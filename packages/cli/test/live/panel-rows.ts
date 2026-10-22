/**
 * The machinery a planted-defect live row needs, shared by both fixtures
 * (X5, ADR 0074 §10).
 *
 * X5 adds a second fixture — the flat paper cut into `\input`-ed files — and
 * the two exist **to be compared**. Copying `runPanel`, `report` and
 * `assertHonesty` into the second file would make that comparison a comparison
 * of two reporters as much as of two layouts: a fix to one printer, or a new
 * count added to one tally, would silently change what one row measures and
 * not the other. So they live here once and are parameterised by the fixture.
 *
 * Nothing here asserts a number. Every recall, located-rate and agreement
 * figure is **reported** ([ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md) §5);
 * what `assertHonesty` asserts is that the panel *said* what it could not do,
 * which is a structural claim and holds whatever the models answer.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  ModelBinding,
  ReviewItem,
  ReviewLimit,
  Skill,
} from "@lemmaria/harness";
import {
  PANEL_SKILL,
  describeWrapping,
  listSkills,
  manuscriptTitle,
  sameTitle,
} from "@lemmaria/harness";
import { bundledSkillsDir } from "@lemmaria/harness/bundled-skills";
import { expect } from "vitest";
import {
  type AgreementReport,
  formatAgreementReport,
  measureAgreement,
} from "../../src/eval/agreement.js";
import {
  type DefectManifest,
  type RecallReport,
  formatLedgerRateLine,
  formatRecallReport,
  matchDefects,
  readManifest,
} from "../../src/eval/recall.js";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import { classifyPanel, scenarioById } from "../../src/eval/scenarios.js";
import {
  type VerificationReport,
  formatVerificationReport,
  measureVerification,
} from "../../src/eval/verification.js";
import { liveWorkDir } from "./work-dir.js";

export { liveBinding };

/**
 * R3's raised budget: 8,000 output tokens per reviewer at N = 3, turns
 * undivided. The stock default's behaviour on this topology is R3's and R9's
 * measured evidence; the evidence rows do not re-spend on it.
 *
 * **Passed as `ceilings`, not `budget`** — `runSessionTask` treats a `budget`
 * as an action's *request* and clamps DOWN from the ceiling, which is how the
 * pre-ADR-0071 figures were taken at a 5,333-token carve rather than 8,000.
 * Figures taken before that fix are not comparable with figures taken after.
 */
export const RAISED_CEILINGS = {
  maxTurns: 12,
  maxToolCalls: 24,
  maxOutputTokens: 24_000,
};

export const PLANTED_DEFECTS = 16;

export type Outcome = ReturnType<typeof classifyPanel> | "recall_zero";

/** The SHIPPED protocol, through the bundled loader — never a hand-written
 *  fixture, which would measure a protocol nobody ships. */
export async function panelProtocol(): Promise<Skill[]> {
  const { skills, diagnostics } = await listSkills({
    bundledDir: bundledSkillsDir(),
  });
  expect(diagnostics).toEqual([]);
  const protocol = skills.find((s) => s.name === PANEL_SKILL);
  expect(protocol?.source).toBe("bundled");
  expect(protocol?.body ?? "").not.toBe("");
  return skills;
}

/**
 * The fixture check, before any spend (the E1 pattern).
 *
 * A broken fixture is indistinguishable from a real regression at the moment
 * you are trying to tell them apart. `expectFiles` is the workspace listing
 * the reviewers may see — the answer key must not be in it — and `expectLines`
 * is the manuscript's own length, which differs between the two fixtures and
 * is therefore the caller's to state.
 */
export function checkFixture(
  paperDir: string,
  manifest: DefectManifest,
  expect_: { files: string[]; entry: string; lines: number },
): void {
  const files = new Set<string>();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.add(relative(paperDir, child).split(sep).join("/"));
    }
  };
  walk(paperDir);
  expect([...files].sort()).toEqual([...expect_.files].sort());
  const main = readFileSync(resolve(paperDir, expect_.entry), "utf8");
  expect(
    main.split("\n").filter((_, i, all) => i < all.length - 1),
  ).toHaveLength(expect_.lines);
  expect(describeWrapping(main)).toContain("hard-wrapped");
  expect(manifest.defects).toHaveLength(PLANTED_DEFECTS);
}

/**
 * One line per reviewer: the model as the RECORD has it (reading it back from
 * the item rather than from the test's own input is what makes it evidence),
 * what it located and dropped, what it could not reach, and cost.
 */
export function reviewerTally(
  item: ReviewItem,
  limits: readonly ReviewLimit[],
  recall: RecallReport,
): string {
  return item.seats
    .map((seat) => {
      const name = seat.reviewer;
      const mine = recall.perReviewer[name];
      const dropped = limits
        .filter((l) => l.kind === "anchors_dropped" && l.reviewer === name)
        .flatMap((l) => (l.kind === "anchors_dropped" ? l.anchors : []));
      const gone = limits.find(
        (l) => l.kind === "seat_missing" && l.reviewer === name,
      );
      const rejected = limits
        .filter((l) => l.kind === "entries_rejected" && l.reviewer === name)
        .flatMap((l) => (l.kind === "entries_rejected" ? l.entries : []));
      const sources = limits
        .filter((l) => l.kind === "source_unavailable" && l.reviewer === name)
        .map((l) =>
          l.kind === "source_unavailable"
            ? `${l.source}:${l.status}${l.anonymous === true ? ":anon" : ""}`
            : "",
        );
      const spent = limits.some(
        (l) => l.kind === "search_budget_spent" && l.reviewer === name,
      );
      const unguided = limits.some(
        (l) => l.kind === "seat_unguided" && l.reviewer === name,
      );
      // X5: what the seat's own ledger came to, before and after the one
      // re-ask. `mine.ledger` is the harness's count, copied rather than
      // re-derived — the first pass no longer exists by the time this runs.
      const ledger = mine?.ledger;
      const counts = (c: {
        entries: number;
        located: number;
        dropped: number;
        rejected: number;
      }): string => `${c.entries}/${c.located}/${c.dropped}/${c.rejected}`;
      return (
        `${name}@${seat.model}${seat.unverified === true ? "!unverified" : ""}` +
        `${seat.unpriced === true ? "!unpriced" : ""}` +
        `=${seat.status}${seat.retried === true ? "+retried" : ""}` +
        `/${mine?.concerns ?? 0}concerns/${mine?.located ?? 0}loc/${dropped.length}drop` +
        `${dropped.length > 0 ? `(${dropped.map((d) => `${d.role}:${d.reason}`).join(" ")})` : ""}` +
        `${rejected.length > 0 ? `/${rejected.length}rejected(${rejected.map((r) => `#${r.index}`).join(" ")})` : ""}` +
        `/${mine?.majors ?? 0}maj(${mine?.blockingMajors ?? 0}blocking)` +
        `/found:${mine?.found.join(",") || "none"}` +
        `${
          ledger === undefined
            ? ""
            : `/ledger:${ledger.firstPass !== undefined ? `first=${counts(ledger.firstPass)}→` : ""}final=${counts(ledger)}relocated=${ledger.relocated}`
        }` +
        `${sources.length > 0 ? `/sources:${sources.join(",")}` : ""}` +
        `${spent ? "/search-budget-spent" : ""}` +
        `${unguided ? "/UNGUIDED" : ""}` +
        // The driver's OWN words for why a reviewer went missing. Without the
        // detail, `unparsed` and `starved by the carve` read identically in
        // the tally, and they are opposite findings. X5 adds the CLASS, so a
        // dead key and an overloaded provider are distinguishable too.
        `${
          gone?.kind === "seat_missing"
            ? `/missing:${gone.reason}${gone.detail !== undefined ? `(${gone.detail})` : ""}${gone.cause !== undefined ? `[${gone.cause.class}${gone.cause.message !== undefined ? `: ${gone.cause.message}` : ""}]` : ""}`
            : ""
        }` +
        `/${seat.usage?.outputTokens ?? "?"}out`
      );
    })
    .join(" ");
}

/**
 * Everything the record asks for, printed, plus the named triggers whose
 * revisit conditions say *the evidence measurement*.
 *
 * A fired trigger is a **finding for the operator**, never something a build
 * session acts on — so it is printed loudly here and named in the Done record.
 */
export function report(
  tag: string,
  label: string,
  item: ReviewItem | undefined,
  recall: RecallReport,
  agreement: AgreementReport,
  task: { turns: number; toolCalls: number; usage?: { costUsd?: number } },
  wallMs: number,
  /** V1 (ADR 0076, plan D12): the same run read twice. */
  verification?: VerificationReport,
): Outcome {
  const base = classifyPanel(item);
  const limits = item?.result?.limits ?? [];
  const outcome: Outcome =
    base === "panel_located" && recall.overall.found === 0
      ? "recall_zero"
      : base;
  const synthesis = item?.result?.synthesis;

  console.info(
    `[${tag}/${label}] outcome=${outcome} status=${item?.status ?? "none"} ` +
      `${item ? reviewerTally(item, limits, recall) : "no-item"} ` +
      `cross-review=${item?.synthesis ?? "?"}` +
      `${synthesis ? `(${synthesis.consensus.length}c/${synthesis.disagreements.length}d)` : ""}` +
      `@${item?.synthesisSeat?.model ?? "?"}/${item?.synthesisSeat?.usage?.outputTokens ?? "?"}out ` +
      // V1: the verifier's state, its model and its spend, beside the
      // cross-review's — a sibling, never a seat.
      `verifier=${item?.verification ?? "?"}` +
      `@${item?.verifierSeat?.model ?? "?"}/${item?.verifierSeat?.usage?.outputTokens ?? "?"}out ` +
      // X5: what the pre-run check cost and whether it passed. A row whose
      // preflight is absent ran before X5; one whose preflight failed never
      // reached a seat, and its zeros are refusals rather than findings.
      `preflight=${
        item?.preflight === undefined
          ? "?"
          : item.preflight
              .map(
                (p) =>
                  `${p.model}:${p.status}${p.cause !== undefined ? `(${p.cause.class})` : ""}`,
              )
              .join(",")
      } ` +
      `turns=${task.turns} tool-calls=${task.toolCalls} wall=${(wallMs / 1000).toFixed(1)}s ` +
      `usage=${item?.usage?.outputTokens ?? "?"}out` +
      `${task.usage?.costUsd === undefined ? "" : `/$${task.usage.costUsd.toFixed(4)}`}`,
  );
  console.info(`[${tag}/${label}] ${formatRecallReport(recall)}`);
  console.info(`[${tag}/${label}] ${formatAgreementReport(agreement)}`);
  // V1 (plan D12, L1/L2): the tally, recall before → after with what was
  // lost, trap hits with each pick, and central beside blocking. Reported,
  // never asserted — a withdrawal rate the operator may not like is a
  // finding for the Done record, never a reason for a floor.
  if (verification !== undefined)
    console.info(`[${tag}/${label}] ${formatVerificationReport(verification)}`);

  // X5 (ADR 0074 §8): the number this milestone exists to move, printed on a
  // line of its own so it survives a scroll. Absent when no seat reported a
  // tally — an absent measurement and a measured zero are opposite findings.
  const rates = formatLedgerRateLine(recall);
  console.info(
    `[${tag}/${label}] ${rates ?? "located rate: not measured — no seat reported a ledger tally"}`,
  );
  // X5 (ADR 0074 §9): the instrument for the protocol change. Reported and
  // never asserted; the reading to watch is whether it falls.
  console.info(
    `[${tag}/${label}] outage-shaped concerns: ${recall.outageShaped.length}` +
      `${recall.outageShaped.length > 0 ? ` (${recall.outageShaped.map((o) => `${o.id}: ${o.message.slice(0, 80)}`).join(" | ")})` : ""}`,
  );

  const budgetSpent = limits.filter(
    (l) => l.kind === "search_budget_spent",
  ).length;
  const maxConcerns = Math.max(
    0,
    ...Object.values(recall.perReviewer).map((r) => r.located),
  );
  const majors = Object.values(recall.perReviewer).reduce(
    (n, r) => n + r.majors,
    0,
  );
  const blocking = Object.values(recall.perReviewer).reduce(
    (n, r) => n + r.blockingMajors,
    0,
  );
  const allBlocking =
    majors > 0 && blocking === majors ? " ALL-BLOCKING (R3's entry fires)" : "";
  console.info(
    `[${tag}/${label}] triggers: search_budget_spent=${budgetSpent} (ADR 0067 §6 fires at N=3 if > 0) max-located-per-reviewer=${maxConcerns} (MAX_ANNOTATIONS is 50) blocking-among-majors=${blocking}/${majors}${allBlocking}`,
  );
  return outcome;
}

/** L3 — the panel says what it could not do (stage-gate claim 3). V1's L4
 *  (stage-gate claim 8) rides here too: `paperDir`, when given, is where a
 *  withdrawn concern's counter must really be. */
/**
 * The fixture's own `\title`, for L2 and L4 (V2).
 *
 * Read with the harness's own reader over the files on disk, so the test and
 * the product agree on what the title IS — a second parser here would be a
 * second answer, and the interesting failures are exactly where they differ.
 */
function fixtureTitle(paperDir: string): string | undefined {
  const files = new Map<string, string>();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else
        files.set(
          relative(paperDir, child).split(sep).join("/"),
          readFileSync(child, "utf8"),
        );
    }
  };
  walk(paperDir);
  return manuscriptTitle({ files, defaultFile: "main.tex" });
}

export function assertHonesty(
  tag: string,
  item: ReviewItem | undefined,
  label: string,
  paperDir?: string,
): void {
  const limits = item?.result?.limits ?? [];
  const seats = new Set((item?.seats ?? []).map((s) => s.reviewer));
  // V2: the reviewed manuscript's own title, read from the fixture on disk
  // rather than from the record — the record is what is under test.
  const ownTitle = paperDir === undefined ? undefined : fixtureTitle(paperDir);

  // The forced `/skill:` load held in every run R3, R4 and R9 measured. If it
  // ever stops holding, every recall below was taken on an unguided panel.
  expect(limits.filter((l) => l.kind === "seat_unguided")).toEqual([]);

  // A reviewer that did not complete is NAMED. Silence there would report a
  // narrower review as a whole one.
  for (const seat of item?.seats ?? []) {
    if (seat.status === "completed") continue;
    expect(
      limits.some(
        (l) => l.kind === "seat_missing" && l.reviewer === seat.reviewer,
      ),
    ).toBe(true);
  }

  // Every honesty entry is well formed and about a reviewer that ran. The
  // implication is vacuous when every source answered — that is an outcome
  // set, and the branch taken is in the line below.
  const unavailable = limits.filter((l) => l.kind === "source_unavailable");
  for (const limit of unavailable) {
    if (limit.kind !== "source_unavailable") continue;
    expect(seats.has(limit.reviewer)).toBe(true);
    expect(limit.source).not.toBe("");
    expect(["rate_limited", "timeout", "failed"]).toContain(limit.status);
  }

  // X5 (L5): the tally's own identities, as implications over whatever the run
  // produced. These are arithmetic, not thresholds — `entries` is `located`
  // plus `dropped` plus `rejected` by construction, so a run that breaks one
  // has a counting bug, not a bad model.
  for (const seat of item?.seats ?? []) {
    const c = seat.ledger;
    if (c === undefined) continue;
    expect(`${seat.reviewer}: ${c.located + c.dropped + c.rejected}`).toBe(
      `${seat.reviewer}: ${c.entries}`,
    );
    expect(c.relocated).toBeLessThanOrEqual(c.located);
    // `firstPass` present implies `retried`; the converse is false, because a
    // re-ask whose first answer did not parse has nothing countable.
    if (c.firstPass !== undefined) expect(seat.retried).toBe(true);
  }
  // And every rejection names a seat that actually ran.
  for (const limit of limits) {
    if (limit.kind !== "entries_rejected") continue;
    expect(seats.has(limit.reviewer)).toBe(true);
    expect(limit.entries.length).toBeGreaterThan(0);
  }

  // V1 (plan D12, L4): what verification did is structurally sound, as
  // implications over whatever the run produced — never a threshold.
  const annotations = item?.result?.annotations ?? [];
  for (const a of annotations) {
    const v = a.verification;
    if (v === undefined) continue;
    if (v.outcome === "refuted") {
      // Withdrawn only on a passage the HARNESS located.
      expect(v.counter, a.id).toBeDefined();
      expect(v.counter?.line ?? 0, a.id).toBeGreaterThanOrEqual(1);
      if (paperDir !== undefined && v.counter !== undefined)
        expect(existsSync(resolve(paperDir, v.counter.file)), a.id).toBe(true);
    } else {
      expect(v.counter, a.id).toBeUndefined();
    }
    // `central` is asked of a major only.
    if (v.central !== undefined) expect(a.severity, a.id).toBe("major");
  }
  if (item?.verifierSeat?.verification !== undefined) {
    const c = item.verifierSeat.verification;
    expect(
      `verifier: ${c.upheld + c.refuted + c.unverifiable + c.unanswered}`,
    ).toBe(`verifier: ${c.concerns}`);
    // Both downgrades land as unverifiable (plan D3).
    expect(c.downgraded).toBeLessThanOrEqual(c.unverifiable);
  } else if (item?.result !== undefined) {
    // No verifier seat: the record says why — Off, a verifier that could
    // not run, or nothing located to check.
    expect(
      item.verification === "skipped" ||
        limits.some((l) => l.kind === "verification_missing"),
    ).toBe(true);
  }

  // V2 (plan D14, L4): the third evidence kind is structurally sound, over
  // every panel the tier runs. Implications again, never thresholds — a panel
  // that cited no paper at all passes these vacuously, and says so below.
  const papers = annotations.filter((a) => a.evidence?.kind === "paper");
  for (const a of papers) {
    if (a.evidence?.kind !== "paper") continue;
    // A paper with no title is not a citation of anything, and `source` is
    // which index returned it — the thing that makes it RETRIEVED rather than
    // recalled, which is the whole of ADR 0078 §3.
    expect(a.evidence.title.trim(), `${a.id} title`).not.toBe("");
    expect(a.evidence.source.trim(), `${a.id} source`).not.toBe("");
    // And it is not the manuscript itself (L2's structural assertion, checked
    // on every fixture rather than only the own-title twin).
    if (ownTitle !== undefined)
      expect(
        sameTitle(a.evidence.title, ownTitle),
        `${a.id} is the paper`,
      ).toBe(false);
  }
  // A fixture that HAS a title must never report the guard unarmed: that limit
  // means self-withholding could not run, and on a titled paper it would mean
  // the reviewed manuscript could come back in a seat's own search results.
  if (ownTitle !== undefined) {
    expect(
      limits.filter((l) => l.kind === "own_title_unguarded"),
      "the fixture has a title, so the guard must have been armed",
    ).toEqual([]);
  }
  // A `literature` concern can only be REFUTED because V2 hands the verifier
  // the paper's abstract — so one refuted without a paper behind it means the
  // gate that makes it answerable was bypassed.
  for (const a of annotations) {
    if (a.verification?.kind !== "literature") continue;
    if (a.verification.outcome !== "refuted") continue;
    expect(a.evidence?.kind, `${a.id}: refuted literature concern`).toBe(
      "paper",
    );
  }

  console.info(
    `[${tag}/${label}] L4 papers: ${papers.length} paper evidence` +
      `; ownTitle=${ownTitle === undefined ? "none" : JSON.stringify(ownTitle)}` +
      `; withheld=${
        (item?.seats ?? [])
          .map((s) => `${s.reviewer}:${s.ownTitleWithheld ?? 0}`)
          .join(" ") || "none"
      }`,
  );

  console.info(
    `[${tag}/${label}] L3 branch: ${
      unavailable.length === 0
        ? "every source answered (vacuous)"
        : `${unavailable.length} source_unavailable entr(ies) recorded`
    }; seat_missing=${limits.filter((l) => l.kind === "seat_missing").length}` +
      `; entries_rejected=${limits.filter((l) => l.kind === "entries_rejected").length}` +
      `; L4 verification=${item?.verification ?? "?"}` +
      `; verification_missing=${
        limits
          .filter((l) => l.kind === "verification_missing")
          .map((l) => (l.kind === "verification_missing" ? l.reason : ""))
          .join(",") || "none"
      }`,
  );
}

export interface PanelRun {
  item: ReviewItem | undefined;
  recall: RecallReport;
  agreement: AgreementReport;
  /** V1: the same run read again, without what verification withdrew. */
  verification: VerificationReport;
  outcome: Outcome;
  /** Remove the working copy — only where the test has finished asserting. */
  discard: () => Promise<void>;
}

/** One planted-defect panel, on whichever fixture the caller names. */
export async function runPanel(
  where: { tag: string; scenario: string; fixtureDir: string },
  label: string,
  binding: ModelBinding,
  over: {
    reviewers?: ModelBinding[];
    synthesis?: ModelBinding;
    /** Run before any spend; throw to refuse the row. */
    precheck?: (manifest: DefectManifest) => void;
  } = {},
): Promise<PanelRun> {
  const scenario = scenarioById(where.scenario);
  if (scenario === undefined) {
    throw new Error(`${where.scenario} scenario missing`);
  }
  const paperDir = resolve(where.fixtureDir, "paper");
  const manifest = await readManifest(
    resolve(where.fixtureDir, "defects.json"),
  );
  over.precheck?.(manifest);
  const evidence = liveWorkDir();
  const started = Date.now();
  const { precheck: _precheck, ...panel } = over;
  const task = await runEvalTask({
    scenario,
    paperDir,
    grants: new Map(),
    stub: false,
    // A panel never writes (ADR 0061 §1), so no edit host — otherwise
    // `propose_edit` is loop-injected into every reviewer.
    readOnly: true,
    skills: await panelProtocol(),
    binding,
    ceilings: RAISED_CEILINGS,
    ...panel,
  });
  evidence.track(task.workDir);
  const item = task.outcome.items.find(
    (i): i is ReviewItem => i.type === "review",
  );
  const recall = matchDefects(
    item ?? ({ seats: [] } as unknown as ReviewItem),
    manifest,
  );
  const agreement = measureAgreement(
    item ?? ({ seats: [] } as unknown as ReviewItem),
    recall,
  );
  const verification = measureVerification(
    item ?? ({ seats: [] } as unknown as ReviewItem),
    manifest,
  );
  const outcome = report(
    where.tag,
    label,
    item,
    recall,
    agreement,
    task,
    Date.now() - started,
    verification,
  );
  assertHonesty(where.tag, item, label, paperDir);
  return {
    item,
    recall,
    agreement,
    verification,
    outcome,
    discard: () => evidence.discard(),
  };
}
