/**
 * V4 (ADR 0081; O17, O22): the PDF reviewer in the extension host, end to end.
 *
 * A scripted model and the REAL renderer — the shipped `dist/pdfium.wasm`,
 * through `sharedTaskOptions` — over a temp workspace holding `main.tex` and a
 * `main.pdf` touched newer than it (a copy of the adapters' `simple-en` pair:
 * one page, US Letter, no Author). What is asserted is what the host keeps:
 * the stored review, the tab's state, the charge, and the conversation it
 * stayed out of.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionEvent,
  StoredReview,
} from "@lemmaria/harness";
import { REVIEWER_NAMES } from "@lemmaria/harness";
import * as vscode from "vscode";
import type { ResolvedReviewPanel } from "../src/model";
import { DEFAULT_REVIEW_ROLES } from "../src/review-roles-store";
import type { ReviewTabState, WebviewToHost } from "../src/webview-protocol";

interface PdfApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  sessionEventsForTests(): SessionEvent[];
  resetSessionForTests(): void;
  resetCostForTests(): void;
  sessionUsageForTests(): Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  lastReviewTabStateForTests(): ReviewTabState | undefined;
  persistableReviewsForTests(): StoredReview[];
  setReviewPanelForTests(panel: ResolvedReviewPanel | undefined): void;
  setEngineProbeForTests(fn: (engine: string) => boolean): void;
  clearEngineProbeForTests(): void;
  reviewRolesStoreForTests():
    | import("../src/review-roles-store").ReviewRolesStore
    | undefined;
  modelStoreForTests(): import("../src/model-store").ModelStore | undefined;
  clearModelsForTests(): Promise<void>;
}

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "test",
  "fixtures",
  "review-pdf",
);
const ANCHOR = "Eta theta iota kappa lambda.";

const SONNET: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  apiKey: "k",
};
const HAIKU: ModelBinding = {
  ...SONNET,
  model: "claude-haiku-4-5-20251001",
  imageInput: true,
};

function firstUser(req: GenerateRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  return typeof first?.content === "string" ? first.content : "";
}

function seatOf(req: GenerateRequest): string {
  const text = firstUser(req);
  if (text.includes("`pdf_reviewer`, the one reviewer")) return "pdf";
  for (const name of REVIEWER_NAMES)
    if (text.includes(`\`${name}\`, one of `)) return name;
  return text.includes("reviewers have each read") ? "synthesis" : "";
}

/**
 * Answers by seat. The PDF reviewer views page 1, then files one concern with
 * that page as its evidence; every text reviewer finds nothing; the pre-run
 * check (no brief, key "") is answered with anything.
 */
class PdfSeatModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly seats: string[] = [];
  private pdfTurns = 0;
  private result(req: GenerateRequest): GenerateResult {
    const seat = seatOf(req);
    this.seats.push(seat);
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (seat === "pdf") {
      this.pdfTurns += 1;
      if (this.pdfTurns === 1)
        return {
          text: "",
          toolCalls: [
            { id: "v1", name: "view_pdf_pages", args: { pages: [1] } },
          ],
          stopReason: "tool_use",
          usage,
        };
      return {
        text: JSON.stringify({
          impressions: {},
          annotations: [
            {
              dimension: "presentation",
              severity: "minor",
              anchor: ANCHOR,
              evidence: { page: 1 },
              message: "the verbatim block runs close to the margin",
            },
          ],
        }),
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    }
    return {
      text:
        seat === ""
          ? "ok"
          : JSON.stringify({ annotations: [], impressions: {} }),
      toolCalls: [],
      stopReason: "stop",
      usage,
    };
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.result(req);
  }
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed", result: this.result(req) };
  }
}

async function getApi(): Promise<PdfApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as PdfApi;
}

/** `main.tex` and a `main.pdf` newer than it, opened on the entry. */
async function openPaperWithPdf(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-v4-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const tex = path.join(dir, "main.tex");
  const pdf = path.join(dir, "main.pdf");
  fs.copyFileSync(path.join(FIXTURE, "main.tex"), tex);
  fs.copyFileSync(path.join(FIXTURE, "main.pdf"), pdf);
  // Both times are SET: on Windows a copy keeps its source's mtime, which
  // would make the fixture's PDF older than the manuscript it was built from.
  const past = new Date(Date.now() - 60_000);
  const now = new Date();
  fs.utimesSync(tex, past, past);
  fs.utimesSync(pdf, now, now);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tex));
  await vscode.window.showTextDocument(doc);
  return dir;
}

const reviewsHeld = (api: PdfApi): number =>
  api.lastReviewTabStateForTests()?.history?.length ?? 0;

async function waitFor(
  predicate: () => boolean,
  label: string,
  // The first run in a cold window reads the WASM and the skills; a fresh
  // VS Code build took ~20 s once. The suite allows 60 s a test.
  timeoutMs = 45000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function land(api: PdfApi, msg: WebviewToHost): Promise<unknown> {
  const before = reviewsHeld(api);
  const outcome = await api.dispatchWebviewMessageForTests(msg);
  await waitFor(() => reviewsHeld(api) > before, "the detached run to land");
  return outcome;
}

const newest = (api: PdfApi): StoredReview | undefined =>
  api.persistableReviewsForTests().at(-1);

const PDF_KINDS = ["pdf_unavailable", "visual_unavailable", "pages_unviewed"];

suite("V4: the PDF reviewer in the extension host", function () {
  this.timeout(60000);
  teardown(async () => {
    const api = await getApi();
    api.setReviewPanelForTests(undefined);
    api.clearModelForTests();
    api.clearEngineProbeForTests();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("O17: a typed /review-pdf reads the real PDF, stores a pdf review, and stays out of the conversation", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.resetCostForTests();
    // No compile is wanted: the PDF beside the entry is fresh.
    api.setEngineProbeForTests(() => false);
    const writing = new PdfSeatModel();
    const pdfModel = new PdfSeatModel();
    api.setModelForTests(writing, SONNET);
    api.setReviewPanelForTests({
      reviewers: [{ adapter: writing, binding: SONNET }],
      synthesis: { adapter: writing, binding: SONNET },
      verifier: "off",
      pdfReviewer: { adapter: pdfModel, binding: HAIKU },
    });
    await openPaperWithPdf();

    const outcome = (await land(api, {
      type: "composerSend",
      text: "/review-pdf",
    })) as { status: string };
    assert.strictEqual(outcome.status, "review");

    const stored = newest(api);
    assert.ok(stored, "no review was stored");
    assert.strictEqual(stored.mode, "pdf");
    assert.strictEqual(
      stored.pdf?.source,
      "beside_entry",
      JSON.stringify(stored.result.limits),
    );
    assert.strictEqual(stored.pdf?.path, "main.pdf");
    assert.strictEqual(stored.pdf?.facts.pages, 1);
    assert.strictEqual(stored.pdf?.facts.pageSize.name, "letter");
    assert.strictEqual(stored.pdf?.facts.author, undefined);
    assert.deepStrictEqual(stored.pdf?.viewed, [1]);
    assert.strictEqual(stored.pdfSeat?.model, "claude-haiku-4-5-20251001");
    assert.deepStrictEqual(stored.seats ?? [], []);

    const tab = api.lastReviewTabStateForTests();
    assert.strictEqual(tab?.mode, "pdf");
    assert.deepStrictEqual(
      tab?.annotations.map((a) => [a.id, a.evidence]),
      [["pdf_reviewer-1", { kind: "page", page: 1 }]],
    );

    // The Writing model was never asked; the PDF reviewer's model answered
    // the pre-run check and its two turns.
    assert.deepStrictEqual(writing.seats, []);
    assert.deepStrictEqual(pdfModel.seats, ["", "pdf", "pdf"]);

    // O22: charged once, to the PDF reviewer's model, and to nothing else.
    const usage = api.sessionUsageForTests();
    assert.deepStrictEqual(
      usage.map((u) => [u.model, u.inputTokens, u.outputTokens]),
      [["claude-haiku-4-5-20251001", 3, 3]],
    );

    // Detached: no review item and no message reached the session.
    const kinds = api
      .sessionEventsForTests()
      .flatMap((e) => ("item" in e ? [(e.item as { type: string }).type] : []));
    assert.ok(!kinds.includes("review"), "a review item reached the session");
    assert.ok(!kinds.includes("user_message"), "/review-pdf became a message");
  });

  test("O17: the launcher's Review the PDF reaches the same run", async () => {
    const api = await getApi();
    api.setEngineProbeForTests(() => false);
    const model = new PdfSeatModel();
    api.setModelForTests(model, SONNET);
    api.setReviewPanelForTests({
      reviewers: [{ adapter: model, binding: SONNET }],
      synthesis: { adapter: model, binding: SONNET },
      verifier: "off",
      pdfReviewer: { adapter: model, binding: HAIKU },
    });
    await openPaperWithPdf();
    await land(api, { type: "runReviewPdf" });
    assert.strictEqual(newest(api)?.mode, "pdf");
    assert.strictEqual(newest(api)?.pdfSeat?.status, "completed");
  });

  test("O17: the role turned off — a panel with no PDF record and no PDF limit", async () => {
    const api = await getApi();
    api.setEngineProbeForTests(() => false);
    const model = new PdfSeatModel();
    api.setModelForTests(model, SONNET);
    api.setReviewPanelForTests({
      reviewers: [{ adapter: model, binding: SONNET }],
      synthesis: { adapter: model, binding: SONNET },
      verifier: "off",
      pdfReviewer: "off",
    });
    await openPaperWithPdf();
    await land(api, { type: "runReviewPanel" });
    const stored = newest(api);
    assert.strictEqual(stored?.mode, "panel");
    assert.strictEqual(stored?.pdf, undefined);
    assert.strictEqual(stored?.pdfSeat, undefined);
    assert.deepStrictEqual(
      (stored?.result.limits ?? []).filter((l) => PDF_KINDS.includes(l.kind)),
      [],
    );
    assert.ok(!model.seats.includes("pdf"), "Off still ran a PDF reviewer");
  });

  test("O17: a Writing model that takes no images — the tab says the PDF was not read, and why", async () => {
    const api = await getApi();
    api.setEngineProbeForTests(() => false);
    const model = new PdfSeatModel();
    const blind: ModelBinding = { ...SONNET, imageInput: false };
    api.setModelForTests(model, blind);
    // No `pdfReviewer`: the role's default, the Writing model's own binding.
    api.setReviewPanelForTests({
      reviewers: [{ adapter: model, binding: blind }],
      synthesis: { adapter: model, binding: blind },
      verifier: "off",
    });
    await openPaperWithPdf();
    await land(api, { type: "runReviewPanel" });
    assert.deepStrictEqual(
      (api.lastReviewTabStateForTests()?.limits ?? []).filter((l) =>
        PDF_KINDS.includes(l.kind),
      ),
      [{ kind: "visual_unavailable", reason: "model_has_no_image_input" }],
    );
    assert.ok(!model.seats.includes("pdf"));
  });

  test("V6's E1 round: Review the PDF with the PDF reviewer Off refuses, stores nothing and spends no version", async () => {
    // The 中文 window stored `seats: []` and no limit from this click, used
    // up a version number, and the tab then blamed an unreadable ledger.
    const api = await getApi();
    api.setEngineProbeForTests(() => false);
    const model = new PdfSeatModel();
    api.setModelForTests(model, SONNET);
    api.setReviewPanelForTests({
      reviewers: [],
      synthesis: { adapter: model, binding: SONNET },
      verifier: "off",
      pdfReviewer: "off",
    });
    await openPaperWithPdf();
    const before = api.persistableReviewsForTests().length;
    const outcome = (await api.dispatchWebviewMessageForTests({
      type: "runReviewPdf",
    })) as { status: string };
    assert.deepStrictEqual(outcome, { status: "pdf-reviewer-off" });
    // The refusal holds no run: asked again, it refuses again, not `busy`.
    assert.deepStrictEqual(
      await api.dispatchWebviewMessageForTests({ type: "runReviewPdf" }),
      { status: "pdf-reviewer-off" },
      "the refusal left a run held",
    );
    // Typed, the same function answers — and stores nothing either.
    await api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "/review-pdf",
    });
    // Give a wrongly-started run the time to land, then check none did.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(api.persistableReviewsForTests().length, before);
    assert.deepStrictEqual(model.seats, [], "no model was asked anything");
  });

  test("the code review: a role Review the PDF never seats cannot refuse it", async () => {
    const api = await getApi();
    api.setEngineProbeForTests(() => false);
    const model = new PdfSeatModel();
    api.setModelForTests(model, SONNET);
    await api.clearModelsForTests();
    const models = api.modelStoreForTests();
    const roles = api.reviewRolesStoreForTests();
    assert.ok(models && roles);
    // A reviewer pointed at a model with no key: a panel cannot run.
    const keyless = await models.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "claude-haiku-4-5-20251001",
      },
      "",
    );
    await roles.set({
      ...DEFAULT_REVIEW_ROLES,
      reviewers: ["", keyless.id],
    });
    try {
      await openPaperWithPdf();
      const panel = (await api.dispatchWebviewMessageForTests({
        type: "runReviewPanel",
      })) as { status: string; role?: string };
      assert.deepStrictEqual(panel, {
        status: "no-reviewer-model",
        role: "reviewer_b",
      });
      // The PDF review seats only the PDF reviewer — Writing's, by default.
      const outcome = (await land(api, { type: "runReviewPdf" })) as {
        status: string;
      };
      assert.strictEqual(outcome.status, "started");
      const stored = newest(api);
      assert.strictEqual(stored?.mode, "pdf");
      assert.strictEqual(stored?.pdfSeat?.model, "claude-sonnet-4-5");
    } finally {
      await roles.set(DEFAULT_REVIEW_ROLES);
      await api.clearModelsForTests();
    }
  });
});
