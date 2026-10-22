/**
 * V3, the **live** rows L1 and L2 (plan D18; ADR 0080).
 *
 * ## The question
 *
 * Everything else in this milestone is wiring that can be asserted offline: a
 * page becomes a PNG, the PNG becomes an image part, the part reaches the wire
 * in each protocol's shape, and the bytes never reach the transcript. None of
 * it answers the only question the door exists for — **can a real model read
 * something that is on the rendered page and nowhere else?**
 *
 * The fixture plants a code inside a framed box on page 1. It is in `main.tex`
 * and in the PDF's text layer, and the model is shown neither: the tool hands
 * back a raster at the harness's own width, and the task's only instruction is
 * to look at the page and reply with the code. A model that answers correctly
 * saw the pixels. There is no other channel.
 *
 * ## Reported, never asserted — with one exception
 *
 * **No read floor is asserted.** The same rule the novelty and planted-defect
 * rows follow: a floor asserted against a model that moves under its own
 * version is a flake generator, and ADR 0035 §5 forbids the *"assertion
 * admitting one outcome only"*. **A run where the marker is not read is a
 * finding for the Done record, not a failure** — and the plan's acceptance
 * gate says so in as many words: *do not raise the width, change the prompt's
 * shape, or add a second call to make it read.*
 *
 * The exception is **L2**, which is structural rather than a judgement of the
 * model: the transcript carries no image bytes, every page shown is a page
 * that exists, and the tool's own record of what it rendered agrees with what
 * the transcript says. Those either hold or the door is broken, on any model.
 *
 * What is NOT asserted, and is the first thing to read in the report: whether
 * the tool was called at all. A model that never opens the door measures
 * nothing about reading a page, so the instrument says *not measured* rather
 * than a zero.
 *
 * ## Cost
 *
 * Two turns and one page image per row on the cheap openai pin — far below the
 * panel rows, which measure ≈ $0.10 each. Budget **≈ $0.01 per run of this
 * file**, and note `vitest.live.config.ts` carries `retry: 1`.
 *
 * The anthropic rows are written, typechecked and **skipped**: the pin is
 * disabled by operator decision (an exported key with no credit fails every
 * row on billing and reads as a regression). A closed pin is recorded as
 * *not measured — pin disabled*, never as zero.
 *
 * ## What it read, the first two times it was run (V3 T12, 2026-09-22)
 *
 * Both readings on `gpt-5.6-luna`, and **identical to the token** — once
 * narrowed to this file, once inside a whole `pnpm test:live`:
 *
 *     marker: read · calls: 1 · pages viewed: 1 · images sent: 1
 *     pdf=beside_entry  in=3987  out=32  cost=$0.0008  in 4.7s / 6.0s
 *
 * So: **one call, one page, and the code came back.** The model was never
 * shown the `.tex`, the text layer or the marker file — a raster at 1,100 px
 * is the only place that string existed for it.
 *
 * Two things worth carrying forward. The **input cost of a page is ~3,950
 * tokens** on this pin, against `IMAGE_TOKEN_ESTIMATE`'s 2,200 — the estimate
 * is low here, which is the safe direction for a *window* estimate only
 * because eviction keeps at most one batch's pages live; it is the number to
 * re-measure if the width ever moves. And the whole row costs **$0.0008**,
 * two orders of magnitude under a panel row: a page image is cheap, and
 * fan-out is what is not.
 *
 * The anthropic half is **not measured — pin disabled**. Not zero, and not a
 * claim that the Anthropic wire works against a real endpoint: nothing here
 * has tested that, and this row is the only thing that would.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPdfiumRenderer } from "@lemmaria/adapters";
import { pdfiumWasmPath } from "@lemmaria/adapters/pdfium-wasm";
import type { ModelBinding, PdfRenderer } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  type Marker,
  type MarkerMeasurement,
  formatMarkerReport,
  measureMarker,
  readMarker,
} from "../../src/eval/marker.js";
import {
  type EvalTaskResult,
  liveBinding,
  runEvalTask,
} from "../../src/eval/run-eval.js";
import { scenarioById } from "../../src/eval/scenarios.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_BUDGET,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/pdf-marker");

/**
 * The renderer, built once per file rather than per row. It reads ~2 MiB of
 * WASM; a row's cost should be the model, not the loader.
 */
let renderer: PdfRenderer | undefined;
async function pdfRenderer(): Promise<PdfRenderer> {
  if (renderer === undefined) {
    renderer = createPdfiumRenderer(
      new Uint8Array(await readFile(pdfiumWasmPath())),
    );
  }
  return renderer;
}

interface MarkerRun {
  task: EvalTaskResult;
  marker: Marker;
  measurement: MarkerMeasurement;
  /** Everything the run persisted, concatenated — L2 reads this. */
  jsonl: string;
  discard: () => Promise<void>;
}

async function runMarker(
  tag: string,
  label: string,
  binding: ModelBinding,
): Promise<MarkerRun> {
  const scenario = scenarioById("pdf-marker");
  if (scenario === undefined) throw new Error("pdf-marker scenario missing");
  const marker = await readMarker(resolve(FIXTURE, "marker.json"));

  const evidence = liveWorkDir();
  const started = Date.now();
  const task = await runEvalTask({
    scenario,
    paperDir: resolve(FIXTURE, "paper"),
    grants: new Map(),
    stub: false,
    // The door is read-only by construction; a run that could write is a
    // different measurement.
    readOnly: true,
    binding,
    pdfRenderer: await pdfRenderer(),
    ceilings: LIVE_BUDGET,
  });
  evidence.track(task.workDir);

  const dir = join(task.workDir, "sessions");
  const names = await readdir(dir);
  const jsonl = (
    await Promise.all(
      names
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => readFile(join(dir, n), "utf8")),
    )
  ).join("\n");

  const measurement = measureMarker(task.outcome, marker.marker);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const cost = task.usage?.costUsd;
  console.info(
    `[${tag}/${label}] ${task.model}: status=${task.outcome.status}` +
      ` pdf=${task.pdf?.source ?? task.pdf?.withheld ?? task.pdf?.reason ?? "—"}` +
      ` in=${task.usage?.inputTokens ?? 0} out=${task.usage?.outputTokens ?? 0}` +
      ` cost=${cost === undefined ? "$unpriced" : `$${cost.toFixed(4)}`}` +
      ` in ${seconds}s`,
  );

  return {
    task,
    marker,
    measurement,
    jsonl,
    discard: () => evidence.discard(),
  };
}

/** L1's reading, printed. Nothing here is asserted. */
function reportL1(tag: string, label: string, run: MarkerRun): void {
  console.info(`[${tag}/${label}] ${formatMarkerReport(run.measurement)}`);
  // The input-token figure is what an image costs in practice, and it is the
  // number a future width change is judged against. Reported per run because
  // the page is the bulk of it: the prompt is two sentences.
  const input = run.task.usage?.inputTokens ?? "unreported";
  console.info(
    `[${tag}/${label}] input tokens for the run (the page is nearly all of it): ${input}; the harness estimates an image part at IMAGE_TOKEN_ESTIMATE`,
  );
  if (!run.measurement.read && run.measurement.measured) {
    // Said out loud so it is not read as a passing row that happens to be
    // quiet. It is the finding the plan names in advance.
    const FINDING =
      "FINDING: the door opened and the marker was NOT read. Per the plan's" +
      " acceptance gate this is the reading, not a failure — it is not a" +
      " reason to raise the width or reshape the prompt.";
    console.info(`[${tag}/${label}] ${FINDING}`);
  }
}

/**
 * L2, asserted on every run: the structural half.
 *
 * None of it is a judgement of the model — it is the door either working or
 * not, which is why these are `expect`s where L1's numbers are `console.info`.
 */
function assertL2(tag: string, label: string, run: MarkerRun): void {
  // The wiring has to have worked for any of this to mean anything. A withheld
  // tool or an unresolved PDF is a broken row, not a reading.
  expect(
    run.task.pdf?.withheld,
    `${tag}/${label}: tool withheld`,
  ).toBeUndefined();
  expect(run.task.pdf?.source).toBe("beside_entry");

  // 1. No image bytes in the persisted transcript. Eviction happens in the
  //    live history; persistence never saw them in the first place.
  expect(run.jsonl).not.toContain("image/png");
  expect(run.jsonl).not.toContain("iVBORw0KGgo");

  // 2. Every page shown is a page that exists. The fixture has one.
  for (const page of run.measurement.viewed) {
    expect(page).toBeGreaterThanOrEqual(1);
    expect(page).toBeLessThanOrEqual(1);
  }

  // 3. The tool's OWN record of what it rendered and the transcript's page
  //    reports are the same set. Two independent sources — `viewed` is the
  //    Set the tool kept, `measurement.viewed` is parsed back out of the
  //    persisted result JSON — so agreement is a real check rather than a
  //    restatement.
  expect([...(run.task.pdf?.viewed ?? [])].sort()).toEqual(
    [...run.measurement.viewed].sort(),
  );

  // 4. One image per page rendered. Counted here from the raw items rather
  //    than from the instrument, so the two arithmetics have to agree.
  const reported = run.task.outcome.items
    .filter((i) => i.type === "tool_call" && i.tool === "view_pdf_pages")
    .reduce((n, i) => {
      try {
        const r = JSON.parse(
          (i as { resultJson?: string }).resultJson ?? "{}",
        ) as { pages?: unknown[]; error?: unknown };
        return n + (r.error ? 0 : (r.pages ?? []).length);
      } catch {
        return n;
      }
    }, 0);
  expect(run.measurement.imagesSent).toBe(reported);
}

describe("V3 L1 — can a model read a code that is only on the page?", () => {
  it.runIf(liveOpenAIReady())(
    "L1a: the door's first reading (openai)",
    async () => {
      const run = await runMarker(
        "V3 live",
        "L1a/openai",
        liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
      );
      // The only behavioural assertion: the run has to have finished for its
      // transcript to be worth reading. Whether the marker came back is L1's
      // reading, not this row's pass condition.
      expect(run.task.outcome.status).toBe("completed");
      reportL1("V3 live", "L1a/openai", run);
      assertL2("V3 live", "L1a/openai", run);
      await run.discard();
    },
    600_000,
  );

  it.runIf(liveAnthropicReady())(
    "L1b: the same, on the anthropic pin",
    async () => {
      // Written, typechecked, and skipped while the pin is off — the tool
      // result's image shape differs between the two protocols (a
      // `tool_result` whose content is an array, against a trailing `user`
      // message), so this row is the only thing that would exercise the
      // Anthropic half against a real endpoint.
      const run = await runMarker(
        "V3 live",
        "L1b/anthropic",
        liveBinding("anthropic", LIVE_ANTHROPIC_MODEL),
      );
      expect(run.task.outcome.status).toBe("completed");
      reportL1("V3 live", "L1b/anthropic", run);
      assertL2("V3 live", "L1b/anthropic", run);
      await run.discard();
    },
    600_000,
  );
});
