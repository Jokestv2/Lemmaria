import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SessionItem } from "@lemmaria/harness";
import { DEFAULT_TASK_BUDGET, ScriptedModelAdapter } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  formatEvalReport,
  runEvalTask,
  runFlagshipEval,
} from "../src/eval/run-eval.js";
import type { EvalOutcome } from "../src/eval/scenarios.js";
import {
  FLAGSHIP_SCENARIOS,
  codeTerms,
  groundNumerals,
  scenarioById,
} from "../src/eval/scenarios.js";
import { main } from "../src/main.js";

/**
 * A6 — the retained flagship eval driver. These run OFFLINE (`stub: true`):
 * they prove the driver wires the real `runSessionTask` to grants, tools, the
 * write path and the judges. What a live model does with the same prompts is
 * what the operator measures; that is deliberately not asserted here.
 */

const fixtures = fileURLToPath(
  new URL("./fixtures/flagship/", import.meta.url),
);
const paper = `${fixtures}paper`;
const codebase = `${fixtures}codebase`;
const results = `${fixtures}results`;

function collect(): { io: { log: (l: string) => void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { log: (l) => lines.push(l) }, lines };
}

/**
 * One applied edit carrying `content` — the corpus every judge check about what
 * the run wrote reads (the review round's F3).
 *
 * Hand-built rather than driven, because what is under test in the blocks below
 * is the judge's arithmetic over a transcript, not the transcript's making.
 */
function applied(content: string): SessionItem {
  return {
    id: "e1",
    type: "edit_proposal",
    policy: "ask",
    edits: [
      {
        file: "sections/method.tex",
        kind: "create",
        content,
        status: "applied",
      },
    ],
  } as SessionItem;
}

describe("lemmaria eval — flagship scenarios (A6)", () => {
  it("wires Methods-from-codebase end to end (stub: plumbing, not the model)", async () => {
    const scenario = scenarioById("methods-from-codebase");
    expect(scenario).toBeDefined();
    if (!scenario) return;
    const report = await runFlagshipEval({
      scenario,
      paperDir: paper,
      grants: new Map([["codebase", codebase]]),
      stub: true,
    });
    expect(report.status).toBe("completed");
    expect(report.verdict.pass, JSON.stringify(report.verdict.checks)).toBe(
      true,
    );
    // It really drove the loop, not a mock of it.
    expect(report.toolCalls).toBeGreaterThan(0);
  }, 30_000);

  it("wires Experiments-from-results, and the gitignored entries ARE disclosed", async () => {
    const scenario = scenarioById("experiments-from-results");
    expect(scenario).toBeDefined();
    if (!scenario) return;
    const report = await runFlagshipEval({
      scenario,
      paperDir: paper,
      grants: new Map([["results", results]]),
      stub: true,
    });
    expect(report.verdict.pass, JSON.stringify(report.verdict.checks)).toBe(
      true,
    );
    // This scenario is also A6's end-to-end guard for the exclusion counters:
    // the fixture's figures/ is gitignored, so the check below fails if the
    // counts stop reaching the tool result.
    const disclosure = report.verdict.checks.find((c) =>
      c.label.includes("hidden"),
    );
    expect(disclosure?.pass).toBe(true);
  }, 30_000);

  it("wires literature-research, and a degraded source IS reported honestly", async () => {
    const scenario = scenarioById("literature-research");
    expect(scenario).toBeDefined();
    if (!scenario) return;
    const report = await runFlagshipEval({
      scenario,
      paperDir: paper,
      grants: new Map(),
      stub: true,
    });
    expect(report.verdict.pass, JSON.stringify(report.verdict.checks)).toBe(
      true,
    );
  }, 30_000);

  it("never writes to the caller's paper directory", async () => {
    const before = await readFile(`${paper}/main.tex`, "utf8");
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) return;
    const report = await runFlagshipEval({
      scenario,
      paperDir: paper,
      grants: new Map([["codebase", codebase]]),
      stub: true,
    });
    expect(await readFile(`${paper}/main.tex`, "utf8")).toBe(before);
    // A passing run cleans its working copy up rather than leaking one per
    // scenario per test run (review, Important 6).
    expect(report.workDir).toBeUndefined();
  }, 30_000);

  it("never offers the model a way to execute anything (review, Critical 1)", async () => {
    // `runSessionTask` unions `run_script` into the allowlist whenever a
    // scriptHost + grants are present, ignoring `allowedTools` — so a driver
    // that passed an auto-approving scriptHost would let a live model run
    // arbitrary code with cwd = the operator's REAL granted directory, which
    // is never copied. The driver must therefore pass no scriptHost at all.
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) return;
    const src = await readFile(
      fileURLToPath(new URL("../src/eval/run-eval.ts", import.meta.url)),
      "utf8",
    );
    // A structural assertion, because the loop gives a caller no way to read
    // back its own allowlist: the offer is a side effect of passing the host.
    expect(src).not.toContain("scriptHost:");
    expect(src).not.toContain("spawnScript");
    // No scenario asks for it either, so nothing should want it back.
    for (const s of FLAGSHIP_SCENARIOS) {
      expect(s.tools).not.toContain("run_script");
    }
  });

  it("runEvalTask exposes the raw transcript and files, and leaves the work dir in place", async () => {
    const scenario = scenarioById("methods-from-codebase");
    expect(scenario).toBeDefined();
    if (!scenario) return;
    const task = await runEvalTask({
      scenario,
      paperDir: paper,
      grants: new Map([["codebase", codebase]]),
      stub: true,
    });
    try {
      expect(task.outcome.status).toBe("completed");
      expect(task.outcome.items.length).toBeGreaterThan(0);
      expect(task.outcome.files.size).toBeGreaterThan(0);
      // The CALLER owns cleanup, so the directory must still be here. This is
      // the contract difference from runFlagshipEval, which removes it on pass.
      expect(existsSync(task.workDir)).toBe(true);
    } finally {
      await rm(task.workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses to evaluate a scenario without the grant it needs", async () => {
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) return;
    // Silently evaluating a crippled task would produce a meaningless verdict.
    await expect(
      runFlagshipEval({
        scenario,
        paperDir: paper,
        grants: new Map(),
        stub: true,
      }),
    ).rejects.toThrow(/needs --grant codebase/);
  });
});

describe("the judges are not vacuous (A6)", () => {
  it("fails a run that produced nothing", () => {
    // The A5 lesson: a check that cannot fail is worse than no check. Every
    // scenario's judge must reject an empty outcome.
    for (const scenario of FLAGSHIP_SCENARIOS) {
      const verdict = scenario.judge({
        status: "completed",
        items: [],
        files: new Map(),
      });
      expect(verdict.pass, scenario.id).toBe(false);
    }
  });

  it("fails a run whose prose is not grounded in what it read", () => {
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) return;
    const verdict = scenario.judge({
      status: "completed",
      items: [
        {
          id: "t1",
          type: "tool_call",
          tool: "list_files",
          argsJson: JSON.stringify({ root: "codebase" }),
          status: "completed",
          resultJson: "{}",
        },
        // Long, fluent, and about nothing in the granted source. An APPLIED
        // EDIT, so the check fails because the prose is ungrounded rather than
        // merely because nothing was written (F3).
        applied("We did some things. ".repeat(30)),
      ],
      files: new Map(),
    });
    expect(verdict.pass).toBe(false);
    const grounding = verdict.checks.find((c) => c.label.includes("grounded"));
    expect(grounding?.pass).toBe(false);
  });

  it("fails a Methods draft that invented a citation key", () => {
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) return;
    const verdict = scenario.judge({
      status: "completed",
      items: [
        {
          id: "t1",
          type: "tool_call",
          tool: "read_span",
          argsJson: JSON.stringify({ root: "codebase" }),
          status: "completed",
          resultJson: "{}",
        },
        // An APPLIED EDIT, not a file in the working copy (F3): a paper that
        // already carried a `\cite` key would otherwise fail this check on a
        // run that wrote nothing, and a run that really did invent one would
        // pass it on a paper whose own keys are all legitimate.
        applied(
          `We train WidgetNet with AdamW \\cite{totallyMadeUp2024}. ${"padding ".repeat(30)}`,
        ),
      ],
      // The bibliography the key is absent FROM. Without one the check now
      // refuses to measure rather than passing (F11), so a test that means
      // "this key is invented" has to supply the thing it is invented against.
      files: new Map([["refs.bib", "@article{known2020, title={A}}"]]),
    });
    const citations = verdict.checks.find((c) => c.label.includes("citation"));
    expect(citations?.pass).toBe(false);
    expect(citations?.detail).toContain("totallyMadeUp2024");
  });
});

/**
 * The review round's **F3** and **F4**, on the `methods-from-codebase` judge.
 *
 * Both checks were measuring the wrong thing, and in the same way the
 * Experiments grounding check was before `1325522` re-grounded it — that commit
 * left this one behind. *"Wrote a substantial passage into the paper"* read
 * every text file in the working copy, so the flagship gate saw
 * `5661 chars written`, verdict pass, on a paper `git diff` showed to be
 * byte-identical. *"The prose is grounded in the source it read"* was
 * `/widgetnet|adamw|widgetset|gelu/i` — three of those four words belong to the
 * retired synthetic fixture, so on bring-your-own material, which is the entire
 * point of the gate this scenario serves, it degraded to *"did the model happen
 * to type AdamW"*, over a corpus that included the operator's own manuscript.
 */
describe("the Methods judge measures the run, not the paper (F3, F4)", () => {
  const scenario = scenarioById("methods-from-codebase");

  /** A completed read of the granted codebase, whose result IS the source. */
  const readCodebase = (source: string): SessionItem =>
    ({
      id: "t1",
      type: "tool_call",
      tool: "read_span",
      argsJson: JSON.stringify({ root: "codebase", file: "src/train.py" }),
      status: "completed",
      resultJson: JSON.stringify({ text: source }),
    }) as SessionItem;

  const judgeOf = (source: string, draft: string) => {
    if (!scenario) throw new Error("methods-from-codebase missing");
    return scenario.judge({
      status: "completed",
      items: [readCodebase(source), applied(draft)],
      files: new Map([["main.tex", "the paper as it arrived, untouched.\n"]]),
    });
  };

  it("grounds the prose in a codebase that is NOT the shipped fixture", () => {
    // The requirement F4 names: `tests/r5/3-live-flagship-gate/TEST.md` sends
    // the operator at this scenario with `--grant codebase=<their own repo>`,
    // and no word of the retired regex can be expected to appear in one.
    const verdict = judgeOf(
      "def build_optimizer(cfg):\n" +
        '    """AdamW, or SGD when hidden_dim < 256."""\n' +
        "    return GRUCell(cfg)\n",
      `We optimise with AdamW through build_optimizer, whose GRUCell update is selected whenever hidden_dim exceeds the configured threshold. ${"x".repeat(200)}`,
    );
    const grounding = verdict.checks.find((c) => c.label.includes("grounded"));
    expect(grounding?.pass, JSON.stringify(verdict.checks)).toBe(true);
    expect(grounding?.detail).toContain("code terms appear in the source");
  });

  it("fails prose whose terms are in no source the run read, and names them", () => {
    const verdict = judgeOf(
      'def build_optimizer(cfg):\n    """AdamW."""\n',
      `We train TransformerXL with LAMB at batch_size 4096 using RMSProp and a WarmupCosine schedule. ${"x".repeat(200)}`,
    );
    const grounding = verdict.checks.find((c) => c.label.includes("grounded"));
    expect(grounding?.pass).toBe(false);
    // The operator's spot-check shortlist, exactly as the Experiments check
    // gives one for figures.
    expect(grounding?.detail).toContain("not found:");
    expect(grounding?.detail).toContain("TransformerXL");
  });

  it("is not satisfied by ONE lucky term — the defect the old regex had", () => {
    const verdict = judgeOf(
      'def build_optimizer(cfg):\n    """AdamW."""\n',
      `We use AdamW. ${"Fluent prose about nothing in particular. ".repeat(12)}`,
    );
    expect(verdict.checks.find((c) => c.label.includes("grounded"))?.pass).toBe(
      false,
    );
  });

  it("takes code names out of LaTeX prose and leaves the author's keys alone", () => {
    // The candidate set is what the detail line shows the operator as their
    // spot-check shortlist, so markup in it is not cosmetic: `known2020` and
    // `eq:cost` are identifier-shaped and belong to the manuscript, and a
    // "not found in your codebase" list full of bibliography keys is noise.
    expect(
      codeTerms(
        String.raw`\section*{Method} at $3\times10^{-4}$ \cite{known2020,smith2019} \eqref{eq:cost}, we use AdamW and GRUCell`,
      ),
    ).toEqual(["AdamW", "GRUCell"]);
    expect(
      codeTerms(String.raw`\citep{roy2021efficient} — hidden_dim and Set2Set`),
    ).toEqual(["hidden_dim", "Set2Set"]);
    // A bracket note used to break the narrower `\citep{…}` match and drop the
    // key back onto the shortlist; one shared `CITE_RE` is what stops it.
    expect(
      codeTerms(
        String.raw`\citep[see][p.~4]{roy2021efficient} uses hidden_dim`,
      ),
    ).toEqual(["hidden_dim"]);
    // Notation the model INTRODUCED, not names it claims to have read: the
    // round-2 flagship run filled all six shortlist slots with these.
    expect(
      codeTerms(
        String.raw`The gate $W_1 h_v + W_2 h_u$ with $s_v$, $t_v$ feeds GRUCell`,
      ),
    ).toEqual(["GRUCell"]);
    // Ordinary English is never a candidate: an identifier is evidence on its
    // own, and a share of prose words overlapping would need a stopword list.
    expect(
      codeTerms("we train the model on the dataset for forty epochs"),
    ).toEqual([]);
  });

  it("does not let notation reach the floor, even when the code uses it too", () => {
    // The filter sits in the CANDIDATE set, so it moves the pass/fail
    // arithmetic and not only the operator's shortlist. This pins that
    // deliberately: a GNN codebase names its own variables `h_v` and `W_1`, so
    // all four notation terms here are genuinely IN the source, and counting
    // them would carry this passage over `GROUNDED_TERMS_FLOOR` on one real
    // name. A model writes `h_v` for a graph network whether or not it read
    // anything, which is the lucky-term defect wearing a subscript.
    const verdict = judgeOf(
      `def message(h_v, h_u):
    return W_1 @ h_v + W_2 @ h_u  # GRUCell update
`,
      `The gate $W_1 h_v + W_2 h_u$ drives the GRUCell update. ${"x".repeat(200)}`,
    );
    const grounding = verdict.checks.find((c) => c.label.includes("grounded"));
    expect(grounding?.pass, JSON.stringify(verdict.checks)).toBe(false);
    // 1/1, not 5/5: the notation left the denominator with the numerator.
    expect(grounding?.detail).toContain("1/1 code terms appear in the source");
    expect(grounding?.detail).toContain("GRUCell");
  });

  it("fails a run that wrote nothing into a paper full of its own text", () => {
    // F3's repro in miniature: the paper is long, the run wrote nothing, and the
    // check that exists to notice that used to report the paper's own size.
    if (!scenario) return;
    const verdict = scenario.judge({
      status: "completed",
      items: [readCodebase("def build_optimizer(cfg): pass\n")],
      files: new Map([
        ["main.tex", "A real manuscript, mentioning AdamW. ".repeat(60)],
      ]),
    });
    const passage = verdict.checks.find((c) =>
      c.label.includes("substantial passage"),
    );
    expect(passage?.pass).toBe(false);
    expect(passage?.detail).toBe("0 chars written");
    // Nor is the grounding check vacuously satisfied by the paper's own AdamW.
    expect(verdict.checks.find((c) => c.label.includes("grounded"))?.pass).toBe(
      false,
    );
  });
});

/**
 * The grounding check of `experiments-from-results`, on material that is NOT
 * the shipped fixture.
 *
 * The defect this pins: the check used to test the written prose against four
 * hardcoded literals out of `test/fixtures/flagship/results/metrics.csv`, so it
 * could only ever pass on that one directory — while
 * `tests/r5/3-live-flagship-gate/TEST.md` sends the operator at this scenario
 * with `--grant results=<their own results dir>`. It has to ground the prose in
 * whatever the run actually read, and a *derived* number (a delta, a rounded
 * or percentage form, a thousands-separated count) is honest prose, not a miss.
 */
const OTHER_RESULTS_CSV = [
  "model,split,roc_auc,ci_low,ci_high,n",
  "widgetnet,test,0.8470,0.8451,0.8492,986412",
  "baseline,test,0.8231,0.8210,0.8253,986412",
].join("\n");

function experimentsOutcome(prose: string): EvalOutcome {
  return {
    status: "completed",
    items: [
      {
        id: "t1",
        type: "tool_call",
        tool: "list_files",
        argsJson: JSON.stringify({ root: "results" }),
        status: "completed",
        resultJson: JSON.stringify({
          root: "results",
          files: ["metrics.csv"],
          excludedByGitignore: 1,
        }),
      },
      {
        id: "t2",
        type: "tool_call",
        tool: "read_span",
        argsJson: JSON.stringify({ root: "results", file: "metrics.csv" }),
        status: "completed",
        resultJson: JSON.stringify({
          root: "results",
          file: "metrics.csv",
          text: OTHER_RESULTS_CSV,
        }),
      },
      {
        id: "e1",
        type: "edit_proposal",
        policy: "auto_apply",
        edits: [
          {
            file: "sections/experiments.tex",
            kind: "create",
            content: prose,
            status: "applied",
          },
        ],
      },
    ],
    // The paper as it stands after the run: the section the agent wrote, plus
    // the manuscript it was already part of. Numbers that were in the paper
    // BEFORE the run are not what this scenario reports.
    files: new Map([
      ["sections/experiments.tex", prose],
      [
        "main.tex",
        "\\section{Introduction}\nOur earlier study reported 0.6613 on 51,204 examples in 2019.\n",
      ],
    ]),
  };
}

describe("experiments-from-results grounds metrics in the granted results dir", () => {
  const grounding = (outcome: EvalOutcome) => {
    const scenario = scenarioById("experiments-from-results");
    expect(scenario).toBeDefined();
    const verdict = scenario?.judge(outcome);
    const check = verdict?.checks.find((c) => c.label.includes("really in"));
    expect(check, JSON.stringify(verdict?.checks)).toBeDefined();
    return { verdict, check };
  };

  it("passes on a results directory that is not the shipped fixture", () => {
    // Every reported figure is out of OTHER_RESULTS_CSV, in one of the shapes
    // an honest report actually uses: verbatim, as a percentage, with a
    // thousands separator, and one legitimately derived delta (0.0239).
    const { verdict, check } = grounding(
      experimentsOutcome(
        `\\section*{Experiments}
On the held-out test split the model reaches a ROC-AUC of 0.8470
(95\\% CI 0.8451 to 0.8492), against 0.8231 for the baseline — an improvement of
0.0239, or 84.70\\% against 82.31\\%, over 986,412 test examples. Some entries in
the results directory are hidden from us by .gitignore, so the figures
accompanying these numbers could not be inspected.
`,
      ),
    );
    expect(check?.pass, check?.detail).toBe(true);
    expect(verdict?.pass, JSON.stringify(verdict?.checks)).toBe(true);
  });

  it("still fails prose whose numbers are in no file the run read", () => {
    // The check must stay non-vacuous: fluent, confident, and about numbers
    // that exist nowhere in the granted results.
    const { check } = grounding(
      experimentsOutcome(
        `\\section*{Experiments}
The model reaches an accuracy of 0.7312 and an F1 of 0.6620, against 0.5904 for
the baseline, over 12,345 held-out examples.
`,
      ),
    );
    expect(check?.pass).toBe(false);
  });

  it("does not credit numbers that were already in the paper", () => {
    // main.tex carries 0.6613 / 51,204 / 2019 and the results dir does not.
    // Grounding the whole paper directory instead of what the run WROTE is the
    // same defect wearing a different denominator.
    const { check } = grounding(
      experimentsOutcome(
        `\\section*{Experiments}
We reproduce the earlier figure of 0.6613 on 51,204 examples.
`,
      ),
    );
    expect(check?.pass).toBe(false);
  });
});

describe("groundNumerals — formatting is not fabrication", () => {
  const source = "roc_auc,ci_low,n\n0.8470,0.8451,986412\n";

  it("accepts the same figure written to fewer digits, or as a percent", () => {
    // 0.847 / 0.8470 / 84.7% are one number, three renderings.
    for (const written of ["0.8470", "0.847", "0.85", "84.70", "84.7"]) {
      const report = groundNumerals(`the score is ${written}`, source);
      expect(report.grounded, written).toBe(1);
    }
  });

  it("accepts a thousands-separated count", () => {
    expect(groundNumerals("over 986,412 examples", source).grounded).toBe(1);
  });

  it("ignores years, small counts and digits glued to a word", () => {
    // None of these is a reported measurement, so none may be held against
    // the writer — a year in a citation key least of all.
    const report = groundNumerals(
      "In 2019 we ran 40 epochs over 3 seeds \\cite{known2020}, Table 2.",
      source,
    );
    expect(report.reported).toBe(0);
  });

  it("does not let a percent rescaling truncate a source count into a match", () => {
    // 412031 / 100 is 4120.31, which rounds to 4120 — so an unscaled integer
    // would have grounded itself against the leading digits of an unrelated
    // count. A percentage is never a five-figure headcount, so the scalings
    // apply to fractional figures only.
    const counts = "n_train,n_test\n412031,986412\n";
    expect(groundNumerals("over 4120 examples", counts).grounded).toBe(0);
    expect(groundNumerals("over 9864 examples", counts).grounded).toBe(0);
    expect(groundNumerals("over 986,412 examples", counts).grounded).toBe(1);
  });

  it("reports a figure that is in no source file", () => {
    const report = groundNumerals("an accuracy of 0.7312", source);
    expect(report.grounded).toBe(0);
    expect(report.ungrounded).toContain("0.7312");
  });
});

describe("lemmaria eval — command surface (A6)", () => {
  it("reports usage and exits non-zero without required flags", async () => {
    const { io, lines } = collect();
    expect(await main(["eval"], io)).toBe(1);
    expect(lines.join("\n")).toContain("--scenario");
  });

  it("rejects an unknown scenario id", async () => {
    const { io, lines } = collect();
    expect(
      await main(["eval", "--scenario", "nope", "--paper", paper], io),
    ).toBe(1);
    expect(lines.join("\n")).toContain("unknown scenario");
  });

  it("rejects a malformed --grant", async () => {
    const { io, lines } = collect();
    const code = await main(
      [
        "eval",
        "--scenario",
        "methods-from-codebase",
        "--paper",
        paper,
        "--grant",
        "no-equals-sign",
        "--stub",
      ],
      io,
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("invalid --grant");
  });

  it("runs a scenario end to end and returns 0 with a PASS line", async () => {
    const { io, lines } = collect();
    const code = await main(
      [
        "eval",
        "--scenario",
        "methods-from-codebase",
        "--paper",
        paper,
        "--grant",
        `codebase=${codebase}`,
        "--stub",
      ],
      io,
    );
    expect(lines.join("\n")).toContain("PASS");
    expect(code).toBe(0);
  }, 30_000);

  it("--json emits a machine-readable report", async () => {
    const { io, lines } = collect();
    await main(
      [
        "eval",
        "--scenario",
        "literature-research",
        "--paper",
        paper,
        "--stub",
        "--json",
      ],
      io,
    );
    const parsed = JSON.parse(lines[lines.length - 1] ?? "[]") as Array<{
      scenario: string;
      verdict: { pass: boolean };
    }>;
    expect(parsed[0]?.scenario).toBe("literature-research");
    expect(typeof parsed[0]?.verdict.pass).toBe("boolean");
  }, 30_000);
});

/**
 * The review round's **F2**: the three `--max-*` flags could only ever LOWER
 * the budget.
 *
 * `runSessionTask` has two budget inputs — `budget`, an action's *request*,
 * which `resolveTaskBudget` clamps down from the ceiling and can never raise,
 * and `ceilings`, the authoritative per-field cap that raises or lowers the
 * default. The driver passed the flags as `budget`, so `--max-tool-calls 60`
 * resolved to `min(24, 60) = 24` and the gate's own `EVAL_USAGE` offer to
 * *"raise the budget for a large repo"* was unreachable. The tell was a
 * `budget.tool_calls` notice firing at 23 of a requested 60.
 *
 * It cost R5 its own live rows too: `planted-defects.live.test.ts` passes
 * `{maxOutputTokens: 24_000}` through this same option, and every recorded
 * panel ran at the default 16,000 — a 5,333-token carve per seat at N = 3, not
 * the 8,000 the test, the plan and ADR 0070 state.
 *
 * Invariant 5 is untouched: it governs what an *action* may request, and the
 * operator driving `lemmaria eval` is the user whose ceiling it clamps to.
 */
describe("the --max-* flags are ceilings, so they can raise (F2)", () => {
  /** `turns` turns of `perTurn` list_files calls each — enough to run out. */
  const busyModel = (turns: number, perTurn: number): ScriptedModelAdapter =>
    new ScriptedModelAdapter([
      ...Array.from({ length: turns }, (_, t) => ({
        toolCalls: Array.from({ length: perTurn }, (_, c) => ({
          id: `t${t}-c${c}`,
          name: "list_files" as const,
          args: {},
        })),
      })),
      { text: "done" },
    ]);

  const run = async (ceilings?: { maxToolCalls: number }) => {
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) throw new Error("methods-from-codebase missing");
    const task = await runEvalTask({
      scenario,
      paperDir: paper,
      grants: new Map([["codebase", codebase]]),
      stub: true,
      adapter: busyModel(10, 4),
      ...(ceilings ? { ceilings } : {}),
    });
    try {
      return {
        toolCalls: task.toolCalls,
        notices: task.outcome.items
          .filter((i) => i.type === "notice")
          .map((i) => (i.type === "notice" ? i.code : "")),
      };
    } finally {
      await rm(task.workDir, { recursive: true, force: true });
    }
  };

  it("stops at the default ceiling when no flag raises it", async () => {
    const { toolCalls, notices } = await run();
    expect(toolCalls).toBeLessThanOrEqual(DEFAULT_TASK_BUDGET.maxToolCalls);
    expect(notices).toContain("budget.tool_calls");
  }, 60_000);

  it("really runs past the default when the flag raises it", async () => {
    // The assertion that was impossible before the fix: more tool calls than
    // `DEFAULT_TASK_BUDGET.maxToolCalls` allows, because the operator said so.
    const { toolCalls } = await run({ maxToolCalls: 36 });
    expect(toolCalls).toBeGreaterThan(DEFAULT_TASK_BUDGET.maxToolCalls);
  }, 60_000);

  it("still lowers — a ceiling is a ceiling in both directions", async () => {
    const { toolCalls, notices } = await run({ maxToolCalls: 4 });
    expect(toolCalls).toBeLessThanOrEqual(4);
    expect(notices).toContain("budget.tool_calls");
  }, 60_000);
});

/**
 * The round-2 review's **F11** — the same defect as F4, in the check below it.
 *
 * *"Invented no citation key"* compared every key against the literal
 * `known2020`, the offline fixture's only bib key, with a pattern that matched
 * neither `\citep{}` nor `\citet{}`. The operator's own paper uses `\citep{}`
 * exclusively, so on the material this gate exists for the check inspected
 * nothing at all — and the three ways it was wrong are the three cases below.
 */
describe("the citation check reads a bibliography (F11)", () => {
  const scenario = scenarioById("methods-from-codebase");

  const REFS = [
    "@article{known2020, title={A Known Prior Work}, year={2020}}",
    "@inproceedings{perez2018film, title={FiLM}, year={2018}}",
  ].join("\n\n");

  // `null` rather than `undefined` for "no bibliography at all": an omitted
  // argument and an explicit `undefined` are the same thing to a default.
  const citations = (draft: string, bib: string | null = REFS) => {
    if (!scenario) throw new Error("methods-from-codebase missing");
    const verdict = scenario.judge({
      status: "completed",
      items: [
        {
          id: "t1",
          type: "tool_call",
          tool: "read_span",
          argsJson: JSON.stringify({ root: "codebase" }),
          status: "completed",
          resultJson: "{}",
        } as SessionItem,
        applied(`${draft} ${"padding ".repeat(30)}`),
      ],
      files: new Map([
        ["main.tex", "the paper as it arrived.\n"],
        ...(bib === null
          ? []
          : ([["refs.bib", bib]] as Array<[string, string]>)),
      ]),
    });
    return verdict.checks.find((c) => c.label.includes("citation"));
  };

  it("reads the capitalised natbib forms, where a sentence starts", () => {
    // `\Citep{}` opens a sentence in real natbib prose, which is where an
    // author capitalises and therefore where a case-sensitive pattern would
    // let a fabricated key through unseen.
    const ok = citations(
      String.raw`\Citep{known2020} and \Nocite{perez2018film}`,
    );
    expect(ok?.pass, JSON.stringify(ok)).toBe(true);
    expect(ok?.detail).toContain("2/2 cited key(s) are in the bibliography");
    const bad = citations(String.raw`\Citet{invented2099} claims otherwise`);
    expect(bad?.pass).toBe(false);
    expect(bad?.detail).toContain("invented2099");
  });

  it("passes a real key in the form the operator's paper actually uses", () => {
    // Round 1 "passed" this vacuously: `/\\cite{/` never saw a `\citep`.
    const check = citations(String.raw`as shown by \citep{perez2018film}`);
    expect(check?.pass, JSON.stringify(check)).toBe(true);
    expect(check?.detail).toContain("1/1 cited key(s) are in the bibliography");
  });

  it("fails a FABRICATED key in that same form", () => {
    // The false negative that mattered: the one thing this check exists to
    // catch, in the one form it could not see.
    const check = citations(
      String.raw`as shown by \citep{totally_invented_2099}`,
    );
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("not in the bibliography");
    expect(check?.detail).toContain("totally_invented_2099");
  });

  it("no longer fails a real key just because it is not the fixture's", () => {
    // The false POSITIVE: `\cite{perez2018film}` is honest and was failed.
    const check = citations(String.raw`following \cite{perez2018film}`);
    expect(check?.pass).toBe(true);
  });

  it("fails the fixture's own key when the paper's bibliography lacks it", () => {
    // The third direction: `known2020` passed unconditionally, including on a
    // paper whose bibliography has never heard of it.
    const check = citations(
      String.raw`following \citep{known2020}`,
      "@inproceedings{perez2018film, title={FiLM}}",
    );
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("known2020");
  });

  it("reads keys through natbib's pre/post notes, and multi-key lists", () => {
    expect(
      citations(String.raw`\citep[see][p.~4]{perez2018film, known2020}`)?.pass,
    ).toBe(true);
    expect(
      citations(String.raw`\citet{known2020} and \autocite{nope1999}`)?.pass,
    ).toBe(false);
  });

  it("says so when there is nothing to check, rather than ticking silently", () => {
    // Vacuity named in both directions — a green tick over an empty denominator
    // is this round's own I1.
    expect(citations("a Method section that cites nobody")?.detail).toBe(
      "no citation keys written",
    );
    const noBib = citations(String.raw`following \citep{perez2018film}`, null);
    expect(noBib?.pass).toBe(false);
    expect(noBib?.detail).toContain("unverifiable");
  });
});

/**
 * **F12** — the offline tier is offline BY CONSTRUCTION (ADR 0035), and this is
 * what checks that it is.
 *
 * `pnpm test` — the milestone gate — failed on any machine with no
 * `LEMMARIA_SMOKE_ANTHROPIC_KEY` exported, because the binding fell through to
 * `liveBinding()` whenever `stub` was false, including for the four tests that
 * inject a scripted panel and make no model call at all. The key was demanded,
 * never used, and its absence failed the build; the round's own `progress.md`
 * claim that "the gate ran green" held only inside a shell that had one.
 *
 * The latent half was worse: the literature seam built the four REAL scholarly
 * providers on the same condition, and `planted-defects` carries
 * `literature_search` — so a scripted panel that searched would have reached
 * Crossref and arXiv from inside the offline tier, no key needed.
 */
describe("an injected adapter needs neither a key nor the network (F12)", () => {
  const KEYS = [
    "LEMMARIA_SMOKE_ANTHROPIC_KEY",
    "LEMMARIA_SMOKE_OPENAI_KEY",
  ] as const;

  /** Both smoke keys gone for the duration of `body`, restored afterwards. */
  async function withNoKeys<T>(body: () => Promise<T>): Promise<T> {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const [k] of saved) delete process.env[k];
    try {
      return await body();
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  }

  it("runs a literature scenario with no key, against the stub sources", async () => {
    const scenario = scenarioById("literature-research");
    if (!scenario) throw new Error("literature-research missing");
    const task = await withNoKeys(() =>
      runEvalTask({
        scenario,
        paperDir: paper,
        grants: new Map(),
        // NOT `--stub`: this is exactly how the four R5 scenario tests run, and
        // the combination that used to throw for want of a key it never used.
        stub: false,
        adapter: new ScriptedModelAdapter([
          {
            toolCalls: [
              {
                id: "s1",
                name: "literature_search",
                args: { query: "widget representations" },
              },
            ],
          },
          { text: "one source answered; the others did not." },
        ]),
      }),
    );
    try {
      expect(task.outcome.status).toBe("completed");
      // The stub providers answer from `https://stub.invalid/...`, which is not
      // a host: a live provider set would have gone to the real endpoints.
      const search = task.outcome.items.find(
        (i) => i.type === "tool_call" && i.tool === "literature_search",
      );
      expect(JSON.stringify(search)).toContain("stub.invalid");
      // And `--stub`'s own precedence is untouched: the run reports the stub
      // binding rather than inventing a live model id.
      expect(task.model).toBe("claude-sonnet-4-5");
    } finally {
      await rm(task.workDir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * The review round's **I4** and **I6**, on the report an operator reads.
 *
 * I4: `runFlagshipEval` deleted the work dir whenever the verdict passed — and
 * an evidence scenario's verdict passes by construction whenever the task
 * completes, so the transcript of every *paid measurement* was destroyed and
 * only the runs that produced no number kept theirs.
 *
 * I6: a panel run printed `turns=0 tools=0` beside a real `out=` figure, and no
 * cost at all on the one path where the operator spends their own money.
 */
describe("an evidence run keeps its evidence, and says what it cost (I4, I6)", () => {
  it("prints the cost beside the output tokens when usage carries one", () => {
    const base = {
      scenario: "planted-defects",
      title: "t",
      model: "pin-x",
      status: "completed" as const,
      verdict: { pass: true, checks: [] },
      turns: 3,
      toolCalls: 7,
      notices: [],
    };
    expect(
      formatEvalReport({
        ...base,
        usage: { inputTokens: 10, outputTokens: 6396, costUsd: 0.075 },
      }),
    ).toContain("out=6396/$0.0750");
    // A model with no price is an explicit absence, never silence (N5): the
    // round-2 flagship panel printed `out=9129` and nothing else, which reads
    // identically to a run that was free.
    expect(
      formatEvalReport({
        ...base,
        usage: { inputTokens: 10, outputTokens: 6396 },
      }),
    ).toContain("out=6396/$unpriced");
  });

  it("keeps a passing flagship run's copy when the operator asked", async () => {
    // The gate's round 2: B2-B4 ask the operator to READ the Method section the
    // run wrote, and a passing run had already deleted it. `--stub` still
    // cleans up; every live run now keeps its evidence and prints the `rm -rf`.
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) return;
    const report = await runFlagshipEval({
      scenario,
      paperDir: paper,
      grants: new Map([["codebase", codebase]]),
      stub: true,
      keepWorkDir: true,
    });
    expect(report.verdict.pass).toBe(true);
    expect(report.workDir).toBeDefined();
    expect(formatEvalReport(report)).toContain("when done: rm -rf");
    if (report.workDir !== undefined) {
      expect(existsSync(report.workDir)).toBe(true);
      await rm(report.workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("still cleans up after a passing FLAGSHIP run", async () => {
    // The rule I4 narrows, not one it replaces: a green `pnpm test` must not
    // leak a copy of the paper per scenario.
    const scenario = scenarioById("methods-from-codebase");
    if (!scenario) return;
    const report = await runFlagshipEval({
      scenario,
      paperDir: paper,
      grants: new Map([["codebase", codebase]]),
      stub: true,
    });
    expect(report.verdict.pass).toBe(true);
    expect(report.workDir).toBeUndefined();
  }, 30_000);
});
