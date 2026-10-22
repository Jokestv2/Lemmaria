/**
 * R5 (O5, O7, and O8's half of the promise): the measurement reaches the panel
 * through the retained eval driver, and says nothing it should not.
 *
 * The live rows drive exactly this path, so the seam is asserted OFFLINE with a
 * scripted panel — a seam whose only test costs real money is a seam nobody
 * re-checks (T2's rule, ADR 0043 §D7). What is under test here is the wiring:
 * the scenario resolves, the manifest reaches the judge, the recall lines come
 * out of it, `--scenario all` is still the three flagships, and — the one that
 * would silently invalidate every number R5 takes — the workspace the reviewers
 * read carries **neither the manifest nor the clean twin**.
 */
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelStreamEvent,
  ReviewItem,
  Skill,
} from "@lemmaria/harness";
import {
  PANEL_SKILL,
  VERIFIER_BRIEF_MARKER,
  VERIFIER_SKILL,
  listSkills,
} from "@lemmaria/harness";
import { bundledSkillsDir } from "@lemmaria/harness/bundled-skills";
import { afterEach, describe, expect, it } from "vitest";
import { evalCommand } from "../../src/eval/command.js";
import { readManifest } from "../../src/eval/recall.js";
import {
  formatEvalReport,
  runEvalTask,
  runFlagshipEval,
} from "../../src/eval/run-eval.js";
import {
  EVIDENCE_SCENARIOS,
  FLAGSHIP_SCENARIOS,
  classifyPanel,
  scenarioById,
} from "../../src/eval/scenarios.js";
import {
  formatVerificationReport,
  measureVerification,
} from "../../src/eval/verification.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../live/fixtures/planted-defects");
const PAPER = resolve(FIXTURE, "paper");

const PROTOCOL: Skill = {
  name: PANEL_SKILL,
  description: "the panel protocol",
  body: "quote one whole line",
  source: "bundled",
  path: `/skills/${PANEL_SKILL}/SKILL.md`,
  references: [],
};

/**
 * A scripted panel that hits exactly three of the sixteen — one of them
 * through its EVIDENCE pointer rather than its claim.
 *
 * The anchors are the manifest's own, so the harness locates them in the copy's
 * bytes and the spans that come back are the ones `matchDefects` is asked
 * about. Two reviewers contribute, which is what `panel_located` needs and what
 * gives the cross-review two different reviewers to cite.
 */
class PanelAdapter implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  constructor(
    private readonly ledgers: Map<string, string>,
    /** `unparseable`: every seat answers with something that is not a ledger,
     *  which is what a dead key or an exhausted account looks like from the
     *  driver's side — the `panel_unparsed` I1 is about. */
    private readonly how: {
      unparseable?: boolean;
      /** V1: how the verifier answers its brief. Default: uphold every id. */
      verify?: (brief: string) => string;
    } = {},
  ) {}

  /** Every request this adapter answered, for the tests that count them. */
  readonly requests: GenerateRequest[] = [];

  private answer(request: GenerateRequest): string {
    this.requests.push(request);
    if (this.how.unparseable === true) return "I could not review this paper.";
    const first = request.messages.find((m) => m.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    // V1 (ADR 0076 §5): the verifier, keyed by its brief's marker sentence.
    // Its default UPHOLDS every id it is handed, built from the request.
    if (text.includes(VERIFIER_MARKER)) {
      return (this.how.verify ?? upholdEvery)(text);
    }
    for (const [key, body] of this.ledgers) {
      if (text.includes(key)) return body;
    }
    return '{"annotations": [], "impressions": {}}';
  }

  private done(request: GenerateRequest): GenerateResult {
    return {
      text: this.answer(request),
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve(this.done(request));
  }

  async *generateStream(
    request: GenerateRequest,
  ): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed", result: this.done(request) };
  }
}

/** The sentence every verifier brief opens its prose with (V1). */
const VERIFIER_MARKER = VERIFIER_BRIEF_MARKER;

/** The concern ids a verifier brief hands its child, read from its JSON. */
function idsIn(brief: string): string[] {
  const line = brief
    .split(String.fromCharCode(10))
    .find((l) => l.startsWith('{"concerns":'));
  if (line === undefined) return [];
  return (JSON.parse(line) as { concerns: Array<{ id: string }> }).concerns.map(
    (c) => c.id,
  );
}

const upholdEvery = (brief: string): string =>
  JSON.stringify({
    verifications: idsIn(brief).map((id) => ({
      id,
      kind: "absence",
      outcome: "upheld",
    })),
  });

/** The verifier's protocol, as an offered skill. */
const VERIFIER: Skill = {
  name: VERIFIER_SKILL,
  description: "the verifier protocol",
  body: "start from the concern standing",
  source: "bundled",
  path: `/skills/${VERIFIER_SKILL}/SKILL.md`,
  references: [],
};

/** The ledger a reviewer returns, built from the manifest's own anchors. */
function ledger(
  entries: Array<{ anchor: string; evidence: string; dimension?: string }>,
): string {
  return JSON.stringify({
    impressions: {},
    annotations: entries.map((e, i) => ({
      dimension: e.dimension ?? "soundness",
      severity: "major",
      anchor: e.anchor,
      // The ledger's evidence is an OBJECT with its own verbatim anchor, or
      // the literal "missing" — never a bare quote (ADR 0060 §D2).
      evidence: { anchor: e.evidence },
      message: `concern ${i + 1}`,
    })),
  });
}

async function scriptedPanel(
  verify?: (brief: string) => string,
): Promise<PanelAdapter> {
  const manifest = await readManifest(resolve(FIXTURE, "defects.json"));
  const spanOf = (id: string): string => {
    const defect = manifest.defects.find((d) => d.id === id);
    if (defect === undefined) throw new Error(`no defect ${id}`);
    return defect.spans[0]?.anchor as string;
  };
  const elsewhere =
    "Corridor Attention keeps Equation~\\eqref{eq:dense} exactly as it is and";
  const unperturbed =
    "We take a third position, which we think is the pragmatic one: keep attention";
  return new PanelAdapter(
    new Map([
      [
        "`reviewer_a`, one of",
        ledger([
          { anchor: spanOf("S1"), evidence: spanOf("S1") },
          { anchor: spanOf("C2"), evidence: spanOf("C2") },
          // Anchored away from the defect, cited ON it: the evidence pointer
          // is what makes this a hit (ADR 0070 §2).
          { anchor: elsewhere, evidence: spanOf("R3") },
        ]),
      ],
      [
        "`reviewer_b`, one of",
        ledger([
          { anchor: spanOf("S1"), evidence: spanOf("S1") },
          // Lands on a planted defect under a dimension the gate does not
          // admit: a style note on a missing-case proof is not a detection of
          // it, so S2 stays missed and the concern shows up as a span-only hit.
          {
            anchor: spanOf("S2"),
            evidence: spanOf("S2"),
            dimension: "language",
          },
          // Lands nowhere near ground truth: this is what `unmatched` counts,
          // and what keeps a panel that flags everything visible.
          { anchor: unperturbed, evidence: unperturbed },
        ]),
      ],
      [
        "reviewers have each read",
        JSON.stringify({
          consensus: [
            {
              ids: ["reviewer_a-1", "reviewer_b-1"],
              note: "both raise the crossover",
            },
          ],
          disagreements: [],
        }),
      ],
    ]),
    verify ? { verify } : {},
  );
}

const trash: string[] = [];
afterEach(async () => {
  for (const dir of trash.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("R5 O5 — the scenario, through the driver", () => {
  it("is resolvable by id, and stays out of --scenario all", () => {
    // `all` spends three flagship tasks; an evidence run spends a whole panel,
    // and sweeping it in would make the flagship gate silently more expensive.
    expect(scenarioById("planted-defects")?.title).toBe(
      "Planted-defect recall of the review panel",
    );
    // X5 (ADR 0074 §10): two evidence scenarios now — the same measurement on
    // a flat paper and on the same paper cut into `\input`-ed files. NEITHER
    // is in `all`, which is the property this test is really about, and
    // `all` expands to `FLAGSHIP_SCENARIOS` so it holds by construction.
    for (const id of ["planted-defects", "planted-defects-split"]) {
      expect(FLAGSHIP_SCENARIOS.map((s) => s.id)).not.toContain(id);
    }
    expect(EVIDENCE_SCENARIOS.map((s) => s.id)).toEqual([
      "planted-defects",
      "planted-defects-split",
    ]);
    expect(scenarioById("planted-defects")?.readOnly).toBe(true);
    expect(scenarioById("planted-defects")?.bundledSkills).toBe(true);
  });

  it("reports the recall of a panel that found three of the sixteen", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const report = await runFlagshipEval({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL],
      adapter: await scriptedPanel(),
      manifest: await readManifest(resolve(FIXTURE, "defects.json")),
    });
    if (report.workDir !== undefined) trash.push(report.workDir);

    const text = formatEvalReport(report);
    expect(text).toContain("recall overall: 3/16");
    expect(text).toContain("recall surface: 1/4");
    expect(text).toContain("recall claim: 1/4");
    expect(text).toContain("recall reasoning: 1/4");
    expect(text).toContain("recall experimental: 0/4");
    expect(text).toContain("panel outcome: panel_located");
    expect(text).toContain("unmatched concerns: 1");
    expect(text).toContain("span-only hits: 1");
    expect(text).toContain("agreement same-model=");
    // Every recall line passes by construction: the number is reported, never
    // gated (ADR 0070 §5). What fails is the run not happening.
    expect(report.verdict.pass).toBe(true);

    // **I4** — the evidence survives its own measurement. This rule used to be
    // "delete the work dir on a pass", and an evidence run's verdict passes by
    // construction whenever the task completes, so the transcript of every PAID
    // measurement was destroyed and only the runs that produced no number kept
    // theirs. A 14/16 could then not be audited after the fact.
    expect(report.workDir).toBeDefined();
    expect(existsSync(report.workDir as string)).toBe(true);
    expect(text).toContain("work dir:");

    // **I6** — a panel's work is its seats', and the outer session takes no
    // turn of its own, so the header says `n/a` rather than printing two zeros
    // beside a real `out=` figure.
    expect(report.delegated).toBe(true);
    const head = text.split("\n")[0] ?? "";
    expect(head).toContain("turns=n/a tools=n/a");
    expect(head).not.toContain("turns=0");

    // The attribution that makes the figure auditable at all: which concern
    // earned which hit, on the line that carries the number.
    expect(text).toMatch(/credited \w+:/);

    // The **anchor location rate, per seat**, on the CLI path. `lemmaria eval`
    // is the only command that can reach a flagship, and it reported a
    // flagship's recall and nothing about its quoting — so the review round's
    // Judge question 1, "a cheap model quotes badly" against "models quote
    // badly", could not be put to a flagship at all. `formatRecallReport` had
    // built this line for the live tier since R5 and nothing else printed it.
    expect(text).toContain("anchors located:");
    expect(text).toMatch(/reviewer_a@[^=]+=\d+loc\/\d+drop/);
    expect(text).toContain("found:");
  });

  /**
   * **I1** — a panel whose every seat is missing is UNMEASURED, not 0/16.
   *
   * The driving documents tell the operator three times to record
   * `panel_unparsed` as unmeasured and never as a recall of zero, and the
   * instrument printed exactly the number they forbid: a full table of four
   * `0/4` categories, `overall: 0/16`, all sixteen ids under `missed:`, every
   * line ticked green, at exit 0, on a run that never reached a model. The
   * judge computed `classifyPanel` one line above and never consulted it.
   */
  it("refuses to report a recall when no seat produced a ledger", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const report = await runFlagshipEval({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL],
      // Every seat answers with something that is not a ledger, which is what a
      // dead key, a revoked model or an exhausted account looks like from here.
      adapter: new PanelAdapter(new Map(), { unparseable: true }),
      manifest: await readManifest(resolve(FIXTURE, "defects.json")),
    });
    if (report.workDir !== undefined) trash.push(report.workDir);
    const text = formatEvalReport(report);
    expect(text).toContain("panel outcome: panel_unparsed");
    expect(text).toContain("recall: unmeasured");
    // None of the four figures an operator would otherwise copy into a ledger.
    expect(text).not.toContain("recall overall:");
    expect(text).not.toContain("recall surface:");
    expect(text).not.toContain("missed S1");
    // And it does NOT exit 0: a PASS line over a fabricated zero is the one
    // route to the outcome the driving documents forbid.
    expect(report.verdict.pass).toBe(false);
  });

  it("reports zeros rather than failing when the panel finds nothing", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const report = await runFlagshipEval({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL],
      adapter: new PanelAdapter(new Map()),
      manifest: await readManifest(resolve(FIXTURE, "defects.json")),
    });
    if (report.workDir !== undefined) trash.push(report.workDir);
    const text = formatEvalReport(report);
    expect(text).toContain("recall overall: 0/16");
    expect(text).toContain("panel outcome: panel_empty");
    expect(report.verdict.pass).toBe(true);
  });

  it("hands the reviewers a workspace with no manifest and no clean twin", async () => {
    // THE assertion of this file. `runEvalTask` copies `paperDir` whole into
    // the directory the seats read with `list_files` / `read_span`, so a
    // manifest inside `paper/` would hand the panel its own answer key and
    // every recall R5 ever takes would be meaningless (ADR 0070 §3).
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL],
      adapter: await scriptedPanel(),
    });
    trash.push(task.workDir);

    expect([...task.outcome.files.keys()].sort()).toEqual([
      "PAPER.md",
      "main.tex",
      "refs.bib",
    ]);
    const copied = await readdir(resolve(task.workDir, "paper"));
    expect(copied).not.toContain("defects.json");
    expect(copied).not.toContain("clean");

    const item = task.outcome.items.find(
      (i): i is ReviewItem => i.type === "review",
    );
    expect(classifyPanel(item)).toBe("panel_located");
    // A review never writes (invariant 3): the copy is byte-identical to the
    // fixture it came from.
    expect(task.outcome.files.get("main.tex")).toContain(
      "n^{*} = \\frac{2 k b^{2}}{2 b^{2} + 1} ,",
    );
  });
});

describe("R5 O7 — the --stub dry run, and the refusal without ground truth", () => {
  it("runs offline, loads the shipped skill, and prints the zero report", async () => {
    const lines: string[] = [];
    const code = await evalCommand(
      ["--scenario", "planted-defects", "--paper", PAPER, "--stub"],
      { log: (line) => lines.push(line) },
    );
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("PASS");
    expect(text).toContain("planted-defects");
    expect(text).toContain("recall overall: 0/16");
    expect(text).toContain("panel outcome: panel_empty");
    // The bundled protocol really loaded — a `review.skill_missing` notice is
    // the panel saying it could not equip its seats, and a dry run that says
    // nothing about the wiring is worth nothing.
    expect(text).not.toContain("review.skill_missing");
  });

  it("refuses, with the usage line, when the manifest is not where it looked", async () => {
    const lines: string[] = [];
    const code = await evalCommand(
      [
        "--scenario",
        "planted-defects",
        // `blind-panel/paper` has no `../defects.json`.
        "--paper",
        resolve(here, "../live/fixtures/blind-panel/paper"),
        "--stub",
      ],
      { log: (line) => lines.push(line) },
    );
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("needs its defect manifest");
    expect(text).toContain("usage: lemmaria eval");
  });

  it("takes the manifest from --defects when the operator names one", async () => {
    const lines: string[] = [];
    const code = await evalCommand(
      [
        "--scenario",
        "planted-defects",
        "--paper",
        resolve(here, "../live/fixtures/blind-panel/paper"),
        "--defects",
        resolve(FIXTURE, "defects.json"),
        "--stub",
      ],
      { log: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("recall overall: 0/16");
  });

  it("names the evidence scenario in its usage text, apart from `all`", async () => {
    const lines: string[] = [];
    const code = await evalCommand(
      ["--scenario", "nonesuch", "--paper", PAPER],
      {
        log: (line) => lines.push(line),
      },
    );
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("evidence:  planted-defects");
    expect(text).toContain("--defects <path>");
    expect(text).toContain("--scenario all, which is those three");
  });
});

/**
 * V1 (ADR 0076 §5, O26): the verifier's role reaches the panel through the
 * retained eval driver — the seam the live tier drives.
 */
describe("V1 O26 — the verifier, through the eval driver", () => {
  /** A whole, unique line of the planted paper — the passage a scripted
   *  verifier quotes to withdraw a concern. */
  const ANSWER =
    "We take a third position, which we think is the pragmatic one: keep attention";

  const reviewOf = (items: readonly { type: string }[]) =>
    items.find((i): i is ReviewItem => i.type === "review");

  it("binds the verifier's own adapter, and only the verifier's requests reach it", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const verifierAdapter = new PanelAdapter(new Map());
    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL, VERIFIER],
      adapter: await scriptedPanel(),
      verifier: {
        protocol: "anthropic",
        endpoint: "https://api.anthropic.com",
        model: "verifier-model",
        apiKey: "k",
      },
      verifierAdapter,
    });
    trash.push(task.workDir);
    const item = reviewOf(task.outcome.items);
    expect(item?.verification).toBe("completed");
    expect(item?.verifierSeat?.model).toBe("verifier-model");
    const briefs = verifierAdapter.requests.map((r) => {
      const first = r.messages.find((m) => m.role === "user");
      return typeof first?.content === "string" ? first.content : "";
    });
    // Its own pre-run check, then the verifier — and no reviewer, ever.
    expect(briefs.some((b) => b.includes(VERIFIER_MARKER))).toBe(true);
    expect(briefs.some((b) => b.includes("one of 3 independent"))).toBe(false);
  });

  it("carries Off to the panel, which then asks nothing of a verifier", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const adapter = await scriptedPanel();
    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL, VERIFIER],
      adapter,
      verifier: "off",
    });
    trash.push(task.workDir);
    const item = reviewOf(task.outcome.items);
    expect(item?.verification).toBe("off");
    expect(item?.result?.limits).toContainEqual({
      kind: "verification_missing",
      reason: "off",
    });
    expect(
      adapter.requests.some((r) =>
        JSON.stringify(r.messages).includes(VERIFIER_MARKER),
      ),
    ).toBe(false);
  });

  it("a scripted verifier's withdrawals reach the panel, and the report, through the real driver", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL, VERIFIER],
      adapter: await scriptedPanel((brief) =>
        JSON.stringify({
          verifications: idsIn(brief).map((id) =>
            id === "reviewer_a-1" || id === "reviewer_a-2"
              ? {
                  id,
                  kind: "absence",
                  outcome: "refuted",
                  counter: { anchor: ANSWER },
                }
              : { id, kind: "absence", outcome: "upheld" },
          ),
        }),
      ),
    });
    trash.push(task.workDir);
    const item = reviewOf(task.outcome.items);
    const withdrawn = item?.result?.annotations.find(
      (a) => a.id === "reviewer_a-1",
    );
    expect(withdrawn?.verification?.outcome).toBe("refuted");
    expect(withdrawn?.verification?.counter?.file).toBe("main.tex");
    expect(item?.verifierSeat?.verification?.refuted).toBe(2);

    // The instrument reads the same record (plan D12). reviewer_a-1 sat on
    // S1, which reviewer_b-1 still credits, so S1 survives the withdrawal;
    // reviewer_a-2 was C2's only finder, so C2 is what verification cost.
    if (item === undefined) throw new Error("no review item");
    const manifest = await readManifest(resolve(FIXTURE, "defects.json"));
    const report = measureVerification(item, manifest);
    expect(report.ran).toBe(true);
    expect(report.tally?.refuted).toBe(2);
    expect(report.before.hits.map((h) => h.defect)).toEqual(["S1", "C2", "R3"]);
    expect(report.lost).toEqual(["C2"]);
    expect(report.after.hits.find((h) => h.defect === "S1")?.ids).toEqual([
      "reviewer_b-1",
    ]);
    expect(formatVerificationReport(report)).toContain(
      "lost to verification: C2",
    );
  });

  it("the --stub scenario locates nothing, so verification is skipped and no verifier seat is recorded", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const { skills } = await listSkills({ bundledDir: bundledSkillsDir() });
    // The shipped set really carries the verifier's protocol — so `skipped`
    // below is the empty ledgers speaking, not a missing skill.
    expect(skills.map((s) => s.name)).toContain(VERIFIER_SKILL);
    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      skills,
    });
    trash.push(task.workDir);
    const item = reviewOf(task.outcome.items);
    expect(item?.status).toBe("completed");
    expect(item?.verification).toBe("skipped");
    expect(item?.verifierSeat).toBeUndefined();
  });
});

/**
 * V5 (D15, O18): the `--stub` run drives strengths and impressions end to end
 * — every scripted seat files the same strength and an impression per
 * dimension (the seats stream concurrently, so one of three is not
 * addressable; `stub-script.ts` says why) — and the judge prints the derived
 * card on two lines beside recall, levels apart from impressions.
 */
describe("V5 O18 — the --stub run carries a strength and the impressions", () => {
  const reviewOf = (items: readonly { type: string }[]) =>
    items.find((i): i is ReviewItem => i.type === "review");

  it("locates each seat's strength, records seven assessments per seat, and re-asks nobody", async () => {
    const scenario = scenarioById("planted-defects");
    if (scenario === undefined) throw new Error("scenario missing");
    const { skills } = await listSkills({ bundledDir: bundledSkillsDir() });
    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      skills,
    });
    trash.push(task.workDir);
    const item = reviewOf(task.outcome.items);
    expect(item?.status).toBe("completed");
    const seats = item?.seats ?? [];
    expect(seats).toHaveLength(3);
    const strengths = item?.result?.strengths ?? [];
    expect(strengths.map((s) => s.reviewer).sort()).toEqual(
      seats.map((s) => s.reviewer).sort(),
    );
    for (const s of strengths) {
      expect(s).toMatchObject({
        id: `${s.reviewer}-s1`,
        dimension: "clarity",
        span: { file: "main.tex", line: 29 },
      });
    }
    const assessments = item?.result?.assessments ?? [];
    for (const seat of seats) {
      const mine = assessments.filter((a) => a.reviewer === seat.reviewer);
      expect(mine, seat.reviewer).toHaveLength(7);
      expect(
        mine.every((a) => Number.isInteger(a.impression)),
        seat.reviewer,
      ).toBe(true);
      // A present block and a located strength: nothing to re-ask.
      expect(seat.retried, seat.reviewer).not.toBe(true);
      expect(seat.ledger?.strengths).toMatchObject({ entries: 1, located: 1 });
    }
    expect(
      (item?.result?.limits ?? []).filter((l) => l.kind === "strengths_lost"),
    ).toEqual([]);
  });

  it("prints the scorecard and impressions lines, and still passes", async () => {
    const lines: string[] = [];
    const code = await evalCommand(
      ["--scenario", "planted-defects", "--paper", PAPER, "--stub"],
      { log: (line) => lines.push(line) },
    );
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("PASS");
    expect(text).toMatch(/scorecard: soundness=\S+ claims=\S+/);
    // The one strength, and no concern: clarity is a level-4 row, unchecked.
    expect(text).toContain("clarity=4:unchecked");
    expect(text).toMatch(
      /impressions: soundness=5\.0 claims=4\.0 clarity=7\.0/,
    );
    expect(text).not.toMatch(
      /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i,
    );
  });
});
