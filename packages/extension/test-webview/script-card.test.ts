import { describe, expect, it } from "vitest";
import {
  type ScriptOutput,
  scriptFoldOpen,
  scriptOutputFold,
} from "../src/webview/parts/script-card.js";

const run = (over: Partial<ScriptOutput> = {}): ScriptOutput => ({
  id: "s1",
  status: "completed",
  stdout: "line one\nline two\n",
  exitCode: 0,
  ...over,
});

describe("scriptFoldOpen (CHAT-4)", () => {
  it("stays collapsed when the script succeeded", () => {
    expect(scriptFoldOpen(run())).toBe(false);
  });

  it("opens on a non-zero exit", () => {
    // A deliberate divergence: neither Codex nor Pi auto-expands on failure,
    // both spend their strongest visual signal on it instead (ADR 0037 §5).
    // The cost of a click is highest exactly when you are debugging.
    expect(scriptFoldOpen(run({ exitCode: 1 }))).toBe(true);
    expect(scriptFoldOpen(run({ exitCode: 127 }))).toBe(true);
  });

  it("opens when the process was killed before exiting", () => {
    // `exitCode: null` is an interrupt or a timeout — the user needs to see
    // how far it got, which is precisely what a collapsed fold hides.
    expect(scriptFoldOpen(run({ exitCode: null }))).toBe(true);
  });

  it("opens when the run failed to start at all", () => {
    expect(scriptFoldOpen(run({ status: "failed", exitCode: undefined }))).toBe(
      true,
    );
  });

  it("stays collapsed on a success with no exit code reported", () => {
    expect(scriptFoldOpen(run({ exitCode: undefined }))).toBe(false);
  });
});

describe("scriptOutputFold (CHAT-4)", () => {
  it("returns nothing when the run produced no output", () => {
    expect(
      scriptOutputFold(run({ stdout: undefined, stderr: undefined }), "en"),
    ).toBeUndefined();
    expect(scriptOutputFold(run({ stdout: "" }), "en")).toBeUndefined();
  });

  it("folds a successful run's output away", () => {
    const node = scriptOutputFold(run(), "en");
    expect(node?.tagName).toBe("DETAILS");
    expect((node as HTMLDetailsElement).open).toBe(false);
    expect(node?.querySelector("pre")?.textContent).toBe(
      "line one\nline two\n",
    );
  });

  it("opens a failed run's output", () => {
    const node = scriptOutputFold(
      run({ exitCode: 2, stderr: "Traceback: boom\n" }),
      "en",
    );
    expect((node as HTMLDetailsElement).open).toBe(true);
  });

  it("reuses the tool row's fold classes, which are the ones with CSS", () => {
    // `.lm-script__out` has no rule at all in styles.css, which is why a
    // script printing thousands of lines floods the transcript while a
    // grep_project over the same data scrolls inside its own box.
    const node = scriptOutputFold(run({ stderr: "warn\n" }), "en");
    expect(node?.className).toContain("lm-msg-tool");
    expect(node?.querySelector("summary")?.className).toBe("lm-tool__head");
    const pres = [...(node?.querySelectorAll("pre") ?? [])];
    expect(pres).toHaveLength(2);
    for (const pre of pres) expect(pre.className).toContain("lm-tool__raw");
    expect(pres[1]?.className).toContain("lm-script__err");
  });

  it("names the exit code and the captured byte counts in the summary", () => {
    const head = scriptOutputFold(
      run({ exitCode: 3, stdoutBytes: 120, stderr: "e\n", stderrBytes: 40 }),
      "en",
    )?.querySelector("summary")?.textContent;
    expect(head).toContain("exit 3");
    expect(head).toContain("120");
    expect(head).toContain("40");
  });

  it("reports a byte count only for a stream that has content", () => {
    // `ScriptRunResult` reports both counts as required numbers, so a run with
    // no stderr carries an explicit 0 — and an unconditional summary would
    // append a bare `err 0` to every successful run.
    const head = scriptOutputFold(
      run({ stdoutBytes: 18, stderr: "", stderrBytes: 0 }),
      "en",
    )?.querySelector("summary")?.textContent;
    expect(head).toContain("out 18");
    expect(head).not.toContain("err");
  });

  it("says so when the capture was truncated", () => {
    const head = scriptOutputFold(
      run({ truncated: true, stdoutBytes: 900000 }),
      "en",
    )?.querySelector("summary")?.textContent;
    expect(head).toContain("truncated");
  });

  it("renders its summary in Chinese under the zh locale, with no English", () => {
    const head =
      scriptOutputFold(
        run({ exitCode: 1, stdoutBytes: 10 }),
        "zh",
      )?.querySelector("summary")?.textContent ?? "";
    expect(head).toMatch(/[一-鿿]/);
    // Invariant 6 rule 2: one language per reader. `exit` and `bytes` are the
    // English labels; a zh reader must see neither.
    expect(head).not.toMatch(/\bexit\b|\bbytes\b|\btruncated\b/);
  });

  it("remembers a fold the user opened, across the next re-render", () => {
    // The transcript rebuilds the DOM on EVERY streamed delta, so without a
    // memory a fold opened to read output snaps shut on the next token.
    const opened = new Map<string, boolean>();
    const first = scriptOutputFold(run(), "en", opened) as HTMLDetailsElement;
    expect(first.open).toBe(false);
    first.open = true;
    first.dispatchEvent(new Event("toggle"));

    const second = scriptOutputFold(run(), "en", opened) as HTMLDetailsElement;
    expect(second.open).toBe(true);
  });

  it("remembers a failure fold the user closed on purpose", () => {
    const opened = new Map<string, boolean>();
    const failed = run({ exitCode: 1 });
    const first = scriptOutputFold(failed, "en", opened) as HTMLDetailsElement;
    expect(first.open).toBe(true);
    first.open = false;
    first.dispatchEvent(new Event("toggle"));

    const second = scriptOutputFold(failed, "en", opened) as HTMLDetailsElement;
    expect(second.open).toBe(false);
  });

  it("keeps each run's fold separate", () => {
    const opened = new Map<string, boolean>();
    const a = scriptOutputFold(
      run({ id: "a" }),
      "en",
      opened,
    ) as HTMLDetailsElement;
    a.open = true;
    a.dispatchEvent(new Event("toggle"));

    const b = scriptOutputFold(
      run({ id: "b" }),
      "en",
      opened,
    ) as HTMLDetailsElement;
    expect(b.open).toBe(false);
  });

  it("records only a real gesture, never the default it started at", () => {
    // Setting `.open` on a fresh <details> queues a `toggle` that the listener
    // is attached in time to receive, so without a guard the map fills with
    // defaults nobody asked it to remember.
    const opened = new Map<string, boolean>();
    scriptOutputFold(run({ exitCode: 1 }), "en", opened);
    scriptOutputFold(run({ id: "s2" }), "en", opened);
    expect([...opened.keys()]).toEqual([]);
  });

  it("falls back to the default when no memory is supplied", () => {
    expect((scriptOutputFold(run(), "en") as HTMLDetailsElement).open).toBe(
      false,
    );
  });

  it("writes output as text, never as markup", () => {
    // The webview CSP has no 'unsafe-inline' and this is model-adjacent data:
    // a script can print anything. An innerHTML shortcut here is a security
    // defect, not a style choice.
    const node = scriptOutputFold(
      run({ stdout: '<img src=x onerror="alert(1)">\n' }),
      "en",
    );
    const pre = node?.querySelector("pre");
    expect(pre?.textContent).toBe('<img src=x onerror="alert(1)">\n');
    expect(pre?.querySelector("img")).toBeNull();
    expect(node?.querySelector("img")).toBeNull();
  });
});
