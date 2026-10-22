import {
  type ChildModel,
  type ModelAdapter,
  type ModelBinding,
  type Protocol,
  REVIEWER_NAMES,
  createModelAdapter,
  providerPreset,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale } from "./i18n";
import {
  MODELS_ACTIVE_KEY,
  MODELS_LIST_KEY,
  MODELS_MIGRATED_KEY,
  ModelStore,
  type StoredModel,
  modelKeySecret,
} from "./model-store";
import {
  DEFAULT_REVIEW_ROLES,
  PDF_REVIEWER_OFF,
  REVIEW_ROLES_KEY,
  type ReviewRoles,
  ReviewRolesStore,
  VERIFIER_OFF,
} from "./review-roles-store";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/** The legacy shared BYOK key — retained only as the one-time migration source. */
export const KEY_SECRET = "lemmaria.apiKey";

/** The extension context, stashed for the key seams (set by registerSetApiKey). */
let keyContext: vscode.ExtensionContext | undefined;

/** The multi-model store + the context that owns it (set by registerModels). */
let store: ModelStore | undefined;
let modelContext: vscode.ExtensionContext | undefined;

/** The review roles store (R9), registered beside the model list. */
let rolesStore: ReviewRolesStore | undefined;

/** What was opted into Settings Sync, kept so a test can assert it: VS Code
 *  offers no getter for `setKeysForSync`, and a key silently missing from it
 *  is invisible until a user's second machine reviews on the wrong models. */
let syncedGlobalKeys: string[] = [];

/**
 * Stash the ModelStore for the host + getModel; opt the list into Settings
 * Sync.
 *
 * R9: the review roles travel WITH the list. They are ids into it, so syncing
 * one without the other lands roles pointing at models the second machine does
 * not have — which the store's own pruning would then quietly flatten to
 * "same as Writing", losing the user's choice without saying so.
 */
export function registerModels(context: vscode.ExtensionContext): ModelStore {
  modelContext = context;
  store = new ModelStore(context.globalState, context.secrets);
  rolesStore = new ReviewRolesStore(context.globalState, () =>
    (store?.list() ?? []).map((m) => m.id),
  );
  // A model the user deletes stops being pointed at ON DISK too, not only in
  // what `get()` reads back.
  context.subscriptions.push(
    store.onDidChange(() => {
      void rolesStore?.pruneRemovedModels();
    }),
  );
  syncedGlobalKeys = [MODELS_LIST_KEY, MODELS_ACTIVE_KEY, REVIEW_ROLES_KEY];
  context.globalState.setKeysForSync(syncedGlobalKeys);
  return store;
}

/** The activation-stashed roles store (the host reads it for ModelsState).
 *  Re-exported as `reviewRolesStoreForTests` from `extension.ts`, the way
 *  `modelStore` is — one function, two names at the boundary, rather than two
 *  byte-identical functions here. */
export function reviewRolesStore(): ReviewRolesStore | undefined {
  return rolesStore;
}

/** Test seam: the globalState keys opted into Settings Sync. */
export function syncedGlobalKeysForTests(): string[] {
  return [...syncedGlobalKeys];
}

/** The activation-stashed store (host reads it to build ModelsState). */
export function modelStore(): ModelStore | undefined {
  return store;
}

/** Test seam: the live store. */
export function modelStoreForTests(): ModelStore | undefined {
  return store;
}

/** Test seam: wipe the list, active pointer, and every per-model key (hermetic). */
export async function clearModelsForTests(): Promise<void> {
  if (!store || !modelContext) return;
  // Through the store (never raw globalState writes): the store's in-memory
  // copy is authoritative; remove() also deletes each per-model key.
  for (const m of store.list()) {
    await store.remove(m.id);
  }
  await modelContext.globalState.update(MODELS_MIGRATED_KEY, undefined);
}

/**
 * One-time migration: on the first activation after upgrade, if no model list
 * exists yet but the legacy single-model settings + shared `lemmaria.apiKey` do,
 * fold them into one active StoredModel. Gated on a persisted done-flag (set on
 * the first run regardless of outcome) — the legacy settings/key are retained as
 * a rollback net, so an emptiness check alone would resurrect a model the user
 * later deleted. Runs at most once per install.
 */
export async function migrateLegacyModel(
  context: vscode.ExtensionContext,
): Promise<StoredModel | undefined> {
  if (!store) return undefined;
  // The flag still round-trips the raw Memento (the storage class ModelStore
  // no longer trusts mid-session): written once per activation and read only
  // at the NEXT activation's start, before storage churn — a lost write here
  // would re-run the migration, so the residual exposure is accepted, not zero.
  if (context.globalState.get<boolean>(MODELS_MIGRATED_KEY)) return undefined;
  await context.globalState.update(MODELS_MIGRATED_KEY, true);
  if (store.list().length > 0) return undefined;
  const cfg = vscode.workspace.getConfiguration("lemmaria.model");
  const legacyModel = cfg.get<string>("model", "");
  if (legacyModel === "") return undefined;
  const legacyKey = await context.secrets.get(KEY_SECRET);
  if (!legacyKey) return undefined;
  const protocol: Protocol =
    cfg.get<string>("protocol", "anthropic") === "openai-compatible"
      ? "openai-compatible"
      : "anthropic";
  const provider = protocol === "openai-compatible" ? "openai" : "anthropic";
  return store.add(
    {
      provider,
      protocol,
      endpoint: cfg.get<string>("endpoint", ""),
      model: legacyModel,
    },
    legacyKey,
  );
}

/** Test seam: the active model's binding via getModel (no adapter). */
export async function resolveModelForTests(): Promise<
  ModelBinding | undefined
> {
  if (!modelContext) return undefined;
  return (await getModel(modelContext.secrets))?.binding;
}

/** Test seam: run the legacy migration against the stashed context. */
export function migrateLegacyModelForTests(): Promise<StoredModel | undefined> {
  return modelContext
    ? migrateLegacyModel(modelContext)
    : Promise.resolve(undefined);
}

/** Test seam: delete the stored API key so key-presence tests are hermetic. */
export async function clearStoredApiKeyForTests(): Promise<void> {
  await keyContext?.secrets.delete(KEY_SECRET);
}

/** Test override for the interactive key prompt ({value: undefined} = Esc). */
let promptForTests: { value: string | undefined } | undefined;

/** Test seam: make `lemmaria.setApiKey` resolve to `value` instead of prompting. */
export function setApiKeyPromptForTests(value: string | undefined): void {
  promptForTests = { value };
}

export function clearApiKeyPromptForTests(): void {
  promptForTests = undefined;
}

let testOverride: { adapter: ModelAdapter; binding: ModelBinding } | undefined;

/** Test seam for the ext-host suites: inject a deterministic ModelAdapter. */
export function setModelForTests(
  adapter: ModelAdapter,
  binding?: ModelBinding,
): void {
  testOverride = {
    adapter,
    binding: binding ?? {
      protocol: adapter.protocol,
      endpoint: "stub://",
      // A6 (ADR 0023): a REAL verified model id. The old "stub" placeholder is
      // — correctly — outside the declared L2 floor, so it made every ext-host
      // session test emit the `model.unverified` notice and assert against a
      // transcript the product would never produce for a configured user. The
      // unverified path has its own test, which passes the binding explicitly.
      model: "claude-sonnet-4-5",
      apiKey: "",
    },
  };
}

export function clearModelForTests(): void {
  testOverride = undefined;
}

/**
 * The active model (ModelStore) + its SecretStorage key → a bound ModelAdapter.
 * BYOK: the key is injected here by the host; the adapter never reads storage
 * (contracts, Model Adapter Layer). Returns undefined when no model is active or
 * a key-required provider has no key.
 */
export async function getModel(
  secrets: vscode.SecretStorage,
): Promise<{ adapter: ModelAdapter; binding: ModelBinding } | undefined> {
  if (testOverride) return testOverride;
  const active = store?.active();
  if (!active) return undefined;
  const apiKey = (await secrets.get(modelKeySecret(active.id))) ?? "";
  const keyRequired = providerPreset(active.provider)?.keyRequired ?? true;
  if (active.model === "" || (keyRequired && apiKey === "")) return undefined;
  return {
    adapter: createModelAdapter(active.protocol),
    binding: {
      protocol: active.protocol,
      endpoint: active.endpoint,
      model: active.model,
      apiKey,
      // V3 (ADR 0080 §6): the user's per-model image-input override, when they
      // set one. Absent leaves the harness's prefix table in charge.
      ...(active.imageInput !== undefined
        ? { imageInput: active.imageInput }
        : {}),
    },
  };
}

/** Every role bound to a model that can actually run (R9, ADR 0069 §D8). */
export interface ResolvedReviewPanel {
  reviewers: ChildModel[];
  synthesis: ChildModel;
  /** V1 (ADR 0076 §8): the verifier's model, or `"off"`. Its default is the
   *  cross-review's own `ChildModel` — the same object, not a second bind, so
   *  the two are asked the pre-run check as the one model they are. */
  verifier: ChildModel | "off";
  /**
   * V4 (ADR 0081 §8): the PDF reviewer's model, or `"off"`. Its default is the
   * Writing model's own binding, `imageInput` included. Optional so a test's
   * override may omit it — the driver then reads the parent's, which is the
   * same default.
   */
  pdfReviewer?: ChildModel | "off";
}

/** The first role that cannot be bound, named. `unbound` indexes `reviewers`,
 *  and equals `reviewers.length` for the cross-review, one past that for the
 *  verifier, two past it for the PDF reviewer. */
export interface UnboundReviewRole {
  unbound: number;
  role: string;
}

export type ReviewPanelResolution = ResolvedReviewPanel | UnboundReviewRole;

/** Test seam for the ext-host suites: run the panel on given bindings without
 *  a configured model list. Mirrors `setModelForTests`, one level over. */
let reviewPanelOverride: ResolvedReviewPanel | undefined;

export function setReviewPanelForTests(
  panel: ResolvedReviewPanel | undefined,
): void {
  reviewPanelOverride = panel;
}

/** One role's stored id → the model it will run on, or undefined if it cannot
 *  run. `""` means *same as Writing*, so it resolves through `getModel` and
 *  inherits every gate the Writing model is held to. */
async function bindRole(
  id: string,
  secrets: vscode.SecretStorage,
): Promise<ChildModel | undefined> {
  if (id === "") return getModel(secrets);
  const m = store?.list().find((x) => x.id === id);
  if (!m) return undefined;
  const apiKey = (await secrets.get(modelKeySecret(m.id))) ?? "";
  const keyRequired = providerPreset(m.provider)?.keyRequired ?? true;
  if (m.model === "" || (keyRequired && apiKey === "")) return undefined;
  return {
    adapter: createModelAdapter(m.protocol),
    binding: {
      protocol: m.protocol,
      endpoint: m.endpoint,
      model: m.model,
      apiKey,
      // V3 (ADR 0080 §6): as in `getModel` — a reviewer's own override.
      ...(m.imageInput !== undefined ? { imageInput: m.imageInput } : {}),
    },
  };
}

/**
 * The configured roles → the models the panel's children run on.
 *
 * **An unbound role is a refusal, not a fallback.** Falling back to the
 * Writing model would run a panel the Models tab does not describe, and a
 * mixed panel's whole value is knowing which model said what; falling back
 * silently would make the record wrong rather than incomplete. So this reports
 * the FIRST role it cannot bind, by index and by name, and the host declines
 * to send.
 */
export async function resolveReviewPanel(
  secrets: vscode.SecretStorage,
): Promise<ReviewPanelResolution> {
  if (reviewPanelOverride) return reviewPanelOverride;
  const roles: ReviewRoles = rolesStore?.get() ?? DEFAULT_REVIEW_ROLES;
  const reviewers: ChildModel[] = [];
  for (const [i, id] of roles.reviewers.entries()) {
    const bound = await bindRole(id, secrets);
    if (!bound)
      return { unbound: i, role: REVIEWER_NAMES[i] ?? `reviewer_${i}` };
    reviewers.push(bound);
  }
  const synthesis = await bindRole(roles.synthesis, secrets);
  if (!synthesis) return { unbound: reviewers.length, role: "synthesis" };
  // V1: the verifier's `""` is the cross-review's model, never Writing's.
  let verifier: ChildModel | "off";
  if (roles.verifier === VERIFIER_OFF) verifier = VERIFIER_OFF;
  else {
    const bound =
      roles.verifier === ""
        ? synthesis
        : await bindRole(roles.verifier, secrets);
    if (!bound) return { unbound: reviewers.length + 1, role: "verifier" };
    verifier = bound;
  }
  // V4 (ADR 0081 §8): the PDF reviewer's `""` is Writing's, through the same
  // `bindRole` every role takes — which copies `imageInput`, the one field
  // this role is gated on.
  let pdfReviewer: ChildModel | "off";
  if (roles.pdfReviewer === PDF_REVIEWER_OFF) pdfReviewer = PDF_REVIEWER_OFF;
  else {
    const bound = await bindRole(roles.pdfReviewer, secrets);
    if (!bound) return { unbound: reviewers.length + 2, role: "pdf_reviewer" };
    pdfReviewer = bound;
  }
  return { reviewers, synthesis, verifier, pdfReviewer };
}

/**
 * The roles a `/review-pdf` run uses — the PDF reviewer's, and nothing else
 * (V4, ADR 0081 §7; the code review's catch). A reviewer pointed at a model
 * that cannot run must not refuse a run that never seats it, exactly as the
 * harness preflights only the PDF seat in this mode.
 *
 * The panel's other fields are filled with what the driver ignores in
 * pdf-only mode: no reviewers, the Writing model as the cross-review it will
 * never ask, and the verifier off.
 */
export async function resolvePdfReviewPanel(
  secrets: vscode.SecretStorage,
): Promise<ReviewPanelResolution> {
  if (reviewPanelOverride) return reviewPanelOverride;
  const roles: ReviewRoles = rolesStore?.get() ?? DEFAULT_REVIEW_ROLES;
  const writing = await getModel(secrets);
  if (!writing) return { unbound: 0, role: "pdf_reviewer" };
  let pdfReviewer: ChildModel | "off";
  if (roles.pdfReviewer === PDF_REVIEWER_OFF) pdfReviewer = PDF_REVIEWER_OFF;
  else {
    const bound = await bindRole(roles.pdfReviewer, secrets);
    if (!bound) return { unbound: 0, role: "pdf_reviewer" };
    pdfReviewer = bound;
  }
  return { reviewers: [], synthesis: writing, verifier: "off", pdfReviewer };
}

/** Test seam: the resolver against the stashed context's secrets. */
export async function resolveReviewPanelForTests(): Promise<ReviewPanelResolution> {
  return modelContext
    ? resolveReviewPanel(modelContext.secrets)
    : { unbound: 0, role: "reviewer_a" };
}

export function registerSetApiKey(context: vscode.ExtensionContext): void {
  keyContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand("lemmaria.setApiKey", async () => {
      const key = promptForTests
        ? promptForTests.value
        : await vscode.window.showInputBox({
            prompt: chrome("apiKeyPrompt"),
            password: true,
            ignoreFocusOut: true,
          });
      if (key === undefined) return;
      await context.secrets.store(KEY_SECRET, key);
      if (!promptForTests) {
        void vscode.window.showInformationMessage(chrome("apiKeySaved"));
      }
    }),
  );
}
