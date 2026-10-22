/**
 * V5 (ADR 0087, O5, O20): the PDF reviewer's strengths and its one
 * assessment join the record like the reviewers', and its absent impressions
 * block is re-asked naming `presentation` alone.
 *
 * A file of its own because `review-panel-pdf.test.ts` is one of the suites
 * V5's plan keeps unedited beyond its scripted input; the fixture below is a
 * trimmed copy of that file's, kept to what these cases read.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  GenerateRequest,
  ModelBinding,
  PdfDocument,
  ReviewItem,
  Skill,
  ToolName,
} from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/index.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import {
  ScriptedModelAdapter,
  type ScriptedTurn,
  scriptedByKey,
} from "../../src/model/scripted.js";
import {
  PANEL_SKILL,
  PREFLIGHT_PROMPT,
  REVIEWER_NAMES,
} from "../../src/session/review-panel.js";
import {
  PDF_REVIEWER_NAME,
  PDF_SKILL,
} from "../../src/session/review-pdf-seat.js";
import {
  VERIFIER_BRIEF_MARKER,
  VERIFIER_SKILL,
} from "../../src/session/review-verifier.js";
import { runSessionTask } from "../../src/session/run.js";
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

const seeing: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "model-x",
  apiKey: "k",
  imageInput: true,
};

const skill = (name: string): Skill => ({
  name,
  description: `${name} description`,
  body: `body of ${name}`,
  source: "bundled",
  path: `/skills/${name}/SKILL.md`,
  references: [],
});

const document: PdfDocument = {
  pageCount: 3,
  pageSize: () => ({ width: 595.28, height: 841.89 }),
  renderPage: async (_p, opts) => ({
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    width: opts.width,
    height: opts.width,
  }),
  pageText: async (page) =>
    page === 3 ? "References\n[1] A. Author." : `page ${page} text`,
  pageTextSizes: async () => [{ sizePt: 10.9, chars: 500 }],
  metadata: async () => ({ author: "A. Fixture" }),
  close: () => {},
};

const FILES: Record<
  string,
  { text?: string; bytes?: Uint8Array; mtimeMs: number }
> = {
  "main.tex": { text: MAIN, mtimeMs: 1_000 },
  "main.pdf": {
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    mtimeMs: 10_000,
  },
};

const workspace = {
  root: "/ws",
  async readFile(path: string): Promise<string> {
    const f = FILES[path];
    if (f?.text === undefined) throw new Error(`no such file: ${path}`);
    return f.text;
  },
  async listFiles(): Promise<string[]> {
    return Object.keys(FILES).filter((p) => p.endsWith(".tex"));
  },
  async stat(path: string) {
    const f = FILES[path];
    return f === undefined
      ? undefined
      : { mtimeMs: f.mtimeMs, size: f.bytes?.length ?? 0 };
  },
  async readBinary(path: string): Promise<Uint8Array> {
    const f = FILES[path];
    if (f?.bytes === undefined) throw new Error(`no such file: ${path}`);
    return f.bytes;
  },
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
        if (seatKey(req) === "verifier") return upholdEvery(req).generate(req);
        return inner.generate(keyed(req));
      },
      async *generateStream(req: GenerateRequest) {
        requests.push(req);
        if (seatKey(req) === "verifier") {
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

const view = (page: number): ScriptedTurn => ({
  text: "",
  toolCalls: [
    { id: `v${page}`, name: "view_pdf_pages", args: { pages: [page] } },
  ],
  stopReason: "tool_use",
});

const EMPTY = JSON.stringify({ annotations: [], impressions: {} });
const TABLE = "The table below runs past its column.";
const CAPTION = "\\caption{Cost falls as the sequence grows.}";

/** The PDF seat's ledger: one presentation concern and one strength, each on
 *  a page it viewed — with or without its impressions block. */
const pdfLedger = (impressions: boolean): string =>
  JSON.stringify({
    annotations: [
      {
        dimension: "presentation",
        severity: "major",
        anchor: TABLE,
        evidence: { page: 1 },
        message: "the table runs into the margin",
      },
    ],
    strengths: [
      {
        dimension: "presentation",
        anchor: CAPTION,
        evidence: { page: 2 },
        message: "the figure reads at a glance",
      },
    ],
    ...(impressions ? { impressions: { presentation: 6, claims: 9 } } : {}),
  });

async function runPanel(pdf: ScriptedTurn[]) {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-panel-pdf-v5-"));
  temps.push(dir);
  const store = new SessionStore(join(dir, "sessions"));
  const session = await store.create({ title: "p", workspace: "/ws" });
  const model = panelModel({
    [A]: [{ text: EMPTY }],
    [B]: [{ text: EMPTY }],
    [C]: [{ text: EMPTY }],
    pdf,
    synthesis: [{ text: JSON.stringify({ consensus: [], disagreements: [] }) }],
  });
  const result = await runSessionTask({
    store,
    session,
    model: model.adapter,
    binding: seeing,
    text: "/review",
    registry: readRegistry(),
    skills: [
      skill(PANEL_SKILL),
      skill(PDF_SKILL),
      skill(VERIFIER_SKILL),
      skill("related-work"),
    ],
    workspace,
    paperEntry: "main.tex",
    manuscriptGraph: async (entry: string) => ({
      files: [entry],
      missing: [] as string[],
    }),
    literatureWithhold: { titles: [] },
    reviewPdf: { renderer: async () => document },
  });
  const item = [...result.items]
    .reverse()
    .find((i): i is ReviewItem => i.type === "review");
  return { item, requests: model.requests };
}

describe("the PDF reviewer's strengths and assessment join the record (V5, O5)", () => {
  it("carries its page-evidenced strength and ONE assessment — presentation's", async () => {
    const { item } = await runPanel([
      view(1),
      view(2),
      { text: pdfLedger(true) },
    ]);
    expect(item?.result?.strengths).toEqual([
      expect.objectContaining({
        id: `${PDF_REVIEWER_NAME}-s1`,
        reviewer: PDF_REVIEWER_NAME,
        dimension: "presentation",
        evidence: { kind: "page", page: 2 },
      }),
    ]);
    const mine = (item?.result?.assessments ?? []).filter(
      (a) => a.reviewer === PDF_REVIEWER_NAME,
    );
    // Asked of presentation alone: its "claims" impression is not recorded.
    expect(mine).toEqual([
      { reviewer: PDF_REVIEWER_NAME, dimension: "presentation", impression: 6 },
    ]);
    // Its row counts what its searches came to — it holds no search tool.
    expect(item?.pdfSeat?.searches).toEqual({ attempted: 0, answered: 0 });
    expect(item?.pdfSeat?.ledger?.strengths).toMatchObject({
      entries: 1,
      located: 1,
    });
  });

  it("re-asks its ABSENT block naming presentation alone", async () => {
    const { item, requests } = await runPanel([
      view(1),
      view(2),
      { text: pdfLedger(false) },
      { text: JSON.stringify({ impressions: { presentation: 5 } }) },
    ]);
    expect(item?.pdfSeat?.retried).toBe(true);
    const feedback = requests
      .filter((r) => seatKey(r) === "pdf")
      .flatMap((r) => r.messages)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .find((t) => t.includes("Every entry of your ledger was recorded."));
    expect(feedback).toContain(
      '- your reply carries no "impressions" block; send one, with an integer 1–10 or null for "presentation"',
    );
    expect(feedback).not.toContain("each dimension your brief lists");
    expect(
      item?.result?.assessments?.find((a) => a.reviewer === PDF_REVIEWER_NAME),
    ).toEqual({
      reviewer: PDF_REVIEWER_NAME,
      dimension: "presentation",
      impression: 5,
    });
    // The first pass's concern and strength stand.
    expect(item?.result?.strengths).toHaveLength(1);
  });
});
