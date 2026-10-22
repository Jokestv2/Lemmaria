import { describe, expect, it } from "vitest";
import type { SessionItem } from "../../src/contracts/index.js";
import {
  fileOperations,
  formatFileOperations,
} from "../../src/session/file-operations.js";

/**
 * B4 (ADR 0029) — what the work touched, carried across a compaction.
 *
 * Compaction is lossy by design: tool traffic before a checkpoint leaves the
 * model's view entirely, and describing it is the summary's job. But a summary
 * is a model artifact and can omit a file it read three turns ago. The set of
 * files touched is a FACT, and facts should not be left to a summariser.
 *
 * Lemmaria DERIVES the set from the transcript rather than persisting it on
 * the checkpoint the way Pi does: the transcript is never edited, so the
 * pre-checkpoint items are all still there, and a derivation stays correct
 * after an ADR 0018 rewind — where a persisted snapshot would still be
 * claiming files that no longer happened.
 */

const read = (id: string, file: string, root?: string): SessionItem => ({
  id,
  type: "tool_call",
  tool: "read_span",
  argsJson: "{}",
  status: "completed",
  resultJson: JSON.stringify({ ...(root ? { root } : {}), file, text: "x" }),
});

describe("fileOperations (B4)", () => {
  it("is empty for a conversation that touched nothing", () => {
    const ops = fileOperations([
      { id: "u1", type: "user_message", text: "hello" },
    ]);
    expect(ops).toEqual({ read: [], written: [], edited: [] });
    expect(formatFileOperations(ops)).toBe("");
  });

  it("records a read from the RESULT, because read_span accepts a section title", () => {
    // The arguments may carry `section: "Method"` and no file at all; only the
    // result knows which file that resolved to.
    const ops = fileOperations([read("t1", "method.tex")]);
    expect(ops.read).toEqual(["method.tex"]);
  });

  it("qualifies a granted-root read so it is never confused with a workspace path", () => {
    const ops = fileOperations([read("t1", "src/train.py", "code")]);
    expect(ops.read).toEqual(["code:src/train.py"]);
  });

  it("separates a created file from an edited one", () => {
    const items: SessionItem[] = [
      {
        id: "e1",
        type: "edit_proposal",
        policy: "review",
        edits: [
          {
            file: "method.tex",
            kind: "replace",
            anchor: "a",
            replacement: "b",
            status: "applied",
          },
          { file: "new.tex", kind: "create", content: "x", status: "applied" },
        ],
      },
    ];
    const ops = fileOperations(items);
    expect(ops.edited).toEqual(["method.tex"]);
    expect(ops.written).toEqual(["new.tex"]);
  });

  it("counts only edits that were APPLIED — a rejected proposal touched nothing", () => {
    const items: SessionItem[] = [
      {
        id: "e1",
        type: "edit_proposal",
        policy: "review",
        edits: [
          {
            file: "rejected.tex",
            kind: "replace",
            anchor: "a",
            replacement: "b",
            status: "rejected",
          },
          {
            file: "stale.tex",
            kind: "replace",
            anchor: "a",
            replacement: "b",
            status: "stale",
          },
        ],
      },
    ];
    expect(fileOperations(items)).toEqual({
      read: [],
      written: [],
      edited: [],
    });
  });

  it("picks up the auto-apply changed_files summary too", () => {
    const items: SessionItem[] = [
      {
        id: "c1",
        type: "changed_files",
        files: [
          { file: "a.tex", edits: 2, created: false },
          { file: "b.tex", edits: 1, created: true },
        ],
      },
    ];
    const ops = fileOperations(items);
    expect(ops.edited).toEqual(["a.tex"]);
    expect(ops.written).toEqual(["b.tex"]);
  });

  it("a modified file is never ALSO listed as read", () => {
    const items: SessionItem[] = [
      read("t1", "method.tex"),
      read("t2", "intro.tex"),
      {
        id: "e1",
        type: "edit_proposal",
        policy: "review",
        edits: [
          {
            file: "method.tex",
            kind: "replace",
            anchor: "a",
            replacement: "b",
            status: "applied",
          },
        ],
      },
    ];
    const ops = fileOperations(items);
    expect(ops.read).toEqual(["intro.tex"]);
    expect(ops.edited).toEqual(["method.tex"]);
  });

  it("de-duplicates a file read five times", () => {
    const ops = fileOperations([
      read("t1", "m.tex"),
      read("t2", "m.tex"),
      read("t3", "m.tex"),
    ]);
    expect(ops.read).toEqual(["m.tex"]);
  });

  it("renders a block the model can read, or nothing at all", () => {
    const block = formatFileOperations(
      fileOperations([
        read("t1", "intro.tex"),
        {
          id: "c1",
          type: "changed_files",
          files: [{ file: "method.tex", edits: 1, created: false }],
        },
      ]),
    );
    expect(block).toContain("intro.tex");
    expect(block).toContain("method.tex");
    // ADR 0034: English, like SUMMARY_PREFIX and like its own <files-read>
    // siblings. No reader ever sees this string — it goes to the model.
    expect(block).not.toMatch(/[一-鿿]/);
    expect(block).toContain("<files-read>");
    expect(block).toContain("<files-modified>");
  });
});
