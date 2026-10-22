/**
 * The ⟲ popover: three arms, and the consent card behind the two that write
 * (E6, D8; [ADR 0058](../../../../../Lemmaria-design-doc/docs/adr/0058-rewind-decomposed-and-sessions-titled.md) §4).
 *
 * **Why the consent moved in here.** Until E6 a rewind asked for consent with
 * `vscode.window.showWarningMessage({ modal: true })` — an OS dialog. It was
 * correct under invariant 3 and unreadable to every offline runner we have, so
 * the gate could assert that the question was ASKED but never what it SAID: no
 * test could see the file list the user was consenting to. A card built here is
 * a detached node whose every path is `textContent`, which is what makes the
 * promise assertable (ADR 0037's standing rule for `parts/`).
 *
 * **Two steps, because the two halves have different costs.** The fork-only arm
 * writes no user file, so invariant 3 asks nothing of it and the click is the
 * action. A restoring arm asks the host for the plan first; the host computes it
 * once, holds it under a nonce, and pushes it back — so what the user consents
 * to and what is applied are the same plan, which is the compute-once-apply-that
 * window the modal already had.
 *
 * **No string is parsed into DOM.** Every node is `document.createElement`;
 * `scripts/check-webview-innerhtml.mjs` is deny-by-default over this directory
 * with no allowlist, and the webview's CSP carries no `'unsafe-inline'` to fall
 * back on ([ADR 0039](../../../../../Lemmaria-design-doc/docs/adr/0039-markdown-subset-in-the-transcript.md) §5).
 */
import type { SessionLocale } from "@lemmaria/harness";
import { type StringKey, tr } from "./strings.js";

/** What the popover posts to the host — D8's table, and the decision. */
export type RewindMenuPost =
  /** Fork the conversation here. Writes no user file; runs on the click. */
  | { type: "rewindFork"; messageId: string }
  /** Compute the plan for a restoring arm and push it back for consent. */
  | { type: "rewindPreview"; messageId: string; withFork: boolean }
  /** The answer to one card. `confirmed: false` releases the pending plan. */
  | { type: "rewindDecision"; nonce: string; confirmed: boolean };

/** The plan the host computed, as the card needs to name it. */
export interface RewindConsent {
  /** Identifies the pending plan the host is holding. */
  readonly nonce: string;
  /** Whether this restore also forks — it chooses the question and the verb. */
  readonly withFork: boolean;
  /** Files whose contents would be rewritten, by workspace-relative path. */
  readonly files: readonly string[];
  /** Files that would be removed from disk, by workspace-relative path. */
  readonly deletions: readonly string[];
}

export interface RewindMenuOptions {
  readonly messageId: string;
  readonly locale: SessionLocale;
  readonly post: (message: RewindMenuPost) => void;
  /** Told when the menu leaves the DOM, however it was closed. */
  readonly onClose?: () => void;
}

export interface RewindMenuHandle {
  readonly element: HTMLElement;
  /** Which user message this menu belongs to, so a push can be routed to it. */
  readonly messageId: string;
  /** Swap the arms for the consent card. Ignored once the menu is closed. */
  showConsent(consent: RewindConsent): void;
  /**
   * The host declined to answer a preview — re-arm instead of staying dead.
   *
   * A restoring arm disables all three while the host computes, because a
   * second nonce for one gesture would strand the first plan. But the host may
   * answer with **nothing**: a task in flight, no workspace folder, a session
   * it cannot load, a cut it cannot resolve. Without this the menu is then
   * three dead buttons with no way forward but Esc — and ⟲ renders on every
   * user bubble regardless of task state, so that is an ordinary click rather
   * than an edge case. Ignored once a card is up or the menu is closed.
   */
  refuse(): void;
  /** Idempotent: removes the node, drops the listeners, releases the plan. */
  close(): void;
}

/**
 * How many paths a card lists before it summarizes the rest.
 *
 * The same cap `describeRestore` uses for the OS modal, so the two consent
 * surfaces — this card and the palette command's QuickPick — cannot end up
 * describing the same plan at different lengths.
 */
export const MAX_CARD_FILES = 5;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Unique per card, so `aria-labelledby` names THIS card's question. */
let cardSeq = 0;

/**
 * Open the popover against a ⟲ control, mounted in the bubble it belongs to.
 *
 * The caller owns the toggle: a press on the anchor is deliberately NOT treated
 * as a click-away, so a second press can close a menu the first press opened
 * rather than closing and reopening it in one gesture.
 */
export function openRewindMenu(
  anchor: HTMLElement,
  options: RewindMenuOptions,
): RewindMenuHandle {
  const { messageId, locale, post } = options;
  const doc = anchor.ownerDocument;
  const root = el("div", "lm-rewind");

  let live = true;
  /** The nonce of a plan the host is holding for us, or none. */
  let pending: string | undefined;
  /** A preview is in flight: a second one would strand the first plan. */
  let asked = false;

  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    // Consumed at the capture phase: the composer's own Esc handling would
    // otherwise also run, and dismissing a popover is one action, not two.
    ev.preventDefault();
    ev.stopPropagation();
    close();
  };

  const onMouseDown = (ev: MouseEvent): void => {
    const target = ev.target as Node | null;
    if (target !== null && (root.contains(target) || anchor.contains(target)))
      return;
    close();
  };

  function close(): void {
    if (!live) return;
    live = false;
    doc.removeEventListener("keydown", onKeydown, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    root.remove();
    // A card that is walked away from DECLINES. The host is holding a plan and
    // its `expected` shas under this nonce; a silent close would leave that
    // entry alive until some later preview happened to replace it.
    if (pending !== undefined) {
      const nonce = pending;
      pending = undefined;
      post({ type: "rewindDecision", nonce, confirmed: false });
    }
    if (anchor.isConnected) anchor.focus();
    options.onClose?.();
  }

  const button = (cls: string, text: string, run: () => void): HTMLElement => {
    const node = el("button", cls, text) as HTMLButtonElement;
    node.type = "button";
    node.addEventListener("click", run);
    return node;
  };

  const renderArms = (): void => {
    root.replaceChildren();
    root.setAttribute("role", "menu");
    root.removeAttribute("aria-labelledby");

    const arm = (key: StringKey, run: () => void): HTMLElement => {
      const node = button("lm-rewind__arm", tr(locale, key), run);
      node.setAttribute("role", "menuitem");
      return node;
    };

    const preview = (withFork: boolean) => (): void => {
      if (asked) return;
      asked = true;
      // Every arm goes quiet while the host computes: a second nonce for one
      // gesture would leave a plan pending that nobody will ever answer.
      for (const b of root.querySelectorAll("button")) b.disabled = true;
      post({ type: "rewindPreview", messageId, withFork });
    };

    root.append(
      arm("rewindArmFork", () => {
        post({ type: "rewindFork", messageId });
        close();
      }),
      arm("rewindArmRestore", preview(false)),
      arm("rewindArmBoth", preview(true)),
    );
  };

  const nameList = (
    files: readonly string[],
    heading: StringKey,
    itemClass: string,
  ): void => {
    if (files.length === 0) return;
    // The heading carries the TRUE total; the cap shortens the list, never the
    // number the user is consenting to.
    root.append(
      el(
        "div",
        "lm-rewind__heading",
        tr(locale, heading).replace("{n}", String(files.length)),
      ),
    );
    const list = el("ul", "lm-rewind__files");
    for (const file of files.slice(0, MAX_CARD_FILES))
      list.append(el("li", itemClass, file));
    const rest = files.length - MAX_CARD_FILES;
    if (rest > 0)
      list.append(
        el(
          "li",
          "lm-rewind__more",
          tr(locale, "rewindMore").replace("{n}", String(rest)),
        ),
      );
    root.append(list);
  };

  const showConsent = (consent: RewindConsent): void => {
    // A push that lost the race with a dismissal is dropped rather than
    // re-mounting a menu the user has already closed.
    if (!live) return;
    pending = consent.nonce;
    root.replaceChildren();
    root.setAttribute("role", "dialog");

    const ask = el(
      "div",
      "lm-rewind__ask",
      tr(locale, consent.withFork ? "rewindAskBoth" : "rewindAskRestore"),
    );
    ask.id = `lm-rewind-ask-${++cardSeq}`;
    root.setAttribute("aria-labelledby", ask.id);
    root.append(ask);

    nameList(consent.files, "rewindCardRestored", "lm-rewind__file");
    nameList(consent.deletions, "rewindCardDeleted", "lm-rewind__deletion");
    // An empty plan says so and still asks: a plan that turns out to change
    // nothing is a fact about the worktree, not a reason to skip the question.
    if (consent.files.length === 0 && consent.deletions.length === 0)
      root.append(el("div", "lm-rewind__none", tr(locale, "rewindNoFiles")));

    const decide = (confirmed: boolean) => (): void => {
      const nonce = pending;
      // Cleared BEFORE the close, so the decline `close()` would otherwise
      // send cannot follow an answer the user has already given.
      pending = undefined;
      if (nonce !== undefined)
        post({ type: "rewindDecision", nonce, confirmed });
      close();
    };

    const actions = el("div", "lm-rewind__actions");
    actions.append(
      button(
        "lm-rewind__confirm",
        tr(locale, consent.withFork ? "rewindDoBoth" : "rewindDoRestore"),
        decide(true),
      ),
      button("lm-rewind__cancel", tr(locale, "mCancel"), decide(false)),
    );
    root.append(actions);

    // Cancel takes focus, not the confirming button. An arm can be activated
    // with Enter, and a key held a beat too long would otherwise carry that
    // same press onto a button that writes files.
    (actions.lastElementChild as HTMLElement | null)?.focus();
  };

  /**
   * See {@link RewindMenuHandle.refuse}.
   *
   * Guarded on `pending` as well as on `live`: a refusal is only ever sent
   * INSTEAD of a card, so the two cannot both arrive on the wire — but if they
   * ever raced, throwing away a card whose plan the host is still holding
   * would leave that plan alive until some later preview replaced it.
   */
  const refuse = (): void => {
    if (!live || !asked || pending !== undefined) return;
    asked = false;
    renderArms();
    (root.firstElementChild as HTMLElement | null)?.focus();
  };

  renderArms();
  anchor.parentElement?.append(root);
  doc.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("mousedown", onMouseDown, true);
  (root.firstElementChild as HTMLElement | null)?.focus();

  return { element: root, messageId, showConsent, refuse, close };
}
