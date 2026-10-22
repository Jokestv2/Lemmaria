/**
 * propose_edit batch validation + the revalidating splice (ADR 0016).
 * Pure helpers: the loop (run.ts) owns policy branching and persistence; the
 * SessionEditHost owns IO. Anchor discipline is ADR 0007's — verbatim,
 * exactly once — via the same locateAnchor.
 */

import type {
  ProposedEdit,
  ProtectedSpan,
  ProtectedSpanReader,
  SessionEditHost,
  SessionItem,
  SessionLocale,
} from "../contracts/index.js";
import { locateAnchor } from "../engine/anchored-edit.js";
import {
  missingProtectedSpan,
  protectedSpanRefusal,
  undeclarableRemoval,
  undeclarableRemovalRefusal,
} from "./protected-edits.js";

/**
 * Parse + shape-validate raw propose_edit args into pending ProposedEdits.
 * A malformed payload (not an object, edits missing/empty/not an array, an
 * entry that is neither a replace {file, anchor, replacement} nor a create
 * {file, create: true, content}) returns a single honest error.
 */
export function parseProposeEditArgs(
  raw: unknown,
): { edits: ProposedEdit[] } | { error: string } {
  if (typeof raw !== "object" || raw === null || !("edits" in raw)) {
    return { error: "propose_edit expects { edits: [...] }" };
  }
  const list = (raw as { edits: unknown }).edits;
  if (!Array.isArray(list) || list.length === 0) {
    return { error: "propose_edit expects a non-empty edits array" };
  }
  const edits: ProposedEdit[] = [];
  for (const [i, entry] of list.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { error: `edits[${i}] is not an object` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.file !== "string") {
      return { error: `edits[${i}].file must be a string` };
    }
    if (e.create === true) {
      if (typeof e.content !== "string") {
        return { error: `edits[${i}] is a create but has no string content` };
      }
      edits.push({
        file: e.file,
        kind: "create",
        content: e.content,
        status: "pending",
      });
    } else if (
      typeof e.anchor === "string" &&
      typeof e.replacement === "string"
    ) {
      // X2 (ADR 0033): the declared-removal escape. Present-but-malformed is
      // rejected rather than silently dropped — a model that meant to declare
      // a removal and got the shape wrong must learn that, not be refused for
      // the removal it thought it had declared.
      if (e.removes_protected !== undefined) {
        if (
          !Array.isArray(e.removes_protected) ||
          e.removes_protected.some((r) => typeof r !== "string")
        ) {
          return {
            error: `edits[${i}].removes_protected must be an array of strings`,
          };
        }
      }
      edits.push({
        file: e.file,
        kind: "replace",
        anchor: e.anchor,
        replacement: e.replacement,
        status: "pending",
        ...(Array.isArray(e.removes_protected) && e.removes_protected.length > 0
          ? { removesProtected: e.removes_protected as string[] }
          : {}),
      });
    } else {
      return {
        error: `edits[${i}] must be {file, anchor, replacement} or {file, create: true, content}`,
      };
    }
  }
  return { edits };
}

/**
 * Workspace-relative containment (pure): rejects empty, absolute (posix,
 * drive-letter, or UNC), and `..`-escaping paths; backslashes are normalized
 * for the check. Returns the reason, or undefined when acceptable.
 */
export function invalidPathReason(
  file: string,
  /** D4 (ADR 0034): the language the reason renders in — it reaches the user in
   *  the proposal row, not only the model in the decision array. */
  locale: SessionLocale = "en",
): string | undefined {
  const zh = locale === "zh";
  if (file.trim() === "") return zh ? "路径为空" : "empty path";
  const normalized = file.replace(/\\/g, "/");
  const absolute = zh ? "不允许使用绝对路径" : "absolute paths are not allowed";
  if (normalized.startsWith("/")) return absolute;
  if (/^[A-Za-z]:/.test(normalized)) return absolute;
  const segments = normalized.split("/");
  // `.git` is never a legitimate propose_edit target, and writing there is
  // uniquely dangerous: a hook is executable and runs on the user's next
  // commit, and a write into the object store can corrupt the repository
  // itself (round-2 review). The rule predates ADR 0031 — it was also what
  // kept a hook out of reach of the git checkpoint restore — but it stands on
  // its own now that restores are content-addressed rather than git-backed.
  if (segments.some((segment) => segment === ".git")) {
    return zh ? "不允许写入 .git" : "writes into .git are not allowed";
  }
  let depth = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    depth += segment === ".." ? -1 : 1;
    if (depth < 0)
      return zh ? "路径超出了工作区" : "path escapes the workspace";
  }
  return undefined;
}

/** The two anchor failures, in the reader's language (ADR 0034). */
function anchorNote(error: string, locale: SessionLocale): string {
  if (locale === "zh") {
    return error === "ambiguous"
      ? "锚点不唯一——它必须恰好出现一次；请扩展锚点直到唯一"
      : "找不到锚点——请从文件中逐字复制";
  }
  return error === "ambiguous"
    ? "anchor is ambiguous — it must occur exactly once; extend it until unique"
    : "anchor not found — copy it verbatim from the file";
}

/**
 * Proposal-time validation against current file contents: bad path →
 * invalid; replace whose file is missing or whose anchor is not found /
 * ambiguous (locateAnchor) → invalid with the honest reason; create whose
 * target exists → invalid. Valid edits stay pending. Returns a new array.
 *
 * D1 (ADR 0032) adds a fourth arm, LAST: a replacement that drops a protected
 * span its anchor contained → invalid. Last because an anchor defect has the
 * more useful message — a model told about a protected span when its anchor
 * never matched would go and fix the wrong thing. `protect` absent (or
 * answering `undefined` for a file it cannot analyse) ⇒ this arm does nothing
 * and the function behaves exactly as it did before D1.
 */
export async function validateProposedEdits(
  edits: ProposedEdit[],
  host: Pick<SessionEditHost, "readFile" | "fileExists">,
  protect?: ProtectedSpanReader,
  /** X2 (ADR 0034): the language a refusal note renders in. */
  locale: SessionLocale = "en",
): Promise<ProposedEdit[]> {
  const validated: ProposedEdit[] = [];
  for (const edit of edits) {
    const pathReason = invalidPathReason(edit.file, locale);
    if (pathReason) {
      validated.push({ ...edit, status: "invalid", note: pathReason });
      continue;
    }
    if (edit.kind === "create") {
      if (await host.fileExists(edit.file)) {
        validated.push({
          ...edit,
          status: "invalid",
          note:
            locale === "zh"
              ? `文件已存在：${edit.file}`
              : `file already exists: ${edit.file}`,
        });
      } else {
        validated.push({ ...edit });
      }
      continue;
    }
    const content = await host.readFile(edit.file);
    if (content === undefined) {
      validated.push({
        ...edit,
        status: "invalid",
        note:
          locale === "zh"
            ? `找不到文件：${edit.file}`
            : `file not found: ${edit.file}`,
      });
      continue;
    }
    const located = locateAnchor(content, edit.anchor ?? "");
    if ("error" in located) {
      validated.push({
        ...edit,
        status: "invalid",
        note: anchorNote(located.error, locale),
      });
      continue;
    }
    const verdict = await protectedVerdict(protect, edit);
    if (verdict?.kind === "undeclarable") {
      validated.push({
        ...edit,
        status: "invalid",
        note: undeclarableRemovalRefusal(verdict.raw, locale),
      });
      continue;
    }
    if (verdict?.kind === "lost") {
      validated.push({
        ...edit,
        status: "invalid",
        note: protectedSpanRefusal(verdict.span, locale),
      });
      continue;
    }
    validated.push({ ...edit });
  }
  return validated;
}

/**
 * The protected span this replace edit would lose, if any (D1, ADR 0032).
 * A reader that rejects yields `undefined`: a parse failure must degrade to
 * "we could not analyse this", never to a refusal of an edit we cannot judge.
 */
async function protectedVerdict(
  protect: ProtectedSpanReader | undefined,
  edit: ProposedEdit,
): Promise<
  | { kind: "lost"; span: ProtectedSpan }
  | { kind: "undeclarable"; raw: string }
  | undefined
> {
  if (!protect) return undefined;
  const anchor = edit.anchor ?? "";
  if (anchor === "") return undefined;
  let spans: ProtectedSpan[] | undefined;
  try {
    spans = await protect(edit.file, anchor);
  } catch {
    return undefined;
  }
  if (!spans || spans.length === 0) return undefined;
  const declared = edit.removesProtected ?? [];
  // A dishonest declaration is reported BEFORE a loss: the model needs to know
  // its escape was rejected, or it reads the loss refusal as "the declaration
  // did not work" and retries with the same bad entry (ADR 0033 s2).
  const bogus = undeclarableRemoval(spans, declared);
  if (bogus !== undefined) return { kind: "undeclarable", raw: bogus };
  const span = missingProtectedSpan(
    anchor,
    edit.replacement ?? "",
    spans,
    declared,
  );
  return span ? { kind: "lost", span } : undefined;
}

/**
 * Apply-time splice with revalidation (ADR 0016 round-2 pin): callers pass
 * the file's CURRENT content; the anchor is located again (exactly-once) and
 * spliced. Returns undefined when the anchor no longer matches — the edit
 * turns `stale`, nothing is written, never a fuzzy match.
 */
export function spliceAnchor(
  content: string,
  anchor: string,
  replacement: string,
): string | undefined {
  const located = locateAnchor(content, anchor);
  if ("error" in located) return undefined;
  return (
    content.slice(0, located.offset) +
    replacement +
    content.slice(located.offset + anchor.length)
  );
}

/**
 * The approval UNIT is the file, not the edit (A1b manual-test finding): a
 * batch of five typo fixes in one paper is one decision a reviewer makes once,
 * not five. Groups a batch's edits by file in first-appearance order, carrying
 * the original indices so the posted decision array stays parallel to
 * `item.edits` — the contract is per-edit; only the UI granularity is per-file.
 */
export function groupEditsByFile(
  edits: ProposedEdit[],
): { file: string; indices: number[] }[] {
  const groups: { file: string; indices: number[] }[] = [];
  const byFile = new Map<string, { file: string; indices: number[] }>();
  for (const [i, edit] of edits.entries()) {
    let group = byFile.get(edit.file);
    if (!group) {
      group = { file: edit.file, indices: [] };
      byFile.set(edit.file, group);
      groups.push(group);
    }
    group.indices.push(i);
  }
  return groups;
}

/**
 * The proposed content of ONE file after all of its edits in a batch — the
 * combined-diff source for a per-file decision. Replaces splice in order over
 * the evolving content (each anchor is still located exactly once); a create
 * contributes its content as the whole file. undefined when any anchor no
 * longer matches — the same honest "nothing to preview" as a single edit.
 */
export function spliceEditsForFile(
  content: string,
  edits: ProposedEdit[],
): string | undefined {
  let current = content;
  for (const edit of edits) {
    if (edit.kind === "create") {
      current = edit.content ?? "";
      continue;
    }
    const next = spliceAnchor(
      current,
      edit.anchor ?? "",
      edit.replacement ?? "",
    );
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/**
 * Collapse one file group's per-edit statuses into the single status its row
 * shows, plus the per-status counts. Undecided wins (the row is still a
 * question); otherwise **`applied` wins over any failure** — a row that says
 * `invalid` while one of its edits was written to disk hides a real write
 * from the user, which the counts then qualify honestly.
 */
export function summarizeEditGroup(edits: ProposedEdit[]): {
  status: ProposedEdit["status"];
  counts: Partial<Record<ProposedEdit["status"], number>>;
} {
  const counts: Partial<Record<ProposedEdit["status"], number>> = {};
  for (const edit of edits) {
    counts[edit.status] = (counts[edit.status] ?? 0) + 1;
  }
  const status = counts.pending
    ? "pending"
    : counts.applied
      ? "applied"
      : (edits.find((e) => e.status !== "applied")?.status ?? "applied");
  return { status, counts };
}

/**
 * Is the task paused on the user (a proposal batch with an undecided edit)?
 * The UI uses this to tell "the model is working" from "we are waiting on
 * you" — a busy/thinking indicator must not run during an approval pause
 * (A1b manual-test finding).
 */
export function awaitsEditDecision(items: SessionItem[]): boolean {
  return items.some(
    (item) =>
      item.type === "edit_proposal" &&
      item.edits.some((edit) => edit.status === "pending"),
  );
}

/**
 * Which user messages the conversation can branch at (ADR 0031) — every
 * non-steered one, unconditionally.
 *
 * B6 needed two functions here: `forkTargets` (can the conversation branch?)
 * and `restoreTargets` (does a git ref exist to put the files back?). The
 * second question no longer exists — every node's file state is derivable from
 * the log — so the split, the two modal wordings it fed, and the refusal path
 * when the two disagreed are all gone.
 *
 * Steered messages stay excluded for the reason they always were: they joined
 * a RUNNING task, so they are not task boundaries, and branching there would
 * split a turn from its own request.
 */
export function branchPoints(items: readonly SessionItem[]): string[] {
  return items
    .filter((i) => i.type === "user_message" && i.steered !== true)
    .map((i) => i.id);
}

/**
 * Files APPLIED as creations at or after the given user message. Bookkeeping
 * from the persisted transcript, never filesystem archaeology; an unknown
 * message id yields nothing rather than guessing a scope.
 */
export function createdFilesSince(
  items: SessionItem[],
  userMessageId: string,
): string[] {
  const from = items.findIndex((item) => item.id === userMessageId);
  if (from < 0) return [];
  const created = new Set<string>();
  for (const item of items.slice(from)) {
    if (item.type !== "edit_proposal") continue;
    for (const edit of item.edits) {
      if (edit.kind === "create" && edit.status === "applied") {
        created.add(edit.file);
      }
    }
  }
  return [...created];
}
