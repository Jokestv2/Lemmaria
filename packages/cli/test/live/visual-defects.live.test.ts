/**
 * V4, the **live** rows L1–L3 (plan D15; ADR 0081).
 *
 * ## The question
 *
 * Everything else in V4 is asserted offline: the facts, the seat's wiring, the
 * page rule, the record. None of it answers what the milestone is for — **does
 * the shipped PDF reviewer, one page at a time, find defects that exist only on
 * the rendered page, and name the page it saw each on?**
 *
 * S6's defective twin plants ten: text in the margin, a table past its column,
 * labels too small to read, a stranded heading, a float three pages from its
 * reference, the wrong paper size, one page over the limit, a caption that
 * contradicts its plot, an unreferenced figure, and an author named on a
 * double-blind submission. Three of them (V3, V6, V7) the deterministic facts
 * answer, so the seat is read on the other seven.
 *
 * ## Reported, never asserted — except L3
 *
 * **L1 and L2 assert no count.** A found-count asserted against a model that
 * moves under its own version is a flake generator (ADR 0035 §5), and the
 * plan's gate says it in advance: a defect the seat never finds is a finding
 * for the Done record, never a reason to raise the width, the view budget or
 * the carve. **There is no *before*:** this is the seat's first reading, a
 * floor. S6's table drove a hand-rolled request with every page in one batch;
 * V4 drives one page at a time through the shipped seat, so the two are not
 * comparable numbers.
 *
 * **L3 is structural** and asserted on every run: no image bytes reached the
 * persisted transcript, every page cited as evidence is a page the seat viewed,
 * the seat ran on the pin's model, and the PDF-only record says what it is —
 * verification skipped, no cross-review, and neither missing-limit.
 *
 * ## Cost
 *
 * Three pages at 1,100 px (≈ 3,950 input tokens a page on the openai pin, V3's
 * measurement) plus the source reads and one ledger — **under US$0.02 a run**
 * on the cheap pin; a run over **US$0.15** is printed as a STOP and is to be
 * reported rather than re-run. `vitest.live.config.ts` carries `retry: 1`.
 *
 * The anthropic rows are written, typechecked and **skipped**: the pin is
 * disabled by operator decision. A closed pin is recorded as *not measured —
 * pin disabled*, never as zero.
 *
 * ## What it read, the first two times it was run (V4 T13, 2026-09-23)
 *
 * On `gpt-5.6-luna`, once inside a whole `pnpm test:live` and once narrowed to
 * this file. **L1 read the same both times:**
 *
 *     found 4/7 — text-in-the-margin 1/1 · stranded-heading-and-gap 1/1 ·
 *     float-pages-from-its-reference 1/1 · caption-contradicts-figure 1/1 ·
 *     table-past-the-column 0/1 · unreferenced-figure 0/1 ·
 *     identity-on-an-anonymous-submission 0/1
 *     page named right 5 of 5 · unmatched 0 · pages viewed 1, 2, 3
 *     facts: 3 pages · a4 · smallest text 5.0 pt on page 1 · over the limit
 *     in=51,333 out=569 / 588 · $0.0109 / $0.0110 · 16.0 s / 16.2 s
 *
 * Five concerns, every one located and every one citing the page the defect
 * is on; the fifth reached V3 (the illegible labels, a facts defect), so it is
 * credited and counts toward nothing planted. **Missed: V2, V9, V10** — the
 * table cut at the column edge, the figure no sentence refers to, and the
 * author named on a double-blind submission. The last two are the fixture's
 * source-visible controls, so the seat reading the page and not the source
 * for them is itself the reading. This is a floor, not a grade.
 *
 * **L2 raised 3, then 2 concerns on the clean twin** (both pages viewed;
 * $0.0251 / $0.0131) — every one about the paper's argument (an unsupported
 * causal claim, a missing dense baseline, a schematic plot, thin related
 * work), none about the page. By construction each is a false alarm *for this
 * fixture*; none is a layout remark on a clean page. The anthropic half is
 * **not measured — pin disabled**.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPdfiumRenderer } from "@lemmaria/adapters";
import { pdfiumWasmPath } from "@lemmaria/adapters/pdfium-wasm";
import {
  type ModelBinding,
  type PdfRenderer,
  type ReviewItem,
  type Skill,
  listSkills,
} from "@lemmaria/harness";
import { bundledSkillsDir } from "@lemmaria/harness/bundled-skills";
import { describe, expect, it } from "vitest";
import {
  type EvalTaskResult,
  liveBinding,
  runEvalTask,
} from "../../src/eval/run-eval.js";
import { scenarioById } from "../../src/eval/scenarios.js";
import {
  type VisualManifest,
  formatVisualReport,
  matchVisualDefects,
  readVisualManifest,
} from "../../src/eval/visual.js";
import { RAISED_CEILINGS } from "./panel-rows.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/visual-defects");
const STOP_USD = 0.15;

let renderer: PdfRenderer | undefined;
let skills: Skill[] | undefined;
let manifest: VisualManifest | undefined;
async function deps(): Promise<{
  renderer: PdfRenderer;
  skills: Skill[];
  manifest: VisualManifest;
}> {
  renderer ??= createPdfiumRenderer(
    new Uint8Array(await readFile(pdfiumWasmPath())),
  );
  skills ??= (await listSkills({ bundledDir: bundledSkillsDir() })).skills;
  manifest ??= await readVisualManifest(resolve(FIXTURE, "visual.json"));
  return { renderer, skills, manifest };
}

interface VisualRun {
  task: EvalTaskResult;
  item: ReviewItem | undefined;
  manifest: VisualManifest;
  /** Every JSONL the run persisted, the child's included — L3 reads it. */
  jsonl: string;
  seconds: string;
  discard: () => Promise<void>;
}

async function persisted(workDir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(await readFile(p, "utf8"));
    }
  };
  await walk(join(workDir, "sessions"));
  return out.join("\n");
}

async function runTwin(
  twin: "paper" | "clean",
  tag: string,
  binding: ModelBinding,
): Promise<VisualRun> {
  const scenario = scenarioById("visual-defects");
  if (scenario === undefined)
    throw new Error("visual-defects scenario missing");
  const d = await deps();
  const evidence = liveWorkDir();
  const started = Date.now();
  const task = await runEvalTask({
    scenario,
    paperDir: resolve(FIXTURE, twin),
    grants: new Map(),
    stub: false,
    readOnly: true,
    binding,
    skills: d.skills,
    pdfRenderer: d.renderer,
    venue: d.manifest.venue,
    ceilings: RAISED_CEILINGS,
  });
  evidence.track(task.workDir);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const item = task.outcome.items.find(
    (i): i is ReviewItem => i.type === "review",
  );
  const cost = task.usage?.costUsd;
  console.info(
    `[${tag}] ${task.model}: status=${task.outcome.status}` +
      ` pdf=${task.pdf?.source ?? task.pdf?.withheld ?? task.pdf?.reason ?? "—"}` +
      ` in=${task.usage?.inputTokens ?? 0} out=${task.usage?.outputTokens ?? 0}` +
      ` cost=${cost === undefined ? "$unpriced" : `$${cost.toFixed(4)}`}` +
      ` in ${seconds}s`,
  );
  if (cost !== undefined && cost > STOP_USD) {
    console.info(
      `[${tag}] STOP: this run cost $${cost.toFixed(4)}, over the plan's $${STOP_USD} — report it, do not re-run`,
    );
  }
  return {
    task,
    item,
    manifest: d.manifest,
    jsonl: await persisted(task.workDir),
    seconds,
    discard: () => evidence.discard(),
  };
}

/** L1's reading, printed. Nothing here is asserted. */
function reportL1(tag: string, run: VisualRun): void {
  const report = matchVisualDefects(run.item, run.manifest);
  for (const line of formatVisualReport(report).split("\n")) {
    console.info(`[${tag}] ${line}`);
  }
  console.info(
    `[${tag}] credited: ${
      report.hits
        .map((h) => `${h.defect}:${h.ids.join("+")}(page ${h.pageNamed})`)
        .join(" ") || "nothing"
    } — missed ${report.missed.join(",") || "nothing"}`,
  );
  console.info(
    `[${tag}] views: ${report.viewed.length} · input tokens of the run: ${run.task.usage?.inputTokens ?? "unreported"} · wall ${run.seconds}s`,
  );
  if (report.measured && report.found === 0) {
    console.info(
      `[${tag}] FINDING: the seat ran and reached none of the ${report.planted} defects. Per the plan this is the reading — not a reason to raise the width, the view budget or the carve.`,
    );
  }
}

/** L2's reading: on the clean twin every concern is a false alarm. */
function reportL2(tag: string, run: VisualRun): void {
  const concerns = (run.item?.result?.annotations ?? []).filter(
    (a) => a.reviewer === "pdf_reviewer",
  );
  console.info(
    `[${tag}] concerns raised on the clean twin: ${concerns.length}` +
      ` · pages viewed: ${(run.item?.pdf?.viewed ?? []).join(", ") || "none"}`,
  );
  for (const a of concerns) {
    console.info(
      `[${tag}]   ${a.id} · ${a.dimension} · ${a.severity} · ${a.span.file}:${a.span.line} — ${a.message}`,
    );
  }
}

/** L3, asserted: the structural half — the seat working or not, on any model. */
function assertL3(tag: string, run: VisualRun, model: string): void {
  expect(run.task.outcome.status, tag).toBe("completed");
  const item = run.item;
  expect(item, `${tag}: no review item`).toBeDefined();
  // The wiring has to have worked for any of this to mean anything.
  expect(run.task.pdf?.withheld, `${tag}: withheld`).toBeUndefined();
  expect(item?.pdf?.source, `${tag}: no PDF`).toBe("beside_entry");

  // 1. No image bytes in anything persisted.
  expect(run.jsonl).not.toContain("data:image");
  expect(run.jsonl).not.toContain("iVBORw0KGgo");

  // 2. Every page cited as evidence is a page the seat viewed — the driver's
  //    drop rule, checked from the outside.
  const viewed = new Set(item?.pdf?.viewed ?? []);
  for (const a of item?.result?.annotations ?? []) {
    if (a.evidence?.kind === "page") {
      expect(
        viewed.has(a.evidence.page),
        `${tag}: ${a.id} cites an unviewed page`,
      ).toBe(true);
    }
  }

  // 3. The seat ran on the pin's model.
  expect(item?.pdfSeat?.model).toBe(model);

  // 4. A PDF-only record says what it is, and misdescribes nothing.
  expect(item?.pdfOnly).toBe(true);
  expect(item?.verification).toBe("skipped");
  expect(item?.synthesis).toBeUndefined();
  const kinds = (item?.result?.limits ?? []).map((l) => l.kind);
  expect(kinds).not.toContain("synthesis_missing");
  expect(kinds).not.toContain("verification_missing");
}

describe("V4 L1–L3 — the PDF reviewer on S6's two twins", () => {
  it.runIf(liveOpenAIReady())(
    "L1a + L3: the defective twin, alone (openai)",
    async () => {
      const tag = "V4 live L1a/openai";
      const run = await runTwin(
        "paper",
        tag,
        liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
      );
      reportL1(tag, run);
      assertL3(tag, run, LIVE_OPENAI_MODEL);
      await run.discard();
    },
    900_000,
  );

  it.runIf(liveOpenAIReady())(
    "L2a + L3: the clean twin, alone (openai)",
    async () => {
      const tag = "V4 live L2a/openai";
      const run = await runTwin(
        "clean",
        tag,
        liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
      );
      reportL2(tag, run);
      assertL3(tag, run, LIVE_OPENAI_MODEL);
      await run.discard();
    },
    900_000,
  );

  it.runIf(liveAnthropicReady())(
    "L1b + L3: the defective twin, on the anthropic pin",
    async () => {
      const tag = "V4 live L1b/anthropic";
      const run = await runTwin(
        "paper",
        tag,
        liveBinding("anthropic", LIVE_ANTHROPIC_MODEL),
      );
      reportL1(tag, run);
      assertL3(tag, run, LIVE_ANTHROPIC_MODEL);
      await run.discard();
    },
    900_000,
  );

  it.runIf(liveAnthropicReady())(
    "L2b + L3: the clean twin, on the anthropic pin",
    async () => {
      const tag = "V4 live L2b/anthropic";
      const run = await runTwin(
        "clean",
        tag,
        liveBinding("anthropic", LIVE_ANTHROPIC_MODEL),
      );
      reportL2(tag, run);
      assertL3(tag, run, LIVE_ANTHROPIC_MODEL);
      await run.discard();
    },
    900_000,
  );
});
