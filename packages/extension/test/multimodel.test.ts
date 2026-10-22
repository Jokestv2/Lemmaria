// Revised-U3 multi-model config: host seams for the ModelStore, getModel
// resolution, and legacy migration. Ext-host (mocha) — a real Memento +
// SecretStorage. All offline.
import * as assert from "node:assert";
import type { ModelBinding, Protocol } from "@lemmaria/harness";
import * as vscode from "vscode";
import {
  type ModelStore,
  ModelStore as ModelStoreClass,
  type StoredModel,
} from "../src/model-store";

interface MultiModelApi {
  modelStoreForTests(): ModelStore | undefined;
  clearModelsForTests(): Promise<void>;
  resolveModelForTests(): Promise<ModelBinding | undefined>;
  migrateLegacyModelForTests(): Promise<StoredModel | undefined>;
}

type FullApi = MultiModelApi & {
  clearStoredApiKeyForTests(): Promise<void>;
  setApiKeyPromptForTests(value: string | undefined): void;
  clearApiKeyPromptForTests(): void;
};

async function getApi(): Promise<MultiModelApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as MultiModelApi;
}

async function getApiFull(): Promise<FullApi> {
  return (await getApi()) as unknown as FullApi;
}

/**
 * A Memento that ACKS updates but never applies them — the observed VS Code
 * globalState hazard under storage churn (an update resolves, then a read
 * returns the stale snapshot). The store must stay correct regardless.
 */
function lossyMemento(): vscode.Memento & {
  setKeysForSync(keys: readonly string[]): void;
} {
  return {
    keys: () => [],
    get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
    update: () => Promise.resolve(),
    setKeysForSync: () => undefined,
  };
}

function stubSecrets(): vscode.SecretStorage {
  const map = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...map.keys()]),
    onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>()
      .event,
  };
}

suite("revised-U3: ModelStore lost-persist resilience", function () {
  this.timeout(30000);

  test("an added model stays listed and active even when the Memento loses the write", async () => {
    const store = new ModelStoreClass(lossyMemento(), stubSecrets());
    const m = await store.add(
      {
        provider: "anthropic",
        protocol: "anthropic" as Protocol,
        endpoint: "",
        model: "claude-lossy",
      },
      "sk-lossy",
    );
    assert.strictEqual(store.list().length, 1, "model survives a lost persist");
    assert.strictEqual(
      store.activeId(),
      m.id,
      "active survives a lost persist",
    );
  });

  test("remove + active reassignment work over a lossy Memento", async () => {
    const store = new ModelStoreClass(lossyMemento(), stubSecrets());
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
    await store.remove(a.id);
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.list()[0]?.id, b.id);
    assert.strictEqual(
      store.activeId(),
      b.id,
      "active reassigned to the survivor",
    );
  });
});

suite("revised-U3: ModelStore CRUD", function () {
  this.timeout(30000);

  test("add makes the first model active and stores its key", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const store = api.modelStoreForTests();
    assert.ok(store);
    const m = await store.add(
      {
        provider: "anthropic",
        protocol: "anthropic" as Protocol,
        endpoint: "",
        model: "claude-x",
      },
      "sk-one",
    );
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.activeId(), m.id);
    assert.strictEqual(await store.getKey(m.id), "sk-one");
    await api.clearModelsForTests();
  });

  test("a second add does not steal active; setActive switches it", async () => {
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
        provider: "openai",
        protocol: "openai-compatible",
        endpoint: "https://api.openai.com/v1",
        model: "b",
      },
      "kb",
    );
    assert.strictEqual(store.activeId(), a.id);
    await store.setActive(b.id);
    assert.strictEqual(store.activeId(), b.id);
    await api.clearModelsForTests();
  });

  test("remove deletes metadata + key and reassigns active when needed", async () => {
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
    await store.remove(a.id); // a was active
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.activeId(), b.id);
    assert.strictEqual(await store.getKey(a.id), undefined);
    await store.remove(b.id); // last one
    assert.strictEqual(store.activeId(), undefined);
    await api.clearModelsForTests();
  });
});

suite("revised-U3: getModel resolution", function () {
  this.timeout(30000);

  test("undefined when no model is active", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    assert.strictEqual(await api.resolveModelForTests(), undefined);
  });

  test("returns the active model's binding once a key is present", async () => {
    const api = await getApi();
    await api.clearModelsForTests();
    const store = api.modelStoreForTests();
    assert.ok(store);
    const m = await store.add(
      {
        provider: "openai",
        protocol: "openai-compatible",
        endpoint: "https://example.test/v1",
        model: "gpt-x",
      },
      "sk-resolve",
    );
    await store.setActive(m.id);
    const binding = await api.resolveModelForTests();
    assert.ok(binding);
    assert.strictEqual(binding.protocol, "openai-compatible");
    assert.strictEqual(binding.endpoint, "https://example.test/v1");
    assert.strictEqual(binding.model, "gpt-x");
    assert.strictEqual(binding.apiKey, "sk-resolve");
    await api.clearModelsForTests();
  });
});

suite("revised-U3: legacy migration", function () {
  this.timeout(30000);
  const cfg = () => vscode.workspace.getConfiguration("lemmaria.model");
  suiteTeardown(async () => {
    await cfg().update("model", undefined, vscode.ConfigurationTarget.Global);
    await cfg().update(
      "protocol",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  test("migrates lemmaria.model.* + lemmaria.apiKey into one active model", async () => {
    const api = await getApiFull();
    await api.clearModelsForTests();
    await api.clearStoredApiKeyForTests();
    await cfg().update(
      "model",
      "legacy-model-x",
      vscode.ConfigurationTarget.Global,
    );
    await cfg().update(
      "protocol",
      "anthropic",
      vscode.ConfigurationTarget.Global,
    );
    api.setApiKeyPromptForTests("sk-legacy");
    try {
      await vscode.commands.executeCommand("lemmaria.setApiKey"); // stores legacy KEY_SECRET
      const migrated = await api.migrateLegacyModelForTests();
      assert.ok(migrated, "expected a migrated model");
      assert.strictEqual(migrated.model, "legacy-model-x");
      assert.strictEqual(migrated.provider, "anthropic");
      const store = api.modelStoreForTests();
      assert.strictEqual(store?.activeId(), migrated.id);
      assert.strictEqual(await store?.getKey(migrated.id), "sk-legacy");
    } finally {
      api.clearApiKeyPromptForTests();
      await api.clearStoredApiKeyForTests();
      await api.clearModelsForTests();
    }
  });

  test("does not resurrect a deleted model on a second migration", async () => {
    const api = await getApiFull();
    await api.clearModelsForTests();
    await api.clearStoredApiKeyForTests();
    await cfg().update(
      "model",
      "legacy-model-y",
      vscode.ConfigurationTarget.Global,
    );
    api.setApiKeyPromptForTests("sk-legacy2");
    try {
      await vscode.commands.executeCommand("lemmaria.setApiKey");
      const first = await api.migrateLegacyModelForTests();
      assert.ok(first, "first migration created the model");
      const store = api.modelStoreForTests();
      await store?.remove(first.id); // the user deletes the migrated model
      assert.strictEqual(store?.list().length, 0);
      const second = await api.migrateLegacyModelForTests();
      assert.strictEqual(second, undefined, "no re-migration");
      assert.strictEqual(store?.list().length, 0, "model stays deleted");
    } finally {
      api.clearApiKeyPromptForTests();
      await api.clearStoredApiKeyForTests();
      await api.clearModelsForTests();
    }
  });
});
