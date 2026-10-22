import { randomUUID } from "node:crypto";
import type {
  GrantedRoot,
  ScriptApproval,
  ScriptRunItem,
  SessionEvent,
  SessionItem,
  SessionLocale,
  SessionScriptHost,
} from "../../contracts/index.js";
import { ok, toolFail } from "../../contracts/index.js";
import type { ToolExecutor } from "../../engine/tools.js";
import { truncateKeepingTail } from "../../text/truncate.js";
import { raceWithAbort } from "../abort.js";
import { messagesFor } from "../messages.js";
import {
  parseRunScriptArgs,
  resolveRunScript,
  scriptContentHash,
} from "../scripts.js";

/**
 * `run_script` — approval-gated script execution (A4b, ADR 0020).
 *
 * A loop-injected tool, offered only when the host configured a script host
 * with a non-empty interpreter allowlist AND a grants getter (a script needs a
 * granted-root cwd). Extracted from `run.ts` at B1: the five pre-run refusal
 * gates below are each the record of a review finding, and they move verbatim
 * with their comments.
 */

/** Cap the script source shown in the approval card + persisted record. */
export const SCRIPT_PREVIEW_MAX_CHARS = 4000;

/**
 * B4 (ADR 0029): the model-facing budget for each captured stream, applied to
 * the **tail** — a script that prints a lot and then fails puts its error last.
 *
 * Sized so both streams together serialize well under `TOOL_RESULT_MAX_CHARS`.
 * That is the point: before B4 a 400 kB result was head-cut by `capToolResult`,
 * and because `stdout` precedes `stderr` in the payload, **stderr was destroyed
 * first, systematically**. Bounding each stream here means the global backstop
 * never has to choose between them.
 */
export const SCRIPT_OUTPUT_MAX_LINES = 200;
export const SCRIPT_OUTPUT_MAX_TOKENS = 2_000;

/**
 * What a truncated stream tells the model, beside the text it kept.
 *
 * `total_lines` is **absent** when the host's capture window already dropped
 * bytes (review, Minor 7): the line count of what survived is not the line
 * count of what ran, and nothing at this layer can know the latter. Reporting
 * it anyway would be the invented number this milestone exists to remove.
 */
interface StreamTruncation {
  kept: "tail";
  shown_lines: number;
  total_lines?: number;
  total_bytes: number;
}

/**
 * Bound one captured stream. Two truncations can stack — the host's capture
 * window (which already dropped the FRONT, `ScriptRunResult.truncated`) and
 * this budget — so a stream is reported as truncated if either fired, and
 * `total_bytes` is what the process actually produced, not what survived.
 */
function boundStream(
  text: string,
  producedBytes: number | undefined,
  droppedAtCapture: boolean,
): { text: string; truncation?: StreamTruncation } {
  const cut = truncateKeepingTail(text, {
    maxLines: SCRIPT_OUTPUT_MAX_LINES,
    maxTokens: SCRIPT_OUTPUT_MAX_TOKENS,
  });
  const totalBytes = producedBytes ?? cut.totalBytes;
  const lostAtCapture = droppedAtCapture && totalBytes > cut.totalBytes;
  if (!cut.truncated && !lostAtCapture) return { text: cut.text };
  return {
    text: cut.text,
    truncation: {
      kept: "tail",
      shown_lines: cut.shownLines,
      ...(lostAtCapture ? {} : { total_lines: cut.totalLines }),
      total_bytes: totalBytes,
    },
  };
}

export const RUN_SCRIPT_SPEC = {
  name: "run_script" as const,
  description:
    "Run a script in a granted folder (ADR 0020). Argv only, no shell: { root: '<granted-folder-id>', command: [interpreter, script, ...args] }. The interpreter must be allowlisted; the script must be a file inside a granted folder or the paper workspace (create it with propose_edit first if needed). It runs in the granted folder with the user's full OS permissions and needs their approval each time. The result reports status (completed/denied/failed), exitCode, and captured stdout/stderr.",
  parameters: {
    type: "object",
    properties: {
      root: { type: "string" },
      command: { type: "array", items: { type: "string" } },
    },
    required: ["root", "command"],
  } as Record<string, unknown>,
};

export function createRunScriptTool(deps: {
  scriptHost: SessionScriptHost;
  /** Live grant set — a mid-task revocation bites at the next call AND after
   *  the approval pause (review #6). */
  grants: () => GrantedRoot[];
  workspaceRoot: string;
  emit: (event: SessionEvent) => Promise<void>;
  emitItem: (item: SessionItem) => Promise<void>;
  signal?: AbortSignal;
  /** X2 (ADR 0034): which language this session's run notes render in. */
  locale?: SessionLocale;
}): ToolExecutor {
  const { scriptHost, emit, emitItem } = deps;
  const msg = messagesFor(deps.locale);
  return {
    name: "run_script",
    category: "mutation",
    // Deliberately NO `executionMode` (B3, ADR 0025): `mutation` is forced
    // sequential by the batch planner. See `propose_edit` for the reasoning.
    spec: RUN_SCRIPT_SPEC,
    invoke: async (args) => {
      const parsed = parseRunScriptArgs(args);
      if ("error" in parsed) return toolFail("invalid", parsed.error);
      const grant = deps.grants().find((g) => g.id === parsed.root);
      if (!grant) {
        return toolFail(
          "refused",
          `no such granted folder: ${parsed.root} — it may have been revoked`,
        );
      }
      const resolved = resolveRunScript({
        command: parsed.command,
        grant,
        workspaceRoot: deps.workspaceRoot,
        interpreters: scriptHost.interpreters(),
      });
      if ("refused" in resolved)
        return toolFail(resolved.code, resolved.refused);

      const itemId = randomUUID();
      // The source the user approves (review #2): the card shows the script
      // itself, not just its filename — a granted-folder file the model did
      // not author is otherwise approved sight-unseen. Capped for the record.
      const preview =
        resolved.content.length > SCRIPT_PREVIEW_MAX_CHARS
          ? `${resolved.content.slice(0, SCRIPT_PREVIEW_MAX_CHARS)}\n… (truncated)`
          : resolved.content;
      const baseItem = (status: ScriptRunItem["status"]): ScriptRunItem => ({
        id: itemId,
        type: "script_run",
        command: resolved.display,
        rootId: grant.id,
        rootLabel: grant.label,
        status,
        scriptPreview: preview,
      });
      // The pause record — persisted so a death mid-approval replays failed.
      await emitItem(baseItem("pending"));

      // Always-allow identity binds the root + full resolved argv + content
      // (review #1), never just the interpreter basename.
      const hash = scriptContentHash(grant.id, resolved.argv, resolved.content);
      const approval: ScriptApproval | undefined = await raceWithAbort(
        scriptHost.requestApproval(baseItem("pending"), hash),
        deps.signal,
      );
      if (approval === undefined) {
        // Interrupted before a decision — the outer loop ends the task.
        await emitItem({
          ...baseItem("failed"),
          note: msg.scriptInterruptedBeforeApproval,
        });
        // ADR 0024: nothing ran, so there is no result — `refused`, not a
        // `{status: "failed"}` payload that reads like a run that happened.
        return toolFail("refused", "interrupted before approval");
      }
      if (!approval.approve) {
        await emitItem({
          ...baseItem("denied"),
          ...(approval.note !== undefined ? { note: approval.note } : {}),
        });
        // The user's note IS the guidance the model must follow; it travels
        // as the failure message so nothing is lost by the shape change.
        return toolFail(
          "refused",
          approval.note !== undefined
            ? `the user denied this run: ${approval.note}`
            : "the user denied this run",
        );
      }

      // Re-check the grant after the pause (review #6): the user may have
      // revoked it while the approval sat open — don't run in a now-revoked
      // folder just because the resolved cwd was captured earlier.
      const liveGrant = deps.grants().find((g) => g.id === grant.id);
      if (!liveGrant) {
        await emitItem({
          ...baseItem("failed"),
          note: msg.scriptGrantRevoked(grant.id),
        });
        return toolFail(
          "refused",
          `granted folder ${grant.id} was revoked before the run`,
        );
      }

      // Re-resolve the script and re-hash immediately before spawning
      // (review: approved source may differ from executed source). The user
      // approved specific bytes; if the file (or the folder it resolves in)
      // was swapped during the approval pause, the fresh hash won't match the
      // approved one — refuse rather than run content the user never saw.
      const recheck = resolveRunScript({
        command: parsed.command,
        grant: liveGrant,
        workspaceRoot: deps.workspaceRoot,
        interpreters: scriptHost.interpreters(),
      });
      if ("refused" in recheck) {
        await emitItem({
          ...baseItem("failed"),
          note: msg.scriptChangedAfterApproval(recheck.refused),
        });
        return toolFail(
          "refused",
          `script changed after approval — ${recheck.refused}`,
        );
      }
      if (
        scriptContentHash(liveGrant.id, recheck.argv, recheck.content) !== hash
      ) {
        await emitItem({
          ...baseItem("failed"),
          note: msg.scriptChangedNothingRun,
        });
        return toolFail(
          "refused",
          "the script changed after approval; nothing was run",
        );
      }

      await emit({ type: "item.updated", item: baseItem("running") });
      // Defence in depth (review #5): race the run against the AbortSignal so
      // an unkillable/wedged child can never wedge the loop at this await —
      // the host also gets the signal and kills the tree.
      const runResult = await raceWithAbort(
        scriptHost.run(recheck.argv, recheck.cwd, deps.signal),
        deps.signal,
      );
      if (runResult === undefined) {
        await emitItem({
          ...baseItem("failed"),
          note: msg.scriptInterruptedDuringRun,
        });
        return toolFail("refused", "interrupted during the run");
      }
      const status: ScriptRunItem["status"] = runResult.error
        ? "failed"
        : "completed";
      await emitItem({
        ...baseItem(status),
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
        truncated: runResult.truncated,
        // D2: the transcript's fold summary reports these; B4 measured them
        // here and spent them only on the model's payload, three lines below.
        stdoutBytes: runResult.stdoutBytes,
        stderrBytes: runResult.stderrBytes,
        ...(runResult.error !== undefined ? { note: runResult.error } : {}),
      });
      // The script RAN: a non-zero exit is a result, not a ToolError — the
      // model needs the output to act on it (ADR 0024). The spawn/kill reason
      // travels as `note`, matching `ScriptRunItem`: `error` is the wire key
      // ADR 0024 reserves for the failure envelope, and a success payload
      // using it would make the transcript row read as a bare ✓ (review).
      // B4: the transcript row keeps the host's fuller capture (the user can
      // scroll); the model's payload is tail-bounded per stream so a failing
      // script's last words survive the trip.
      const out = boundStream(
        runResult.stdout,
        runResult.stdoutBytes,
        runResult.truncated,
      );
      const err = boundStream(
        runResult.stderr,
        runResult.stderrBytes,
        runResult.truncated,
      );
      return ok({
        status,
        exitCode: runResult.exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated:
          runResult.truncated ||
          out.truncation !== undefined ||
          err.truncation !== undefined,
        ...(out.truncation ? { stdout_truncation: out.truncation } : {}),
        ...(err.truncation ? { stderr_truncation: err.truncation } : {}),
        ...(runResult.error !== undefined ? { note: runResult.error } : {}),
      });
    },
  };
}
