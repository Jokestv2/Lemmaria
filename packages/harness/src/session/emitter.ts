import { randomUUID } from "node:crypto";
import type {
  NoticeItem,
  SessionEntry,
  SessionEvent,
  SessionItem,
  SessionLocale,
} from "../contracts/index.js";
import type { TaskSessionStore } from "./child-store.js";
import { NOTICE_MESSAGES } from "./notices.js";

/**
 * A task's event sink (extracted from `run.ts` at B1).
 *
 * Persistence is best-effort once the task is running (the A0 P1 rule);
 * DELIVERY is not — every event, including the terminal `task.completed`,
 * always reaches the live sink. `item.started`/`item.updated` deltas reach the
 * live sink only and are never persisted, so an interrupted partial turn
 * replays clean by construction (ADR 0015).
 */
export interface SessionEmitter {
  /** Persist (unless a delta) then deliver. Never throws. */
  emit(event: SessionEvent): Promise<void>;
  emitItem(item: SessionItem): Promise<void>;
  emitNotice(code: NoticeItem["code"], n: number): Promise<void>;
  /** Every record so far (prior + this task's), for `replayEntries`. */
  entries(): SessionEntry[];
  /** The FIRST append failure, if any — the task must report itself failed. */
  storeError(): string | undefined;
}

export function createSessionEmitter(opts: {
  store: TaskSessionStore;
  sessionId: string;
  prior: readonly SessionEntry[];
  onEvent?: (event: SessionEvent) => void;
  /**
   * Which language this session's notices render in (ADR 0034). Defaults to
   * English, the fallback for every non-Chinese display language — never a
   * reason to emit both.
   */
  locale?: SessionLocale;
}): SessionEmitter {
  const entries: SessionEntry[] = [...opts.prior];
  let storeError: string | undefined;

  const emit = async (event: SessionEvent): Promise<void> => {
    const persist =
      event.type !== "item.started" && event.type !== "item.updated";
    if (persist) {
      // The store mints the record's id, so the in-memory array is the one
      // the file holds. Once an append has failed, persistence stops (the A0
      // P1 rule) but the LIVE history must stay whole — the task is still
      // running and its history still has to be replayable — so the record is
      // minted here instead.
      let entry: SessionEntry | undefined;
      if (storeError === undefined) {
        try {
          entry = await opts.store.append(opts.sessionId, event);
        } catch (err) {
          storeError = err instanceof Error ? err.message : String(err);
        }
      }
      entries.push(entry ?? { id: randomUUID(), event });
    }
    // The sink is host territory (a disposed webview, a broken pipe) — a
    // throwing sink must not break the loop's never-throws contract (P1).
    try {
      opts.onEvent?.(event);
    } catch {
      // Delivery to a broken sink is best-effort; persistence already ran.
    }
  };
  const emitItem = (item: SessionItem) =>
    emit({ type: "item.completed", item });
  const emitNotice = (code: NoticeItem["code"], n: number) =>
    emitItem({
      id: randomUUID(),
      type: "notice",
      code,
      message: NOTICE_MESSAGES[opts.locale ?? "en"][code](n),
      // B2: persist the number, not just the sentence it was baked into — the
      // webview localizes by code and had no way to name it (ADR 0026).
      n,
    });

  return {
    emit,
    emitItem,
    emitNotice,
    entries: () => entries,
    storeError: () => storeError,
  };
}
