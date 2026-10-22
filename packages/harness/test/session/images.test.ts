/**
 * V3 (O4, O9): the door, end to end on a recorder.
 *
 * Three properties the unit tests cannot see between them, asserted here under
 * a real `runSessionTask` against `ScriptedModelAdapter`, which records every
 * `GenerateRequest` verbatim — the cheapest place to assert a wire shape with
 * no network:
 *
 *  1. a task on a binding that CAN see is offered the spec, and the request
 *     after the tool call carries the image;
 *  2. the same task on a binding that cannot is offered no spec and receives
 *     no image — the allowlist lock and the wire lock, composed;
 *  3. nothing that reaches a real `SessionStore` contains a pixel.
 *
 * Nothing under `src/` is written for this file; it is a composition test.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ModelBinding,
  PdfDocument,
  SessionEvent,
  ToolName,
} from "../../src/contracts/index.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import { withholdImageTools } from "../../src/model/capabilities.js";
import {
  ScriptedModelAdapter,
  type ScriptedTurn,
} from "../../src/model/scripted.js";
import { createViewPdfPagesTool } from "../../src/session/loop-tools/pdf-pages.js";
import { runSessionTask } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";

const PNG_SIGNATURE_B64 = "iVBORw0KGgo";
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A one-page document whose PNG begins with the real PNG signature. */
function onePageDocument(): PdfDocument {
  return {
    pageCount: 1,
    pageSize: () => ({ width: 612, height: 792 }),
    renderPage: async (_page, opts) => ({
      // \x89PNG\r\n\x1a\n — so a base64 search for the signature is meaningful.
      png: new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02,
      ]),
      width: opts.width,
      height: Math.round(opts.width * (792 / 612)),
    }),
    pageText: async () => "LEMMARIA-MARKER-7F3A",
    metadata: async () => ({ producer: "pdfTeX" }),
    close: () => {},
  };
}

const TURNS: ScriptedTurn[] = [
  {
    text: "",
    toolCalls: [{ id: "c1", name: "view_pdf_pages", args: { pages: [1] } }],
    stopReason: "tool_use",
  },
  { text: "I can see the marker.", stopReason: "stop" },
];

/** The turns a blind model runs: it is never offered the tool, so it answers. */
const BLIND_TURNS: ScriptedTurn[] = [
  { text: "I was not shown a page.", stopReason: "stop" },
];

async function runWithBinding(opts: {
  binding: ModelBinding;
  turns: ScriptedTurn[];
}): Promise<{
  model: ScriptedModelAdapter;
  sessionsDir: string;
  events: SessionEvent[];
}> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-images-"));
  dirs.push(dir);
  const sessionsDir = join(dir, "sessions");
  const store = new SessionStore(sessionsDir);
  const session = await store.create({ title: "visual", workspace: "/w" });
  const model = new ScriptedModelAdapter(opts.turns);
  const events: SessionEvent[] = [];

  const { executor } = createViewPdfPagesTool({ document: onePageDocument() });
  const registry = new Map<ToolName, ToolExecutor>([
    ["view_pdf_pages", executor],
  ]);
  // How the eval — and, in V4, the panel driver — composes the allowlist lock.
  const allowedTools = withholdImageTools(["view_pdf_pages"], opts.binding);

  await runSessionTask({
    store,
    session,
    model,
    binding: opts.binding,
    registry,
    allowedTools,
    text: "Look at page 1 and tell me what the framed box says.",
    onEvent: (e) => events.push(e),
  });

  return { model, sessionsDir, events };
}

const seeing: ModelBinding = {
  protocol: "openai-compatible",
  endpoint: "https://openai.test/v1",
  model: "gpt-5.6-luna", // matches the `gpt-5` row S6 measured seeing
  apiKey: "k",
};

describe("a task on a model that CAN see (V3, O9)", () => {
  it("is offered the spec, and its next request carries one labelled PNG part", async () => {
    const { model } = await runWithBinding({ binding: seeing, turns: TURNS });

    // Offered: the spec reached the model on the very first request. (The
    // loop also injects update_plan and spawn_subtask for any non-empty
    // registry; what this asserts is that the IMAGE tool is among them.)
    expect(model.requests[0]?.tools?.map((t) => t.name)).toContain(
      "view_pdf_pages",
    );

    // Carried: the SECOND request holds the tool message with the image.
    const second = model.requests[1];
    const toolMessage = second?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.images).toHaveLength(1);
    expect(toolMessage?.images?.[0]?.label).toBe("page 1");
    expect(toolMessage?.images?.[0]?.mimeType).toBe("image/png");
    expect(toolMessage?.images?.[0]?.data).toContain(PNG_SIGNATURE_B64);
    // …and its text is still the tool's JSON, unchanged.
    expect(toolMessage?.content).toContain('"viewsRemaining"');
  });

  it("writes no pixel into the persisted session (O4)", async () => {
    const { sessionsDir } = await runWithBinding({
      binding: seeing,
      turns: TURNS,
    });
    const files = await readdir(sessionsDir, { recursive: true });
    const jsonl = files.filter((f) => String(f).endsWith(".jsonl"));
    expect(jsonl.length).toBeGreaterThan(0);
    for (const f of jsonl) {
      const text = await readFile(join(sessionsDir, String(f)), "utf8");
      expect(text).not.toContain(PNG_SIGNATURE_B64);
      expect(text).not.toContain("data:image");
      expect(text).not.toContain('"images"');
      // The tool_call row IS there — it just carries the JSON only.
      expect(text).toContain("view_pdf_pages");
      expect(text).toContain("viewsRemaining");
    }
  });
});

describe("a task on a model that CANNOT see (V3, O9)", () => {
  it("an explicit imageInput: false is offered no spec at all", async () => {
    const { model } = await runWithBinding({
      binding: { ...seeing, imageInput: false },
      turns: BLIND_TURNS,
    });
    expect(model.requests[0]?.tools?.map((t) => t.name) ?? []).not.toContain(
      "view_pdf_pages",
    );
    const body = JSON.stringify(model.requests);
    expect(body).not.toContain(PNG_SIGNATURE_B64);
  });

  it("an UNKNOWN model id with no override is offered nothing — deny by default", async () => {
    const { model } = await runWithBinding({
      // No prefix in the table matches this; unknown is `false`.
      binding: { ...seeing, model: "mystery-1" },
      turns: BLIND_TURNS,
    });
    expect(model.requests[0]?.tools?.map((t) => t.name) ?? []).not.toContain(
      "view_pdf_pages",
    );
  });

  it("an override can open the door for an endpoint nobody has heard of", async () => {
    const { model } = await runWithBinding({
      binding: { ...seeing, model: "mystery-1", imageInput: true },
      turns: TURNS,
    });
    expect(model.requests[0]?.tools?.map((t) => t.name)).toContain(
      "view_pdf_pages",
    );
    const toolMessage = model.requests[1]?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.images?.[0]?.data).toContain(PNG_SIGNATURE_B64);
  });
});
