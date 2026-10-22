/**
 * V2 (O27): the probe fixture itself, checked the way `planted-defects-fixture`
 * checks its manifest.
 *
 * **Why a fixture needs a test.** Every live number the probe produces is only
 * as good as four properties of these files, and each of them is one careless
 * edit away from being silently false:
 *
 * 1. the two manuscripts differ in **exactly** the `\title` line — otherwise
 *    L2's withholding reading is confounded by whatever else changed;
 * 2. every claim anchor occurs once, at its recorded line — otherwise a
 *    concern cannot be located against it;
 * 3. the known work's title appears **nowhere** in `paper/` — otherwise a seat
 *    can read the answer instead of retrieving it, and the probe measures
 *    grep rather than recall;
 * 4. `probe.json` sits outside both manuscript directories (ADR 0070's layout
 *    rule) — for the same reason.
 *
 * None of these can be asserted from the instrument's side, because the
 * instrument is handed the probe and believes it.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readProbe } from "../../src/eval/novelty.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "live", "fixtures", "novelty-probe");
const PAPER = join(FIXTURE, "paper");
const OWN_TITLE = join(FIXTURE, "own-title");

const read = (...p: string[]) => readFile(join(...p), "utf8");

describe("V2 O27 — the novelty probe fixture", () => {
  it("has a readable probe naming the known work", async () => {
    const probe = await readProbe(join(FIXTURE, "probe.json"));
    expect(probe.fixture).toBe("novelty-probe");
    expect(probe.known.title).toBe(
      "Adam: A Method for Stochastic Optimization",
    );
    expect(probe.known.arxiv).toBe("1412.6980");
    expect(probe.claims.length).toBeGreaterThan(0);
  });

  it("differs from its own-title twin in EXACTLY the \\title line", async () => {
    const a = (await read(PAPER, "main.tex")).split("\n");
    const b = (await read(OWN_TITLE, "main.tex")).split("\n");
    expect(b).toHaveLength(a.length);
    const differing = a
      .map((line, i) => (line === b[i] ? -1 : i))
      .filter((i) => i >= 0);
    // One line, and it is the title — asserted as the LINE INDICES rather than
    // a count, so a failure says which line drifted.
    expect(differing).toHaveLength(1);
    const i = differing[0] as number;
    expect(a[i]).toMatch(/^\\title\{/);
    expect(b[i]).toBe("\\title{Adam: A Method for Stochastic Optimization}");
  });

  it("records every claim anchor once, at the line it names", async () => {
    const probe = await readProbe(join(FIXTURE, "probe.json"));
    const text = await read(PAPER, "main.tex");
    const lines = text.split("\n");
    for (const claim of probe.claims) {
      // Once in the whole manuscript: an anchor that occurs twice is
      // `ambiguous` to the locator and drops the entry that cites it.
      const occurrences = text.split(claim.anchor).length - 1;
      expect(
        occurrences,
        `anchor "${claim.anchor}" occurs ${occurrences} times`,
      ).toBe(1);
      expect(
        lines[claim.line - 1],
        `anchor "${claim.anchor}" is not on line ${claim.line}`,
      ).toContain(claim.anchor);
    }
  });

  it("never names the known work anywhere under paper/", async () => {
    const probe = await readProbe(join(FIXTURE, "probe.json"));
    for (const name of await readdir(PAPER)) {
      const body = await read(PAPER, name);
      expect(body, `${name} names the known title`).not.toContain(
        probe.known.title,
      );
      // And not by its short name either. A seat that can grep "Adam" has not
      // retrieved anything, and the probe would measure reading rather than
      // recall — the one failure mode that would look like a success.
      expect(body, `${name} names the known work`).not.toMatch(/\bAdam\b/);
      expect(body, `${name} carries its arXiv id`).not.toContain(
        probe.known.arxiv,
      );
    }
  });

  it("keeps probe.json outside both manuscript directories", async () => {
    // ADR 0070's layout rule. The ground truth is the one file a reviewer must
    // not be able to open, and `--paper` copies a manuscript directory.
    for (const dir of [PAPER, OWN_TITLE]) {
      expect(await readdir(dir)).not.toContain("probe.json");
    }
    expect(await readdir(FIXTURE)).toContain("probe.json");
  });

  it("re-derives the known work in substance, so there is something to find", async () => {
    // A probe whose paper did NOT re-derive the known work would be
    // unfalsifiable: no reviewer could correctly cite it, and `0/3` would mean
    // nothing. These are the two moments and the bias correction that make the
    // method the known one under another name.
    const body = await read(PAPER, "main.tex");
    for (const marker of [
      "\\beta_1 m_{t-1} + (1 - \\beta_1) g_t",
      "\\beta_2 v_{t-1} + (1 - \\beta_2) g_t^2",
      "\\frac{m_t}{1 - \\beta_1^t}",
      "\\sqrt{\\hat{v}_t} +",
    ]) {
      expect(body, `the derivation is missing ${marker}`).toContain(marker);
    }
  });
});
