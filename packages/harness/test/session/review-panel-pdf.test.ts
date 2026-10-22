/**
 * V4 (ADR 0081, O5–O8): the PDF reviewer inside the panel driver.
 *
 * Kept apart from the 1,600-line driver file. Everything runs under a real
 * `runSessionTask` against a seat-keyed scripted adapter, so what a seat is
 * offered and what it was told are read off the recorded requests, and the
 * record is read off the persisted `review` item.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  CompileResult,
  GenerateRequest,
  ModelBinding,
  PdfDocument,
  ReviewItem,
  ReviewLimit,
  ReviewPdfDeps,
  SessionEvent,
  Skill,
  ToolName,
  Warning,
} from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/index.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import {
  ScriptedModelAdapter,
  type ScriptedTurn,
  scriptedByKey,
} from "../../src/model/scripted.js";
import { buildConversationHistory } from "../../src/session/compaction.js";
import {
  PANEL_SKILL,
  PREFLIGHT_PROMPT,
  REVIEWER_NAMES,
  renderReviewForHistory,
} from "../../src/session/review-panel.js";
import {
  PDF_REVIEWER_NAME,
  PDF_SKILL,
} from "../../src/session/review-pdf-seat.js";
import {
  VERIFIER_BRIEF_MARKER,
  VERIFIER_SKILL,
} from "../../src/session/review-verifier.js";
import {
  type RunSessionTaskOptions,
  runSessionTask,
} from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";

const [A, B, C] = REVIEWER_NAMES as unknown as [string, string, string];

const temps: string[] = [];
afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

const MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\caption{Cost falls as the sequence grows.}",
  "We report no baseline for the headline claim.",
  "The table below runs past its column.",
  "Results follow in Section 4.",
  "\\end{document}",
  "",
].join("\n");

/** A seeing binding — the capability table does not know `model-x`, so the
 *  binding says so itself. */
const seeing: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "model-x",
  apiKey: "k",
  imageInput: true,
};
const blind: ModelBinding = { ...seeing, imageInput: false };

const skill = (name: string): Skill => ({
  name,
  description: `${name} description`,
  body: `body of ${name}`,
  source: "bundled",
  path: `/skills/${name}/SKILL.md`,
  references: [],
});

const ALL_SKILLS = [
  skill(PANEL_SKILL),
  skill(PDF_SKILL),
  skill(VERIFIER_SKILL),
  skill("related-work"),
];

/** A fake compiled PDF: three pages, records whether it was closed. */
function fakePdf(pages = 3) {
  const state = { closed: 0 };
  const document: PdfDocument = {
    pageCount: pages,
    pageSize: () => ({ width: 595.28, height: 841.89 }),
    renderPage: async (_p, opts) => ({
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      width: opts.width,
      height: opts.width,
    }),
    pageText: async (page) =>
      page === pages ? "References\n[1] A. Author." : `page ${page} text`,
    pageTextSizes: async () => [{ sizePt: 10.9, chars: 500 }],
    metadata: async () => ({ author: "A. Fixture" }),
    close: () => {
      state.closed += 1;
    },
  };
  return { document, state };
}

interface Files {
  [path: string]: { text?: string; bytes?: Uint8Array; mtimeMs: number };
}

function workspaceOf(files: Files) {
  return {
    root: "/ws",
    async readFile(path: string): Promise<string> {
      const f = files[path];
      if (f?.text === undefined) throw new Error(`no such file: ${path}`);
      return f.text;
    },
    async listFiles(): Promise<string[]> {
      return Object.keys(files).filter((p) => p.endsWith(".tex"));
    },
    async stat(path: string) {
      const f = files[path];
      return f === undefined
        ? undefined
        : { mtimeMs: f.mtimeMs, size: f.bytes?.length ?? 0 };
    },
    async readBinary(path: string): Promise<Uint8Array> {
      const f = files[path];
      if (f?.bytes === undefined) throw new Error(`no such file: ${path}`);
      return f.bytes;
    },
  };
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const FRESH: Files = {
  "main.tex": { text: MAIN, mtimeMs: 1_000 },
  "main.pdf": { bytes: PDF_BYTES, mtimeMs: 10_000 },
};

function readRegistry(): Map<ToolName, ToolExecutor> {
  const registry = new Map<ToolName, ToolExecutor>();
  registry.set("read_span", {
    name: "read_span",
    category: "retrieval",
    spec: {
      name: "read_span",
      description: "read",
      parameters: { type: "object" },
    },
    invoke: async () => ok({ content: MAIN }),
  });
  return registry;
}

const PDF_MARKER = `\`${PDF_REVIEWER_NAME}\`, the one reviewer`;

function seatKey(req: GenerateRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  if (text === PREFLIGHT_PROMPT) return "preflight";
  if (text.includes(PDF_MARKER)) return "pdf";
  for (const name of REVIEWER_NAMES) {
    if (text.includes(`\`${name}\`, one of `)) return name;
  }
  if (text.includes(VERIFIER_BRIEF_MARKER)) return "verifier";
  return text.includes("reviewers have each read") ? "synthesis" : text;
}

/** The verifier upholds whatever its brief hands it. */
function upholdEvery(req: GenerateRequest): ScriptedModelAdapter {
  const first = req.messages.find((m) => m.role === "user");
  const brief = typeof first?.content === "string" ? first.content : "";
  const line = brief.split("\n").find((l) => l.startsWith('{"concerns":'));
  const ids = line
    ? (JSON.parse(line) as { concerns: Array<{ id: string }> }).concerns.map(
        (c) => c.id,
      )
    : [];
  return new ScriptedModelAdapter([
    {
      text: JSON.stringify({
        verifications: ids.map((id) => ({
          id,
          kind: "absence",
          outcome: "upheld",
        })),
      }),
    },
  ]);
}

function panelModel(scripts: Record<string, ScriptedTurn[]>) {
  const inner = scriptedByKey(scripts);
  const requests: GenerateRequest[] = [];
  const keyed = (req: GenerateRequest): GenerateRequest => ({
    ...req,
    messages: [
      ...req.messages.filter((m) => m.role === "system"),
      { role: "user" as const, content: seatKey(req) },
    ],
  });
  return {
    requests,
    adapter: {
      protocol: "anthropic" as const,
      generate: (req: GenerateRequest) => {
        requests.push(req);
        if (seatKey(req) === "verifier" && scripts.verifier === undefined) {
          return upholdEvery(req).generate(req);
        }
        return inner.generate(keyed(req));
      },
      async *generateStream(req: GenerateRequest) {
        requests.push(req);
        if (seatKey(req) === "verifier" && scripts.verifier === undefined) {
          yield* upholdEvery(req).generateStream(req);
          return;
        }
        const stream = inner.generateStream as (
          r: GenerateRequest,
        ) => AsyncIterable<unknown>;
        yield* stream(keyed(req)) as AsyncIterable<never>;
      },
    },
  };
}

interface Concern {
  anchor: string;
  dimension: string;
  severity?: "info" | "minor" | "major";
  message?: string;
  evidence?: unknown;
}
const ledgerOf = (concerns: Concern[]): string =>
  JSON.stringify({
    impressions: {},
    annotations: concerns.map((c) => ({
      dimension: c.dimension,
      severity: c.severity ?? "minor",
      anchor: c.anchor,
      evidence: c.evidence ?? "missing",
      message: c.message ?? "m",
    })),
  });

const view = (page: number): ScriptedTurn => ({
  text: "",
  toolCalls: [
    { id: `v${page}`, name: "view_pdf_pages", args: { pages: [page] } },
  ],
  stopReason: "tool_use",
});

/** The PDF seat views pages 1 and 2, then files one presentation concern. */
const PDF_SEAT: ScriptedTurn[] = [
  view(1),
  view(2),
  {
    text: ledgerOf([
      {
        anchor: "The table below runs past its column.",
        dimension: "presentation",
        severity: "major",
        evidence: { page: 1 },
      },
    ]),
  },
];

const HEALTHY: Record<string, ScriptedTurn[]> = {
  [A]: [
    {
      text: ledgerOf([
        {
          anchor: "We report no baseline for the headline claim.",
          dimension: "soundness",
        },
      ]),
    },
  ],
  [B]: [
    {
      text: ledgerOf([
        { anchor: "Results follow in Section 4.", dimension: "claims" },
      ]),
    },
  ],
  [C]: [{ text: ledgerOf([]) }],
  pdf: PDF_SEAT,
  synthesis: [
    {
      text: JSON.stringify({
        consensus: [{ ids: [`${A}-1`, `${B}-1`], note: "both" }],
        disagreements: [],
      }),
    },
  ],
};

interface Run {
  item: ReviewItem | undefined;
  store: SessionStore;
  sessionId: string;
  requests: GenerateRequest[];
  events: SessionEvent[];
  registry: Map<ToolName, ToolExecutor>;
}

async function runPanel(
  opts: {
    scripts?: Record<string, ScriptedTurn[]>;
    files?: Files;
    binding?: ModelBinding;
    pdf?: ReviewPdfDeps | "none";
    over?: Partial<RunSessionTaskOptions>;
    text?: string;
    /** The fake PDF's page count; three when absent. */
    pages?: number;
  } = {},
): Promise<Run & { doc: ReturnType<typeof fakePdf> }> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-panel-pdf-"));
  temps.push(dir);
  const store = new SessionStore(join(dir, "sessions"));
  const session = await store.create({ title: "p", workspace: "/ws" });
  const model = panelModel(opts.scripts ?? HEALTHY);
  const events: SessionEvent[] = [];
  const registry = readRegistry();
  const doc = fakePdf(opts.pages);
  const pdf: ReviewPdfDeps | undefined =
    opts.pdf === "none"
      ? undefined
      : (opts.pdf ?? { renderer: async () => doc.document });
  const result = await runSessionTask({
    store,
    session,
    model: model.adapter,
    binding: opts.binding ?? seeing,
    text: opts.text ?? "/review",
    registry,
    skills: ALL_SKILLS,
    workspace: workspaceOf(opts.files ?? FRESH),
    paperEntry: "main.tex",
    // Every real host wires both, so a run without them would carry notices
    // and limits no production panel raises (the driver file's reasoning).
    manuscriptGraph: async (entry: string) => ({
      files: [entry],
      missing: [] as string[],
    }),
    literatureWithhold: { titles: [] },
    onEvent: (e) => events.push(e),
    ...(pdf ? { reviewPdf: pdf } : {}),
    ...opts.over,
  });
  const item = [...result.items]
    .reverse()
    .find((i): i is ReviewItem => i.type === "review");
  return {
    item,
    store,
    sessionId: session.id,
    requests: model.requests,
    events,
    registry,
    doc,
  };
}

const limitsOf = (item: ReviewItem | undefined): ReviewLimit[] =>
  item?.result?.limits ?? [];
const pdfLimits = (item: ReviewItem | undefined): ReviewLimit[] =>
  limitsOf(item).filter((l) =>
    ["pdf_unavailable", "visual_unavailable", "pages_unviewed"].includes(
      l.kind,
    ),
  );
const bySeat = (requests: GenerateRequest[], key: string) =>
  requests.filter((r) => seatKey(r) === key);
const specNames = (r: GenerateRequest | undefined): string[] =>
  (r?.tools ?? []).map((t) => t.name);

describe("the PDF reviewer joins the panel (V4, O6)", () => {
  it("runs beside the reviewers, sees the facts, and alone holds view_pdf_pages", async () => {
    const { item, requests, registry, doc } = await runPanel();
    const pdfRequests = bySeat(requests, "pdf");
    expect(pdfRequests.length).toBeGreaterThan(0);
    const brief = JSON.stringify(pdfRequests[0]?.messages);
    // Both protocols were forced in, and the facts are in its brief.
    expect(brief).toContain(`/skill:${PANEL_SKILL} /skill:${PDF_SKILL}`);
    expect(brief).toContain("The PDF has 3 pages.");
    expect(brief).toContain("A. Fixture");
    expect(specNames(pdfRequests[0])).toContain("view_pdf_pages");
    expect(specNames(pdfRequests[0])).not.toContain("literature_search");
    for (const r of [A, B, C]) {
      expect(specNames(bySeat(requests, r)[0])).not.toContain("view_pdf_pages");
    }
    // The record: a sibling row, the reviewers unchanged in number.
    expect(item?.seats).toHaveLength(3);
    expect(item?.pdfSeat).toMatchObject({
      reviewer: PDF_REVIEWER_NAME,
      status: "completed",
      model: "model-x",
    });
    expect(item?.pdf).toMatchObject({
      source: "beside_entry",
      path: "main.pdf",
      viewed: [1, 2],
    });
    expect(item?.pdf?.facts).toMatchObject({
      pages: 3,
      pageSize: { name: "a4" },
      referencesStart: 3,
      mainTextPages: 2,
      author: "A. Fixture",
    });
    // Its concern is in the result, as its own.
    const pdfConcern = item?.result?.annotations.find(
      (a) => a.reviewer === PDF_REVIEWER_NAME,
    );
    expect(pdfConcern).toMatchObject({
      id: `${PDF_REVIEWER_NAME}-1`,
      dimension: "presentation",
      evidence: { kind: "page", page: 1 },
    });
    // It viewed two of three pages, and completed.
    expect(pdfLimits(item)).toEqual([
      { kind: "pages_unviewed", viewed: 2, total: 3 },
    ]);
    // The document was closed, once; the parent never gained the tool.
    expect(doc.state.closed).toBe(1);
    expect(registry.has("view_pdf_pages")).toBe(false);
  });

  it("carves the budget one seat more when the PDF reviewer joins", async () => {
    // 14,000 output tokens, less what the preflight spent: about 4,660 each
    // for three reviewers, and under 3,500 each for four — which is under the
    // per-seat floor, and says so.
    const budget = { ceilings: { maxOutputTokens: 14_000 } };
    const notices = (events: SessionEvent[]) =>
      events.flatMap((e) =>
        e.type === "item.completed" &&
        e.item.type === "notice" &&
        e.item.code === "review.seat_budget"
          ? [e.item.n]
          : [],
      );
    const withSeat = await runPanel({ over: budget });
    const [n] = notices(withSeat.events);
    // Divided by four — not three (> 3,500), not five (<= 2,800).
    expect(n).toBeLessThanOrEqual(3_500);
    expect(n).toBeGreaterThan(14_000 / 5);
    const without = await runPanel({
      over: { ...budget, reviewPanel: { reviewers: [], pdfReviewer: "off" } },
    });
    expect(notices(without.events)).toEqual([]);
  });

  it("a reviewer that calls view_pdf_pages is denied", async () => {
    const { requests } = await runPanel({
      scripts: {
        ...HEALTHY,
        [C]: [view(1), { text: ledgerOf([]) }],
      },
    });
    const second = bySeat(requests, C)[1];
    expect(JSON.stringify(second?.messages)).toContain(
      '\\"code\\":\\"denied\\"',
    );
  });

  it("the verifier and the cross-review read the reviewers' concerns only", async () => {
    const { item, requests } = await runPanel();
    for (const key of ["verifier", "synthesis"]) {
      for (const r of bySeat(requests, key)) {
        expect(JSON.stringify(r.messages), key).not.toContain(
          `${PDF_REVIEWER_NAME}-1`,
        );
      }
    }
    expect(bySeat(requests, "verifier").length).toBeGreaterThan(0);
    const pdfConcern = item?.result?.annotations.find(
      (a) => a.reviewer === PDF_REVIEWER_NAME,
    );
    expect(pdfConcern?.verification).toBeUndefined();
    // The reviewers' concerns were checked.
    const reviewerConcern = item?.result?.annotations.find(
      (a) => a.reviewer === A,
    );
    expect(reviewerConcern?.verification?.outcome).toBe("upheld");
    expect(item?.verifierSeat?.verification?.concerns).toBe(2);
  });

  it("one reviewer plus the PDF reviewer is not a panel to read across", async () => {
    const { item } = await runPanel({
      over: { reviewPanel: { reviewers: [{}] } },
    });
    expect(item?.pdfSeat?.status).toBe("completed");
    expect(limitsOf(item)).toContainEqual({
      kind: "synthesis_missing",
      reason: "insufficient_seats",
    });
  });

  it("records seat_unguided and skips the seat when the addendum is not offered", async () => {
    const { item, requests } = await runPanel({
      over: {
        skills: [skill(PANEL_SKILL), skill(VERIFIER_SKILL)],
      },
    });
    expect(bySeat(requests, "pdf")).toHaveLength(0);
    expect(item?.pdfSeat).toBeUndefined();
    expect(limitsOf(item)).toContainEqual({
      kind: "seat_unguided",
      reviewer: PDF_REVIEWER_NAME,
    });
  });

  it("drops a page the seat did not view, and says so in its one re-ask", async () => {
    const { item, requests } = await runPanel({
      scripts: {
        ...HEALTHY,
        pdf: [
          view(1),
          {
            text: ledgerOf([
              {
                anchor: "\\caption{Cost falls as the sequence grows.}",
                dimension: "claims",
                evidence: { page: 3 },
              },
            ]),
          },
          // It files the same page again: taken, with the entry dropped.
          {
            text: ledgerOf([
              {
                anchor: "\\caption{Cost falls as the sequence grows.}",
                dimension: "claims",
                evidence: { page: 3 },
              },
            ]),
          },
        ],
      },
    });
    const pdfRequests = bySeat(requests, "pdf");
    expect(JSON.stringify(pdfRequests.at(-1)?.messages)).toContain(
      "you cited page 3 as evidence but viewed page 1",
    );
    expect(
      item?.result?.annotations.filter((a) => a.reviewer === PDF_REVIEWER_NAME),
    ).toHaveLength(0);
    expect(limitsOf(item)).toContainEqual({
      kind: "anchors_dropped",
      reviewer: PDF_REVIEWER_NAME,
      anchors: [
        { anchor: "page 3", role: "evidence", reason: "page_not_viewed" },
      ],
    });
  });
});

describe("a panel sets aside the PDF reviewer's argument (ADR 0083 §2, O36)", () => {
  /** Views pages 1 and 2, then files what J1's default-budget run filed: page
   *  concerns beside concerns about the argument that name no page. */
  const MIXED: ScriptedTurn[] = [
    view(1),
    view(2),
    {
      text: ledgerOf([
        {
          anchor: "The table below runs past its column.",
          dimension: "presentation",
          evidence: { page: 1 },
        },
        {
          anchor: "We report no baseline for the headline claim.",
          dimension: "soundness",
          message: "no baseline backs the headline claim",
        },
        // A figure that contradicts its caption is `claims` — and the page
        // shows it, so it stays the seat's.
        {
          anchor: "\\caption{Cost falls as the sequence grows.}",
          dimension: "claims",
          evidence: { page: 2 },
        },
        {
          anchor: "Results follow in Section 4.",
          dimension: "clarity",
          evidence: { anchor: "The table below runs past its column." },
          message: "Section 4 is promised, not shown",
        },
      ]),
    },
  ];

  it("keeps the page's concerns with dense ids, and records the rest", async () => {
    const { item } = await runPanel({ scripts: { ...HEALTHY, pdf: MIXED } });
    const pdf = item?.result?.annotations.filter(
      (a) => a.reviewer === PDF_REVIEWER_NAME,
    );
    expect(pdf?.map((a) => [a.id, a.dimension, a.evidence])).toEqual([
      [`${PDF_REVIEWER_NAME}-1`, "presentation", { kind: "page", page: 1 }],
      [`${PDF_REVIEWER_NAME}-2`, "claims", { kind: "page", page: 2 }],
    ]);
    expect(limitsOf(item)).toContainEqual({
      kind: "concerns_set_aside",
      reviewer: PDF_REVIEWER_NAME,
      // ADR 0086: what each said. Neither cited a page, so neither has one.
      entries: [
        {
          dimension: "soundness",
          concern: {
            severity: "minor",
            message: "no baseline backs the headline claim",
            span: { file: "main.tex", line: 4 },
          },
        },
        {
          dimension: "clarity",
          concern: {
            severity: "minor",
            message: "Section 4 is promised, not shown",
            span: { file: "main.tex", line: 6 },
          },
        },
      ],
    });
    expect(item?.pdfSeat?.ledger).toMatchObject({
      entries: 4,
      located: 2,
      setAside: 2,
    });
    // The reviewers' own concerns about the argument are untouched.
    expect(
      item?.result?.annotations
        .filter((a) => a.reviewer !== PDF_REVIEWER_NAME)
        .map((a) => a.dimension),
    ).toEqual(["soundness", "claims"]);
  });

  it("a PDF-only run keeps them: there is no text reviewer to leave them to", async () => {
    const pdfModel = panelModel({ pdf: MIXED });
    const { item } = await runPanel({
      text: "/review-pdf",
      over: {
        reviewPanel: {
          reviewers: [],
          pdfReviewer: {
            adapter: pdfModel.adapter,
            binding: { ...seeing, model: "model-p" },
          },
        },
      },
    });
    expect(item?.pdfOnly).toBe(true);
    expect(item?.result?.annotations.map((a) => a.dimension)).toEqual([
      "presentation",
      "soundness",
      "claims",
      "clarity",
    ]);
    expect(limitsOf(item).map((l) => l.kind)).not.toContain(
      "concerns_set_aside",
    );
    expect(item?.pdfSeat?.ledger).not.toHaveProperty("setAside");
  });
});

describe("review-mode furniture is set aside, in both modes (ADR 0085 §2, O41)", () => {
  // Round 4: all three S2 runs filed the anonymised author block and the
  // template's placeholder DOI as major and blocking, on the page that shows
  // `Anonymous Author(s)` — round 3 filed neither, with the same addendum.
  const ANON_MAIN = MAIN.replace(
    "\\documentclass{article}",
    [
      "\\documentclass[sigconf, review, anonymous]{acmart}",
      "\\acmDOI{XXXXXXX.XXXXXXX}",
      "\\author{Author Name}",
    ].join("\n"),
  );
  const files = (main: string): Files => ({
    "main.tex": { text: main, mtimeMs: 1_000 },
    "main.pdf": { bytes: PDF_BYTES, mtimeMs: 10_000 },
  });
  const FURNITURE = [
    {
      anchor: "\\author{Author Name}",
      dimension: "presentation",
      severity: "major" as const,
      evidence: { page: 1 },
      message: "the author block reads Anonymous",
    },
    {
      anchor: "\\acmDOI{XXXXXXX.XXXXXXX}",
      dimension: "presentation",
      evidence: { page: 1 },
      message: "the DOI is a placeholder",
    },
    {
      anchor: "The table below runs past its column.",
      dimension: "presentation",
      evidence: { page: 1 },
    },
  ];
  const pdfOnly = (main: string) => {
    const pdfModel = panelModel({
      pdf: [view(1), { text: ledgerOf(FURNITURE) }],
    });
    return runPanel({
      text: "/review-pdf",
      files: files(main),
      over: {
        reviewPanel: {
          reviewers: [],
          pdfReviewer: {
            adapter: pdfModel.adapter,
            binding: { ...seeing, model: "model-p" },
          },
        },
      },
    });
  };
  const keptLines = (item: ReviewItem | undefined): number[] =>
    (item?.result?.annotations ?? [])
      .filter((a) => a.reviewer === PDF_REVIEWER_NAME)
      .map((a) => a.span.line);

  it("a PDF-only run sets both aside, keeps the page defect, and records them", async () => {
    const { item } = await pdfOnly(ANON_MAIN);
    // The table's line, after the three preamble lines ANON_MAIN adds.
    expect(keptLines(item)).toEqual([7]);
    expect(item?.result?.annotations[0]?.id).toBe(`${PDF_REVIEWER_NAME}-1`);
    expect(limitsOf(item)).toContainEqual({
      kind: "furniture_set_aside",
      reviewer: PDF_REVIEWER_NAME,
      // ADR 0086: what each said, with the page it CITED.
      entries: [
        {
          dimension: "presentation",
          concern: {
            severity: "major",
            message: "the author block reads Anonymous",
            span: { file: "main.tex", line: 3 },
            page: 1,
          },
        },
        {
          dimension: "presentation",
          concern: {
            severity: "minor",
            message: "the DOI is a placeholder",
            span: { file: "main.tex", line: 2 },
            page: 1,
          },
        },
      ],
    });
    expect(item?.pdfSeat?.ledger).toMatchObject({
      entries: 3,
      located: 1,
      setAside: 2,
    });
  });

  it("keeps the author block when the class does not run anonymous (E1's V10)", async () => {
    const { item } = await pdfOnly(ANON_MAIN.replace(", anonymous", ""));
    expect(keptLines(item)).toEqual([3, 7]);
    expect(limitsOf(item)).toContainEqual({
      kind: "furniture_set_aside",
      reviewer: PDF_REVIEWER_NAME,
      entries: [
        {
          dimension: "presentation",
          concern: {
            severity: "minor",
            message: "the DOI is a placeholder",
            span: { file: "main.tex", line: 2 },
            page: 1,
          },
        },
      ],
    });
  });

  it("in a panel it runs first, and the argument's set-aside adds to its count", async () => {
    const { item } = await runPanel({
      scripts: {
        ...HEALTHY,
        pdf: [
          view(1),
          {
            text: ledgerOf([
              ...FURNITURE,
              {
                anchor: "We report no baseline for the headline claim.",
                dimension: "soundness",
              },
            ]),
          },
        ],
      },
      files: files(ANON_MAIN),
    });
    expect(keptLines(item)).toEqual([7]);
    const kinds = limitsOf(item).map((l) => l.kind);
    expect(kinds).toContain("furniture_set_aside");
    expect(kinds).toContain("concerns_set_aside");
    expect(item?.pdfSeat?.ledger).toMatchObject({
      entries: 4,
      located: 1,
      setAside: 3,
    });
  });
});

describe("a page cite follows the float its anchor sits in (ADR 0084, O39)", () => {
  const FLOAT_MAIN = [
    "\\documentclass{article}",
    "\\begin{document}",
    "We report no baseline for the headline claim.",
    "\\begin{figure}",
    "\\includegraphics{plot.pdf}",
    "\\caption{Cost falls as the sequence grows.}\\label{fig:cost}",
    "\\end{figure}",
    "Results follow in Section 4.",
    "\\end{document}",
    "",
  ].join("\n");
  const AUX = "\\relax\n\\newlabel{fig:cost}{{1}{3}}\n";
  const TEXTS: Record<number, string> = {
    1: "We report no baseline for the headline claim.",
    2: "Results follow in Section 4.",
    3: "Figure 1: Cost falls as the sequence grows.",
  };
  const withText = (texts: Record<number, string>): ReviewPdfDeps => ({
    renderer: async () => ({
      ...fakePdf(3).document,
      pageText: async (page: number) => texts[page] ?? "",
    }),
  });
  const filesWith = (auxMtimeMs: number): Files => ({
    "main.tex": { text: FLOAT_MAIN, mtimeMs: 1_000 },
    "main.pdf": { bytes: PDF_BYTES, mtimeMs: 10_000 },
    "main.aux": { text: AUX, mtimeMs: auxMtimeMs },
  });
  /** Views every page, then cites the figure one page early, as round 3's
   *  *Review the PDF* did on a real paper. */
  const EARLY: ScriptedTurn[] = [
    view(1),
    view(2),
    view(3),
    {
      text: ledgerOf([
        {
          anchor: "\\includegraphics{plot.pdf}",
          dimension: "presentation",
          evidence: { page: 2 },
        },
      ]),
    },
  ];
  const pdfOnlyRun = (files: Files, texts = TEXTS) => {
    const pdfModel = panelModel({ pdf: EARLY });
    return runPanel({
      text: "/review-pdf",
      files,
      pdf: withText(texts),
      over: {
        reviewPanel: {
          reviewers: [],
          pdfReviewer: {
            adapter: pdfModel.adapter,
            binding: { ...seeing, model: "model-p" },
          },
        },
      },
    });
  };

  it("moves a PDF-only run's cite to the float's page, and records the move", async () => {
    const { item } = await pdfOnlyRun(filesWith(10_000));
    expect(item?.pdfOnly).toBe(true);
    expect(item?.result?.annotations.map((a) => [a.id, a.evidence])).toEqual([
      [`${PDF_REVIEWER_NAME}-1`, { kind: "page", page: 3 }],
    ]);
    expect(limitsOf(item)).toContainEqual({
      kind: "pages_corrected",
      reviewer: PDF_REVIEWER_NAME,
      entries: [{ id: `${PDF_REVIEWER_NAME}-1`, cited: 2, page: 3 }],
    });
  });

  it("does the same in a panel", async () => {
    const { item } = await runPanel({
      scripts: { ...HEALTHY, pdf: EARLY },
      files: filesWith(10_000),
      pdf: withText(TEXTS),
    });
    const pdf = item?.result?.annotations.filter(
      (a) => a.reviewer === PDF_REVIEWER_NAME,
    );
    expect(pdf?.map((a) => a.evidence)).toEqual([{ kind: "page", page: 3 }]);
    expect(limitsOf(item).map((l) => l.kind)).toContain("pages_corrected");
  });

  it("leaves the cite alone when the aux is older than the PDF", async () => {
    const { item } = await pdfOnlyRun(filesWith(1_000));
    expect(item?.result?.annotations.map((a) => a.evidence)).toEqual([
      { kind: "page", page: 2 },
    ]);
    expect(limitsOf(item).map((l) => l.kind)).not.toContain("pages_corrected");
  });

  it("never moves a right cite onto the page that only refers to the float (the code review's repro)", async () => {
    // A cover page shifts the printed numbering by one: the aux names printed
    // page 2, and physical page 2 only REFERS to Figure 1 in its running text.
    const SEAT_RIGHT: ScriptedTurn[] = [
      view(1),
      view(2),
      view(3),
      {
        text: ledgerOf([
          {
            anchor: "\\includegraphics{plot.pdf}",
            dimension: "presentation",
            evidence: { page: 3 },
          },
        ]),
      },
    ];
    const pdfModel = panelModel({ pdf: SEAT_RIGHT });
    const { item } = await runPanel({
      text: "/review-pdf",
      files: {
        ...filesWith(10_000),
        "main.aux": { text: "\\newlabel{fig:cost}{{1}{2}}\n", mtimeMs: 10_000 },
      },
      pdf: withText({
        ...TEXTS,
        2: "Cover.\r\nAs shown in Figure 1, the cost falls. See Figure 1.",
      }),
      over: {
        reviewPanel: {
          reviewers: [],
          pdfReviewer: {
            adapter: pdfModel.adapter,
            binding: { ...seeing, model: "model-p" },
          },
        },
      },
    });
    expect(item?.result?.annotations.map((a) => a.evidence)).toEqual([
      { kind: "page", page: 3 },
    ]);
    expect(limitsOf(item).map((l) => l.kind)).not.toContain("pages_corrected");
  });

  it("leaves it alone when the caption stands on a second page too", async () => {
    // A supplement that restarts its numbering prints another Figure 1.
    const { item } = await pdfOnlyRun(filesWith(10_000), {
      ...TEXTS,
      1: "Supplementary material\r\nFigure 1: A second figure one.",
    });
    expect(item?.result?.annotations.map((a) => a.evidence)).toEqual([
      { kind: "page", page: 2 },
    ]);
    expect(limitsOf(item).map((l) => l.kind)).not.toContain("pages_corrected");
  });

  it("leaves it alone when the aux counts pages another build shipped", async () => {
    const { item } = await pdfOnlyRun({
      ...filesWith(10_000),
      "main.aux": {
        text: `${AUX}\\gdef \\@abspage@last{5}\n`,
        mtimeMs: 10_000,
      },
    });
    expect(item?.result?.annotations.map((a) => a.evidence)).toEqual([
      { kind: "page", page: 2 },
    ]);
  });

  it("reads the aux a compile for this review wrote", async () => {
    const pdfModel = panelModel({ pdf: EARLY });
    const { item } = await runPanel({
      text: "/review-pdf",
      files: { "main.tex": { text: FLOAT_MAIN, mtimeMs: 1_000 } },
      pdf: {
        ...withText(TEXTS),
        compile: async () => ({
          ok: true,
          log: "",
          pdf: PDF_BYTES,
          aux: `${AUX}\\gdef \\@abspage@last{3}\n`,
        }),
      },
      over: {
        reviewPanel: {
          reviewers: [],
          pdfReviewer: {
            adapter: pdfModel.adapter,
            binding: { ...seeing, model: "model-p" },
          },
        },
      },
    });
    expect(item?.pdf?.source).toBe("compiled");
    expect(item?.result?.annotations.map((a) => a.evidence)).toEqual([
      { kind: "page", page: 3 },
    ]);
  });

  it("names the final id: the page step runs after a panel's set-aside", async () => {
    // A page-less concern about the argument comes first, so the float's
    // concern is pdf_reviewer-2 as filed and pdf_reviewer-1 once it is set aside.
    const BOTH: ScriptedTurn[] = [
      view(1),
      view(2),
      view(3),
      {
        text: ledgerOf([
          {
            anchor: "We report no baseline for the headline claim.",
            dimension: "soundness",
          },
          {
            anchor: "\\includegraphics{plot.pdf}",
            dimension: "presentation",
            evidence: { page: 2 },
          },
        ]),
      },
    ];
    const { item } = await runPanel({
      scripts: { ...HEALTHY, pdf: BOTH },
      files: filesWith(10_000),
      pdf: withText(TEXTS),
    });
    expect(limitsOf(item)).toContainEqual({
      kind: "pages_corrected",
      reviewer: PDF_REVIEWER_NAME,
      entries: [{ id: `${PDF_REVIEWER_NAME}-1`, cited: 2, page: 3 }],
    });
    expect(
      item?.result?.annotations
        .filter((a) => a.reviewer === PDF_REVIEWER_NAME)
        .map((a) => [a.id, a.evidence]),
    ).toEqual([[`${PDF_REVIEWER_NAME}-1`, { kind: "page", page: 3 }]]);
  });

  it("leaves it alone when the aux's page does not carry the caption", async () => {
    const { item } = await pdfOnlyRun(filesWith(10_000), {
      ...TEXTS,
      3: "An appendix page with no caption.",
    });
    expect(item?.result?.annotations.map((a) => a.evidence)).toEqual([
      { kind: "page", page: 2 },
    ]);
    expect(limitsOf(item).map((l) => l.kind)).not.toContain("pages_corrected");
  });

  describe("a found .aux that could not be used is said (ADR 0085 §3, O42)", () => {
    // Round 4: on the operator's repository the committed PDF carried the
    // checkout's time and the untracked `.aux` an earlier build's, so the step
    // above switched itself off and nothing told the author.
    const unchecked = (
      reason: "aux_older_than_pdf" | "aux_other_build",
    ): unknown => ({
      kind: "pages_unchecked",
      reviewer: PDF_REVIEWER_NAME,
      reason,
      entries: [{ id: `${PDF_REVIEWER_NAME}-1` }],
    });

    it("an .aux older than the PDF: the cite stands, and the limit names it", async () => {
      const { item } = await pdfOnlyRun(filesWith(1_000));
      expect(item?.result?.annotations.map((a) => a.evidence)).toEqual([
        { kind: "page", page: 2 },
      ]);
      expect(limitsOf(item)).toContainEqual(unchecked("aux_older_than_pdf"));
    });

    it("an .aux that counts another build's pages: aux_other_build", async () => {
      const { item } = await pdfOnlyRun({
        ...filesWith(10_000),
        "main.aux": {
          text: `${AUX}\\gdef \\@abspage@last{5}\n`,
          mtimeMs: 10_000,
        },
      });
      expect(limitsOf(item)).toContainEqual(unchecked("aux_other_build"));
    });

    it("says so in a panel too", async () => {
      const { item } = await runPanel({
        scripts: { ...HEALTHY, pdf: EARLY },
        files: filesWith(1_000),
        pdf: withText(TEXTS),
      });
      expect(limitsOf(item)).toContainEqual(unchecked("aux_older_than_pdf"));
    });

    it("says nothing when no .aux was found — there was none to reject", async () => {
      const { "main.aux": _aux, ...noAux } = filesWith(10_000);
      const { item } = await pdfOnlyRun(noAux);
      expect(limitsOf(item).map((l) => l.kind)).not.toContain(
        "pages_unchecked",
      );
    });

    it("says nothing when the .aux was usable", async () => {
      const { item } = await pdfOnlyRun(filesWith(10_000));
      expect(limitsOf(item).map((l) => l.kind)).not.toContain(
        "pages_unchecked",
      );
    });

    it("says nothing when no page cite sits in a float — nothing it could have checked", async () => {
      const OUTSIDE: ScriptedTurn[] = [
        view(1),
        view(2),
        view(3),
        {
          text: ledgerOf([
            {
              anchor: "Results follow in Section 4.",
              dimension: "presentation",
              evidence: { page: 2 },
            },
          ]),
        },
      ];
      const pdfModel = panelModel({ pdf: OUTSIDE });
      const { item } = await runPanel({
        text: "/review-pdf",
        files: filesWith(1_000),
        pdf: withText(TEXTS),
        over: {
          reviewPanel: {
            reviewers: [],
            pdfReviewer: {
              adapter: pdfModel.adapter,
              binding: { ...seeing, model: "model-p" },
            },
          },
        },
      });
      expect(item?.result?.annotations).toHaveLength(1);
      expect(limitsOf(item).map((l) => l.kind)).not.toContain(
        "pages_unchecked",
      );
    });
  });
});

describe("the PDF reviewer's degradations, panel mode (V4, O7)", () => {
  const panelRanWhole = (item: ReviewItem | undefined) => {
    expect(item?.status).toBe("completed");
    expect(item?.seats).toHaveLength(3);
    expect(item?.pdfSeat).toBeUndefined();
  };

  it("off: nothing resolved, nothing compiled, no limit, no record", async () => {
    let rendered = 0;
    let compiled = 0;
    const { item } = await runPanel({
      pdf: {
        renderer: async () => {
          rendered += 1;
          return undefined;
        },
        compile: async () => {
          compiled += 1;
          return { ok: true, log: "" };
        },
      },
      over: { reviewPanel: { reviewers: [], pdfReviewer: "off" } },
    });
    panelRanWhole(item);
    expect([rendered, compiled]).toEqual([0, 0]);
    expect(pdfLimits(item)).toEqual([]);
    expect(item?.pdf).toBeUndefined();
  });

  it("a model that cannot see: a limit, and no compile", async () => {
    let compiled = 0;
    const { item, requests } = await runPanel({
      binding: blind,
      files: { "main.tex": { text: MAIN, mtimeMs: 1_000 } },
      pdf: {
        renderer: async () => undefined,
        compile: async () => {
          compiled += 1;
          return { ok: true, log: "" };
        },
      },
    });
    panelRanWhole(item);
    expect(compiled).toBe(0);
    expect(bySeat(requests, "pdf")).toHaveLength(0);
    expect(pdfLimits(item)).toEqual([
      { kind: "visual_unavailable", reason: "model_has_no_image_input" },
    ]);
  });

  it("no renderer wired: no_renderer", async () => {
    const { item } = await runPanel({ pdf: "none" });
    panelRanWhole(item);
    expect(pdfLimits(item)).toEqual([
      { kind: "visual_unavailable", reason: "no_renderer" },
    ]);
  });

  it("no PDF and no compile: none", async () => {
    const { item } = await runPanel({
      files: { "main.tex": { text: MAIN, mtimeMs: 1_000 } },
    });
    panelRanWhole(item);
    expect(pdfLimits(item)).toEqual([
      { kind: "pdf_unavailable", reason: "none" },
    ]);
  });

  it("a stale PDF and no compile: stale", async () => {
    const { item } = await runPanel({
      files: {
        "main.tex": { text: MAIN, mtimeMs: 100_000 },
        "main.pdf": { bytes: PDF_BYTES, mtimeMs: 1_000 },
      },
    });
    panelRanWhole(item);
    expect(pdfLimits(item)).toEqual([
      { kind: "pdf_unavailable", reason: "stale" },
    ]);
  });

  it("a compile that fails: compile_failed, with the log's tail for the record", async () => {
    const { item } = await runPanel({
      files: { "main.tex": { text: MAIN, mtimeMs: 1_000 } },
      pdf: {
        renderer: async () => undefined,
        compile: async (): Promise<CompileResult> => ({
          ok: false,
          log: "! Undefined control sequence.\nl.4 \\foo",
        }),
      },
    });
    panelRanWhole(item);
    const limit = pdfLimits(item)[0];
    expect(limit).toMatchObject({
      kind: "pdf_unavailable",
      reason: "compile_failed",
    });
    expect(limit?.kind === "pdf_unavailable" && limit.detail).toContain(
      "Undefined control sequence",
    );
  });

  it("bytes the renderer refuses: render_failed", async () => {
    const { item } = await runPanel({
      pdf: { renderer: async () => undefined },
    });
    panelRanWhole(item);
    expect(pdfLimits(item)).toEqual([
      { kind: "pdf_unavailable", reason: "render_failed" },
    ]);
  });

  it("a named PDF older than the manuscript is used, and flagged stale", async () => {
    const { item } = await runPanel({
      files: {
        "main.tex": { text: MAIN, mtimeMs: 100_000 },
        "paper.pdf": { bytes: PDF_BYTES, mtimeMs: 1_000 },
      },
      over: { paperPdf: "paper.pdf" },
    });
    expect(item?.pdf).toMatchObject({
      source: "named",
      path: "paper.pdf",
      stale: true,
    });
    expect(item?.pdfSeat?.status).toBe("completed");
  });
});

describe("the compile log's overfull boxes (V4, O5)", () => {
  const OVERFULL_LOG =
    "Overfull \\hbox (12.0pt too wide) in paragraph at lines 5--6";
  const reader = (log: string, entryFile: string): Warning[] =>
    log.includes("Overfull")
      ? [
          {
            id: "w",
            source: "latexmk",
            severity: "warning",
            code: "overfull-hbox",
            message: log,
            file: entryFile,
          },
        ]
      : [];

  it("reads the <base>.log beside a found PDF when it is not older than it", async () => {
    const doc = fakePdf();
    const { item } = await runPanel({
      files: {
        ...FRESH,
        "main.log": { text: OVERFULL_LOG, mtimeMs: 10_500 },
      },
      pdf: { renderer: async () => doc.document, compileLog: reader },
    });
    expect(item?.pdf?.facts.overfull).toEqual({ hboxes: 1, vboxes: 0 });
  });

  it("ignores a log older than the PDF — it describes another build", async () => {
    const doc = fakePdf();
    const { item } = await runPanel({
      files: {
        ...FRESH,
        "main.log": { text: OVERFULL_LOG, mtimeMs: 1_000 },
      },
      pdf: { renderer: async () => doc.document, compileLog: reader },
    });
    expect(item?.pdf?.facts.overfull).toBeUndefined();
  });

  it("reads the compile's own log when the PDF was compiled this run", async () => {
    const doc = fakePdf();
    const { item } = await runPanel({
      files: { "main.tex": { text: MAIN, mtimeMs: 1_000 } },
      pdf: {
        renderer: async () => doc.document,
        compile: async () => ({ ok: true, log: OVERFULL_LOG, pdf: PDF_BYTES }),
        compileLog: reader,
      },
    });
    expect(item?.pdf?.source).toBe("compiled");
    expect(item?.pdf?.facts.overfull).toEqual({ hboxes: 1, vboxes: 0 });
  });

  it("states no overfull fact without a log reader", async () => {
    const { item } = await runPanel({
      files: {
        ...FRESH,
        "main.log": { text: OVERFULL_LOG, mtimeMs: 10_500 },
      },
    });
    expect(item?.pdf?.facts).toBeDefined();
    expect(item?.pdf?.facts.overfull).toBeUndefined();
  });
});

describe("the record survives a reload (V4, O13)", () => {
  it("replays pdfSeat and pdf through the session store, and the handoff names the seat", async () => {
    const { item, store, sessionId } = await runPanel();
    const loaded = await store.load(sessionId);
    const back = loaded.items.find((i): i is ReviewItem => i.type === "review");
    expect(back?.pdfSeat).toEqual(item?.pdfSeat);
    expect(back?.pdf).toEqual(item?.pdf);
    // No image ever reaches the persisted session: the pages were viewed in
    // the child, and the child's transcript is not this one.
    const raw = JSON.stringify(loaded.entries);
    expect(raw).not.toContain("image/png");
    expect(raw).not.toContain("iVBOR");
    const history = buildConversationHistory(loaded.items, "model-x");
    const handoff = history.map((m) => JSON.stringify(m.content)).join("\n");
    expect(handoff).toContain(`${PDF_REVIEWER_NAME}=model-x`);
    expect(handoff).toContain(
      `${PDF_REVIEWER_NAME}'s concerns are about the rendered page of the compiled PDF and were not checked by the verifier.`,
    );
  });
});

describe("/review-pdf — the compiled paper reviewed alone (V4, O9)", () => {
  /** A pdf model of its own, so the preflight's reach can be told apart. */
  const ownPdfModel = (scripts: Record<string, ScriptedTurn[]>) => {
    const model = panelModel(scripts);
    return {
      model,
      child: {
        adapter: model.adapter,
        binding: { ...seeing, model: "model-p" },
      },
    };
  };
  const noticeCodes = (events: SessionEvent[]) =>
    events.flatMap((e) =>
      e.type === "item.completed" && e.item.type === "notice"
        ? [e.item.code]
        : [],
    );

  it("runs the one seat: no reviewers, no verifier, no cross-review, no model turn", async () => {
    const pdf = ownPdfModel({ pdf: PDF_SEAT });
    const { item, requests } = await runPanel({
      text: "/review-pdf",
      over: { reviewPanel: { reviewers: [], pdfReviewer: pdf.child } },
    });
    expect(item).toMatchObject({
      status: "completed",
      pdfOnly: true,
      seats: [],
      verification: "skipped",
      skill: PDF_SKILL,
    });
    expect(item?.synthesis).toBeUndefined();
    expect(item?.version).toBe(1);
    expect(item?.pdfSeat).toMatchObject({
      reviewer: PDF_REVIEWER_NAME,
      status: "completed",
      model: "model-p",
    });
    expect(item?.result?.annotations.map((a) => a.id)).toEqual([
      `${PDF_REVIEWER_NAME}-1`,
    ]);
    const kinds = limitsOf(item).map((l) => l.kind);
    expect(kinds).not.toContain("synthesis_missing");
    expect(kinds).not.toContain("verification_missing");
    expect(kinds).not.toContain("own_title_unguarded");
    // The parent model was never asked anything — not even the preflight.
    expect(requests).toEqual([]);
    const pdfKeys = pdf.model.requests.map(seatKey);
    expect(pdfKeys[0]).toBe("preflight");
    expect(pdfKeys.slice(1).every((k) => k === "pdf")).toBe(true);
  });

  it("hands the focus to the seat, verbatim", async () => {
    const { requests } = await runPanel({
      text: "/review-pdf the tables on page 2",
      over: { reviewPanel: { reviewers: [] } },
    });
    expect(JSON.stringify(bySeat(requests, "pdf")[0]?.messages)).toContain(
      "the tables on page 2",
    );
  });

  it("a model that cannot see COMPLETES with the limit, sends nothing, and posts no notice", async () => {
    const { item, requests, events } = await runPanel({
      text: "/review-pdf",
      binding: blind,
    });
    expect(requests).toEqual([]);
    expect(item).toMatchObject({ status: "completed", pdfOnly: true });
    expect(item?.result?.annotations).toEqual([]);
    expect(limitsOf(item)).toEqual([
      { kind: "visual_unavailable", reason: "model_has_no_image_input" },
    ]);
    expect(item?.pdfSeat).toBeUndefined();
    expect(item?.pdf).toBeUndefined();
    expect(noticeCodes(events)).toEqual([]);
  });

  it("no PDF completes the same way, with pdf_unavailable", async () => {
    const { item, events } = await runPanel({
      text: "/review-pdf",
      files: { "main.tex": { text: MAIN, mtimeMs: 1_000 } },
    });
    expect(item?.status).toBe("completed");
    expect(limitsOf(item)).toEqual([
      { kind: "pdf_unavailable", reason: "none" },
    ]);
    expect(item?.pdfSeat).toBeUndefined();
    expect(noticeCodes(events)).toEqual([]);
  });

  it("the role turned off: the run completes with nothing in it (as built — see open-questions)", async () => {
    // D4 step 1 reads "off" as *no PDF work of any kind*, in both modes, and
    // D11 records a limit only for steps 1–3's failures — so a `/review-pdf`
    // with the role off is an empty, limit-less review. Pinned as built; the
    // shape is raised for the gate in open-questions.md.
    const { item, requests } = await runPanel({
      text: "/review-pdf",
      over: { reviewPanel: { reviewers: [], pdfReviewer: "off" } },
    });
    expect(requests).toEqual([]);
    expect(item?.status).toBe("completed");
    expect(item?.result?.annotations).toEqual([]);
    expect(limitsOf(item)).toEqual([]);
  });

  it("a child's `/review-pdf` is prose, never a review", async () => {
    const { item } = await runPanel({
      text: "/review-pdf",
      scripts: { "/review-pdf": [{ text: "just text" }] },
      over: { isChild: true },
    });
    expect(item).toBeUndefined();
  });
});

/** One page a turn, as the addendum asks: a line of notes on the page just
 *  seen, then the next view — charged the output a real seat spends on it. */
const noteAndView = (page: number, alsoRead = false): ScriptedTurn => ({
  text:
    page === 1 ? "" : `Page ${page - 1}: a figure and a table, both legible.`,
  toolCalls: [
    { id: `v${page}`, name: "view_pdf_pages", args: { pages: [page] } },
    ...(alsoRead
      ? [
          {
            id: `r${page}`,
            name: "read_span" as const,
            args: { path: "main.tex" },
          },
        ]
      : []),
  ],
  stopReason: "tool_use",
  usage: { outputTokens: 120 },
});
const reads = (n: number, id: string): ScriptedTurn => ({
  text: "",
  toolCalls: Array.from({ length: n }, (_, i) => ({
    id: `${id}-${i}`,
    name: "read_span",
    args: { path: "main.tex" },
  })),
  stopReason: "tool_use",
  usage: { outputTokens: 40 },
});
const ledgerTurn = (page: number): ScriptedTurn => ({
  text: ledgerOf([
    {
      anchor: "The table below runs past its column.",
      dimension: "presentation",
      severity: "major",
      evidence: { page },
    },
  ]),
  usage: { outputTokens: 1_500 },
});
const pageRange = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => i + 1);
const systemOf = (r: GenerateRequest | undefined): string => {
  const content = r?.messages.find((m) => m.role === "system")?.content;
  return typeof content === "string" ? content : "";
};

describe("J1's review round: the PDF reviewer can finish a real paper (O30)", () => {
  it("a 12-page paper, one page a turn and three source reads, completes under the default budget", async () => {
    // The report's own guard. Fourteen turns — one to read, twelve to view,
    // one to answer — against a default of twelve. Tool calls (15 of 24) never
    // bind here; turns do, which is why the allowance widens both.
    const { item } = await runPanel({
      text: "/review-pdf",
      pages: 12,
      scripts: {
        pdf: [
          reads(3, "src"),
          ...pageRange(12).map((p) => noteAndView(p)),
          ledgerTurn(12),
        ],
      },
      over: { reviewPanel: { reviewers: [] } },
    });
    expect(item?.pdf?.viewed).toEqual(pageRange(12));
    expect(limitsOf(item)).toEqual([]);
    expect(item?.result?.annotations.map((a) => a.id)).toEqual([
      `${PDF_REVIEWER_NAME}-1`,
    ]);
  });

  it("S2's shape — a panel's PDF seat that reads beside every page — completes", async () => {
    // Twenty-five tool calls against twenty-four: J1's panel seat viewed 8 of
    // 9 pages this way and lost its whole report to `budget.tool_calls`.
    const { item } = await runPanel({
      pages: 9,
      scripts: {
        ...HEALTHY,
        pdf: [
          reads(4, "open"),
          ...pageRange(9).map((p) => noteAndView(p, true)),
          reads(3, "anchor"),
          ledgerTurn(9),
        ],
      },
    });
    expect(item?.pdf?.viewed).toEqual(pageRange(9));
    expect(item?.pdfSeat?.status).toBe("completed");
    expect(
      limitsOf(item).filter(
        (l) => "reviewer" in l && l.reviewer === PDF_REVIEWER_NAME,
      ),
    ).toEqual([]);
    expect(
      item?.result?.annotations.filter((a) => a.reviewer === PDF_REVIEWER_NAME),
    ).toHaveLength(1);
  });

  it("the allowance is the PDF reviewer's alone: a turn and a call per page, on top of its carve", async () => {
    const { requests } = await runPanel({ pages: 9 });
    expect(systemOf(bySeat(requests, "pdf")[0])).toContain(
      "at most 21 model turns, 33 tool calls",
    );
    for (const r of [A, B, C]) {
      expect(systemOf(bySeat(requests, r)[0])).toContain(
        "at most 12 model turns, 24 tool calls",
      );
    }
  });

  it("the allowance is capped by the seat's view budget, not by the paper's length", async () => {
    // min(70 pages, 60 views) = 60, on top of twelve turns and 24 calls.
    const { requests } = await runPanel({
      text: "/review-pdf",
      pages: 70,
      over: { reviewPanel: { reviewers: [] } },
    });
    expect(systemOf(bySeat(requests, "pdf")[0])).toContain(
      "at most 72 model turns, 84 tool calls",
    );
  });
});

describe("J1's review round: a seat that runs out of room says which (O31)", () => {
  /** A reviewer that never answers: every turn is a batch of reads. */
  const readsForever = (perTurn: number, turns: number, output = 40) =>
    Array.from({ length: turns }, (_, t) => ({
      ...reads(perTurn, `t${t}`),
      usage: { outputTokens: output },
    }));
  const seatMissing = (item: ReviewItem | undefined, reviewer: string) =>
    limitsOf(item).find(
      (l) => l.kind === "seat_missing" && l.reviewer === reviewer,
    );

  it.each([
    ["tool_calls", readsForever(6, 5)],
    ["turns", readsForever(1, 12)],
    ["output_tokens", readsForever(1, 2, 5_000)],
  ] as const)(
    "a reviewer stopped by its %s budget records it, beside the old detail",
    async (budget, script) => {
      const { item } = await runPanel({
        scripts: { ...HEALTHY, [A]: [...script] },
      });
      expect(seatMissing(item, A)).toEqual({
        kind: "seat_missing",
        reviewer: A,
        reason: "unparsed",
        detail: `the seat produced no report (budget.${budget})`,
        ranOutOf: budget,
      });
    },
  );

  it("so does the PDF reviewer, past its allowance", async () => {
    // Three pages ⇒ 27 calls; five turns of six reads ask for thirty.
    const { item } = await runPanel({
      scripts: { ...HEALTHY, pdf: readsForever(6, 5) },
    });
    expect(seatMissing(item, PDF_REVIEWER_NAME)).toMatchObject({
      reason: "unparsed",
      ranOutOf: "tool_calls",
    });
  });

  it("and when its last words were a page note — the path rule 2 makes the usual one", async () => {
    // Rule 2 has the seat write a note beside every view, so a seat stopped
    // mid-way leaves prose behind rather than silence: the report is read,
    // fails as not JSON, and must still name the budget.
    const noteAndReads = (t: number): ScriptedTurn => ({
      ...reads(6, `n${t}`),
      text: `Page ${t + 1}: a figure and a table, both legible.`,
    });
    const { item } = await runPanel({
      scripts: {
        ...HEALTHY,
        pdf: Array.from({ length: 5 }, (_, t) => noteAndReads(t)),
      },
    });
    expect(seatMissing(item, PDF_REVIEWER_NAME)).toMatchObject({
      reason: "unparsed",
      ranOutOf: "tool_calls",
      detail: expect.stringContaining("pure JSON"),
    });
  });

  it("the history handoff names the budget, in the harness's English", () => {
    const text = renderReviewForHistory({
      annotations: [],
      limits: [
        {
          kind: "seat_missing",
          reviewer: PDF_REVIEWER_NAME,
          reason: "unparsed",
          detail: "the seat produced no report (budget.tool_calls)",
          ranOutOf: "tool_calls",
        },
      ],
    });
    expect(text).toContain(
      `limit: seat_missing — ${PDF_REVIEWER_NAME} reported nothing usable (unparsed) — it ran out of its tool-call budget`,
    );
  });

  it("a seat whose report is merely unreadable records no budget", async () => {
    const { item } = await runPanel({
      scripts: {
        ...HEALTHY,
        [A]: [{ text: "not a ledger" }, { text: "still not a ledger" }],
      },
    });
    const limit = seatMissing(item, A);
    expect(limit).toMatchObject({ reason: "unparsed" });
    expect(limit).not.toHaveProperty("ranOutOf");
  });
});
