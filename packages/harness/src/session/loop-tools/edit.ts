import { randomUUID } from "node:crypto";
import type {
  EditDecision,
  EditProposalItem,
  NoticeItem,
  ProposedEdit,
  ProtectedSpanReader,
  SessionEditHost,
  SessionEvent,
  SessionItem,
  SessionLocale,
} from "../../contracts/index.js";
import { ok, toolFail } from "../../contracts/index.js";
import type { ToolExecutor } from "../../engine/tools.js";
import { raceWithAbort } from "../abort.js";
import {
  parseProposeEditArgs,
  spliceAnchor,
  validateProposedEdits,
} from "../edits.js";
import { messagesFor } from "../messages.js";
import type { SnapshotStore } from "../snapshot-store.js";

/**
 * `propose_edit` — the write path (ADR 0016, revised by ADR 0017, ADR 0018 and
 * ADR 0031).
 *
 * A loop-injected tool, offered only when the host configured an edit host.
 * Extracted from `run.ts` at B1 with every gate and comment intact: the
 * proposal-time validation → policy branch → apply-time revalidation order IS
 * invariant 3's mechanism, not an implementation detail. ADR 0031 removed the
 * git-stash checkpoint step that used to sit between validation and the policy
 * branch — `fileStates` (captured in `applyOne`, below) is its replacement.
 */

export const PROPOSE_EDIT_SPEC = {
  name: "propose_edit" as const,
  description:
    "Propose document edits as a batch (ADR 0016). Submit ALL edits of one change in ONE call. Each edit is either a replace {file, anchor, replacement} — anchor copied VERBATIM from the file and occurring exactly once (extend it until unique) — or a create {file, create: true, content} for a new file. Use create for any script, program, data file, or other non-prose artifact the user asks for: write it to its own file, never into the paper source and never as a code block in your reply. If the user's request asks you to change or remove protected content (a comment, formula, citation, reference or macro), list each one's exact text in that edit's removes_protected — otherwise dropping it is refused. The result is a per-edit decision array: applied (written), rejected (the user's note is guidance — follow it), stale (the file changed — re-read, then re-propose), invalid (fix the anchor or path).",
  parameters: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            anchor: { type: "string" },
            replacement: { type: "string" },
            create: { type: "boolean" },
            content: { type: "string" },
            removes_protected: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["file"],
        },
      },
    },
    required: ["edits"],
  } as Record<string, unknown>,
};

/**
 * Files auto-applied since the last drain → the per-turn `changed_files` item
 * (ADR 0016). The loop drains it at each turn boundary; a review turn never
 * fills it, because the user saw each edit as it was decided.
 */
export interface AppliedLedger {
  /** Returns the entries and clears, so a turn reports each file exactly once. */
  drain(): {
    file: string;
    edits: number;
    created: boolean;
    /** D2 / X2's T6 — deduped, and absent when nothing was declared. */
    removesProtected?: string[];
  }[];
}

export function createProposeEditTool(deps: {
  editHost: SessionEditHost;
  emit: (event: SessionEvent) => Promise<void>;
  emitItem: (item: SessionItem) => Promise<void>;
  emitNotice: (code: NoticeItem["code"], n: number) => Promise<void>;
  /**
   * The id of the user_message that starts this task (ADR 0017; the transcript's
   * per-message restore affordance targets exactly this turn).
   */
  userMessageId: string;
  signal?: AbortSignal;
  /**
   * ADR 0031: when present, every applied write is content-addressed into this
   * store and the batch's `fileStates` manifest is attached to the terminal
   * item. Absent → no `fileStates` key at all, so a caller that never wired a
   * snapshot store sees the exact shape it always has.
   */
  snapshots?: SnapshotStore;
  /**
   * D1 (ADR 0032): the same detector `read_span` marks with. A replacement
   * that drops a protected span its anchor contained is refused at proposal
   * time — before any policy branch, so neither policy can write it. Absent ⇒
   * no enforcement, exactly the pre-D1 behaviour.
   */
  protectedSpans?: ProtectedSpanReader;
  /**
   * X2 (ADR 0034): which language this session's edit notes render in. A note
   * is read by the model AND shown to the user in the proposal row; it
   * resolves to ONE language, never both. Absent ⇒ English.
   */
  locale?: SessionLocale;
}): { tool: ToolExecutor; applied: AppliedLedger } {
  const { editHost, emitItem, emitNotice, snapshots } = deps;
  const msg = messagesFor(deps.locale);
  /** Auto-applied files this turn → the per-turn changed_files summary. */
  const appliedThisTurn = new Map<
    string,
    { edits: number; created: boolean; removed: Set<string> }
  >();

  /**
   * One batch's content-identity note-taker (ADR 0031). Built fresh inside
   * `invoke` for every call — `createProposeEditTool` runs ONCE per task but
   * `invoke` runs once per `propose_edit` batch, and `fileStates` must not
   * outlive the batch it describes: a later batch that touches none of an
   * earlier batch's files must report none of them, and a `before` recorded
   * for a file must be THIS batch's before, not a stale one from an earlier
   * call that happened to touch the same file.
   */
  const makeNoteTaker = (): {
    fileStates: Map<string, { before: string | null; after: string }>;
    note: (
      file: string,
      beforeContent: string | undefined,
      afterContent: string,
    ) => Promise<void>;
  } => {
    const fileStates = new Map<
      string,
      { before: string | null; after: string }
    >();
    const note = async (
      file: string,
      beforeContent: string | undefined,
      afterContent: string,
    ): Promise<void> => {
      if (!snapshots) return;
      const after = await snapshots.put(afterContent);
      const existing = fileStates.get(file);
      if (existing) {
        fileStates.set(file, { before: existing.before, after });
        return;
      }
      const before =
        beforeContent === undefined ? null : await snapshots.put(beforeContent);
      fileStates.set(file, { before, after });
    };
    return { fileStates, note };
  };

  const applyOne = async (
    edit: ProposedEdit,
    note: (
      file: string,
      beforeContent: string | undefined,
      afterContent: string,
    ) => Promise<void>,
  ): Promise<ProposedEdit> => {
    // Apply-time revalidation, both policies (round 2): re-read the CURRENT
    // content — the user may have typed since the proposal — and never
    // fuzzy-match, never apply blind.
    try {
      if (edit.kind === "create") {
        if (await editHost.fileExists(edit.file)) {
          return {
            ...edit,
            status: "stale",
            note: msg.editFileExists,
          };
        }
        await editHost.writeFile(edit.file, edit.content ?? "");
        await note(edit.file, undefined, edit.content ?? "");
        return { ...edit, status: "applied" };
      }
      const content = await editHost.readFile(edit.file);
      const spliced =
        content === undefined
          ? undefined
          : spliceAnchor(content, edit.anchor ?? "", edit.replacement ?? "");
      if (spliced === undefined) {
        return {
          ...edit,
          status: "stale",
          note: msg.editAnchorChanged,
        };
      }
      await editHost.writeFile(edit.file, spliced);
      await note(edit.file, content, spliced);
      return { ...edit, status: "applied" };
    } catch (error) {
      // A failed host write leaves this edit un-applied but must not kill
      // the batch: stale = "nothing written, re-propose" is the honest fit.
      const message = error instanceof Error ? error.message : String(error);
      return { ...edit, status: "stale", note: `write failed: ${message}` };
    }
  };
  const recordApplied = (edits: ProposedEdit[]): void => {
    for (const edit of edits) {
      if (edit.status !== "applied") continue;
      const entry = appliedThisTurn.get(edit.file) ?? {
        edits: 0,
        created: false,
        removed: new Set<string>(),
      };
      entry.edits += 1;
      if (edit.kind === "create") entry.created = true;
      // D2 / X2's T6: a Set, because two edits declaring the same span removed
      // ONE thing — a summary that named it twice would misreport the damage.
      for (const raw of edit.removesProtected ?? []) entry.removed.add(raw);
      appliedThisTurn.set(edit.file, entry);
    }
  };
  // A decision array IS a result (ADR 0024): every terminal status —
  // applied, rejected, stale, invalid — is information the model acts on.
  // Only a batch that could not be PARSED is a ToolError.
  const decisionsOf = (edits: ProposedEdit[]) =>
    ok({
      decisions: edits.map((edit) => ({
        file: edit.file,
        status: edit.status,
        ...(edit.note !== undefined ? { note: edit.note } : {}),
      })),
    });

  const tool: ToolExecutor = {
    name: "propose_edit",
    category: "mutation",
    // Deliberately NO `executionMode` (B3, ADR 0025): `mutation` is forced
    // sequential by the batch planner, and marking it here would suggest the
    // marking is what protects it. Invariant 3 is not an opt-in field.
    spec: PROPOSE_EDIT_SPEC,
    invoke: async (args) => {
      const parsed = parseProposeEditArgs(args);
      if ("error" in parsed) return toolFail("invalid", parsed.error);
      let edits = await validateProposedEdits(
        parsed.edits,
        editHost,
        deps.protectedSpans,
        deps.locale ?? "en",
      );
      const anyValid = edits.some((edit) => edit.status === "pending");
      const policy = editHost.policy();
      const itemId = randomUUID();
      // ADR 0031: THIS batch's note-taker — see makeNoteTaker's comment for
      // why it must not be shared across `invoke` calls.
      const { fileStates, note } = makeNoteTaker();
      const proposalItem = (current: ProposedEdit[]): EditProposalItem => ({
        id: itemId,
        type: "edit_proposal",
        policy,
        edits: current,
        ...(fileStates.size > 0
          ? {
              fileStates: [...fileStates].map(([file, s]) => ({
                file,
                before: s.before,
                after: s.after,
              })),
            }
          : {}),
      });
      if (!anyValid) {
        await emitItem(proposalItem(edits));
        return decisionsOf(edits);
      }
      if (policy === "review") {
        // The pause record: pending statuses persisted so a process death
        // mid-pause replays honestly (replayEntries normalizes → stale).
        await emitItem(proposalItem(edits));
        const decisions: EditDecision[] | undefined = await raceWithAbort(
          editHost.requestDecisions(proposalItem(edits)),
          deps.signal,
        );
        if (decisions === undefined) {
          edits = edits.map((edit) =>
            edit.status === "pending"
              ? {
                  ...edit,
                  status: "stale" as const,
                  note: msg.editInterrupted,
                }
              : edit,
          );
          await emitItem(proposalItem(edits));
          return decisionsOf(edits);
        }
        const decided: ProposedEdit[] = [];
        for (const [i, edit] of edits.entries()) {
          if (edit.status !== "pending") {
            decided.push(edit);
          } else if (decisions[i]?.accept === true) {
            decided.push(await applyOne(edit, note));
          } else {
            decided.push({
              ...edit,
              status: "rejected",
              ...(decisions[i]?.note !== undefined
                ? { note: decisions[i]?.note }
                : {}),
            });
          }
        }
        edits = decided;
        await emitItem(proposalItem(edits));
        return decisionsOf(edits);
      }
      // auto_apply: no pause — apply immediately, one terminal record.
      const applied: ProposedEdit[] = [];
      for (const edit of edits) {
        applied.push(
          edit.status === "pending" ? await applyOne(edit, note) : edit,
        );
      }
      edits = applied;
      await emitItem(proposalItem(edits));
      recordApplied(edits);
      return decisionsOf(edits);
    },
  };

  return {
    tool,
    applied: {
      drain: () => {
        const out = [...appliedThisTurn].map(([file, entry]) => ({
          file,
          edits: entry.edits,
          created: entry.created,
          // Absent, not empty — the same discipline `parseProposeEditArgs`
          // applies when it drops an empty `removes_protected`.
          ...(entry.removed.size > 0
            ? { removesProtected: [...entry.removed] }
            : {}),
        }));
        appliedThisTurn.clear();
        return out;
      },
    },
  };
}
