import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompileProjectOptions } from "../../src/engine/compile.js";
import { bundledVenuesDir } from "../../src/venue/bundled.js";
import { getVenue } from "../../src/venue/library.js";
import { VenueError } from "../../src/venue/manifest.js";
import { scaffoldVenue } from "../../src/venue/scaffold.js";
import { expectLocalePair } from "../support/locale.js";

const exists = async (p: string): Promise<boolean> => {
  try {
    await readdir(p);
    return true;
  } catch {
    return (await readFile(p, "utf8")
      .then(() => true)
      .catch(() => false)) as boolean;
  }
};

describe("scaffoldVenue", () => {
  let target: string;
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "lemmaria-scaffold-"));
    target = join(scratch, "paper");
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const bundled = { bundledDir: bundledVenuesDir() };

  it("materializes acm-sigconf: starters + requirements + seeded PAPER.md + compile", async () => {
    const compile = vi
      .fn<(o: CompileProjectOptions) => Promise<{ ok: boolean; log: string }>>()
      .mockResolvedValue({ ok: true, log: "clean" });
    const venue = await getVenue("acm-sigconf", bundled);
    const report = await scaffoldVenue({ venue, targetDir: target, compile });

    expect(report.venueId).toBe("acm-sigconf");
    expect(report.filesWritten).toEqual([
      "PAPER.md",
      "main.tex",
      "references.bib",
      "requirements.md",
    ]);
    expect(report.entryFile).toBe("main.tex");
    expect(report.compile).toEqual({
      engine: "pdflatex",
      ok: true,
      log: "clean",
    });
    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({
        root: target,
        entry: "main.tex",
        engine: "pdflatex",
      }),
    );

    const paper = await readFile(join(target, "PAPER.md"), "utf8");
    expect(paper).toContain("# paper"); // title = basename(targetDir)
    expect(paper).toContain(
      "page_limit: 9 pages (excl. references; check your CFP)",
    );
    expect(paper).toContain("anonymity: double_blind");
    expect(paper).toContain("bibstyle: ACM-Reference-Format");

    const mainTex = await readFile(join(target, "main.tex"), "utf8");
    const bundledTex = await readFile(
      join(bundledVenuesDir(), "acm-sigconf", "main.tex"),
      "utf8",
    );
    expect(mainTex).toBe(bundledTex);
  });

  it("refuses a non-empty target and writes nothing", async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "existing.txt"), "hi", "utf8");
    const venue = await getVenue("acm-sigconf", bundled);
    let err: unknown;
    try {
      await scaffoldVenue({ venue, targetDir: target, compile: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe("target_not_empty");
    expect(await readdir(target)).toEqual(["existing.txt"]);
  });

  it("refuses cleanly when the target path is an existing file", async () => {
    await mkdir(scratch, { recursive: true });
    await writeFile(target, "i am a file, not a dir", "utf8");
    const venue = await getVenue("acm-sigconf", bundled);
    let err: unknown;
    try {
      await scaffoldVenue({ venue, targetDir: target, compile: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe("target_not_empty");
    // The pre-existing file is untouched.
    expect(await readFile(target, "utf8")).toBe("i am a file, not a dir");
  });

  /** Rewritten by D4: this asserted `toContain("跳过")` on the default (English)
   *  render — i.e. it asserted the `"english / 中文"` defect ADR 0034 retired.
   *  The replacement is §5's shape, and the two-locale pair is asserted in the
   *  "one language per reader" suite below. */
  it("skips the baseline compile on compile: false with a reason", async () => {
    const venue = await getVenue("ieee-conference", bundled);
    const report = await scaffoldVenue({
      venue,
      targetDir: target,
      compile: false,
    });
    expect(report.compile).toHaveProperty("skipped");
    expect((report.compile as { skipped: string }).skipped).toBe(
      "skipped by request",
    );
  });

  it("reports resolveEngine guidance when the engine is unavailable (files still written)", async () => {
    const venue = await getVenue("ieee-conference", bundled);
    const compile = vi.fn();
    const report = await scaffoldVenue({
      venue,
      targetDir: target,
      compile,
      engineAvailable: () => false,
    });
    expect(compile).not.toHaveBeenCalled();
    expect((report.compile as { skipped: string }).skipped).toMatch(/pdflatex/);
    expect(await exists(join(target, "main.tex"))).toBe(true);
  });

  // ── redistribute:false (reference-and-fetch) ───────────────────────────────

  async function fetchVenueDir(): Promise<string> {
    const dir = join(scratch, "venues", "fetchy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "venue.yaml"),
      [
        "id: fetchy",
        "name: { en: Fetchy, zh: 取件 }",
        "documentclass: { class: fetchy }",
        "engine: pdflatex",
        "starter_files: [main.tex]",
        "redistribute: false",
        "fetch_files:",
        '  - { url: "https://example.org/fetchy.cls", dest: fetchy.cls }',
        "source_url: https://example.org/guidelines",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "requirements.md"), "# fetchy\n", "utf8");
    await writeFile(join(dir, "main.tex"), "\\documentclass{fetchy}\n", "utf8");
    return join(scratch, "venues");
  }

  it("fetches fetch_files live and writes them", async () => {
    const bundledDir = await fetchVenueDir();
    const venue = await getVenue("fetchy", { bundledDir });
    const fetchImpl = vi.fn().mockResolvedValue(new Response("CLS CONTENT"));
    const report = await scaffoldVenue({
      venue,
      targetDir: target,
      compile: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(report.filesWritten).toContain("fetchy.cls");
    expect(await readFile(join(target, "fetchy.cls"), "utf8")).toBe(
      "CLS CONTENT",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.org/fetchy.cls",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("a failed fetch aborts with source_url in the error and writes nothing", async () => {
    const bundledDir = await fetchVenueDir();
    const venue = await getVenue("fetchy", { bundledDir });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    let err: unknown;
    try {
      await scaffoldVenue({
        venue,
        targetDir: target,
        compile: false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe("fetch_failed");
    expect((err as VenueError).message).toContain(
      "https://example.org/guidelines",
    );
    expect(await exists(target)).toBe(false);
  });

  it("a non-OK fetch status fails the same way", async () => {
    const bundledDir = await fetchVenueDir();
    const venue = await getVenue("fetchy", { bundledDir });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(
      scaffoldVenue({
        venue,
        targetDir: target,
        compile: false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(await exists(target)).toBe(false);
  });

  it("a hanging fetch is cut off by fetchTimeoutMs (never a hang)", async () => {
    const bundledDir = await fetchVenueDir();
    const venue = await getVenue("fetchy", { bundledDir });
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise<never>(() => {}), // ignores the abort signal, never settles
    );
    const started = Date.now();
    await expect(
      scaffoldVenue({
        venue,
        targetDir: target,
        compile: false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        fetchTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await exists(target)).toBe(false);
  });

  it("a starter file missing on disk fails clearly, nothing written", async () => {
    const dir = join(scratch, "venues2", "ghost");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "venue.yaml"),
      "id: ghost\nname: { en: G, zh: G }\ndocumentclass: { class: g }\nengine: pdflatex\nstarter_files: [missing.tex]\n",
      "utf8",
    );
    await writeFile(join(dir, "requirements.md"), "# g\n", "utf8");
    const venue = await getVenue("ghost", {
      bundledDir: join(scratch, "venues2"),
    });
    await expect(
      scaffoldVenue({ venue, targetDir: target, compile: false }),
    ).rejects.toThrow(/missing\.tex/);
    expect(await exists(target)).toBe(false);
  });
});

/**
 * D4 (invariant 6 rule 2, ADR 0034): every report and refusal the scaffolder
 * produces renders in the reader's language. Six strings, all of which surfaced
 * as `"English. 中文。"` through `venue-ui.ts` before D4.
 */
describe("scaffoldVenue — one language per reader (D4)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "lemmaria-scaffold-locale-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const refusalInto = async (
    dir: string,
    locale: "en" | "zh",
  ): Promise<string> => {
    const venue = await getVenue("acm-sigconf", {
      bundledDir: bundledVenuesDir(),
    });
    try {
      await scaffoldVenue({
        venue,
        targetDir: dir,
        compile: false,
        locale,
      });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected scaffoldVenue to refuse");
  };

  it("refuses a non-empty target in one language, differing by locale", async () => {
    const enDir = join(scratch, "en");
    const zhDir = join(scratch, "zh");
    for (const d of [enDir, zhDir]) {
      await mkdir(d, { recursive: true });
      await writeFile(join(d, "occupied.txt"), "x", "utf8");
    }
    expectLocalePair(
      await refusalInto(enDir, "en"),
      await refusalInto(zhDir, "zh"),
      [enDir, zhDir],
    );
  });

  it("reports a skipped compile in one language, differing by locale", async () => {
    const venue = await getVenue("acm-sigconf", {
      bundledDir: bundledVenuesDir(),
    });
    const report = async (locale: "en" | "zh") => {
      const dir = join(scratch, `skip-${locale}`);
      const r = await scaffoldVenue({
        venue,
        targetDir: dir,
        compile: false,
        locale,
      });
      return "skipped" in r.compile ? r.compile.skipped : "";
    };
    expectLocalePair(await report("en"), await report("zh"));
  });

  it("defaults to English, so every pre-D4 caller is byte-identical", async () => {
    const venue = await getVenue("acm-sigconf", {
      bundledDir: bundledVenuesDir(),
    });
    const r = await scaffoldVenue({
      venue,
      targetDir: join(scratch, "default"),
      compile: false,
    });
    expect("skipped" in r.compile ? r.compile.skipped : "").toBe(
      "skipped by request",
    );
  });
});
