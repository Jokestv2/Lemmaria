import { randomUUID } from "node:crypto";
import type { SessionEntry, SessionEvent } from "../../src/contracts/index.js";

/**
 * Wrap a flat event list as a session's entries — one persisted record each,
 * in order (ADR 0057).
 *
 * B5 needed this to build a straight BRANCH out of a tree (every event a child
 * of the one before it), so that suites predating ADR 0027 kept asserting
 * exactly what they always had. A session file is linear again, so the wrap is
 * now only about minting record ids — and the suites that use it are, once
 * more, reading the shape they were written against.
 */
export function linearEntries(events: readonly SessionEvent[]): SessionEntry[] {
  return events.map((event) => ({ id: randomUUID(), event }));
}
