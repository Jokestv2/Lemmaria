import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  GenerateRequest,
  ModelAdapter,
  ModelBinding,
  ReviewItem,
  ReviewLimit,
  SessionEvent,
  SessionItem,
  Skill,
  ToolName,
} from "../../src/contracts/index.js";
import { ok, toolFail } from "../../src/contracts/index.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import {
  ScriptedModelAdapter,
  scriptedByKey,
} from "../../src/model/scripted.js";
import type { ScriptedTurn } from "../../src/model/scripted.js";
import type { BudgetUsed } from "../../src/session/budget.js";
import { buildConversationHistory } from "../../src/session/compaction.js";
import {
  DEFAULT_REVIEWER_COUNT,
  PANEL_SEAT_TOKEN_FLOOR,
  PANEL_SKILL,
  PREFLIGHT_MAX_TOKENS,
  PREFLIGHT_PROMPT,
  REVIEWER_NAMES,
  runReviewPanel,
} from "../../src/session/review-panel.js";
import {
  VERIFIER_BRIEF_MARKER,
  VERIFIER_SKILL,
} from "../../src/session/review-verifier.js";
import { runSessionTask } from "../../src/session/run.js";
import type { RunSessionTaskOptions } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";

/**
 * R3 (ADR 0061): the review panel's DRIVER, against scripted seats.
 *
 * Everything here is asserted from the outside — the persisted transcript, the
 * requests each seat's model actually received, and the honesty record the
 * driver wrote. The seats are keyed by their goal text (`scriptedByKey`), which
 * is also what makes the blindness assertion possible: a seat's whole request
 * list is addressable on its own.
 */

/** The three reviewers a default panel runs, by their ORDINAL names (R9). */
const [A, B, C] = REVIEWER_NAMES as unknown as [string, string, string];

const temps: string[] = [];
async function mkStore(): Promise<SessionStore> {
  const d = await mkdtemp(join(tmpdir(), "lemmaria-review-panel-"));
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

/** A hard-wrapped fixture: each line is one whole quotable anchor.
 *
 *  V2: the `\title` shares line 1 with `\documentclass` on purpose. A real
 *  manuscript has a title and the withholding guard needs one, but this
 *  fixture's LINE NUMBERS are pinned by the assertions below (`main.tex:4`),
 *  so the title had to arrive without shifting a single one. */
const MAIN = [
  "\\documentclass{article}\\title{A Two-Stage Least Squares Study}",
  "\\begin{document}",
  "We estimate the effect with a two-stage least squares design.",
  "The instrument is the distance to the nearest treated unit.",
  "Table 2 reports a gain of nine points over the strongest baseline.",
  "We conclude that the method generalises to every domain we tried.",
  "\\end{document}",
  "",
].join("\n");

const METHOD = ["The estimator is defined in Appendix A.", ""].join("\n");

const skill = (name: string): Skill => ({
  name,
  description: `${name} description`,
  body: `body of ${name}`,
  source: "bundled",
  path: `/skills/${name}/SKILL.md`,
  references: [],
});

function workspace(files: Record<string, string> = {}) {
  const tree: Record<string, string> = {
    "main.tex": MAIN,
    "sections/method.tex": METHOD,
    ...files,
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

/**
 * The include-graph reader a scripted panel gets by default (X5, ADR 0074 §4).
 *
 * Every real host wires one, so a driver test that wired none would be
 * measuring the FALLBACK — and would carry a `review.manuscript_unresolved`
 * notice no production panel raises. It returns the fake workspace's own
 * manuscript-suffixed files, entry first, which is what a resolved graph over
 * this tree would say.
 *
 * The tests that are ABOUT the fallback pass `manuscriptGraph: undefined`
 * explicitly, so the absence is visible where it is the subject.
 */
function graphReader(files: Record<string, string> = {}) {
  const tree = ["main.tex", "sections/method.tex", ...Object.keys(files)];
  return async (entry: string) => ({
    files: [
      entry,
      ...tree.filter((f) => f !== entry && /\.(tex|md|bib)$/.test(f)),
    ],
    missing: [] as string[],
  });
}

/** A minimal read registry, so the task has a non-empty tool surface. */
function readRegistry(
  extra?: (r: Map<ToolName, ToolExecutor>) => void,
): Map<ToolName, ToolExecutor> {
  const r = new Map<ToolName, ToolExecutor>();
  r.set("read_span", {
    name: "read_span",
    category: "retrieval",
    spec: {
      name: "read_span",
      description: "read",
      parameters: { type: "object" },
    },
    invoke: async () => ok({ content: MAIN }),
  });
  extra?.(r);
  return r;
}

/** A well-formed ledger for one anchor of `main.tex`. */
const ledger = (anchor: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    impressions: {},
    annotations: [
      {
        dimension: "soundness",
        severity: "major",
        anchor,
        evidence: "missing",
        message: "this does not follow from what is shown",
        ...over,
      },
    ],
  });

const EMPTY_LEDGER = JSON.stringify({ annotations: [], impressions: {} });

/** One located concern, and a synthesis citing it — for the deps-level test
 *  below, which drives `runReviewPanel` directly rather than through a model. */
const SEAT_TEXT = ledger(
  "We estimate the effect with a two-stage least squares design.",
);
const SYNTH_TEXT = JSON.stringify({
  consensus: [{ ids: [`${A}-1`], note: "one reviewer, one concern" }],
  disagreements: [],
});

/**
 * Key the scripts by seat NAME rather than by the whole brief.
 *
 * The FIRST user message, not the last: a seat's goal is stable across its
 * turns, while the last one becomes the shape feedback the moment the in-loop
 * retry fires — which would silently switch a seat's script mid-run.
 */
function seatKey(req: GenerateRequest): string {
  const firstUser = req.messages.find((m) => m.role === "user");
  const text = typeof firstUser?.content === "string" ? firstUser.content : "";
  // X5 (ADR 0074 §6): the pre-run check, which precedes every seat and belongs
  // to no reviewer. Keyed by name so a test can script it FAILING; left
  // unscripted it falls through to `scriptedByKey`'s "unscripted" turn, which
  // resolves — and a resolving call is exactly what the check reads as `ok`.
  if (text === PREFLIGHT_PROMPT) return "preflight";
  for (const name of REVIEWER_NAMES) {
    if (text.includes(`\`${name}\`, one of `)) return name;
  }
  // V1 (ADR 0076 §5): the verifier, keyed by its brief's marker sentence.
  if (text.includes(VERIFIER_BRIEF_MARKER)) {
    return "verifier";
  }
  return text.includes("reviewers have each read") ? "synthesis" : text;
}

/**
 * V1: the verifier's default answer — UPHOLD every id its brief hands it,
 * built from the request because the ids differ per test. With it, every
 * assertion below about limits, annotations, the cross-review and blindness
 * stands as it was; what V1 changes is a COUNT of model calls.
 */
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

/**
 * A model whose script is chosen by SEAT, not by the whole goal text — the
 * goals carry the manuscript's file list, so keying on them verbatim would
 * make every test restate a brief.
 */
function panelModel(scripts: Record<string, ScriptedTurn[]>) {
  const keyOf = seatKey;
  const inner = scriptedByKey(scripts);
  const requests: GenerateRequest[] = [];
  return {
    requests,
    adapter: {
      protocol: "anthropic" as const,
      generate: (req: GenerateRequest) => {
        requests.push(req);
        if (keyOf(req) === "verifier" && scripts.verifier === undefined) {
          return upholdEvery(req).generate(req);
        }
        return inner.generate({
          ...req,
          messages: [{ role: "user" as const, content: keyOf(req) }],
        });
      },
      async *generateStream(req: GenerateRequest) {
        requests.push(req);
        if (keyOf(req) === "verifier" && scripts.verifier === undefined) {
          yield* upholdEvery(req).generateStream(req);
          return;
        }
        const stream = inner.generateStream as (
          r: GenerateRequest,
        ) => AsyncIterable<unknown>;
        yield* stream({
          ...req,
          messages: [
            ...req.messages.filter((m) => m.role === "system"),
            { role: "user" as const, content: keyOf(req) },
          ],
        }) as AsyncIterable<never>;
      },
    },
  };
}

/**
 * The parent binding the pre-run check asks (X5, ADR 0074 §6).
 *
 * The two tests below drive `runReviewPanel` directly, so they own the whole
 * deps literal and must supply it. Any adapter that RESOLVES will do — the
 * check reads the call returning, never its text — and the usage is pinned to
 * zero on purpose: both tests assert exact carve arithmetic, and a check that
 * spent real tokens would shift the seats' ceilings out from under them.
 */
const stubParent = (): ChildModel => ({
  adapter: new ScriptedModelAdapter([
    { text: "ready", usage: { inputTokens: 0, outputTokens: 0 } },
  ]),
  binding,
});

async function runPanel(
  scripts: Record<string, ScriptedTurn[]>,
  over: Partial<RunSessionTaskOptions> = {},
  text = "/review",
) {
  const store = await mkStore();
  const session = await store.create({ title: "p", workspace: "/ws" });
  const model = panelModel(scripts);
  const events: SessionEvent[] = [];
  const result = await runSessionTask({
    store,
    session,
    model: model.adapter,
    binding,
    text,
    registry: readRegistry(),
    // V1: the verifier's protocol is offered too, so the default panel
    // verifies — as every host's does.
    skills: [skill(PANEL_SKILL), skill(VERIFIER_SKILL), skill("related-work")],
    workspace: workspace(),
    paperEntry: "main.tex",
    manuscriptGraph: graphReader(),
    // V2 (ADR 0078 §5): every real host wires a withholding holder, so a
    // driver test that wired none would measure the UNGUARDED path and carry
    // an `own_title_unguarded` limit no production panel raises — exactly the
    // reasoning `graphReader` above is defaulted for. The tests that are ABOUT
    // its absence pass `literatureWithhold: undefined` explicitly.
    literatureWithhold: { titles: [] },
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { result, events, requests: model.requests, store, session };
}

const reviewItem = (items: readonly SessionItem[]): ReviewItem | undefined =>
  [...items].reverse().find((i): i is ReviewItem => i.type === "review");

const liveReviews = (events: SessionEvent[]): ReviewItem[] =>
  events
    .filter(
      (e): e is Extract<SessionEvent, { type: "item.updated" }> =>
        e.type === "item.updated" && e.item.type === "review",
    )
    .map((e) => e.item as ReviewItem);

const noticeCodes = (items: readonly SessionItem[]): string[] =>
  items.filter((i) => i.type === "notice").map((i) => i.code);

const limitsOf = (item: ReviewItem | undefined): ReviewLimit[] =>
  item?.result?.limits ?? [];

/** Three seats that each locate one concern, and a valid synthesis. */
const HEALTHY: Record<string, ScriptedTurn[]> = {
  [A]: [
    {
      text: ledger(
        "The instrument is the distance to the nearest treated unit.",
      ),
    },
  ],
  [B]: [
    {
      text: ledger(
        "We conclude that the method generalises to every domain we tried.",
        { dimension: "claims" },
      ),
    },
  ],
  [C]: [
    {
      text: ledger(
        "Table 2 reports a gain of nine points over the strongest baseline.",
        { dimension: "positioning", severity: "minor" },
      ),
    },
  ],
  synthesis: [
    {
      text: JSON.stringify({
        consensus: [
          {
            ids: [`${A}-1`, `${B}-1`],
            note: "both read the central design as under-specified",
          },
        ],
        disagreements: [],
      }),
    },
  ],
};

describe("the /review branch (O2)", () => {
  it("runs a panel instead of a model turn, and ends as the panel does", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    expect(result.status).toBe("completed");
    // Six model calls: the pre-run check, three seats, the verifier (V1) and
    // the synthesis. None of them is a parent turn — the parent never talks to
    // the model at all. The check is ONE call for five children, because they
    // share one binding.
    expect(requests).toHaveLength(6);
    const item = reviewItem(result.items);
    expect(item?.type).toBe("review");
    expect(item?.status).toBe("completed");
    expect(item?.skill).toBe(PANEL_SKILL);
  });

  it("keeps the typed message as the task's user_message", async () => {
    const { result, requests } = await runPanel(
      HEALTHY,
      {},
      "/review the statistics",
    );
    const user = result.items.find((i) => i.type === "user_message");
    expect(user?.text).toBe("/review the statistics");
    expect(reviewItem(result.items)?.focus).toBe("the statistics");
  });

  it("a child's /review is prose, not a panel", async () => {
    const { result, requests } = await runPanel(
      { "/review": [{ text: "I am a child" }] },
      { isChild: true, skills: [skill(PANEL_SKILL)] },
    );
    expect(reviewItem(result.items)).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("prose that merely contains /review runs an ordinary turn", async () => {
    const { result, requests } = await runPanel(
      { "we should /review this": [{ text: "sure" }] },
      {},
      "we should /review this",
    );
    expect(reviewItem(result.items)).toBeUndefined();
    expect(
      result.items.some((i) => i.type === "agent_message" && i.text === "sure"),
    ).toBe(true);
  });
});

describe("preconditions (O3)", () => {
  it("refuses without the protocol skill, and says which one", async () => {
    const { result, requests } = await runPanel(HEALTHY, {
      skills: [skill("related-work")],
    });
    expect(noticeCodes(result.items)).toContain("review.skill_missing");
    expect(reviewItem(result.items)?.status).toBe("failed");
    expect(reviewItem(result.items)?.result).toBeUndefined();
    // No seat rows: a refusal fires BEFORE any seat exists, and rows saying
    // `running` under a failed panel would show reviewers still working.
    // Replay cannot correct it either — it normalizes a RUNNING panel.
    expect(reviewItem(result.items)?.seats).toEqual([]);
  });

  it("refuses with no workspace port at all", async () => {
    const { result, requests } = await runPanel(HEALTHY, {
      workspace: undefined,
    });
    expect(noticeCodes(result.items)).toContain("review.no_manuscript");
    expect(reviewItem(result.items)?.status).toBe("failed");
  });

  it("refuses when no entry is given and none can be discovered", async () => {
    const { result, requests } = await runPanel(HEALTHY, {
      paperEntry: undefined,
      workspace: {
        root: "/ws",
        readFile: async () => {
          throw new Error("empty folder");
        },
        listFiles: async () => [],
      },
    });
    expect(noticeCodes(result.items)).toContain("review.no_manuscript");
  });

  it("discovers the entry itself when the host names none", async () => {
    const { result, requests } = await runPanel(HEALTHY, {
      paperEntry: undefined,
    });
    expect(noticeCodes(result.items)).not.toContain("review.no_manuscript");
    expect(reviewItem(result.items)?.status).toBe("completed");
  });

  it("warns below the seat floor and STILL runs the panel", async () => {
    // The budget is the user's dial (invariant 5). Refusing here would
    // substitute the driver's arithmetic for their choice; the honest outcome
    // of a starved seat is a seat_missing limit, which is a fact they can act on.
    const { result, requests } = await runPanel(HEALTHY, {
      ceilings: { maxOutputTokens: PANEL_SEAT_TOKEN_FLOOR },
    });
    const notice = result.items.find(
      (i) => i.type === "notice" && i.code === "review.seat_budget",
    );
    expect(notice).toBeDefined();
    expect((notice as { n?: number }).n).toBeLessThan(PANEL_SEAT_TOKEN_FLOOR);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(reviewItem(result.items)?.status).toBe("completed");
  });

  it("no notice when the carve clears the floor", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    expect(noticeCodes(result.items)).not.toContain("review.seat_budget");
  });

  it("bounds the synthesis floor's overrun to PANEL_SEAT_TOKEN_FLOOR", async () => {
    // The one invariant-5 exception, ASSERTED rather than only described: the
    // three seats each get a carve and never exceed it, and the fourth child
    // asks for at most `max(FLOOR, remaining)`. So a panel exceeds the task
    // ceiling by at most FLOOR, once. Pinned because the bound lived only in
    // prose, and the prose stated it wrongly twice.
    const ceilings: Array<{ tools: number; maxOutputTokens?: number }> = [];
    const CEILING = PANEL_SEAT_TOKEN_FLOOR * 3;
    let used: BudgetUsed = { turns: 0, toolCalls: 0, outputTokens: 0 };
    await runReviewPanel({
      emit: async () => {},
      emitItem: async () => {},
      emitNotice: async () => {},
      runChild: async (_goal, allowedTools, ceiling) => {
        ceilings.push({
          tools: allowedTools.length,
          ...(ceiling.maxOutputTokens !== undefined
            ? { maxOutputTokens: ceiling.maxOutputTokens }
            : {}),
        });
        // Each seat spends its WHOLE carve — the case the floor exists for.
        const spent = ceiling.maxOutputTokens ?? 0;
        return {
          status: "completed" as const,
          items: [
            {
              id: `m${ceilings.length}`,
              type: "agent_message" as const,
              text: allowedTools.length === 0 ? SYNTH_TEXT : SEAT_TEXT,
            },
          ],
          usage: { inputTokens: 0, outputTokens: spent },
        };
      },
      parentAllowed: ["read_span", "get_outline", "list_files"],
      // V1: the verifier's protocol is offered, so the panel's fifth child
      // runs and its carve is part of the bound.
      offeredSkills: [skill(PANEL_SKILL), skill(VERIFIER_SKILL)],
      budget: { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: CEILING },
      usedSoFar: () => used,
      accrue: (u) => {
        used = { ...used, outputTokens: used.outputTokens + u.outputTokens };
      },
      fanOutConcurrency: 3,
      parentModel: binding.model,
      parent: stubParent(),
      workspace: workspace(),
      paperEntry: "main.tex",
    });

    // Three reviewers, the verifier (V1), then the tool-less synthesis. The
    // pre-run check is not among them: it asks the model directly and carves
    // nothing.
    expect(ceilings).toHaveLength(5);
    const seats = ceilings.slice(0, 3);
    const verifier = ceilings[3];
    const synthesis = ceilings[4];
    for (const seat of seats) {
      expect(seat.maxOutputTokens).toBe(
        Math.floor(CEILING / DEFAULT_REVIEWER_COUNT),
      );
    }
    // V1 (ADR 0076 §5): the verifier is carved carve(2) of what the seats
    // left — nothing — with NO floor. It is a read-only child, not tool-less.
    expect(verifier?.tools).toBeGreaterThan(0);
    expect(verifier?.maxOutputTokens).toBe(0);
    expect(synthesis?.tools).toBe(0);
    // The seats left ~nothing, so the floor is what the synthesis got — and
    // the floor IS the whole overrun, still once per panel.
    expect(synthesis?.maxOutputTokens).toBe(PANEL_SEAT_TOKEN_FLOOR);
    const total =
      seats.reduce((n, c) => n + (c.maxOutputTokens ?? 0), 0) +
      (verifier?.maxOutputTokens ?? 0) +
      (synthesis?.maxOutputTokens ?? 0);
    expect(total - CEILING).toBeLessThanOrEqual(PANEL_SEAT_TOKEN_FLOOR);
  });

  it("V1 O9: bounds the overrun once when the verifier's carve is NOT zero", async () => {
    // The case above starves the verifier, so its carve adds nothing to the
    // sum. Here the seats spend half their carve and leave room: the verifier
    // is carved carve(2) of a real remainder and spends all of it, and the
    // synthesis still asks for at most max(FLOOR, what is left). What the
    // panel SPENDS may pass the ceiling by at most the floor, once.
    const ceilings: Array<{ tools: number; maxOutputTokens?: number }> = [];
    const CEILING = PANEL_SEAT_TOKEN_FLOOR * 3;
    let used: BudgetUsed = { turns: 0, toolCalls: 0, outputTokens: 0 };
    await runReviewPanel({
      emit: async () => {},
      emitItem: async () => {},
      emitNotice: async () => {},
      runChild: async (_goal, allowedTools, ceiling) => {
        ceilings.push({
          tools: allowedTools.length,
          ...(ceiling.maxOutputTokens !== undefined
            ? { maxOutputTokens: ceiling.maxOutputTokens }
            : {}),
        });
        const carved = ceiling.maxOutputTokens ?? 0;
        // The three seats come first; each spends half of what it was given.
        const spent =
          ceilings.length <= DEFAULT_REVIEWER_COUNT
            ? Math.floor(carved / 2)
            : carved;
        return {
          status: "completed" as const,
          items: [
            {
              id: `m${ceilings.length}`,
              type: "agent_message" as const,
              text: allowedTools.length === 0 ? SYNTH_TEXT : SEAT_TEXT,
            },
          ],
          usage: { inputTokens: 0, outputTokens: spent },
        };
      },
      parentAllowed: ["read_span", "get_outline", "list_files"],
      offeredSkills: [skill(PANEL_SKILL), skill(VERIFIER_SKILL)],
      budget: { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: CEILING },
      usedSoFar: () => used,
      accrue: (u) => {
        used = { ...used, outputTokens: used.outputTokens + u.outputTokens };
      },
      fanOutConcurrency: 3,
      parentModel: binding.model,
      parent: stubParent(),
      workspace: workspace(),
      paperEntry: "main.tex",
    });

    expect(ceilings).toHaveLength(5);
    const verifier = ceilings[3];
    const synthesis = ceilings[4];
    const seatCarve = Math.floor(CEILING / DEFAULT_REVIEWER_COUNT);
    const left = CEILING - DEFAULT_REVIEWER_COUNT * Math.floor(seatCarve / 2);
    // One chunk, so carve(1 + 1): half of what the seats left, and not zero.
    expect(verifier?.maxOutputTokens).toBe(Math.floor(left / 2));
    expect(verifier?.maxOutputTokens ?? 0).toBeGreaterThan(0);
    expect(synthesis?.maxOutputTokens).toBe(
      Math.max(PANEL_SEAT_TOKEN_FLOOR, left - (verifier?.maxOutputTokens ?? 0)),
    );
    expect(used.outputTokens - CEILING).toBeLessThanOrEqual(
      PANEL_SEAT_TOKEN_FLOOR,
    );
  });
});

describe("seat construction (O6)", () => {
  it("every reviewer's first request already carries the protocol body", async () => {
    // The forced /skill: load (ADR 0059, ADR 0061 §4): the child's own
    // head-of-task parse turns the goal's prefix into a real load exchange,
    // so the protocol is in context BEFORE the reviewer's first turn.
    const { requests } = await runPanel(HEALTHY);
    const seatRequests = requests.filter((r) =>
      REVIEWER_NAMES.some((n) =>
        JSON.stringify(r.messages).includes(`\`${n}\`, one of `),
      ),
    );
    expect(seatRequests).toHaveLength(3);
    for (const req of seatRequests) {
      expect(JSON.stringify(req.messages)).toContain(`body of ${PANEL_SKILL}`);
    }
  });

  it("a reviewer's brief names it, the panel's size, the entry and the focus", async () => {
    const { requests } = await runPanel(HEALTHY, {}, "/review check §4");
    const all = JSON.stringify(requests.map((r) => r.messages));
    for (const name of [A, B, C]) {
      expect(all).toContain(`\`${name}\`, one of 3 independent reviewers`);
    }
    expect(all).toContain("main.tex");
    expect(all).toContain("sections/method.tex");
    expect(all).toContain("check §4");
    // R2's live finding, in the product: this fixture is hard-wrapped.
    expect(all).toContain("ONE WHOLE LINE");
  });

  it("a reviewer is offered exactly the read-only set, plus its own load tool", async () => {
    const { requests } = await runPanel(HEALTHY);
    const seat = requests.find((r) =>
      JSON.stringify(r.messages).includes(`\`${A}\`, one of `),
    );
    const names = (seat?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["load_skill", "read_span"]);
    // Never the parent's own loop tools: a reviewer cannot fan out further,
    // and a review never writes (invariant 3).
    expect(names).not.toContain("spawn_subtask");
    expect(names).not.toContain("propose_edit");
    expect(names).not.toContain("update_plan");
  });

  it("the synthesis seat gets NO tools at all", async () => {
    const { requests } = await runPanel(HEALTHY);
    const synth = requests.find((r) =>
      JSON.stringify(r.messages).includes("reviewers have each read"),
    );
    expect(synth).toBeDefined();
    expect(synth?.tools ?? []).toEqual([]);
  });
});

describe("blindness (O7)", () => {
  it("no reviewer's request carries another's text or the parent's history", async () => {
    // R3 asserted this against the OTHER SEATS' LENSES too; under one
    // whole-review lens every brief carries the same lens by design (O2), so
    // the discriminator is the reviewer's own name — which is also the only
    // thing that differs between two briefs, and therefore the only thing a
    // leak could carry.
    const { requests } = await runPanel(HEALTHY, {}, "/review check §4");
    for (const name of [A, B, C]) {
      const mine = requests.filter((r) =>
        JSON.stringify(r.messages).includes(`\`${name}\`, one of `),
      );
      expect(mine.length).toBeGreaterThan(0);
      for (const req of mine) {
        const text = JSON.stringify(req.messages);
        for (const other of [A, B, C]) {
          if (other === name) continue;
          expect(text).not.toContain(`\`${other}\``);
          expect(text).not.toContain(`${other}-1`);
        }
        // The parent's own message never reaches a reviewer either: it sees
        // its goal, its protocol, and nothing about how it was asked for.
        expect(text).not.toContain("/review check §4");
      }
    }
  });

  it("the synthesis sees located concerns by id, never a reviewer's raw ledger", async () => {
    const { requests } = await runPanel(HEALTHY);
    const synth = requests.find((r) =>
      JSON.stringify(r.messages).includes("reviewers have each read"),
    );
    const text = JSON.stringify(synth?.messages ?? []);
    expect(text).toContain(`${A}-1`);
    expect(text).toContain(`${B}-1`);
    // The wire ledger's own keys never appear: the synthesis reads the
    // harness's located rows, not what a seat wrote.
    expect(text).not.toContain('anchor\\"');
    expect(text).not.toContain("evidence");
  });
});

describe("seat parse (O9)", () => {
  it("a seat that produced no report is missing, naming its budget stop", async () => {
    // Two silent turns: the first spends the in-loop retry, the second
    // completes having written nothing at all.
    const { result, requests } = await runPanel({
      ...HEALTHY,
      [A]: [{ text: "" }, { text: "" }],
    });
    const missing = limitsOf(reviewItem(result.items)).find(
      (l) => l.kind === "seat_missing" && l.reviewer === A,
    );
    expect(missing).toBeDefined();
    expect(missing).toMatchObject({ reason: "unparsed" });
  });

  it("an unparseable ledger is missing, carrying the interpreter's own words", async () => {
    const { result, requests } = await runPanel({
      ...HEALTHY,
      // Two failing answers: the first spends the one in-loop retry.
      [B]: [{ text: "here are my thoughts" }, { text: "still prose" }],
    });
    const missing = limitsOf(reviewItem(result.items)).find(
      (l) => l.kind === "seat_missing" && l.reviewer === B,
    );
    expect(missing).toMatchObject({ reason: "unparsed" });
    expect((missing as { detail?: string }).detail).toContain("pure JSON");
  });

  it("the shape retry is real: a fixed second answer parses and counts", async () => {
    const { result, requests } = await runPanel({
      ...HEALTHY,
      [B]: [
        { text: "here are my thoughts" },
        {
          text: ledger(
            "We conclude that the method generalises to every domain we tried.",
            { dimension: "claims" },
          ),
        },
      ],
    });
    const item = reviewItem(result.items);
    expect(item?.result?.annotations.map((a) => a.id)).toContain(`${B}-1`);
    expect(item?.seats.find((s) => s.reviewer === B)?.retried).toBe(true);
    expect(item?.seats.find((s) => s.reviewer === A)?.retried).toBe(undefined);
  });

  it("an empty ledger is a valid report, not a missing seat", async () => {
    // No quota: a seat that found nothing under its lens says so.
    const { result, requests } = await runPanel({
      ...HEALTHY,
      [C]: [{ text: EMPTY_LEDGER }],
    });
    const item = reviewItem(result.items);
    expect(
      limitsOf(item).some((l) => l.kind === "seat_missing" && l.reviewer === C),
    ).toBe(false);
    expect(item?.result?.annotations.some((a) => a.reviewer === C)).toBe(false);
  });
});

describe("driver-observed limits (O11, O12)", () => {
  it("is silent about guidance when the forced load worked", async () => {
    // `seat_unguided` is an ASSERTION that the forced load happened, not a
    // condition the driver expects to meet — so the healthy panel's record
    // must not mention it.
    const { result, requests } = await runPanel(HEALTHY);
    expect(
      limitsOf(reviewItem(result.items)).some(
        (l) => l.kind === "seat_unguided",
      ),
    ).toBe(false);
  });

  it("records seat_unguided for every seat whose protocol load failed", async () => {
    // A skill whose body cannot be served: the exchange still happens, and it
    // still fails, which is exactly the state this limit exists to make
    // visible — three seats that reviewed a paper without the protocol.
    const broken = { ...skill(PANEL_SKILL) } as unknown as Skill;
    (broken as { references?: string[] }).references = undefined;
    const { result, requests } = await runPanel(HEALTHY, { skills: [broken] });
    const unguided = limitsOf(reviewItem(result.items)).filter(
      (l) => l.kind === "seat_unguided",
    );
    expect(unguided.map((l) => (l as { reviewer: string }).reviewer)).toEqual([
      A,
      B,
      C,
    ]);
  });

  it("records one source_unavailable per (source, status) a seat saw", async () => {
    const registry = readRegistry((r) => {
      r.set("literature_search", {
        name: "literature_search",
        category: "retrieval",
        spec: {
          name: "literature_search",
          description: "search",
          parameters: { type: "object" },
        },
        invoke: async () =>
          ok({
            results: [],
            sources: [
              { name: "arxiv", endpoint: "x", status: "rate_limited" },
              { name: "crossref", endpoint: "y", status: "ok" },
              { name: "dblp", endpoint: "z", status: "timeout" },
            ],
          }),
      });
    });
    const { result, requests } = await runPanel(
      {
        ...HEALTHY,
        [C]: [
          {
            toolCalls: [
              { id: "l1", name: "literature_search", args: { query: "a" } },
            ],
          },
          // A second identical call, to prove the (source, status) dedupe.
          {
            toolCalls: [
              { id: "l2", name: "literature_search", args: { query: "b" } },
            ],
          },
          {
            text: ledger(
              "Table 2 reports a gain of nine points over the strongest baseline.",
              { dimension: "positioning" },
            ),
          },
        ],
      },
      { registry },
    );
    const unavailable = limitsOf(reviewItem(result.items)).filter(
      (l) => l.kind === "source_unavailable",
    );
    expect(unavailable).toEqual([
      {
        kind: "source_unavailable",
        reviewer: C,
        source: "arxiv",
        status: "rate_limited",
      },
      {
        kind: "source_unavailable",
        reviewer: C,
        source: "dblp",
        status: "timeout",
      },
    ]);
  });

  it("carries anonymous through to source_unavailable, and only when the report said so (R4)", async () => {
    const registry = readRegistry((r) => {
      r.set("literature_search", {
        name: "literature_search",
        category: "retrieval",
        spec: {
          name: "literature_search",
          description: "search",
          parameters: { type: "object" },
        },
        invoke: async () =>
          ok({
            sources: [
              {
                name: "semantic_scholar",
                endpoint: "s",
                status: "rate_limited",
                anonymous: true,
              },
              { name: "dblp", endpoint: "z", status: "timeout" },
            ],
            results: [],
          }),
      });
    });
    const { result, requests } = await runPanel(
      {
        ...HEALTHY,
        [C]: [
          {
            toolCalls: [
              { id: "l1", name: "literature_search", args: { query: "a" } },
            ],
          },
          {
            text: ledger(
              "Table 2 reports a gain of nine points over the strongest baseline.",
              { dimension: "positioning" },
            ),
          },
        ],
      },
      { registry },
    );
    expect(
      limitsOf(reviewItem(result.items)).filter(
        (l) => l.kind === "source_unavailable",
      ),
    ).toEqual([
      {
        kind: "source_unavailable",
        reviewer: C,
        source: "semantic_scholar",
        status: "rate_limited",
        anonymous: true,
      },
      {
        kind: "source_unavailable",
        reviewer: C,
        source: "dblp",
        status: "timeout",
      },
    ]);
  });

  it("records search_budget_spent on the tool's own exhaustion code", async () => {
    const registry = readRegistry((r) => {
      r.set("literature_search", {
        name: "literature_search",
        category: "retrieval",
        spec: {
          name: "literature_search",
          description: "search",
          parameters: { type: "object" },
        },
        invoke: async () =>
          toolFail("too_large", "literature search budget exhausted"),
      });
    });
    const { result, requests } = await runPanel(
      {
        ...HEALTHY,
        [C]: [
          {
            toolCalls: [
              { id: "l1", name: "literature_search", args: { query: "a" } },
            ],
          },
          {
            text: ledger(
              "Table 2 reports a gain of nine points over the strongest baseline.",
              { dimension: "positioning" },
            ),
          },
        ],
      },
      { registry },
    );
    expect(limitsOf(reviewItem(result.items))).toContainEqual({
      kind: "search_budget_spent",
      reviewer: C,
    });
  });
});

describe("the synthesis (O13, O14)", () => {
  it("is requested last, after every seat's last request", async () => {
    // "After every report is frozen" is structural — the fan-out core resolves
    // only when its concurrency map has drained — and this is what pins it.
    const { requests } = await runPanel(HEALTHY);
    const last = requests[requests.length - 1];
    expect(JSON.stringify(last?.messages)).toContain(
      "reviewers have each read",
    );
    const synthAt = requests.findIndex((r) =>
      JSON.stringify(r.messages).includes("reviewers have each read"),
    );
    for (const name of [A, B, C]) {
      const lastSeatAt = requests.reduce(
        (acc, r, i) =>
          JSON.stringify(r.messages).includes(`\`${name}\`, one of `) ? i : acc,
        -1,
      );
      expect(lastSeatAt).toBeGreaterThanOrEqual(0);
      expect(lastSeatAt).toBeLessThan(synthAt);
    }
  });

  it("a valid synthesis lands on the result", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    const item = reviewItem(result.items);
    expect(item?.synthesis).toBe("completed");
    expect(item?.result?.synthesis?.consensus).toEqual([
      {
        ids: [`${A}-1`, `${B}-1`],
        note: "both read the central design as under-specified",
      },
    ]);
    expect(limitsOf(item).some((l) => l.kind === "synthesis_missing")).toBe(
      false,
    );
  });

  it("does not run at all with fewer than two parsed seats", async () => {
    const { result, requests } = await runPanel({
      ...HEALTHY,
      [B]: [{ text: "prose" }, { text: "prose" }],
      [C]: [{ text: "prose" }, { text: "prose" }],
    });
    expect(JSON.stringify(requests.map((r) => r.messages))).not.toContain(
      "reviewers have each read",
    );
    expect(limitsOf(reviewItem(result.items))).toContainEqual({
      kind: "synthesis_missing",
      reason: "insufficient_seats",
    });
    expect(reviewItem(result.items)?.synthesis).toBe("missing");
  });

  it("does not run when every seat parsed but located nothing", async () => {
    const { result, requests } = await runPanel({
      ...HEALTHY,
      [A]: [{ text: EMPTY_LEDGER }],
      [B]: [{ text: EMPTY_LEDGER }],
      [C]: [{ text: EMPTY_LEDGER }],
    });
    expect(JSON.stringify(requests.map((r) => r.messages))).not.toContain(
      "reviewers have each read",
    );
    expect(limitsOf(reviewItem(result.items))).toContainEqual({
      kind: "synthesis_missing",
      reason: "insufficient_seats",
    });
  });

  it("an unparseable synthesis is recorded, with the interpreter's words", async () => {
    const { result, requests } = await runPanel({
      ...HEALTHY,
      synthesis: [{ text: "here is what I think" }, { text: "still prose" }],
    });
    const missing = limitsOf(reviewItem(result.items)).find(
      (l) => l.kind === "synthesis_missing",
    );
    expect(missing).toMatchObject({ reason: "unparsed" });
    expect((missing as { detail?: string }).detail).toContain("pure JSON");
    // The concerns survive: a synthesis that failed loses the synthesis only.
    expect(reviewItem(result.items)?.result?.annotations).toHaveLength(3);
  });

  it("a synthesis with no report at all is recorded as no_report", async () => {
    // Two silent turns: the first spends the in-loop retry, the second
    // completes with nothing to parse at all.
    const { result, requests } = await runPanel({
      ...HEALTHY,
      synthesis: [{ text: "" }, { text: "" }],
    });
    expect(limitsOf(reviewItem(result.items))).toContainEqual({
      kind: "synthesis_missing",
      reason: "no_report",
    });
  });
});

describe("assembly (O15) and the item's lifecycle (O16)", () => {
  it("a clean panel carries no limits key at all", async () => {
    // V4 (ADR 0081 §2): a panel on a host that wired no PDF renderer records
    // `visual_unavailable / no_renderer` — it fell short of the page — so a
    // CLEAN panel is now one that asked for no PDF work at all. `off` is that
    // case, and ADR 0060 D6's claim below still holds for it unchanged. The
    // no-renderer case is `review-panel-pdf.test.ts`'s.
    const { result, requests } = await runPanel(HEALTHY, {
      reviewPanel: { reviewers: [], pdfReviewer: "off" },
    });
    expect(reviewItem(result.items)?.result?.limits).toBeUndefined();
  });

  it("concerns are stamped by seat, in seat order, with dense ids", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    const annotations = reviewItem(result.items)?.result?.annotations ?? [];
    expect(annotations.map((a) => a.id)).toEqual([
      `${A}-1`,
      `${B}-1`,
      `${C}-1`,
    ]);
    expect(annotations[0]?.span).toEqual({ file: "main.tex", line: 4 });
  });

  it("streams running, then one update per settled seat, then the result", async () => {
    const { events, result } = await runPanel(HEALTHY);
    const started = events.filter(
      (e) => e.type === "item.started" && e.item.type === "review",
    );
    expect(started).toHaveLength(1);
    const updates = liveReviews(events);
    // Three seats plus the synthesis-started update.
    expect(updates.length).toBeGreaterThanOrEqual(4);
    expect(updates[updates.length - 1]?.synthesis).toBe("running");
    expect(
      updates.some((u) => u.seats.every((s) => s.status === "completed")),
    ).toBe(true);
    // Only the terminal item is persisted (ADR 0015).
    expect(result.items.filter((i) => i.type === "review")).toHaveLength(1);
  });

  it("an interrupt yields an interrupted panel with no synthesis", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, requests } = await runPanel(HEALTHY, {
      signal: controller.signal,
    });
    const item = reviewItem(result.items);
    expect(result.status).toBe("interrupted");
    expect(item?.status).toBe("interrupted");
    expect(item?.seats.every((s) => s.status === "interrupted")).toBe(true);
    expect(limitsOf(item)).toContainEqual({
      kind: "synthesis_missing",
      reason: "interrupted",
    });
  });

  it("an interrupt DURING the synthesis still yields an interrupted panel", async () => {
    // The seats all settle; the stop arrives while the fourth child runs. The
    // panel must not report `completed` on the strength of the three reports
    // it did get — the step that reads them never finished.
    const controller = new AbortController();
    const { result, requests } = await runPanel(HEALTHY, {
      signal: controller.signal,
      onEvent: (e) => {
        if (
          e.type === "item.updated" &&
          e.item.type === "review" &&
          e.item.synthesis === "running"
        ) {
          controller.abort();
        }
      },
    });
    const item = reviewItem(result.items);
    expect(result.status).toBe("interrupted");
    expect(item?.status).toBe("interrupted");
    // The seats really did finish — this is not the pre-aborted case.
    expect(item?.seats.every((s) => s.status === "completed")).toBe(true);
    expect(item?.synthesis).toBe("missing");
    expect(limitsOf(item)).toContainEqual({
      kind: "synthesis_missing",
      reason: "interrupted",
    });
    // The three located concerns survive: they were frozen before the stop.
    expect(item?.result?.annotations).toHaveLength(3);
  });
});

describe("usage (O19)", () => {
  it("the task's usage is the seats' plus the synthesis's, charged once", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    const item = reviewItem(result.items);
    // SIX requests at the scripted adapter's 10 in / 5 out per turn: the
    // pre-run check, three seats, the verifier (V1) and the synthesis. The
    // check's tokens are as real as any other's (X5, ADR 0074 §6) — a total
    // that left them out would under-report what the run actually cost.
    expect(item?.usage).toEqual({ inputTokens: 60, outputTokens: 30 });
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 30 });
    const seatSum = (item?.seats ?? []).reduce(
      (n, s) => n + (s.usage?.outputTokens ?? 0),
      0,
    );
    expect(seatSum).toBe(15);
    // And the check's share is on the record ITEMISED, not only inside the
    // total — which is what lets the host charge it to the right model
    // instead of falling back to the task's.
    expect(item?.preflight).toHaveLength(1);
    expect(item?.preflight?.[0]?.usage?.outputTokens).toBe(5);
  });
});

/**
 * X5 (ADR 0074 §6): the pre-run check.
 *
 * The round this milestone answers lost two of three seats to a key that was
 * authorised but unfunded — and the author paid for the third. One minimal
 * request per DISTINCT model, before anything is carved, turns that into a
 * refusal that costs almost nothing.
 */
describe("the pre-run check (X5 O12)", () => {
  /** A second binding, so a panel can span two real models. */
  const otherBinding = (model: string): ModelBinding => ({
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com",
    model,
    apiKey: "k2",
  });

  const preflightRequests = (requests: readonly GenerateRequest[]) =>
    requests.filter((r) => {
      const first = r.messages.find((m) => m.role === "user");
      return first?.content === PREFLIGHT_PROMPT;
    });

  it("asks ONE question for a panel whose four children share a binding", async () => {
    const { requests } = await runPanel(HEALTHY);
    const checks = preflightRequests(requests);
    expect(checks).toHaveLength(1);
    // FIRST. A check that ran after a seat would be predicting a spend that
    // had already happened.
    expect(requests[0]).toBe(checks[0]);
    const check = checks[0];
    // The request is as close to nothing as a request can be: no tools to be
    // refused over, no temperature to be rejected. What it tests is the
    // endpoint, the model id, the credential and the account — not any
    // model's tolerance for a parameter.
    expect(check?.tools ?? []).toEqual([]);
    expect(check?.temperature).toBeUndefined();
    expect(check?.maxTokens).toBe(PREFLIGHT_MAX_TOKENS);
    // And it carries no manuscript, no protocol and no seat identity.
    const body = JSON.stringify(check?.messages ?? []);
    expect(body).not.toContain("main.tex");
    expect(body).not.toContain(PANEL_SKILL);
  });

  it("asks TWICE when one seat runs on a model of its own", async () => {
    const second = panelModel(HEALTHY);
    const { requests } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [
          {},
          {
            model: {
              adapter: second.adapter,
              binding: otherBinding("local-8b"),
            },
          },
          {},
        ],
      },
    });
    // One each, on the two adapters — never one for each SEAT. Three seats on
    // one binding is one question, because what the check predicts is the
    // binding, and asking it three times would spend three times over.
    expect(preflightRequests(requests)).toHaveLength(1);
    expect(preflightRequests(second.requests)).toHaveLength(1);
  });

  it("refuses the WHOLE panel on an unfunded key, before a single seat runs", async () => {
    const { result, requests } = await runPanel({
      ...HEALTHY,
      preflight: [
        {
          text: "",
          failure: {
            // Anthropic's own sentence, and its 400 — the exact shape the
            // round lost two seats to.
            message:
              "Your credit balance is too low to access the Anthropic API",
            status: 400,
          },
        },
      ],
    });
    const item = reviewItem(result.items);
    expect(item?.status).toBe("failed");
    expect(item?.seats).toEqual([]);
    expect(item?.preflight?.[0]?.status).toBe("failed");
    expect(item?.preflight?.[0]?.cause?.class).toBe("quota");
    // The provider's own words, kept as authored (invariant 6 rule 2's
    // third-party boundary) — never translated, never rewritten.
    expect(item?.preflight?.[0]?.cause?.message).toContain("credit balance");
    expect(noticeCodes(result.items)).toEqual(["review.model_quota"]);
    // The point of the whole task: nothing but the check was ever asked.
    expect(requests).toHaveLength(1);
    // A refused panel is not a versioned one. The sequence counts panels that
    // RAN (ADR 0062 §1), and a refusal leaves no hole in it.
    expect(item?.version).toBeUndefined();
    expect(item?.result).toBeUndefined();
  });

  it("records WHICH model refused, even when the throw carried no usage", async () => {
    const { result, requests } = await runPanel({
      ...HEALTHY,
      preflight: [
        { text: "", failure: { message: "invalid x-api-key", status: 401 } },
      ],
    });
    const item = reviewItem(result.items);
    // A THROWN check reports no usage — there was no response to read one
    // from — so a one-model refusal costs nothing. The row is still on the
    // record, which is what tells the author which model refused.
    expect(item?.usage).toBeUndefined();
    expect(item?.preflight?.[0]?.usage).toBeUndefined();
    expect(item?.preflight?.[0]?.model).toBe(binding.model);
  });

  it("names the class in the notice: unreachable and refused, not quota", async () => {
    const unreachable = await runPanel({
      ...HEALTHY,
      preflight: [
        { text: "", failure: { message: "upstream unavailable", status: 503 } },
      ],
    });
    expect(noticeCodes(unreachable.result.items)).toEqual([
      "review.model_unreachable",
    ]);
    const refused = await runPanel({
      ...HEALTHY,
      preflight: [
        { text: "", failure: { message: "model not found", status: 404 } },
      ],
    });
    expect(noticeCodes(refused.result.items)).toEqual(["review.model_refused"]);
  });

  it("emits ONE notice per class, not one per model", async () => {
    // Two distinct bindings, both out of credit. The author has one problem,
    // and two identical STOP notices would read as two.
    const second = panelModel({
      ...HEALTHY,
      preflight: [
        {
          text: "",
          failure: { message: "credit balance too low", status: 400 },
        },
      ],
    });
    const { result, requests } = await runPanel(
      {
        ...HEALTHY,
        preflight: [
          {
            text: "",
            failure: { message: "credit balance too low", status: 400 },
          },
        ],
      },
      {
        reviewPanel: {
          reviewers: [
            {},
            {
              model: {
                adapter: second.adapter,
                binding: otherBinding("local-8b"),
              },
            },
            {},
          ],
        },
      },
    );
    expect(noticeCodes(result.items)).toEqual(["review.model_quota"]);
    // The count is the models, so the one sentence still says how many.
    const notice = result.items.find(
      (i) => i.type === "notice" && i.code === "review.model_quota",
    );
    expect((notice as { n?: number }).n).toBe(2);
    expect(reviewItem(result.items)?.preflight).toHaveLength(2);
  });

  it("carves the seats from what the check LEFT, not from the whole budget", async () => {
    // Assumption A16, pinned rather than argued. The check runs before
    // `carve` and accrues as it lands, so `usedSoFar()` must already see its
    // tokens when the seats are divided. If it did not, the seats would be
    // carved from a budget that ignores a spend that already happened — and
    // invariant 5 (a request only ever asks for LESS) would be broken by the
    // one step added to protect the author's money.
    const ceilings: number[] = [];
    const CEILING = 30_000;
    const SPENT = 600;
    let used: BudgetUsed = { turns: 0, toolCalls: 0, outputTokens: 0 };
    await runReviewPanel({
      emit: async () => {},
      emitItem: async () => {},
      emitNotice: async () => {},
      runChild: async (_goal, allowedTools, ceiling) => {
        ceilings.push(ceiling.maxOutputTokens ?? 0);
        return {
          status: "completed" as const,
          items: [
            {
              id: `m${ceilings.length}`,
              type: "agent_message" as const,
              text: allowedTools.length === 0 ? SYNTH_TEXT : SEAT_TEXT,
            },
          ],
        };
      },
      parentAllowed: ["read_span"],
      offeredSkills: [skill(PANEL_SKILL)],
      budget: { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: CEILING },
      usedSoFar: () => used,
      accrue: (u) => {
        used = { ...used, outputTokens: used.outputTokens + u.outputTokens };
      },
      fanOutConcurrency: 3,
      parentModel: binding.model,
      parent: {
        adapter: new ScriptedModelAdapter([
          { text: "ready", usage: { inputTokens: 0, outputTokens: SPENT } },
        ]),
        binding,
      },
      workspace: workspace(),
      paperEntry: "main.tex",
    });
    expect(ceilings[0]).toBe(
      Math.floor((CEILING - SPENT) / DEFAULT_REVIEWER_COUNT),
    );
  });

  it("a check that THROWS on the stop is STILL not a refusal", async () => {
    // The branch the test above cannot reach. `ScriptedModelAdapter` is
    // gentler than a real one: it sees `signal.aborted` and RETURNS an
    // `aborted` result, so the check resolves and never takes the failure
    // path at all. A real SDK throws an AbortError — and a thrown abort is
    // indistinguishable, at the catch, from a provider hanging up. Without
    // the guard this panel reports `failed` and tells the author their model
    // refused, when all that happened is that they pressed stop.
    const controller = new AbortController();
    controller.abort();
    const throwsOnAbort: ModelAdapter = {
      protocol: "anthropic",
      async generate(req) {
        if (req.signal?.aborted) {
          throw Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          });
        }
        return {
          text: "ready",
          toolCalls: [],
          stopReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      async *generateStream(req) {
        yield { type: "completed" as const, result: await this.generate(req) };
      },
    };
    const { result, requests } = await runPanel(HEALTHY, {
      model: throwsOnAbort,
      signal: controller.signal,
    });
    const item = reviewItem(result.items);
    expect(result.status).toBe("interrupted");
    expect(item?.status).toBe("interrupted");
    // The check DID fail — the row says so, honestly — and it still refuses
    // nothing. What the record must not do is name a fault the provider
    // never committed.
    expect(item?.preflight?.[0]?.status).toBe("failed");
    for (const code of [
      "review.model_quota",
      "review.model_unreachable",
      "review.model_refused",
    ]) {
      expect(noticeCodes(result.items)).not.toContain(code);
    }
  });

  it("does not call a STOP a refusal — a stopped panel is interrupted", async () => {
    // The check's request is aborted like any other, and an aborted request
    // fails. Reporting that as "the model refused" would name a fault nobody
    // committed, so a stop discards what the check found.
    const controller = new AbortController();
    controller.abort();
    const { result, requests } = await runPanel(HEALTHY, {
      signal: controller.signal,
    });
    const item = reviewItem(result.items);
    expect(item?.status).toBe("interrupted");
    // And the panel still writes the record R3 has always written for a stop:
    // the seats are there, reporting `interrupted`. An empty `seats` would be
    // a second shape for the same event.
    expect(item?.seats.length).toBeGreaterThan(0);
    expect(item?.seats.every((s) => s.status === "interrupted")).toBe(true);
    expect(noticeCodes(result.items)).not.toContain("review.model_quota");
    expect(noticeCodes(result.items)).not.toContain("review.model_refused");
    expect(noticeCodes(result.items)).not.toContain("review.model_unreachable");
  });
});

describe("the unpriced mark (X5 O13)", () => {
  /** A ledger turn that reports a PRICE alongside its tokens. */
  const priced = (turn: ScriptedTurn): ScriptedTurn => ({
    ...turn,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 },
  });

  it("marks a seat whose tokens came with no price", async () => {
    // The aggregate UI has always been honest about this — `engine/cost.ts`
    // renders "$0.500 (+2 unpriced)" — while the persisted record was not,
    // because `sumUsage` carries a `costUsd` whenever ANY part had one. This
    // is the per-seat fact that makes the total readable as a lower bound.
    const { result, requests } = await runPanel({
      ...HEALTHY,
      [A]: [priced(HEALTHY[A]?.[0] as ScriptedTurn)],
    });
    const item = reviewItem(result.items);
    const seat = (name: string) => item?.seats.find((s) => s.reviewer === name);
    expect(seat(A)?.usage?.costUsd).toBe(0.002);
    expect(seat(A)?.unpriced).toBeUndefined();
    expect(seat(B)?.unpriced).toBe(true);
    expect(seat(C)?.unpriced).toBe(true);
  });

  it("marks the CROSS-REVIEW too — it is a paid child like any other", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    const item = reviewItem(result.items);
    expect(item?.synthesisSeat?.usage).toBeDefined();
    expect(item?.synthesisSeat?.unpriced).toBe(true);
    const { result: withPrice } = await runPanel({
      ...HEALTHY,
      synthesis: [priced(HEALTHY.synthesis?.[0] as ScriptedTurn)],
    });
    expect(
      reviewItem(withPrice.items)?.synthesisSeat?.unpriced,
    ).toBeUndefined();
  });

  it("leaves a seat that spent NOTHING unmarked — unrun is not unpriced", async () => {
    // The token test in the predicate, pinned. A part that reported no usage
    // has nothing missing from the total, and marking it would say the total
    // is a lower bound when it is exact.
    const { result, requests } = await runPanel({
      ...HEALTHY,
      [A]: [
        {
          text: HEALTHY[A]?.[0]?.text ?? "",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ],
    });
    const item = reviewItem(result.items);
    expect(item?.seats.find((s) => s.reviewer === A)?.unpriced).toBeUndefined();
  });
});

/**
 * R9 (ADR 0069): the panel takes its reviewers from the host, each may run on
 * its own model, and the record says which one each ran on.
 */
describe("the panel's reviewers and their models (O4, O5, O6, O7)", () => {
  /** A binding for a second, DIFFERENT model. */
  const other = (model: string): ModelBinding => ({
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com",
    model,
    apiKey: "k2",
  });

  /** A healthy script for `n` reviewers plus the synthesis. Each reviewer
   *  locates one distinct anchor, so `assembleReview` has real work to do. */
  function healthyFor(n: number): Record<string, ScriptedTurn[]> {
    const anchors = [
      "We estimate the effect with a two-stage least squares design.",
      "The instrument is the distance to the nearest treated unit.",
      "Table 2 reports a gain of nine points over the strongest baseline.",
      "We conclude that the method generalises to every domain we tried.",
    ];
    const scripts: Record<string, ScriptedTurn[]> = {};
    for (let i = 0; i < n; i++) {
      const name = REVIEWER_NAMES[i] as string;
      scripts[name] = [{ text: ledger(anchors[i % anchors.length] as string) }];
    }
    scripts.synthesis = [
      {
        text: JSON.stringify({
          consensus:
            n >= 2
              ? [
                  {
                    ids: [`${REVIEWER_NAMES[0]}-1`, `${REVIEWER_NAMES[1]}-1`],
                    note: "both read the design as under-specified",
                  },
                ]
              : [],
          disagreements: [],
        }),
      },
    ];
    return scripts;
  }

  it("sends a bound reviewer's requests to ITS adapter, and nowhere else", async () => {
    // O4 end-to-end: the sixth argument is not plumbing until a different
    // adapter actually sees the traffic. Two recorders, and neither may carry
    // the other's reviewer.
    const second = panelModel(HEALTHY);
    const { requests } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [
          {},
          { model: { adapter: second.adapter, binding: other("local-8b") } },
          {},
        ],
      },
    });
    const carries = (rs: GenerateRequest[], name: string) =>
      rs.some((r) =>
        JSON.stringify(r.messages).includes(`\`${name}\`, one of `),
      );
    // The parent's adapter ran reviewer_a, reviewer_c and the synthesis.
    expect(carries(requests, A)).toBe(true);
    expect(carries(requests, C)).toBe(true);
    expect(carries(requests, B)).toBe(false);
    // The second adapter ran reviewer_b, and ONLY reviewer_b.
    expect(carries(second.requests, B)).toBe(true);
    expect(carries(second.requests, A)).toBe(false);
    expect(carries(second.requests, C)).toBe(false);
  });

  it("runs the cross-review on its own model when the host names one", async () => {
    const second = panelModel(HEALTHY);
    const { requests } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [{}, {}, {}],
        synthesis: {
          adapter: second.adapter,
          binding: other("claude-sonnet-4-5"),
        },
      },
    });
    const synthOn = (rs: GenerateRequest[]) =>
      rs.some((r) =>
        JSON.stringify(r.messages).includes("reviewers have each read"),
      );
    expect(synthOn(second.requests)).toBe(true);
    expect(synthOn(requests)).toBe(false);
  });

  it("stamps every reviewer with the model it ran on", async () => {
    const second = panelModel(HEALTHY);
    const { result, requests } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [
          {},
          { model: { adapter: second.adapter, binding: other("local-8b") } },
          {},
        ],
      },
    });
    const item = reviewItem(result.items);
    expect(item?.seats.map((s) => [s.reviewer, s.model])).toEqual([
      [A, "claude-sonnet-4-5"],
      [B, "local-8b"],
      [C, "claude-sonnet-4-5"],
    ]);
  });

  it("marks ONLY the unverified reviewer, and there is no `below`", async () => {
    // ADR 0023's two verdicts, restated per reviewer because a panel may mix
    // models. `claude-sonnet-4-5` is in the declared floor table; `local-8b`
    // is not. This is never a prediction of failure.
    const second = panelModel(HEALTHY);
    const { result, requests } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [
          {},
          { model: { adapter: second.adapter, binding: other("local-8b") } },
          {},
        ],
      },
    });
    const item = reviewItem(result.items);
    expect(item?.seats.map((s) => s.unverified)).toEqual([
      undefined,
      true,
      undefined,
    ]);
    // And the task-level notice still fires once, never per reviewer.
    expect(
      result.items.filter(
        (i) => i.type === "notice" && i.code === "model.unverified",
      ),
    ).toHaveLength(0);
  });

  it("records the cross-review as a seat of its own, with its model", async () => {
    const { result, events } = await runPanel(HEALTHY);
    const item = reviewItem(result.items);
    expect(item?.synthesisSeat).toMatchObject({
      reviewer: "synthesis",
      status: "completed",
      model: "claude-sonnet-4-5",
    });
    expect(item?.synthesisSeat?.usage).toBeDefined();
    // Present from the moment the synthesis STARTS, not only at the end — the
    // running block draws a chip for it.
    const running = liveReviews(events).filter(
      (u) => u.synthesis === "running",
    );
    expect(running.length).toBeGreaterThan(0);
    expect(running[0]?.synthesisSeat?.reviewer).toBe("synthesis");
  });

  it("keeps the item's usage the sum of every reviewer's AND the synthesis's", async () => {
    // R3's "charged once" arithmetic is unchanged; what changes at R9 is who
    // the HOST charges each part to (D5), not what the total is.
    const { result, requests } = await runPanel(HEALTHY);
    const item = reviewItem(result.items);
    const parts = [
      ...(item?.seats ?? []).map((s) => s.usage?.outputTokens ?? 0),
      item?.synthesisSeat?.usage?.outputTokens ?? 0,
      // V1: and the verifier's, recorded as its own sibling seat.
      item?.verifierSeat?.usage?.outputTokens ?? 0,
      // X5: and the pre-run check's, which is itemised for the same reason.
      ...(item?.preflight ?? []).map((r) => r.usage?.outputTokens ?? 0),
    ];
    expect(parts.reduce((a, b) => a + b, 0)).toBe(item?.usage?.outputTokens);
  });

  it("names each reviewer's model in the compaction history", async () => {
    // A compaction after a MIXED panel must keep the fact that makes its
    // agreement interpretable: which model said what.
    const second = panelModel(HEALTHY);
    const { store, session } = await runPanel(HEALTHY, {
      reviewPanel: {
        reviewers: [
          {},
          { model: { adapter: second.adapter, binding: other("local-8b") } },
          {},
        ],
      },
    });
    const loaded = await store.load(session.id);
    const text = buildConversationHistory(loaded.items, binding.model)
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain(
      `reviewers: ${A}=claude-sonnet-4-5, ${B}=local-8b, ${C}=claude-sonnet-4-5; synthesis=claude-sonnet-4-5`,
    );
  });

  it("V1 O13: the compaction history names the verifier's model beside the cross-review's", async () => {
    // Whether a concern was checked by a relative of the model that raised
    // it is the same kind of fact as which model raised it — so the handoff
    // a compaction writes must carry the verifier's seat, not only the
    // renderer's own test.
    const { store, session } = await runPanel(HEALTHY);
    const loaded = await store.load(session.id);
    const text = buildConversationHistory(loaded.items, binding.model)
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain(
      "; synthesis=claude-sonnet-4-5; verifier=claude-sonnet-4-5",
    );
  });

  it("runs ONE reviewer at N = 1, and says why there is no cross-review", async () => {
    // The honest record of a single standalone review: `interpretSynthesis`
    // needs two DIFFERENT reviewers per entry, so a panel of one has nothing
    // for it to do — and no child is spent finding that out.
    const { result, requests } = await runPanel(healthyFor(1), {
      reviewPanel: { reviewers: [{}] },
    });
    const item = reviewItem(result.items);
    expect(item?.seats.map((s) => s.reviewer)).toEqual([A]);
    // Three requests: the pre-run check, the one seat, and the verifier — N = 1
    // verifies like any other panel (V1). No child is spent discovering there
    // is no cross-review to run.
    expect(requests).toHaveLength(3);
    expect(item?.synthesisSeat).toBeUndefined();
    expect(limitsOf(item)).toContainEqual({
      kind: "synthesis_missing",
      reason: "insufficient_seats",
    });
  });

  it("warns and runs at N = 8, where the default carve is under the floor", async () => {
    const { result, requests } = await runPanel(healthyFor(8), {
      reviewPanel: { reviewers: Array.from({ length: 8 }, () => ({})) },
      maxFanOut: 8,
    });
    expect(noticeCodes(result.items)).toContain("review.seat_budget");
    const item = reviewItem(result.items);
    expect(item?.seats).toHaveLength(8);
    expect(item?.status).toBe("completed");
  });

  it("clamps nine reviewers to eight, SAYS so, and runs eight", async () => {
    const { result, requests } = await runPanel(healthyFor(8), {
      reviewPanel: { reviewers: Array.from({ length: 9 }, () => ({})) },
      maxFanOut: 8,
    });
    const clamped = result.items.find(
      (i) => i.type === "notice" && i.code === "review.reviewers_clamped",
    );
    expect(clamped).toBeDefined();
    expect((clamped as { n?: number }).n).toBe(8);
    expect(reviewItem(result.items)?.seats).toHaveLength(8);
  });

  it("says nothing about clamping when the request fits", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    expect(noticeCodes(result.items)).not.toContain("review.reviewers_clamped");
  });

  it("keeps ids dense per reviewer and every name distinct, at N = 8", async () => {
    // `assembleReview` THROWS on a duplicate reviewer name — a driver bug by
    // design — so a panel that reached eight reviewers is itself the proof it
    // never generated one.
    const { result, requests } = await runPanel(healthyFor(8), {
      reviewPanel: { reviewers: Array.from({ length: 8 }, () => ({})) },
      maxFanOut: 8,
    });
    const item = reviewItem(result.items);
    const names = (item?.seats ?? []).map((s) => s.reviewer);
    expect(new Set(names).size).toBe(8);
    expect(item?.result?.annotations.map((a) => a.id)).toEqual(
      REVIEWER_NAMES.map((n) => `${n}-1`),
    );
  });

  it("narrows the fan-out width to the panel's size, never past it", async () => {
    // The width dial stays `lemmaria.budget.maxFanOut`; N only ever narrows it.
    const widths: number[] = [];
    let inFlight = 0;
    let peak = 0;
    let used: BudgetUsed = { turns: 0, toolCalls: 0, outputTokens: 0 };
    await runReviewPanel({
      emit: async () => {},
      emitItem: async () => {},
      emitNotice: async () => {},
      runChild: async (_goal, allowedTools) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        widths.push(allowedTools.length);
        return {
          status: "completed" as const,
          items: [
            {
              id: `m${widths.length}`,
              type: "agent_message" as const,
              text: allowedTools.length === 0 ? SYNTH_TEXT : SEAT_TEXT,
            },
          ],
        };
      },
      parentAllowed: ["read_span"],
      offeredSkills: [skill(PANEL_SKILL)],
      budget: { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: 60_000 },
      usedSoFar: () => used,
      accrue: (u) => {
        used = { ...used, outputTokens: used.outputTokens + u.outputTokens };
      },
      fanOutConcurrency: 8,
      parentModel: "claude-sonnet-4-5",
      parent: stubParent(),
      reviewers: [{}, {}],
      workspace: workspace(),
      paperEntry: "main.tex",
    });
    // Two reviewers, so at most two ran at once even though the dial said 8.
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("replay (O17) and compaction (O18)", () => {
  it("a review left running is failed after replay, seats and all", async () => {
    const { store, session } = await runPanel(HEALTHY);
    await store.append(session.id, {
      type: "item.completed",
      item: {
        id: "stuck",
        type: "review",
        status: "running",
        skill: PANEL_SKILL,
        seats: [
          { reviewer: A, status: "running", model: "claude-sonnet-4-5" },
          { reviewer: B, status: "completed", model: "local-8b" },
        ],
      },
    });
    const loaded = await store.load(session.id);
    const stuck = loaded.items.find((i) => i.id === "stuck") as ReviewItem;
    expect(stuck.status).toBe("failed");
    expect(stuck.seats.map((s) => s.status)).toEqual(["failed", "completed"]);
    // The model each reviewer ran on survives the normalization: a panel that
    // died mid-run is exactly when a reader wants to know which model it was.
    expect(stuck.seats.map((s) => s.model)).toEqual([
      "claude-sonnet-4-5",
      "local-8b",
    ]);
  });

  it("normalizes a pre-R9 seat row, which carries no model at all", async () => {
    // A22: there is no backward-compatibility burden, so `model` is REQUIRED
    // on new rows — but a `review` item persisted before R9 has none, and a
    // replay that left the field `undefined` would put a lie in a required
    // slot. `""` is the honest answer, and the tab renders the model by
    // exception, so an empty one simply does not appear.
    const { store, session } = await runPanel(HEALTHY);
    await store.append(session.id, {
      type: "item.completed",
      item: {
        id: "pre-r9",
        type: "review",
        status: "running",
        skill: PANEL_SKILL,
        seats: [
          { reviewer: A, status: "running" },
        ] as unknown as ReviewItem["seats"],
      },
    });
    const loaded = await store.load(session.id);
    const old = loaded.items.find((i) => i.id === "pre-r9") as ReviewItem;
    expect(old.seats[0]?.model).toBe("");
  });

  it("normalizes a pre-R9 review that COMPLETED, which is the one a reader opens", async () => {
    // The normalization used to live inside the `running` branch alone, so a
    // pre-R9 review persisted as `completed` kept `model: undefined` — and
    // that is precisely the review a reader picks out of the history. Two of
    // the four readers guard on `""` and would have rendered `· undefined`.
    // The status is untouched: a completed review completed.
    const { store, session } = await runPanel(HEALTHY);
    await store.append(session.id, {
      type: "item.completed",
      item: {
        id: "pre-r9-done",
        type: "review",
        status: "completed",
        skill: PANEL_SKILL,
        seats: [
          { reviewer: A, status: "completed" },
          { reviewer: B, status: "completed" },
        ],
        synthesisSeat: { reviewer: "synthesis", status: "completed" },
      } as unknown as ReviewItem,
    });
    const loaded = await store.load(session.id);
    const old = loaded.items.find((i) => i.id === "pre-r9-done") as ReviewItem;
    expect(old.status).toBe("completed");
    expect(old.seats.map((s) => s.model)).toEqual(["", ""]);
    expect(old.seats.map((s) => s.status)).toEqual(["completed", "completed"]);
    expect(old.synthesisSeat?.model).toBe("");
  });

  it("V1: replays the verifier's seat and state, normalizing a missing model", async () => {
    const { store, session } = await runPanel(HEALTHY);
    await store.append(session.id, {
      type: "item.completed",
      item: {
        id: "v1-done",
        type: "review",
        status: "completed",
        skill: PANEL_SKILL,
        seats: [{ reviewer: A, status: "completed", model: "m" }],
        verification: "completed",
        verifierSeat: { reviewer: "verifier", status: "completed" },
      } as unknown as ReviewItem,
    });
    const loaded = await store.load(session.id);
    const item = loaded.items.find((i) => i.id === "v1-done") as ReviewItem;
    expect(item.verification).toBe("completed");
    expect(item.verifierSeat?.model).toBe("");
    // A live panel's own record replays whole.
    const live = reviewItem(loaded.items.filter((i) => i.id !== "v1-done"));
    expect(live?.verifierSeat?.reviewer).toBe("verifier");
    expect(live?.verification).toBe("completed");
  });

  it("V1: the rebuilt history marks a withdrawn concern and names the verifier", async () => {
    const withdraw = `${A}-1`;
    const { store, session } = await runPanel({
      ...HEALTHY,
      verifier: [
        {
          text: JSON.stringify({
            verifications: [
              {
                id: withdraw,
                kind: "absence",
                outcome: "refuted",
                counter: {
                  anchor:
                    "We estimate the effect with a two-stage least squares design.",
                },
              },
              { id: `${B}-1`, kind: "absence", outcome: "upheld" },
              { id: `${C}-1`, kind: "absence", outcome: "upheld" },
            ],
          }),
        },
      ],
      synthesis: [
        {
          text: JSON.stringify({
            consensus: [{ ids: [`${B}-1`, `${C}-1`], note: "both" }],
            disagreements: [],
          }),
        },
      ],
    });
    const loaded = await store.load(session.id);
    const text = buildConversationHistory(loaded.items, binding.model)
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain("1 withdrawn by verification");
    expect(text).toContain(
      "withdrawn by verification (answered at main.tex:3)",
    );
    expect(text).toContain(`verifier=${binding.model}`);
  });

  it("a completed review reaches the rebuilt history as one assistant message", async () => {
    const { store, session } = await runPanel(HEALTHY);
    const loaded = await store.load(session.id);
    const history = buildConversationHistory(loaded.items, binding.model);
    const text = history.map((m) => m.content).join("\n");
    expect(text).toContain(`${A}-1`);
    expect(text).toContain("Review panel result");
    expect(text).toContain(`consensus (${A}-1, ${B}-1)`);
  });

  it("a failed review contributes nothing to the history", async () => {
    const { store, session } = await runPanel(HEALTHY, {
      skills: [skill("related-work")],
    });
    const loaded = await store.load(session.id);
    const history = buildConversationHistory(loaded.items, binding.model);
    expect(history.map((m) => m.content).join("\n")).not.toContain(
      "Review panel result",
    );
  });
});

/**
 * ADR 0062 §1 — the R3 gate-review round. A reviewer revises and re-reviews,
 * so the reviews are a sequence, and the transcript has to say which one each
 * card is.
 */
describe("review versions (ADR 0062 §1)", () => {
  /** Two panels and a refusal on ONE session, in order. */
  async function threeRuns() {
    const store = await mkStore();
    const session = await store.create({ title: "p", workspace: "/ws" });
    const run = async (over: Partial<RunSessionTaskOptions> = {}) => {
      const model = panelModel(HEALTHY);
      return runSessionTask({
        store,
        session,
        model: model.adapter,
        binding,
        text: "/review",
        registry: readRegistry(),
        skills: [skill(PANEL_SKILL), skill("related-work")],
        workspace: workspace(),
        paperEntry: "main.tex",
        ...over,
      });
    };
    const first = await run();
    // A precondition refuses this one: it never ran, so it takes no number.
    const refused = await run({ skills: [skill("related-work")] });
    const third = await run();
    return { first, refused, third };
  }

  it("numbers each panel of the session, and a refused one takes no number", async () => {
    const { first, refused, third } = await threeRuns();
    expect(reviewItem(first.items)?.version).toBe(1);
    // The refusal is the LAST review item of its own run, and it is unversioned
    // — a version is a review you can go back to, and this one never ran.
    const refusedItem = [...refused.items]
      .reverse()
      .find((i): i is ReviewItem => i.type === "review");
    expect(refusedItem?.status).toBe("failed");
    expect(refusedItem?.version).toBeUndefined();
    // So the sequence has no hole: the next panel that RUNS is v2, not v3.
    expect(reviewItem(third.items)?.version).toBe(2);
  });

  it("stamps when the panel started — on the refused one too", async () => {
    const before = Date.now();
    const { first, refused } = await threeRuns();
    const after = Date.now();
    const at = reviewItem(first.items)?.at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    // `at` is when the user ASKED, which a refusal answers as much as a run.
    const refusedItem = [...refused.items]
      .reverse()
      .find((i): i is ReviewItem => i.type === "review");
    expect(refusedItem?.at).toBeGreaterThanOrEqual(before);
  });

  it("carries the version from the first frame, not only at the end", async () => {
    // The progress block shows it while the seats read, so it rides
    // `item.started` and every `item.updated` — not just the completed item.
    const { events } = await runPanel(HEALTHY);
    const started = events.find(
      (e) => e.type === "item.started" && e.item.type === "review",
    );
    expect((started as { item: ReviewItem } | undefined)?.item.version).toBe(1);
    for (const live of liveReviews(events)) expect(live.version).toBe(1);
  });

  it("lets the CALLER number the panel instead (O71, ADR 0065 §1)", async () => {
    // The extension runs a detached panel on a SCRATCH store, whose transcript
    // is empty by construction — so counting this session's own review items
    // would answer 1 for every review a workspace ever ran, which is the
    // defect ADR 0065 came from. A caller that passes a number is saying the
    // sequence lives somewhere else (its persisted store), and nothing here
    // second-guesses it.
    const store = await mkStore();
    const session = await store.create({ title: "p", workspace: "/ws" });
    const model = panelModel(HEALTHY);
    const out = await runSessionTask({
      store,
      session,
      model: model.adapter,
      binding,
      text: "/review",
      registry: readRegistry(),
      skills: [skill(PANEL_SKILL), skill("related-work")],
      workspace: workspace(),
      paperEntry: "main.tex",
      reviewOrdinal: 7,
    });
    expect(reviewItem(out.items)?.version).toBe(7);
  });

  it("still counts the session when no caller numbers it", async () => {
    // The CLI eval driver takes this path, and for it ADR 0062 §1's rule is
    // still right: its review really does live in one task.
    const { first } = await threeRuns();
    expect(reviewItem(first.items)?.version).toBe(1);
  });
});

describe("the manuscript's shape, said out loud (X5 O9)", () => {
  it("warns and runs when no include graph could be resolved", async () => {
    // Deny-by-default: a host that wires no reader has a panel reading the
    // FOLDER, not the paper, and is told so. It still reviews.
    const { result, requests } = await runPanel(HEALTHY, {
      manuscriptGraph: undefined,
    });
    expect(result.status).toBe("completed");
    expect(noticeCodes(result.items)).toContain("review.manuscript_unresolved");
    const notice = result.items.find(
      (i) => i.type === "notice" && i.code === "review.manuscript_unresolved",
    );
    // `n` is how many files it swept in, so a localizing UI can say it.
    expect(notice?.type === "notice" && notice.n).toBe(2);
  });

  it("says nothing about the manuscript when the graph resolved", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    expect(noticeCodes(result.items)).not.toContain(
      "review.manuscript_unresolved",
    );
    expect(noticeCodes(result.items)).not.toContain(
      "review.manuscript_incomplete",
    );
  });

  it("warns and runs when a file the manuscript DECLARES cannot be read", async () => {
    const { result, requests } = await runPanel(HEALTHY, {
      manuscriptGraph: async (entry: string) => ({
        files: [entry, "sections/method.tex"],
        missing: ["sections/gone.tex"],
      }),
    });
    expect(result.status).toBe("completed");
    const notice = result.items.find(
      (i) => i.type === "notice" && i.code === "review.manuscript_incomplete",
    );
    expect(notice?.type === "notice" && notice.n).toBe(1);
  });

  it("gives the seats ONLY what the paper includes, in reading order", async () => {
    // The whole point of the change: a second paper in the folder, the real
    // reviews of it, and Lemmaria's own memory file stop being quotable.
    const { requests } = await runPanel(HEALTHY, {
      workspace: workspace({
        "other-paper/main.tex": "someone else's paper",
        "official_reviews/r1.md": "a real review",
        "PAPER.md": "Lemmaria's memory",
      }),
      manuscriptGraph: async (entry: string) => ({
        files: [entry, "sections/method.tex"],
        missing: [],
      }),
    });
    // The first SEAT's brief — `requests[0]` is the pre-run check, which
    // carries no manuscript at all (X5, ADR 0074 §6).
    const brief = JSON.stringify(
      requests.find((r) =>
        REVIEWER_NAMES.some((n) =>
          JSON.stringify(r.messages).includes(`\`${n}\`, one of `),
        ),
      )?.messages ?? [],
    );
    expect(brief).toContain("sections/method.tex");
    expect(brief).not.toContain("other-paper");
    expect(brief).not.toContain("official_reviews");
    expect(brief).not.toContain("PAPER.md");
  });
});

describe("the one re-ask carries what failed (X5 O6, O7)", () => {
  /** A concern whose anchor is nowhere in the fixture manuscript. */
  const UNLOCATABLE = "No sentence of this manuscript reads like this.";
  /** Two real sentences of `main.tex` — the one that locates first, and the
   *  one the correction lands on. */
  const DESIGN_LINE =
    "We estimate the effect with a two-stage least squares design.";
  const SECOND =
    "Table 2 reports a gain of nine points over the strongest baseline.";

  it("re-asks a seat whose anchors dropped, and APPENDS the correction", async () => {
    const { result, requests } = await runPanel({
      [A]: [
        {
          text: JSON.stringify({
            impressions: {},
            annotations: [
              JSON.parse(ledger(DESIGN_LINE)).annotations[0],
              JSON.parse(ledger(UNLOCATABLE)).annotations[0],
            ],
          }),
        },
        // The correction: the one entry that failed, quoted properly.
        { text: ledger(SECOND) },
      ],
      [B]: [{ text: EMPTY_LEDGER }],
      [C]: [{ text: EMPTY_LEDGER }],
      synthesis: [
        {
          text: JSON.stringify({ consensus: [], disagreements: [] }),
        },
      ],
    });
    const item = reviewItem(result.items);
    const seat = item?.seats.find((s) => s.reviewer === A);
    // What located the first time kept its id; the correction was appended.
    const mine = (item?.result?.annotations ?? []).filter(
      (a) => a.reviewer === A,
    );
    expect(mine.map((a) => a.id)).toEqual([`${A}-1`, `${A}-2`]);
    expect(seat?.retried).toBe(true);
    // The first pass's drop was ANSWERED, so it is not on the record.
    const dropped = (item?.result?.limits ?? []).filter(
      (l) => l.kind === "anchors_dropped" && l.reviewer === A,
    );
    expect(dropped).toHaveLength(0);
    // Before and after the re-ask, off ONE run.
    expect(seat?.ledger?.firstPass).toEqual({
      entries: 2,
      located: 1,
      relocated: 0,
      dropped: 1,
      rejected: 0,
    });
    expect(seat?.ledger?.located).toBe(2);
    expect(seat?.ledger?.entries).toBe(2);
  });

  it("is harmless when the seat re-sends its WHOLE ledger", async () => {
    const { result, requests } = await runPanel({
      [A]: [
        {
          text: JSON.stringify({
            impressions: {},
            annotations: [
              JSON.parse(ledger(DESIGN_LINE)).annotations[0],
              JSON.parse(ledger(UNLOCATABLE)).annotations[0],
            ],
          }),
        },
        {
          // The one that already located, sent again, beside the correction.
          text: JSON.stringify({
            annotations: [
              JSON.parse(ledger(DESIGN_LINE)).annotations[0],
              JSON.parse(ledger(SECOND)).annotations[0],
            ],
          }),
        },
      ],
      [B]: [{ text: EMPTY_LEDGER }],
      [C]: [{ text: EMPTY_LEDGER }],
      synthesis: [
        { text: JSON.stringify({ consensus: [], disagreements: [] }) },
      ],
    });
    const item = reviewItem(result.items);
    const mine = (item?.result?.annotations ?? []).filter(
      (a) => a.reviewer === A,
    );
    // Two, not three: the re-sent entry was recognised and skipped.
    expect(mine.map((a) => a.id)).toEqual([`${A}-1`, `${A}-2`]);
  });

  it("a correction that is PROSE costs nothing but the correction", async () => {
    const { result, requests } = await runPanel({
      [A]: [
        {
          text: JSON.stringify({
            impressions: {},
            annotations: [
              JSON.parse(ledger(DESIGN_LINE)).annotations[0],
              JSON.parse(ledger(UNLOCATABLE)).annotations[0],
            ],
          }),
        },
        { text: "Sorry — I could not find that passage again." },
      ],
      [B]: [{ text: EMPTY_LEDGER }],
      [C]: [{ text: EMPTY_LEDGER }],
      synthesis: [
        { text: JSON.stringify({ consensus: [], disagreements: [] }) },
      ],
    });
    const item = reviewItem(result.items);
    const mine = (item?.result?.annotations ?? []).filter(
      (a) => a.reviewer === A,
    );
    // The located concern survives — which is the whole point of merging
    // rather than replacing.
    expect(mine).toHaveLength(1);
    // And the first pass's drop is STILL on the record: nothing answered it.
    const dropped = (item?.result?.limits ?? []).find(
      (l) => l.kind === "anchors_dropped" && l.reviewer === A,
    );
    expect(dropped).toBeDefined();
  });

  it("makes exactly ONE request for a seat whose first answer was clean", async () => {
    const { requests } = await runPanel(HEALTHY);
    const mine = requests.filter((r) => {
      const first = r.messages.find((m) => m.role === "user");
      return (
        typeof first?.content === "string" &&
        first.content.includes(`\`${A}\`, one of `)
      );
    });
    expect(mine).toHaveLength(1);
    const item = reviewItem((await runPanel(HEALTHY)).result.items);
    const seat = item?.seats.find((s) => s.reviewer === A);
    expect(seat?.retried).toBeUndefined();
    expect(seat?.ledger?.firstPass).toBeUndefined();
    expect(seat?.ledger).toEqual({
      entries: 1,
      located: 1,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    });
  });

  it("keeps the tally's identities over every seat of a panel", async () => {
    const { result, requests } = await runPanel(HEALTHY);
    const item = reviewItem(result.items);
    for (const seat of item?.seats ?? []) {
      const c = seat.ledger;
      if (c === undefined) continue;
      expect(c.located + c.dropped + c.rejected).toBe(c.entries);
      expect(c.relocated).toBeLessThanOrEqual(c.located);
      // firstPass present implies retried; the converse is false.
      if (c.firstPass !== undefined) expect(seat.retried).toBe(true);
    }
  });
});

/**
 * V2 (ADR 0078 §3–§4, O9): a paper is checked against THAT seat's own
 * searches, and only its own.
 *
 * This is stage-gate claim 3 as a test. Pooling the panel's results would make
 * a reviewer able to cite what it was never shown, which breaks blindness in
 * one direction — so the fixture gives each seat a different paper and asserts
 * that neither can reach the other's.
 */
describe("a paper is that seat's own, and the re-ask can fix it (V2, O9)", () => {
  /** A literature tool whose answer depends on the QUERY, so two seats that
   *  search differently are shown different papers — which is the only way to
   *  tell "this seat's results" from "the panel's". */
  const withLiterature = (r: Map<ToolName, ToolExecutor>) => {
    r.set("literature_search", {
      name: "literature_search",
      category: "retrieval",
      spec: {
        name: "literature_search",
        description: "search",
        parameters: { type: "object" },
      },
      invoke: async (args) => {
        const query = (args as { query?: string }).query ?? "";
        return ok({
          sources: [{ name: "arxiv", endpoint: "e", status: "ok" }],
          results: [
            {
              title: `Paper ${query}`,
              authors: ["A. Author"],
              year: "2020",
              source: "arxiv",
            },
          ],
        });
      },
    });
  };

  /** A ledger citing a paper by title. */
  const citingLedger = (anchor: string, title: string) =>
    JSON.stringify({
      impressions: {},
      annotations: [
        {
          dimension: "positioning",
          severity: "major",
          anchor,
          evidence: { paper: { title } },
          message: "this is not new",
        },
      ],
    });

  const ANCHOR_A =
    "The instrument is the distance to the nearest treated unit.";
  const ANCHOR_B =
    "We conclude that the method generalises to every domain we tried.";

  it("records a paper the seat searched for, drops one only another seat saw, and appends the correction", async () => {
    const { result, requests } = await runPanel(
      {
        // A searches for "alpha", is shown "Paper alpha", and cites it.
        [A]: [
          {
            toolCalls: [
              { id: "a1", name: "literature_search", args: { query: "alpha" } },
            ],
          },
          { text: citingLedger(ANCHOR_A, "Paper alpha") },
        ],
        // B cites A's paper without ever searching. The harness has no results
        // for B, so the concern drops — and B is asked once.
        [B]: [
          { text: citingLedger(ANCHOR_B, "Paper alpha") },
          // The correction round: B searches for itself this time, and cites
          // what IT was shown.
          {
            toolCalls: [
              { id: "b1", name: "literature_search", args: { query: "beta" } },
            ],
          },
          { text: citingLedger(ANCHOR_B, "Paper beta") },
        ],
        [C]: [{ text: EMPTY_LEDGER }],
        synthesis: [
          { text: JSON.stringify({ consensus: [], disagreements: [] }) },
        ],
        verifier: [{ text: JSON.stringify({ verifications: [] }) }],
      },
      { registry: readRegistry(withLiterature) },
    );

    const item = reviewItem(result.items);
    const annotations = item?.result?.annotations ?? [];
    const evidences = annotations.map((a) => a.evidence);

    // A's concern is recorded, against the result A's OWN search returned.
    expect(evidences).toContainEqual({
      kind: "paper",
      title: "Paper alpha",
      authors: ["A. Author"],
      year: "2020",
      source: "arxiv",
    });
    // Exactly one reviewer cites "Paper alpha" — B could not reach it.
    expect(
      annotations
        .filter(
          (a) =>
            a.evidence?.kind === "paper" && a.evidence.title === "Paper alpha",
        )
        .map((a) => a.reviewer),
    ).toEqual([A]);

    // B's first attempt dropped, and B was asked once. The merged record
    // carries the SECOND pass's limits (ADR 0074 §5), so the drop is not in
    // `limits` — it is in the seat's own `firstPass` tally, which is where
    // *before and after the correction round* is read off one run.
    const seatB = item?.seats?.find((x) => x.reviewer === B);
    expect(seatB?.retried).toBe(true);
    expect(seatB?.ledger?.firstPass).toMatchObject({
      entries: 1,
      located: 0,
      dropped: 1,
    });
    expect(seatB?.ledger).toMatchObject({ located: 1, dropped: 0 });
    // And the feedback B received named the paper in its own sentence — never
    // the `unknown_file` one, which would have said "names `undefined`".
    const bFeedback = requests
      .filter((r) => seatKey(r) === B)
      .flatMap((r) => r.messages.map((m) => String(m.content)));
    expect(bFeedback.join("\n")).toContain(
      '- the paper "Paper alpha" is not among the results your own literature searches returned.',
    );
    expect(bFeedback.join("\n")).not.toContain("undefined");

    // And B's correction — citing a paper B's own later search returned — is
    // APPENDED, with a fresh id of B's own.
    const bPapers = annotations.filter((a) => a.reviewer === B);
    expect(bPapers.map((a) => a.evidence)).toEqual([
      {
        kind: "paper",
        title: "Paper beta",
        authors: ["A. Author"],
        year: "2020",
        source: "arxiv",
      },
    ]);
    expect(bPapers[0]?.id).toBe(`${B}-1`);
  });
});

/**
 * V2 (ADR 0078 §5, §D8, O13): the driver fills the holder for the run, empties
 * it on every exit, and says so on the record when it could not.
 *
 * The emptying is the part with teeth. A title left behind would filter the
 * user's OWN chat searches after the panel ended — a behaviour nobody asked
 * for, and the failure the plan named as a BLOCKED trigger if it could not be
 * made run-scoped.
 */
describe("the panel withholds its own title, for the run only (V2, O13)", () => {
  /** A literature tool that records what it was asked to withhold, at each
   *  call, so the holder's lifetime is observable from outside the driver. */
  const recordingLiterature =
    (seen: string[][]): ((r: Map<ToolName, ToolExecutor>) => void) =>
    (r) => {
      r.set("literature_search", {
        name: "literature_search",
        category: "retrieval",
        spec: {
          name: "literature_search",
          description: "search",
          parameters: { type: "object" },
        },
        invoke: async () => {
          seen.push([...holder.titles]);
          return ok({
            sources: [{ name: "arxiv", endpoint: "e", status: "ok" }],
            results: [],
          });
        },
      });
    };
  let holder = { titles: [] as string[] };

  const searchThen = (text: string) => [
    {
      toolCalls: [
        {
          id: "s",
          name: "literature_search" as ToolName,
          args: { query: "q" },
        },
      ],
    },
    { text },
  ];

  it("fills it with the manuscript's title while the seats run, and empties it after", async () => {
    holder = { titles: [] };
    const seen: string[][] = [];
    const { result } = await runPanel(
      {
        [A]: searchThen(
          ledger("The instrument is the distance to the nearest treated unit."),
        ),
        [B]: [{ text: EMPTY_LEDGER }],
        [C]: [{ text: EMPTY_LEDGER }],
      },
      {
        registry: readRegistry(recordingLiterature(seen)),
        literatureWithhold: holder,
      },
    );

    // While a seat was searching, the guard knew the paper's title — read from
    // `\title` on line 1 of the fixture.
    expect(seen).toEqual([["A Two-Stage Least Squares Study"]]);
    // And once the panel is over it is empty again, so the user's own chat
    // searches are unfiltered.
    expect(holder.titles).toEqual([]);
    // Nothing to report: the guard ran.
    expect(
      limitsOf(reviewItem(result.items)).filter(
        (l) => l.kind === "own_title_unguarded",
      ),
    ).toEqual([]);
  });

  it("empties it even when the panel is REFUSED before a seat runs", async () => {
    holder = { titles: ["left over from somewhere"] };
    // No protocol offered ⇒ the panel refuses at its first precondition.
    await runPanel(HEALTHY, {
      skills: [],
      literatureWithhold: holder,
    });
    expect(holder.titles).toEqual([]);
  });

  it("empties it when the panel is INTERRUPTED mid-run", async () => {
    // O13 names three exits and the suite tested two. The `finally` covers all
    // three structurally, but a holder left full after an interrupt would
    // silently filter the user's next ordinary chat search -- which is the one
    // consequence nothing else in the tree would notice.
    holder = { titles: ["left over from somewhere"] };
    const controller = new AbortController();
    controller.abort();
    const { result } = await runPanel(HEALTHY, {
      signal: controller.signal,
      literatureWithhold: holder,
    });
    expect(reviewItem(result.items)?.status).toBe("interrupted");
    expect(holder.titles).toEqual([]);
  });

  it("empties it when the panel THROWS", async () => {
    // The third exit. A workspace whose read rejects makes `collectManuscript`
    // throw inside the driver, after the wrapper has been entered -- so the
    // `finally` is the only thing that can clear the holder.
    holder = { titles: ["left over from somewhere"] };
    const exploding = {
      root: "/ws",
      readFile: () => Promise.reject(new Error("disk is gone")),
      listFiles: () => Promise.reject(new Error("disk is gone")),
    };
    const { result } = await runPanel(HEALTHY, {
      workspace: exploding,
      literatureWithhold: holder,
    });
    // However the driver reports it, the holder is empty afterwards.
    expect(result).toBeDefined();
    expect(holder.titles).toEqual([]);
  });

  it("records `no_title` when the manuscript offers none", async () => {
    holder = { titles: [] };
    const { result } = await runPanel(HEALTHY, {
      literatureWithhold: holder,
      // A workspace whose entry carries no `\title` at all.
      workspace: workspace({ "main.tex": "\\documentclass{article}\n" }),
    });
    expect(
      limitsOf(reviewItem(result.items)).filter(
        (l) => l.kind === "own_title_unguarded",
      ),
    ).toEqual([{ kind: "own_title_unguarded", reason: "no_title" }]);
  });

  it("records `unavailable` when the host wired no holder", async () => {
    // Deny-by-default: the record says the guard could not run, rather than a
    // clean review implying it did.
    const { result } = await runPanel(HEALTHY, {
      literatureWithhold: undefined,
    });
    expect(
      limitsOf(reviewItem(result.items)).filter(
        (l) => l.kind === "own_title_unguarded",
      ),
    ).toEqual([{ kind: "own_title_unguarded", reason: "unavailable" }]);
  });

  it("carries `ownTitleWithheld` on a seat's row, and only when it fired", async () => {
    holder = { titles: [] };
    const withheldBy = (n: number) => (r: Map<ToolName, ToolExecutor>) => {
      r.set("literature_search", {
        name: "literature_search",
        category: "retrieval",
        spec: {
          name: "literature_search",
          description: "search",
          parameters: { type: "object" },
        },
        invoke: async () =>
          ok({
            sources: [{ name: "arxiv", endpoint: "e", status: "ok" }],
            ...(n > 0 ? { withheld: { ownTitle: n } } : {}),
            results: [],
          }),
      });
    };
    const { result } = await runPanel(
      {
        [A]: searchThen(
          ledger("The instrument is the distance to the nearest treated unit."),
        ),
        [B]: [{ text: EMPTY_LEDGER }],
        [C]: [{ text: EMPTY_LEDGER }],
      },
      { registry: readRegistry(withheldBy(2)), literatureWithhold: holder },
    );
    const seats = reviewItem(result.items)?.seats ?? [];
    expect(seats.find((s) => s.reviewer === A)?.ownTitleWithheld).toBe(2);
    // B and C never searched, so their rows carry no key at all.
    expect(seats.find((s) => s.reviewer === B)).not.toHaveProperty(
      "ownTitleWithheld",
    );
  });
});

/**
 * V5 (ADR 0087, O5, O12's store half, O20's driver half): strengths and
 * assessments ride the panel from each seat's ledger into the record, a
 * seat's searches are counted before its transcript is discarded, and an
 * absent `impressions` block, on its own, spends the one re-ask.
 */
describe("strengths, impressions and searches reach the record (V5, O5, O20)", () => {
  /** A literature tool whose sources answer — or all fail, for "down". */
  const withLiterature = (r: Map<ToolName, ToolExecutor>) => {
    r.set("literature_search", {
      name: "literature_search",
      category: "retrieval",
      spec: {
        name: "literature_search",
        description: "search",
        parameters: { type: "object" },
      },
      invoke: async (args) => {
        const query = (args as { query?: string }).query ?? "";
        if (query === "down") {
          return ok({
            sources: [{ name: "arxiv", endpoint: "e", status: "timeout" }],
            results: [],
          });
        }
        // The fallbacks `searchAnswered` reads when there are no per-source
        // statuses (the code review's Minor 5): a results list alone, an
        // empty `sources` beside one, and neither.
        if (query === "bare") return ok({ results: [] });
        if (query === "no-sources") return ok({ sources: [], results: [] });
        if (query === "nothing") return ok({});
        return ok({
          sources: [{ name: "arxiv", endpoint: "e", status: "ok" }],
          results: [
            {
              title: `Paper ${query}`,
              authors: ["A. Author"],
              year: "2020",
              source: "arxiv",
            },
          ],
        });
      },
    });
  };
  const search = (id: string, query: string): ScriptedTurn => ({
    toolCalls: [{ id, name: "literature_search", args: { query } }],
  });

  const DESIGN =
    "We estimate the effect with a two-stage least squares design.";
  const INSTRUMENT =
    "The instrument is the distance to the nearest treated unit.";
  const TABLE =
    "Table 2 reports a gain of nine points over the strongest baseline.";
  const PRAISE = "the design is laid out before the estimate is reported";

  /** A's ledger: one concern, one strength, a located paper-backed strength,
   *  a strength that cannot locate, and impressions. */
  const A_LEDGER = JSON.stringify({
    annotations: [
      {
        dimension: "soundness",
        severity: "major",
        anchor: INSTRUMENT,
        evidence: "missing",
        message: "the exclusion restriction is never argued",
      },
    ],
    strengths: [
      { dimension: "clarity", anchor: DESIGN, message: PRAISE },
      {
        dimension: "originality",
        anchor: TABLE,
        evidence: { paper: { title: "Paper alpha" } },
        message: "goes past the closest work by a clear margin",
      },
      {
        dimension: "clarity",
        anchor: "No sentence of this manuscript reads like this.",
        message: "lost",
      },
    ],
    impressions: { soundness: 4, clarity: 8, originality: null },
  });

  /** A's answer to its one re-ask (the lost strength spends it): the same
   *  strength, still unlocatable, so its loss stays on the record. */
  const A_CORRECTION = JSON.stringify({
    annotations: [],
    strengths: [
      {
        dimension: "clarity",
        anchor: "No sentence of this manuscript reads like this.",
        message: "lost",
      },
    ],
  });

  it("carries each seat's strengths and assessments into the result, and counts them apart", async () => {
    const { result } = await runPanel(
      {
        [A]: [
          search("a1", "alpha"),
          { text: A_LEDGER },
          { text: A_CORRECTION },
        ],
        [B]: [{ text: EMPTY_LEDGER }],
        [C]: [{ text: EMPTY_LEDGER }],
        synthesis: [
          { text: JSON.stringify({ consensus: [], disagreements: [] }) },
        ],
      },
      { registry: readRegistry(withLiterature) },
    );
    const item = reviewItem(result.items);
    expect(item?.result?.strengths?.map((s) => s.id)).toEqual([
      `${A}-s1`,
      `${A}-s2`,
    ]);
    expect(item?.result?.strengths?.[1]?.evidence).toMatchObject({
      kind: "paper",
      title: "Paper alpha",
    });
    // Seven assessments per contributing reviewer — B and C sent `{}`.
    const assessments = item?.result?.assessments ?? [];
    for (const r of [A, B, C]) {
      expect(assessments.filter((a) => a.reviewer === r)).toHaveLength(7);
    }
    expect(
      assessments.find((a) => a.reviewer === A && a.dimension === "clarity")
        ?.impression,
    ).toBe(8);
    // The lost strength is its own limit, never a concern drop.
    const lost = limitsOf(item).filter((l) => l.kind === "strengths_lost");
    expect(lost).toHaveLength(1);
    expect(limitsOf(item).some((l) => l.kind === "anchors_dropped")).toBe(
      false,
    );
    // The row counts strengths apart; the concern identity is untouched.
    const row = item?.seats.find((s) => s.reviewer === A);
    expect(row?.ledger).toMatchObject({
      entries: 1,
      located: 1,
      strengths: { entries: 3, located: 2, dropped: 1, rejected: 0 },
    });
    // The lost strength spent the re-ask, so the first pass is on the row too.
    expect(row?.retried).toBe(true);
    expect(row?.ledger?.firstPass?.strengths).toEqual({
      entries: 3,
      located: 2,
      relocated: 0,
      dropped: 1,
      rejected: 0,
    });
  });

  it("stamps what each seat's searches came to, per seat, on every completed row", async () => {
    const { result } = await runPanel(
      {
        [A]: [
          search("a1", "alpha"),
          search("a2", "down"),
          { text: A_LEDGER },
          { text: A_CORRECTION },
        ],
        [B]: [search("b1", "down"), { text: EMPTY_LEDGER }],
        [C]: [{ text: EMPTY_LEDGER }],
        synthesis: [
          { text: JSON.stringify({ consensus: [], disagreements: [] }) },
        ],
      },
      { registry: readRegistry(withLiterature) },
    );
    const item = reviewItem(result.items);
    const searches = (r: string) =>
      item?.seats.find((s) => s.reviewer === r)?.searches;
    expect(searches(A)).toEqual({ attempted: 2, answered: 1 });
    expect(searches(B)).toEqual({ attempted: 1, answered: 0 });
    expect(searches(C)).toEqual({ attempted: 0, answered: 0 });
    for (const seat of item?.seats ?? []) {
      const s = seat.searches;
      if (s !== undefined) expect(s.answered).toBeLessThanOrEqual(s.attempted);
    }
  });

  it("with no per-source statuses, a results list is an answer and its absence is not", async () => {
    const { result } = await runPanel(
      {
        // A results list alone, and an empty `sources` beside one: answered.
        [A]: [
          search("a1", "bare"),
          search("a2", "no-sources"),
          { text: EMPTY_LEDGER },
        ],
        // Neither a status nor a results list: attempted, never answered.
        [B]: [search("b1", "nothing"), { text: EMPTY_LEDGER }],
        [C]: [{ text: EMPTY_LEDGER }],
        synthesis: [
          { text: JSON.stringify({ consensus: [], disagreements: [] }) },
        ],
      },
      { registry: readRegistry(withLiterature) },
    );
    const item = reviewItem(result.items);
    const searches = (r: string) =>
      item?.seats.find((s) => s.reviewer === r)?.searches;
    expect(searches(A)).toEqual({ attempted: 2, answered: 2 });
    expect(searches(B)).toEqual({ attempted: 1, answered: 0 });
  });

  it("hands no strength to the verifier or the cross-review", async () => {
    const { requests } = await runPanel(
      {
        [A]: [
          search("a1", "alpha"),
          { text: A_LEDGER },
          { text: A_CORRECTION },
        ],
        [B]: [
          {
            text: JSON.stringify({
              annotations: [
                {
                  dimension: "claims",
                  severity: "minor",
                  anchor: TABLE,
                  evidence: "missing",
                  message: "the baseline is not named",
                },
              ],
              strengths: [
                { dimension: "clarity", anchor: TABLE, message: PRAISE },
              ],
              impressions: {},
            }),
          },
        ],
        [C]: [{ text: EMPTY_LEDGER }],
        synthesis: [
          { text: JSON.stringify({ consensus: [], disagreements: [] }) },
        ],
      },
      { registry: readRegistry(withLiterature) },
    );
    const briefOf = (key: string) =>
      requests
        .filter((r) => seatKey(r) === key)
        .map((r) => JSON.stringify(r.messages))
        .join("\n");
    for (const key of ["verifier", "synthesis"]) {
      const brief = briefOf(key);
      expect(brief).not.toBe("");
      expect(brief).not.toContain(PRAISE);
      expect(brief).not.toContain("goes past the closest work");
      expect(brief).not.toMatch(/reviewer_[abc]-s\d/);
    }
  });

  it("an ABSENT impressions block, on its own, spends the one re-ask — and a scalar-only answer is merged", async () => {
    const { result, requests } = await runPanel({
      // A's first answer is complete but carries no impressions block.
      [A]: [
        {
          text: JSON.stringify({
            annotations: [
              {
                dimension: "soundness",
                severity: "major",
                anchor: INSTRUMENT,
                evidence: "missing",
                message: "the exclusion restriction is never argued",
              },
            ],
            strengths: [
              { dimension: "clarity", anchor: DESIGN, message: PRAISE },
            ],
          }),
        },
        // Its reply to the re-ask: the scalars alone, no annotations key.
        { text: JSON.stringify({ impressions: { soundness: 3, clarity: 7 } }) },
      ],
      [B]: [{ text: EMPTY_LEDGER }],
      [C]: [{ text: EMPTY_LEDGER }],
      synthesis: [
        { text: JSON.stringify({ consensus: [], disagreements: [] }) },
      ],
    });
    const item = reviewItem(result.items);
    const row = item?.seats.find((s) => s.reviewer === A);
    expect(row?.retried).toBe(true);
    // Asked once, with the lead-in that claims no failed entry.
    const feedback = requests
      .filter((r) => seatKey(r) === A)
      .flatMap((r) => r.messages)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((t) => t.includes("Every entry of your ledger was recorded."));
    expect(new Set(feedback).size).toBe(1);
    expect(feedback[0]).toContain(
      '- your reply carries no "impressions" block; send one, with an integer 1–10 or null for each dimension your brief lists',
    );
    expect(feedback[0]).toContain('"annotations": []');
    // The first pass's concern and strength are kept; the scalars merged.
    expect(
      item?.result?.annotations
        .filter((a) => a.reviewer === A)
        .map((a) => a.id),
    ).toEqual([`${A}-1`]);
    expect(item?.result?.strengths?.map((s) => s.id)).toEqual([`${A}-s1`]);
    const impression = (d: string) =>
      item?.result?.assessments?.find(
        (a) => a.reviewer === A && a.dimension === d,
      )?.impression;
    expect(impression("soundness")).toBe(3);
    expect(impression("clarity")).toBe(7);
    expect(impression("claims")).toBeNull();
    // B and C carried a block, so neither was re-asked.
    expect(item?.seats.find((s) => s.reviewer === B)?.retried).toBeUndefined();
  });

  it("the record replays through the session store, and the history names a lost strength", async () => {
    const { store, session } = await runPanel(
      {
        [A]: [
          search("a1", "alpha"),
          { text: A_LEDGER },
          { text: A_CORRECTION },
        ],
        [B]: [{ text: EMPTY_LEDGER }],
        [C]: [{ text: EMPTY_LEDGER }],
        synthesis: [
          { text: JSON.stringify({ consensus: [], disagreements: [] }) },
        ],
      },
      { registry: readRegistry(withLiterature) },
    );
    const loaded = await store.load(session.id);
    const item = reviewItem(loaded.items);
    expect(item?.result?.strengths).toHaveLength(2);
    expect(item?.result?.assessments).toHaveLength(21);
    expect(item?.seats.find((s) => s.reviewer === A)?.searches).toEqual({
      attempted: 1,
      answered: 1,
    });
    const text = buildConversationHistory(loaded.items, binding.model)
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain(
      `limit: strengths_lost — ${A}: 1 strength(s) not recorded`,
    );
    // Strengths are not compaction material.
    expect(text).not.toContain(PRAISE);
  });
});
