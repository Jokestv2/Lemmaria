import { describe, expect, it } from "vitest";
import type { WebviewToHost } from "../src/webview-protocol.js";
import {
  type ImageInputModel,
  imageInputControl,
  imageInputValueOf,
} from "../src/webview/parts/model-image-input.js";
import { STR } from "../src/webview/parts/strings.js";

const model = (over: Partial<ImageInputModel> = {}): ImageInputModel => ({
  id: "m1",
  imageInputDefault: false,
  ...over,
});

function render(
  m: ImageInputModel,
  locale: "en" | "zh" = "en",
): { root: HTMLElement; select: HTMLSelectElement; posted: WebviewToHost[] } {
  const posted: WebviewToHost[] = [];
  const root = imageInputControl(locale, m, (msg) => posted.push(msg));
  const select = root.querySelector("select") as HTMLSelectElement;
  return { root, select, posted };
}

describe("imageInputValueOf — absent is auto (V3, ADR 0080 §6)", () => {
  it("maps the three stored states", () => {
    expect(imageInputValueOf(model())).toBe("auto");
    expect(imageInputValueOf(model({ imageInput: true }))).toBe("yes");
    expect(imageInputValueOf(model({ imageInput: false }))).toBe("no");
  });
});

describe("imageInputControl — three options, auto showing its answer", () => {
  it("renders exactly three options, in order", () => {
    const { select } = render(model());
    expect([...select.options].map((o) => o.value)).toEqual([
      "auto",
      "yes",
      "no",
    ]);
  });

  it("the auto label reads (yes) or (no) from the host-computed default", () => {
    // The whole point: a bare "auto" would leave the user guessing whether
    // their endpoint is one the table knows, which is the question the
    // override exists to answer.
    expect(
      render(model({ imageInputDefault: true })).select.options[0]?.text,
    ).toBe(STR.en.mImageAutoYes);
    expect(
      render(model({ imageInputDefault: false })).select.options[0]?.text,
    ).toBe(STR.en.mImageAutoNo);
  });

  it("selects the STORED value, not the default", () => {
    // A model the table says yes to, overridden to no, must show `no`.
    const { select } = render(
      model({ imageInputDefault: true, imageInput: false }),
    );
    expect(select.value).toBe("no");
    expect(render(model({ imageInputDefault: false })).select.value).toBe(
      "auto",
    );
    expect(
      render(model({ imageInputDefault: false, imageInput: true })).select
        .value,
    ).toBe("yes");
  });

  it("carries the label, in the reader's language", () => {
    expect(render(model()).root.textContent).toContain(STR.en.mImageInput);
    expect(render(model(), "zh").root.textContent).toContain(
      STR.zh.mImageInput,
    );
  });

  it("the zh control uses the zh option labels throughout", () => {
    const { select } = render(model({ imageInputDefault: true }), "zh");
    expect([...select.options].map((o) => o.text)).toEqual([
      STR.zh.mImageAutoYes,
      STR.zh.mImageYes,
      STR.zh.mImageNo,
    ]);
  });
});

describe("imageInputControl — what it posts", () => {
  it("posts setModelImageInput with the chosen value on change", () => {
    for (const value of ["yes", "no", "auto"] as const) {
      const { select, posted } = render(model({ id: "m7" }));
      select.value = value;
      select.dispatchEvent(new Event("change"));
      expect(posted).toEqual([{ type: "setModelImageInput", id: "m7", value }]);
    }
  });

  it("posts nothing until the value changes", () => {
    const { posted } = render(model());
    expect(posted).toEqual([]);
  });

  it("posts the ROW's id, so two rows cannot cross", () => {
    const a = render(model({ id: "a" }));
    const b = render(model({ id: "b" }));
    b.select.value = "yes";
    b.select.dispatchEvent(new Event("change"));
    expect(a.posted).toEqual([]);
    expect(b.posted[0]).toMatchObject({ id: "b" });
  });
});
