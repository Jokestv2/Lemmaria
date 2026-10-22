/**
 * Composer key conventions (D2 / CHAT-1, ADR 0037 §5).
 *
 * A DOM-free predicate over the SHAPE of a keydown, not over the event — so it
 * is testable without a browser, while a real `KeyboardEvent` still satisfies
 * it structurally and the call site needs no cast.
 */

/** The part of a `KeyboardEvent` this rule reads. */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  /** Legacy; some IMEs report 229 without setting `isComposing`. */
  keyCode?: number;
}

/**
 * True when this keydown should send the composer's contents.
 *
 * **Enter sends; Shift+Enter and Alt+Enter insert a newline** — the default
 * both Codex (`keymap.rs`: `submit: plain(Enter)`) and Pi
 * (`keybindings.ts`: `tui.input.submit: "enter"`) settled on, and what users
 * already have in their fingers. **Ctrl/Cmd+Enter is kept as a send alias**, a
 * deliberate divergence: both references spend it on *newline* because a
 * terminal cannot distinguish the two, a browser can, and Ctrl+Enter is what
 * sends in Lemmaria today.
 *
 * **The composition check comes first, and that ordering is the point.** An
 * input method delivers Enter to mean "commit the candidate", and neither
 * reference can be copied here — neither has a DOM, so neither has ever had to
 * guard it. Without this, bare-Enter-sends breaks the composer for exactly the
 * users invariant 6 exists for, and it breaks it silently: the message goes,
 * half-typed. Checking it before the modifiers is what keeps Ctrl+Enter from
 * re-opening the same hole.
 */
export function shouldSubmit(k: KeyLike): boolean {
  if (k.isComposing || k.keyCode === 229) return false;
  if (k.key !== "Enter") return false;
  if (k.shiftKey || k.altKey) return false;
  return true;
}

/**
 * True when the handler must insert the newline **itself**, because the browser
 * will not.
 *
 * Declining to send is not the same as inserting a newline, and D2 shipped as
 * if it were: the keydown handler acted only when {@link shouldSubmit} was
 * true, leaving the rest to the textarea's default action. A textarea inserts a
 * newline on **Shift+Enter** natively — but **not on Alt+Enter**, which has no
 * default text-insertion behaviour, so Codex's other newline binding
 * (`keymap.rs`: `insert_newline: […, shift(Enter), alt(Enter)]`) was inert.
 * Found by the operator's D2 round, 2026-08-14; the offline suite had asserted
 * only that Alt+Enter does not *submit*, which was true and insufficient.
 *
 * **Shift+Enter is deliberately excluded.** Its native action is already
 * correct and keeps the undo stack whole, and intercepting a working path to
 * make two cases look symmetric would risk the case that works for the sake of
 * the one that does not. The asymmetry is the browser's, not ours.
 *
 * **The composition guard leads, exactly as in {@link shouldSubmit}.** A
 * newline injected into a live IME composition corrupts it the same way a send
 * does — invariant 6, and the reason this is a predicate here rather than an
 * `else` in the handler.
 */
export function needsExplicitNewline(k: KeyLike): boolean {
  if (k.isComposing || k.keyCode === 229) return false;
  if (k.key !== "Enter") return false;
  if (k.ctrlKey || k.metaKey) return false;
  return k.altKey;
}

/** What a keydown means while the completion menu is open. */
export type MenuAction = "up" | "down" | "accept" | "dismiss";

/**
 * What this keydown does to an OPEN completion menu, or nothing (E2, ADR 0049;
 * design §6).
 *
 * `main.ts` consults this **before** {@link shouldSubmit}, and only while a row
 * is highlighted. Outside that narrow window the composer behaves exactly as
 * CHAT-1 and D2 settled it — which is why this is a third predicate here rather
 * than a branch in the handler.
 *
 * **The composition guard leads, and that ordering is the whole point.** A
 * Chinese user typing `@` and then Pinyin has two candidate lists open at once
 * and both want Enter. The input method must win: if it does not, the composer
 * commits a half-formed candidate *and* accepts a menu row, and it does so
 * silently. This is invariant 6's reader, and it is the same failure D2 shipped
 * and had to fix — putting the guard first is the fix that already worked here.
 *
 * The four keys are the one thing Claude Code, Codex and Pi all agree on
 * (↑↓ move · Tab/Enter accept · Esc dismiss), so they are what users already
 * have in their fingers.
 *
 * **A modified Enter is declined**, which keeps CHAT-1's Ctrl/Cmd+Enter send
 * alias meaning *send* rather than *take the highlighted row*; a modified Tab is
 * declined so Shift+Tab still moves focus out of the composer.
 */
export function menuKeyAction(k: KeyLike): MenuAction | undefined {
  if (k.isComposing || k.keyCode === 229) return undefined;
  if (k.ctrlKey || k.metaKey || k.altKey || k.shiftKey) return undefined;
  if (k.key === "ArrowUp") return "up";
  if (k.key === "ArrowDown") return "down";
  if (k.key === "Enter" || k.key === "Tab") return "accept";
  if (k.key === "Escape") return "dismiss";
  return undefined;
}
