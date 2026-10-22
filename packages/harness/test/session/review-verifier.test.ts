import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ChildModel,
  GenerateRequest,
  ModelBinding,
  ReviewAnnotation,
  ReviewItem,
  ReviewLimit,
  SessionEvent,
  SessionItem,
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
import type { BudgetUsed } from "../../src/session/budget.js";
import type { SubtaskChildResult } from "../../src/session/loop-tools/subtask.js";
import {
  PANEL_SEAT_TOKEN_FLOOR,
  PANEL_SKILL,
  PREFLIGHT_PROMPT,
  REVIEWER_NAMES,
  type ReviewPanelDeps,
  runReviewPanel,
} from "../../src/session/review-panel.js";
import {
  VERIFIER_BRIEF_MARKER,
  VERIFIER_CHUNK,
  VERIFIER_NAME,
  VERIFIER_SKILL,
  VERIFIER_THIN_CARVE,
  verifierBrief,
  verifierChunks,
} from "../../src/session/review-verifier.js";
import {
  type RunSessionTaskOptions,
  runSessionTask,
} from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";

/**
 * V1 (ADR 0076 §5): the panel's verifier, driven end to end.
 *
 * Two layers, as `review-panel-driver.test.ts` has them. The first drives a
 * real `runSessionTask` against scripted models keyed by WHO is asking — a
 * reviewer, the verifier, the cross-review — so ordering, survival, the
 * pre-run check and the carve are asserted from the requests the models
 * actually received. The second drives `runReviewPanel` with stub children,
 * for the failure records a scripted model cannot stage: a child that never
 * loaded its protocol, one that stopped on its budget, one the user stopped
 * mid-chunk.
 */

const [A, B, C] = REVIEWER_NAMES as unknown as [string, string, string];

const temps: string[] = [];
async function mkStore(): Promise<SessionStore> {
  const d = await mkdtemp(join(tmpdir(), "lemmaria-review-verifier-"));
  temps.push(d);
  return new SessionStore(join(d, "sessions"));
}
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  apiKey: "k",
};

/** Hard-wrapped: every line is one whole quotable anchor. Lines 7–30 give the
 *  chunking tests more than twenty distinct concerns to raise. */
const FINDINGS = Array.from(
  { length: 24 },
  (_, i) => `Finding ${i + 1} is reported in the appendix.`,
);
const MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "We estimate the effect with a two-stage least squares design.",
  "The instrument is the distance to the nearest treated unit.",
  "Table 2 reports a gain of nine points over the strongest baseline.",
  "Section 5 reports the ablation over every component.",
  ...FINDINGS,
  "\\end{document}",
  "",
].join("\n");
/** The passage that answers reviewer_a-1 — line 6 of main.tex. */
const ANSWER = "Section 5 reports the ablation over every component.";

const METHOD = [
  "The estimator is defined in Appendix A.",
  "The bandwidth is chosen by cross-validation.",
  "",
].join("\n");

const skill = (name: string): Skill => ({
  name,
  description: `${name} description`,
  body: `body of ${name}`,
  source: "bundled",
  path: `/skills/${name}/SKILL.md`,
  references: [],
});

function workspace() {
  const tree: Record<string, string> = {
    "main.tex": MAIN,
    "sections/method.tex": METHOD,
  };
  return {
    root: "/ws",
    async readFile(path: string): Promise<string> {
      const content = tree[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    async listFiles(): Promise<string[]> {
      return Object.keys(tree);
    },
  };
}

const graphReader = async (entry: string) => ({
  files: [entry, "sections/method.tex"],
  missing: [] as string[],
});

function readRegistry(): Map<ToolName, ToolExecutor> {
  const r = new Map<ToolName, ToolExecutor>();
  for (const name of ["read_span", "grep_project"] as const) {
    r.set(name, {
      name,
      category: "retrieval",
      spec: { name, description: name, parameters: { type: "object" } },
      invoke: async () => ok({ content: MAIN }),
    });
  }
  return r;
}

type WireConcern = Record<string, unknown>;
const concern = (anchor: string, over: WireConcern = {}): WireConcern => ({
  dimension: "soundness",
  severity: "major",
  blocking: true,
  anchor,
  // The WIRE form, which V2 left unchanged (ADR 0078, D2) — the tag is on
  // what the harness STORES, never on what a model writes.
  evidence: "missing",
  message: "this does not follow from what is shown",
  ...over,
});
const ledger = (...concerns: WireConcern[]): string =>
  JSON.stringify({ annotations: concerns, impressions: {} });

const EMPTY = JSON.stringify({ annotations: [], impressions: {} });
const NO_SYNTHESIS = JSON.stringify({ consensus: [], disagreements: [] });

/** Three reviewers, one located concern each. */
const HEALTHY: Record<string, ScriptedTurn[]> = {
  [A]: [
    {
      text: ledger(
        concern("The instrument is the distance to the nearest treated unit."),
      ),
    },
  ],
  [B]: [
    {
      text: ledger(
        concern(
          "Table 2 reports a gain of nine points over the strongest baseline.",
          { dimension: "claims" },
        ),
      ),
    },
  ],
  [C]: [
    {
      text: ledger(
        concern(
          "We estimate the effect with a two-stage least squares design.",
          { dimension: "positioning", severity: "minor", blocking: undefined },
        ),
      ),
    },
  ],
  synthesis: [
    {
      text: JSON.stringify({
        consensus: [{ ids: [`${B}-1`, `${C}-1`], note: "both see a gap" }],
        disagreements: [],
      }),
    },
  ],
};

/** The marker every verifier brief opens its prose with (ADR 0076 §5). */
const VERIFIER_MARKER = VERIFIER_BRIEF_MARKER;

function firstUserText(req: GenerateRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  return typeof first?.content === "string" ? first.content : "";
}

function seatKey(req: GenerateRequest): string {
  const text = firstUserText(req);
  if (text === PREFLIGHT_PROMPT) return "preflight";
  for (const name of REVIEWER_NAMES) {
    if (text.includes(`\`${name}\`, one of `)) return name;
  }
  if (text.includes(VERIFIER_MARKER)) return "verifier";
  return text.includes("reviewers have each read") ? "synthesis" : text;
}

/** The concern ids a verifier brief hands its child, read from its JSON. */
function idsIn(brief: string): string[] {
  const line = brief.split("\n").find((l) => l.startsWith('{"concerns":'));
  if (line === undefined) return [];
  const parsed = JSON.parse(line) as { concerns: Array<{ id: string }> };
  return parsed.concerns.map((c) => c.id);
}

const upheld = (ids: readonly string[]): string =>
  JSON.stringify({
    verifications: ids.map((id) => ({
      id,
      kind: "absence",
      outcome: "upheld",
    })),
  });

/**
 * How a verifier child answers: its brief, and the feedback it was handed on
 * a re-ask (undefined on its first answer). The default upholds every id it
 * was given — the shape every existing panel test runs under since V1.
 */
type VerifierScript = (
  brief: string,
  feedback: string | undefined,
) => ScriptedTurn;
const upholdAll: VerifierScript = (brief) => ({ text: upheld(idsIn(brief)) });

function panelModel(
  scripts: Record<string, ScriptedTurn[]>,
  verifier: VerifierScript = upholdAll,
) {
  const inner = scriptedByKey(scripts);
  const requests: GenerateRequest[] = [];
  const serve = (req: GenerateRequest): ScriptedModelAdapter | undefined => {
    if (seatKey(req) !== "verifier") return undefined;
    const users = req.messages.filter(
      (m) => m.role === "user" && typeof m.content === "string",
    );
    const last = users[users.length - 1];
    const feedback =
      users.length > 1 && typeof last?.content === "string"
        ? last.content
        : undefined;
    return new ScriptedModelAdapter([verifier(firstUserText(req), feedback)]);
  };
  return {
    requests,
    adapter: {
      protocol: "anthropic" as const,
      generate: (req: GenerateRequest) => {
        requests.push(req);
        const v = serve(req);
        if (v) return v.generate(req);
        return inner.generate({
          ...req,
          messages: [{ role: "user" as const, content: seatKey(req) }],
        });
      },
      async *generateStream(req: GenerateRequest) {
        requests.push(req);
        const v = serve(req);
        if (v) {
          yield* v.generateStream(req);
          return;
        }
        const stream = inner.generateStream as (
          r: GenerateRequest,
        ) => AsyncIterable<unknown>;
        yield* stream({
          ...req,
          messages: [
            ...req.messages.filter((m) => m.role === "system"),
            { role: "user" as const, content: seatKey(req) },
          ],
        }) as AsyncIterable<never>;
      },
    },
  };
}

async function runPanel(
  scripts: Record<string, ScriptedTurn[]>,
  over: Partial<RunSessionTaskOptions> = {},
  verifier?: VerifierScript,
) {
  const store = await mkStore();
  const session = await store.create({ title: "p", workspace: "/ws" });
  const model = panelModel(scripts, verifier);
  const events: SessionEvent[] = [];
  const result = await runSessionTask({
    store,
    session,
    model: model.adapter,
    binding,
    text: "/review",
    registry: readRegistry(),
    skills: [skill(PANEL_SKILL), skill(VERIFIER_SKILL)],
    workspace: workspace(),
    paperEntry: "main.tex",
    manuscriptGraph: graphReader,
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { result, events, requests: model.requests };
}

const reviewItem = (items: readonly SessionItem[]): ReviewItem | undefined =>
  [...items].reverse().find((i): i is ReviewItem => i.type === "review");

const limitsOf = (item: ReviewItem | undefined): ReviewLimit[] =>
  item?.result?.limits ?? [];

const verificationLimits = (item: ReviewItem | undefined) =>
  limitsOf(item).filter((l) => l.kind === "verification_missing");

const keysOf = (requests: readonly GenerateRequest[]): string[] =>
  requests.map(seatKey);

/** A verifier that refutes the listed ids with `ANSWER` and upholds the rest. */
const refuting =
  (withdrawn: readonly string[]): VerifierScript =>
  (brief) => ({
    text: JSON.stringify({
      verifications: idsIn(brief).map((id) =>
        withdrawn.includes(id)
          ? {
              id,
              kind: "absence",
              outcome: "refuted",
              counter: { anchor: ANSWER, file: "main.tex" },
              note: "Section 5 carries the ablation.",
            }
          : { id, kind: "absence", outcome: "upheld" },
      ),
    }),
  });

describe("O7 — where the verifier runs, and what survives it", () => {
  it("runs after every reviewer has settled and before the cross-review", async () => {
    const { requests, result } = await runPanel(HEALTHY);
    const keys = keysOf(requests);
    const verifier = keys.indexOf("verifier");
    expect(verifier).toBeGreaterThan(-1);
    for (const name of [A, B, C]) {
      expect(keys.lastIndexOf(name)).toBeLessThan(verifier);
    }
    expect(keys.indexOf("synthesis")).toBeGreaterThan(verifier);
    const item = reviewItem(result.items);
    expect(item?.status).toBe("completed");
    expect(item?.verification).toBe("completed");
    expect(verificationLimits(item)).toEqual([]);
  });

  it("hands the cross-review only the concerns that survived", async () => {
    const { requests, result } = await runPanel(
      HEALTHY,
      {},
      refuting([`${A}-1`]),
    );
    const synth = requests.find((r) => seatKey(r) === "synthesis");
    const brief = firstUserText(synth as GenerateRequest);
    expect(brief).not.toContain(`${A}-1`);
    expect(brief).toContain(`${B}-1`);
    expect(brief).toContain(`${C}-1`);
    // Withdrawn, never deleted: the concern is still in the result, carrying
    // the passage that answers it.
    const annotations = reviewItem(result.items)?.result?.annotations ?? [];
    expect(annotations.map((a) => a.id)).toEqual([
      `${A}-1`,
      `${B}-1`,
      `${C}-1`,
    ]);
    const withdrawn = annotations[0];
    expect(withdrawn?.verification).toEqual({
      outcome: "refuted",
      kind: "absence",
      counter: { file: "main.tex", line: 6 },
      note: "Section 5 carries the ablation.",
    });
    // Every other field is the reviewer's own, untouched (stage-gate claim 2).
    expect(withdrawn?.message).toBe("this does not follow from what is shown");
    expect(withdrawn?.severity).toBe("major");
    expect(withdrawn?.blocking).toBe(true);
    expect(withdrawn?.span).toEqual({ file: "main.tex", line: 4 });
    expect(withdrawn?.evidence).toEqual({ kind: "missing" });
    expect(annotations[1]?.verification?.outcome).toBe("upheld");
    expect(reviewItem(result.items)?.result?.synthesis).toBeDefined();
  });

  it("rejects a withdrawn id if the cross-review cites it anyway", async () => {
    const { requests, result } = await runPanel(
      {
        ...HEALTHY,
        synthesis: [
          {
            text: JSON.stringify({
              consensus: [{ ids: [`${A}-1`, `${B}-1`], note: "x" }],
              disagreements: [],
            }),
          },
          { text: NO_SYNTHESIS },
        ],
      },
      {},
      refuting([`${A}-1`]),
    );
    const synthRequests = requests.filter((r) => seatKey(r) === "synthesis");
    // The re-ask fired — the withdrawn id is uncitable by construction.
    expect(synthRequests).toHaveLength(2);
    expect(JSON.stringify(synthRequests[1]?.messages)).toContain(
      `\\"${A}-1\\" is not a concern in this review`,
    );
    expect(reviewItem(result.items)?.result?.synthesis).toEqual({
      consensus: [],
      disagreements: [],
    });
  });

  it("every concern withdrawn leaves nothing to cross-review", async () => {
    const { requests, result } = await runPanel(
      HEALTHY,
      {},
      refuting([`${A}-1`, `${B}-1`, `${C}-1`]),
    );
    expect(keysOf(requests)).not.toContain("synthesis");
    const item = reviewItem(result.items);
    expect(limitsOf(item)).toContainEqual({
      kind: "synthesis_missing",
      reason: "insufficient_seats",
    });
    expect(item?.result?.annotations).toHaveLength(3);
  });

  it("records the verifier as one sibling seat, with its counts", async () => {
    const { result, events } = await runPanel(
      HEALTHY,
      {},
      refuting([`${A}-1`]),
    );
    const item = reviewItem(result.items);
    expect(item?.seats.map((s) => s.reviewer)).toEqual([A, B, C]);
    expect(item?.verifierSeat).toMatchObject({
      reviewer: VERIFIER_NAME,
      status: "completed",
      model: binding.model,
      verification: {
        concerns: 3,
        upheld: 2,
        refuted: 1,
        unverifiable: 0,
        downgraded: 0,
        unanswered: 0,
      },
    });
    expect(item?.verifierSeat?.usage?.outputTokens).toBeGreaterThan(0);
    // The live stream says it started, with the seat, before it settled.
    const started = events.find(
      (e) => e.type === "item.started" && e.item.type === "review",
    ) as Extract<SessionEvent, { type: "item.started" }> | undefined;
    expect((started?.item as ReviewItem).verification).toBe("pending");
    const running = events.find(
      (e) =>
        e.type === "item.updated" &&
        e.item.type === "review" &&
        (e.item as ReviewItem).verification === "running",
    ) as Extract<SessionEvent, { type: "item.updated" }> | undefined;
    expect((running?.item as ReviewItem).verifierSeat?.status).toBe("running");
  });
});

describe("O10 — chunks of at most twenty", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `c-${i + 1}`);

  it.each([
    [1, [1]],
    [20, [20]],
    [21, [11, 10]],
    [40, [20, 20]],
    [41, [14, 14, 13]],
    [161, [21, 20, 20, 20, 20, 20, 20, 20]],
  ])("%i concerns → chunk sizes %j", (n, sizes) => {
    const chunks = verifierChunks(ids(n));
    expect(chunks.map((c) => c.length)).toEqual(sizes);
    // Contiguous, in order, every concern exactly once.
    expect(chunks.flat()).toEqual(ids(n));
  });

  it("nothing to chunk is no chunk", () => {
    expect(verifierChunks([])).toEqual([]);
    expect(VERIFIER_CHUNK).toBe(20);
  });

  /** One reviewer that raises 21 located concerns. */
  const TWENTY_ONE = {
    [A]: [
      {
        text: ledger(
          ...FINDINGS.slice(0, 21).map((line) =>
            concern(line, { severity: "minor", blocking: undefined }),
          ),
        ),
      },
    ],
  };

  it("21 concerns run as two children, each briefed with its own ids", async () => {
    const { requests, result } = await runPanel(TWENTY_ONE, {
      reviewPanel: { reviewers: [{}] },
    });
    const briefs = [
      ...new Set(
        requests
          .filter((r) => seatKey(r) === "verifier")
          .map((r) => firstUserText(r)),
      ),
    ];
    expect(briefs).toHaveLength(2);
    const [first, second] = briefs.map(idsIn) as [string[], string[]];
    expect(first).toHaveLength(11);
    expect(second).toHaveLength(10);
    expect([...first, ...second].sort()).toEqual(
      Array.from({ length: 21 }, (_, i) => `${A}-${i + 1}`).sort(),
    );
    const item = reviewItem(result.items);
    expect(item?.verifierSeat?.verification?.upheld).toBe(21);
    expect(verificationLimits(item)).toEqual([]);
    // N = 1 verifies like any other panel; only the cross-review needs two.
    expect(limitsOf(item)).toContainEqual({
      kind: "synthesis_missing",
      reason: "insufficient_seats",
    });
  });

  it("each child's check reads only its own ids", async () => {
    // The first chunk answers one id that belongs to the second: that entry
    // is a problem for the FIRST child, and the second child answers it.
    const stray = `${A}-21`;
    const verifier: VerifierScript = (brief) => {
      const mine = idsIn(brief);
      return {
        text: upheld(mine.includes(`${A}-1`) ? [...mine, stray] : mine),
      };
    };
    const { requests, result } = await runPanel(
      TWENTY_ONE,
      { reviewPanel: { reviewers: [{}] } },
      verifier,
    );
    const firstChild = requests.filter(
      (r) =>
        seatKey(r) === "verifier" && idsIn(firstUserText(r)).includes(`${A}-1`),
    );
    expect(JSON.stringify(firstChild.at(-1)?.messages)).toContain(
      `\\"${stray}\\" is not a concern in your brief`,
    );
    const item = reviewItem(result.items);
    expect(item?.verifierSeat?.verification?.upheld).toBe(21);
    expect(item?.verifierSeat?.retried).toBe(true);
  });
});

describe("O11 — the verifier's model, and Off", () => {
  const otherBinding: ModelBinding = {
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com",
    model: "claude-haiku-4-5",
    apiKey: "k2",
  };

  it("runs on its own model when bound, and that model is preflighted with the rest", async () => {
    const second = panelModel({});
    const { requests, result } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [{}, {}, {}],
        verifier: { adapter: second.adapter, binding: otherBinding },
      },
    });
    expect(keysOf(requests)).not.toContain("verifier");
    expect(keysOf(second.requests)).toEqual(["preflight", "verifier"]);
    const item = reviewItem(result.items);
    expect(item?.preflight?.map((p) => p.model)).toEqual([
      binding.model,
      otherBinding.model,
    ]);
    expect(item?.verifierSeat?.model).toBe(otherBinding.model);
  });

  it("defaults to the cross-review's model, preflighted once with it", async () => {
    const synthesis = panelModel(HEALTHY);
    const { requests, result } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [{}, {}, {}],
        synthesis: { adapter: synthesis.adapter, binding: otherBinding },
      },
    });
    expect(keysOf(requests)).not.toContain("verifier");
    expect(keysOf(synthesis.requests)).toEqual([
      "preflight",
      "verifier",
      "synthesis",
    ]);
    expect(reviewItem(result.items)?.preflight).toHaveLength(2);
  });

  it("an unfunded verifier key refuses the panel before any reviewer runs", async () => {
    const second = panelModel({
      preflight: [
        {
          text: "",
          failure: { message: "credit balance too low", status: 400 },
        },
      ],
    });
    const { requests, result } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [{}, {}, {}],
        verifier: { adapter: second.adapter, binding: otherBinding },
      },
    });
    expect(keysOf(requests)).toEqual(["preflight"]);
    const item = reviewItem(result.items);
    expect(item?.status).toBe("failed");
    expect(item?.seats).toEqual([]);
  });

  it("Off makes no request of any kind, and says so in the record", async () => {
    const { requests, result, events } = await runPanel(HEALTHY, {
      reviewPanel: { reviewers: [{}, {}, {}], verifier: "off" },
    });
    expect(keysOf(requests)).not.toContain("verifier");
    expect(keysOf(requests).filter((k) => k === "preflight")).toHaveLength(1);
    const item = reviewItem(result.items);
    expect(item?.verification).toBe("off");
    expect(item?.verifierSeat).toBeUndefined();
    expect(verificationLimits(item)).toEqual([
      { kind: "verification_missing", reason: "off" },
    ]);
    // Unverified concerns carry no verification, and the cross-review reads
    // all of them.
    expect(
      item?.result?.annotations.every((a) => a.verification === undefined),
    ).toBe(true);
    expect(item?.result?.synthesis).toBeDefined();
    const started = events.find(
      (e) => e.type === "item.started" && e.item.type === "review",
    ) as Extract<SessionEvent, { type: "item.started" }> | undefined;
    expect((started?.item as ReviewItem).verification).toBe("off");
  });
});

describe("O12 — every way of falling short is its own record", () => {
  it("no_protocol: the skill was not offered, so nothing is asked", async () => {
    const { requests, result } = await runPanel(HEALTHY, {
      skills: [skill(PANEL_SKILL)],
    });
    expect(keysOf(requests)).not.toContain("verifier");
    const item = reviewItem(result.items);
    expect(item?.verification).toBe("missing");
    expect(verificationLimits(item)).toEqual([
      { kind: "verification_missing", reason: "no_protocol" },
    ]);
    expect(item?.result?.synthesis).toBeDefined();
  });

  it("nothing located: no request, no limit, and the state says skipped", async () => {
    const { requests, result } = await runPanel({
      [A]: [{ text: EMPTY }],
      [B]: [{ text: EMPTY }],
      [C]: [{ text: EMPTY }],
    });
    expect(keysOf(requests)).not.toContain("verifier");
    const item = reviewItem(result.items);
    expect(item?.verification).toBe("skipped");
    expect(verificationLimits(item)).toEqual([]);
    expect(item?.verifierSeat).toBeUndefined();
  });

  it("interrupted before it starts: recorded, and nothing asked", async () => {
    const controller = new AbortController();
    const { requests, result } = await runPanel(HEALTHY, {
      signal: controller.signal,
      onEvent: (e) => {
        if (
          e.type === "item.updated" &&
          e.item.type === "review" &&
          (e.item as ReviewItem).seats.every((s) => s.status === "completed")
        ) {
          controller.abort();
        }
      },
    });
    expect(keysOf(requests)).not.toContain("verifier");
    const item = reviewItem(result.items);
    expect(item?.status).toBe("interrupted");
    expect(verificationLimits(item)).toEqual([
      { kind: "verification_missing", reason: "interrupted" },
    ]);
  });

  it("unparsed: an unreadable reply, asked once more, is recorded with its detail", async () => {
    const { requests, result } = await runPanel(HEALTHY, {}, () => ({
      text: "Every concern stands.",
    }));
    expect(keysOf(requests).filter((k) => k === "verifier")).toHaveLength(2);
    const item = reviewItem(result.items);
    const [limit] = verificationLimits(item);
    expect(limit).toMatchObject({
      kind: "verification_missing",
      reason: "unparsed",
    });
    expect((limit as { detail?: string }).detail).toContain("pure JSON");
    expect(item?.verifierSeat?.verification?.unanswered).toBe(3);
  });

  it("incomplete: a concern still unanswered after the re-ask", async () => {
    const { result } = await runPanel(HEALTHY, {}, (brief) => ({
      text: upheld(idsIn(brief).slice(0, 2)),
    }));
    const item = reviewItem(result.items);
    expect(verificationLimits(item)).toEqual([
      { kind: "verification_missing", reason: "incomplete" },
    ]);
    expect(item?.verifierSeat?.verification).toMatchObject({
      upheld: 2,
      unanswered: 1,
    });
    expect(item?.verifierSeat?.retried).toBe(true);
  });

  it("failed: the child's cause is on the record", async () => {
    const { result } = await runPanel(HEALTHY, {}, () => ({
      text: "",
      failure: { message: "credit balance too low", status: 400 },
    }));
    const item = reviewItem(result.items);
    expect(verificationLimits(item)).toEqual([
      {
        kind: "verification_missing",
        reason: "failed",
        cause: { class: "quota", message: "credit balance too low" },
      },
    ]);
    expect(item?.verifierSeat?.status).toBe("failed");
    // Unverified, not withdrawn: the cross-review still reads every concern.
    expect(item?.result?.synthesis).toBeDefined();
  });
});

/**
 * V1's J1 round (2026-09-19) drove two panels on a real paper at the shipped
 * `lemmaria.budget.maxTokens: 16000` and saw this notice on EVERY run, while
 * verification finished every time. The carve was adequate; the THRESHOLD was
 * `PANEL_SEAT_TOKEN_FLOOR`, which sizes a reviewer. The gap between the two
 * constants is pinned in O12, where the child's ceiling is observable.
 */
describe("O9 — the verifier's carve", () => {
  const budgetNotice = (items: readonly SessionItem[]) =>
    items.find(
      (i) => i.type === "notice" && i.code === "review.verifier_budget",
    ) as { n?: number } | undefined;

  it("under the verifier's own thin-carve mark it warns, and still runs", async () => {
    const { requests, result } = await runPanel(HEALTHY, {
      ceilings: { maxOutputTokens: PANEL_SEAT_TOKEN_FLOOR },
    });
    const notice = budgetNotice(result.items);
    expect(notice).toBeDefined();
    expect(notice?.n).toBeLessThan(VERIFIER_THIN_CARVE);
    expect(keysOf(requests)).toContain("verifier");
  });

  it("no warning when the carve is ample", async () => {
    const { result } = await runPanel(HEALTHY);
    expect(budgetNotice(result.items)).toBeUndefined();
  });
});

/**
 * The deps-level layer: `runReviewPanel` with stub children, for the records
 * a scripted model cannot stage.
 */
describe("O12 — the records only a stub child can stage", () => {
  const stubParent = (): ChildModel => ({
    adapter: new ScriptedModelAdapter([
      { text: "ready", usage: { inputTokens: 0, outputTokens: 0 } },
    ]),
    binding,
  });

  const loaded = (name: string): SessionItem => ({
    id: `load-${name}`,
    type: "tool_call",
    tool: "load_skill",
    argsJson: JSON.stringify({ name }),
    status: "completed",
    resultJson: "{}",
  });
  const said = (text: string): SessionItem => ({
    id: `m-${text.length}`,
    type: "agent_message",
    text,
  });

  type VerifierStub = (
    goal: string,
    check: ((text: string) => string | undefined) | undefined,
    ceiling: number,
  ) => SubtaskChildResult;

  async function direct(
    seatLedgers: readonly string[],
    verifier: VerifierStub,
    over: Partial<ReviewPanelDeps> = {},
  ) {
    const items: SessionItem[] = [];
    const notices: string[] = [];
    let used: BudgetUsed = { turns: 0, toolCalls: 0, outputTokens: 0 };
    const verifierGoals: string[] = [];
    await runReviewPanel({
      emit: async () => {},
      emitItem: async (i) => {
        items.push(i);
      },
      emitNotice: async (code) => {
        notices.push(code);
      },
      runChild: async (goal, _tools, ceiling, _skills, check) => {
        const reviewer = REVIEWER_NAMES.findIndex((n) =>
          goal.includes(`\`${n}\`, one of `),
        );
        if (reviewer >= 0) {
          return {
            status: "completed",
            items: [loaded(PANEL_SKILL), said(seatLedgers[reviewer] ?? EMPTY)],
          };
        }
        if (goal.includes(VERIFIER_MARKER)) {
          verifierGoals.push(goal);
          return verifier(goal, check, ceiling.maxOutputTokens ?? 0);
        }
        return { status: "completed", items: [said(NO_SYNTHESIS)] };
      },
      parentAllowed: ["read_span", "get_outline", "list_files", "grep_project"],
      offeredSkills: [skill(PANEL_SKILL), skill(VERIFIER_SKILL)],
      budget: { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: 60_000 },
      usedSoFar: () => used,
      accrue: (u) => {
        used = { ...used, outputTokens: used.outputTokens + u.outputTokens };
      },
      fanOutConcurrency: 3,
      parentModel: binding.model,
      parent: stubParent(),
      workspace: workspace(),
      paperEntry: "main.tex",
      reviewers: seatLedgers.map(() => ({})),
      ...over,
    });
    const item = [...items]
      .reverse()
      .find((i): i is ReviewItem => i.type === "review");
    return { item, notices, verifierGoals };
  }

  const TWO_SEATS = [
    ledger(
      concern("The instrument is the distance to the nearest treated unit."),
    ),
    ledger(
      concern(
        "Table 2 reports a gain of nine points over the strongest baseline.",
      ),
    ),
  ];

  it("no_protocol: a child that never completed its load — its answers are discarded", async () => {
    const { item } = await direct(TWO_SEATS, (goal) => ({
      status: "completed",
      // A refutation with a real, located counter — and no load in sight.
      items: [said(refuting([`${A}-1`])(goal, undefined).text ?? "")],
    }));
    expect(verificationLimits(item)).toEqual([
      { kind: "verification_missing", reason: "no_protocol" },
    ]);
    // Discarded: an unguided verifier is not evidence, so nothing withdrew.
    expect(
      item?.result?.annotations.every((a) => a.verification === undefined),
    ).toBe(true);
    expect(item?.verifierSeat?.verification?.unanswered).toBe(2);
  });

  it("no_report: a child that stopped on its budget says which budget", async () => {
    const { item } = await direct(TWO_SEATS, () => ({
      status: "completed",
      items: [
        loaded(VERIFIER_SKILL),
        {
          id: "n",
          type: "notice",
          code: "budget.output_tokens",
          message: "out of tokens",
        },
      ],
    }));
    expect(verificationLimits(item)).toEqual([
      {
        kind: "verification_missing",
        reason: "no_report",
        detail: "budget.output_tokens",
      },
    ]);
  });

  it("interrupted during: a finished chunk is kept, the stopped one is recorded", async () => {
    const controller = new AbortController();
    const many = [
      ledger(
        ...FINDINGS.slice(0, 21).map((line) =>
          concern(line, { severity: "minor", blocking: undefined }),
        ),
      ),
    ];
    const { item } = await direct(
      many,
      (goal) => {
        if (idsIn(goal).includes(`${A}-1`)) {
          return {
            status: "completed",
            items: [loaded(VERIFIER_SKILL), said(upheld(idsIn(goal)))],
          };
        }
        controller.abort();
        return { status: "interrupted", items: [loaded(VERIFIER_SKILL)] };
      },
      { signal: controller.signal, fanOutConcurrency: 1 },
    );
    expect(item?.status).toBe("interrupted");
    expect(verificationLimits(item)).toEqual([
      { kind: "verification_missing", reason: "interrupted" },
    ]);
    expect(item?.verifierSeat?.status).toBe("interrupted");
    expect(item?.verifierSeat?.verification).toMatchObject({
      upheld: 11,
      unanswered: 10,
    });
    expect(
      item?.result?.annotations.filter((a) => a.verification !== undefined),
    ).toHaveLength(11);
  });

  it("carves each child as if one more were running, with no floor", async () => {
    const ceilings: number[] = [];
    await direct(TWO_SEATS, (goal, _check, ceiling) => {
      ceilings.push(ceiling);
      return {
        status: "completed",
        items: [loaded(VERIFIER_SKILL), said(upheld(idsIn(goal)))],
      };
    });
    // Nothing was spent (the stub children report no usage), so carve(k + 1)
    // with k = 1 is exactly half the task's ceiling.
    expect(ceilings).toEqual([30_000]);
  });

  /**
   * The J1 regression, at the layer that can see the number. A carve in
   * [`VERIFIER_THIN_CARVE`, `PANEL_SEAT_TOKEN_FLOOR`) is ample for a reply
   * bounded by `VERIFIER_CHUNK` entries, and used to be announced as
   * underfunded on every run at the shipped default.
   */
  it("a carve over the verifier's mark but under the seat's says nothing", async () => {
    const ceilings: number[] = [];
    const { notices } = await direct(
      TWO_SEATS,
      (goal, _check, ceiling) => {
        ceilings.push(ceiling);
        return {
          status: "completed",
          items: [loaded(VERIFIER_SKILL), said(upheld(idsIn(goal)))],
        };
      },
      { budget: { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: 6_000 } },
    );
    expect(ceilings[0]).toBeGreaterThanOrEqual(VERIFIER_THIN_CARVE);
    expect(ceilings[0]).toBeLessThan(PANEL_SEAT_TOKEN_FLOOR);
    expect(notices).not.toContain("review.verifier_budget");
  });

  it("a carve under the verifier's own mark still says so", async () => {
    const ceilings: number[] = [];
    const { notices } = await direct(
      TWO_SEATS,
      (goal, _check, ceiling) => {
        ceilings.push(ceiling);
        return {
          status: "completed",
          items: [loaded(VERIFIER_SKILL), said(upheld(idsIn(goal)))],
        };
      },
      { budget: { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: 3_000 } },
    );
    expect(ceilings[0]).toBeLessThan(VERIFIER_THIN_CARVE);
    expect(notices).toContain("review.verifier_budget");
  });
});

/**
 * V2 (O17, ADR 0078 §7): what the verifier is actually SHOWN of a cited paper.
 *
 * The code review's I1 found this half of O17 untested, and it is the half the
 * milestone's headline claim rests on. `abstractsHanded` decides whether a
 * `literature` concern may be refuted at all; `verifierBrief` decides whether
 * the verifier has anything to refute it FROM. If the brief silently carried no
 * abstract, every literature refutation would downgrade to `not_refutable` and
 * L4's live assertion -- "a refuted literature concern had a paper behind it"
 * -- would pass vacuously, because there would be no refuted literature
 * concerns to iterate over.
 */
describe("verifierBrief renders a paper, with its abstract (V2, O17)", () => {
  const ctx = {
    entry: "main.tex",
    files: ["main.tex"],
    wrapping: "hard-wrapped",
  };

  const paperConcern = (id: string): ReviewAnnotation =>
    ({
      id,
      reviewer: "reviewer_a",
      dimension: "originality",
      severity: "major",
      span: { file: "main.tex", line: 42 },
      message: "the combination is not new",
      evidence: {
        kind: "paper",
        title: "Adam: A Method for Stochastic Optimization",
        authors: ["Kingma", "Ba"],
        year: "2015",
        source: "arxiv",
      },
    }) as ReviewAnnotation;

  /** The brief's one JSON line, parsed back. */
  const rowsOf = (brief: string): Array<Record<string, unknown>> => {
    const line = brief
      .split(String.fromCharCode(10))
      .find((l) => l.startsWith('{"concerns":'));
    expect(line, "the brief carries no concerns JSON").toBeDefined();
    return (
      JSON.parse(line as string) as { concerns: Array<Record<string, unknown>> }
    ).concerns;
  };

  it("carries the abstract when one was recorded for THAT concern", () => {
    const brief = verifierBrief(
      [paperConcern("reviewer_a-1")],
      ctx,
      new Map([
        [
          "reviewer_a-1",
          "We introduce Adam, an algorithm for first-order gradient-based optimization.",
        ],
      ]),
    );
    expect(rowsOf(brief)[0]?.evidence).toEqual({
      paper: {
        title: "Adam: A Method for Stochastic Optimization",
        year: "2015",
        abstract:
          "We introduce Adam, an algorithm for first-order gradient-based optimization.",
      },
    });
    // The authors, venue, DOI and source stay behind: the abstract is all the
    // verifier may reason from, because it is the only thing anyone here has
    // actually read of the work.
    expect(JSON.stringify(rowsOf(brief)[0])).not.toContain("Kingma");
    expect(JSON.stringify(rowsOf(brief)[0])).not.toContain("arxiv");
  });

  it("omits the abstract key entirely when none was recorded", () => {
    // Absent stays absent. This is the case that keeps `abstractsHanded`
    // smaller than the set of papers, and it is why the gate is a set rather
    // than a boolean.
    const brief = verifierBrief([paperConcern("reviewer_a-1")], ctx);
    expect(rowsOf(brief)[0]?.evidence).toEqual({
      paper: {
        title: "Adam: A Method for Stochastic Optimization",
        year: "2015",
      },
    });
  });

  it("hands an abstract only to the concern it was recorded for", () => {
    // A map keyed by the WRONG id must not leak into this concern's row.
    const brief = verifierBrief(
      [paperConcern("reviewer_a-1")],
      ctx,
      new Map([["reviewer_b-3", "someone else's abstract"]]),
    );
    expect(JSON.stringify(rowsOf(brief))).not.toContain("someone else");
  });

  it("leaves a span and a missing evidence exactly as they were", () => {
    // V2 widened what `evidence` can be; it changed nothing about the two
    // shapes the verifier already read.
    const span = {
      ...paperConcern("reviewer_a-1"),
      evidence: { kind: "span", file: "sections/method.tex", line: 7 },
    } as ReviewAnnotation;
    const missing = {
      ...paperConcern("reviewer_a-2"),
      evidence: { kind: "missing" },
    } as ReviewAnnotation;
    const rows = rowsOf(verifierBrief([span, missing], ctx, new Map()));
    expect(rows[0]?.evidence).toBe("sections/method.tex:7");
    expect(rows[1]?.evidence).toBe("missing");
  });
});

/**
 * V2 (O17, ADR 0078 §7): the abstract handed to the verifier comes from THAT
 * seat's own searches.
 *
 * The code review's I1, second half. O17's own words are *"a paper with the
 * abstract **that seat's** search recorded"*, and pooling every seat's results
 * into one lookup would have passed every other test in the repo — both seats
 * cite the same title, and a pooled map would hand the abstract to both.
 */
describe("the abstract handed is the citing seat's own (V2, O17)", () => {
  const TITLE = "Adam: A Method for Stochastic Optimization";
  const ABSTRACT =
    "We introduce Adam, an algorithm for first-order optimization.";

  /** A search whose result carries an abstract only for the query naming one. */
  function literatureRegistry(): Map<ToolName, ToolExecutor> {
    const r = readRegistry();
    r.set("literature_search", {
      name: "literature_search",
      category: "retrieval",
      spec: {
        name: "literature_search",
        description: "search",
        parameters: { type: "object" },
      },
      invoke: async (args) => {
        const withAbstract = (args as { query?: string }).query === "with";
        return ok({
          sources: [{ name: "arxiv", endpoint: "x", status: "ok" }],
          results: [
            {
              title: TITLE,
              authors: ["Kingma", "Ba"],
              year: "2015",
              source: "arxiv",
              ...(withAbstract ? { abstract: ABSTRACT } : {}),
            },
          ],
        });
      },
    });
    return r;
  }

  const searchThenCite = (query: string): ScriptedTurn[] => [
    {
      toolCalls: [
        { id: `s-${query}`, name: "literature_search", args: { query } },
      ],
    },
    {
      text: ledger(
        concern("The instrument is the distance to the nearest treated unit.", {
          dimension: "originality",
          evidence: { paper: { title: TITLE } },
        }),
      ),
    },
  ];

  it("gives the abstract to the seat whose search recorded it, and to no other", async () => {
    const { result, requests } = await runPanel(
      {
        // A searched with an abstract in the result; B searched and got the
        // same paper WITHOUT one. Both cite it, so both concerns survive
        // validation -- which is what makes this a per-seat question rather
        // than a validation one.
        [A]: searchThenCite("with"),
        [B]: searchThenCite("without"),
        [C]: [{ text: EMPTY }],
      },
      { registry: literatureRegistry() },
    );

    const item = reviewItem(result.items);
    expect(item?.status).toBe("completed");
    const cited = (item?.result?.annotations ?? []).filter(
      (a) => a.evidence?.kind === "paper",
    );
    // Both seats really did get a concern through; otherwise the assertion
    // below would hold for the wrong reason.
    expect(cited.map((a) => a.reviewer).sort()).toEqual([A, B].sort());

    const brief = requests
      .map((r) =>
        (r.messages ?? [])
          .filter((m) => m.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join(""),
      )
      .find((t) => t.includes(VERIFIER_MARKER));
    expect(brief, "the verifier was never briefed").toBeDefined();
    const line = (brief as string)
      .split(String.fromCharCode(10))
      .find((l) => l.startsWith('{"concerns":')) as string;
    const rows = (
      JSON.parse(line) as {
        concerns: Array<{ id: string; evidence?: unknown }>;
      }
    ).concerns;

    const withAbstract = rows.filter((r) =>
      JSON.stringify(r.evidence ?? {}).includes(ABSTRACT),
    );
    // Exactly one row carries it, and it is A's.
    expect(withAbstract).toHaveLength(1);
    expect(withAbstract[0]?.id.startsWith(A)).toBe(true);
    // B's row names the same paper and carries no abstract at all.
    const bRow = rows.find((r) => r.id.startsWith(B));
    expect(JSON.stringify(bRow?.evidence ?? {})).toContain(TITLE);
    expect(JSON.stringify(bRow?.evidence ?? {})).not.toContain("abstract");
  });

  it("the CORRECTION round is handed the same abstracts as the first answer", async () => {
    // V2's gate review, ADR 0079 §2, found while widening the no-abstract
    // test to the upheld direction.
    //
    // `runVerification` reads its child's answer at TWO call sites: the
    // `finalAnswerCheck` that decides whether to re-ask, and the read of the
    // settled report afterwards. Only the first passed `abstractsHanded`. So a
    // seat that answered once was judged against the abstracts it was given,
    // and the same seat *after a re-ask* was judged as though it had been
    // given none — downgrading exactly the concerns the abstract exists to
    // make answerable.
    //
    // It was survivable while only `refuted` was guarded, because a refutation
    // that survives a re-ask is rare. §2 makes the test reach every `upheld`,
    // which is what all 23 concerns of the round's own S2 panel were — so the
    // latent defect becomes the common path, and this is what pins it shut.
    const answered: string[] = [];
    const { result } = await runPanel(
      {
        [A]: searchThenCite("with"),
        [B]: [{ text: EMPTY }],
        [C]: [{ text: EMPTY }],
      },
      { registry: literatureRegistry() },
      (brief, feedback) => {
        answered.push(feedback === undefined ? "first" : "correction");
        // The first answer does not parse, so the one re-ask fires; the
        // correction upholds the literature concern, which is only
        // recordable as `upheld` if the abstracts reached this read too.
        if (feedback === undefined) return { text: "I could not do this." };
        return {
          text: JSON.stringify({
            verifications: idsIn(brief).map((id) => ({
              id,
              kind: "literature",
              outcome: "upheld",
            })),
          }),
        };
      },
    );

    // The re-ask really happened; otherwise this passes on the first path.
    expect(answered).toEqual(["first", "correction"]);
    const item = reviewItem(result.items);
    const paper = (item?.result?.annotations ?? []).find(
      (a) => a.evidence?.kind === "paper",
    );
    expect(paper, "the citing seat's concern never landed").toBeDefined();
    expect(paper?.verification).toEqual({
      outcome: "upheld",
      kind: "literature",
    });
  });
});
