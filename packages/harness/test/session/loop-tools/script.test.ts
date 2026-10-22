import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  GrantedRoot,
  ScriptRunItem,
  SessionItem,
} from "../../../src/contracts/index.js";
import { canonicalizeGrantRoot } from "../../../src/engine/grants.js";
import { createRunScriptTool } from "../../../src/session/loop-tools/script.js";

function fixture(): { grant: GrantedRoot; script: string } {
  const dir = canonicalizeGrantRoot(
    mkdtempSync(join(tmpdir(), "lemmaria-b1-script-")),
  );
  writeFileSync(join(dir, "go.py"), "print('hi')\n", "utf8");
  return { grant: { id: "g1", path: dir, label: "fx" }, script: "go.py" };
}

function sink() {
  const items: SessionItem[] = [];
  return {
    items,
    emit: async () => {},
    emitItem: async (i: SessionItem) => void items.push(i),
  };
}

const mustNotRun = async (): Promise<never> => {
  throw new Error("the script must not have run");
};

describe("createRunScriptTool (B1)", () => {
  it("is `mutation` and declares NO execution mode — the category is the guard (invariant 3)", () => {
    const { grant } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: false }),
        run: mustNotRun,
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    expect(tool.category).toBe("mutation");
    expect(tool.executionMode).toBeUndefined();
  });

  it("a denied run refuses and carries the user's note as the guidance", async () => {
    const { grant, script } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({
          approve: false,
          note: "not on my machine",
        }),
        run: mustNotRun,
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("refused");
      expect(out.error.message).toContain("not on my machine");
    }
    expect((s.items.at(-1) as ScriptRunItem).status).toBe("denied");
  });

  it("a grant revoked during the approval pause refuses and never runs", async () => {
    const { grant, script } = fixture();
    const s = sink();
    let live: GrantedRoot[] = [grant];
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => {
          live = [];
          return { approve: true };
        },
        run: mustNotRun,
      },
      grants: () => live,
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("refused");
      expect(out.error.message).toContain("revoked");
    }
    expect((s.items.at(-1) as ScriptRunItem).status).toBe("failed");
  });

  it("a script changed after approval refuses — the approved bytes are what may run", async () => {
    const { grant, script } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => {
          writeFileSync(join(grant.path, script), "print('SWAPPED')\n", "utf8");
          return { approve: true };
        },
        run: mustNotRun,
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("refused");
    expect((s.items.at(-1) as ScriptRunItem).status).toBe("failed");
  });

  it("an unknown root refuses before any item is emitted", async () => {
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: mustNotRun,
      },
      grants: () => [],
      workspaceRoot: tmpdir(),
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({
      root: "nope",
      command: ["python", "x.py"],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("refused");
    expect(s.items).toEqual([]);
  });

  it("a run that exits non-zero is a SUCCESS payload the model can read (ADR 0024)", async () => {
    const { grant, script } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: async () => ({
          stdout: "partial output",
          stderr: "Traceback: boom",
          exitCode: 1,
          truncated: false,
          stdoutBytes: 14,
          stderrBytes: 16,
        }),
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    // The script RAN: `status` reflects whether it could be spawned, not its
    // exit code, so the model gets the stderr it needs to fix the script.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toMatchObject({
        status: "completed",
        exitCode: 1,
        stderr: "Traceback: boom",
      });
    }
    expect((s.items.at(-1) as ScriptRunItem).status).toBe("completed");
  });

  // D2: the transcript folds script output and its summary says how much there
  // is. B4 measured the captured bytes but left them on `ScriptRunResult`, the
  // adapter-level result the model's payload is built from — they never reached
  // the persisted item the webview reads, so the fold had nothing to report.
  it("carries the captured byte counts onto the emitted item (D2)", async () => {
    const { grant, script } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: async () => ({
          stdout: "ok\n",
          stderr: "warn\n",
          exitCode: 0,
          truncated: false,
          stdoutBytes: 3,
          stderrBytes: 5,
        }),
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    await tool.invoke({ root: "g1", command: ["python", script] });
    const item = s.items.at(-1) as ScriptRunItem;
    expect(item.stdoutBytes).toBe(3);
    expect(item.stderrBytes).toBe(5);
  });

  it("keeps the END of a long stream and says how much it dropped (B4)", async () => {
    const { grant, script } = fixture();
    const s = sink();
    const noise = Array.from({ length: 5_000 }, (_, i) => `step ${i}`).join(
      "\n",
    );
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: async () => ({
          stdout: `${noise}\nRESULT: 0.913`,
          stderr: `${noise}\nValueError: shapes do not align`,
          exitCode: 1,
          // The capture kept everything; only the tool's own budget cuts here.
          truncated: false,
          stdoutBytes: Buffer.byteLength(`${noise}\nRESULT: 0.913`, "utf8"),
          stderrBytes: Buffer.byteLength(
            `${noise}\nValueError: shapes do not align`,
            "utf8",
          ),
        }),
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const value = out.value as {
      stdout: string;
      stderr: string;
      stdout_truncation?: { kept: string; total_lines: number };
      stderr_truncation?: { kept: string; total_lines: number };
    };
    // The whole point: what a failing script says LAST is what the model needs.
    expect(value.stderr.endsWith("ValueError: shapes do not align")).toBe(true);
    expect(value.stdout.endsWith("RESULT: 0.913")).toBe(true);
    expect(value.stderr).not.toContain("step 0\n");
    expect(value.stderr_truncation?.kept).toBe("tail");
    expect(value.stderr_truncation?.total_lines).toBe(5_001);
    expect(value.stdout_truncation?.total_lines).toBe(5_001);
  });

  it("leaves short output alone, with no truncation keys at all (B4)", async () => {
    const { grant, script } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: async () => ({
          stdout: "hi\n",
          stderr: "",
          exitCode: 0,
          truncated: false,
          stdoutBytes: 3,
          stderrBytes: 0,
        }),
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.value as object)).not.toContain("stdout_truncation");
    expect(Object.keys(out.value as object)).not.toContain("stderr_truncation");
    expect((out.value as { stdout: string }).stdout).toBe("hi\n");
  });

  it("reports the capture's own drop, even when what it kept fits (B4)", async () => {
    // Two truncations stack: the host's 200 kB capture window (which already
    // dropped the FRONT of the stream) and the tool's own tail budget. A short
    // survivor must not read as a complete output.
    const { grant, script } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: async () => ({
          stdout: "the last few bytes",
          stderr: "",
          exitCode: 0,
          truncated: true,
          stdoutBytes: 900_000,
          stderrBytes: 0,
        }),
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const value = out.value as {
      truncated: boolean;
      stdout_truncation?: {
        kept: string;
        total_bytes: number;
        total_lines?: number;
      };
    };
    expect(value.truncated).toBe(true);
    expect(value.stdout_truncation?.kept).toBe("tail");
    expect(value.stdout_truncation?.total_bytes).toBe(900_000);
    // The line count of what survived is NOT the line count of what ran, and
    // nothing at this layer can know the latter — so it is omitted rather
    // than invented (review, Minor 7).
    expect(value.stdout_truncation?.total_lines).toBeUndefined();
  });

  it("a script that could not be spawned is a `failed` row carrying the reason", async () => {
    const { grant, script } = fixture();
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: async () => ({
          stdout: "",
          stderr: "",
          exitCode: null,
          truncated: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          error: "spawn ENOENT",
        }),
      },
      grants: () => [grant],
      workspaceRoot: grant.path,
      emit: s.emit,
      emitItem: s.emitItem,
    });
    const out = await tool.invoke({ root: "g1", command: ["python", script] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toMatchObject({
        status: "failed",
        note: "spawn ENOENT",
      });
    }
    expect((s.items.at(-1) as ScriptRunItem).status).toBe("failed");
  });

  it("advertises the allowlisted name and the mutation category", () => {
    const s = sink();
    const tool = createRunScriptTool({
      scriptHost: {
        interpreters: () => ["python"],
        requestApproval: async () => ({ approve: true }),
        run: mustNotRun,
      },
      grants: () => [],
      workspaceRoot: tmpdir(),
      emit: s.emit,
      emitItem: s.emitItem,
    });
    expect(tool.name).toBe("run_script");
    expect(tool.category).toBe("mutation");
  });
});
