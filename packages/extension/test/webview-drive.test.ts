/**
 * T2 (ADR 0043): drive the real webview and measure what the layout engine did.
 *
 * **This file exists to retire tooling-gap reasons, not to add coverage.**
 * [ADR 0038] §3 ruled that *"jsdom performs no layout"* is a statement about our
 * runner, not about a faculty only a human has — so the three D2 checklist items
 * that carried it were a **finding**, and this is where the finding is closed.
 * What moves here is the *mechanical* half of D2 items 1 and 2: does the row
 * flip and stay flipped, does the write land, do the tiles collapse without
 * clipping, is the switch symmetric. Their **perceptual** halves stay with the
 * operator, without apology — *did it feel instant*, *does an 11px arc read as a
 * ring*, *where should 300px actually be* (ADR 0038 §4).
 *
 * **Everything here runs in the real Electron webview**, which is the whole
 * point: `offsetWidth` is a number and `@container` resolves. Nothing in this
 * file may wait on a wall clock — `afterFrames` is the only timing primitive,
 * because a timing test that passes by waiting long enough measures the CI
 * machine (ADR 0043 §D3).
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type {
  ProbeRect,
  ProbeResult,
  ProbeStep,
} from "../src/webview-protocol";

interface DriveApi {
  revealWebviewForTests(): Promise<void>;
  roundTripForTests(text: string): Promise<string>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
}

async function getApi(): Promise<DriveApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as DriveApi;
}

/** Unwraps one result, failing loudly on the `error` branch. */
function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

/**
 * A box that is actually laid out. A `display: none` control reports 0x0 -- the
 * composer's cost readout does exactly that when nothing has been priced -- and
 * counting it as "squeezed to nothing" would call correct behaviour a defect.
 */
function isRendered(b: ProbeRect): boolean {
  return b.width > 0 || b.height > 0;
}

/**
 * How many visual ROWS a set of boxes occupies.
 *
 * NOT `new Set(tops)`, which was the first thing tried here and is wrong: the
 * strip is `align-items: center`, so a 14px ring and a 30px button on the SAME
 * row have different `top`s by construction, and counting distinct tops
 * reported six rows for one. Two boxes share a row when their vertical ranges
 * overlap, so the rows are the disjoint vertical bands.
 */
function rowBands(boxes: ProbeRect[]): number {
  const live = boxes.filter(isRendered).sort((a, b) => a.top - b.top);
  let bands = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const b of live) {
    if (b.top >= end) bands += 1;
    end = Math.max(end, b.bottom);
  }
  return bands;
}

/** How many tracks a resolved `grid-template-columns` describes. */
function trackCount(computed: string): number {
  return computed.trim().split(/\s+/).filter(Boolean).length;
}

/** Sets the query container's width and reports the grid's resolved tracks. */
async function atWidth(
  api: DriveApi,
  px: number,
): Promise<{ tracks: string; count: number }> {
  const [, tracks] = await api.probeWebviewForTests([
    { verb: "setWidth", selector: ".lm-app", px },
    { verb: "computed", selector: ".lm-grid", name: "grid-template-columns" },
  ]);
  const resolved = val<string>(tracks, `grid-template-columns at ${px}px`);
  return { tracks: resolved, count: trackCount(resolved) };
}

suite(
  "T2 (ADR 0043): the panel at two widths — D2 item 2, mechanically",
  function () {
    this.timeout(60000);

    suiteSetup(async () => {
      const api = await getApi();
      await api.revealWebviewForTests();
    });

    suiteTeardown(async () => {
      // The width is an override on a live view other suites share. Clearing it
      // is not politeness: `.vscode-test` reuses one window, and a 280px panel
      // left behind would silently change what a later suite measures.
      const api = await getApi();
      await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 0 },
      ]);
    });

    test("the channel answers before anything else is claimed of it", async () => {
      // ADR 0043 §D6. A probe arrives over the very channel it measures, so a
      // failure could mean the plumbing is dead OR the DOM is wrong. The echo
      // round trip is the channel's own, older evidence — asserted first, so
      // every later failure in this file has exactly one meaning.
      const api = await getApi();
      assert.strictEqual(
        await api.roundTripForTests("t2"),
        "t2 (from webview)",
      );
    });

    test("the query container is real, and forcing its width resolves @container", async () => {
      // The claim scope (b) turns on, and BLOCKED trigger 1 in the plan: if
      // `.lm-app` is not the query container at run time, or the width cannot be
      // forced through CSSOM under the CSP, then D2 item 2's mechanical half
      // cannot move to `offline` and that is a design finding, not something to
      // approximate in jsdom.
      const api = await getApi();
      const [, containerType, rect] = await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 280 },
        { verb: "computed", selector: ".lm-app", name: "container-type" },
        { verb: "rect", selector: ".lm-app" },
      ]);
      assert.strictEqual(
        val<string>(containerType, "container-type"),
        "inline-size",
        ".lm-app is not the query container the stylesheet says it is",
      );
      const box = val<ProbeRect>(rect, ".lm-app rect");
      assert.strictEqual(
        Math.round(box.width),
        280,
        "CSSOM did not take: the CSP may be blocking the width",
      );
      // The fact that makes this file necessary, asserted rather than asserted in
      // prose: jsdom reports 0 here, so this number IS the tooling gap closing.
      assert.ok(
        box.height > 0,
        "a real layout engine gives the panel a height",
      );
    });

    test("below the breakpoint the tiles collapse to ONE column", async () => {
      const api = await getApi();
      const narrow = await atWidth(api, 280);
      assert.strictEqual(
        narrow.count,
        1,
        `expected one track under @container (max-width: 300px), got "${narrow.tracks}"`,
      );
    });

    test("above the breakpoint they are TWO, and the two widths differ", async () => {
      // The guard against passing for the wrong reason. If `setWidth` silently
      // did nothing, both measurements would be identical and the one-column
      // assertion above would be measuring the panel's natural width, not the
      // breakpoint. Different values are what prove the query resolved.
      const api = await getApi();
      const narrow = await atWidth(api, 280);
      const wide = await atWidth(api, 420);
      assert.strictEqual(
        wide.count,
        2,
        `expected two tracks above the breakpoint, got "${wide.tracks}"`,
      );
      assert.notStrictEqual(
        narrow.tracks,
        wide.tracks,
        "both widths resolved identically — the container query never fired",
      );
    });

    test("the switch is symmetric: 280 → 420 → 280 lands back on one column", async () => {
      // The mechanical half of the operator's step 8, which asked whether the
      // switch happens at the same place in both directions. WHERE it should
      // happen stays their judgment (D2's Judge question 1); THAT it happens
      // reversibly is arithmetic, and arithmetic is not a human's job.
      const api = await getApi();
      assert.strictEqual((await atWidth(api, 280)).count, 1);
      assert.strictEqual((await atWidth(api, 420)).count, 2);
      assert.strictEqual((await atWidth(api, 280)).count, 1);
    });

    test("no tile is clipped at either width, and nothing scrolls sideways", async () => {
      // D2's reported symptom in its own words: "narrowing the sidebar clipped
      // the right-hand quick-action tiles". A tile whose right edge is outside
      // the container's is the clip; a sideways scrollbar is how a user notices.
      //
      // `overflows` is pointed at `.lm-content`, NOT at `.lm-app`, and the
      // difference is load-bearing rather than fussy: `.lm-app` is
      // `overflow: visible`, so its `scrollWidth` reports LAYOUT overflow and
      // rounds to whole pixels -- a child ending at 280.03 makes it 281 against
      // a clientWidth of 280, which is a sub-pixel artefact and not a scrollbar.
      // `.lm-content` is the element that can actually scroll (`overflow-y:
      // auto`), so it is the one whose answer means what the item claims.
      const api = await getApi();
      for (const px of [280, 420]) {
        const [, app, tiles, overflow] = await api.probeWebviewForTests([
          { verb: "setWidth", selector: ".lm-app", px },
          { verb: "rect", selector: ".lm-app" },
          { verb: "rects", selector: ".lm-grid > .lm-tile" },
          { verb: "overflows", selector: ".lm-content" },
        ]);
        const box = val<ProbeRect>(app, `.lm-app at ${px}`);
        const boxes = val<ProbeRect[]>(tiles, `tiles at ${px}`);
        assert.strictEqual(
          boxes.length,
          8,
          `the grid interleaves 5 live + 3 shell tiles; got ${boxes.length} at ${px}px`,
        );
        for (const [i, t] of boxes.entries()) {
          assert.ok(
            t.right <= box.right + 0.5,
            `tile ${i} is clipped at ${px}px: right ${t.right} > panel ${box.right}`,
          );
          assert.ok(t.width > 0, `tile ${i} has no width at ${px}px`);
        }
        assert.strictEqual(
          val<boolean>(overflow, `overflow at ${px}`),
          false,
          `the scroll region scrolls horizontally at ${px}px`,
        );
      }
    });

    test("narrow, the composer's control strip WRAPS rather than crowding", async () => {
      // The second half of D2's step 6. `flex-wrap: wrap` is the mechanism the
      // stylesheet declares; occupying more than one row is the mechanism having
      // worked, and it is exactly what a source-level assertion cannot tell you.
      const api = await getApi();
      const [, wrap, kids] = await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 280 },
        { verb: "computed", selector: ".lm-composer__row", name: "flex-wrap" },
        { verb: "rects", selector: ".lm-composer__row > *" },
      ]);
      assert.strictEqual(val<string>(wrap, "flex-wrap"), "wrap");
      const boxes = val<ProbeRect[]>(kids, "control-strip children");
      assert.ok(boxes.length > 1, "the control strip has no controls to wrap");
      assert.ok(
        rowBands(boxes) > 1,
        `the strip stayed on one row at 280px (${boxes.length} controls) - it is crowding, not wrapping`,
      );
      // "None is squeezed" is a claim about controls that are SUPPOSED to be
      // visible. A hidden one (0x0) is correct behaviour, so the squeeze test
      // is: nothing that has height has lost its width.
      for (const [i, b] of boxes.entries()) {
        if (!isRendered(b)) continue;
        assert.ok(
          b.width > 0,
          `control ${i} was squeezed to nothing (height ${b.height})`,
        );
      }
    });

    test("wide, the control strip is back on a single row", async () => {
      const api = await getApi();
      const [, kids] = await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 420 },
        { verb: "rects", selector: ".lm-composer__row > *" },
      ]);
      const boxes = val<ProbeRect[]>(kids, "control-strip children");
      assert.strictEqual(
        rowBands(boxes),
        1,
        "the strip is still wrapped above the breakpoint",
      );
    });
  },
);
