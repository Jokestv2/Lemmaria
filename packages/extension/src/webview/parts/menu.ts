/**
 * The completion menu — its selection state, and its element (E2, ADR 0049).
 *
 * **Why the DOM lives here and not in `main.ts`.** §1's split puts the *logic*
 * in `completion.ts` and the *effects* in `main.ts`; the element is neither. It
 * goes where `decision.ts`, `script-card.ts` and `ring.ts` already put theirs —
 * a `parts/` module returning a detached node — because that is the difference
 * between a behaviour a jsdom test can pin and one that arrives at the gate as
 * an *eyes* item (ADR 0037, and the code-map's standing rule). Nothing imports
 * `main.ts`: it calls `acquireVsCodeApi()` at module scope and exports nothing,
 * so a renderer there would rest on the ext-host probe alone.
 *
 * `completion.ts` stays strictly DOM-free either way. What crosses the boundary
 * is `matchIndices` — just numbers, which is what §7 says makes Codex's
 * `match_indices` the right shape to adapt.
 *
 * **No string is parsed into DOM.** Every node is built with
 * `document.createElement`; `scripts/check-webview-innerhtml.mjs` is
 * deny-by-default over this directory with no allowlist, and the webview's CSP
 * carries no `'unsafe-inline'` to fall back on ([ADR 0039](../../../../../Lemmaria-design-doc/docs/adr/0039-markdown-subset-in-the-transcript.md) §5).
 */
import type { SessionLocale } from "@lemmaria/harness";
import {
  type ActiveToken,
  type Candidate,
  type CandidateGroup,
  MAX_ROWS,
  type Ranked,
  type SigilRule,
  label,
  rank,
} from "./completion.js";
import type { MenuAction } from "./keys.js";
import { type StringKey, tr } from "./strings.js";

/**
 * The groups, in the order they render (D3) — commands first, then skills.
 *
 * Fixed rather than score-ordered, because §8 asks for group headers and a
 * single merged ranking cannot have them; and because a score tie between a
 * verb and a skill would otherwise be broken by whatever order the catalogue
 * happened to load in, so the same query would not give the same first row
 * twice.
 */
const GROUP_ORDER: readonly CandidateGroup[] = ["commands", "skills", "paths"];

const GROUP_HEADING: Record<CandidateGroup, StringKey> = {
  commands: "menuCommands",
  skills: "menuSkills",
  paths: "menuPaths",
};

/** The rows a query produces: each group ranked, then concatenated in order. */
export function menuRows(
  candidates: readonly Candidate[],
  query: string,
): Ranked[] {
  const out: Ranked[] = [];
  for (const group of GROUP_ORDER) {
    out.push(
      ...rank(
        candidates.filter((c) => c.group === group),
        query,
      ),
    );
  }
  return out;
}

export interface MenuState {
  /** The token this menu is completing — held, not re-derived (D4). */
  readonly token: ActiveToken;
  /**
   * Which sigil this menu is completing (E3, D7).
   *
   * It travels WITH the state rather than being re-supplied at each call site,
   * because from E3 on there are two of them and the three places `main.ts`
   * needed it — the token refresh, the render and the accept — would otherwise
   * each have to know which menu was open. One home; a menu cannot render as
   * one sigil and splice as another.
   */
  readonly rule: SigilRule;
  readonly rows: readonly Ranked[];
  /** Which row is highlighted, as an index into `rows`. */
  readonly index: number;
  /** The first visible row — the window's top. */
  readonly top: number;
  /**
   * A pre-localized line about what the list could NOT show, or nothing.
   *
   * Deliberately a finished string rather than a shape this module interprets:
   * B4/A6's *counted, never silently dropped* rule belongs to whoever built the
   * candidates, and a menu that knew how to describe a truncated filesystem
   * walk would be a menu that knew what a filesystem was.
   */
  readonly note?: string;
}

export function menuState(
  token: ActiveToken,
  rule: SigilRule,
  rows: readonly Ranked[],
  note?: string,
): MenuState {
  return { token, rule, rows, index: 0, top: 0, ...(note ? { note } : {}) };
}

/**
 * Rebuild an OPEN menu's rows **without moving the highlight** (E3 code review).
 *
 * A push is not a user action. `menuState` resets `index` and `top` because a
 * new token is a new question — but a candidate source that changed underneath
 * a menu the user is already arrowing through is not, and resetting there hands
 * them row 0 when they press Enter on the row they had aimed at. E2 never hit
 * this because its only push arrived at `ready`; E3's arrives a beat after the
 * `@` menu opens, which is exactly when a fast user is moving.
 *
 * The highlight is **clamped, not preserved blindly**: a revoked grant can make
 * the list shorter than the index, and `index` must stay addressable.
 */
export function reRank(
  open: MenuState,
  rows: readonly Ranked[],
  note?: string,
): MenuState {
  const next = menuState(open.token, open.rule, rows, note);
  if (rows.length === 0) return next;
  const index = Math.min(open.index, rows.length - 1);
  let top = Math.min(open.top, Math.max(0, rows.length - MAX_ROWS));
  if (index < top) top = index;
  else if (index >= top + MAX_ROWS) top = index - MAX_ROWS + 1;
  return { ...next, index, top };
}

/**
 * Moves the highlight one row, **wrapping** at both ends, and scrolls the
 * window only as far as it must to keep the highlight visible.
 *
 * Wrapping is what all three references do. Scrolling lazily is what makes
 * `MAX_ROWS` a window rather than a truncation: the eighth row is not the last
 * candidate, and a menu that stopped there would hide the rest of a catalogue
 * E1 spent a milestone making complete.
 */
export function moveHighlight(state: MenuState, delta: 1 | -1): MenuState {
  const n = state.rows.length;
  if (n === 0) return state;
  const index = (state.index + delta + n) % n;

  let top = state.top;
  if (index < top) top = index;
  else if (index >= top + MAX_ROWS) top = index - MAX_ROWS + 1;
  top = Math.max(0, Math.min(top, Math.max(0, n - MAX_ROWS)));

  return { ...state, index, top };
}

/**
 * Put the highlight on a row that is already on screen — the mouse's move.
 *
 * The window is deliberately **not** touched: the row was pointed at, so it is
 * visible by construction, and recomputing `top` here would let a hover shift
 * the list under the pointer and hand the user a different row than the one
 * they were aiming at.
 */
export function highlightAt(state: MenuState, index: number): MenuState {
  if (index < 0 || index >= state.rows.length) return state;
  if (index === state.index) return state;
  return { ...state, index };
}

/** The rows actually on screen — at most {@link MAX_ROWS} of them. */
export function visibleRows(state: MenuState): Ranked[] {
  return state.rows.slice(state.top, state.top + MAX_ROWS);
}

/**
 * Whether the menu can perform this action at all.
 *
 * **An empty menu consumes only Esc.** `/foo` is prose and must still send —
 * §3 says an unrecognised verb stays prose, and the menu is discovery rather
 * than validation. A menu that ate Enter merely because it happened to be open
 * would make an unmatched slash unsendable, which is a worse failure than
 * offering no menu at all.
 */
export function menuHandles(state: MenuState, action: MenuAction): boolean {
  if (action === "dismiss") return true;
  return state.rows.length > 0;
}

export interface MenuHandlers {
  /** The picked row's index into `rows` — never into the visible window. */
  readonly onPick: (index: number) => void;
  /**
   * One wheel notch over the menu: `+1` scrolls toward the end of the list.
   *
   * **Required, not optional** — the B6 rule that a defaulted parameter makes a
   * missed call site silent. A menu wired without this would swallow the wheel
   * and look broken in exactly the way the operator reported.
   */
  readonly onScroll: (delta: number) => void;
  /**
   * The pointer came to rest on a row — highlight it (operator request,
   * 2026-08-26: hovering a row did nothing, so the mouse could pick a row it
   * could not first point at).
   */
  readonly onHover: (index: number) => void;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The label, with matched characters wrapped in `<strong>` runs.
 *
 * Contiguous matches share one element, so `/ne` produces one `ne` rather than
 * an `n` and an `e` — otherwise the highlight reads as scattered even when the
 * match was not. Splitting is by **code point** (`[...text]`), matching the
 * ranker's own unit, so a name containing an astral character cannot be cut
 * through the middle of a surrogate pair.
 */
function highlighted(text: string, indices: readonly number[]): HTMLElement {
  const name = el("span", "lm-menu__name");
  const marked = new Set(indices);
  const points = [...text];

  let run = "";
  let runMarked = false;
  const flush = (): void => {
    if (run === "") return;
    if (runMarked) name.append(el("strong", "lm-menu__match", run));
    else name.append(run);
    run = "";
  };

  for (let i = 0; i < points.length; i++) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush();
      runMarked = isMarked;
    }
    run += points[i] as string;
  }
  flush();
  return name;
}

/** A stable id per row, so the composer can name the active descendant. */
export function rowId(index: number): string {
  return `lm-menu-row-${index}`;
}

/**
 * The listbox's own id.
 *
 * `aria-activedescendant` names an element that must be **owned** by the
 * element carrying it, and a `<textarea>` can own nothing by containment. So
 * the composer points `aria-owns` at this id, which is what makes the
 * active-descendant reference resolvable at all rather than merely present.
 */
export const MENU_ID = "lm-menu";

/**
 * The menu element — a listbox of rows, grouped, with the highlight marked.
 *
 * The menu never takes DOM focus: the composer keeps it, and this is driven
 * from the composer's own keydown. That is what lets an input method go on
 * owning the keyboard (§6), and it is why the rows carry `aria-selected` and an
 * id, and are taken OUT of the tab order with `tabIndex = -1` — a `<button>`
 * that stayed tabbable would be reachable by a Shift+Tab the composer means to
 * send elsewhere.
 */
/**
 * The last screen position the pointer was seen at, across menu rebuilds.
 *
 * **Module-level because the menu element is not.** The menu is re-mounted on
 * every keystroke, and a browser fires `mouseover`/`mouseenter` at a STATIONARY
 * pointer when the node under it is replaced — so hover-on-enter would let
 * typing yank the highlight to wherever the mouse happened to be resting. A
 * `mousemove` plus this guard means only real pointer movement highlights.
 */
let lastPointer: { x: number; y: number } | undefined;

export function menuElement(
  state: MenuState,
  locale: SessionLocale,
  on: MenuHandlers,
): HTMLElement {
  const root = el("div", "lm-menu");
  root.id = MENU_ID;
  root.setAttribute("role", "listbox");

  // The wheel, over the menu (operator request, 2026-08-26). `passive: false`
  // because the point is to CONSUME it: the menu is an overlay and owns the
  // gesture, so the transcript behind it must not scroll out from under a list
  // the user is reading. Sign only — a notch is one row, and a trackpad's many
  // small deltas then scroll faster on their own without a pixel heuristic.
  root.addEventListener(
    "wheel",
    (e) => {
      const dy = (e as WheelEvent).deltaY;
      if (dy === 0) return;
      e.preventDefault();
      on.onScroll(Math.sign(dy));
    },
    { passive: false },
  );

  // The note is appended LAST, below the rows, because it is about what the
  // list does not contain — a footer, not a header. It is rendered on the empty
  // branch too: "nothing matched, and 12 entries were hidden" is a more useful
  // answer than either half alone.
  const note = (): void => {
    if (state.note === undefined) return;
    const line = el("div", "lm-menu__note", state.note);
    // Presentational for the same reason a group heading is: arrow keys walk
    // `rows`, which holds candidates only, so this is unreachable by
    // construction rather than by a skip rule.
    line.setAttribute("role", "presentation");
    root.append(line);
  };

  const rows = visibleRows(state);
  if (rows.length === 0) {
    // The note WINS over the generic empty line when there is one, rather than
    // stacking above it. Whatever the note says is the better answer to "why is
    // this list empty" — nothing to reference at all, or entries a filter
    // refused — and "No match" repeated above it explains nothing twice.
    if (state.note !== undefined) note();
    else root.append(el("div", "lm-menu__empty", tr(locale, "menuEmpty")));
    return root;
  }

  let lastGroup: CandidateGroup | undefined;
  rows.forEach((ranked, offset) => {
    const index = state.top + offset;
    const group = ranked.candidate.group;
    if (group !== lastGroup) {
      const heading = el(
        "div",
        "lm-menu__group",
        tr(locale, GROUP_HEADING[group]),
      );
      // Presentational: arrow keys walk `rows`, which holds candidates only, so
      // a header is unreachable by construction rather than by a skip rule.
      heading.setAttribute("role", "presentation");
      root.append(heading);
      lastGroup = group;
    }

    const row = el("button", "lm-menu__row") as HTMLButtonElement;
    row.type = "button";
    // OUT of the tab order. A `<button>` is tabbable by default, and the menu
    // renders BEFORE the input box inside `.lm-composer` — so without this,
    // Shift+Tab out of the composer lands on the last row instead of leaving
    // the composer, undoing one layer down exactly what `menuKeyAction`'s
    // modified-Tab decline preserves one layer up. The rows are reached by
    // `aria-activedescendant`, never by focus.
    row.tabIndex = -1;
    row.id = rowId(index);
    row.setAttribute("role", "option");
    const selected = index === state.index;
    row.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) row.classList.add("lm-menu__row--on");

    // E3 (D5): a path row takes the whole width and is allowed to ellipsize,
    // which a slug row is not. The modifier is what the stylesheet keys on.
    if (group === "paths") row.classList.add("lm-menu__row--path");

    row.append(
      highlighted(label(state.rule, ranked.candidate), ranked.matchIndices),
    );
    // The description is the author's own text (invariant 6's boundary), so it
    // is set as text and never touched. A path has none (D5), and an empty
    // element would still take its gap in the flex row — so it is omitted
    // rather than emptied.
    if (ranked.candidate.description !== "") {
      row.append(el("span", "lm-menu__desc", ranked.candidate.description));
    }

    // The pointer must be able to aim before it picks (operator round,
    // 2026-08-26). `mousemove` and not `mouseenter`: see `lastPointer`.
    row.addEventListener("mousemove", (e) => {
      const me = e as MouseEvent;
      if (
        lastPointer !== undefined &&
        lastPointer.x === me.clientX &&
        lastPointer.y === me.clientY
      )
        return;
      lastPointer = { x: me.clientX, y: me.clientY };
      on.onHover(index);
    });
    // `mousedown` rather than `click`: a click would first blur the textarea,
    // and the composer's caret is what the splice is measured against.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      on.onPick(index);
    });
    // Keeps the affordance real for assistive technology, which activates a
    // button rather than pressing it (the arm D3's Copy button needed too).
    row.addEventListener("click", (e) => {
      if ((e as MouseEvent).detail === 0) on.onPick(index);
    });

    root.append(row);
  });

  note();
  return root;
}

/**
 * Move the window without moving the highlight — the mouse wheel (operator
 * request, 2026-08-26).
 *
 * **Why a reducer and not `overflow-y: auto`.** `.lm-menu` carries both, and
 * neither has ever scrolled: {@link visibleRows} puts at most {@link MAX_ROWS}
 * rows in the DOM, so the eight always fit the 268px box and the browser has
 * nothing to scroll. The window is ours, so the wheel has to move it.
 *
 * **The highlight deliberately does not follow.** A wheel scrolls a view; it
 * does not choose, and this is what VS Code's own suggest widget does — the
 * menu a Lemmaria user already has in their fingers. The cost is that the
 * highlight can be scrolled out of sight, which is why `syncMenuAria` goes on
 * naming it: what Enter takes and what a screen reader announces stay the same
 * row whatever the wheel did, and one arrow key brings it back into view.
 */
export function scrollWindow(state: MenuState, delta: number): MenuState {
  const max = Math.max(0, state.rows.length - MAX_ROWS);
  // Identity, not a copy: nothing scrolls when everything fits, which is the
  // default workspace's six candidates, and a new object per notch there would
  // re-render the menu for no change at all.
  if (max === 0) return state;
  const top = Math.max(0, Math.min(state.top + delta, max));
  if (top === state.top) return state;
  return { ...state, top };
}

/**
 * Put the menu into the composer — or take it out — **without disturbing one
 * other node**, the textarea above all.
 *
 * **This exists because of a defect the operator's E-3 round found**, and the
 * defect is worth stating because the fix looks like a mere optimisation and is
 * not. Every menu interaction used to call `scheduleRender()`; `render()`
 * rebuilds `.lm-app`'s children wholesale and `composer()` built a NEW
 * `<textarea>` each time. A browser's **undo stack is per-element state** —
 * `restoreDraft` can carry a value, a caret and focus across a rebuild, and can
 * carry no history at all — so accepting a completion wrote an undoable
 * `execCommand("insertText")` into an element that was replaced one frame
 * later, and typing `/rel` had already replaced it four times before that, once
 * per keystroke, because the menu was open. Ctrl+Z therefore had nothing to
 * undo but the value the fresh element happened to start life with.
 *
 * It is the same lesson `replaceScrollPreserving` records one file over: **the
 * damage is to the node's lifetime, not to the arithmetic over it**, and the
 * only fix is to stop replacing the node. A scroll offset, a pointer capture
 * and an undo stack are three of a kind.
 *
 * Exported and DOM-free of `main.ts` for the usual reason (ADR 0037, and the
 * D2 entry in `open-questions.md`): `main.ts` cannot be imported, so the rule
 * lives here where jsdom can assert that the textarea is the same object before
 * and after — which is the property, stated as an identity rather than as a
 * hope.
 */
export function mountMenu(
  container: HTMLElement,
  menu: HTMLElement | undefined,
  anchorSelector: string,
): void {
  // Scoped to direct children on purpose: a `.lm-menu` is the composer's own,
  // and a descendant query would be a promise about the rest of the subtree
  // that this function has no business making.
  for (const child of Array.from(container.children)) {
    if (child.classList.contains("lm-menu")) child.remove();
  }
  if (menu === undefined) return;
  // `insertBefore(node, null)` appends, so a missing anchor degrades to the end
  // rather than throwing. The order matters to the stylesheet, not to the DOM:
  // `.lm-menu` is positioned `bottom: 100%` against `.lm-composer`.
  container.insertBefore(menu, container.querySelector(anchorSelector));
}

/**
 * The composer's three menu ARIA attributes, set and — the half that is easy to
 * forget — **cleared**.
 *
 * They used to be written inside `composer()`, which was correct only because a
 * render followed every menu change. {@link mountMenu} removes that render, so
 * they need a home that runs on the same beat. A stale `aria-expanded="true"`
 * tells a screen reader a list is open over a composer that has none, which is
 * a worse state than never having announced it.
 *
 * An EMPTY menu clears them too: it owns no row, so there is nothing for
 * `aria-activedescendant` to name, and `menuHandles` already refuses every
 * action on it but Esc.
 */
export function syncMenuAria(
  input: HTMLElement,
  state: MenuState | undefined,
): void {
  if (state === undefined || state.rows.length === 0) {
    input.removeAttribute("aria-owns");
    input.removeAttribute("aria-expanded");
    input.removeAttribute("aria-activedescendant");
    return;
  }
  input.setAttribute("aria-owns", MENU_ID);
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-activedescendant", rowId(state.index));
}
