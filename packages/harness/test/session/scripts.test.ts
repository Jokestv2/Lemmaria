import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GrantedRoot } from "../../src/contracts/index.js";
import { canonicalizeGrantRoot } from "../../src/engine/grants.js";
import {
  parseRunScriptArgs,
  resolveRunScript,
  scriptContentHash,
} from "../../src/session/scripts.js";

const temps: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

const INTERPRETERS = ["python", "python3", "rscript"];

function fixtures() {
  const grantDir = mkTemp("a4b-grant-");
  writeFileSync(join(grantDir, "plot.py"), "print('from grant')\n");
  mkdirSync(join(grantDir, ".git"), { recursive: true });
  writeFileSync(join(grantDir, ".git", "hack.py"), "print('nope')\n");
  const workspace = mkTemp("a4b-ws-");
  writeFileSync(join(workspace, "analyze.py"), "print('from workspace')\n");
  const grant: GrantedRoot = {
    id: "g1",
    path: canonicalizeGrantRoot(grantDir),
    label: "results",
  };
  return { grant, workspace };
}

describe("parseRunScriptArgs", () => {
  it("requires root + a non-empty string command array", () => {
    expect(
      parseRunScriptArgs({ root: "g1", command: ["python", "x.py"] }),
    ).toEqual({
      root: "g1",
      command: ["python", "x.py"],
    });
    expect("error" in parseRunScriptArgs({ command: ["python", "x.py"] })).toBe(
      true,
    );
    expect("error" in parseRunScriptArgs({ root: "g1", command: [] })).toBe(
      true,
    );
    expect(
      "error" in parseRunScriptArgs({ root: "g1", command: ["python"] }),
    ).toBe(true);
    expect(
      "error" in parseRunScriptArgs({ root: "g1", command: "python x.py" }),
    ).toBe(true);
  });
});

describe("resolveRunScript", () => {
  it("resolves a script inside the granted root, cwd = the root realpath", () => {
    const { grant, workspace } = fixtures();
    const r = resolveRunScript({
      command: ["python", "plot.py", "--fast"],
      grant,
      workspaceRoot: workspace,
      interpreters: INTERPRETERS,
    });
    if ("refused" in r) throw new Error(r.refused);
    expect(r.cwd).toBe(grant.path);
    expect(r.argv[0]).toBe("python");
    expect(r.argv[1]).toBe(join(grant.path, "plot.py"));
    expect(r.argv[2]).toBe("--fast");
    expect(r.content).toContain("from grant");
    expect(r.display).toEqual(["python", "plot.py", "--fast"]);
  });

  it("resolves an agent-authored script in the paper workspace (cwd stays the granted root)", () => {
    const { grant, workspace } = fixtures();
    const r = resolveRunScript({
      command: ["python", "analyze.py"],
      grant,
      workspaceRoot: workspace,
      interpreters: INTERPRETERS,
    });
    if ("refused" in r) throw new Error(r.refused);
    expect(r.cwd).toBe(grant.path);
    expect(r.argv[1]).toBe(join(workspace, "analyze.py"));
    expect(r.content).toContain("from workspace");
  });

  it("refuses a non-allowlisted interpreter before anything else", () => {
    const { grant, workspace } = fixtures();
    const r = resolveRunScript({
      command: ["bash", "plot.py"],
      grant,
      workspaceRoot: workspace,
      interpreters: INTERPRETERS,
    });
    expect("refused" in r && /interpreter/i.test(r.refused)).toBe(true);
  });

  it("refuses a deny-listed script (.git) inside the granted root", () => {
    const { grant, workspace } = fixtures();
    const r = resolveRunScript({
      command: ["python", ".git/hack.py"],
      grant,
      workspaceRoot: workspace,
      interpreters: INTERPRETERS,
    });
    expect("refused" in r).toBe(true);
  });

  it("refuses a script in neither the granted root nor the workspace", () => {
    const { grant, workspace } = fixtures();
    const r = resolveRunScript({
      command: ["python", "missing.py"],
      grant,
      workspaceRoot: workspace,
      interpreters: INTERPRETERS,
    });
    expect(
      "refused" in r &&
        /granted folder or the paper workspace/i.test(r.refused),
    ).toBe(true);
  });

  it("refuses a workspace path that escapes the workspace", () => {
    const { grant, workspace } = fixtures();
    const r = resolveRunScript({
      command: ["python", "../secret.py"],
      grant,
      workspaceRoot: workspace,
      interpreters: INTERPRETERS,
    });
    expect("refused" in r).toBe(true);
  });

  it("refuses a script too large to review before reading it into memory", () => {
    const { grant, workspace } = fixtures();
    // Bigger than the review cap: reading it wholesale would block the host.
    writeFileSync(join(grant.path, "huge.py"), "#".repeat(1_500_000));
    const r = resolveRunScript({
      command: ["python", "huge.py"],
      grant,
      workspaceRoot: workspace,
      interpreters: INTERPRETERS,
    });
    expect("refused" in r && /too large/i.test(r.refused)).toBe(true);
  });
});

describe("scriptContentHash", () => {
  const argv = (interp: string, script: string, ...args: string[]) => [
    interp,
    script,
    ...args,
  ];

  it("is stable for the same root + argv + content", () => {
    const a = scriptContentHash(
      "g1",
      argv("python", "/r/plot.py", "--fast"),
      "print(1)",
    );
    expect(
      scriptContentHash(
        "g1",
        argv("python", "/r/plot.py", "--fast"),
        "print(1)",
      ),
    ).toBe(a);
  });

  it("changes when the content or args change", () => {
    const a = scriptContentHash(
      "g1",
      argv("python", "/r/plot.py", "--fast"),
      "print(1)",
    );
    expect(
      scriptContentHash(
        "g1",
        argv("python", "/r/plot.py", "--slow"),
        "print(1)",
      ),
    ).not.toBe(a);
    expect(
      scriptContentHash(
        "g1",
        argv("python", "/r/plot.py", "--fast"),
        "print(2)",
      ),
    ).not.toBe(a);
  });

  it("changes when the granted root, the interpreter path, or the script path change (review #1)", () => {
    const a = scriptContentHash("g1", argv("python", "/r/plot.py"), "print(1)");
    // A different granted root (same content) must NOT reuse the approval.
    expect(
      scriptContentHash("g2", argv("python", "/r/plot.py"), "print(1)"),
    ).not.toBe(a);
    // A different interpreter binary with the same basename must re-prompt.
    expect(
      scriptContentHash(
        "g1",
        argv("/tmp/evil/python", "/r/plot.py"),
        "print(1)",
      ),
    ).not.toBe(a);
    // A different resolved script path must re-prompt.
    expect(
      scriptContentHash("g1", argv("python", "/r/other.py"), "print(1)"),
    ).not.toBe(a);
  });

  it("states the ADR 0024 code beside every refusal, so the boundary is a lookup", () => {
    // The tool boundary maps `resolved.code` straight through (run.ts). If a
    // message here is re-worded the code must still be right, which is exactly
    // what a regex-over-prose mapping could not guarantee.
    const { grant, workspace } = fixtures();
    const base = { grant, workspaceRoot: workspace, interpreters: ["python"] };
    const codeOf = (command: string[]): string => {
      const r = resolveRunScript({ ...base, command });
      if (!("refused" in r))
        throw new Error(`expected a refusal for ${command}`);
      return r.code;
    };
    expect(codeOf(["python"])).toBe("invalid");
    expect(codeOf(["bash", "go.sh"])).toBe("denied");
    expect(codeOf(["python", "nope.py"])).toBe("not_found");
  });
});
