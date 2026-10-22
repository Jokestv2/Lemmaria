import { randomUUID } from "node:crypto";
import type {
  SessionEntry,
  SessionEvent,
  SessionId,
} from "../contracts/index.js";
import { replayEntries } from "./replay.js";
import type { LoadedSession } from "./store.js";

/**
 * The minimal store surface `runSessionTask` uses during a task (A3): it only
 * ever calls `load` (once, at start, for the prior entries + their replayed
 * items) and `append`. Both the on-disk `SessionStore` and the ephemeral child store
 * below satisfy this, so a subagent child can run the very same loop with no
 * persistence.
 */
export interface TaskSessionStore {
  load(id: SessionId): Promise<Pick<LoadedSession, "entries" | "items">>;
  append(id: SessionId, event: SessionEvent): Promise<SessionEntry>;
}

/**
 * An in-memory store for a subagent child (A3, ADR 0022). A child's context is
 * ephemeral — only its final report returns to the parent — so it never touches
 * disk, never appears in the resume listing, and never interleaves events into
 * the parent JSONL. One store per child; the id argument is ignored.
 *
 * A child's entries are a straight line, like every session's since ADR 0057:
 * a child never rewinds and has no restore affordance, so an append is always
 * to the end.
 */
export function createInMemorySessionStore(): TaskSessionStore {
  const entries: SessionEntry[] = [];
  return {
    async load() {
      return { entries: [...entries], items: replayEntries(entries) };
    },
    async append(_id, event) {
      const entry: SessionEntry = { id: randomUUID(), event };
      entries.push(entry);
      return entry;
    },
  };
}
