/**
 * R2, the **live** row of the milestone's tier table (ADR 0060).
 *
 * ## The question
 *
 * Every offline row proves the *harness* half: given a wire ledger, the parser
 * accepts what the contract allows, refuses what it forbids, and locates every
 * quote in the manuscript's own bytes. **None of them can prove a real model
 * can produce such a ledger** — and that is the milestone's actual claim: the
 * contract is one a model can honour *and* the harness can locate, over a whole
 * manuscript rather than a 24,000-character unit.
 *
 * That matters here more than it usually would, because the S5 spike's finding
 * was that a model asked for **positions** gets them wrong — three children of
 * one model placed the same scaffold at 109–119, 161–186 and 142–168 when it
 * sits at 167. R2's answer is to ask for *verbatim quotes* instead and locate
 * them. Whether a model's whole-file quotes are verbatim and unique is exactly
 * what no offline test can say, and reading a ledger to decide is the slow,
 * unreliable human task [ADR 0038](../../../../Lemmaria-design-doc/docs/adr/0038-report-by-exception-and-eyes-reasons.md)
 * §2 sends to the live tier.
 *
 * **No skill and no fan-out.** One parent, read-only, with the wire format
 * stated in full in the prompt. R3 owns the skill and the panel; this row
 * measures the format alone, so that R3's skill author starts from a number.
 *
 * ## What is reported
 *
 * The tally and the branch that held are logged **either way** (T2's rule that
 * a null result needs a name of its own or it borrows the name of a pass):
 *
 * - `ledger_located` — parsed, and at least one concern located.
 * - `ledger_empty` — a valid EMPTY ledger. Named so it cannot borrow a pass:
 *   the *no quota* branch is correct behaviour in general, but on THIS fixture
 *   it is a model finding, because all nine S5 seats found its two deliberately
 *   empty scaffolds.
 * - `ledger_all_dropped` — parsed, nothing located, ≥ 1 anchor dropped. The
 *   model wrote quotes the harness could not find or could find twice.
 * - `ledger_shape_failed` — the wire format is hard for this pin.
 * - `no_answer` — the task did not complete, or produced no agent message.
 *
 * The test **asserts `ledger_located` on each pin**, and a failure is a finding
 * reported beside the gate, never counted in it
 * ([ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md) §5).
 * A pin that only reaches `ledger_shape_failed` is handed to R3 as the number
 * its skill must be written against — it is R2's `BLOCKED` exit only if the
 * failure shows the wire FORMAT cannot be honoured at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { interpretLedger } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_BUDGET,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAPER = resolve(here, "fixtures/concern-ledger/paper");
const DEFAULT_FILE = "main.tex";

/**
 * 223 newline-terminated lines — one `read_span` covers it whole
 * (READ_SPAN_MAX_LINES is 300), which is what keeps the run inside the pins'
 * own turn budget. Counted the way `wc -l` counts, because the file ends with a
 * trailing newline and a naive `split("\n").length` is one more than that.
 */
const FIXTURE_LINES = 223;

const DIMENSIONS = ["soundness", "claims", "clarity", "positioning"];

/**
 * The wire format, stated in full. R3 will move this into a bundled skill in
 * both locales; here it is a prompt, so that what is measured is the FORMAT and
 * not a skill's phrasing of it.
 *
 * **The one-line rule is a measurement, not a hunch, and it is R2's headline
 * finding for R3.** The first version of this prompt said only *"quote a full
 * clause or sentence"*, which is what the plan's D4 anticipated a skill would
 * say. Both pins then honoured the wire format perfectly — valid JSON, evidence
 * present, `"missing"` emitted as a bare string, `blocking` only on majors —
 * and the harness located almost nothing: **7 of 8 claim anchors `not_found` on
 * the openai-compatible pin, 6 of 8 on anthropic**, with `ledger_all_dropped`
 * the outcome on both.
 *
 * The cause is not the model being loose. Its quotes were verbatim in
 * *content*; `main.tex` is hard-wrapped at ~75 columns, so a sentence spans
 * three or four source lines, and the model returned it joined up with spaces
 * where the file has newlines. Checked directly: two of the failing anchors
 * occur exactly **zero** times in the file and exactly **once** in the file
 * with whitespace flattened. The one anchor that did locate was a single-line
 * `% TODO(draft)` comment.
 *
 * This is a **prompt** finding, never a locator one. Loosening `locateAnchor`
 * to match across whitespace would be a supplied position wearing a
 * convenience's clothes — ADR 0060's whole point is that the harness reads the
 * manuscript's own bytes. So the instrument gains the instruction the source's
 * formatting requires, and both numbers go into the record: what a naive
 * *"quote a sentence"* costs, and what a line-aware one buys. R3's skill is
 * written from that pair.
 */
const SPEC: EvalTaskSpec = {
  id: "live-concern-ledger",
  prompt: [
    "Read this whole manuscript first, then review it and reply with ONLY a JSON concern ledger — no prose before or after.",
    "",
    'Shape: {"annotations": [{"dimension": "...", "severity": "info|minor|major", "anchor": "...", "message": "...", "evidence": "missing" | {"anchor": "..."}, "blocking": true}]}',
    "",
    "Rules:",
    `- "dimension" is one of: ${DIMENSIONS.join(", ")}.`,
    '- "anchor" is the passage the concern is ABOUT, copied VERBATIM from the manuscript — character for character, including its LaTeX markup.',
    "- The source is hard-wrapped: a sentence usually spans several lines. Quote ONE WHOLE LINE of the source, exactly as it appears, rather than a sentence you have joined up — a quote that silently turns a line break into a space matches nothing. Pick a line long enough to appear only once in the file.",
    '- "evidence" is REQUIRED on every concern: either an object whose "anchor" is a verbatim passage that supports or contradicts your claim — same one-line rule — or the literal string "missing" when the manuscript offers none.',
    '- "blocking" may be set ONLY on a "major" concern, and says whether the paper\'s central case fails without it. Omit it everywhere else.',
    "- Never write line numbers. Quote text; positions are not yours to supply.",
    "- If no grounded concern exists at some severity, report none — never invent one to fill a slot.",
    "- At most 8 concerns.",
  ].join("\n"),
  requiredGrants: [],
  tools: ["read_span", "get_outline", "list_files"],
};

/**
 * Two ceilings move, and the second one is a measurement rather than a guess.
 *
 * **Output tokens**, as planned: `LIVE_BUDGET`'s 4,096 would truncate a ledger
 * of eight concerns each carrying evidence, and a truncated answer shows up as
 * `ledger_shape_failed` with a JSON parse error — the wrong finding entirely.
 *
 * **Turns**, from the first live run — the plan's A17 predicted this failure
 * and authorised raising the number once, on the record. The plan reasoned that
 * 223 lines fit in one `read_span` (`READ_SPAN_MAX_LINES` is 300), so
 * `LIVE_BUDGET`'s 6 turns would be ample. They were not, and the reason is
 * *how* a model spends turns rather than how much it reads: the
 * openai-compatible pin spent turn 1 on `get_outline`, 2 on `list_files`, 3 on
 * `update_plan`, 4 reading all three files, 5 re-reading the tail of `main.tex`
 * and 6 on a second `update_plan` — and stopped on `budget.turns` having marked
 * its own plan complete, one turn short of writing the ledger it had already
 * composed. 270 output tokens across six turns: it was never close to the
 * output ceiling.
 *
 * So 10 turns / 16 tool calls — the six a planning parent actually spent, plus
 * room to answer and a little slack. Deliberately below R1's 12/20: this suite
 * runs at every gate, so per-run cost is a first-class constraint.
 */
const BUDGET = {
  maxTurns: LIVE_BUDGET.maxTurns + 4,
  maxToolCalls: LIVE_BUDGET.maxToolCalls + 4,
  maxOutputTokens: 6_000,
};

const PROVIDERS = [
  {
    label: "openai-compatible",
    protocol: "openai-compatible" as const,
    model: LIVE_OPENAI_MODEL,
    ready: liveOpenAIReady,
  },
  {
    label: "anthropic",
    protocol: "anthropic" as const,
    model: LIVE_ANTHROPIC_MODEL,
    ready: liveAnthropicReady,
  },
];

/** Every `.tex` under the fixture, keyed the way a seat would cite it. */
function manuscriptFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".tex")) {
        files.set(
          relative(PAPER, child).split(sep).join("/"),
          readFileSync(child, "utf8"),
        );
      }
    }
  };
  walk(PAPER);
  return files;
}

/** The last agent message — the seat's report, in R3's shape (ADR 0022 §2). */
function lastAgentMessage(
  items: readonly { type: string }[],
): string | undefined {
  let text: string | undefined;
  for (const item of items) {
    if (item.type !== "agent_message") continue;
    text = (item as unknown as { text?: string }).text;
  }
  return text;
}

type Outcome =
  | "ledger_located"
  | "ledger_empty"
  | "ledger_all_dropped"
  | "ledger_shape_failed"
  | "no_answer";

for (const provider of PROVIDERS) {
  describe.skipIf(!provider.ready())(
    `R2 live — a real model writes a ledger the harness locates over a whole file (${provider.label})`,
    () => {
      it("reaches ledger_located", async () => {
        const evidence = liveWorkDir();

        // A broken fixture is indistinguishable from a real regression at the
        // moment you are trying to tell them apart, so it fails HERE, loudly,
        // before any spend (the E1 pattern).
        const files = manuscriptFiles();
        expect(files.has(DEFAULT_FILE)).toBe(true);
        const main = files.get(DEFAULT_FILE) as string;
        expect(
          main.split("\n").filter((_, i, all) => i < all.length - 1),
        ).toHaveLength(FIXTURE_LINES);
        expect(main.endsWith("\n")).toBe(true);

        const task = await runEvalTask({
          scenario: SPEC,
          paperDir: PAPER,
          grants: new Map(),
          stub: false,
          readOnly: true,
          binding: liveBinding(provider.protocol, provider.model),
          ceilings: BUDGET,
        });
        evidence.track(task.workDir);

        const answer = lastAgentMessage(task.outcome.items);
        const ledger =
          answer === undefined
            ? undefined
            : interpretLedger({
                answer,
                reviewer: "panel",
                files,
                defaultFile: DEFAULT_FILE,
                allowedDimensions: DIMENSIONS,
                suggestEdits: false,
              });

        let outcome: Outcome;
        if (task.outcome.status !== "completed" || ledger === undefined) {
          outcome = "no_answer";
        } else if (ledger.failure !== undefined) {
          outcome = "ledger_shape_failed";
        } else if ((ledger.result?.annotations.length ?? 0) > 0) {
          outcome = "ledger_located";
        } else if ((ledger.result?.limits?.length ?? 0) > 0) {
          outcome = "ledger_all_dropped";
        } else {
          outcome = "ledger_empty";
        }

        // Reported either way — the question is what models DO. The drop tally
        // is broken out by role × reason because those are different findings
        // for R3's skill: `not_found` means the quote was not verbatim,
        // `ambiguous` means it was too short, `unknown_file` means the model
        // named a file that is not in the manuscript.
        const annotations = ledger?.result?.annotations ?? [];
        const drops = (ledger?.result?.limits ?? []).flatMap((l) =>
          l.kind === "anchors_dropped" ? l.anchors : [],
        );
        const dropTally = new Map<string, number>();
        for (const d of drops) {
          const key = `${d.role}/${d.reason}`;
          dropTally.set(key, (dropTally.get(key) ?? 0) + 1);
        }
        const majors = annotations.filter((a) => a.severity === "major");
        console.info(
          `[R2 live/${provider.label}] outcome=${outcome} located=${annotations.length} ` +
            `dropped=${drops.length}${
              drops.length > 0
                ? ` (${[...dropTally].map(([k, n]) => `${k}:${n}`).join(" ")})`
                : ""
            } ` +
            `majors=${majors.length} with-blocking=${
              majors.filter((a) => a.blocking !== undefined).length
            } ` +
            `evidence-located=${
              annotations.filter((a) => a.evidence?.kind === "span").length
            } evidence-missing=${
              annotations.filter((a) => a.evidence?.kind === "missing").length
            } ` +
            `turns=${task.turns} tool-calls=${task.toolCalls} ` +
            // An engine stop is why a `no_answer` happened, and without it the
            // branch name says only that nothing came back (A17's finding).
            `notices=${
              task.outcome.items
                .filter((i) => i.type === "notice")
                .map((i) => (i as unknown as { code: string }).code)
                .join(",") || "none"
            } ` +
            `usage=${task.usage?.outputTokens ?? "?"}out${
              task.usage?.costUsd === undefined
                ? ""
                : `/$${task.usage.costUsd.toFixed(4)}`
            }` +
            `${ledger?.failure ? ` failure=${JSON.stringify(ledger.failure)}` : ""}` +
            `${task.outcome.error ? ` error=${task.outcome.error}` : ""}`,
        );

        // THE assertion: the contract is one a real model can honour and the
        // harness can locate — over a whole manuscript, from verbatim quotes,
        // with no position ever supplied by the model.
        expect(outcome).toBe("ledger_located");

        await evidence.discard();
      });
    },
  );
}
