import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  SESSION_FORMAT_VERSION,
  type SessionEntry,
  type SessionEvent,
  type SessionId,
  type SessionItem,
  type SessionMeta,
  type SessionRecord,
} from "../contracts/index.js";
import { cutBeforeItem } from "./cut.js";
import { replayEntries } from "./replay.js";
import { foldFileStates, manifestAt } from "./snapshot.js";

const INDEX_FILE = "index.json";

/**
 * Rebuildable listing cache (ADR 0014) — never the source of truth. Each
 * entry records the session file's byte size at index-write time; `list()`
 * trusts a cached entry only while the size still matches, so an index made
 * stale by a crash between a JSONL write and its index update self-heals on
 * the next listing instead of silently shadowing the files.
 */
interface IndexEntry {
  meta: SessionMeta;
  bytes: number;
  /**
   * File → the sha its content had at this session's leaf: the fold of
   * `manifestAt(entries).current`, cached here so a listing can answer *is
   * this session's work still on disk?* without opening a log (ADR 0058 §3).
   *
   * Maintained incrementally — `{}` at `create`, folded per `append`, computed
   * from the copied prefix at `fork` — and recomputed whole on the same
   * rebuild path a diverged entry already takes. The two must agree, which is
   * asserted rather than reasoned about: a fold that drifts from the rebuild
   * is invisible until a session row lies about disk.
   *
   * There is no representation for a file the session DELETED, because there
   * is nothing a session can persist that means it: `ProposedEdit.kind` is
   * `replace | create`, and `FileState.after` is a plain string.
   */
  files: Record<string, string>;
}

/**
 * One row of a listing: a session's meta plus what it believes is on disk.
 *
 * A return type, not a persisted contract — the shape on disk is `IndexEntry`'s
 * and is versioned by `SESSION_INDEX_VERSION`.
 */
export interface SessionListing {
  meta: SessionMeta;
  files: Record<string, string>;
}
/**
 * The listing cache's own version, which moves with `SESSION_FORMAT_VERSION`
 * (ADR 0057 §3, re-applied by ADR 0058). Named rather than repeated as a
 * literal because missing ONE of its uses degrades in silence: a stale index
 * shadowing files the store would now refuse produces no error, only a wrong
 * listing.
 */
const SESSION_INDEX_VERSION = 4;
type SessionIndexVersion = typeof SESSION_INDEX_VERSION;

interface SessionIndex {
  version: SessionIndexVersion;
  entries: IndexEntry[];
}

function byNewestUpdated(a: IndexEntry, b: IndexEntry): number {
  return a.meta.updatedAt < b.meta.updatedAt ? 1 : -1;
}

/**
 * How many session files `list()` touches at once. Sessions are never deleted,
 * so a working writer's store grows without bound, and every listing validates
 * every file (see `list`) — done one await at a time that is a syscall
 * round-trip per session, which crossed into whole seconds well before the
 * store looked large (~2s at 3.6k sessions on Windows). Bounded rather than
 * `Promise.all` over everything so a huge store cannot exhaust file handles.
 */
const IO_WIDTH = 64;

/** Map `fn` over `items` with bounded concurrency, preserving order. */
async function mapBounded<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let start = 0; start < items.length; start += IO_WIDTH) {
    const done = await Promise.all(
      items.slice(start, start + IO_WIDTH).map(fn),
    );
    for (const [i, value] of done.entries()) out[start + i] = value;
  }
  return out;
}

/** The leaf manifest of a run of entries, flattened for the index (ADR 0058). */
function filesAt(entries: readonly SessionEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, history] of manifestAt(entries))
    out[file] = history.current;
  return out;
}

/**
 * How many branch points a run of copied records holds (ADR 0058) — the
 * DISTINCT non-steered `user_message` items, which is `branchPoints`' rule
 * applied to records instead of replayed items.
 *
 * Distinct, not counted: `edit_proposal`, `script_run` and `subtask` items are
 * each persisted twice, and while a user message is not, a count that assumed
 * so would put the number on a session row out of step with the number of ⟲
 * controls above it the first time that changed.
 *
 * Not `branchPoints(replayEntries(...))`, which would replay the whole prefix
 * to throw all of it away but the ids. The equivalence to what the ⟲ controls
 * render is the spec, and it is pinned as a test rather than as a shared call.
 */
function branchPointsIn(copied: readonly { record: SessionRecord }[]): number {
  const ids = new Set<string>();
  for (const { record } of copied) {
    if (record.kind !== "event") continue;
    const { event } = record;
    if (event.type !== "item.completed") continue;
    const { item } = event;
    if (item.type === "user_message" && item.steered !== true) ids.add(item.id);
  }
  return ids.size;
}

/** Collapse whitespace and cap the listing title (first user message). */
export function sessionTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  // Cap by code points, not UTF-16 units — never split a surrogate pair.
  const points = [...oneLine];
  return points.length <= 64 ? oneLine : `${points.slice(0, 63).join("")}…`;
}

export interface LoadedSession {
  meta: SessionMeta;
  /**
   * Every persisted record of this session, in file order — which is the whole
   * conversation, since ADR 0057 made the file linear again. There is no
   * second array and no leaf picking a subset out of a tree: `entries` is what
   * every fold reads, `sumSessionUsage` included, and ADR 0018's "cost history
   * is deliberately not rewritten" holds for free.
   */
  entries: SessionEntry[];
  /** The transcript these entries replay to. */
  items: SessionItem[];
  /** Unparseable JSONL lines skipped during load (e.g. a torn tail write). */
  skippedLines: number;
}

/**
 * Append-only JSONL session store (ADR 0014, made a tree by ADR 0027 and made
 * linear again by ADR 0057). One `<id>.jsonl` per session: a versioned meta
 * record first, then event records, in the order they happened.
 * Location-agnostic: the extension roots it in globalStorage keyed by
 * workspace; a future CLI uses `~/.lemmaria/sessions/`. Quick actions never
 * write here (v0.2 direction).
 *
 * Branching is `fork`, which writes a NEW file. Nothing mutates a session
 * except appending to its end, so there is no pointer for two writers to race
 * and no way for a record to end up unreachable.
 */
export class SessionStore {
  constructor(readonly rootDir: string) {}

  /** Per-session mutation chains — see `serialized`. */
  private readonly writeQueues = new Map<SessionId, Promise<unknown>>();

  /**
   * Sessions whose file this process has already checked for a torn tail — see
   * `ensureNewlineTail`. A process-local accelerator, never the source of
   * truth, and exactly the cost profile ADR 0027 had: one check per session per
   * process, on its first append.
   */
  private readonly tailChecked = new Set<SessionId>();

  private file(id: SessionId): string {
    return join(this.rootDir, `${id}.jsonl`);
  }

  async create(input: {
    title: string;
    workspace: string;
  }): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: sessionTitle(input.title),
      workspace: input.workspace,
      createdAt: now,
      updatedAt: now,
    };
    await mkdir(this.rootDir, { recursive: true });
    const record: SessionRecord = {
      at: now,
      kind: "meta",
      version: SESSION_FORMAT_VERSION,
      meta,
    };
    // wx: a session file is created exactly once, never overwritten.
    await writeFile(this.file(meta.id), `${JSON.stringify(record)}\n`, {
      flag: "wx",
    });
    await this.upsertIndex(meta, undefined, {});
    return meta;
  }

  /**
   * A crash between an append's bytes leaves the file with no closing newline,
   * and the next `appendFile` would FUSE its record onto that torn line —
   * losing it too. Skipping the torn line on read (`load`) is only half the
   * repair; this is the other half, and it has to run before a WRITE, not
   * before a read. Adapted from Pi's fix for its issue #8345 (MIT).
   *
   * Reads one byte, not the file: ADR 0027 got this for free because `append`
   * derived its leaf through `load`, and ADR 0057 deleted that read. Once per
   * session per process — after this process's first append, it wrote the
   * newline itself and knows the tail is sound.
   *
   * A file with no meta record is still repaired here, unlike in `load`, which
   * checks the header first so that a file that is not a session is never
   * written to. The difference is safe because `requireSession` has already
   * run: this only ever touches a path the store itself created.
   */
  private async ensureNewlineTail(id: SessionId): Promise<void> {
    if (this.tailChecked.has(id)) return;
    const handle = await open(this.file(id), "r+");
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) await handle.write("\n", size);
      }
    } finally {
      await handle.close();
    }
    this.tailChecked.add(id);
  }

  /**
   * Append one event to the end of the session, and return the record it
   * wrote. Callers thread nothing: a session grows only at its end.
   */
  async append(id: SessionId, event: SessionEvent): Promise<SessionEntry> {
    // `appendFile` would happily create an orphan meta-less file, so an
    // unknown id must name what went wrong rather than surfacing as ENOENT.
    await this.requireSession(id);
    return this.serialized(id, async () => {
      await this.ensureNewlineTail(id);
      const entry: SessionEntry = { id: randomUUID(), event };
      const at = await this.appendRecord(id, {
        at: "",
        kind: "event",
        id: entry.id,
        event,
      });
      await this.refreshIndexAfterAppend(id, at, { entry });
      return entry;
    });
  }

  /**
   * Name a session after its meta record was written (ADR 0058).
   *
   * A rewind fork is born untitled, because at fork time the child has no
   * message of its own — the message that would have named it went back to the
   * composer. Its first send names it, the way a fresh session's first message
   * names that one, and this is how that reaches disk: one appended `title`
   * record, latest-wins on load. Nothing is rewritten, so the append-only rule
   * ADR 0014 built the store on holds.
   *
   * The index upsert is not a nicety. `refreshIndexAfterAppend` reuses the
   * CACHED meta and `list()` trusts a cache entry whose byte count matches, so
   * an appended record that changes meta-derived state is served STALE by
   * `list()` unless the entry is explicitly corrected — and the Sessions view
   * reads the index and never `load()`s. Pinned by the cache-trap test.
   */
  async setTitle(id: SessionId, title: string): Promise<void> {
    await this.requireSession(id);
    const capped = sessionTitle(title);
    return this.serialized(id, async () => {
      await this.ensureNewlineTail(id);
      const at = await this.appendRecord(id, {
        at: "",
        kind: "title",
        title: capped,
      });
      await this.refreshIndexAfterAppend(id, at, { title: capped });
    });
  }

  /**
   * Run one session's mutations strictly one at a time.
   *
   * ADR 0027 needed this for read-leaf → write-record → set-leaf, and ADR 0057
   * deletes that critical section — but the queue stays, for two reasons that
   * outlive it. `refreshIndexAfterAppend` is a read-modify-write of
   * `index.json`, so two concurrent appends would both read the pre-write
   * cache and the later `writeIndex` would drop the earlier one's entry
   * (self-healing on the next `list()`, at the cost of a full re-validation).
   * And callers rely on records landing in the order they made them; nothing
   * else provides that. Both are reachable in the extension, where
   * `grants-host` appends a `grant_update` straight from a webview message,
   * with no in-flight guard, while the task loop awaits its own emits.
   *
   * A promise chain per session id, not a lock over the whole store: two
   * different sessions have nothing to serialize. The chain continues through
   * a rejection (`.then(op, op)`), so one failed append cannot wedge the rest
   * of the session, and the queue entry is dropped once it is the tail again.
   */
  private serialized<T>(id: SessionId, op: () => Promise<T>): Promise<T> {
    const prior = this.writeQueues.get(id) ?? Promise.resolve();
    const result = prior.then(op, op);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(id, settled);
    void settled.then(() => {
      if (this.writeQueues.get(id) === settled) this.writeQueues.delete(id);
    });
    return result;
  }

  /** appendFile would happily create an orphan meta-less file — fail fast. */
  private async requireSession(id: SessionId): Promise<void> {
    try {
      await access(this.file(id));
    } catch {
      throw new Error(`unknown session: ${id}`);
    }
  }

  /** Stamp `at`, write one JSONL line, and return the stamp. */
  private async appendRecord(
    id: SessionId,
    record: SessionRecord,
  ): Promise<string> {
    const at = new Date().toISOString();
    await appendFile(this.file(id), `${JSON.stringify({ ...record, at })}\n`);
    return at;
  }

  /**
   * Bring one session's index entry up to date after a record was appended.
   *
   * `title` corrects the cached meta after a `setTitle`, and `entry` advances
   * the cached leaf manifest by exactly the record just written (ADR 0058 §3)
   * — the incremental half of the fold, which is why an append costs one
   * `foldFileStates` rather than a re-read of the log. On the cache-MISS arm
   * neither is applied: the reload already folds both.
   */
  private async refreshIndexAfterAppend(
    id: SessionId,
    at: string,
    change: { title?: string; entry?: SessionEntry },
  ): Promise<void> {
    // Read the cache ONCE and hand it on: every append refreshes this
    // session's entry, and re-parsing the whole index inside `upsertIndex` too
    // doubled that cost for nothing (the file is megabyte-scale on a store
    // with thousands of sessions, and this runs per event, not per turn).
    const index = await this.readIndexRaw();
    const cached = index?.entries.find((e) => e.meta.id === id);
    if (!cached) {
      const loaded = await this.load(id);
      await this.upsertIndex(loaded.meta, index, filesAt(loaded.entries));
      return;
    }
    const meta = {
      ...cached.meta,
      updatedAt: at,
      ...(change.title === undefined ? {} : { title: change.title }),
    };
    let files = cached.files ?? {};
    if (change.entry) {
      const manifest = new Map(
        Object.entries(files).map(
          ([f, sha]) => [f, { first: sha, current: sha }] as const,
        ),
      );
      foldFileStates(manifest, change.entry);
      files = Object.fromEntries(
        [...manifest].map(([f, history]) => [f, history.current]),
      );
    }
    await this.upsertIndex(meta, index, files);
  }

  /**
   * Newest-updated first. The index is only an accelerator: every listing
   * re-scans the directory and re-validates each cached entry against the
   * file's current size, reloading (or dropping) whatever diverged — the
   * JSONL files stay the single source of truth (ADR 0014).
   *
   * Returns each row's leaf file manifest beside its meta (ADR 0058 §3), so a
   * caller can ask whether a session's work is still on disk without opening
   * one log — which is what keeps the Sessions view a pure index reader.
   */
  async list(): Promise<SessionListing[]> {
    let names: string[];
    try {
      names = (await readdir(this.rootDir)).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return []; // no directory yet = no sessions
    }
    const index = await this.readIndexRaw();
    // Keyed, not scanned: a `find` per file made validation quadratic in the
    // session count, which is seconds of pure comparison before any I/O once a
    // store reaches a few thousand sessions.
    const cachedById = new Map(
      (index?.entries ?? []).map((e) => [e.meta.id, e] as const),
    );
    const entries: IndexEntry[] = [];
    const diverged: { id: string; bytes: number }[] = [];
    let dirty = index === undefined;
    const sizes = await mapBounded(names, async (name) => {
      try {
        return (await stat(join(this.rootDir, name))).size;
      } catch {
        return undefined; // vanished between readdir and stat
      }
    });
    for (const [i, name] of names.entries()) {
      const bytes = sizes[i];
      if (bytes === undefined) continue;
      const id = name.slice(0, -".jsonl".length);
      const cached = cachedById.get(id);
      if (cached && cached.bytes === bytes) entries.push(cached);
      else diverged.push({ id, bytes });
    }
    if (diverged.length > 0) {
      dirty = true;
      const reloaded = await mapBounded(diverged, async ({ id, bytes }) => {
        try {
          // The rebuild recomputes the manifest WHOLE, which is what the
          // incremental fold above is asserted against.
          const loaded = await this.load(id);
          return { meta: loaded.meta, bytes, files: filesAt(loaded.entries) };
        } catch {
          return undefined; // unreadable session file: left out of the listing
        }
      });
      for (const entry of reloaded) if (entry) entries.push(entry);
    }
    if (index !== undefined && index.entries.length !== entries.length)
      dirty = true; // index knew sessions whose files are gone
    entries.sort(byNewestUpdated);
    if (dirty) {
      try {
        await this.writeIndex({ version: SESSION_INDEX_VERSION, entries });
      } catch {
        // the repaired listing is still returned; the cache heals next time
      }
    }
    return entries.map((e) => ({ meta: e.meta, files: e.files ?? {} }));
  }

  /**
   * The one parser of a session file (ADR 0057). Two consumers: `load`, which
   * folds the records into entries, and `fork`, which copies their RAW lines.
   *
   * `fork` needs the raw text because a `SessionEntry` carries no `at`, so a
   * copy rebuilt from entries would silently re-stamp every record with the
   * fork's own time — turning *when this turn happened* into *when someone
   * rewound*. Sharing the parser is what keeps the two readers agreeing about
   * the version check, the skip rules and what counts as a record.
   *
   * Reads only. `load`'s torn-tail repair stays in `load`, because a fork must
   * never write the session it copies.
   */
  private parseRecords(
    raw: string,
    id: SessionId,
  ): {
    meta: SessionMeta;
    lines: { raw: string; record: SessionRecord }[];
    lastAt: string | undefined;
    skippedLines: number;
  } {
    let meta: SessionMeta | undefined;
    let lastAt: string | undefined;
    let skippedLines = 0;
    // Latest-wins (ADR 0058). Folded after the loop rather than into `meta` as
    // it goes, so a title record that precedes the meta record in a
    // hand-mangled file still names the session rather than being overwritten
    // by the header it appears before.
    let titled: string | undefined;
    const lines: { raw: string; record: SessionRecord }[] = [];
    for (const line of raw.split("\n").filter((l) => l.trim() !== "")) {
      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        skippedLines += 1;
        continue;
      }
      if (record.kind === "meta") {
        if (record.version !== SESSION_FORMAT_VERSION)
          throw new Error(
            `unsupported session format (expected ${SESSION_FORMAT_VERSION}, got ${String(record.version)}): ${id}`,
          );
        meta = record.meta;
      } else if (record.kind === "event") {
        if (typeof record.id !== "string") {
          skippedLines += 1;
          continue;
        }
      } else if (record.kind === "title") {
        if (typeof record.title !== "string") {
          skippedLines += 1;
          continue;
        }
        titled = record.title;
      } else {
        skippedLines += 1;
        continue;
      }
      lines.push({ raw: line, record });
      lastAt = record.at;
    }
    if (!meta)
      throw new Error(`malformed session file (no meta record): ${id}`);
    return {
      meta: titled === undefined ? meta : { ...meta, title: titled },
      lines,
      lastAt,
      skippedLines,
    };
  }

  /**
   * Fork a session into a NEW one (ADR 0057, superseding ADR 0027's in-file
   * tree): a fresh file whose `event` records are a verbatim copy of the
   * source's up to the cut, with record ids and `at` stamps preserved.
   *
   * `cutBeforeItemId` names the item the copy stops before (`cutBeforeItem`);
   * omit it to copy the whole session, which is what `/fork` does. Record ids
   * are preserved because they are the handles a rewind point and this cut
   * resolve by — re-minting them would give one conversation two id spaces.
   *
   * **The source is never written**, which is what makes a rewind
   * non-destructive now that nothing moves a leaf. An unknown source id or an
   * unresolvable cut throws and writes nothing: a refusal, never a widened
   * copy (ADR 0018's rule, carried forward).
   */
  async fork(
    sourceId: SessionId,
    opts: { cutBeforeItemId?: string; title?: string },
  ): Promise<SessionMeta> {
    await this.requireSession(sourceId);
    const raw = await readFile(this.file(sourceId), "utf8");
    const { meta: source, lines } = this.parseRecords(raw, sourceId);
    // `title` records are dropped here, and that is the rule that keeps a
    // child from resurrecting its parent's names: the child's own effective
    // title comes from `opts.title ?? source.title`, where `source.title` is
    // already the parent's FOLDED title (ADR 0058).
    const events = lines.filter((l) => l.record.kind === "event");
    let copied = events;
    if (opts.cutBeforeItemId !== undefined) {
      const entries: SessionEntry[] = events.map((l) => {
        const record = l.record as Extract<SessionRecord, { kind: "event" }>;
        return { id: record.id, event: record.event };
      });
      const cut = cutBeforeItem(entries, opts.cutBeforeItemId);
      // `=== undefined`, never `!cut`: 0 is a legitimate cut (the item is the
      // first record, and the copy is empty).
      if (cut === undefined)
        throw new Error(
          `unknown session item: ${opts.cutBeforeItemId} (in ${sourceId})`,
        );
      copied = events.slice(0, cut);
    }
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: sessionTitle(opts.title ?? source.title),
      workspace: source.workspace,
      createdAt: now,
      updatedAt: now,
      forkedFrom: {
        sessionId: sourceId,
        cutBeforeItemId: opts.cutBeforeItemId ?? null,
        // Only a cut has an ordinal: a fork at the end cut before nothing.
        ...(opts.cutBeforeItemId === undefined
          ? {}
          : { atMessage: branchPointsIn(copied) + 1 }),
      },
    };
    const header: SessionRecord = {
      at: now,
      kind: "meta",
      version: SESSION_FORMAT_VERSION,
      meta,
    };
    await mkdir(this.rootDir, { recursive: true });
    // One write, `wx` like `create`: a session file is created exactly once.
    await writeFile(
      this.file(meta.id),
      [JSON.stringify(header), ...copied.map((l) => l.raw), ""].join("\n"),
      { flag: "wx" },
    );
    // The child's leaf manifest is the COPIED PREFIX's, not the parent's — the
    // records are already parsed here, so this costs no second read.
    await this.upsertIndex(
      meta,
      undefined,
      filesAt(
        copied.map((l) => {
          const record = l.record as Extract<SessionRecord, { kind: "event" }>;
          return { id: record.id, event: record.event };
        }),
      ),
    );
    return meta;
  }

  async load(id: SessionId): Promise<LoadedSession> {
    const raw = await readFile(this.file(id), "utf8");
    const { meta, lines, lastAt, skippedLines } = this.parseRecords(raw, id);
    const entries: SessionEntry[] = [];
    for (const { record } of lines)
      if (record.kind === "event")
        entries.push({ id: record.id, event: record.event });
    // A crash between an append's bytes leaves the file with no closing
    // newline, and `appendFile` would then FUSE the next record onto that torn
    // line — losing it too. Skipping the torn line on read (above) is only half
    // the repair; this is the other half. Adapted from Pi's fix for its issue
    // #8345 (MIT).
    //
    // AFTER the meta check, so a file that is not a session is never written
    // to — Pi's ordering, and the reason its own fix validates the header
    // first. Deliberately NOT through `serialized`: a bare one-byte O_APPEND is
    // safe without it, and the worst a race can produce is a blank line, which
    // the split above already drops.
    if (!raw.endsWith("\n")) await appendFile(this.file(id), "\n");
    // updatedAt advances with appends; recover it from the tail timestamp so a
    // rebuilt index (which reads through load) stays honestly ordered.
    //
    // Never EARLIER than `createdAt` (ADR 0057): a fork's tail is a COPIED
    // record whose `at` predates the fork, so the bare tail stamp would sort a
    // freshly-forked child behind its own parent — and the child is the session
    // the user is now in. For a session that was not forked the tail is always
    // at or after creation, so this changes nothing about one.
    const recovered =
      lastAt !== undefined && lastAt > meta.createdAt ? lastAt : meta.createdAt;
    const withUpdated: SessionMeta = { ...meta, updatedAt: recovered };
    return {
      meta: withUpdated,
      entries,
      items: replayEntries(entries),
      skippedLines,
    };
  }

  /** The raw cache, or undefined when missing/corrupt/an older shape. */
  private async readIndexRaw(): Promise<SessionIndex | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.rootDir, INDEX_FILE), "utf8"),
      ) as SessionIndex;
      if (
        parsed.version === SESSION_INDEX_VERSION &&
        Array.isArray(parsed.entries)
      )
        return parsed;
    } catch {
      // missing or unreadable — callers fall back to the JSONL files
    }
    return undefined;
  }

  /** Refresh one session's cache entry (with its file's current size).
   *  `known` is the caller's already-read cache, when it has one. */
  private async upsertIndex(
    meta: SessionMeta,
    known: SessionIndex | undefined,
    files: Record<string, string>,
  ): Promise<void> {
    const bytes = (await stat(this.file(meta.id))).size;
    const index = known ??
      (await this.readIndexRaw()) ?? {
        version: SESSION_INDEX_VERSION,
        entries: [],
      };
    const entries = [
      { meta, bytes, files },
      ...index.entries.filter((e) => e.meta.id !== meta.id),
    ];
    entries.sort(byNewestUpdated);
    await this.writeIndex({ version: SESSION_INDEX_VERSION, entries });
  }

  private async writeIndex(index: SessionIndex): Promise<void> {
    await writeFile(join(this.rootDir, INDEX_FILE), JSON.stringify(index));
  }
}
