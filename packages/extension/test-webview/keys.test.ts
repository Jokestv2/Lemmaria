import { describe, expect, it } from "vitest";
import {
  type KeyLike,
  menuKeyAction,
  needsExplicitNewline,
  shouldSubmit,
} from "../src/webview/parts/keys.js";

const key = (over: Partial<KeyLike> = {}): KeyLike => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...over,
});

describe("shouldSubmit (CHAT-1)", () => {
  it("submits on a bare Enter — the Codex/Pi default", () => {
    expect(shouldSubmit(key())).toBe(true);
  });

  it("does not submit on Shift+Enter, which inserts a newline", () => {
    expect(shouldSubmit(key({ shiftKey: true }))).toBe(false);
  });

  it("does not submit on Alt+Enter, Codex's other newline binding", () => {
    expect(shouldSubmit(key({ altKey: true }))).toBe(false);
  });

  it("still submits on Ctrl+Enter and Cmd+Enter (the kept alias)", () => {
    // Deliberate divergence from both references, which spend Ctrl+Enter on
    // newline because a terminal cannot tell it from Enter (ADR 0037 §5). It is
    // currently the ONLY thing that sends in Lemmaria; removing it would break
    // muscle memory for a constraint a browser does not have.
    expect(shouldSubmit(key({ ctrlKey: true }))).toBe(true);
    expect(shouldSubmit(key({ metaKey: true }))).toBe(true);
  });

  it("NEVER submits while an IME composition is in progress", () => {
    // Invariant 6, not a keyboard nicety: a CJK user presses Enter to commit a
    // candidate, and bare-Enter-sends turns that into a half-typed message.
    expect(shouldSubmit(key({ isComposing: true }))).toBe(false);
  });

  it("NEVER submits mid-composition even with a send modifier held", () => {
    // The composition check runs FIRST, before any modifier is consulted —
    // the ordering is the load-bearing part, not the flag.
    expect(shouldSubmit(key({ isComposing: true, ctrlKey: true }))).toBe(false);
    expect(shouldSubmit(key({ isComposing: true, metaKey: true }))).toBe(false);
  });

  it("NEVER submits on the legacy keyCode 229 composition signal", () => {
    // Some IMEs still report 229 without setting isComposing; browsers keep
    // emitting it. No prior art in Codex or Pi — neither has a DOM.
    expect(shouldSubmit(key({ keyCode: 229 }))).toBe(false);
    expect(shouldSubmit(key({ keyCode: 229, ctrlKey: true }))).toBe(false);
  });

  it("ignores every other key", () => {
    for (const k of ["a", "Escape", "Tab", "ArrowUp", " "]) {
      expect(shouldSubmit(key({ key: k }))).toBe(false);
      expect(shouldSubmit(key({ key: k, ctrlKey: true }))).toBe(false);
    }
  });

  it("accepts a real KeyboardEvent structurally", () => {
    // The predicate takes a shape, not an event — but the shape must be one a
    // KeyboardEvent satisfies, or the call site needs a cast it should not need.
    const ev = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
    expect(shouldSubmit(ev)).toBe(false);
  });
});

describe("needsExplicitNewline (CHAT-1, the operator's D2 round)", () => {
  // The defect this exists for: `shouldSubmit` returning false only declines to
  // SEND. Inserting the newline was left to the textarea's default action —
  // which a browser performs for Shift+Enter and does NOT perform for
  // Alt+Enter, so Alt+Enter was inert. Driven and reported 2026-08-14.
  //
  // Note what the old suite proved and did not: "does not submit on Alt+Enter"
  // is a true statement about the rule that says nothing about the behaviour
  // the tier table claimed ("inserts a newline instead"). That gap is why only
  // a human pressing the key found it.

  it("is true for Alt+Enter — the binding no browser delivers on its own", () => {
    expect(needsExplicitNewline(key({ altKey: true }))).toBe(true);
  });

  it("is FALSE for Shift+Enter, which the textarea already handles", () => {
    // Deliberately not intercepted: the native action is correct and keeps the
    // undo stack whole. Two paths to one behaviour, and the asymmetry is the
    // browser's, not ours.
    expect(needsExplicitNewline(key({ shiftKey: true }))).toBe(false);
  });

  it("is false for anything that sends", () => {
    expect(needsExplicitNewline(key())).toBe(false);
    expect(needsExplicitNewline(key({ ctrlKey: true }))).toBe(false);
    expect(needsExplicitNewline(key({ metaKey: true }))).toBe(false);
  });

  it("NEVER fires mid-composition, on either signal", () => {
    // Same ordering as shouldSubmit, for the same invariant-6 reason: an IME
    // owns the Enter that commits a candidate, and a newline injected into a
    // live composition corrupts it exactly like a send would.
    expect(needsExplicitNewline(key({ altKey: true, isComposing: true }))).toBe(
      false,
    );
    expect(needsExplicitNewline(key({ altKey: true, keyCode: 229 }))).toBe(
      false,
    );
  });

  it("is false for Ctrl+Alt+Enter and Cmd+Alt+Enter", () => {
    // A send modifier wins; Alt is not a licence to insert into a send.
    expect(needsExplicitNewline(key({ altKey: true, ctrlKey: true }))).toBe(
      false,
    );
    expect(needsExplicitNewline(key({ altKey: true, metaKey: true }))).toBe(
      false,
    );
  });

  it("ignores every other key held with Alt", () => {
    for (const k of ["a", "Escape", "Tab", "ArrowUp", " "]) {
      expect(needsExplicitNewline(key({ key: k, altKey: true }))).toBe(false);
    }
  });

  it("and the two predicates are never both true", () => {
    // The handler branches on shouldSubmit first; if both could be true for one
    // keydown, a send would silently also insert a newline into the next draft.
    for (const over of [
      {},
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true, ctrlKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ]) {
      const k = key(over);
      expect(shouldSubmit(k) && needsExplicitNewline(k)).toBe(false);
    }
  });
});

describe("menuKeyAction (E2, ADR 0049, design §6)", () => {
  it("NEVER acts while an IME composition is in progress", () => {
    // The guard leads, in exactly the order `shouldSubmit` and
    // `needsExplicitNewline` already lead with it. A Chinese user typing `@`
    // and then Pinyin has TWO candidate lists open and both want Enter; the
    // input method must win, or the composer commits a half-formed candidate
    // AND accepts a menu row, silently. This is the same failure D2 shipped
    // and had to fix, and putting the guard first is the fix that worked.
    for (const k of ["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"]) {
      expect(menuKeyAction(key({ key: k, isComposing: true }))).toBeUndefined();
      expect(menuKeyAction(key({ key: k, keyCode: 229 }))).toBeUndefined();
    }
  });

  it("maps the four keys every reference converged on", () => {
    // Claude Code, Codex and Pi all agree: ↑↓ move, Tab/Enter accept, Esc
    // dismisses. This is the convention users already have in their fingers.
    expect(menuKeyAction(key({ key: "ArrowUp" }))).toBe("up");
    expect(menuKeyAction(key({ key: "ArrowDown" }))).toBe("down");
    expect(menuKeyAction(key({ key: "Enter" }))).toBe("accept");
    expect(menuKeyAction(key({ key: "Tab" }))).toBe("accept");
    expect(menuKeyAction(key({ key: "Escape" }))).toBe("dismiss");
  });

  it("yields nothing for any other key, so typing still types", () => {
    for (const k of ["a", " ", "/", "Backspace", "ArrowLeft", "Home", "F5"]) {
      expect(menuKeyAction(key({ key: k }))).toBeUndefined();
    }
  });

  it("declines a modified Enter, leaving Ctrl/Cmd+Enter as a send", () => {
    // CHAT-1 kept Ctrl/Cmd+Enter as a send alias. A user who reaches for it
    // means "send this", not "take the highlighted row" — so the menu does not
    // consume it and `shouldSubmit` gets it, exactly as with no menu open.
    expect(menuKeyAction(key({ key: "Enter", ctrlKey: true }))).toBeUndefined();
    expect(menuKeyAction(key({ key: "Enter", metaKey: true }))).toBeUndefined();
    expect(
      menuKeyAction(key({ key: "Enter", shiftKey: true })),
    ).toBeUndefined();
    expect(menuKeyAction(key({ key: "Enter", altKey: true }))).toBeUndefined();
  });

  it("declines a modified Tab, so Shift+Tab still moves focus out", () => {
    expect(menuKeyAction(key({ key: "Tab", shiftKey: true }))).toBeUndefined();
  });

  it("and the THREE predicates never disagree about a composition", () => {
    // The cross-check above, widened. `main.ts` consults `menuKeyAction`
    // first while the menu is open; if a composition could produce an action
    // there while the other two correctly declined, the guard's ordering
    // would be defeated by the very branch it was added for.
    for (const over of [
      {},
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ]) {
      for (const k of ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown"]) {
        const ev = key({ ...over, key: k });
        if (ev.isComposing || ev.keyCode === 229) {
          expect(shouldSubmit(ev)).toBe(false);
          expect(needsExplicitNewline(ev)).toBe(false);
          expect(menuKeyAction(ev)).toBeUndefined();
        }
      }
    }
  });

  it("accepts a real KeyboardEvent structurally, with no cast", () => {
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown" });
    expect(menuKeyAction(ev)).toBe("down");
  });
});
