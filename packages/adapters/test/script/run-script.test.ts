import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnScript } from "../../src/script/run-script.js";

const NODE = process.execPath;
const cwd = mkdtempSync(join(tmpdir(), "a4b-spawn-"));

describe("spawnScript", () => {
  it("captures stdout, stderr, and a zero exit code", async () => {
    const r = await spawnScript(
      [NODE, "-e", "process.stdout.write('out');process.stderr.write('err')"],
      cwd,
    );
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("err");
    expect(r.exitCode).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it("reports a non-zero exit code without throwing", async () => {
    const r = await spawnScript([NODE, "-e", "process.exit(3)"], cwd);
    expect(r.exitCode).toBe(3);
    expect(r.error).toBeUndefined();
  });

  it("returns { error } when the interpreter cannot be spawned (never throws)", async () => {
    const r = await spawnScript(
      [join(cwd, "definitely-not-an-interpreter-xyz"), "x"],
      cwd,
    );
    expect(r.error).toBeDefined();
    expect(r.exitCode).toBeNull();
  });

  it("caps output and sets truncated", async () => {
    const r = await spawnScript(
      [NODE, "-e", "process.stdout.write('x'.repeat(1000))"],
      cwd,
      { maxOutputBytes: 100 },
    );
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
  });

  it("keeps the END of an oversized stream — a failing script's error is last (B4)", async () => {
    // Before B4 the sink kept the first `maxOutputBytes` and dropped every
    // later chunk, so the traceback a script prints just before dying was the
    // first thing lost. This is the reversal ADR 0029 records against ADR 0020.
    const r = await spawnScript(
      [
        NODE,
        "-e",
        "process.stdout.write('x'.repeat(1000));process.stdout.write('THE-ERROR')",
      ],
      cwd,
      { maxOutputBytes: 100 },
    );
    expect(r.stdout.endsWith("THE-ERROR")).toBe(true);
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
  });

  it("reports the total bytes each stream PRODUCED, not what survived (B4)", async () => {
    // `truncated: true` alone cannot say which stream was cut, or by how much.
    const r = await spawnScript(
      [
        NODE,
        "-e",
        "process.stdout.write('x'.repeat(1000));process.stderr.write('e'.repeat(20))",
      ],
      cwd,
      { maxOutputBytes: 100 },
    );
    expect(r.stdoutBytes).toBe(1000);
    expect(r.stderrBytes).toBe(20);
    // The untruncated stream is returned whole.
    expect(r.stderr.length).toBe(20);
  });

  it("keeps the tail cheaply when output arrives in many tiny chunks (B4 review)", async () => {
    // Regression guard for review Important 2: trimming the window on every
    // chunk is quadratic in chunk count, and a line-buffered script delivers
    // tens of thousands of tiny writes — the sink could consume the run's own
    // timeout. 40 000 line-flushed writes must stay far inside it.
    const started = Date.now();
    const r = await spawnScript(
      [
        NODE,
        "-e",
        "for(let i=0;i<40000;i++)process.stdout.write('line '+i+'\\n');process.stdout.write('THE-END')",
      ],
      cwd,
      { maxOutputBytes: 4_000 },
    );
    expect(r.stdout.endsWith("THE-END")).toBe(true);
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(4_000);
    expect(r.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("reports totals even when nothing was truncated (B4)", async () => {
    const r = await spawnScript(
      [NODE, "-e", "process.stdout.write('hello')"],
      cwd,
    );
    expect(r.truncated).toBe(false);
    expect(r.stdoutBytes).toBe(5);
    expect(r.stderrBytes).toBe(0);
  });

  it("does not leave a broken codepoint when the dropped prefix splits one (B4)", async () => {
    // The ring drops whole leading BYTES, which can land inside a multibyte
    // character; the decode must skip the orphaned continuation bytes.
    const r = await spawnScript(
      [NODE, "-e", "process.stdout.write('\\u2605'.repeat(1000))"],
      cwd,
      { maxOutputBytes: 100 },
    );
    expect(r.stdout).not.toContain("�");
    expect([...r.stdout].every((ch) => ch === "★")).toBe(true);
  });

  it("kills the process on abort and reports it (exitCode null, error set)", async () => {
    const ctrl = new AbortController();
    const p = spawnScript([NODE, "-e", "setTimeout(()=>{},60000)"], cwd, {
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 100);
    const r = await p;
    expect(r.exitCode).toBeNull();
    expect(r.error).toBeDefined();
  });

  it("caps output by BYTES, not UTF-16 code units (multibyte output)", async () => {
    // '★' is 3 bytes / 1 UTF-16 unit in JS. A char-based cap would let ~3x the
    // documented byte budget through; assert the byte length is bounded.
    const r = await spawnScript(
      [NODE, "-e", "process.stdout.write('\\u2605'.repeat(1000))"],
      cwd,
      { maxOutputBytes: 300 },
    );
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(300);
    expect(r.truncated).toBe(true);
  });

  it("still settles when the child ignores SIGTERM/SIGINT (forceful kill)", async () => {
    const ctrl = new AbortController();
    const p = spawnScript(
      [
        NODE,
        "-e",
        "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)",
      ],
      cwd,
      { signal: ctrl.signal },
    );
    setTimeout(() => ctrl.abort(), 150);
    const r = await p;
    expect(r.exitCode).toBeNull();
    expect(r.error).toBeDefined();
  });
});
