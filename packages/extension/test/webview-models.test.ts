/**
 * V3's E1 round (2026-09-22): a model row's lines, measured in the REAL webview.
 *
 * The defect was layout. `.lm-mrow__setkey` and `.m-image-input-row` ask for a
 * line of their own with `flex-basis: 100%`, but `.lm-mrow` did not wrap, so
 * both were squeezed into the row's one line: `.lm-mrow__body` (the provider
 * name and the model id) got 0px at every width, the provider name overprinted
 * the status, the key field was a sliver, and the select stuck out past the
 * card. Wrapping alone is not the whole fix: the key field is `width: 100%`,
 * so `Set key` still broke over two lines at 280px AND at 420px until the
 * button was taken out of the shrink (measured here: 42px tall at 13px).
 * The operator's round found it on screen; `styles.test.ts` now pins the
 * declaration, and this suite pins what the layout engine does with it — the
 * mechanical half of E1 (ADR 0043), which leaves the operator only whether the
 * row READS as one row.
 *
 * Two rows, because the two arms differ: a keyless row renders the inline key
 * field and `Set key`, a keyed row does not. No wall-clock waits: DOM facts are
 * awaited by probing until they hold.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ModelStore } from "../src/model-store";
import type {
  ProbeRect,
  ProbeResult,
  ProbeStep,
  WebviewToHost,
} from "../src/webview-protocol";

interface ModelsDriveApi {
  revealWebviewForTests(): Promise<void>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  modelStoreForTests(): ModelStore | undefined;
  clearModelsForTests(): Promise<void>;
}

async function getApi(): Promise<ModelsDriveApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as ModelsDriveApi;
}

function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

/** Probe until the DOM says what the caller is waiting for (the
 *  `webview-review.test.ts` shape), so no fixed sleep stands in for a render. */
async function probeUntil(
  api: ModelsDriveApi,
  steps: ProbeStep[],
  ready: (results: ProbeResult[]) => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<ProbeResult[]> {
  const start = Date.now();
  let last = await api.probeWebviewForTests(steps);
  while (!ready(last)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `timed out waiting for ${label}; last: ${JSON.stringify(last)}`,
      );
    await new Promise((r) => setTimeout(r, 25));
    last = await api.probeWebviewForTests(steps);
  }
  return last;
}

/** Sub-pixel slack: boxes on consecutive lines can share a fractional edge. */
const SLACK = 0.5;

/** Whether `box` sits inside `row`'s vertical band — how a key-controls line,
 *  which only the keyless row has, is matched to its row without trusting an
 *  index. */
const within = (box: ProbeRect, row: ProbeRect): boolean =>
  box.top >= row.top - SLACK && box.bottom <= row.bottom + SLACK;

const PARTS: ProbeStep[] = [
  { verb: "rects", selector: ".lm-mrow" },
  { verb: "rects", selector: ".lm-mrow__body" },
  { verb: "rects", selector: ".m-image-input-row" },
  { verb: "rects", selector: ".m-image-input-label" },
  { verb: "rects", selector: ".m-image-input" },
  { verb: "rects", selector: ".lm-mrow__setkey" },
  { verb: "rects", selector: ".lm-mrow__setkey .lm-mform__input" },
  { verb: "rects", selector: ".lm-mrow__setkey .lm-mform__save" },
  { verb: "overflows", selector: ".lm-content" },
  {
    verb: "computed",
    selector: ".lm-mrow__setkey .lm-mform__save",
    name: "font-size",
  },
  {
    verb: "computed",
    selector: ".lm-mrow__setkey .lm-mform__save",
    name: "padding-top",
  },
  {
    verb: "computed",
    selector: ".lm-mrow__setkey .lm-mform__save",
    name: "padding-bottom",
  },
];

suite(
  "V3 E1 round: a model row's lines are lines of their own, in the real webview",
  function () {
    this.timeout(60000);

    suiteSetup(async () => {
      const api = await getApi();
      await api.revealWebviewForTests();
      await api.clearModelsForTests();
      const store = api.modelStoreForTests();
      assert.ok(store, "no model store");
      // E1's two rows: a keyless `gpt-4o`, the crowded arm, and a keyed
      // unknown id. The key is only stored; nothing is sent anywhere.
      const endpoint = "https://api.openai.com/v1";
      await store.add(
        {
          provider: "openai",
          protocol: "openai-compatible",
          endpoint,
          model: "gpt-4o",
        },
        "",
      );
      await store.add(
        {
          provider: "openai",
          protocol: "openai-compatible",
          endpoint,
          model: "qwen-max",
        },
        "sk-e1",
      );
      // The tab button is how a reader gets there; the explicit request covers
      // a view an earlier suite already left on the Models tab, where the
      // click is a no-op and would push nothing.
      await api.probeWebviewForTests([
        { verb: "click", selector: "#lm-tab-2" },
      ]);
      await api.dispatchWebviewMessageForTests({ type: "requestModels" });
      await probeUntil(
        api,
        [{ verb: "count", selector: ".lm-mrow" }],
        (r) => r[0]?.value === 2,
        "the two model rows",
      );
    });

    suiteTeardown(async () => {
      const api = await getApi();
      // The width and the active tab are both state on a live view the whole
      // ext-host suite shares; later suites measure the Assistant tab.
      await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 0 },
        { verb: "click", selector: "#lm-tab-0" },
      ]);
      await api.clearModelsForTests();
    });

    for (const px of [280, 420]) {
      test(`at ${px}px the name, the key controls and Image input each get a line`, async () => {
        const api = await getApi();
        const [, ...results] = await api.probeWebviewForTests([
          { verb: "setWidth", selector: ".lm-app", px },
          ...PARTS,
        ]);
        const at = `at ${px}px`;
        const rows = val<ProbeRect[]>(results[0], `rows ${at}`);
        const bodies = val<ProbeRect[]>(results[1], `bodies ${at}`);
        const lines = val<ProbeRect[]>(results[2], `Image input lines ${at}`);
        const labels = val<ProbeRect[]>(results[3], `labels ${at}`);
        const selects = val<ProbeRect[]>(results[4], `selects ${at}`);
        const keyLines = val<ProbeRect[]>(results[5], `key lines ${at}`);
        const keyFields = val<ProbeRect[]>(results[6], `key fields ${at}`);
        const keyButtons = val<ProbeRect[]>(results[7], `Set key ${at}`);
        const overflow = val<boolean>(results[8], `overflow ${at}`);
        const [fontSize, padTop, padBottom] = [9, 10, 11].map((k) =>
          Number.parseFloat(val<string>(results[k], `Set key style ${at}`)),
        ) as [number, number, number];

        assert.strictEqual(rows.length, 2, `two rows ${at}`);
        for (const parts of [bodies, lines, labels, selects])
          assert.strictEqual(parts.length, 2, `one of each per row ${at}`);
        assert.strictEqual(keyLines.length, 1, `only gpt-4o is keyless ${at}`);

        for (const [i, row] of rows.entries()) {
          const body = bodies[i] as ProbeRect;
          const line = lines[i] as ProbeRect;
          const label = labels[i] as ProbeRect;
          const select = selects[i] as ProbeRect;
          // The symptom the round reported first: no model id on any row.
          assert.ok(
            body.width > 0,
            `row ${i} ${at}: the name and model id have no width (${JSON.stringify(body)})`,
          );
          // A line of its own, under the name/model/status line.
          assert.ok(
            line.top >= body.bottom - SLACK,
            `row ${i} ${at}: Image input is on the head line: body ${JSON.stringify(body)}, line ${JSON.stringify(line)}`,
          );
          // Inside the card, not past its right border.
          assert.ok(
            select.right <= row.right + SLACK,
            `row ${i} ${at}: the select sticks out of the row: ${select.right} > ${row.right}`,
          );
          // One line: a wrapped label is taller than the select beside it.
          assert.ok(
            label.height <= select.height + SLACK,
            `row ${i} ${at}: the Image input label wrapped (${label.height} > ${select.height})`,
          );
        }

        // The keyless row's key controls: under the head line, above Image
        // input, the field wider than the button, the button on one line.
        const keyLine = keyLines[0] as ProbeRect;
        const owner = rows.findIndex((r) => within(keyLine, r));
        assert.ok(owner >= 0, `the key controls sit in no row ${at}`);
        const ownerBody = bodies[owner] as ProbeRect;
        const ownerLine = lines[owner] as ProbeRect;
        assert.ok(
          keyLine.top >= ownerBody.bottom - SLACK,
          `${at}: the key controls are on the head line`,
        );
        assert.ok(
          ownerLine.top >= keyLine.bottom - SLACK,
          `${at}: Image input is not under the key controls`,
        );
        assert.ok(
          keyLine.right <= (rows[owner] as ProbeRect).right + SLACK,
          `${at}: the key controls stick out of the row`,
        );
        const field = keyFields[0] as ProbeRect;
        const button = keyButtons[0] as ProbeRect;
        assert.ok(
          field.width > button.width,
          `${at}: the key field is a sliver (${field.width} vs Set key ${button.width})`,
        );
        // One line, measured against the button's OWN font rather than the
        // field beside it: `.lm-mrow__setkey` stretches its items, so a
        // wrapped button takes the field to the same height and a comparison
        // between the two can never fail. A line box is at least 1em tall, so
        // two lines never fit under this bound, and one always does.
        assert.ok(
          button.height < padTop + padBottom + 2 * fontSize,
          `${at}: Set key wrapped (${button.height}px tall at ${fontSize}px)`,
        );

        assert.strictEqual(
          overflow,
          false,
          `${at}: the Models tab scrolls sideways`,
        );
      });
    }
  },
);
