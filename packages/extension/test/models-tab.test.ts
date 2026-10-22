// U3 acceptance surface: the Models tab wires the existing settings /
// SecretStorage / cost state into the webview. These tests drive the HOST
// seams (the browser bundle has no test runner per ADR 0001); rendering is
// covered by the manual checklist + the U0 round-trip + check:boundaries.
// All offline: the model is a deterministic in-test adapter.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import {
  type CompileProjectOptions,
  type CompileResult,
  type GenerateRequest,
  type GenerateResult,
  MAX_FAN_OUT,
  type ModelAdapter,
  type ModelBinding,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { ResolvedReviewPanel, ReviewPanelResolution } from "../src/model";
import {
  DEFAULT_REVIEW_ROLES,
  PDF_REVIEWER_OFF,
  type ReviewRoles,
  type ReviewRolesStore,
  VERIFIER_OFF,
} from "../src/review-roles-store";
import type { SharedTaskOptions } from "../src/session/task-options";
import type { ModelsState, WebviewToHost } from "../src/webview-protocol";

interface ModelsApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  computeInitStateForTests(): { model: { name: string; configured: boolean } };
  clearModelForTests(): void;
  resetCostForTests(): void;
  sessionUsageForTests(): Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  computeModelsStateForTests(): Promise<ModelsState>;
  lastModelsStateForTests(): ModelsState | undefined;
  modelStoreForTests(): import("../src/model-store").ModelStore | undefined;
  clearModelsForTests(): Promise<void>;
  resolveModelForTests(): Promise<ModelBinding | undefined>;
  // R9 (ADR 0069 §D8).
  reviewRolesStoreForTests(): ReviewRolesStore | undefined;
  resolveReviewPanelForTests(): Promise<ReviewPanelResolution>;
  syncedGlobalKeysForTests(): string[];
}

/** V4 (ADR 0081): the seams the PDF reviewer's role tests add. */
interface PdfRoleApi {
  sharedTaskOptionsForTests(
    paper: { root: string; entry: string } | undefined,
    panel?: ResolvedReviewPanel,
  ): Promise<SharedTaskOptions>;
  setCompileForTests(
    fn: (opts: CompileProjectOptions) => Promise<CompileResult>,
  ): void;
  clearCompileForTests(): void;
  setEngineProbeForTests(fn: (engine: string) => boolean): void;
  clearEngineProbeForTests(): void;
}

/** Deterministic in-test model (the U1 pattern): replies texts[i] on call i. */
class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(private readonly texts: string[]) {}
  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const text = this.texts[Math.min(this.i, this.texts.length - 1)] ?? "";
    this.i += 1;
    return Promise.resolve({
      text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  }
}

async function getApi(): Promise<ModelsApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as ModelsApi;
}

async function writeTexWith(name: string, body: string): Promise<vscode.Uri> {
  const doc = `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const uri = vscode.Uri.file(
    path.join(
      os.tmpdir(),
      `lemmaria-u3-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
    ),
  );
  await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, "utf8"));
  return uri;
}

async function pollFor(
  cond: () => boolean,
  what: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite("U3: per-model session usage", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("a quick-action run tallies session tokens under the bound model", async () => {
    const api = await getApi();
    api.resetCostForTests();
    api.setModelForTests(new TestModel(["Polished text."]), {
      protocol: "anthropic",
      endpoint: "stub://",
      model: "test-model-u3",
      apiKey: "k",
    });
    try {
      const uri = await writeTexWith("u3-usage.tex", "Hello usage world.");
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 0, 2, 18);
      await api.dispatchWebviewMessageForTests({
        type: "runQuickAction",
        actionId: "polish",
      });
      const rows = api.sessionUsageForTests();
      const row = rows.find((r) => r.model === "test-model-u3");
      assert.ok(
        row,
        `expected a session row for test-model-u3, got ${JSON.stringify(rows)}`,
      );
      assert.ok(row.inputTokens >= 7, "input tokens tallied");
      assert.ok(row.outputTokens >= 3, "output tokens tallied");
    } finally {
      api.clearModelForTests();
      api.resetCostForTests();
    }
  });
});

suite("revised-U3: models state (list)", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("requestModels reports an empty list and the provider presets", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const state = (await api.dispatchWebviewMessageForTests({
      type: "requestModels",
    })) as ModelsState;
    assert.deepStrictEqual(state.models, []);
    assert.strictEqual(state.activeModelId, undefined);
    const ids = state.providers.map((p) => p.id);
    assert.ok(ids.includes("anthropic") && ids.includes("openai"));
    await api.clearModelsForTests();
  });

  test("computeModelsState reflects a stored model with keyPresent + active", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const store = api.modelStoreForTests();
    assert.ok(store);
    const m = await store.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "claude-y",
      },
      "sk-y",
    );
    const state = await api.computeModelsStateForTests();
    const row = state.models.find((x) => x.id === m.id);
    assert.ok(row);
    assert.strictEqual(row.model, "claude-y");
    assert.strictEqual(row.providerLabel, "Anthropic");
    assert.strictEqual(row.keyPresent, true);
    assert.strictEqual(row.active, true);
    assert.strictEqual(state.activeModelId, m.id);
    await api.clearModelsForTests();
  });

  test("a recorded run pushes a models state carrying the session row", async () => {
    const api = await getApi();
    api.resetCostForTests();
    api.setModelForTests(new TestModel(["Polished again."]), {
      protocol: "anthropic",
      endpoint: "stub://",
      model: "test-model-u3-push",
      apiKey: "k",
    });
    try {
      const uri = await writeTexWith("u3-push.tex", "Push me, please.");
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 0, 2, 15);
      await api.dispatchWebviewMessageForTests({
        type: "runQuickAction",
        actionId: "polish",
      });
      await pollFor(
        () =>
          api
            .lastModelsStateForTests()
            ?.session.some((r) => r.model === "test-model-u3-push") ?? false,
        "models state push after a recorded run",
      );
    } finally {
      api.clearModelForTests();
      api.resetCostForTests();
    }
  });
});

suite("revised-U3: model CRUD via dispatch", function () {
  this.timeout(30000);

  test("addModel stores a model + key and pushes it as keyPresent", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    await api.dispatchWebviewMessageForTests({
      type: "addModel",
      provider: "openai",
      model: "gpt-add",
      endpoint: "",
      apiKey: "sk-add",
    });
    const state = api.lastModelsStateForTests();
    const row = state?.models.find((m) => m.model === "gpt-add");
    assert.ok(row, "added model present in pushed state");
    assert.strictEqual(row.keyPresent, true);
    assert.strictEqual(row.protocol, "openai-compatible");
    // endpoint "" resolves to the preset default
    assert.strictEqual(row.endpoint, "https://api.openai.com/v1");
    await api.clearModelsForTests();
  });

  test("setActiveModel makes getModel return that binding", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const store = api.modelStoreForTests();
    assert.ok(store);
    await store.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "a",
      },
      "ka",
    );
    const b = await store.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "b",
      },
      "kb",
    );
    await api.dispatchWebviewMessageForTests({
      type: "setActiveModel",
      id: b.id,
    });
    assert.strictEqual(api.lastModelsStateForTests()?.activeModelId, b.id);
    await api.clearModelsForTests();
  });

  test("removeModel drops it and reassigns active", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const store = api.modelStoreForTests();
    assert.ok(store);
    const a = await store.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "a",
      },
      "ka",
    );
    const b = await store.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "b",
      },
      "kb",
    );
    await api.dispatchWebviewMessageForTests({
      type: "removeModel",
      id: a.id,
    });
    const state = api.lastModelsStateForTests();
    assert.strictEqual(state?.models.length, 1);
    assert.strictEqual(state?.activeModelId, b.id);
    await api.clearModelsForTests();
  });
});

suite(
  "ADR 0064 §4: the composer's model chip names what will RUN",
  function () {
    this.timeout(30000);

    test("init reads the STORE, not the legacy lemmaria.model.model setting", async () => {
      // The bug the R3 gate-review reported: a window opened with the chip
      // naming one model while the Models tab named another, and the chip
      // silently corrected itself the first time that tab was visited (which
      // pushes `modelsState`). `computeInitState` read `lemmaria.model.model`;
      // `getModel` — what actually binds a turn — reads `store.active()`. The
      // one-time migration RETAINS the legacy setting as a rollback net, so it
      // keeps naming the pre-store model forever while every model added since
      // changes only the store. The two therefore disagree in the ORDINARY
      // case, not an edge one.
      const api = await getApi();
      await api.clearModelsForTests();
      const cfg = vscode.workspace.getConfiguration("lemmaria.model");
      const before = cfg.get<string>("model", "");
      await cfg.update("model", "legacy-stale-4-mini", true);
      try {
        const store = api.modelStoreForTests();
        assert.ok(store);
        await store.add(
          {
            provider: "anthropic",
            protocol: "anthropic",
            endpoint: "",
            model: "the-one-that-runs",
          },
          "k",
        );
        assert.strictEqual(
          api.computeInitStateForTests().model.name,
          "the-one-that-runs",
          "the chip named the legacy setting instead of the active model",
        );
        assert.strictEqual(
          api.computeInitStateForTests().model.configured,
          true,
        );

        // And with NO model in the store the chip says nothing rather than
        // resurrecting the legacy name — "not configured" is the honest answer
        // when nothing will run.
        await api.clearModelsForTests();
        assert.strictEqual(api.computeInitStateForTests().model.name, "");
        assert.strictEqual(
          api.computeInitStateForTests().model.configured,
          false,
        );
      } finally {
        await cfg.update("model", before === "" ? undefined : before, true);
        await api.clearModelsForTests();
      }
    });
  },
);

/**
 * R9 (ADR 0069 §D8): the review roles — the store the Models tab's Reviewers
 * and Cross-review cards edit, and the resolver that turns them into the
 * bindings the panel's children actually run on.
 *
 * These drive the HOST seams, like every suite above: a role that is a stored
 * model id is only meaningful next to `ModelStore`, and the refusal path is
 * the host's alone (the harness never sees an unbound reviewer — that is the
 * point of refusing before the send).
 */
suite("R9: the review roles store and resolver", function () {
  // V1 (ADR 0076 §8): the roles value gained `verifier`, so every literal
  // below carries its default, `""`. No expectation changed with it. V4 (ADR
  // 0081 §8): and `pdfReviewer`, the same way and with the same default.
  this.timeout(30000);
  suiteTeardown(async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    await api.reviewRolesStoreForTests()?.set(DEFAULT_REVIEW_ROLES);
  });

  test("O10: the store defaults to three, round-trips, clamps, and prunes", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const roles = api.reviewRolesStoreForTests();
    assert.ok(roles, "the review roles store was never registered");
    await roles.set(DEFAULT_REVIEW_ROLES);
    assert.deepStrictEqual(
      roles.get(),
      { reviewers: ["", "", ""], synthesis: "", verifier: "", pdfReviewer: "" },
      "D2's default, said in the host's terms",
    );

    const models = api.modelStoreForTests();
    assert.ok(models);
    const haiku = await models.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "claude-haiku-4-5-20251001",
      },
      "k",
    );
    await roles.set({
      reviewers: ["", haiku.id],
      synthesis: haiku.id,
      verifier: "",
      pdfReviewer: "",
    });
    assert.deepStrictEqual(roles.get(), {
      reviewers: ["", haiku.id],
      synthesis: haiku.id,
      verifier: "",
      pdfReviewer: "",
    });

    // Invariant 5: a host can only ask for LESS than the harness allows. The
    // store clamps at its own edge so a card that lost its disabled state
    // cannot post twelve reviewers and have the driver silently drop four.
    await roles.set({
      reviewers: new Array(12).fill(""),
      synthesis: "",
      verifier: "",
      pdfReviewer: "",
    });
    assert.strictEqual(roles.get().reviewers.length, 8);
    await roles.set({
      reviewers: [],
      synthesis: "",
      verifier: "",
      pdfReviewer: "",
    });
    assert.strictEqual(roles.get().reviewers.length, 1);

    // An id that leaves ModelStore reads back as "" — a reviewer never
    // dangles, and "same as Writing" is the honest reading of a model the
    // user just deleted.
    await roles.set({
      reviewers: ["", haiku.id],
      synthesis: haiku.id,
      verifier: "",
      pdfReviewer: "",
    });
    await models.remove(haiku.id);
    assert.deepStrictEqual(roles.get(), {
      reviewers: ["", ""],
      synthesis: "",
      verifier: "",
      pdfReviewer: "",
    });

    // Synced with the models list (the keys travel together or a synced
    // install gets roles pointing at models it does not have).
    assert.ok(
      api.syncedGlobalKeysForTests().includes("lemmaria.reviewRoles.v1"),
      "the roles key was not opted into Settings Sync",
    );
  });

  test("O11: the resolver binds every role, and names the first it cannot", async () => {
    const api = await getApi();
    api.clearModelForTests();
    await api.clearModelsForTests();
    const models = api.modelStoreForTests();
    const roles = api.reviewRolesStoreForTests();
    assert.ok(models);
    assert.ok(roles);
    await roles.set(DEFAULT_REVIEW_ROLES);

    // Nothing active: the FIRST reviewer is what cannot be bound, because
    // every default entry means "same as Writing" and there is no Writing.
    assert.deepStrictEqual(await api.resolveReviewPanelForTests(), {
      unbound: 0,
      role: "reviewer_a",
    });

    const writing = await models.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "claude-sonnet-4-5",
      },
      "k1",
    );
    await models.setActive(writing.id);
    const luna = await models.add(
      {
        provider: "openai",
        protocol: "openai-compatible",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-5.6-luna",
      },
      "k2",
    );

    const same = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in same, "three empty roles should have resolved");
    assert.deepStrictEqual(
      same.reviewers.map((c) => c.binding.model),
      ["claude-sonnet-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5"],
    );
    assert.strictEqual(same.synthesis.binding.model, "claude-sonnet-4-5");

    // A stored id on the OTHER protocol brings its own adapter and its own
    // key — the whole point of the milestone.
    await roles.set({
      reviewers: ["", luna.id],
      synthesis: luna.id,
      verifier: "",
      pdfReviewer: "",
    });
    const mixed = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in mixed, "a stored id should have resolved");
    assert.strictEqual(mixed.reviewers[0]?.binding.model, "claude-sonnet-4-5");
    assert.strictEqual(mixed.reviewers[1]?.binding.model, "gpt-5.6-luna");
    assert.strictEqual(
      mixed.reviewers[1]?.binding.protocol,
      "openai-compatible",
    );
    assert.strictEqual(
      mixed.reviewers[1]?.binding.endpoint,
      "https://api.openai.com/v1",
    );
    assert.strictEqual(mixed.reviewers[1]?.binding.apiKey, "k2");
    assert.strictEqual(
      mixed.reviewers[1]?.adapter.protocol,
      "openai-compatible",
    );
    assert.strictEqual(mixed.synthesis.adapter.protocol, "openai-compatible");

    // A model whose preset requires a key and has none is a REFUSAL, not a
    // fallback: a panel that quietly ran the Writing model where the card
    // shows another is worse than one that does not run.
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
      reviewers: ["", keyless.id, ""],
      synthesis: "",
      verifier: "",
      pdfReviewer: "",
    });
    assert.deepStrictEqual(await api.resolveReviewPanelForTests(), {
      unbound: 1,
      role: "reviewer_b",
    });

    // The cross-review is the last role checked, and it is named as itself.
    await roles.set({
      reviewers: ["", ""],
      synthesis: keyless.id,
      verifier: "",
      pdfReviewer: "",
    });
    assert.deepStrictEqual(await api.resolveReviewPanelForTests(), {
      unbound: 2,
      role: "synthesis",
    });

    await api.clearModelsForTests();
    await roles.set(DEFAULT_REVIEW_ROLES);
  });

  test("O12: setReviewRoles persists, and every models state carries it", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const models = api.modelStoreForTests();
    assert.ok(models);
    const m = await models.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "claude-haiku-4-5-20251001",
      },
      "k",
    );

    await api.dispatchWebviewMessageForTests({
      type: "setReviewRoles",
      reviewers: ["", m.id, ""],
      synthesis: m.id,
      verifier: "",
      pdfReviewer: "",
    });
    const roles = api.reviewRolesStoreForTests();
    assert.ok(roles);
    assert.deepStrictEqual(roles.get(), {
      reviewers: ["", m.id, ""],
      synthesis: m.id,
      verifier: "",
      pdfReviewer: "",
    });
    // The dispatch pushes, so the live webview is told without asking.
    assert.deepStrictEqual(api.lastModelsStateForTests()?.reviewRoles, {
      reviewers: ["", m.id, ""],
      synthesis: m.id,
      verifier: "",
      pdfReviewer: "",
    });
    // And a cold `requestModels` carries the same thing.
    const asked = (await api.dispatchWebviewMessageForTests({
      type: "requestModels",
    })) as ModelsState;
    assert.deepStrictEqual(asked.reviewRoles, {
      reviewers: ["", m.id, ""],
      synthesis: m.id,
      verifier: "",
      pdfReviewer: "",
    });

    // The card draws its row count against this, and the webview cannot
    // import MAX_FAN_OUT (ADR 0011), so the number crossing here IS the
    // clamp the user sees. A drift would let the card offer rows the
    // harness would silently drop (invariant 5).
    assert.strictEqual(asked.maxReviewers, MAX_FAN_OUT);
    assert.strictEqual(MAX_FAN_OUT, 8);

    // The pruning read is what the webview gets, so a deleted model never
    // reaches the card as a selected option it cannot draw.
    await models.remove(m.id);
    const pruned = await api.computeModelsStateForTests();
    assert.deepStrictEqual(pruned.reviewRoles, {
      reviewers: ["", "", ""],
      synthesis: "",
      verifier: "",
      pdfReviewer: "",
    });
  });
});

suite("V1: the verifier is a role (ADR 0076 §8)", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    await api.reviewRolesStoreForTests()?.set(DEFAULT_REVIEW_ROLES);
  });

  test("O16: verifier defaults to same-as-cross-review, keeps Off, and prunes a dangling id", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const roles = api.reviewRolesStoreForTests();
    const models = api.modelStoreForTests();
    assert.ok(roles);
    assert.ok(models);
    await roles.set(DEFAULT_REVIEW_ROLES);
    assert.strictEqual(roles.get().verifier, "");
    // Model ids are UUIDs, so the sentinel cannot be one.
    assert.strictEqual(VERIFIER_OFF, "off");

    const m = await models.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "claude-haiku-4-5-20251001",
      },
      "k",
    );
    await roles.set({
      reviewers: [""],
      synthesis: "",
      verifier: m.id,
      pdfReviewer: "",
    });
    assert.strictEqual(roles.get().verifier, m.id);

    // Off survives the pruning read and the persisted prune — but only in
    // the verifier's field: "off" is not a model any other role can name.
    // (V4: and the PDF reviewer's — held at its default here; its own Off is
    // asserted in the V4 suite.)
    await roles.set({
      reviewers: ["off"],
      synthesis: "off",
      verifier: "off",
      pdfReviewer: "",
    });
    assert.deepStrictEqual(roles.get(), {
      reviewers: [""],
      synthesis: "",
      verifier: "off",
      pdfReviewer: "",
    });
    await roles.pruneRemovedModels();
    assert.strictEqual(roles.get().verifier, "off");

    // A removed model's id reads back as the default, like every role's.
    await roles.set({
      reviewers: [""],
      synthesis: "",
      verifier: m.id,
      pdfReviewer: "",
    });
    await models.remove(m.id);
    assert.strictEqual(roles.get().verifier, "");

    // A value stored before V1 has no field at all, and reads as the default
    // — no `.v2` key, no migration. So does a value that is not a string.
    await roles.set({
      reviewers: [""],
      synthesis: "",
    } as unknown as ReviewRoles);
    assert.strictEqual(roles.get().verifier, "");
    await roles.set({
      reviewers: [""],
      synthesis: "",
      verifier: 7,
    } as unknown as ReviewRoles);
    assert.strictEqual(roles.get().verifier, "");
  });

  test("O16: setReviewRoles carries the verifier, and every models state says so", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    await api.dispatchWebviewMessageForTests({
      type: "setReviewRoles",
      reviewers: ["", ""],
      synthesis: "",
      verifier: "off",
      pdfReviewer: "",
    });
    assert.strictEqual(api.reviewRolesStoreForTests()?.get().verifier, "off");
    assert.strictEqual(
      api.lastModelsStateForTests()?.reviewRoles.verifier,
      "off",
    );
    const asked = (await api.dispatchWebviewMessageForTests({
      type: "requestModels",
    })) as ModelsState;
    assert.strictEqual(asked.reviewRoles.verifier, "off");
  });

  test("O17: the resolver gives the cross-review's own model, Off, a bound model, or a refusal naming the verifier", async () => {
    const api = await getApi();
    api.clearModelForTests();
    await api.clearModelsForTests();
    const models = api.modelStoreForTests();
    const roles = api.reviewRolesStoreForTests();
    assert.ok(models);
    assert.ok(roles);
    const writing = await models.add(
      {
        provider: "anthropic",
        protocol: "anthropic",
        endpoint: "",
        model: "claude-sonnet-4-5",
      },
      "k1",
    );
    await models.setActive(writing.id);
    const luna = await models.add(
      {
        provider: "openai",
        protocol: "openai-compatible",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-5.6-luna",
      },
      "k2",
    );

    // "" is the ALREADY-RESOLVED cross-review, not a second bind: they are one
    // model and must be asked the pre-run check as one.
    await roles.set({
      reviewers: ["", ""],
      synthesis: luna.id,
      verifier: "",
      pdfReviewer: "",
    });
    const same = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in same, "the default verifier should have resolved");
    assert.strictEqual(same.verifier, same.synthesis);

    await roles.set({
      reviewers: ["", ""],
      synthesis: "",
      verifier: "off",
      pdfReviewer: "",
    });
    const off = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in off);
    assert.strictEqual(off.verifier, "off");

    await roles.set({
      reviewers: ["", ""],
      synthesis: "",
      verifier: luna.id,
      pdfReviewer: "",
    });
    const own = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in own);
    assert.ok(own.verifier !== "off");
    assert.strictEqual(own.verifier.binding.model, "gpt-5.6-luna");
    assert.strictEqual(own.verifier.binding.apiKey, "k2");
    assert.strictEqual(own.verifier.adapter.protocol, "openai-compatible");
    assert.strictEqual(own.synthesis.binding.model, "claude-sonnet-4-5");

    // A verifier that cannot be bound refuses the panel, named as itself and
    // indexed one past the cross-review.
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
      reviewers: ["", "", ""],
      synthesis: "",
      verifier: keyless.id,
      pdfReviewer: "",
    });
    assert.deepStrictEqual(await api.resolveReviewPanelForTests(), {
      unbound: 4,
      role: "verifier",
    });

    await api.clearModelsForTests();
    await roles.set(DEFAULT_REVIEW_ROLES);
  });
});

suite("V3: image input is a per-model override (ADR 0080 §6)", function () {
  this.timeout(30000);

  /** Add one model and return its id. */
  async function addModel(api: ModelsApi, model: string): Promise<string> {
    const store = api.modelStoreForTests();
    assert.ok(store);
    await store.add(
      {
        provider: "openai",
        protocol: "openai-compatible",
        endpoint: "",
        model,
      },
      "sk-v3",
    );
    const row = store.list().find((m) => m.model === model);
    assert.ok(row, `model ${model} should be stored`);
    return row.id;
  }

  test("the pushed row carries the override AND what the table would say", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    // `gpt-5.6-luna` matches the `gpt-5` row the table says CAN see; a model
    // id nobody has heard of cannot.
    await addModel(api, "gpt-5.6-luna");
    await addModel(api, "mystery-1");
    const state = await api.computeModelsStateForTests();

    const seeing = state.models.find((m) => m.model === "gpt-5.6-luna");
    const unknown = state.models.find((m) => m.model === "mystery-1");
    assert.strictEqual(seeing?.imageInputDefault, true);
    assert.strictEqual(unknown?.imageInputDefault, false);
    // No override stored yet, on either.
    assert.strictEqual(seeing?.imageInput, undefined);
    assert.strictEqual(unknown?.imageInput, undefined);
    await api.clearModelsForTests();
  });

  test("setModelImageInput persists yes / no / auto and re-pushes", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const id = await addModel(api, "mystery-2");

    await api.dispatchWebviewMessageForTests({
      type: "setModelImageInput",
      id,
      value: "yes",
    });
    let row = api.lastModelsStateForTests()?.models.find((m) => m.id === id);
    assert.strictEqual(row?.imageInput, true, "yes stores true");

    await api.dispatchWebviewMessageForTests({
      type: "setModelImageInput",
      id,
      value: "no",
    });
    row = api.lastModelsStateForTests()?.models.find((m) => m.id === id);
    assert.strictEqual(row?.imageInput, false, "no stores false");

    await api.dispatchWebviewMessageForTests({
      type: "setModelImageInput",
      id,
      value: "auto",
    });
    row = api.lastModelsStateForTests()?.models.find((m) => m.id === id);
    assert.strictEqual(
      row?.imageInput,
      undefined,
      "auto clears the override entirely",
    );
    await api.clearModelsForTests();
  });

  test("the override round-trips through the store, not only the push", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const id = await addModel(api, "mystery-3");
    const store = api.modelStoreForTests();
    assert.ok(store);

    await store.setImageInput(id, false);
    assert.strictEqual(
      store.list().find((m) => m.id === id)?.imageInput,
      false,
    );
    await store.setImageInput(id, undefined);
    assert.strictEqual(
      "imageInput" in (store.list().find((m) => m.id === id) ?? {}),
      false,
      "auto removes the field rather than storing a third value",
    );
    await api.clearModelsForTests();
  });

  test("the override reaches the BINDING, which is what the wire reads", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const id = await addModel(api, "mystery-4");
    const store = api.modelStoreForTests();
    assert.ok(store);
    await store.setActive(id);

    // Without an override the binding says nothing and the table decides.
    let binding = await api.resolveModelForTests();
    assert.strictEqual(binding?.imageInput, undefined);

    await store.setImageInput(id, true);
    binding = await api.resolveModelForTests();
    assert.strictEqual(
      binding?.imageInput,
      true,
      "an endpoint nobody has heard of can be opened by hand",
    );
    await api.clearModelsForTests();
  });
});

suite("V4: the PDF reviewer is a role (ADR 0081 §8)", function () {
  this.timeout(60000);
  suiteTeardown(async () => {
    const api = (await getApi()) as ModelsApi & PdfRoleApi;
    await api.clearModelsForTests();
    await api.reviewRolesStoreForTests()?.set(DEFAULT_REVIEW_ROLES);
    api.clearCompileForTests();
    api.clearEngineProbeForTests();
  });

  const haiku = {
    provider: "anthropic",
    protocol: "anthropic" as const,
    endpoint: "",
    model: "claude-haiku-4-5-20251001",
  };

  test("O14: defaults to same-as-Writing, keeps Off, prunes a dangling id, and reads a 0.3.x value as the default", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const roles = api.reviewRolesStoreForTests();
    const models = api.modelStoreForTests();
    assert.ok(roles);
    assert.ok(models);
    await roles.set(DEFAULT_REVIEW_ROLES);
    assert.strictEqual(roles.get().pdfReviewer, "");
    // One literal for both roles that may be off.
    assert.strictEqual(PDF_REVIEWER_OFF, VERIFIER_OFF);

    const m = await models.add(haiku, "k");
    await roles.set({ ...DEFAULT_REVIEW_ROLES, pdfReviewer: m.id });
    assert.strictEqual(roles.get().pdfReviewer, m.id);

    await roles.set({ ...DEFAULT_REVIEW_ROLES, pdfReviewer: "off" });
    assert.strictEqual(roles.get().pdfReviewer, "off");
    await roles.pruneRemovedModels();
    assert.strictEqual(roles.get().pdfReviewer, "off");

    await roles.set({ ...DEFAULT_REVIEW_ROLES, pdfReviewer: m.id });
    await models.remove(m.id);
    assert.strictEqual(roles.get().pdfReviewer, "");

    // A value stored by 0.3.x has no field — no `.v2` key, no migration.
    await roles.set({
      reviewers: [""],
      synthesis: "",
      verifier: "off",
    } as unknown as ReviewRoles);
    assert.deepStrictEqual(roles.get(), {
      reviewers: [""],
      synthesis: "",
      verifier: "off",
      pdfReviewer: "",
    });
  });

  test("O14: setReviewRoles carries all four fields, and every models state says so", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    await api.dispatchWebviewMessageForTests({
      type: "setReviewRoles",
      reviewers: ["", ""],
      synthesis: "",
      verifier: "",
      pdfReviewer: "off",
    });
    assert.strictEqual(
      api.reviewRolesStoreForTests()?.get().pdfReviewer,
      "off",
    );
    assert.strictEqual(
      api.lastModelsStateForTests()?.reviewRoles.pdfReviewer,
      "off",
    );
    const asked = (await api.dispatchWebviewMessageForTests({
      type: "requestModels",
    })) as ModelsState;
    assert.strictEqual(asked.reviewRoles.pdfReviewer, "off");
  });

  test("O14: the resolver gives Writing's own binding, Off, a bound model, or a refusal naming the PDF reviewer", async () => {
    const api = await getApi();
    api.clearModelForTests();
    await api.clearModelsForTests();
    const models = api.modelStoreForTests();
    const roles = api.reviewRolesStoreForTests();
    assert.ok(models);
    assert.ok(roles);
    const writing = await models.add(
      { ...haiku, model: "claude-sonnet-4-5" },
      "k1",
    );
    await models.setActive(writing.id);
    // The one field this role is gated on rides the Writing binding.
    await models.setImageInput(writing.id, false);

    await roles.set({ ...DEFAULT_REVIEW_ROLES, reviewers: [""] });
    const same = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in same, "the default PDF reviewer should resolve");
    assert.ok(same.pdfReviewer !== undefined && same.pdfReviewer !== "off");
    assert.strictEqual(same.pdfReviewer.binding.model, "claude-sonnet-4-5");
    assert.strictEqual(same.pdfReviewer.binding.imageInput, false);

    await roles.set({
      ...DEFAULT_REVIEW_ROLES,
      reviewers: [""],
      pdfReviewer: "off",
    });
    const off = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in off);
    assert.strictEqual(off.pdfReviewer, "off");

    const own = await models.add(haiku, "k2");
    await roles.set({
      ...DEFAULT_REVIEW_ROLES,
      reviewers: [""],
      pdfReviewer: own.id,
    });
    const bound = await api.resolveReviewPanelForTests();
    assert.ok("reviewers" in bound);
    assert.ok(bound.pdfReviewer !== undefined && bound.pdfReviewer !== "off");
    assert.strictEqual(
      bound.pdfReviewer.binding.model,
      "claude-haiku-4-5-20251001",
    );

    // Unbindable: named as itself, two past the reviewers.
    const keyless = await models.add({ ...haiku, model: "keyless" }, "");
    await roles.set({
      ...DEFAULT_REVIEW_ROLES,
      reviewers: ["", ""],
      pdfReviewer: keyless.id,
    });
    assert.deepStrictEqual(await api.resolveReviewPanelForTests(), {
      unbound: 4,
      role: "pdf_reviewer",
    });
    await roles.set(DEFAULT_REVIEW_ROLES);
  });

  test("O14: a review's options carry the role and what the PDF needs — a renderer, a compile iff one can run, a log reader, the venue", async () => {
    const api = (await getApi()) as ModelsApi & PdfRoleApi;
    const model = new TestModel(["x"]);
    const child = {
      adapter: model,
      binding: {
        protocol: "anthropic" as const,
        endpoint: "",
        model: "claude-sonnet-4-5",
        apiKey: "k",
      },
    };
    const panel = {
      reviewers: [child],
      synthesis: child,
      verifier: "off" as const,
      pdfReviewer: "off" as const,
    };
    const dir = path.join(
      os.tmpdir(),
      `lemmaria-v4-opts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const write = (name: string, text: string) =>
      vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(dir, name)),
        Buffer.from(text, "utf8"),
      );
    await write(
      "acm.tex",
      "\\documentclass[sigconf]{acmart}\n\\begin{document}\nx\n\\end{document}\n",
    );
    await write(
      "plain.tex",
      "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
    );
    await write("notes.md", "# Notes\n");

    // A chat send is handed nothing about a PDF.
    const chat = await api.sharedTaskOptionsForTests({
      root: dir,
      entry: "plain.tex",
    });
    assert.strictEqual(chat.reviewPdf, undefined);

    // No TeX on this machine: a renderer, no compile.
    api.setEngineProbeForTests(() => false);
    const noTex = await api.sharedTaskOptionsForTests(
      { root: dir, entry: "plain.tex" },
      panel,
    );
    assert.strictEqual(noTex.reviewPanel?.pdfReviewer, "off");
    assert.ok(noTex.reviewPdf, "a review is handed the PDF's dependencies");
    assert.strictEqual(typeof noTex.reviewPdf.renderer, "function");
    assert.strictEqual(noTex.reviewPdf.compile, undefined);
    // Its log reader is the Compile tab's parser.
    const warnings = noTex.reviewPdf.compileLog?.(
      "Overfull \\hbox (12.0pt too wide) in paragraph at lines 3--3\n",
      "plain.tex",
    );
    assert.ok(
      (warnings ?? []).some((w) => /overfull/i.test(`${w.code} ${w.message}`)),
      "the log reader should see the overfull box",
    );
    // An unknown class names no venue.
    assert.strictEqual(noTex.reviewPdf.venue, undefined);

    // An engine that resolves: a compile that asks for the PDF back.
    api.clearEngineProbeForTests();
    let asked: CompileProjectOptions | undefined;
    api.setCompileForTests(async (opts) => {
      asked = opts;
      return { ok: true, log: "" };
    });
    const withTex = await api.sharedTaskOptionsForTests(
      { root: dir, entry: "acm.tex" },
      panel,
    );
    assert.ok(withTex.reviewPdf?.compile, "a compile when an engine resolves");
    await withTex.reviewPdf.compile();
    assert.strictEqual(asked?.wantPdf, true);
    assert.strictEqual(asked?.entry, "acm.tex");
    // `acmart` is acm-sigconf's class: its limit and anonymity, as authored.
    assert.deepStrictEqual(withTex.reviewPdf.venue, {
      id: "acm-sigconf",
      pageLimit: {
        value: 9,
        unit: "pages",
        note: "excl. references; check your CFP",
      },
      anonymity: "double_blind",
    });

    // A Markdown paper has no compile a review could run.
    const md = await api.sharedTaskOptionsForTests(
      { root: dir, entry: "notes.md" },
      panel,
    );
    assert.strictEqual(md.reviewPdf?.compile, undefined);
    api.clearCompileForTests();
  });
});
