import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionItem, SessionTaskResult } from "@lemmaria/harness";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatMarkerReport,
  measureMarker,
  readMarker,
} from "../../src/eval/marker.js";

const MARKER = "LEMMARIA-MARKER-7F3A";
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function markerFile(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-marker-"));
  dirs.push(dir);
  const path = join(dir, "marker.json");
  await writeFile(path, body, "utf8");
  return path;
}

/** A run that viewed `pages` and then said `answer`. */
function outcomeOf(
  calls: Array<{ pages: number[] }>,
  answer: string,
): SessionTaskResult {
  const items: SessionItem[] = [];
  calls.forEach((call, i) => {
    items.push({
      id: `c${i}`,
      type: "tool_call",
      tool: "view_pdf_pages",
      argsJson: JSON.stringify({ pages: call.pages }),
      status: "completed",
      resultJson: JSON.stringify({
        pages: call.pages.map((page) => ({ page, width: 1100, height: 1424 })),
        pageCount: 1,
        viewsRemaining: 60 - call.pages.length,
      }),
    });
  });
  items.push({ id: "a", type: "agent_message", text: answer });
  return { status: "completed", items } as SessionTaskResult;
}

describe("readMarker refuses rather than repairs (V3, ADR 0080)", () => {
  it("reads a well-formed file", async () => {
    const p = await markerFile(`{"marker":"${MARKER}","page":1}`);
    expect(await readMarker(p)).toEqual({ marker: MARKER, page: 1 });
  });

  it.each([
    ["not an object", "[]"],
    ["no marker", '{"page":1}'],
    ["an empty marker", '{"marker":"","page":1}'],
    ["a non-string marker", '{"marker":7,"page":1}'],
    ["no page", `{"marker":"${MARKER}"}`],
    ["a 0-based page", `{"marker":"${MARKER}","page":0}`],
    ["a fractional page", `{"marker":"${MARKER}","page":1.5}`],
  ])("throws on %s", async (_label, body) => {
    const p = await markerFile(body);
    await expect(readMarker(p)).rejects.toThrow();
  });
});

describe("measureMarker (V3, O22)", () => {
  it("reads `read`, `calls`, `viewed` and `imagesSent` from a run", () => {
    const m = measureMarker(
      outcomeOf([{ pages: [1] }], `The code is ${MARKER}.`),
      MARKER,
    );
    expect(m).toEqual({
      read: true,
      calls: 1,
      refused: 0,
      viewed: [1],
      imagesSent: 1,
      measured: true,
    });
  });

  it("reports `not read` when the answer does not carry the code", () => {
    const m = measureMarker(
      outcomeOf([{ pages: [1] }], "I could not make out the box."),
      MARKER,
    );
    expect(m.read).toBe(false);
    expect(m.measured).toBe(true);
  });

  it("`measured` is FALSE when the tool never ran — never `read: false`", () => {
    // A run that was never offered the tool says nothing about whether a model
    // can read a page; reporting a false would be a measurement of the wiring
    // wearing a measurement of the model.
    const m = measureMarker(outcomeOf([], "I was shown nothing."), MARKER);
    expect(m.measured).toBe(false);
    expect(m.calls).toBe(0);
    expect(m.viewed).toEqual([]);
  });

  it("counts every call and deduplicates pages in call order", () => {
    const m = measureMarker(
      outcomeOf([{ pages: [2, 1] }, { pages: [1, 3] }], "…"),
      MARKER,
    );
    expect(m.calls).toBe(2);
    expect(m.viewed).toEqual([2, 1, 3]);
    expect(m.imagesSent).toBe(4);
  });

  it("a call the ALLOWLIST refused is not a measurement", () => {
    // The hole this guards: the allowlist denies at execution, so a withheld
    // tool still leaves a `tool_call` item behind. Counted as a call, a run
    // that was never shown a page reports `not read · calls: 1 · images sent:
    // 0` — a measurement of the wiring wearing a measurement of the model,
    // which is the one thing this instrument's own contract forbids.
    const items: SessionItem[] = [
      {
        id: "c0",
        type: "tool_call",
        tool: "view_pdf_pages",
        argsJson: '{"pages":[1]}',
        status: "failed",
        resultJson: JSON.stringify({
          error: {
            code: "denied",
            message: 'tool "view_pdf_pages" is not permitted in this session',
          },
        }),
      },
      { id: "a", type: "agent_message", text: "I was shown nothing." },
    ];
    const m = measureMarker(
      { status: "completed", items } as SessionTaskResult,
      MARKER,
    );
    expect(m.measured).toBe(false);
    expect(m.calls).toBe(0);
    expect(m.refused).toBe(1);
    expect(m.imagesSent).toBe(0);
    expect(formatMarkerReport(m)).toContain("withheld");
    expect(formatMarkerReport(m)).toContain("not measured");
  });

  it("a call that ran and FAILED is still a measurement", () => {
    // The door opened and the renderer broke. That is a reading about the
    // door, so it is reported — only `denied` means the tool never ran.
    const items: SessionItem[] = [
      {
        id: "c0",
        type: "tool_call",
        tool: "view_pdf_pages",
        argsJson: '{"pages":[1]}',
        status: "failed",
        resultJson: JSON.stringify({
          error: { code: "unavailable", message: "could not render the PDF" },
        }),
      },
      { id: "a", type: "agent_message", text: "The page would not open." },
    ];
    const m = measureMarker(
      { status: "completed", items } as SessionTaskResult,
      MARKER,
    );
    expect(m.measured).toBe(true);
    expect(m.calls).toBe(1);
    expect(m.refused).toBe(0);
  });

  it("a malformed result is still a call, with no pages", () => {
    const items: SessionItem[] = [
      {
        id: "c0",
        type: "tool_call",
        tool: "view_pdf_pages",
        argsJson: "{}",
        status: "failed",
        resultJson: "not json at all",
      },
      { id: "a", type: "agent_message", text: "…" },
    ];
    const m = measureMarker(
      { status: "completed", items } as SessionTaskResult,
      MARKER,
    );
    expect(m.calls).toBe(1);
    expect(m.viewed).toEqual([]);
    expect(m.measured).toBe(true);
  });

  it("ignores other tools' calls", () => {
    const items: SessionItem[] = [
      {
        id: "c0",
        type: "tool_call",
        tool: "read_span",
        argsJson: "{}",
        status: "completed",
        resultJson: "{}",
      },
      { id: "a", type: "agent_message", text: MARKER },
    ];
    const m = measureMarker(
      { status: "completed", items } as SessionTaskResult,
      MARKER,
    );
    expect(m.measured).toBe(false);
  });
});

describe("formatMarkerReport — prose, never a rate (ADR 0070 §5)", () => {
  it("says read / not read and the raw counts", () => {
    const read = formatMarkerReport(
      measureMarker(outcomeOf([{ pages: [1] }], MARKER), MARKER),
    );
    expect(read).toContain("marker: read");
    expect(read).toContain("calls: 1");
    expect(read).toContain("pages viewed: 1");

    const not = formatMarkerReport(
      measureMarker(outcomeOf([{ pages: [1] }], "no idea"), MARKER),
    );
    expect(not).toContain("marker: not read");
  });

  it("says `not measured` rather than a zero", () => {
    const line = formatMarkerReport(measureMarker(outcomeOf([], "…"), MARKER));
    expect(line).toContain("not measured");
    expect(line).not.toMatch(/\b0\b/);
  });

  it("carries no percentage, score or rate — whatever the run did", () => {
    for (const m of [
      measureMarker(outcomeOf([{ pages: [1] }], MARKER), MARKER),
      measureMarker(outcomeOf([{ pages: [1] }], "no"), MARKER),
      measureMarker(outcomeOf([], "no"), MARKER),
    ]) {
      const line = formatMarkerReport(m).toLowerCase();
      expect(line).not.toContain("%");
      for (const banned of ["score", "rate", "accuracy", "precision"]) {
        expect(line).not.toContain(banned);
      }
    }
  });
});
