/**
 * The multi-model config store (revised U3). Owns the user's list of models as
 * structured CRUD data in globalState, paired 1:1 with per-model API keys in
 * SecretStorage (`lemmaria.apiKey.<id>`). The Models tab UI is the only editor;
 * a key never leaves the host. See docs/plans/24-u3-multimodel-config-design.md.
 *
 * The store keeps an AUTHORITATIVE in-memory copy (seeded from globalState at
 * construction) and mirrors every mutation back with write-through updates.
 * Reads never go through the Memento: VS Code's globalState was observed (U4
 * gate debugging) to intermittently revert a just-updated value to a stale
 * snapshot under storage churn — a read-through store then "loses" a model the
 * user just added. Trade-off (recorded as a U4 known limit): an external write
 * to these keys (e.g. Settings Sync landing mid-session) is not picked up until
 * the next activation, AND the next local mutation persists the in-memory copy,
 * overwriting the synced-in value. The per-model keys live in SecretStorage
 * (never synced), so a synced list arrives keyless anyway — sync only seeds
 * the list at activation.
 */

import { randomUUID } from "node:crypto";
import type { Protocol } from "@lemmaria/harness";
import * as vscode from "vscode";

export const MODELS_LIST_KEY = "lemmaria.models.v1";
export const MODELS_ACTIVE_KEY = "lemmaria.activeModelId";
/** One-time flag: the legacy single-model config has been migrated (or skipped). */
export const MODELS_MIGRATED_KEY = "lemmaria.legacyModelMigrated";

/** The SecretStorage key holding one model's API key. */
export function modelKeySecret(id: string): string {
  return `lemmaria.apiKey.${id}`;
}

export interface StoredModel {
  id: string; // crypto.randomUUID()
  provider: string; // provider preset id
  protocol: Protocol; // denormalized from the preset
  endpoint: string; // resolved (preset default or user override)
  model: string; // model id (curated or custom)
  label?: string; // optional friendly name; UI falls back to `model`
  /**
   * The user's per-model image-input override (V3, ADR 0080 §6).
   *
   * Absent = *auto*, which asks the harness's prefix table; `true` / `false`
   * override it in either direction. Additive with no `.v2` key, on the
   * `verifier` precedent: every value already stored reads back valid, and
   * the Convention's *no backward-compatibility burden* applies.
   */
  imageInput?: boolean;
}

export class ModelStore {
  /** The authoritative in-session copy (globalState is the persisted mirror). */
  private models: StoredModel[];
  private activeIdValue: string | undefined;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.models = globalState.get<StoredModel[]>(MODELS_LIST_KEY, []);
    this.activeIdValue = globalState.get<string>(MODELS_ACTIVE_KEY);
  }

  list(): StoredModel[] {
    return [...this.models];
  }

  activeId(): string | undefined {
    return this.activeIdValue;
  }

  active(): StoredModel | undefined {
    const id = this.activeIdValue;
    return id === undefined ? undefined : this.models.find((m) => m.id === id);
  }

  /**
   * Fired after any mutation lands (E1 review round, ADR 0048).
   *
   * The consumer is the skills catalogue budget, which is 2 % of the BOUND
   * model's context window — so binding a different model changes how much of
   * each skill description fits and which skills fit at all, and the view would
   * otherwise keep showing the fit computed for whatever was bound when the
   * skills were last read.
   *
   * Fired from `persist` rather than from `setActive` alone, deliberately:
   * `add` can make its model active, `remove` can take the active one away, and
   * a hook that has to be remembered at three call sites is one that will be
   * forgotten at the fourth. Over-firing costs a reload of three small
   * directories; missing a change shows the user a stale catalogue.
   */
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private async persist(): Promise<void> {
    await this.globalState.update(MODELS_LIST_KEY, this.models);
    await this.globalState.update(MODELS_ACTIVE_KEY, this.activeIdValue);
    this.changed.fire();
  }

  async setActive(id: string): Promise<void> {
    // Ignore ids that aren't in the list, so `activeId()` never dangles.
    if (!this.models.some((m) => m.id === id)) return;
    this.activeIdValue = id;
    await this.persist();
  }

  /** Append a model (making it active if it is the first) and store its key. */
  async add(
    entry: Omit<StoredModel, "id">,
    apiKey: string,
  ): Promise<StoredModel> {
    const model: StoredModel = { ...entry, id: randomUUID() };
    this.models = [...this.models, model];
    if (this.activeIdValue === undefined) this.activeIdValue = model.id;
    await this.persist();
    if (apiKey !== "") {
      await this.secrets.store(modelKeySecret(model.id), apiKey);
    }
    return model;
  }

  /** Delete a model + its key; if it was active, fall back to the first left. */
  async remove(id: string): Promise<void> {
    this.models = this.models.filter((m) => m.id !== id);
    if (this.activeIdValue === id) {
      this.activeIdValue = this.models[0]?.id;
    }
    await this.persist();
    await this.secrets.delete(modelKeySecret(id));
  }

  getKey(id: string): Thenable<string | undefined> {
    return this.secrets.get(modelKeySecret(id));
  }

  async updateKey(id: string, apiKey: string): Promise<void> {
    await this.secrets.store(modelKeySecret(id), apiKey);
  }

  /**
   * Set (or clear) one model's image-input override (V3, ADR 0080 §6).
   *
   * `undefined` removes the field entirely rather than storing a third value,
   * so *auto* is the ABSENCE of a decision and a row that never had one reads
   * back identically to a row that was set back to auto.
   */
  async setImageInput(id: string, value: boolean | undefined): Promise<void> {
    const index = this.models.findIndex((m) => m.id === id);
    const model = this.models[index];
    if (!model) return;
    // Rebuilt without the key rather than set to `undefined`: *auto* is the
    // ABSENCE of a decision, so a row returned to auto reads back byte-for-byte
    // like a row that never had one.
    const { imageInput: _dropped, ...rest } = model;
    this.models[index] =
      value === undefined ? rest : { ...rest, imageInput: value };
    await this.persist();
  }
}
