/**
 * One-call assembly for a session-loop test (B0).
 *
 * Every loop test used to hand-roll the same five things: a temp-dir
 * `SessionStore`, a session, a scripted model, an event sink, and a
 * `ModelBinding` whose model id had to be a *verified* one so the ADR 0023
 * floor notice did not appear in unrelated assertions. That last requirement
 * lived in a comment; here it is the default, so no new test can trip over it.
 *
 * Adapted from Pi's `test/suite/harness.ts` shape (MIT) — assemble the whole
 * runtime in one call so a behaviour test is a handful of lines.
 *
 * Temp dirs are tracked module-wide; call `cleanupSessionHarnesses` from the
 * suite's `afterAll`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelBinding,
  SessionEvent,
  SessionItem,
  SessionMeta,
  ToolName,
} from "../../src/contracts/index.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import {
  ScriptedModelAdapter,
  type ScriptedTurn,
} from "../../src/model/scripted.js";
import type {
  RunSessionTaskOptions,
  SessionTaskResult,
} from "../../src/session/run.js";
import { runSessionTask } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";

/**
 * A REAL, verified model id (ADR 0023). Loop tests assert loop behaviour, so
 * the binding must not also trip the `model.unverified` notice — that path has
 * its own dedicated tests.
 */
export const VERIFIED_MODEL = "claude-sonnet-4-5";

const tempDirs: string[] = [];

export interface SessionHarness {
  store: SessionStore;
  session: SessionMeta;
  model: ScriptedModelAdapter;
  binding: ModelBinding;
  /** Every event this harness's runs emitted, in order. */
  events: SessionEvent[];
  /**
   * Every retry backoff the runs asked for, in ms (B2). Recorded rather than
   * waited: a suite that actually slept its way through the default policy
   * would add seconds per retry test and assert nothing extra — the delays the
   * policy computes are what matter, and this is where they can be read.
   */
  slept: number[];
  /** `runSessionTask` with store/session/model/binding/onEvent already wired. */
  run(
    opts: { text: string } & Partial<RunSessionTaskOptions>,
  ): Promise<SessionTaskResult>;
  /** The transcript's item types, in order — the assertion most tests want. */
  itemTypes(result: SessionTaskResult): SessionItem["type"][];
}

export async function createSessionHarness(opts: {
  turns: ScriptedTurn[];
  registry?: Map<ToolName, ToolExecutor>;
  /** Override only to exercise the ADR 0023 floor itself. */
  model?: string;
  title?: string;
  workspace?: string;
}): Promise<SessionHarness> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-session-harness-"));
  tempDirs.push(dir);
  const store = new SessionStore(join(dir, "sessions"));
  const session = await store.create({
    title: opts.title ?? "test session",
    workspace: opts.workspace ?? "/w",
  });
  const model = new ScriptedModelAdapter(opts.turns);
  const events: SessionEvent[] = [];
  const slept: number[] = [];
  const binding: ModelBinding = {
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com",
    model: opts.model ?? VERIFIED_MODEL,
    apiKey: "k",
  };
  return {
    store,
    session,
    model,
    binding,
    events,
    slept,
    // `runOpts` is spread BEFORE the harness's own wiring, so a caller cannot
    // accidentally replace the event collector (leaving `h.events` empty) or
    // the registry by passing `onEvent`/`registry` through (review, Minor).
    // Override those by constructing the harness differently, not per-run.
    run: (runOpts) =>
      runSessionTask({
        ...runOpts,
        store,
        session,
        model,
        binding,
        ...(opts.registry ? { registry: opts.registry } : {}),
        // B2: the backoff is recorded, never spent. Deliberately NOT
        // overridable per run, for the same reason `onEvent` is not — a test
        // that quietly restored the real timer would just be slow.
        sleep: async (ms) => {
          slept.push(ms);
          return true;
        },
        onEvent: (e) => events.push(e),
      }),
    itemTypes: (result) => result.items.map((i) => i.type),
  };
}

/** Remove every temp dir this module created. Call from the suite's afterAll. */
export async function cleanupSessionHarnesses(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}
