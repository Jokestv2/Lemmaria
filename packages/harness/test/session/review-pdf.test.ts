import { describe, expect, it } from "vitest";
import type { CompileResult } from "../../src/contracts/adapters.js";
import {
  PDF_FRESHNESS_SLACK_MS,
  PDF_OUTPUT_DIRS,
  type ReviewPdfOutcome,
  resolveReviewPdf,
} from "../../src/session/review-pdf.js";

const NOW = 1_700_000_000_000;
const bytesFor = (path: string): Uint8Array =>
  new TextEncoder().encode(`%PDF-${path}`);
const pathOf = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes).replace("%PDF-", "");

/**
 * One bed for every case: a fake file system of `path → mtimeMs`, and a
 * compile that can be told to succeed, fail, or be absent entirely.
 */
function bed(opts: {
  files: Record<string, number>;
  entry?: string;
  manuscript?: string[];
  namedPdf?: string;
  compile?: "ok" | "fail" | "no-pdf";
}) {
  const reads: string[] = [];
  let compiles = 0;
  const compileImpl = async (): Promise<CompileResult> => {
    compiles++;
    if (opts.compile === "fail") {
      return {
        ok: false,
        log: [...Array(40)].map((_, i) => `log line ${i}`).join("\n"),
      };
    }
    if (opts.compile === "no-pdf") return { ok: true, log: "no output" };
    return { ok: true, log: "Output written", pdf: bytesFor("<compiled>") };
  };
  return {
    reads,
    compiles: () => compiles,
    run: (): Promise<ReviewPdfOutcome> =>
      resolveReviewPdf({
        entry: opts.entry ?? "main.tex",
        files: opts.manuscript ?? ["main.tex"],
        ...(opts.namedPdf ? { namedPdf: opts.namedPdf } : {}),
        stat: async (p) =>
          p in opts.files ? { mtimeMs: opts.files[p] as number } : undefined,
        readBinary: async (p) => {
          reads.push(p);
          return bytesFor(p);
        },
        ...(opts.compile ? { compile: compileImpl } : {}),
      }),
  };
}

describe("resolveReviewPdf — rule 1, a PDF the user named (V3, ADR 0080 §8)", () => {
  it("wins outright when it exists and is fresh", async () => {
    const out = await bed({
      files: { "main.tex": NOW, "main.pdf": NOW, "dist/paper.pdf": NOW },
      namedPdf: "dist/paper.pdf",
    }).run();
    expect(out).toMatchObject({
      ok: true,
      source: "named",
      path: "dist/paper.pdf",
    });
    expect(out.ok && out.stale).toBeUndefined();
  });

  it("wins EVEN WHEN STALE, flagged — the user said which file", async () => {
    // A Markdown project has no compile to fall back to, so overriding the
    // user's choice would leave the review with nothing.
    const out = await bed({
      files: { "main.tex": NOW, "dist/paper.pdf": NOW - 600_000 },
      namedPdf: "dist/paper.pdf",
      compile: "ok",
    }).run();
    expect(out).toMatchObject({ ok: true, source: "named", stale: true });
  });

  it("falls THROUGH when it does not exist — a path typed once and since moved", async () => {
    const out = await bed({
      files: { "main.tex": NOW, "main.pdf": NOW },
      namedPdf: "gone/paper.pdf",
    }).run();
    expect(out).toMatchObject({ ok: true, source: "beside_entry" });
  });
});

describe("resolveReviewPdf — rule 2, discovery", () => {
  it("prefers a fresh PDF beside the entry over one in out/", async () => {
    const out = await bed({
      files: { "main.tex": NOW, "main.pdf": NOW, "out/main.pdf": NOW },
    }).run();
    expect(out).toMatchObject({
      ok: true,
      source: "beside_entry",
      path: "main.pdf",
    });
  });

  it("finds BOTH conventional output directories", async () => {
    for (const dir of PDF_OUTPUT_DIRS) {
      const out = await bed({
        files: { "main.tex": NOW, [`${dir}/main.pdf`]: NOW },
      }).run();
      expect(out).toMatchObject({
        ok: true,
        source: "output_dir",
        path: `${dir}/main.pdf`,
      });
    }
  });

  it("looks beside a NESTED entry, and at the root's output dirs", async () => {
    const beside = await bed({
      entry: "paper/main.tex",
      manuscript: ["paper/main.tex"],
      files: { "paper/main.tex": NOW, "paper/main.pdf": NOW },
    }).run();
    expect(beside).toMatchObject({ ok: true, path: "paper/main.pdf" });

    const atRoot = await bed({
      entry: "paper/main.tex",
      manuscript: ["paper/main.tex"],
      files: { "paper/main.tex": NOW, "out/main.pdf": NOW },
    }).run();
    expect(atRoot).toMatchObject({ ok: true, path: "out/main.pdf" });
  });

  it("skips a STALE candidate and keeps looking", async () => {
    const out = await bed({
      files: {
        "main.tex": NOW,
        "main.pdf": NOW - 600_000, // stale
        "out/main.pdf": NOW, // fresh
      },
    }).run();
    expect(out).toMatchObject({ ok: true, path: "out/main.pdf" });
  });

  it("the newest of ALL manuscript files sets the bar — a .bib counts", async () => {
    const out = await bed({
      manuscript: ["main.tex", "refs.bib"],
      files: {
        "main.tex": NOW - 600_000,
        "refs.bib": NOW, // edited after the PDF was built
        "main.pdf": NOW - 300_000,
      },
    }).run();
    expect(out).toMatchObject({ ok: false, reason: "stale" });
  });

  it("a manuscript file with NO stat is ignored, not treated as infinitely new", async () => {
    // One unreadable \input should not condemn every PDF as stale.
    const out = await bed({
      manuscript: ["main.tex", "sections/missing.tex"],
      files: { "main.tex": NOW - 600_000, "main.pdf": NOW - 300_000 },
    }).run();
    expect(out).toMatchObject({ ok: true, source: "beside_entry" });
  });

  it("the two-second slack lets a PDF built just before a save read fresh", async () => {
    const justInside = await bed({
      files: { "main.tex": NOW, "main.pdf": NOW - PDF_FRESHNESS_SLACK_MS },
    }).run();
    expect(justInside.ok).toBe(true);

    const justOutside = await bed({
      files: { "main.tex": NOW, "main.pdf": NOW - PDF_FRESHNESS_SLACK_MS - 1 },
    }).run();
    expect(justOutside).toMatchObject({ ok: false, reason: "stale" });
  });

  it("reads only the candidate it chose", async () => {
    const b = bed({
      files: { "main.tex": NOW, "main.pdf": NOW, "out/main.pdf": NOW },
    });
    await b.run();
    expect(b.reads).toEqual(["main.pdf"]);
  });
});

describe("resolveReviewPdf — rule 3, compiling one", () => {
  it("compiles when every candidate is stale, and reports source: compiled", async () => {
    const b = bed({
      files: { "main.tex": NOW, "main.pdf": NOW - 600_000 },
      compile: "ok",
    });
    const out = await b.run();
    expect(out).toMatchObject({ ok: true, source: "compiled" });
    expect(out.ok && pathOf(out.bytes)).toBe("<compiled>");
    expect(b.compiles()).toBe(1);
  });

  it("compiles when there is no candidate at all", async () => {
    const out = await bed({ files: { "main.tex": NOW }, compile: "ok" }).run();
    expect(out).toMatchObject({ ok: true, source: "compiled" });
  });

  it("does NOT compile when a fresh candidate was found", async () => {
    const b = bed({
      files: { "main.tex": NOW, "main.pdf": NOW },
      compile: "ok",
    });
    await b.run();
    expect(b.compiles()).toBe(0);
  });

  it("a failed compile carries the log's tail as the detail", async () => {
    const out = await bed({
      files: { "main.tex": NOW },
      compile: "fail",
    }).run();
    expect(out).toMatchObject({ ok: false, reason: "compile_failed" });
    const detail = (out as { detail?: string }).detail ?? "";
    expect(detail).toContain("log line 39");
    expect(detail).not.toContain("log line 0");
    expect(detail.split("\n")).toHaveLength(20);
  });

  it("an ok compile that produced no PDF is still compile_failed", async () => {
    // ok:true with no artifact means the engine claimed success and wrote
    // nothing we could find — the limit that records a user's own -outdir.
    const out = await bed({
      files: { "main.tex": NOW },
      compile: "no-pdf",
    }).run();
    expect(out).toMatchObject({ ok: false, reason: "compile_failed" });
  });
});

describe("resolveReviewPdf — rule 4, the two kinds of nothing", () => {
  it("`stale` when a candidate existed but this run cannot compile", async () => {
    const out = await bed({
      files: { "main.tex": NOW, "main.pdf": NOW - 600_000 },
    }).run();
    expect(out).toEqual({ ok: false, reason: "stale" });
  });

  it("`none` when no candidate existed at all", async () => {
    const out = await bed({ files: { "main.tex": NOW } }).run();
    expect(out).toEqual({ ok: false, reason: "none" });
  });

  it("the two are distinguishable — one means recompile, the other means there is none", async () => {
    const stale = await bed({
      files: { "main.tex": NOW, "out/main.pdf": NOW - 600_000 },
    }).run();
    const none = await bed({ files: { "main.tex": NOW } }).run();
    expect((stale as { reason: string }).reason).not.toBe(
      (none as { reason: string }).reason,
    );
  });
});

describe("resolveReviewPdf — a throwing port degrades, it does not escape", () => {
  // The guard V3's code review asked for. Every real `Workspace` can throw
  // where this module's contract says *degrade*: `assertWorkspaceRelative` is
  // outside the `try` in both `stat` implementations, neither `readBinary` has
  // one, and `FsWorkspace.compile` rejects with no entry bound. A throw would
  // reach the caller past all four of the honest refusal reasons — and V4's
  // review driver is the first production caller, so the seam is easy to miss.
  const boom = (what: string) => () => {
    throw new Error(`${what} exploded`);
  };

  it("a throwing `stat` reads as absence, not as an exception", async () => {
    const out = await resolveReviewPdf({
      entry: "main.tex",
      files: ["main.tex"],
      stat: async () => boom("stat")(),
      readBinary: async (p) => bytesFor(p),
    });
    expect(out).toEqual({ ok: false, reason: "none" });
  });

  it("a candidate that stats but will not read falls to the NEXT candidate", async () => {
    const files: Record<string, number> = {
      "main.tex": NOW,
      "main.pdf": NOW,
      "out/main.pdf": NOW,
    };
    const out = await resolveReviewPdf({
      entry: "main.tex",
      files: ["main.tex"],
      stat: async (p) =>
        p in files ? { mtimeMs: files[p] as number } : undefined,
      readBinary: async (p) => {
        // The one beside the entry is unreadable; `out/` is fine.
        if (p === "main.pdf") throw new Error("EACCES");
        return bytesFor(p);
      },
    });
    // Not a refusal, and not the unreadable file: the next rule answered.
    expect(out).toMatchObject({
      ok: true,
      source: "output_dir",
      path: `${PDF_OUTPUT_DIRS[0]}/main.pdf`,
    });
  });

  it("a NAMED pdf that will not read falls through to discovery", async () => {
    const files: Record<string, number> = {
      "main.tex": NOW,
      "main.pdf": NOW,
      "dist/paper.pdf": NOW,
    };
    const out = await resolveReviewPdf({
      entry: "main.tex",
      files: ["main.tex"],
      namedPdf: "dist/paper.pdf",
      stat: async (p) =>
        p in files ? { mtimeMs: files[p] as number } : undefined,
      readBinary: async (p) => {
        if (p === "dist/paper.pdf") throw new Error("EACCES");
        return bytesFor(p);
      },
    });
    // The same fall-through a named path that no longer exists already takes.
    expect(out).toMatchObject({ ok: true, source: "beside_entry" });
  });

  it("a REJECTING compile is `compile_failed`, carrying the message as detail", async () => {
    const out = await resolveReviewPdf({
      entry: "main.tex",
      files: ["main.tex"],
      stat: async (p) => (p === "main.tex" ? { mtimeMs: NOW } : undefined),
      readBinary: async (p) => bytesFor(p),
      compile: async () => boom("compile")(),
    });
    expect(out).toMatchObject({ ok: false, reason: "compile_failed" });
    expect((out as { detail?: string }).detail).toContain("compile exploded");
  });
});
