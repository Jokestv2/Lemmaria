/**
 * V3 (O20): the visual door, end to end through the **real** driver.
 *
 * `pdf-marker-fixture.test.ts` proves the fixture carries a code only the
 * rendered page shows; `marker.test.ts` proves the instrument reads a run. This
 * proves the thing between them — that `lemmaria eval --scenario pdf-marker`
 * resolves a PDF, builds the tool over it, sends the page as an image part, and
 * persists a transcript with **no image bytes in it**.
 *
 * Offline, with the real PDFium renderer and a scripted model. The renderer is
 * real because the whole point is that a page becomes a PNG; the model is
 * scripted because what a model SEES is the live tier's reading (D18), and a
 * gate test that needed a real one would be measuring an API key.
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPdfiumRenderer } from "@lemmaria/adapters";
import { pdfiumWasmPath } from "@lemmaria/adapters/pdfium-wasm";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  PdfRenderer,
  ToolCallItem,
} from "@lemmaria/harness";
import { ScriptedModelAdapter } from "@lemmaria/harness";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runEvalTask } from "../../src/eval/run-eval.js";
import {
  FLAGSHIP_SCENARIOS,
  PROBE_SCENARIOS,
  scenarioById,
} from "../../src/eval/scenarios.js";
import { stubTurnsFor } from "../../src/eval/stub-script.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAPER = resolve(here, "../live/fixtures/pdf-marker/paper");
const MARKER = "LEMMARIA-MARKER-7F3A";

function scenario() {
  const s = scenarioById("pdf-marker");
  if (s === undefined) throw new Error("no pdf-marker scenario");
  return s;
}

let renderer: PdfRenderer;
beforeAll(async () => {
  renderer = createPdfiumRenderer(
    new Uint8Array(await readFile(pdfiumWasmPath())),
  );
});

const trash: string[] = [];
afterEach(async () => {
  for (const d of trash.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

/** Runs the committed stub script, and remembers every request it was sent. */
class RecordingStub implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private readonly inner = new ScriptedModelAdapter(stubTurnsFor("pdf-marker"));

  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    return this.inner.generate(req);
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    yield* this.inner.generateStream(req);
  }
}

/** Every `.jsonl` this run persisted, concatenated. */
async function persisted(workDir: string): Promise<string> {
  const dir = join(workDir, "sessions");
  const names = await readdir(dir);
  const parts = await Promise.all(
    names
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => readFile(join(dir, n), "utf8")),
  );
  expect(parts.length).toBeGreaterThan(0);
  return parts.join("\n");
}

function pdfCalls(items: readonly { type: string }[]): ToolCallItem[] {
  return items.filter(
    (i): i is ToolCallItem =>
      i.type === "tool_call" && (i as ToolCallItem).tool === "view_pdf_pages",
  );
}

/** Calls the ALLOWLIST refused — asked for, never run. */
function deniedCalls(items: readonly { type: string }[]): ToolCallItem[] {
  return pdfCalls(items).filter((c) => c.status !== "completed");
}

describe("V3 O20 — the pdf-marker scenario", () => {
  it("resolves by id, is a PROBE, and is not swept into `--scenario all`", () => {
    const s = scenario();
    expect(s.tools).toEqual(["view_pdf_pages"]);
    expect(s.readOnly).toBe(true);
    expect(s.requiredGrants).toEqual([]);
    expect(FLAGSHIP_SCENARIOS.map((x) => x.id)).not.toContain("pdf-marker");
    expect(PROBE_SCENARIOS.map((x) => x.id)).toContain("pdf-marker");
  });

  it("resolves the PDF beside the entry, renders it, and the tool runs", async () => {
    const task = await runEvalTask({
      scenario: scenario(),
      paperDir: PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      pdfRenderer: renderer,
    });
    trash.push(task.workDir);

    expect(task.outcome.status).toBe("completed");
    // The committed `main.pdf` sits beside `main.tex` and is not stale — the
    // `preserveTimestamps` copy is what keeps that true of the working copy.
    expect(task.pdf?.source).toBe("beside_entry");
    expect(task.pdf?.withheld).toBeUndefined();
    expect(task.pdf?.reason).toBeUndefined();
    expect(task.pdf?.viewed).toEqual([1]);

    const calls = pdfCalls(task.outcome.items);
    expect(calls.length).toBe(1);
    expect(calls[0]?.status).toBe("completed");
    const result = JSON.parse(calls[0]?.resultJson ?? "{}") as {
      pages?: Array<{ page: number; width: number; height: number }>;
      pageCount?: number;
    };
    expect(result.pageCount).toBe(1);
    expect(result.pages?.[0]?.page).toBe(1);
    expect(result.pages?.[0]?.width).toBe(1100);

    // And the scenario's own judge reads the run as the door having worked.
    expect(scenario().judge(task.outcome, undefined).pass).toBe(true);
  });

  it("sends the page as ONE labelled PNG part on the tool message", async () => {
    const adapter = new RecordingStub();
    const task = await runEvalTask({
      scenario: scenario(),
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      adapter,
      pdfRenderer: renderer,
    });
    trash.push(task.workDir);

    // Request 1 asks; request 2 is the one that carries what the tool produced.
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2);
    const second = adapter.requests[1];
    const withImages = (second?.messages ?? []).filter(
      (m) => (m.images?.length ?? 0) > 0,
    );
    expect(withImages.length).toBe(1);
    const carrier = withImages[0];
    // Images ride as a SIBLING of `content`, never as a union with it — the
    // deliberate divergence in ADR 0080 §2, and the reason compaction, the
    // token estimate and persistence needed no change.
    expect(carrier?.role).toBe("tool");
    expect(typeof carrier?.content).toBe("string");
    expect(carrier?.images?.length).toBe(1);
    const part = carrier?.images?.[0];
    expect(part?.mimeType).toBe("image/png");
    expect(part?.label).toBe("page 1");
    expect(part?.data?.length ?? 0).toBeGreaterThan(10_000);
    // A real PNG, not a placeholder: base64 of the 8-byte signature.
    expect(part?.data?.startsWith("iVBORw0KGgo")).toBe(true);
  });

  it("persists a transcript with NO image bytes in it", async () => {
    const task = await runEvalTask({
      scenario: scenario(),
      paperDir: PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      pdfRenderer: renderer,
    });
    trash.push(task.workDir);

    const jsonl = await persisted(task.workDir);
    // The call and its page report ARE persisted…
    expect(jsonl).toContain("view_pdf_pages");
    // The value-bearing form, as it appears inside the JSONL's own JSON
    // string: `String.raw` rather than a hand-escaped literal.
    expect(jsonl).toContain(String.raw`\"pageCount\":1`);
    // …and the pixels are not. A session file that grew a megabyte per page
    // would make the door unusable long before a context window did.
    expect(jsonl).not.toContain("image/png");
    expect(jsonl).not.toContain("iVBORw0KGgo");
    expect(jsonl.length).toBeLessThan(200_000);
    // The model did answer with the code the stub script says it read, so the
    // absence above is eviction and not a run that never saw a page.
    expect(jsonl).toContain(MARKER);
  });

  it("withholds the tool from a binding that cannot see, and says why", async () => {
    const binding: ModelBinding = {
      protocol: "anthropic",
      endpoint: "",
      model: "claude-sonnet-4-5",
      apiKey: "stub",
      // The operator's explicit *no* on the Models tab, which outranks the
      // capability table's *yes* for this prefix (ADR 0080 §3).
      imageInput: false,
    };
    const adapter = new RecordingStub();
    const task = await runEvalTask({
      scenario: scenario(),
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      binding,
      readOnly: true,
      adapter,
      pdfRenderer: renderer,
    });
    trash.push(task.workDir);

    expect(task.pdf?.withheld).toBe("model_has_no_image_input");
    expect(task.pdf?.source).toBeUndefined();
    // Lock one: the tool was never OFFERED, so a model reading its own tool
    // list could not have asked for it.
    const offered = adapter.requests[0]?.tools ?? [];
    expect(offered.map((t) => t.name)).not.toContain("view_pdf_pages");
    // The stub script asks anyway — it is a fixed list of turns, not a model —
    // and the allowlist refuses it at execution. That refusal is the second
    // half of the lock, and it is why the judge counts calls that RAN.
    expect(deniedCalls(task.outcome.items).length).toBe(
      pdfCalls(task.outcome.items).length,
    );
    expect(deniedCalls(task.outcome.items)[0]?.resultJson).toContain("denied");
    expect(scenario().judge(task.outcome, undefined).pass).toBe(false);
    // No page was ever rendered, so no image could have reached the wire.
    const carried = adapter.requests.flatMap((r) =>
      r.messages.filter((m) => (m.images?.length ?? 0) > 0),
    );
    expect(carried).toEqual([]);
  });

  it("says `no_renderer` rather than running a door with nothing behind it", async () => {
    const task = await runEvalTask({
      scenario: scenario(),
      paperDir: PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      // No `pdfRenderer`.
    });
    trash.push(task.workDir);

    expect(task.pdf?.withheld).toBe("no_renderer");
    expect(task.pdf?.viewed).toEqual([]);
    // Refused at execution, exactly as above — nothing ran.
    expect(deniedCalls(task.outcome.items).length).toBe(
      pdfCalls(task.outcome.items).length,
    );
    // And the judge FAILS the run, instead of passing a scenario that did not
    // do the one thing it exists for.
    expect(scenario().judge(task.outcome, undefined).pass).toBe(false);
  });
});
