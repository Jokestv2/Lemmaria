/**
 * E2 (ADR 0049) — the composer command menu, driven in the REAL webview.
 *
 * What only this suite can prove: that the pure modules are actually WIRED.
 * `completion.ts` and `menu.ts` are asserted under jsdom, but the lines in
 * `main.ts` that call them are not (D2's standing limit, ADR 0037 §3) — and
 * `main.ts` is where a menu that never opens, an Enter that sends instead of
 * accepting, or an Esc that clears the draft would live.
 *
 * T2's drive-and-measure seam (ADR 0043) is what makes these rows *offline*
 * rather than items on the operator's list: the `input` and `key` verbs drive a
 * real Chromium keydown, and `value` reads the textarea back. The one thing the
 * seam cannot supply is `isComposing` — a synthetic KeyboardEvent has no way to
 * carry it — which is why exactly one row of this milestone's tier table is an
 * *eyes* item, and why it is that one.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type {
  ProbeRect,
  ProbeResult,
  ProbeStep,
} from "../src/webview-protocol";

const INPUT = ".lm-input";
const MENU = ".lm-menu";
const ROW = ".lm-menu__row";
const ON = ".lm-menu__row--on";

interface MenuApi {
  revealWebviewForTests(): Promise<void>;
  roundTripForTests(text: string): Promise<string>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
}

async function getApi(): Promise<MenuApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as MenuApi;
}

/** Unwraps one result, failing loudly on the `error` branch. */
function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

/** Types `text` into the composer and reports what the menu became. */
async function type(
  api: MenuApi,
  text: string,
): Promise<{ open: boolean; rows: number }> {
  const [, open, rows] = await api.probeWebviewForTests([
    { verb: "input", selector: INPUT, text },
    { verb: "exists", selector: MENU },
    { verb: "count", selector: ROW },
  ]);
  return {
    open: val<boolean>(open, "menu exists"),
    rows: val<number>(rows, "row count"),
  };
}

/** Leaves the composer empty and the menu closed, whatever a test did. */
async function clear(api: MenuApi): Promise<void> {
  await api.probeWebviewForTests([
    { verb: "input", selector: INPUT, text: "" },
  ]);
}

suite(
  "E2 (ADR 0049): the composer command menu, in the real webview",
  function () {
    this.timeout(60000);

    suiteSetup(async () => {
      const api = await getApi();
      await api.revealWebviewForTests();
    });

    suiteTeardown(async () => {
      // One window is shared by the whole run: a forced width and a half-typed
      // draft would both silently change what a later suite measures.
      const api = await getApi();
      await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "" },
        { verb: "setWidth", selector: ".lm-app", px: 0 },
      ]);
    });

    test("the channel answers before anything else is claimed of it", async () => {
      // ADR 0043 §D6: a probe arrives over the very channel it measures, so a
      // failure could mean the plumbing is dead OR the DOM is wrong. Asserting
      // the older echo round trip first gives every later failure in this file
      // exactly one meaning.
      const api = await getApi();
      assert.strictEqual(
        await api.roundTripForTests("e2"),
        "e2 (from webview)",
      );
    });

    test("no menu exists until a `/` is typed", async () => {
      const api = await getApi();
      await clear(api);
      assert.strictEqual((await type(api, "hello")).open, false);
      assert.strictEqual((await type(api, "")).open, false);
    });

    test("a bare `/` opens the menu with every verb on it", async () => {
      // Design §2: both sigils open on an empty query. Codex's file search
      // declines to; Lemmaria opens, because E3's ＋ button IS an empty-query
      // menu and one that rendered nothing would read as broken.
      const api = await getApi();
      await clear(api);
      const { open, rows } = await type(api, "/");
      assert.strictEqual(open, true);
      assert.ok(rows >= 3, `expected at least the three verbs, saw ${rows}`);
    });

    test("typing narrows it, and the match is bolded in the DOM", async () => {
      const api = await getApi();
      await clear(api);
      const [, rows, marks, name] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/comp" },
        { verb: "count", selector: ROW },
        { verb: "count", selector: ".lm-menu__match" },
        { verb: "text", selector: `${ROW} .lm-menu__name` },
      ]);
      assert.strictEqual(val<number>(rows, "rows"), 1);
      assert.strictEqual(val<string>(name, "name"), "/compact");
      // §7: the highlight is DOM, built node by node — the CSP has no
      // 'unsafe-inline' and `check-webview-innerhtml` has no allowlist. One
      // contiguous run of four characters is one element.
      assert.strictEqual(val<number>(marks, "marks"), 1);
    });

    test("a slash that matches nothing says so, rather than showing an empty box", async () => {
      const api = await getApi();
      await clear(api);
      const [, empty, rows] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/zzzzz" },
        { verb: "exists", selector: ".lm-menu__empty" },
        { verb: "count", selector: ROW },
      ]);
      assert.strictEqual(val<boolean>(empty, "empty state"), true);
      assert.strictEqual(val<number>(rows, "rows"), 0);
      await clear(api);
    });

    test("Enter over an EMPTY menu is not eaten — an unknown verb is prose", async () => {
      // Design §3: an unrecognised `/verb` is sent as typed. A menu that
      // consumed Enter merely because it happened to be open would make an
      // unmatched slash unsendable, which is worse than offering no menu.
      const api = await getApi();
      await clear(api);
      const [, empty, , after] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/zzzzz" },
        { verb: "exists", selector: ".lm-menu__empty" },
        { verb: "key", selector: INPUT, key: "Enter" },
        { verb: "value", selector: INPUT },
      ]);
      assert.strictEqual(val<boolean>(empty, "empty state"), true);
      // `defaultPrevented` is true on both branches — `shouldSubmit` prevents
      // too — so the evidence is the composer, which a send CLEARS and an
      // accept would have rewritten.
      assert.strictEqual(val<string>(after, "composer after Enter"), "");
    });

    test("↓ moves the highlight, and ↑ from the top wraps", async () => {
      const api = await getApi();
      await clear(api);
      const [, first, , second] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/" },
        { verb: "text", selector: `${ON} .lm-menu__name` },
        { verb: "key", selector: INPUT, key: "ArrowDown" },
        { verb: "text", selector: `${ON} .lm-menu__name` },
      ]);
      assert.strictEqual(val<string>(first, "first"), "/new");
      assert.strictEqual(val<string>(second, "second"), "/compact");

      const [, onCount, , wrapped] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/" },
        { verb: "count", selector: ON },
        { verb: "key", selector: INPUT, key: "ArrowUp" },
        { verb: "text", selector: `${ON} .lm-menu__name` },
      ]);
      // Exactly one row is ever highlighted — a second would mean the class is
      // being added without the previous render's being dropped.
      assert.strictEqual(val<number>(onCount, "highlighted rows"), 1);
      assert.notStrictEqual(val<string>(wrapped, "wrapped"), "/new");
      await clear(api);
    });

    test("Enter ACCEPTS the highlighted insert row instead of sending", async () => {
      // The behaviour D2 shipped wrong once, in the one place E2 touches a
      // convention the operator has already signed off (CHAT-1). Driven rather
      // than argued: a real keydown in the real webview, and the textarea read
      // back — a send would have emptied it.
      const api = await getApi();
      await clear(api);
      const { rows } = await type(api, "/skill:");
      assert.ok(
        rows > 0,
        "no skill rows: the bundled catalogue should always supply some",
      );
      const [, , after, stillOpen] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/skill:" },
        { verb: "key", selector: INPUT, key: "Enter" },
        { verb: "value", selector: INPUT },
        { verb: "exists", selector: MENU },
      ]);
      const text = val<string>(after, "composer");
      // The acceptance criterion at the surface: what the menu produced is a
      // string `INVOCATION_RE` accepts.
      assert.match(
        text,
        /^\/skill:[a-z0-9]+(?:-[a-z0-9]+)* $/,
        `expected an invocable prefix, got ${JSON.stringify(text)}`,
      );
      // §3's trailing space put the caret past the token, which is what closes
      // the menu — no separate dismissal, and no state to get out of step.
      assert.strictEqual(val<boolean>(stillOpen, "menu still open"), false);
      await clear(api);
    });

    test("Tab accepts too, the alias all three references carry", async () => {
      const api = await getApi();
      await clear(api);
      const [, , after] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/skill:" },
        { verb: "key", selector: INPUT, key: "Tab" },
        { verb: "value", selector: INPUT },
      ]);
      assert.match(val<string>(after, "composer"), /^\/skill:\S+ $/);
      await clear(api);
    });

    test("accepting a COMMAND row empties the composer and closes the menu", async () => {
      // The other accept kind, driven end to end. `/compact` is the safe verb
      // to drive here: with no active session the host refuses it, so the test
      // exercises the composer side without leaving a session behind in a host
      // every other suite shares.
      //
      // The composer ends EMPTY because the token is the whole draft — which is
      // the ordinary case, and the one design §3 was written for. When a draft
      // sits behind the verb the token alone is removed; that branch needs the
      // caret placed inside the token, which the probe's closed verb set cannot
      // do, so it is pinned on `removeToken` in `test-webview/completion.test.ts`.
      const api = await getApi();
      await clear(api);
      const [, , after, stillOpen] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/comp" },
        { verb: "key", selector: INPUT, key: "Enter" },
        { verb: "value", selector: INPUT },
        { verb: "exists", selector: MENU },
      ]);
      assert.strictEqual(val<string>(after, "composer"), "");
      assert.strictEqual(val<boolean>(stillOpen, "menu still open"), false);
      await clear(api);
    });

    test("Esc closes the menu and LEAVES the draft", async () => {
      const api = await getApi();
      await clear(api);
      const [, , open, text] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "/comp" },
        { verb: "key", selector: INPUT, key: "Escape" },
        { verb: "exists", selector: MENU },
        { verb: "value", selector: INPUT },
      ]);
      assert.strictEqual(val<boolean>(open, "menu open"), false);
      // Clearing the composer is the one Esc behaviour a user might expect and
      // would be a data loss.
      assert.strictEqual(val<string>(text, "draft"), "/comp");
      await clear(api);
    });

    test("with no menu open, Enter still sends — CHAT-1 is untouched", async () => {
      // The thread gate's third claim, driven rather than inferred from the
      // fact that `keys.test.ts` still passes.
      const api = await getApi();
      await clear(api);
      const [, open, , after] = await api.probeWebviewForTests([
        { verb: "input", selector: INPUT, text: "ordinary prose" },
        { verb: "exists", selector: MENU },
        { verb: "key", selector: INPUT, key: "Enter" },
        { verb: "value", selector: INPUT },
      ]);
      assert.strictEqual(val<boolean>(open, "menu open"), false);
      assert.strictEqual(val<string>(after, "composer after send"), "");
    });

    test("a `/` MID-MESSAGE opens the menu (ADR 0050)", async () => {
      // The engine-grammar rule, at the surface, and it INVERTED at ADR 0050:
      // this suite used to drive `please /new` and assert the menu stayed
      // shut. `skill-invocation.ts`'s regex moved to the same whitespace-
      // delimited rule in the same commit, so the menu offering a token here
      // can no longer insert a string the harness treats as prose.
      const api = await getApi();
      await clear(api);
      assert.strictEqual((await type(api, "please /new")).open, true);
      assert.strictEqual((await type(api, " /new")).open, true);
      await clear(api);
    });

    test("a `/` INSIDE a word still opens nothing — a URL is not an invocation", async () => {
      // The half that did NOT move, and the one that keeps decision 1 true:
      // the token is bounded at both ends, in the menu and in the regex alike.
      const api = await getApi();
      await clear(api);
      assert.strictEqual((await type(api, "http://x/new")).open, false);
      assert.strictEqual((await type(api, "and/new")).open, false);
      await clear(api);
    });

    test("the menu stays inside the panel at 280px and at 420px, in both axes", async () => {
      // Real geometry in the real webview, which is what keeps this row OFF
      // the operator's list: `setWidth` writes through CSSOM, so `@container`
      // resolves for real. What a human still adds is whether the result is
      // LEGIBLE — the tier table's second eyes row, and only that.
      const api = await getApi();
      await clear(api);
      //
      // `overflows` is pointed at `.lm-content` and at the menu itself, NEVER
      // at `.lm-app`, and that is load-bearing rather than fussy — it is the
      // trap T2 documented on the verb and this milestone walked into anyway.
      // `.lm-app` is `overflow: visible`, so its `scrollWidth` reports LAYOUT
      // overflow rounded to whole pixels: a child ending at 280.03 answers
      // `true` against a 280 client width with no scrollbar anywhere. The
      // elements that can actually scroll are the ones whose answer means what
      // the claim says.
      for (const px of [280, 420]) {
        const [, , menu, app, contentScrolls, menuScrolls] =
          await api.probeWebviewForTests([
            { verb: "setWidth", selector: ".lm-app", px },
            { verb: "input", selector: INPUT, text: "/" },
            { verb: "rect", selector: MENU },
            { verb: "rect", selector: ".lm-app" },
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
        assert.strictEqual(
          val<boolean>(contentScrolls, `content overflow at ${px}`),
          false,
          `the transcript scrolls sideways with the menu open at ${px}px`,
        );
        assert.strictEqual(
          val<boolean>(menuScrolls, `menu overflow at ${px}`),
          false,
          `the menu itself scrolls sideways at ${px}px — a row is too wide`,
        );
        // VERTICAL containment, added at E2's code review: the horizontal
        // assertions above say nothing about a menu that rises out of the
        // composer with `bottom: 100%` and runs off the TOP of a short panel.
        // Its `max-height` (268px) and the panel's height are set independently
        // — nothing couples them — so this is a real geometry claim and not a
        // restatement. It is measurable, which is why it is here and not on the
        // operator's list: the *eyes* row covers whether the menu READS well
        // over the transcript, not whether it fits.
        assert.ok(
          box.top >= panel.top - 1,
          `the menu is clipped by the top of the panel at ${px}px: ${JSON.stringify(box)} vs ${JSON.stringify(panel)}`,
        );
      }
      await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 0 },
      ]);
      await clear(api);
    });

    test("it shows at most MAX_ROWS rows however many candidates there are", async () => {
      // The bound is `visibleRows()`, asserted under jsdom; this asserts the
      // WIRING honours it, which is the half a pure test cannot see.
      const api = await getApi();
      await clear(api);
      const { rows } = await type(api, "/");
      assert.ok(rows <= 8, `expected at most 8 visible rows, saw ${rows}`);
      await clear(api);
    });
  },
);
