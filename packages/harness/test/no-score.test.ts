import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReviewAnnotation } from "../src/contracts/index.js";
import { deriveScorecard } from "../src/engine/scorecard.js";

/**
 * The stage's *no score* claim, as a guard rather than a promise — re-scoped
 * by V5 (ADR 0087 §6).
 *
 * **Lemmaria asks for no number for the whole paper and no acceptance
 * verdict.** Per-dimension levels are computed by the harness from located
 * concerns; a reviewer's per-dimension impression is asked for on an anchored
 * scale and drives nothing. A number for the whole paper invites comparison
 * across papers it was never calibrated for, and the moment one exists it is
 * the only part anyone reads. (The v0.3 sentence this replaces — *never asks
 * a model to rate a paper* — became false when the impression was asked for,
 * so it is withdrawn rather than left standing.)
 *
 * **The re-scope narrows nothing the guard tests:** the word list below is
 * whole and unedited, and the scope only grows. The guard is over the surfaces
 * a model actually receives — the bundled actions and Writing Skills, the
 * agentic system prompt, the panel's briefs and interpreter feedback — plus
 * the contracts that shape what a review may say back and the derivation that
 * turns it into a scorecard, which a structural case below holds to *no number
 * for the whole paper*.
 *
 * The match is WHOLE-WORD and case-insensitive on purpose: a substring search
 * hits "ope*rating*-system" in prompt.ts and would have to be muzzled with an
 * allowlist, which is the thing this guard must not have. There is no
 * allowlist, and adding one would be the defect, not the fix.
 */

const HARNESS_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every file under `path` (a file or a directory), recursively. */
function filesUnder(path: string): string[] {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

const SCOPE = [
  "actions",
  "skills",
  "src/session/prompt.ts",
  "src/contracts/data.ts",
  // R3 (ADR 0061): the panel driver holds every model-facing string the review
  // panel emits — the seat briefs, the synthesis brief, and the interpreter
  // feedback fed back inside a seat's loop. A guard over the skills and the
  // envelope prompt that did not cover it would miss the surface a seat
  // actually reads.
  "src/session/review-panel.ts",
  // V1 (ADR 0076): the verifier's interpreter feedback and its brief are
  // model-facing text a verifier child reads, so the guard follows them into
  // the two files that hold them. Widening a deny-by-default guard is always
  // allowed; narrowing it is not.
  "src/engine/verification.ts",
  "src/session/review-verifier.ts",
  // V4 (ADR 0081): the PDF facts sentence is model-facing — the PDF reviewer
  // reads it in its brief — and it states numbers, which is exactly where a
  // judging word would creep in.
  "src/engine/pdf-facts.ts",
  // …and the PDF reviewer's brief, which carries those facts to the seat.
  "src/session/review-pdf-seat.ts",
  // V5 (ADR 0087 §6): the derivation that turns a ledger into a scorecard,
  // the span rule it groups issues by, and the interpreter — which holds every
  // feedback sentence a seat reads, including the impression lines, and which
  // the v0.3 guard never covered. Widening only.
  "src/engine/scorecard.ts",
  "src/engine/review-spans.ts",
  "src/engine/review.ts",
];

const BANNED =
  /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;

describe("no number for the whole paper, and no acceptance verdict (the stage gate, re-scoped by ADR 0087)", () => {
  it("no banned word reaches a model, a contract or the derivation", () => {
    const hits: string[] = [];
    for (const entry of SCOPE) {
      for (const file of filesUnder(join(HARNESS_ROOT, entry))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (BANNED.test(line)) {
            hits.push(
              `${file.slice(HARNESS_ROOT.length)}:${i + 1}: ${line.trim()}`,
            );
          }
        });
      }
    }
    // Printed, not merely counted: a hit is read and judged, and the fix is to
    // remove it or to narrow the scope to what the stage gate names — never to
    // add an allowlist.
    expect(hits, `banned words found:\n${hits.join("\n")}`).toEqual([]);
  });

  it("actually reads the files it claims to guard", () => {
    // A guard whose scope silently resolved to nothing would pass forever.
    for (const entry of SCOPE) {
      expect(
        filesUnder(join(HARNESS_ROOT, entry)).length,
        entry,
      ).toBeGreaterThan(0);
    }
    expect(BANNED.test("we report a score for each paper")).toBe(true);
    // The substring trap this guard is written around.
    expect(BANNED.test("the operating-system layer")).toBe(false);
  });
});

/**
 * V5 (ADR 0087 §6): *no numeric field for the whole paper*, made into a test
 * rather than a promise. A card is derived from a constructed panel that
 * exercises every standing, and every number in it is walked: each must be a
 * level (1–4), an impression (1–10, or null), or a count — of distinct
 * issues, of strengths, or (the root's one number) of dimensions not
 * assessed. The readiness word carries no number at all.
 */
describe("a derived scorecard holds no number for the whole paper (V5, ADR 0087 §6)", () => {
  const concern = (
    reviewer: string,
    n: number,
    dimension: string,
    severity: ReviewAnnotation["severity"],
    line: number,
    blocking = false,
  ): ReviewAnnotation => ({
    id: `${reviewer}-${n}`,
    reviewer,
    dimension,
    severity,
    span: { file: "main.tex", line },
    message: "m",
    ...(blocking ? { blocking: true } : {}),
    verification: { outcome: "upheld", kind: "judgment" },
  });
  const seat = (reviewer: string, answered: number) => ({
    reviewer,
    status: "completed" as const,
    model: "m",
    ledger: { entries: 1, located: 1, relocated: 0, dropped: 0, rejected: 0 },
    searches: { attempted: 1, answered },
  });
  const card = deriveScorecard({
    result: {
      annotations: [
        concern("reviewer_a", 1, "soundness", "major", 3, true),
        concern("reviewer_b", 1, "claims", "major", 4),
        concern("reviewer_b", 2, "clarity", "minor", 5),
        concern("reviewer_c", 1, "language", "info", 6),
      ],
      strengths: [
        {
          id: "reviewer_a-s1",
          reviewer: "reviewer_a",
          dimension: "significance",
          span: { file: "main.tex", line: 7 },
          message: "m",
        },
      ],
      assessments: [
        { reviewer: "reviewer_a", dimension: "soundness", impression: 3 },
        { reviewer: "reviewer_b", dimension: "soundness", impression: 6 },
        { reviewer: "reviewer_c", dimension: "clarity", impression: 9 },
      ],
    },
    seats: [
      seat("reviewer_a", 0),
      seat("reviewer_b", 0),
      seat("reviewer_c", 0),
    ],
    verifierSeat: { reviewer: "verifier", status: "completed", model: "m" },
  });

  it("has exactly the four root keys, and the readiness word is one of five", () => {
    expect(Object.keys(card).sort()).toEqual([
      "dimensions",
      "notAssessed",
      "panel",
      "readiness",
    ]);
    expect(["blocking", "major", "minor", "none", "not_assessed"]).toContain(
      card.readiness.label,
    );
    // The readiness word carries no number, and the root's one number is a
    // count of dimensions — never a figure for the paper.
    for (const value of Object.values(card.readiness)) {
      expect(typeof value).not.toBe("number");
    }
    const rootNumbers = Object.entries(card).filter(
      ([, value]) => typeof value === "number",
    );
    expect(rootNumbers.map(([key]) => key)).toEqual(["notAssessed"]);
    expect(Number.isInteger(card.notAssessed)).toBe(true);
    expect(card.notAssessed).toBeGreaterThanOrEqual(0);
    expect(card.notAssessed).toBeLessThanOrEqual(card.dimensions.length);
  });

  it("every number under a dimension is a level, an impression or a count", () => {
    const seen: string[] = [];
    const walk = (value: unknown, path: string[]): void => {
      if (typeof value === "number") {
        const key = path[path.length - 1] ?? "";
        const where = path.join(".");
        seen.push(where);
        if (key === "level") {
          expect([1, 2, 3, 4], where).toContain(value);
        } else if (key === "impression") {
          expect(value, where).toBeGreaterThanOrEqual(1);
          expect(value, where).toBeLessThanOrEqual(10);
        } else if (path.includes("issues") || key === "strengths") {
          expect(Number.isInteger(value) && value >= 0, where).toBe(true);
        } else {
          throw new Error(`a number no rule admits: ${where} = ${value}`);
        }
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
      }
    };
    walk(card.dimensions, ["dimensions"]);
    walk(card.panel, ["panel"]);
    // The walk reached every kind it admits, so it was not vacuous.
    expect(seen.some((p) => p.endsWith(".level"))).toBe(true);
    expect(seen.some((p) => p.endsWith(".impression"))).toBe(true);
    expect(seen.some((p) => p.includes(".issues."))).toBe(true);
  });
});
