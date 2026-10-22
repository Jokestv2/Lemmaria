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
import { main } from "../src/main.js";

function collectIo(): { io: { log: (l: string) => void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { log: (l) => lines.push(l) }, lines };
}

describe("lemmaria venues", () => {
  let isoHome: string;

  beforeEach(async () => {
    // Hermetic default cache: point the `.lemmaria` root at an empty temp
    // dir so the real ~/.lemmaria/venues (F5-test leftovers) can't leak in.
    isoHome = await mkdtemp(join(tmpdir(), "lemmaria-venues-home-"));
    vi.stubEnv("LEMMARIA_MEMORY_DIR", isoHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(isoHome, { recursive: true, force: true });
  });

  it("lists the three curated bundled venues", async () => {
    const { io, lines } = collectIo();
    const code = await main(["venues"], io);
    expect(code).toBe(0);
    const out = JSON.parse(lines.join("\n")) as {
      venues: Array<{ id: string; source: string; engine: string }>;
      errors: unknown[];
    };
    expect(out.venues.map((v) => v.id)).toEqual([
      "acm-sigconf",
      "ieee-conference",
      "llncs",
    ]);
    expect(out.venues.every((v) => v.source === "bundled")).toBe(true);
    expect(out.errors).toEqual([]);
  });
});

describe("lemmaria new (M10 offline acceptance)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "lemmaria-cli-new-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it.each(["acm-sigconf", "ieee-conference"])(
    "scaffolds %s offline (--no-compile): files + seeded PAPER.md",
    async (id) => {
      const target = join(scratch, id);
      const { io, lines } = collectIo();
      const code = await main(
        ["new", "--venue", id, "--target", target, "--no-compile"],
        io,
      );
      expect(code).toBe(0);
      const report = JSON.parse(lines.join("\n")) as {
        venueId: string;
        filesWritten: string[];
        entryFile: string;
        compile: { skipped?: string };
      };
      expect(report.venueId).toBe(id);
      expect(report.filesWritten).toEqual([
        "PAPER.md",
        "main.tex",
        "references.bib",
        "requirements.md",
      ]);
      expect(report.entryFile).toBe("main.tex");
      expect(report.compile.skipped).toBeDefined();
      expect((await readdir(target)).sort()).toEqual(report.filesWritten);
      const paper = await readFile(join(target, "PAPER.md"), "utf8");
      expect(paper).toContain("## Venue");
    },
  );

  it("seeds the acm PAPER.md with the manifest constraints", async () => {
    const target = join(scratch, "acm2");
    const { io } = collectIo();
    await main(
      ["new", "--venue", "acm-sigconf", "--target", target, "--no-compile"],
      io,
    );
    const paper = await readFile(join(target, "PAPER.md"), "utf8");
    expect(paper).toContain(
      "page_limit: 9 pages (excl. references; check your CFP)",
    );
    expect(paper).toContain("anonymity: double_blind");
    expect(paper).toContain("bibstyle: ACM-Reference-Format");
  });

  it("an unknown venue exits 1 listing the known ids", async () => {
    const { io, lines } = collectIo();
    const code = await main(
      [
        "new",
        "--venue",
        "nope",
        "--target",
        join(scratch, "x"),
        "--no-compile",
      ],
      io,
    );
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("acm-sigconf");
    expect(out).toContain("ieee-conference");
  });

  it("a non-empty target exits 1 and stays untouched", async () => {
    const target = join(scratch, "busy");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep", "utf8");
    const { io, lines } = collectIo();
    const code = await main(
      ["new", "--venue", "acm-sigconf", "--target", target, "--no-compile"],
      io,
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/not empty|非空/);
    expect(await readdir(target)).toEqual(["keep.txt"]);
  });

  it("missing flags print usage and exit 1", async () => {
    const { io, lines } = collectIo();
    const code = await main(["new", "--venue", "acm-sigconf"], io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("--target");
  });
});

// Live baseline-compile acceptance (build-plan M10 gate line 1): requires a
// local latexmk + the acmart/IEEEtran classes; env-gated like the M5 suite.
describe.skipIf(process.env.LEMMARIA_COMPILE_TESTS !== "1")(
  "lemmaria new (live baseline compile)",
  () => {
    it.each(["acm-sigconf", "ieee-conference"])(
      "scaffolded %s passes a baseline compile",
      async (id) => {
        const scratch = await mkdtemp(join(tmpdir(), "lemmaria-live-new-"));
        try {
          const { io, lines } = collectIo();
          const code = await main(
            ["new", "--venue", id, "--target", join(scratch, id)],
            io,
          );
          const report = JSON.parse(lines.join("\n")) as {
            compile: { ok?: boolean; log?: string };
          };
          expect(report.compile.ok, report.compile.log?.slice(-2000)).toBe(
            true,
          );
          expect(code).toBe(0);
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      },
      300_000,
    );
  },
);
