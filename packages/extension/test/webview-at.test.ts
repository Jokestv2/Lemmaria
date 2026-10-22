/**
 * E3 (ADR 0052) — `@` context references, driven in the REAL webview.
 *
 * What only this suite can prove: that the candidate source is actually WIRED,
 * end to end, through the host's own walks. `context-paths.ts` is asserted under
 * jsdom over a walk result someone handed it; nothing there can see whether the
 * host really calls `walkGrantedRoot`, whether a grant added at runtime reaches
 * the menu, or whether a hundred-character path fits a 280 px sidebar.
 *
 * **The grant is the candidate source here, and that is not a workaround.** The
 * ext-host run opens no workspace folder (`.vscode-test.mjs` passes none), so
 * there is no paper in context and the workspace half of the set is empty by
 * construction — which is itself one of the claims below. What is left is
 * exactly the shape the v0.2.3 stage gate's claim 2 asks for: assert with zero
 * grants, then with one added, then with it revoked, so the set is shown to
 * MOVE rather than merely to be non-empty.
 */
import * as assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import type {
  ProbeRect,
  ProbeResult,
  ProbeStep,
} from "../src/webview-protocol";

const INPUT = ".lm-input";
const MENU = ".lm-menu";
const ROW = ".lm-menu__row";
const PATH_ROW = ".lm-menu__row--path";
const NAME = ".lm-menu__name";
const NOTE = ".lm-menu__note";
const ADD_CTX = ".lm-addctx";

/** Long on purpose: the 280 px geometry claim is only real over a real path. */
const DEEP_DIR = join(
  "a-very-long-directory-name",
  "another-quite-long-segment",
);
const DEEP_FILE = join(DEEP_DIR, "final-results-table.csv").replaceAll(
  "\\",
  "/",
);

interface AtApi {
  revealWebviewForTests(): Promise<void>;
  roundTripForTests(text: string): Promise<string>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  addGrantForTests(folderPath: string): Promise<{ id: string; label: string }>;
  revokeGrantForTests(id: string): Promise<boolean>;
  activeSessionGrantsForTests(): { id: string; label: string }[];
}

async function getApi(): Promise<AtApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as AtApi;
}

function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the menu reports what we are waiting for, or give up.
 *
 * The candidate set arrives by a PUSH after an asynchronous walk, so there is a
 * beat between granting a folder and the menu knowing about it. Polling a
 * condition is the honest way to wait for that; sleeping a fixed time would
 * measure the machine (the rule `webview-menu.test.ts` states on `afterFrames`).
 */
async function untilRows(
  api: AtApi,
  text: string,
  want: (rows: number) => boolean,
  ms = 8000,
): Promise<number> {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < ms) {
    last = await rowCount(api, text);
    if (want(last)) return last;
    await delay(50);
  }
  return last;
}

async function rowCount(api: AtApi, text: string): Promise<number> {
  const [, rows] = await api.probeWebviewForTests([
    { verb: "input", selector: INPUT, text },
    { verb: "count", selector: ROW },
  ]);
  return val<number>(rows, "row count");
}

async function clear(api: AtApi): Promise<void> {
  await api.probeWebviewForTests([
    { verb: "input", selector: INPUT, text: "" },
  ]);
}

async function revokeAll(api: AtApi): Promise<void> {
  for (const g of api.activeSessionGrantsForTests()) {
    await api.revokeGrantForTests(g.id);
  }
}

suite("E3 (ADR 0052): `@` references in the real webview", function () {
  this.timeout(60000);

  let dir = "";
  let label = "";

  suiteSetup(async () => {
    const api = await getApi();
    await api.revealWebviewForTests();
    dir = mkdtempSync(join(tmpdir(), "lemmaria-e3-"));
    label = basename(dir);
    mkdirSync(join(dir, DEEP_DIR), { recursive: true });
    writeFileSync(join(dir, DEEP_FILE), "a,b\n1,2\n", "utf8");
    writeFileSync(join(dir, "notes.md"), "# notes\n", "utf8");
    // Proves the GRANTED half of D1's per-root mirror in the real host: this
    // walk applies nested `.gitignore`, where the workspace walk does not.
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "ignored", "secret.txt"), "x\n", "utf8");
    writeFileSync(join(dir, ".gitignore"), "ignored/\n", "utf8");
  });

  suiteTeardown(async () => {
    // One window and one session are shared by the whole run: a forced width, a
    // half-typed draft and a live grant would each silently change what a later
    // suite measures.
    const api = await getApi();
    await revokeAll(api);
    await api.probeWebviewForTests([
      { verb: "input", selector: INPUT, text: "" },
      { verb: "setWidth", selector: ".lm-app", px: 0 },
    ]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the channel answers before anything else is claimed of it", async () => {
    // ADR 0043 §D6, and `webview-menu.test.ts`'s reason: a probe arrives over
    // the very channel it measures, so asserting the older echo round trip
    // first gives every later failure in this file exactly one meaning.
    const api = await getApi();
    assert.strictEqual(await api.roundTripForTests("e3"), "e3 (from webview)");
  });

  test("with NOTHING granted and no paper folder, `@` offers nothing and says so", async () => {
    // Invariant 2's floor, driven. The ext-host run opens no workspace folder,
    // so `paperInContext()` is undefined and the workspace half is absent —
    // which is the mirror `list_files` itself performs, refusing outright
    // rather than falling back to a root the session is not reading.
    const api = await getApi();
    await revokeAll(api);
    await clear(api);
    const rows = await untilRows(api, "@", (n) => n === 0);
    assert.strictEqual(rows, 0, "a menu with no granted root offered rows");
    const [, open, note] = await api.probeWebviewForTests([
      { verb: "input", selector: INPUT, text: "@" },
      { verb: "exists", selector: MENU },
      { verb: "text", selector: NOTE },
    ]);
    // It OPENS — design §2, because the ＋ button is an empty-query `@` and a
    // menu that rendered nothing when you pressed the button built to open it
    // reads as broken.
    assert.strictEqual(val<boolean>(open, "menu exists"), true);
    assert.match(
      val<string>(note, "note"),
      /Nothing to reference/,
      "an empty menu must explain itself rather than say `No match`",
    );
    await clear(api);
  });

  test("granting a folder WIDENS the menu, and revoking it NARROWS it again", async () => {
    // The v0.2.3 stage gate's claim 2, and the reason it is driven in both
    // directions: a set shown only to be non-empty has not been shown to be
    // BOUNDED by the grants. Design §5's stated consequence — `@` gets wider
    // when the user grants a folder and narrower when they revoke one — is what
    // makes the grant chips mean more than they did.
    const api = await getApi();
    await revokeAll(api);
    await clear(api);
    assert.strictEqual(await untilRows(api, "@", (n) => n === 0), 0);

    const grant = await api.addGrantForTests(dir);
    const widened = await untilRows(api, "@", (n) => n > 0);
    assert.ok(widened > 0, "granting a folder did not widen the `@` menu");

    const [, name] = await api.probeWebviewForTests([
      { verb: "input", selector: INPUT, text: "@notes" },
      { verb: "text", selector: `${ROW} ${NAME}` },
    ]);
    // D3: the row NAMES its root, with the grant's own label — the qualifier
    // the capability envelope already declares as `g1: <label> (<path>)`.
    assert.strictEqual(val<string>(name, "row name"), `@${label}/notes.md`);

    // D1's granted half, in the real host: this walk applies nested
    // `.gitignore`, so the ignored file is not on the menu — and it is not
    // there because `walkGrantedRoot` refused it, not because the menu filtered
    // it a second time.
    //
    // Asserted on the menu's LITERAL text, not on the row count for a query.
    // The first version asked `@secret` for zero rows and was flaky ~1 run in
    // 5 — found by repeating `test:ext` at E3's gate rather than by reasoning.
    // `rank` is a subsequence match and `mkdtemp` puts SIX RANDOM CHARACTERS in
    // the grant's label, so whenever that suffix happened to contain an `s` the
    // deep path supplied `e·c·r·e·t` from `very`, `directory`, `name` and
    // `another` and two rows matched a file that was never on the menu. The
    // fuzzy query was measuring the temp-directory name; this measures the
    // claim.
    const [, menuText] = await api.probeWebviewForTests([
      { verb: "input", selector: INPUT, text: "@" },
      { verb: "text", selector: MENU },
    ]);
    const shown = val<string>(menuText, "menu text");
    assert.ok(
      !shown.includes("secret"),
      `a gitignored file reached the menu: ${shown}`,
    );
    // And not vacuously: the menu really is populated with this grant's files.
    assert.ok(shown.includes("notes.md"), `the menu was empty: ${shown}`);

    assert.strictEqual(await api.revokeGrantForTests(grant.id), true);
    assert.strictEqual(
      await untilRows(api, "@", (n) => n === 0),
      0,
      "revoking the grant did not narrow the `@` menu",
    );
    await clear(api);
  });

  test("`a@b` opens nothing — an email address is not a reference", async () => {
    const api = await getApi();
    await clear(api);
    const [, open] = await api.probeWebviewForTests([
      { verb: "input", selector: INPUT, text: "mail a@b" },
      { verb: "exists", selector: MENU },
    ]);
    assert.strictEqual(val<boolean>(open, "menu exists"), false);
    await clear(api);
  });

  suite("with the folder granted", () => {
    let grantId = "";

    suiteSetup(async () => {
      const api = await getApi();
      await revokeAll(api);
      const grant = await api.addGrantForTests(dir);
      grantId = grant.id;
      await untilRows(api, "@", (n) => n > 0);
      await clear(api);
    });

    suiteTeardown(async () => {
      const api = await getApi();
      if (grantId) await api.revokeGrantForTests(grantId);
      await clear(api);
    });

    test("accepting a path row KEEPS the `@`, appends a space, and does not send", async () => {
      // ADR 0053, superseding ADR 0052 D4: the sigil stays, so a reference is
      // visible in the sent message and can be read back out of plain text.
      // A send would have emptied the composer, so reading it back proves both
      // halves at once.
      const api = await getApi();
      await clear(api);
      assert.ok(await untilRows(api, "@final", (n) => n > 0));
      // The row Enter will take is the FIRST one, so that is what is pinned —
      // not the row COUNT. `rank` is a subsequence match, and over paths a
      // hundred characters long a five-character query legitimately matches
      // several: `notes` finds an `n`, an `o`, a `t`, an `e` and an `s`
      // scattered through a long directory name too. The contiguous match
      // scores 0 and every scattered one scores its span, so the intended row
      // is first — which is the property that matters and the one asserted.
      const [, first] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "@final" },
        { verb: "text", selector: `${ROW} ${NAME}` },
      ]);
      assert.strictEqual(
        val<string>(first, "first row"),
        `@${label}/${DEEP_FILE}`,
      );
      const [, , after, stillOpen] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "@final" },
        { verb: "key", selector: INPUT, key: "Enter" },
        { verb: "value", selector: INPUT },
        { verb: "exists", selector: MENU },
      ]);
      assert.strictEqual(
        val<string>(after, "composer"),
        `@${label}/${DEEP_FILE} `,
      );
      // The trailing space put the caret past the token, which is what closes
      // the menu — ADR 0049 decision 4, inherited unchanged.
      assert.strictEqual(val<boolean>(stillOpen, "menu still open"), false);
      await clear(api);
    });

    test("a path row carries the path modifier; a `/` row still does not", async () => {
      // D5's trade, at the surface: only a path row is allowed to truncate,
      // because only a path row has the width to itself.
      const api = await getApi();
      await clear(api);
      await untilRows(api, "@notes", (n) => n > 0);
      const [, rows, paths, descs] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "@notes" },
        { verb: "count", selector: ROW },
        { verb: "count", selector: PATH_ROW },
        { verb: "count", selector: ".lm-menu__desc" },
      ]);
      // EVERY row, not one: the count is a subsequence match's business (see
      // the accept test), while "a path row is marked and carries no
      // description" is a claim about all of them.
      const total = val<number>(rows, "rows");
      assert.ok(total > 0, "no rows to check the modifier on");
      assert.strictEqual(val<number>(paths, "path rows"), total);
      assert.strictEqual(val<number>(descs, "description nodes"), 0);

      const [, slugPaths] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/comp" },
        { verb: "count", selector: PATH_ROW },
      ]);
      assert.strictEqual(val<number>(slugPaths, "path rows on a `/` menu"), 0);
      await clear(api);
    });

    test("the `＋` button opens the `@` menu it has been reserved for since U1", async () => {
      // D8: the button TYPES an `@` rather than opening a menu of its own, so
      // there is one code path and the token still comes from the text.
      const api = await getApi();
      await clear(api);
      const [, , open, text] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "" },
        { verb: "click", selector: ADD_CTX },
        { verb: "exists", selector: MENU },
        { verb: "value", selector: INPUT },
      ]);
      assert.strictEqual(val<boolean>(open, "menu exists"), true);
      assert.strictEqual(val<string>(text, "composer"), "@");
      await clear(api);
    });

    test("the button separates the sigil from a word the caret is inside", async () => {
      // `activeToken` asks whether the whitespace-delimited word the caret is
      // in begins with the sigil, so an `@` appended to `abc` yields the word
      // `abc@` and no menu at all — the same rule that makes `a@b` an email
      // address, applied from the other side.
      const api = await getApi();
      await clear(api);
      const [, , open, text] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "look at" },
        { verb: "click", selector: ADD_CTX },
        { verb: "exists", selector: MENU },
        { verb: "value", selector: INPUT },
      ]);
      assert.strictEqual(val<string>(text, "composer"), "look at @");
      assert.strictEqual(val<boolean>(open, "menu exists"), true);
      await clear(api);
    });

    test("`/` still behaves exactly as E2 shipped it", async () => {
      // The regression that matters most: E3 put a second sigil into the same
      // refresh path, and a mistake there would break the surface the operator
      // has already signed off.
      const api = await getApi();
      await clear(api);
      const [, open, rows, name] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/comp" },
        { verb: "exists", selector: MENU },
        { verb: "count", selector: ROW },
        { verb: "text", selector: `${ROW} ${NAME}` },
      ]);
      assert.strictEqual(val<boolean>(open, "menu exists"), true);
      assert.strictEqual(val<number>(rows, "rows"), 1);
      assert.strictEqual(val<string>(name, "name"), "/compact");
      await clear(api);
    });

    test("a LONG path does not push the menu out of the panel at 280px or 420px", async () => {
      // Row 19, and the one E3 could genuinely have broken: a `/skill:` slug is
      // ~18 characters and never truncates, where the path driven here is over
      // a hundred. `setWidth` writes through CSSOM so the container query
      // resolves for real. What a person still adds is whether an ellipsized
      // path is IDENTIFIABLE — the tier table's second eyes row, and only that.
      const api = await getApi();
      await clear(api);
      for (const px of [280, 420]) {
        // CONTROL first: is `.lm-content` already scrolling sideways at this
        // width with no menu at all? The window is shared by the whole run, so
        // an absolute assertion here could be measuring another suite's
        // transcript rather than this milestone's menu.
        const [, , controlScrolls] = await api.probeWebviewForTests([
          { verb: "setWidth", selector: ".lm-app", px },
          { verb: "input", selector: INPUT, text: "" },
          { verb: "overflows", selector: ".lm-content" },
        ]);
        const [, , menu, app, contentScrolls, menuScrolls] =
          await api.probeWebviewForTests([
            { verb: "setWidth", selector: ".lm-app", px },
            { verb: "input", selector: INPUT, text: "@" },
            { verb: "rect", selector: MENU },
            { verb: "rect", selector: ".lm-app" },
            // Pointed at `.lm-content` and the menu, NEVER at `.lm-app`: that
            // one is `overflow: visible`, so its `scrollWidth` reports layout
            // overflow rounded to whole pixels and answers `true` with no
            // scrollbar anywhere. The trap T2 documented on the verb.
            { verb: "overflows", selector: ".lm-content" },
            { verb: "overflows", selector: MENU },
          ]);
        const box = val<ProbeRect>(menu, `menu rect at ${px}`);
        const panel = val<ProbeRect>(app, `app rect at ${px}`);
        assert.ok(box.height > 0, `the menu is not laid out at ${px}px`);
        assert.ok(
          box.left >= panel.left - 1 && box.right <= panel.right + 1,
          `the menu escapes the panel at ${px}px: ${JSON.stringify(box)} vs ${JSON.stringify(panel)}`,
        );
        // RELATIVE to the control, deliberately, and this is not a weakened
        // claim — it is a better attributed one. The ext-host run shares one
        // window, and `.lm-content` was measured scrolling sideways at 280px
        // with NO menu open at all, from whatever the transcript held by the
        // time this suite ran. An absolute assertion here would have been
        // reporting another suite's content as E3's defect. What E3 owes is
        // that opening the menu does not make it worse, which is exactly this.
        // (`webview-menu.test.ts`'s absolute form stands unchanged, at its own
        // point in the run; the observation is recorded in open-questions.md.)
        assert.strictEqual(
          val<boolean>(contentScrolls, `content overflow at ${px}`),
          val<boolean>(controlScrolls, `control overflow at ${px}`),
          `the path menu CHANGED the transcript's horizontal overflow at ${px}px`,
        );
        assert.strictEqual(
          val<boolean>(menuScrolls, `menu overflow at ${px}`),
          false,
          `the menu itself scrolls sideways at ${px}px — a path is too wide`,
        );
        assert.ok(
          box.top >= panel.top - 1,
          `the menu is clipped by the top of the panel at ${px}px`,
        );
      }
      await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 0 },
      ]);
      await clear(api);
    });
  });
});
