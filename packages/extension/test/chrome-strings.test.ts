/**
 * D4: the chrome's string table (invariant 6 rule 2, ADR 0034).
 *
 * The repo-wide guard `scripts/check-mixed-language-strings.mjs` proves no
 * SOURCE literal carries two languages. These checks prove the complementary
 * half, over the RESOLVED values: every key exists in both halves, the English
 * half is English, the Chinese half is Chinese, and no key is dead. That is the
 * same pairing D2 established for the webview table — the rule pinned once by
 * source text and once by value (`test-webview/strings.test.ts`).
 *
 * It lives in the ext-host suite rather than under vitest because
 * `chrome-strings.ts` is HOST code, not webview code — ADR 0037 §2.4 scopes the
 * jsdom project to `src/webview/parts/`. The module imports no `vscode`, so it
 * is imported directly here and needs nothing launched.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { CHROME, type ChromeKey, tr } from "../src/chrome-strings";

function extensionRoot(): string {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return ext.extensionPath;
}

const CJK = /[一-鿿]/;
/** The guard's own English-PROSE test: three ASCII words plus a function word,
 *  so a Chinese label naming `PAPER.md` or `Semantic Scholar` is not reported. */
const EN_CLAUSE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
const EN_FUNCTION_WORD =
  /\b(?:the|an?|is|are|was|were|be|to|of|in|on|for|and|or|not|no|it|this|that|these|with|from|by|at|as|has|have|had|can|could|will|would|your|you|its|any|all|so|but|if|when|while|than|then|there|here|into|out|up|down|only|every|each|because|before|after|again)\b/i;

/**
 * Keys whose Chinese value is legitimately script-neutral — a bare product
 * name, a file name, a command id. Kept as an explicit list rather than a
 * pattern so a genuinely untranslated string cannot hide behind it.
 */
const SCRIPT_NEUTRAL: ChromeKey[] = [];

suite("D4 chrome string table", () => {
  const enKeys = Object.keys(CHROME.en).sort();
  const zhKeys = Object.keys(CHROME.zh).sort();

  test("both halves carry exactly the same keys", () => {
    assert.deepStrictEqual(enKeys, zhKeys);
    assert.ok(enKeys.length > 0, "the table is empty");
  });

  test("the English half carries no Chinese", () => {
    const offenders = enKeys.filter((k) => CJK.test(CHROME.en[k as ChromeKey]));
    assert.deepStrictEqual(offenders, []);
  });

  test("the Chinese half is Chinese", () => {
    const offenders = zhKeys.filter(
      (k) =>
        !SCRIPT_NEUTRAL.includes(k as ChromeKey) &&
        !CJK.test(CHROME.zh[k as ChromeKey]),
    );
    assert.deepStrictEqual(offenders, []);
  });

  test("the Chinese half carries no English clause", () => {
    const offenders = zhKeys.filter((k) => {
      const v = CHROME.zh[k as ChromeKey];
      return EN_CLAUSE.test(v) && EN_FUNCTION_WORD.test(v);
    });
    assert.deepStrictEqual(offenders, []);
  });

  test("no value is empty in either half", () => {
    const offenders = enKeys.filter(
      (k) =>
        CHROME.en[k as ChromeKey].trim() === "" ||
        CHROME.zh[k as ChromeKey].trim() === "",
    );
    assert.deepStrictEqual(offenders, []);
  });

  test("tr resolves each key in each locale", () => {
    for (const k of enKeys) {
      assert.strictEqual(tr("en", k as ChromeKey), CHROME.en[k as ChromeKey]);
      assert.strictEqual(tr("zh", k as ChromeKey), CHROME.zh[k as ChromeKey]);
    }
  });

  /**
   * A dead key is the `nls.test.ts` no-unused-translation guard applied here:
   * it is the only automated signal that a swept call site kept its key, and it
   * is what would catch a sweep that added a key and forgot to use it.
   */
  test("no chrome string offers the reader a branch (ADR 0057)", () => {
    // E5 deleted branches from the product. A string table is where a retired
    // word survives longest — nothing type-checks prose — and this milestone
    // found two live strings still promising branches, neither caught by any
    // guard. Swept over RESOLVED values in both halves so the class is closed
    // rather than the two instances. Git branches are named by interpolating
    // call sites in `status-bar-ui.ts`, never by a key here, so this sweep has
    // no legitimate exception; if one ever arrives, it argues for itself.
    const offenders: string[] = [];
    for (const locale of ["en", "zh"] as const)
      for (const [key, value] of Object.entries(CHROME[locale]))
        if (/branch/i.test(value) || /分支/.test(value))
          offenders.push(`${locale}.${key}: ${value}`);
    assert.deepStrictEqual(offenders, []);
  });

  test("every key is referenced by a source file", () => {
    const root = extensionRoot();
    const srcDir = path.join(root, "src");
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.ts$/.test(entry.name) && entry.name !== "chrome-strings.ts")
          sources.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(srcDir);
    const all = sources.join("\n");
    // A real LOOKUP, not a bare substring: `all.includes(`"${k}"`)` was
    // satisfied by the key appearing in a comment or in an unrelated literal.
    // Found by D4's code review.
    const unused = enKeys.filter(
      (k) => !all.includes(`chrome("${k}")`) && !all.includes(`, "${k}")`),
    );
    assert.deepStrictEqual(unused, [], "chrome-strings keys nothing uses");
  });
});

/**
 * D4: every harness function that renders a user-visible string takes a
 * `SessionLocale`, defaulted to `"en"` so pre-D4 callers stay byte-identical.
 * That default is exactly what makes a MISSED call site silent — the string
 * just comes back English, in a Chinese editor, with every test still green.
 *
 * D4's own code review found four such call sites after the harness half was
 * "done" (`venue-ui.ts` ×3, `citation-ui.ts`, `paper-md.ts`). This is the
 * assertion that would have caught them. It is source-level for the reason
 * `check-vscode-imports.mjs` is: what must be true is a property of the CALL,
 * and a default that silently works has no behaviour to observe.
 */
suite("D4: every locale-taking harness call passes one", () => {
  /** Harness functions whose output a user reads, and where the argument goes. */
  const LOCALE_TAKING = [
    "checkCitationConsistency",
    "resolveEngine",
    "parseVenueManifest",
    "listVenues",
    "getVenue",
    "scaffoldVenue",
    "draftPaperMd",
    "validateProposedEdits",
    "invalidPathReason",
    "compileStatusLabel",
  ];

  /** The source text of the call's argument list, parens balanced. */
  const argsOf = (src: string, at: number): string => {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return src.slice(at, i + 1);
      }
    }
    return src.slice(at);
  };

  test("no call site relies on the en default", () => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext, "extension not found");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const src = fs.readFileSync(full, "utf8");
        for (const fn of LOCALE_TAKING) {
          const call = new RegExp(`(?<![\\w.])${fn}\\s*\\(`, "g");
          for (const m of src.matchAll(call)) {
            const open = m.index + m[0].length - 1;
            // Comments are STRIPPED first. Without that, a comment inside the
            // call explaining why the locale matters satisfies the check while
            // the argument is missing — which is exactly what happened when
            // this guard was first written.
            const args = argsOf(src, open)
              .replace(/\/\*[\s\S]*?\*\//g, "")
              .replace(/\/\/[^\n]*/g, "");
            // `libraryOptions(context)` is the one indirection: it BUILDS the
            // options object and puts the locale in it, so a call taking it is
            // passing one.
            const ok =
              args.includes("currentLocale()") ||
              /\blocale\b/.test(args) ||
              args.includes("libraryOptions(");
            if (!ok) offenders.push(`${entry.name}: ${fn}(...)`);
          }
        }
      }
    };
    walk(path.join(ext.extensionPath, "src"));
    assert.deepStrictEqual(
      offenders,
      [],
      "these calls fall back to the English default",
    );
  });
});

/**
 * E6 (code review): the six strings that live in BOTH tables must say the same
 * thing.
 *
 * The duplication is deliberate and cannot be removed — the ⟲ popover renders
 * from `webview/parts/strings.ts` and the palette command's QuickPick from
 * `chrome-strings.ts`, and ADR 0037 §2.4 forbids a host module importing the
 * webview's table. But ADR 0058 §4's whole claim for the palette twin is that
 * it asks the SAME question in different chrome, and nothing was stopping the
 * two copies from drifting into two different questions.
 *
 * Read as source text, following `nls.test.ts`'s precedent for the same file:
 * the webview table is not importable from the ext-host suite, and the text is
 * what a source edit would change.
 */
suite("chrome strings — the six the webview also owns", () => {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  const src = fs.readFileSync(
    path.join(ext.extensionPath, "src", "webview", "parts", "strings.ts"),
    "utf8",
  );

  /** Both locale tables' values for one key, in source order (en, then zh). */
  function webviewValues(key: string): string[] {
    return [...src.matchAll(new RegExp(`\\b${key}:\\s+"([^"]*)"`, "g"))].map(
      (m) => m[1] ?? "",
    );
  }

  const SHARED = [
    "rewindArmFork",
    "rewindArmRestore",
    "rewindArmBoth",
    "rewindAskRestore",
    "rewindAskBoth",
    "rewindNoFiles",
  ] as const;

  test("each one resolves identically in both tables, in both locales", () => {
    for (const key of SHARED) {
      const [en, zh] = webviewValues(key);
      assert.ok(
        en !== undefined && zh !== undefined,
        `${key} must appear in both of the webview's locale tables`,
      );
      assert.strictEqual(
        CHROME.en[key as ChromeKey],
        en,
        `${key} has drifted between the card and the QuickPick (en)`,
      );
      assert.strictEqual(
        CHROME.zh[key as ChromeKey],
        zh,
        `${key} has drifted between the card and the QuickPick (zh)`,
      );
    }
  });
});
