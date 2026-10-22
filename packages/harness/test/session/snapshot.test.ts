import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/contracts/index.js";
import {
  type FileManifest,
  manifestAt,
  restoreBaselines,
  restorePlan,
} from "../../src/session/snapshot.js";

/** A node carrying one applied batch. */
const wrote = (
  id: string,
  fileStates: { file: string; before: string | null; after: string }[],
): SessionEntry => ({
  id,
  event: {
    type: "item.completed",
    item: {
      id: `i-${id}`,
      type: "edit_proposal",
      policy: "auto_apply",
      edits: [],
      fileStates,
    },
  },
});

/** A node that wrote nothing — a plain question. */
const asked = (id: string): SessionEntry => ({
  id,
  event: {
    type: "item.completed",
    item: { id: `i-${id}`, type: "user_message", text: "?" },
  },
});

describe("manifestAt", () => {
  it("folds to the newest sha per file, remembering the first before", () => {
    const entries = [
      wrote("n1", [{ file: "c.tex", before: "sha0", after: "sha1" }]),
      wrote("n2", [{ file: "c.tex", before: "sha1", after: "sha2" }]),
    ];
    expect(manifestAt(entries).get("c.tex")).toEqual({
      first: "sha0",
      current: "sha2",
    });
  });

  it("is empty for entries that carry no fileStates", () => {
    expect(manifestAt([asked("n1")]).size).toBe(0);
  });

  // The guard is `item.fileStates === undefined`, and the test above reaches it
  // through a `user_message` — which the PRECEDING check (`type !==
  // "edit_proposal"`) already rejects. So the undefined-guard itself was never
  // executed. This is the batch that applied nothing, and every pre-ADR-0031
  // session on disk.
  it("ignores an edit_proposal whose fileStates is literally undefined", () => {
    const applied: SessionEntry = {
      id: "n1",
      event: {
        type: "item.completed",
        item: {
          id: "i-n1",
          type: "edit_proposal",
          policy: "auto_apply",
          edits: [],
        },
      },
    };
    expect(manifestAt([applied]).size).toBe(0);
  });
});

/**
 * The shape ADR 0057 gives these folds: two INDEPENDENT histories, which is
 * what a fork produces — a shared prefix (`root`) and then a draft each. The
 * assertions below are B5/B6's, unchanged in substance; only the fixture stops
 * being one file's tree and becomes what it now is, two sessions' entries.
 */
const trunk: SessionEntry[] = [asked("root")];
const draftOne: SessionEntry[] = [
  ...trunk,
  wrote("d1", [{ file: "c.tex", before: "shaOrig", after: "shaOne" }]),
];
const draftTwo: SessionEntry[] = [
  ...trunk,
  wrote("d2", [{ file: "c.tex", before: "shaOrig", after: "shaTwo" }]),
];
const m = (entries: readonly SessionEntry[]): FileManifest =>
  manifestAt(entries);

describe("restoreBaselines", () => {
  it("is the departing history's CURRENT sha per file, never its `first`", () => {
    // The drift baseline: "unchanged since the agent left it" is about the
    // bytes on disk now, so `first` — where the file started — must not leak
    // in, or a second edit to the same file would read as a hand edit.
    const twice = [
      asked("root"),
      wrote("n1", [{ file: "c.tex", before: "sha0", after: "sha1" }]),
      wrote("n2", [{ file: "c.tex", before: "sha1", after: "sha2" }]),
    ];
    expect([...restoreBaselines(m(twice), m(twice))]).toEqual([
      ["c.tex", "sha2"],
    ]);
  });

  it("is scoped to the departing history, so the other draft never appears", () => {
    expect(restoreBaselines(m(draftOne), m(draftOne)).get("c.tex")).toBe(
      "shaOne",
    );
    expect(restoreBaselines(m(draftTwo), m(draftTwo)).get("c.tex")).toBe(
      "shaTwo",
    );
  });

  // THE REGRESSION. A fork puts the file back to the target's `first`, so on
  // the way back the bytes on disk are Lemmaria's own work — but the departing
  // history never wrote that file, so a baseline built from it alone is EMPTY
  // and every such file compares against `undefined` and reads as a hand edit.
  // "Fork, try it another way, go back" is the workflow this exists for, so the
  // false "changed outside Lemmaria" landed on the common path.
  it("falls back to the TARGET's `first` for a file the departing history never wrote", () => {
    expect(restoreBaselines(m(trunk), m(draftOne)).get("c.tex")).toBe(
      "shaOrig",
    );
  });

  it("records `null` when the target says the file should not exist yet", () => {
    // Returning to a history that CREATES a file: before the restore runs, the
    // file is legitimately absent. A file present anyway was made by someone
    // else, so `null` must be a recorded belief, not a missing key.
    const created = [
      asked("root"),
      wrote("c1", [{ file: "plot.py", before: null, after: "shaPy" }]),
    ];
    const base = restoreBaselines(m(trunk), m(created));
    expect(base.has("plot.py")).toBe(true);
    expect(base.get("plot.py")).toBeNull();
  });

  it("is empty when neither history ever wrote anything", () => {
    expect(restoreBaselines(m(trunk), m(trunk)).size).toBe(0);
    expect(restoreBaselines(m([]), m([])).size).toBe(0);
  });

  it("prefers the departing history over the target when both know the file", () => {
    // Order matters: what is on disk now is what the history we are LEAVING
    // last wrote, not where the target started.
    expect(restoreBaselines(m(draftTwo), m(draftOne)).get("c.tex")).toBe(
      "shaTwo",
    );
  });
});

describe("restorePlan", () => {
  it("rewrites a file that differs between the two histories", () => {
    expect(restorePlan(m(draftTwo), m(draftOne))).toEqual([
      { file: "c.tex", sha: "shaOne" },
    ]);
  });

  it("is empty when nothing differs", () => {
    expect(restorePlan(m(draftOne), m(draftOne))).toEqual([]);
  });

  it("deletes a file the target history never created", () => {
    const created = [
      asked("root"),
      wrote("c1", [{ file: "plot.py", before: null, after: "shaPy" }]),
    ];
    // Leaving the history that created plot.py for one that never did.
    expect(restorePlan(m(created), m(trunk))).toEqual([
      { file: "plot.py", sha: null },
    ]);
  });

  it("restores a file to its pre-session content, not to deletion, when it existed before", () => {
    const edited = [
      asked("root"),
      wrote("e1", [{ file: "c.tex", before: "shaOrig", after: "shaEdit" }]),
    ];
    expect(restorePlan(m(edited), m(trunk))).toEqual([
      { file: "c.tex", sha: "shaOrig" },
    ]);
  });

  it("takes two manifests, so a rewind's target is just a PREFIX of its own", () => {
    // ADR 0057: the plan a rewind builds is `manifestAt(entries)` against
    // `manifestAt(entries.slice(0, cut))` — no second history, no tree, and no
    // leaf id. Asserted here because it is the shape the rewind actually uses.
    const session = [
      asked("root"),
      wrote("w1", [{ file: "c.tex", before: "shaOrig", after: "shaOne" }]),
      asked("q"),
      wrote("w2", [{ file: "notes.md", before: null, after: "shaNotes" }]),
    ];
    expect(restorePlan(m(session), m(session.slice(0, 2)))).toEqual([
      { file: "notes.md", sha: null },
    ]);
  });
});
