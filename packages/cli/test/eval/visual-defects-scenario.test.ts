/**
 * V4 (O24): `lemmaria eval --scenario visual-defects`, offline, end to end.
 *
 * The real driver, the REAL PDFium renderer over the committed defective twin,
 * the shipped skills, and the scripted stub: the PDF reviewer runs alone
 * (`/review-pdf`), views pages 1–3 one per turn, and files two concerns that
 * cite page 1. What a model would find is the live tier's reading (L1); this
 * proves the path a finding travels, and that no page image is persisted.
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPdfiumRenderer } from "@lemmaria/adapters";
import { pdfiumWasmPath } from "@lemmaria/adapters/pdfium-wasm";
import {
  type PdfRenderer,
  type ReviewItem,
  ScriptedModelAdapter,
  type Skill,
  listSkills,
} from "@lemmaria/harness";
import { bundledSkillsDir } from "@lemmaria/harness/bundled-skills";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { evalCommand } from "../../src/eval/command.js";
import { runEvalTask } from "../../src/eval/run-eval.js";
import {
  EVIDENCE_SCENARIOS,
  FLAGSHIP_SCENARIOS,
  VISUAL_SCENARIOS,
  scenarioById,
} from "../../src/eval/scenarios.js";
import { stubTurnsFor } from "../../src/eval/stub-script.js";
import {
  type VisualManifest,
  matchVisualDefects,
  readVisualManifest,
} from "../../src/eval/visual.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../live/fixtures/visual-defects");
const PAPER = resolve(FIXTURE, "paper");

function scenario() {
  const s = scenarioById("visual-defects");
  if (s === undefined) throw new Error("no visual-defects scenario");
  return s;
}

let renderer: PdfRenderer;
let skills: Skill[];
let manifest: VisualManifest;
beforeAll(async () => {
  renderer = createPdfiumRenderer(
    new Uint8Array(await readFile(pdfiumWasmPath())),
  );
  skills = (await listSkills({ bundledDir: bundledSkillsDir() })).skills;
  manifest = await readVisualManifest(resolve(FIXTURE, "visual.json"));
});

const trash: string[] = [];
afterEach(async () => {
  for (const d of trash.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

/** Every `.jsonl` this run persisted — the parent's and its child's. */
async function persisted(workDir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(await readFile(p, "utf8"));
    }
  };
  await walk(join(workDir, "sessions"));
  expect(out.length).toBeGreaterThan(0);
  return out.join("\n");
}

const reviewOf = (items: readonly { type: string }[]): ReviewItem | undefined =>
  items.find((i): i is ReviewItem => i.type === "review");

describe("V4 O24 — the visual-defects scenario", { timeout: 30_000 }, () => {
  it("resolves by id, is listed apart, and is never swept into `--scenario all`", () => {
    const s = scenario();
    expect(s.prompt).toBe("/review-pdf");
    expect(s.readOnly).toBe(true);
    expect(s.bundledSkills).toBe(true);
    expect(VISUAL_SCENARIOS.map((x) => x.id)).toEqual(["visual-defects"]);
    expect(FLAGSHIP_SCENARIOS.map((x) => x.id)).not.toContain("visual-defects");
    expect(EVIDENCE_SCENARIOS.map((x) => x.id)).not.toContain("visual-defects");
  });

  it("runs the PDF reviewer alone over the committed PDF, and the judge reads it", async () => {
    const task = await runEvalTask({
      scenario: scenario(),
      paperDir: PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      skills,
      pdfRenderer: renderer,
      venue: manifest.venue,
    });
    trash.push(task.workDir);

    expect(task.outcome.status).toBe("completed");
    const item = reviewOf(task.outcome.items);
    expect(item?.pdfOnly).toBe(true);
    expect(item?.seats).toEqual([]);
    expect(item?.pdfSeat?.status).toBe("completed");

    // The facts, as the record states them.
    const facts = item?.pdf?.facts;
    expect(facts?.pages).toBe(3);
    expect(facts?.pageSize.name).toBe("a4");
    expect(facts?.author).toBe("A. Fixture");
    expect(facts?.venue?.pageLimit?.value).toBe(2);
    // Figure 2's `\fontsize{2}{2}` names 2 pt, but LaTeX substitutes the
    // smallest size its font has — so the PAGE carries 5.0 pt, and the fact
    // states what is on the page (the plan's "2.0 pt" was the source's number).
    const smallest = [...(facts?.smallestText ?? [])].sort(
      (a, b) => a.sizePt - b.sizePt,
    )[0];
    expect(smallest).toEqual({ page: 1, sizePt: 5 });

    // The eval's own report reads the same record.
    expect(task.pdf?.source).toBe("beside_entry");
    expect(task.pdf?.viewed).toEqual([1, 2, 3]);
    expect(task.pdf?.facts?.pages).toBe(3);

    // Both concerns located, each citing the page it was seen on.
    const concerns = item?.result?.annotations ?? [];
    expect(concerns.map((a) => [a.id, a.evidence])).toEqual([
      ["pdf_reviewer-1", { kind: "page", page: 1 }],
      ["pdf_reviewer-2", { kind: "page", page: 1 }],
    ]);
    const report = matchVisualDefects(item, manifest);
    expect(report.measured).toBe(true);
    expect(report.hits.map((h) => [h.defect, h.pageNamed])).toEqual([
      ["V1", true],
      ["V8", true],
    ]);
    expect(report.facts.overLimit).toBe(true);

    const verdict = scenario().judge(task.outcome, manifest);
    expect(verdict.pass).toBe(true);
    expect(verdict.checks.map((c) => c.label)).toContain(
      "visual defects: found 2/7",
    );

    // No page image reached any persisted transcript.
    const jsonl = await persisted(task.workDir);
    expect(jsonl).not.toContain("image/png");
    expect(jsonl).not.toContain("iVBOR");
  });

  it("the command reads visual.json beside the paper, builds the renderer, and prints the report", async () => {
    const lines: string[] = [];
    const code = await evalCommand(
      ["--scenario", "visual-defects", "--paper", PAPER, "--stub"],
      { log: (line) => lines.push(line) },
    );
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("PASS");
    expect(text).toContain("visual defects: found 2/7");
    expect(text).toContain("page named right 2 of 2");
    expect(text).toContain("smallest text 5.0 pt on page 1");
  });

  it("a binding that cannot see: withheld, not measured, and the judge fails", async () => {
    const task = await runEvalTask({
      scenario: scenario(),
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      adapter: new ScriptedModelAdapter(stubTurnsFor("visual-defects")),
      binding: {
        protocol: "anthropic",
        endpoint: "",
        model: "claude-sonnet-4-5",
        apiKey: "stub",
        imageInput: false,
      },
      readOnly: true,
      skills,
      pdfRenderer: renderer,
      venue: manifest.venue,
    });
    trash.push(task.workDir);
    expect(task.pdf?.withheld).toBe("model_has_no_image_input");
    const item = reviewOf(task.outcome.items);
    expect(item?.pdfSeat).toBeUndefined();
    const verdict = scenario().judge(task.outcome, manifest);
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.map((c) => c.label)).toContain(
      "visual defects: not measured",
    );
  });
});
