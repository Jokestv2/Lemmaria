import { describe, expect, it } from "vitest";
import {
  MAX_CARD_FILES,
  type RewindConsent,
  type RewindMenuPost,
  openRewindMenu,
} from "../src/webview/parts/rewind-menu.js";

/**
 * E6 (D8, ADR 0058 §4): the ⟲ affordance's three arms, and the consent surface
 * that replaced the OS modal.
 *
 * **Why this is a jsdom test and not an ext-host one.** The modal it supersedes
 * was `vscode.window.showWarningMessage({ modal: true })` — a surface no
 * offline runner can read, which is why E5's gate could assert that consent was
 * *asked for* but never what it *said*. A card built in `parts/` is a detached
 * node: the question, every file path and both buttons are `textContent` here,
 * so invariant 3's "names every file before it writes" is finally an assertion
 * rather than a claim (ADR 0037's standing rule, and the reason the plan's tier
 * table moves rows 8–9 offline).
 */

function anchorInBubble(): HTMLButtonElement {
  const bubble = document.createElement("div");
  bubble.className = "lm-msg lm-msg-user";
  const button = document.createElement("button");
  button.className = "lm-msg-user__restore";
  bubble.append(button);
  document.body.append(bubble);
  return button;
}

/** A menu on a fresh anchor, with everything it posts collected. */
function open(locale: "en" | "zh" = "en") {
  document.body.replaceChildren();
  const posts: RewindMenuPost[] = [];
  const anchor = anchorInBubble();
  const handle = openRewindMenu(anchor, {
    messageId: "m1",
    locale,
    post: (m) => posts.push(m),
  });
  return { anchor, handle, posts };
}

const armTexts = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll("button")).map((b) => b.textContent ?? "");

const lines = (el: HTMLElement, cls: string): string[] =>
  Array.from(el.querySelectorAll(`.${cls}`)).map((n) => n.textContent ?? "");

const esc = (): boolean =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );

const mousedownOn = (node: Node): boolean =>
  node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

describe("the rewind popover — its three arms (D8)", () => {
  it("renders the operator's three arms, in English, as text", () => {
    const { handle } = open("en");
    expect(armTexts(handle.element)).toEqual([
      "Fork conversation from here",
      "Rewind code to here",
      "Fork conversation and rewind code",
    ]);
  });

  it("renders them in Chinese for a Chinese reader, with no English in them", () => {
    const { handle } = open("zh");
    const arms = armTexts(handle.element);
    expect(arms).toEqual([
      "从此处分叉会话",
      "将代码回退到此处",
      "分叉会话并回退代码",
    ]);
    // Invariant 6 rule 2 over what is RENDERED, not merely over the table.
    for (const arm of arms) expect(arm).not.toMatch(/[a-z]/i);
  });

  it("mounts into the bubble, so the menu sits with the message it belongs to", () => {
    const { anchor, handle } = open();
    expect(anchor.parentElement?.contains(handle.element)).toBe(true);
  });

  it("the fork-only arm posts rewindFork and closes at once", () => {
    // It writes no user file, so invariant 3 asks nothing of it: the click IS
    // the action, and a consent card in front of it would be ceremony.
    const { handle, posts } = open();
    (handle.element.querySelectorAll("button")[0] as HTMLElement).click();
    expect(posts).toEqual([{ type: "rewindFork", messageId: "m1" }]);
    expect(handle.element.isConnected).toBe(false);
  });

  it("a restoring arm asks the host for a preview and stays open for the card", () => {
    const { handle, posts } = open();
    (handle.element.querySelectorAll("button")[1] as HTMLElement).click();
    expect(posts).toEqual([
      { type: "rewindPreview", messageId: "m1", withFork: false },
    ]);
    expect(handle.element.isConnected).toBe(true);
  });

  it("the both-arm asks for the same preview, with the fork", () => {
    const { handle, posts } = open();
    (handle.element.querySelectorAll("button")[2] as HTMLElement).click();
    expect(posts).toEqual([
      { type: "rewindPreview", messageId: "m1", withFork: true },
    ]);
  });

  it("refuses a second preview while the first is in flight", () => {
    // Two nonces for one gesture would leave the host holding a pending plan
    // nobody will ever answer.
    const { handle, posts } = open();
    const arms = handle.element.querySelectorAll("button");
    (arms[1] as HTMLElement).click();
    (arms[2] as HTMLElement).click();
    expect(posts).toHaveLength(1);
  });

  // The other half of that latch, found at E6's code review: a preview the
  // host DECLINES to answer — no session, a load that throws, an unresolvable
  // cut, a task in flight, no workspace folder — used to leave the menu with
  // three dead arms and no way forward but Esc. The arms go quiet while the
  // host computes; a refusal is what wakes them up again.
  it("a refused preview re-arms the menu instead of leaving it dead", () => {
    const { handle, posts } = open();
    const disabled = () =>
      Array.from(handle.element.querySelectorAll("button")).map(
        (b) => (b as HTMLButtonElement).disabled,
      );
    (handle.element.querySelectorAll("button")[1] as HTMLElement).click();
    expect(disabled()).toEqual([true, true, true]);

    handle.refuse();
    expect(handle.element.isConnected).toBe(true);
    expect(disabled()).toEqual([false, false, false]);
    expect(armTexts(handle.element)).toEqual([
      "Fork conversation from here",
      "Rewind code to here",
      "Fork conversation and rewind code",
    ]);

    // And the latch is genuinely released, not merely repainted.
    (handle.element.querySelectorAll("button")[2] as HTMLElement).click();
    expect(posts).toEqual([
      { type: "rewindPreview", messageId: "m1", withFork: false },
      { type: "rewindPreview", messageId: "m1", withFork: true },
    ]);
  });

  it("a refusal that arrives after the card does not throw the card away", () => {
    // A refusal is only ever sent INSTEAD of a card, so this cannot happen on
    // the wire — but the two pushes race in principle, and a card the user is
    // reading must not be replaced by the arms with a plan still pending: the
    // host would then hold that plan until some later preview replaced it.
    const { handle, posts } = open();
    (handle.element.querySelectorAll("button")[1] as HTMLElement).click();
    handle.showConsent({
      nonce: "n1",
      withFork: false,
      files: ["a.tex"],
      deletions: [],
    });
    handle.refuse();
    expect(lines(handle.element, "lm-rewind__file")).toEqual(["a.tex"]);
    expect(handle.element.getAttribute("role")).toBe("dialog");
    // Answering it still spends the nonce exactly once.
    (
      handle.element.querySelector(".lm-rewind__confirm") as HTMLElement
    ).click();
    expect(posts.at(-1)).toEqual({
      type: "rewindDecision",
      nonce: "n1",
      confirmed: true,
    });
  });

  it("a refusal for a closed menu is inert", () => {
    const { handle, posts } = open();
    (handle.element.querySelectorAll("button")[1] as HTMLElement).click();
    handle.close();
    handle.refuse();
    expect(handle.element.isConnected).toBe(false);
    expect(posts).toEqual([
      { type: "rewindPreview", messageId: "m1", withFork: false },
    ]);
  });
});

describe("the rewind popover — dismissal (D8)", () => {
  it("Esc closes it and posts nothing at all", () => {
    const { handle, posts } = open();
    esc();
    expect(handle.element.isConnected).toBe(false);
    expect(posts).toEqual([]);
  });

  it("a click away closes it, leaving the composer and every file untouched", () => {
    const { handle, posts } = open();
    const elsewhere = document.createElement("textarea");
    document.body.append(elsewhere);
    mousedownOn(elsewhere);
    expect(handle.element.isConnected).toBe(false);
    expect(posts).toEqual([]);
  });

  it("a click INSIDE the menu leaves it open", () => {
    const { handle } = open();
    mousedownOn(handle.element);
    expect(handle.element.isConnected).toBe(true);
  });

  it("a click on the ⟲ itself is not a click away — the caller owns the toggle", () => {
    // Otherwise the second click would close and reopen in one gesture, and
    // the menu could never be dismissed by the control that opened it.
    const { anchor, handle } = open();
    mousedownOn(anchor);
    expect(handle.element.isConnected).toBe(true);
  });

  it("stops listening once closed, so a later Esc reaches whatever is focused", () => {
    const { handle, posts } = open();
    handle.close();
    handle.close();
    esc();
    expect(posts).toEqual([]);
    expect(handle.element.isConnected).toBe(false);
  });
});

describe("the consent card — what it names before a file is written (D8)", () => {
  const consent = (over: Partial<RewindConsent> = {}): RewindConsent => ({
    nonce: "n-1",
    withFork: false,
    files: ["paper/intro.tex"],
    deletions: [],
    ...over,
  });

  it("asks the restore question, and offers the restoring verb", () => {
    const { handle } = open("en");
    handle.showConsent(consent());
    expect(handle.element.textContent).toContain(
      "Rewind code to this message?",
    );
    expect(armTexts(handle.element)).toEqual(["Rewind code", "Cancel"]);
  });

  it("asks the both question when the fork rides along", () => {
    const { handle } = open("en");
    handle.showConsent(consent({ withFork: true }));
    expect(handle.element.textContent).toContain(
      "Fork the conversation and rewind code to this message?",
    );
    expect(armTexts(handle.element)).toEqual(["Fork and rewind", "Cancel"]);
  });

  it("asks it in Chinese for a Chinese reader, with no English in the card", () => {
    const { handle } = open("zh");
    handle.showConsent(consent({ withFork: true, files: ["论文/引言.tex"] }));
    expect(handle.element.textContent).toContain(
      "分叉会话并将代码回退到该消息处？",
    );
    expect(armTexts(handle.element)).toEqual(["分叉并回退", "取消"]);
  });

  it("names every changed file by path, as text", () => {
    const { handle } = open("en");
    handle.showConsent(consent({ files: ["a.tex", "b/c.tex"] }));
    expect(lines(handle.element, "lm-rewind__file")).toEqual([
      "a.tex",
      "b/c.tex",
    ]);
    expect(handle.element.textContent).toContain("2 file(s) will be restored:");
  });

  it("names the deletions separately, in the imperative", () => {
    // A restore that removes a file the session created is not a restore of
    // that file, and describing it as one is the one thing the modal's own
    // wording was careful never to do.
    const { handle } = open("en");
    handle.showConsent(consent({ files: [], deletions: ["draft/new.tex"] }));
    expect(lines(handle.element, "lm-rewind__deletion")).toEqual([
      "draft/new.tex",
    ]);
    expect(handle.element.textContent).toContain(
      "1 file(s) will be DELETED from disk (this session created them):",
    );
  });

  it("caps the list at five names and counts the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => `f${i}.tex`);
    const { handle } = open("en");
    handle.showConsent(consent({ files: many }));
    expect(lines(handle.element, "lm-rewind__file")).toEqual(
      many.slice(0, MAX_CARD_FILES),
    );
    expect(lines(handle.element, "lm-rewind__more")).toEqual(["…and 3 more"]);
    // The HEADING still carries the true total — the cap shortens the list,
    // never the count the user is consenting to.
    expect(handle.element.textContent).toContain("8 file(s) will be restored:");
  });

  it("counts the rest in Chinese too", () => {
    const many = Array.from({ length: 7 }, (_, i) => `f${i}.tex`);
    const { handle } = open("zh");
    handle.showConsent(consent({ files: many }));
    expect(lines(handle.element, "lm-rewind__more")).toEqual(["……另有 2 个"]);
  });

  it("caps the deletions on their own, not against the restored files", () => {
    const { handle } = open("en");
    handle.showConsent(
      consent({
        files: Array.from({ length: 5 }, (_, i) => `r${i}.tex`),
        deletions: Array.from({ length: 6 }, (_, i) => `d${i}.tex`),
      }),
    );
    expect(lines(handle.element, "lm-rewind__file")).toHaveLength(5);
    expect(lines(handle.element, "lm-rewind__deletion")).toHaveLength(5);
    expect(lines(handle.element, "lm-rewind__more")).toEqual(["…and 1 more"]);
  });

  it("says so when the plan changes nothing, and still asks", () => {
    // Consent proceeds uniformly: a plan that turns out to be empty is a fact
    // about the worktree, not a reason to skip the question.
    const { handle } = open("en");
    handle.showConsent(consent({ files: [], deletions: [] }));
    expect(handle.element.textContent).toContain("No files will change.");
    expect(armTexts(handle.element)).toEqual(["Rewind code", "Cancel"]);
  });

  it("says it in Chinese for a Chinese reader", () => {
    const { handle } = open("zh");
    handle.showConsent(consent({ files: [], deletions: [] }));
    expect(handle.element.textContent).toContain("没有文件会被改动。");
  });

  it("renders a path that looks like markup as the path it is", () => {
    // The webview's CSP carries no 'unsafe-inline' and every node here is
    // built with createElement (ADR 0039 §5); `check-webview-innerhtml.mjs` is
    // the deny-by-default backstop. This is the same property from the
    // reader's side: a filename is shown, never parsed.
    const { handle } = open("en");
    handle.showConsent(consent({ files: ["<b>bold</b>.tex"] }));
    const file = handle.element.querySelector(
      ".lm-rewind__file",
    ) as HTMLElement;
    expect(file.textContent).toBe("<b>bold</b>.tex");
    expect(file.querySelector("b")).toBe(null);
  });

  it("replaces the arms — the card is step two, not a second menu", () => {
    const { handle } = open("en");
    handle.showConsent(consent());
    expect(handle.element.textContent).not.toContain(
      "Fork conversation from here",
    );
  });

  it("ignores a card that arrives after the menu is gone", () => {
    const { handle, posts } = open();
    handle.close();
    handle.showConsent(consent());
    expect(handle.element.isConnected).toBe(false);
    expect(posts).toEqual([]);
  });
});

describe("the consent card — the decision it posts (D8)", () => {
  const shown = (locale: "en" | "zh" = "en") => {
    const o = open(locale);
    o.handle.showConsent({
      nonce: "n-7",
      withFork: true,
      files: ["a.tex"],
      deletions: [],
    });
    return o;
  };

  it("Confirm posts the decision under its nonce, and closes", () => {
    const { handle, posts } = shown();
    (handle.element.querySelectorAll("button")[0] as HTMLElement).click();
    expect(posts).toEqual([
      { type: "rewindDecision", nonce: "n-7", confirmed: true },
    ]);
    expect(handle.element.isConnected).toBe(false);
  });

  it("Cancel declines under the same nonce, so the host can drop the plan", () => {
    const { handle, posts } = shown();
    (handle.element.querySelectorAll("button")[1] as HTMLElement).click();
    expect(posts).toEqual([
      { type: "rewindDecision", nonce: "n-7", confirmed: false },
    ]);
    expect(handle.element.isConnected).toBe(false);
  });

  it("Esc over the card declines it, rather than leaving the plan pending", () => {
    // The host holds the computed plan and its `expected` shas under the
    // nonce. Walking away silently would leave that entry alive until the next
    // preview replaced it; a decline is the honest close.
    const { posts } = shown();
    esc();
    expect(posts).toEqual([
      { type: "rewindDecision", nonce: "n-7", confirmed: false },
    ]);
  });

  it("a click away declines it too", () => {
    const { posts } = shown();
    const elsewhere = document.createElement("textarea");
    document.body.append(elsewhere);
    mousedownOn(elsewhere);
    expect(posts).toEqual([
      { type: "rewindDecision", nonce: "n-7", confirmed: false },
    ]);
  });

  it("posts exactly one decision per card, however it is closed", () => {
    const { handle, posts } = shown();
    (handle.element.querySelectorAll("button")[0] as HTMLElement).click();
    handle.close();
    esc();
    expect(posts).toHaveLength(1);
  });
});
