/**
 * V5, the **live** rows of the milestone's tier table (plan D16, L1–L5 —
 * ADR 0087).
 *
 * ## The question
 *
 * A scorecard is a view of the ledger: a level per dimension computed from
 * what located, and each reviewer's impression riding beside it, driving
 * nothing. Whether that view means anything is three questions, each a
 * comparison between panels on versions of one paper
 * (`fixtures/scorecard/`):
 *
 * - **sensitivity** — does the planted twin stand lower than the clean one on
 *   `soundness` and `claims`, where the sixteen defects live, and not on
 *   `clarity`, where none does?
 * - **test–retest** — how far does one twin's reading move between two runs
 *   of the same panel?
 * - **laundering** — does rephrasing every prose line, and changing nothing
 *   the defects are made of, move the reading? The bet is that the level holds
 *   (it rests on what located) while the impression moves (it rests on what a
 *   reviewer felt) — so levels and impressions are printed apart throughout.
 *
 * ## Reported, never asserted
 *
 * Every level, impression and movement is printed, and none is gated (ADR
 * 0035 §5, ADR 0070 §5): a threshold on a model that moves under its own
 * version is a flake generator. There is **no before** — the first scorecard
 * reading is the floor. What IS asserted is L5, structural and over every run:
 * the reading was measured at all; every strength's span is a real line of
 * the twin it was filed on (a bounds check — the record keeps a span, not the
 * quote, so L5 cannot re-locate it; the locator already did, at parse time);
 * every impression is an integer 1–10 or `null`;
 * every contributing reviewer holds exactly seven assessments; every
 * `strengths_lost` names a seat of the panel; no seat answered more searches
 * than it attempted; the printed report carries no `%` and no banned word; and
 * R3's `assertHonesty` holds.
 *
 * ## The rows
 *
 * Per pin, each twin twice — `L1` planted, `L2` clean, `L3` laundered, runs 1
 * and 2 — then `L4`, the three comparisons, over whatever ran. The suffix is
 * the pin, as the tier table names it: `L1a` … `L4a` the openai pin, `L1b` …
 * `L4b` the anthropic one. Each run is one `it`, so `retry: 1` re-spends one
 * panel and not six.
 *
 * ## Cost
 *
 * Plan estimate: ≈ US$0.15–0.30 a run with the verifier on and the raised
 * ceilings, ≈ $1–2 for the file on one pin. **A run over US$0.60 halts the
 * file**: it is printed, and every later run skips rather than spending.
 * **Measured at the V5 gate:** US$0.82 for the file inside the whole
 * `pnpm test:live`, US$0.93 narrowed — twelve runs from US$0.1085 to
 * US$0.1800, 91–148 s each; no run came near the stop line.
 *
 * ## Readings (the V5 gate, 2026-09-28 — the first scorecard readings, a floor)
 *
 * Openai pin (`gpt-5.6-luna`), read twice: once inside the whole
 * `pnpm test:live`, once narrowed to this file. Twelve runs, all measured; L5
 * held on every one. The `re-asked:` line was added before the second reading.
 *
 * - **Levels saturate at 1 where the defects live.** `soundness` and `claims`
 *   read level 1 (blocking) on all twelve runs of all three twins, so the
 *   planted twin stands lower than the clean one on them in **0 of 4** run
 *   pairs; `positioning` reads 1 on ten of twelve. `clarity` moves between 1
 *   and 4 from run to run of one twin (lower on planted in 1 of 4 pairs).
 *   Readiness read *blocking* on all twelve; its `checked` flag flipped with
 *   whether any strength-only row existed (see the OPEN question on it).
 * - **The impression separates what the level does not.** The median on
 *   `clarity` read 7.0 on the clean twin and 6.0 on the planted one in **4 of
 *   4** pairs; on `soundness`, clean 3.0 against planted 2.0 in 3 of 4. It
 *   bunches: every median fell between 2.0 and 8.0, no seat wrote 1, 9 or 10,
 *   and `soundness` read 2–3 on every seat of every run.
 * - **Test–retest:** the saturated rows held in every retest; `clarity`,
 *   `positioning`, `originality` and `significance` each moved a level in at
 *   least one of six retests, and impression medians moved by at most 1.0
 *   except once (2.0, `significance`).
 * - **Laundering:** `soundness` and `claims` held level 1 and their impression
 *   medians held or moved by 1.0 in 4 of 4 pairs; `clarity`'s level improved
 *   a step in **4 of 4** pairs while its impression held or moved by 1.0.
 * - **Strengths and searches:** 38 and 33 strengths located per reading
 *   (1–4 a seat), 3 lost in all — every one on the laundered twin; every seat
 *   answered every search it ran (3–8 each) despite 6–13 `source_unavailable`
 *   entries a run, so `no_literature` was never imposed. In the second
 *   reading **every seat was re-asked** (18 of 18), as A27 predicted; the
 *   record does not say for which line.
 * - anthropic pin: **not measured — pin disabled** (`LEMMARIA_SMOKE_ANTHROPIC_ENABLED`
 *   unset; [open-questions.md](../../../../Lemmaria-design-doc/docs/open-questions.md)
 *   → *DEFERRED*). Its rows are written, typechecked and skipped.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelBinding, Protocol, ReviewItem } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { runEvalTask } from "../../src/eval/run-eval.js";
import { scenarioById } from "../../src/eval/scenarios.js";
import {
  type ScorecardReading,
  compareReadings,
  formatComparison,
  formatScorecardReport,
  formatSeatReadings,
  measureScorecard,
} from "../../src/eval/scorecard.js";
import {
  RAISED_CEILINGS,
  assertHonesty,
  liveBinding,
  panelProtocol,
} from "./panel-rows.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const TWINS_DIR = resolve(here, "fixtures/scorecard");
const TAG = "V5 live";

const TWINS = ["planted", "clean", "laundered"] as const;
type Twin = (typeof TWINS)[number];
const ROW: Record<Twin, string> = {
  planted: "L1",
  clean: "L2",
  laundered: "L3",
};
const RUNS = [1, 2] as const;

/** The plan's stop line: one run past it halts every later run. */
const RUN_CEILING_USD = 0.6;

/** The harness guard's word list (`no-score.test.ts`), whole-word. */
const BANNED =
  /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;

const PINS = [
  {
    label: "openai",
    row: "a",
    protocol: "openai-compatible" as Protocol,
    model: LIVE_OPENAI_MODEL,
    ready: liveOpenAIReady,
  },
  {
    label: "anthropic",
    row: "b",
    protocol: "anthropic" as Protocol,
    model: LIVE_ANTHROPIC_MODEL,
    ready: liveAnthropicReady,
  },
];

/** A twin's own shape, checked before any spend. */
function checkTwin(dir: string): void {
  expect(readdirSync(dir).sort()).toEqual(["PAPER.md", "main.tex", "refs.bib"]);
}

/** L5, over one run: what the record must hold, whatever the model said. */
function assertStructure(
  label: string,
  item: ReviewItem | undefined,
  reading: ScorecardReading,
  dir: string,
  printed: string,
): void {
  // The precondition for reading anything, as `panel_located` is R3's.
  expect(reading.measured, `${label}: measured`).toBe(true);
  const result = item?.result;
  const seats = item?.seats ?? [];
  const names = new Set(seats.map((s) => s.reviewer));

  // Every strength's span is a real line of the twin it was filed on —
  // bounds-checked against the fixture's bytes, not the record's word. A
  // span-only record keeps no quote, so this is not a re-location.
  for (const s of result?.strengths ?? []) {
    const lines = readFileSync(resolve(dir, s.span.file), "utf8").split("\n");
    expect(s.span.line, `${label} ${s.id}`).toBeGreaterThanOrEqual(1);
    expect(
      s.span.endLine ?? s.span.line,
      `${label} ${s.id}`,
    ).toBeLessThanOrEqual(lines.length);
  }

  // Every impression is an integer 1–10 or null, and every contributing
  // reviewer holds exactly the seven its brief asked for.
  for (const a of result?.assessments ?? []) {
    if (a.impression !== null) {
      expect(Number.isInteger(a.impression), `${label} ${a.reviewer}`).toBe(
        true,
      );
      expect(a.impression).toBeGreaterThanOrEqual(1);
      expect(a.impression).toBeLessThanOrEqual(10);
    }
  }
  for (const { reviewer } of reading.card?.panel.reviewers ?? []) {
    expect(
      (result?.assessments ?? []).filter((a) => a.reviewer === reviewer),
      `${label} ${reviewer}: seven assessments`,
    ).toHaveLength(7);
  }

  // Every lost strength names a seat of this panel.
  for (const l of result?.limits ?? []) {
    if (l.kind === "strengths_lost") {
      expect(names.has(l.reviewer), `${label} ${l.reviewer}`).toBe(true);
    }
  }

  // No seat answered more searches than it attempted.
  for (const seat of seats) {
    if (seat.searches !== undefined) {
      expect(
        seat.searches.answered,
        `${label} ${seat.reviewer}`,
      ).toBeLessThanOrEqual(seat.searches.attempted);
    }
  }

  // What is printed stays inside the stage's vocabulary.
  expect(printed).not.toContain("%");
  expect(printed).not.toMatch(BANNED);
}

for (const pin of PINS) {
  describe.skipIf(!pin.ready())(
    `V5 live — the scorecard on three twins (${pin.label})`,
    () => {
      const readings = new Map<string, ScorecardReading>();
      let halted: string | undefined;

      for (const twin of TWINS) {
        for (const run of RUNS) {
          it(`${ROW[twin]}${pin.row} — the ${twin} twin, run ${run}`, async (ctx) => {
            if (halted !== undefined) {
              console.info(
                `[${TAG}/${pin.label}] ${twin}#${run} skipped — ${halted}`,
              );
              ctx.skip();
            }
            const dir = resolve(TWINS_DIR, twin);
            checkTwin(dir);
            const scenario = scenarioById("planted-defects");
            if (scenario === undefined) throw new Error("scenario missing");
            const binding: ModelBinding = liveBinding(pin.protocol, pin.model);
            const evidence = liveWorkDir();
            const started = Date.now();
            const task = await runEvalTask({
              scenario,
              paperDir: dir,
              grants: new Map(),
              stub: false,
              readOnly: true,
              skills: await panelProtocol(),
              binding,
              ceilings: RAISED_CEILINGS,
              // D16: three reviewers, the cross-review and the verifier all
              // on the pin's model; the PDF reviewer off (no PDF ships).
              reviewers: [binding, binding, binding],
              synthesis: binding,
              verifier: binding,
              pdfReviewer: "off",
            });
            evidence.track(task.workDir);
            const item = task.outcome.items.find(
              (i): i is ReviewItem => i.type === "review",
            );
            const reading = item
              ? measureScorecard(item)
              : { measured: false, perSeat: [] };
            const cost = task.usage?.costUsd;
            const label = `${ROW[twin]}${pin.row}/${pin.label}/${twin}#${run}`;
            const printed = [
              formatScorecardReport(reading),
              formatSeatReadings(reading),
              // A27: whether a seat spent its one re-ask — under Option 2 an
              // absent `impressions` block does, on its own.
              `  re-asked: ${
                (item?.seats ?? [])
                  .map(
                    (s) => `${s.reviewer}=${s.retried === true ? "yes" : "no"}`,
                  )
                  .join(" ") || "none"
              }`,
            ].join("\n");
            console.info(
              `[${TAG}/${label}] status=${item?.status ?? "none"} ` +
                `verifier=${item?.verification ?? "?"} ` +
                `wall=${((Date.now() - started) / 1000).toFixed(1)}s ` +
                `cost=${cost === undefined ? "unknown" : `$${cost.toFixed(4)}`}`,
            );
            console.info(`[${TAG}/${label}]\n${printed}`);
            if (cost !== undefined && cost > RUN_CEILING_USD) {
              halted = `${label} cost $${cost.toFixed(4)}, over the $${RUN_CEILING_USD.toFixed(2)} stop line`;
              console.warn(`[${TAG}] HALT — ${halted}; stop and report`);
            } else if (cost === undefined) {
              // An unpriced model: the stop line cannot be read, so say so
              // loudly rather than let the file spend past it unseen.
              console.warn(
                `[${TAG}] WARNING — ${label} has no cost; the $${RUN_CEILING_USD.toFixed(2)} stop line cannot be checked, so read the provider's bill before a second run`,
              );
            }
            assertStructure(label, item, reading, dir, printed);
            assertHonesty(TAG, item, label, dir);
            readings.set(`${twin}#${run}`, reading);
            await evidence.discard();
          });
        }
      }

      it(`L4${pin.row} — the readings compared: sensitivity, test–retest, laundering`, () => {
        const of = (twin: Twin, run: number) => readings.get(`${twin}#${run}`);
        const say = (line: string) =>
          console.info(`[${TAG}/L4${pin.row}/${pin.label}] ${line}`);
        const compare = (
          a: ScorecardReading | undefined,
          b: ScorecardReading | undefined,
          label: string,
        ) => {
          if (a === undefined || b === undefined) {
            say(`${label}: not measured — a run did not complete`);
            return undefined;
          }
          const c = compareReadings(a, b, label);
          for (const line of formatComparison(c).split("\n")) say(line);
          return c;
        };

        // Sensitivity: clean → planted, per run pair. "Lower" is the
        // delta's own order (1 < 2 < 3 < nothing raised < 4).
        const pairs = RUNS.map((run) =>
          compare(
            of("clean", run),
            of("planted", run),
            `clean→planted run ${run}`,
          ),
        );
        for (const dimension of ["soundness", "claims", "clarity"]) {
          const lower = pairs.filter(
            (c) =>
              c?.dimensions.find((d) => d.dimension === dimension)?.standing
                .change === "worsened",
          ).length;
          const read = pairs.filter((c) => c !== undefined).length;
          say(
            `sensitivity ${dimension}: planted stands lower than clean in ${lower} of ${read} run pair(s) read`,
          );
        }

        // Test–retest: each twin's two runs.
        for (const twin of TWINS)
          compare(of(twin, 1), of(twin, 2), `${twin} retest`);

        // Laundering: planted → laundered, per run pair.
        for (const run of RUNS) {
          compare(
            of("planted", run),
            of("laundered", run),
            `planted→laundered run ${run}`,
          );
        }

        if (halted !== undefined) say(`halted — ${halted}`);
        // Nothing here is a floor; the comparison is the reading.
        expect(readings.size).toBeLessThanOrEqual(TWINS.length * RUNS.length);
      });
    },
  );
}
