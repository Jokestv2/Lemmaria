/**
 * R5 (O6): stage-gate claim 1 — **blindness is asserted, not asserted-about.**
 *
 * v0.3's gate claims that a reviewer never sees another reviewer's text or the
 * parent's transcript, that the persisted report is the reviewers' own ledgers
 * and nothing added, that the cross-review runs only after every reviewer has
 * settled and reads them by id, and that a reviewer that never reported is
 * named rather than silently dropped.
 *
 * Those four properties are each pinned somewhere — R3's O7/O9/O13/O14 and
 * R9's O7 — but never together, and never under the topology users actually
 * run since R9 made the reviewers' models a setting: **N reviewers on
 * DIFFERENT models**. A panel that leaks only when two reviewers sit on
 * different adapters is exactly the failure a single-adapter assertion cannot
 * see, so this is the test the stage-gate ledger points at.
 *
 * Nothing under `src/` changes for it. It is a consolidation, and its value is
 * that a later milestone breaking any one of the four breaks a test whose name
 * says which claim it broke.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  GenerateRequest,
  ModelBinding,
  ReviewItem,
  ReviewLimit,
  SessionItem,
  Skill,
  ToolName,
} from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/index.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import type { ScriptedTurn } from "../../src/model/scripted.js";
import { scriptedByKey } from "../../src/model/scripted.js";
import {
  PANEL_SKILL,
  PREFLIGHT_PROMPT,
  REVIEWER_NAMES,
} from "../../src/session/review-panel.js";
import {
  VERIFIER_BRIEF_MARKER,
  VERIFIER_SKILL,
  VERIFIER_TOOLS,
} from "../../src/session/review-verifier.js";
import { runSessionTask } from "../../src/session/run.js";
import type { RunSessionTaskOptions } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";

const [A, B, C] = REVIEWER_NAMES as unknown as [string, string, string];

/** The focus the user aimed the panel with — reviewers DO see this, and only
 *  this, of what the parent said (ADR 0064). */
const FOCUS = "check the cost model";

/** What the parent actually typed. No reviewer may see it. */
const PARENT_TEXT = `/review ${FOCUS}`;

const temps: string[] = [];
afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function mkStore(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-panel-blindness-"));
  temps.push(dir);
  return new SessionStore(join(dir, "sessions"));
}

const parentBinding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "model-x",
  apiKey: "k",
};

/** The second model a mixed panel binds one reviewer to. */
const otherBinding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "model-y",
  apiKey: "k2",
};

/** Hard-wrapped, so each line is one whole quotable anchor. */
const MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "We estimate the effect with a two-stage least squares design.",
  "The instrument is the distance to the nearest treated unit.",
  "Table 2 reports a gain of nine points over the strongest baseline.",
  "We conclude that the method generalises to every domain we tried.",
  "\\end{document}",
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
  const tree: Record<string, string> = { "main.tex": MAIN };
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

interface Concern {
  anchor: string;
  dimension: string;
  severity: "info" | "minor" | "major";
  message: string;
  blocking?: boolean;
}

const ledgerOf = (concerns: Concern[]): string =>
  JSON.stringify({
    impressions: {},
    annotations: concerns.map((c) => ({
      dimension: c.dimension,
      severity: c.severity,
      anchor: c.anchor,
      evidence: "missing",
      message: c.message,
      ...(c.blocking !== undefined ? { blocking: c.blocking } : {}),
    })),
  });

/** The seat a request belongs to, from its FIRST user message (R9's rule). */
function seatKey(request: GenerateRequest): string {
  const first = request.messages.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  // X5 (ADR 0074 §6): the pre-run check, which belongs to no seat. Keyed so a
  // test can address it; unscripted it rides `scriptedByKey`'s fallback turn,
  // which resolves — and resolving is what the check reads as `ok`.
  if (text === PREFLIGHT_PROMPT) return "preflight";
  for (const name of REVIEWER_NAMES) {
    if (text.includes(`\`${name}\`, one of `)) return name;
  }
  // V1 (ADR 0076 §5): the verifier, keyed by its brief's marker sentence.
  if (text.includes(VERIFIER_MARKER)) return "verifier";
  return text.includes("reviewers have each read") ? "synthesis" : text;
}

/** The sentence every verifier brief opens its prose with (V1). */
const VERIFIER_MARKER = VERIFIER_BRIEF_MARKER;

/** One request, as the journal records it: which adapter saw it, and when. */
interface Seen {
  adapter: "X" | "Y";
  request: GenerateRequest;
}

/**
 * A recording adapter over a seat-keyed script.
 *
 * Two of these run in every test below. A single recorder can only ever prove
 * that one process did not confuse its own children; two prove that the
 * request went to the model it was bound to and to no other, which is what
 * blindness means once the models are a setting (ADR 0069 §D4).
 */
function recorder(
  label: "X" | "Y",
  scripts: Record<string, ScriptedTurn[]>,
  journal: Seen[],
) {
  const inner = scriptedByKey(scripts);
  const requests: GenerateRequest[] = [];
  const keyed = (request: GenerateRequest): GenerateRequest => ({
    ...request,
    messages: [
      ...request.messages.filter((m) => m.role === "system"),
      { role: "user" as const, content: seatKey(request) },
    ],
  });
  return {
    requests,
    adapter: {
      protocol: "anthropic" as const,
      generate: (request: GenerateRequest) => {
        requests.push(request);
        journal.push({ adapter: label, request });
        return inner.generate(keyed(request));
      },
      async *generateStream(request: GenerateRequest) {
        requests.push(request);
        journal.push({ adapter: label, request });
        const stream = inner.generateStream as (
          r: GenerateRequest,
        ) => AsyncIterable<unknown>;
        yield* stream(keyed(request)) as AsyncIterable<never>;
      },
    },
  };
}

/**
 * Runs one panel of three reviewers across two adapters — `reviewer_a` and
 * `reviewer_c` on X (the parent's), `reviewer_b` on Y — and hands back
 * everything the assertions read.
 */
async function runMixedPanel(
  scripts: Record<string, ScriptedTurn[]>,
  over: Partial<RunSessionTaskOptions> = {},
) {
  const store = await mkStore();
  const session = await store.create({ title: "panel", workspace: "/ws" });
  const journal: Seen[] = [];
  const x = recorder("X", scripts, journal);
  const y = recorder("Y", scripts, journal);
  const result = await runSessionTask({
    store,
    session,
    model: x.adapter,
    binding: parentBinding,
    text: PARENT_TEXT,
    registry: readRegistry(),
    skills: [skill(PANEL_SKILL), skill("related-work")],
    workspace: workspace(),
    paperEntry: "main.tex",
    reviewPanel: {
      reviewers: [
        {},
        { model: { adapter: y.adapter, binding: otherBinding } },
        {},
      ],
    },
    ...over,
  });
  const item = [...result.items]
    .reverse()
    .find((i): i is ReviewItem => i.type === "review");
  return { result, item, journal, x, y };
}

const limitsOf = (item: ReviewItem | undefined): ReviewLimit[] =>
  item?.result?.limits ?? [];

const bodyOf = (request: GenerateRequest): string =>
  JSON.stringify(request.messages);

// ── the scripts ─────────────────────────────────────────────────────────────

const A_CONCERNS: Concern[] = [
  {
    anchor: "The instrument is the distance to the nearest treated unit.",
    dimension: "soundness",
    severity: "major",
    message: "the exclusion restriction is never argued for",
    blocking: true,
  },
];
const B_CONCERNS: Concern[] = [
  {
    anchor: "We conclude that the method generalises to every domain we tried.",
    dimension: "claims",
    severity: "major",
    message: "the conclusion outruns the evidence offered for it",
  },
];
const C_CONCERNS: Concern[] = [
  {
    anchor:
      "Table 2 reports a gain of nine points over the strongest baseline.",
    dimension: "positioning",
    severity: "minor",
    message: "the strongest baseline is not the one the field uses",
  },
];

/** An anchor no reviewer could have quoted from this manuscript. */
const UNLOCATABLE = "A sentence that appears nowhere in the manuscript at all.";

const SYNTHESIS = JSON.stringify({
  consensus: [
    { ids: [`${A}-1`, `${B}-1`], note: "both read the design as unsupported" },
  ],
  disagreements: [],
});

/**
 * What a cross-review can write when one reviewer never reported: it cites the
 * two that did. `SYNTHESIS` above cites `${B}-1`, which does not exist in that
 * run, and `interpretSynthesis` refuses a cross-review naming an id it cannot
 * resolve — so the missing-reviewer test needs its own script or it asserts
 * over nothing.
 */
const SURVIVORS_SYNTHESIS = JSON.stringify({
  consensus: [
    { ids: [`${A}-1`, `${C}-1`], note: "both read the reporting as thin" },
  ],
  disagreements: [],
});

const HEALTHY: Record<string, ScriptedTurn[]> = {
  [A]: [{ text: ledgerOf(A_CONCERNS) }],
  [B]: [{ text: ledgerOf(B_CONCERNS) }],
  [C]: [{ text: ledgerOf(C_CONCERNS) }],
  synthesis: [{ text: SYNTHESIS }],
};

// ── the claim ───────────────────────────────────────────────────────────────

describe("stage gate claim 1 — blindness is asserted, not asserted-about", () => {
  it("leaks no reviewer's name, id or the parent's own words into another's request", async () => {
    const { journal, x, y } = await runMixedPanel(HEALTHY);
    // Each reviewer's traffic went to ITS adapter and to no other, which is
    // what makes the leak question meaningful at all under mixed models.
    const carries = (requests: GenerateRequest[], name: string): boolean =>
      requests.some((r) => bodyOf(r).includes(`\`${name}\`, one of `));
    expect(carries(x.requests, A)).toBe(true);
    expect(carries(x.requests, C)).toBe(true);
    expect(carries(x.requests, B)).toBe(false);
    expect(carries(y.requests, B)).toBe(true);
    expect(carries(y.requests, A)).toBe(false);
    expect(carries(y.requests, C)).toBe(false);

    for (const name of [A, B, C]) {
      const mine = journal.filter((s) =>
        bodyOf(s.request).includes(`\`${name}\`, one of `),
      );
      expect(mine.length).toBeGreaterThan(0);
      for (const seen of mine) {
        const text = bodyOf(seen.request);
        for (const other of [A, B, C]) {
          if (other === name) continue;
          expect(text).not.toContain(`\`${other}\``);
          expect(text).not.toContain(`${other}-1`);
        }
        // Never the parent's transcript — not the typed message, not the
        // `/review` verb it arrived under. What DOES reach a reviewer is the
        // focus, and only the focus: aiming the panel is deliberate
        // (ADR 0064), and the distinction is the point of asserting both.
        expect(text).not.toContain(PARENT_TEXT);
        expect(text).toContain(FOCUS);
        // And never another reviewer's prose.
        const mineToSay =
          name === A ? A_CONCERNS : name === B ? B_CONCERNS : C_CONCERNS;
        for (const concern of [...A_CONCERNS, ...B_CONCERNS, ...C_CONCERNS]) {
          if (mineToSay.includes(concern)) continue;
          expect(text).not.toContain(concern.message);
          expect(text).not.toContain(concern.anchor);
        }
      }
    }
  });

  it("persists exactly what the reviewers declared and the harness located", async () => {
    // The report is FROZEN: the annotations are the ledgers' own entries, with
    // their own words and their own severities, and nothing the driver decided
    // to add. An anchor that did not locate leaves the concern out and its
    // quote in the honesty record, verbatim — dropped and invented are
    // opposite failures and the record keeps them apart (ADR 0060 §2).
    const declared = [...A_CONCERNS, ...B_CONCERNS, ...C_CONCERNS];
    const cReport = ledgerOf([
      ...C_CONCERNS,
      {
        anchor: UNLOCATABLE,
        dimension: "clarity",
        severity: "info",
        message: "a concern whose quote is not in the manuscript",
      },
    ]);
    const { item } = await runMixedPanel({
      ...HEALTHY,
      // X5 (ADR 0074 §5): a dropped anchor now earns the seat its one
      // correction round, so this seat is asked twice. It answers with the
      // SAME report — a model that cannot find the passage again and repeats
      // itself — which is the branch where the first pass stands, its limits
      // final. What this test asserts is unchanged: the concerns that located
      // are persisted, and the quote that did not is in the honesty record.
      [C]: [{ text: cReport }, { text: cReport }],
    });
    const annotations = item?.result?.annotations ?? [];
    expect(annotations).toHaveLength(declared.length);
    for (const concern of declared) {
      const mine = annotations.find((a) => a.message === concern.message);
      expect(mine).toBeDefined();
      expect(mine?.dimension).toBe(concern.dimension);
      expect(mine?.severity).toBe(concern.severity);
      expect(mine?.blocking).toBe(concern.blocking);
    }
    // Nothing added: every persisted message was declared by some reviewer.
    for (const annotation of annotations) {
      expect(declared.map((c) => c.message)).toContain(annotation.message);
    }
    const dropped = limitsOf(item).flatMap((l) =>
      l.kind === "anchors_dropped" ? l.anchors : [],
    );
    expect(dropped.map((d) => d.anchor)).toContain(UNLOCATABLE);
    expect(dropped.every((d) => d.reason === "not_found")).toBe(true);
  });

  it("runs the cross-review last, over ids, with no reviewer's ledger in it", async () => {
    const { journal, item } = await runMixedPanel(HEALTHY);
    const last = journal[journal.length - 1];
    expect(last).toBeDefined();
    const text = bodyOf((last as Seen).request);
    // Last across BOTH adapters: a cross-review that started before a reviewer
    // settled would be reading a panel that had not finished disagreeing.
    expect(text).toContain("reviewers have each read");
    expect(
      journal.filter((s) =>
        bodyOf(s.request).includes("reviewers have each read"),
      ),
    ).toHaveLength(1);

    for (const annotation of item?.result?.annotations ?? []) {
      expect(text).toContain(annotation.id);
    }
    // The wire ledger's own KEYS never appear: the cross-review reads the
    // harness's located rows, not what a seat wrote. Asserted on the quoted
    // key rather than the bare word on purpose — one reviewer's message here
    // says "evidence", and a test that could not tell prose from a key would
    // pass for the wrong reason.
    expect(text).not.toContain('anchor\\"');
    expect(text).not.toContain('\\"evidence\\"');
    expect(text).not.toContain('\\"anchor\\"');
    for (const concern of [...A_CONCERNS, ...B_CONCERNS, ...C_CONCERNS]) {
      expect(text).not.toContain(concern.anchor);
    }
    expect(item?.result?.synthesis?.consensus).toHaveLength(1);
  });

  it("names a reviewer that never reported, and reads across the rest", async () => {
    // A panel silently short one reviewer would report a narrower review as a
    // whole one. `seat_missing` is the honesty record saying otherwise, and it
    // carries the reviewer that went missing — which is the only way a reader
    // can tell a two-reviewer panel from a three-reviewer panel that lost one.
    const { item } = await runMixedPanel({
      ...HEALTHY,
      [B]: [
        {
          text: ledgerOf(B_CONCERNS),
          failure: { message: "the provider refused", status: 500, times: 9 },
        },
      ],
      // The cross-review sees only the two reviewers that answered, so it can
      // only cite them. Scripting `HEALTHY`'s synthesis here would cite the
      // missing reviewer's id, `interpretSynthesis` would refuse the whole
      // cross-review as unresolvable, and every assertion below about what it
      // cited would hold vacuously over an empty list — passing while proving
      // the opposite of what this test is named for.
      synthesis: [{ text: SURVIVORS_SYNTHESIS }],
    });
    expect(item?.seats).toHaveLength(3);
    const seat = item?.seats.find((s) => s.reviewer === B);
    expect(seat?.status).toBe("failed");
    const missing = limitsOf(item).find(
      (l) => l.kind === "seat_missing" && l.reviewer === B,
    );
    expect(missing).toBeDefined();
    expect(missing?.kind === "seat_missing" && missing.reason).toBe("failed");

    // The panel still ran, over the two reviewers that answered.
    const annotations = item?.result?.annotations ?? [];
    expect(annotations.map((a) => a.reviewer).sort()).toEqual([A, C]);

    // And the cross-review actually happened — asserted before anything is
    // said about what it cited, because `synthesis` is `undefined` whenever
    // the harness refuses it and an absent cross-review would otherwise read
    // as a clean one.
    expect(limitsOf(item).some((l) => l.kind === "synthesis_missing")).toBe(
      false,
    );
    const cited = (item?.result?.synthesis?.consensus ?? []).flatMap(
      (e) => e.ids,
    );
    expect(cited).toHaveLength(2);
    for (const id of cited) {
      expect(annotations.map((a) => a.id)).toContain(id);
    }
    // Nothing of the missing reviewer's survives into the cross-review — not
    // its id, and not the concern it never got to report.
    expect(cited.some((id) => id.startsWith(B))).toBe(false);
    expect(annotations.some((a) => a.reviewer === B)).toBe(false);
  });
});

/** Every item kind the panel emits, so a stray `review` item cannot hide. */
const reviewItems = (items: readonly SessionItem[]): ReviewItem[] =>
  items.filter((i): i is ReviewItem => i.type === "review");

describe("stage gate claim 1 — the record a reader gets", () => {
  it("emits exactly one review item, and stamps every reviewer's model on it", async () => {
    const { result, item } = await runMixedPanel(HEALTHY);
    expect(reviewItems(result.items)).toHaveLength(1);
    expect(item?.seats.map((s) => [s.reviewer, s.model])).toEqual([
      [A, "model-x"],
      [B, "model-y"],
      [C, "model-x"],
    ]);
    // R5's hivemind measurement keys on exactly this, and it is the one thing
    // the cross-review is never told (ADR 0069 §6).
    expect(item?.seats.every((s) => s.model !== "")).toBe(true);
  });
});

describe("a failed seat says WHY (X5 O11, ADR 0074 §7)", () => {
  /** One panel where seat B dies the way the script says, and the two that
   *  answered still produce a cross-review over their own ids. */
  const panelWhereBDies = (failure: {
    message: string;
    status?: number;
    times: number;
  }) =>
    runMixedPanel({
      ...HEALTHY,
      [B]: [{ text: ledgerOf(B_CONCERNS), failure }],
      synthesis: [{ text: SURVIVORS_SYNTHESIS }],
    });

  const causeOf = (
    item: ReturnType<typeof reviewItems>[number] | undefined,
  ) => {
    const limit = limitsOf(item).find(
      (l) => l.kind === "seat_missing" && l.reviewer === B,
    );
    return limit?.kind === "seat_missing" ? limit.cause : undefined;
  };

  it("classes a provider overload as retryable, with the provider's own words", async () => {
    // The child's retry policy emitted `stream.retry_failed` after exhausting
    // its attempts — the class it decided WITH THE HTTP STATUS IN HAND.
    const { item } = await panelWhereBDies({
      message: "the provider refused",
      status: 500,
      times: 9,
    });
    expect(causeOf(item)?.class).toBe("retryable");
    expect(causeOf(item)?.message).toContain("the provider refused");
  });

  it("classes a credit-balance refusal as quota, not as a transient 400", async () => {
    // Anthropic's exhaustion arrives as a 400, which a status-only reading
    // would call `fatal`. The policy's `provider.quota` notice is what says
    // otherwise, and re-deriving the class from the message here would be the
    // driver second-guessing a decision made with better information.
    const { item } = await panelWhereBDies({
      message: "Your credit balance is too low to access the Anthropic API",
      status: 400,
      times: 9,
    });
    expect(causeOf(item)?.class).toBe("quota");
    expect(causeOf(item)?.message).toContain("credit balance");
  });

  it("classes a bad key as fatal — the class that emits no notice at all", async () => {
    const { item } = await panelWhereBDies({
      message: "invalid x-api-key",
      status: 401,
      times: 9,
    });
    expect(causeOf(item)?.class).toBe("fatal");
    expect(causeOf(item)?.message).toContain("invalid x-api-key");
  });

  it("gives an INTERRUPTED seat no cause — no provider said anything", async () => {
    const { item } = await runMixedPanel(HEALTHY);
    for (const limit of limitsOf(item)) {
      if (limit.kind !== "seat_missing") continue;
      if (limit.reason !== "failed") expect(limit.cause).toBeUndefined();
    }
  });

  it("gives a failed CROSS-REVIEW a cause too — the fourth child dies the same way", async () => {
    const { item } = await runMixedPanel({
      ...HEALTHY,
      synthesis: [
        {
          text: SURVIVORS_SYNTHESIS,
          failure: {
            message: "Your credit balance is too low",
            status: 400,
            times: 9,
          },
        },
      ],
    });
    const missing = limitsOf(item).find((l) => l.kind === "synthesis_missing");
    expect(missing).toBeDefined();
    expect(missing?.kind === "synthesis_missing" && missing.reason).toBe(
      "failed",
    );
    expect(missing?.kind === "synthesis_missing" && missing.cause?.class).toBe(
      "quota",
    );
  });
});

describe("the pre-run check is blind too (X5 O12)", () => {
  it("sends each binding a question that carries nothing about the panel", async () => {
    const { journal } = await runMixedPanel(HEALTHY);
    const checks = journal.filter(
      (seen) =>
        seen.request.messages.find((m) => m.role === "user")?.content ===
        PREFLIGHT_PROMPT,
    );
    // One per DISTINCT binding: the parent's, which two seats and the
    // cross-review share, and the second reviewer's own.
    expect(checks.map((c) => c.adapter).sort()).toEqual(["X", "Y"]);
    for (const check of checks) {
      const body = bodyOf(check.request);
      // The check runs before any seat exists, so there is nothing about a
      // seat for it to leak — but blindness is what this file proves, and a
      // request that reached a model is a request that has to be looked at.
      for (const name of REVIEWER_NAMES) expect(body).not.toContain(name);
      expect(body).not.toContain(PANEL_SKILL);
      expect(body).not.toContain("main.tex");
      expect(check.request.tools ?? []).toEqual([]);
    }
  });
});

/**
 * V1 (ADR 0076 §5, O8): the verifier is blind the same way a reviewer is, and
 * is a read-only child whose one skill is its own protocol.
 */
describe("the verifier is blind to models, and reads only the manuscript (V1 O8)", () => {
  /** The parent holds the literature and grep, so the verifier's narrowing is
   *  actually tested: read tools the parent holds, minus the literature. */
  function wideRegistry(): Map<ToolName, ToolExecutor> {
    const registry = readRegistry();
    for (const name of ["grep_project", "literature_search"] as const) {
      registry.set(name, {
        name,
        category: "retrieval",
        spec: { name, description: name, parameters: { type: "object" } },
        invoke: async () => ok({}),
      });
    }
    return registry;
  }

  const WITH_VERIFIER: Record<string, ScriptedTurn[]> = {
    ...HEALTHY,
    verifier: [
      {
        text: JSON.stringify({
          verifications: [`${A}-1`, `${B}-1`, `${C}-1`].map((id) => ({
            id,
            kind: "absence",
            outcome: "upheld",
          })),
        }),
      },
    ],
  };

  const toolNames = (request: GenerateRequest): string[] =>
    (request.tools ?? []).map((t) => t.name);

  it("carries no model id, no reviewer field, no focus and no transcript", async () => {
    const { journal, item } = await runMixedPanel(WITH_VERIFIER, {
      skills: [
        skill(PANEL_SKILL),
        skill(VERIFIER_SKILL),
        skill("related-work"),
      ],
      registry: wideRegistry(),
    });
    expect(item?.verification).toBe("completed");
    const mine = journal.filter((s) =>
      bodyOf(s.request).includes(VERIFIER_MARKER),
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const seen of mine) {
      const first = seen.request.messages.find((m) => m.role === "user");
      const brief = typeof first?.content === "string" ? first.content : "";
      // It checks what was said, never who said it or on what.
      expect(brief).not.toContain("model-x");
      expect(brief).not.toContain("model-y");
      expect(brief).not.toContain('"reviewer"');
      for (const name of REVIEWER_NAMES) {
        expect(brief).not.toContain(`\`${name}\``);
      }
      // The focus aimed the reviewers; it is not evidence.
      expect(brief).not.toContain(FOCUS);
      expect(brief).not.toContain(PARENT_TEXT);
      // No reviewer's wire ledger: the located rows, by id, only.
      expect(brief).not.toContain('"annotations"');
      expect(brief).not.toContain('"anchor"');
      for (const id of [`${A}-1`, `${B}-1`, `${C}-1`]) {
        expect(brief).toContain(id);
      }
    }
  });

  it("gets the parent's read tools without the literature, and only its own protocol", async () => {
    const { journal } = await runMixedPanel(WITH_VERIFIER, {
      skills: [
        skill(PANEL_SKILL),
        skill(VERIFIER_SKILL),
        skill("related-work"),
      ],
      registry: wideRegistry(),
    });
    const reviewer = journal.find((s) =>
      bodyOf(s.request).includes(`\`${A}\`, one of `),
    );
    // The reviewers DO get the literature — which is what makes its absence
    // from the verifier a narrowing, not an accident of the registry.
    expect(toolNames((reviewer as Seen).request)).toContain(
      "literature_search",
    );
    const verifier = journal.filter((s) =>
      bodyOf(s.request).includes(VERIFIER_MARKER),
    );
    for (const seen of verifier) {
      const names = toolNames(seen.request).filter((n) => n !== "load_skill");
      expect(names).not.toContain("literature_search");
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(VERIFIER_TOOLS as readonly string[]).toContain(name);
      }
      const body = bodyOf(seen.request);
      expect(body).toContain(`body of ${VERIFIER_SKILL}`);
      expect(body).not.toContain(`body of ${PANEL_SKILL}`);
    }
    // And the cross-review's tool set is still empty.
    const synthesis = journal.filter((s) =>
      bodyOf(s.request).includes("reviewers have each read"),
    );
    expect(synthesis).toHaveLength(1);
    expect(toolNames((synthesis[0] as Seen).request)).toEqual([]);
  });
});
