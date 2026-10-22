/**
 * The render frame: coalescing rebuilds, and keeping the reader's place across
 * one (D3 round 2, deliverable 2).
 *
 * `main.ts`'s `render()` rebuilds the whole `document.body` on every streamed
 * delta — A1a's design, which D2's fold memory and decision memory both exist to
 * survive. Two consequences made the transcript unscrollable while a response
 * streamed, in both directions, and both are fixed here rather than by
 * decomposing `main.ts` (which is a milestone of its own — see the DEFERRED
 * entry in `docs/open-questions.md`):
 *
 * 1. **Nothing coalesced.** Every `sessionEvent` called `render()`
 *    synchronously, with no `requestAnimationFrame` anywhere in the file, so at
 *    streaming rates the main thread spent most of every frame rebuilding and
 *    had no room to process a wheel event. It read as locked, not as slow.
 * 2. **The scroll position was read too early.** It was captured before the
 *    expensive build and written back after it, so a scroll performed during the
 *    build landed on a node about to be detached and was then discarded.
 *
 * The ORDER in `replaceScrollPreserving` is therefore the fix, and it lives here
 * — in a module a jsdom test can call — rather than inline in `render()`, where
 * nothing could assert it.
 */

/**
 * How near the bottom still counts as following the stream.
 *
 * A1a's number, unchanged: a reader who has drifted a line or two has not chosen
 * to stop following, and pinning them to the bottom is what "follow the output"
 * means.
 */
export const BOTTOM_SLACK_PX = 40;

/**
 * Whether the transcript is still riding the stream, as the reader's INTENT.
 *
 * **Why this is state and not a measurement (D3 round 4).** Rounds 2 and 3 both
 * asked the pixels, every frame: *is the offset within `BOTTOM_SLACK_PX` of the
 * bottom?* That question cannot distinguish **the reader is here** from **the
 * reader is on their way out**, and the difference is the whole feature. A wheel
 * notch is a compositor animation that takes several frames to travel, and a
 * thumb drag is a sequence of small offsets; both spend their first frames still
 * inside the bottom band, where the sample says "following" and the renderer
 * pins to `scrollHeight` — cancelling the gesture and dragging the reader back
 * down. The operator's re-drive of round 3 found exactly that: the container was
 * finally alive, and the stream still would not let go.
 *
 * So the intent is taken from the reader's INPUT, which is unambiguous the
 * instant it happens, and content arriving never changes it.
 *
 * **Three arms, each covering a route the others cannot** — the same shape the
 * Copy button's activation already documents:
 *
 * - **`wheel` upward** — decided before the offset has moved at all, which is
 *   what makes it immune to the animation's travel time. A trackpad is a wheel
 *   too, so this is the common case in both hands.
 * - **`mousedown` in the scrollbar gutter** (`offsetX` past `clientWidth`, which
 *   excludes the bar) — a thumb drag's first frames have the same problem as the
 *   wheel's, and the press precedes all of them. A press on the CONTENT is
 *   deliberately not a signal: clicking a Copy button inside the transcript is
 *   not a request to stop following the answer.
 * - **`scroll` upward and away** — the catch-all for any route the two above do
 *   not originate, and the only arm that can restore following, which it does
 *   when the reader arrives back within the slack. Rate-limited by nothing:
 *   deciding twice for the same gesture is harmless, because both decisions
 *   agree.
 */
export interface ScrollFollower {
  /** Follow this container, releasing whichever one was tracked before. */
  track(el: HTMLElement | undefined): void;
  /** Whether the renderer should pin to the bottom. */
  following(): boolean;
  /** Pin now, and do not read the resulting scroll event as the reader. */
  pin(el: HTMLElement): void;
  /** Return to following — a first render, or a different view arriving. */
  reset(): void;
}

export function createScrollFollower(
  slack: number = BOTTOM_SLACK_PX,
): ScrollFollower {
  let node: HTMLElement | undefined;
  let follow = true;
  let lastTop = 0;

  const distanceFromBottom = (el: HTMLElement): number =>
    el.scrollHeight - el.scrollTop - el.clientHeight;

  const onScroll = (): void => {
    if (node === undefined) return;
    const top = node.scrollTop;
    // A decrease is the reader moving up and away. The `> slack` guard keeps a
    // browser-side clamp — content shrinking under a reader who is at the bottom
    // — from reading as a deliberate move.
    if (top < lastTop && distanceFromBottom(node) > slack) follow = false;
    else if (distanceFromBottom(node) <= slack) follow = true;
    lastTop = top;
  };

  const onWheel = (ev: WheelEvent): void => {
    if (ev.deltaY < 0) follow = false;
  };

  const onMouseDown = (ev: MouseEvent): void => {
    if (node === undefined || ev.target !== node) return;
    // `clientWidth` excludes the scrollbar, so a press past it is a press ON it.
    // The width guard keeps a panel that has never been laid out from reading
    // every press as a scrollbar press.
    if (node.clientWidth > 0 && ev.offsetX > node.clientWidth) follow = false;
  };

  return {
    track(el: HTMLElement | undefined): void {
      if (el === node) return;
      node?.removeEventListener("scroll", onScroll);
      node?.removeEventListener("wheel", onWheel);
      node?.removeEventListener("mousedown", onMouseDown);
      node = el;
      lastTop = el?.scrollTop ?? 0;
      el?.addEventListener("scroll", onScroll, { passive: true });
      el?.addEventListener("wheel", onWheel, { passive: true });
      el?.addEventListener("mousedown", onMouseDown);
    },
    following: (): boolean => follow,
    pin(el: HTMLElement): void {
      el.scrollTop = el.scrollHeight;
      // Read back: the browser clamps to `scrollHeight - clientHeight`, and a
      // stale `lastTop` would make the next event look like a decrease.
      lastTop = el.scrollTop;
    },
    reset(): void {
      follow = true;
      lastTop = node?.scrollTop ?? 0;
    },
  };
}

/** Where the reader was, immediately before the tree was replaced. */
export interface ScrollAnchor {
  readonly top: number;
  readonly atBottom: boolean;
}

/**
 * Read the anchor.
 *
 * A missing container reports `atBottom`, which is the right answer for the one
 * case that reaches here without one: the transcript's very first render, whose
 * old tree is an empty `<body>`. A view that should not move at all never calls
 * this — it passes no `scroll` to `replaceScrollPreserving` — and conflating the
 * two is exactly the regression that sent five non-transcript tabs to the bottom
 * of their own content on every render.
 */
export function scrollAnchor(el: HTMLElement | null | undefined): ScrollAnchor {
  if (el === null || el === undefined) return { top: 0, atBottom: true };
  return {
    top: el.scrollTop,
    atBottom:
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX,
  };
}

/** Where a live transcript's reader should end up after the swap. */
export interface ScrollCarry {
  /** How to find the scroll region, in the old tree and in the new one. */
  readonly selector: string;
  /**
   * True for a re-render of the same view, where the reader's position is theirs
   * to keep. False for a first render of it, which lands at the bottom.
   */
  readonly keepPosition: boolean;
  /**
   * Who decides whether to ride the stream (D3 round 4).
   *
   * With a follower, following is the reader's remembered intent and the pixel
   * anchor decides nothing. Without one, the anchor is sampled as before — which
   * every non-streaming caller can afford, because nothing is arriving under
   * them while they read.
   */
  readonly follower?: ScrollFollower;
}

export interface ReplaceOptions {
  /** The node whose children are replaced — `document.body`. */
  readonly root: HTMLElement;
  /** Builds the new tree. The expensive half; called exactly once. */
  readonly build: () => Node;
  /**
   * How to carry the reader's place across the swap.
   *
   * **Omit it and `scrollTop` is never written**, which is what every view that
   * is not a live transcript wants: a freshly built panel starts where the
   * browser puts it. Only the streamed transcript has a reason to move it, and
   * conflating the two — one flag meaning both *keep the offset* and *otherwise
   * jump to the bottom* — is what silently sent the Citations, Models, Venue,
   * Review and Compile panels to the bottom of their own content on every
   * render. This module stays ignorant of which view it is rebuilding; the
   * caller says whether a scroll is being carried at all.
   */
  readonly scroll?: ScrollCarry;
}

/**
 * Make the live wrapper carry what the build expressed on the fresh one.
 *
 * The preserving path below keeps the OLD wrapper attached, so an attribute the
 * build set on the new one would otherwise be dropped without a sound. Nothing
 * on `.lm-app` is dynamic today; this exists so that the first thing that is
 * does not fail silently.
 */
function syncAttributes(live: Element, fresh: Element): void {
  for (const { name, value } of Array.from(fresh.attributes)) {
    if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  }
  for (const { name } of Array.from(live.attributes)) {
    if (!fresh.hasAttribute(name)) live.removeAttribute(name);
  }
}

/**
 * Swap everything around and inside `live` without ever detaching `live`.
 *
 * Its siblings are removed and the built tree's siblings inserted around it, in
 * their built order; then its own children are replaced. The node itself, and
 * every ancestor of it, stays in the document throughout.
 */
function spliceAround(live: HTMLElement, fresh: HTMLElement): void {
  const liveParent = live.parentElement;
  const freshParent = fresh.parentElement;
  if (liveParent === null || freshParent === null) return;
  syncAttributes(liveParent, freshParent);
  for (const node of Array.from(liveParent.childNodes)) {
    if (node !== live) liveParent.removeChild(node);
  }
  let past = false;
  for (const node of Array.from(freshParent.childNodes)) {
    if (node === fresh) {
      past = true;
      continue;
    }
    if (past) liveParent.appendChild(node);
    else liveParent.insertBefore(node, live);
  }
  live.replaceChildren(...Array.from(fresh.childNodes));
}

/**
 * Update the view, keeping a live scroll container alive across the update.
 *
 * **Why the container's node identity is the whole fix (D3 round 3).** A wheel
 * notch is not a synchronous write — the compositor animates it over several
 * frames — and a scrollbar drag is a pointer capture held by the scroller's own
 * scrollbar. Both live ON the element. Round 2 rebuilt `document.body` every
 * frame, which built a new `.lm-content` every frame, so at streaming rates both
 * were cancelled before either could land as a `scrollTop` that an anchor could
 * carry: the wheel did nothing until the response ended, and the thumb could not
 * be dragged at all. Round 2's coalescing and its build-then-anchor ORDER were
 * both real fixes to real defects and neither addressed this one, because the
 * damage is to the node's lifetime rather than to the arithmetic over it.
 *
 * So when the caller is carrying a position (`keepPosition`) and both trees have
 * the container, the update SPLICES: siblings replaced around the live node, its
 * children replaced beneath it, the node and its ancestors never detached.
 *
 * A preserved container keeps its own offset, so a reader who has scrolled away
 * needs **nothing written at all** — and writing anyway would cancel the very
 * animation the wheel notch started. The only write left is the deliberate one:
 * following the bottom for a reader who was at the bottom.
 *
 * **The documented fallback** is the wholesale swap this function used to do,
 * for every shape the splice cannot serve: no `scroll` carried at all, a tab
 * switch (`keepPosition: false`), a tree with no container, a first render with
 * no live container, or a built tree that IS the container and so has no
 * siblings to splice and no wrapper to keep. The order is still the point there:
 * building first means the anchor is read at the last possible moment before the
 * node it describes is detached.
 */
export function replaceScrollPreserving(opts: ReplaceOptions): void {
  const tree = opts.build();
  const carry = opts.scroll;
  if (carry === undefined) {
    opts.root.replaceChildren(tree);
    return;
  }
  const before = opts.root.querySelector(carry.selector);
  const live = before instanceof HTMLElement ? before : undefined;
  // Read AFTER the build, from the node the reader is actually looking at.
  const anchor = scrollAnchor(live);
  if (carry.keepPosition && live !== undefined && live.parentElement !== null) {
    const fresh =
      tree instanceof Element ? tree.querySelector(carry.selector) : null;
    if (fresh instanceof HTMLElement && fresh.parentElement !== null) {
      spliceAround(live, fresh);
      // Nothing to restore: the node never moved, so its offset never moved
      // either. Following the bottom is the one thing still worth writing — and
      // whether to do it is the reader's intent, not this frame's pixels.
      const follower = carry.follower;
      if (follower !== undefined) {
        follower.track(live);
        if (follower.following()) follower.pin(live);
      } else if (anchor.atBottom) {
        live.scrollTop = live.scrollHeight;
      }
      return;
    }
  }
  opts.root.replaceChildren(tree);
  const after = opts.root.querySelector(carry.selector);
  if (!(after instanceof HTMLElement)) {
    carry.follower?.track(undefined);
    return;
  }
  const follower = carry.follower;
  if (follower !== undefined) {
    // A container this path installs is a NEW node, so the follower has to be
    // moved onto it or it would keep listening to a detached one.
    if (!carry.keepPosition) follower.reset();
    follower.track(after);
    if (follower.following()) follower.pin(after);
    else after.scrollTop = anchor.top;
    return;
  }
  after.scrollTop =
    !carry.keepPosition || anchor.atBottom ? after.scrollHeight : anchor.top;
}

/** One rebuild per animation frame, however many events arrive inside it. */
export interface RenderScheduler {
  schedule(): void;
}

/**
 * Coalesce every `schedule()` inside one frame into a single `run()`.
 *
 * The frame source is injected rather than reached for, so a test can drive it
 * without stubbing a global — and so this module needs no `window`.
 *
 * There is deliberately **no `cancel()`**: nothing in the webview has a reason
 * to abandon a pending render, and an unused escape hatch is a thing a later
 * reader assumes something calls.
 */
export function createRenderScheduler(
  run: () => void,
  raf: (cb: () => void) => number,
): RenderScheduler {
  let handle: number | undefined;
  return {
    schedule(): void {
      if (handle !== undefined) return;
      handle = raf(() => {
        // Cleared BEFORE the run, so a `schedule()` made from inside it earns
        // the next frame rather than being swallowed by a stale handle.
        handle = undefined;
        run();
      });
    },
  };
}

/**
 * Where the WRITER was, immediately before the composer was rebuilt.
 *
 * The sibling of {@link ScrollAnchor}, and it exists for the same reason: a
 * rebuild replaces the textarea, and everything the browser was holding on the
 * old node — its value, its focus, its caret — dies with it unless something
 * carries it across. A0 carried the first two and dropped the third, which is
 * the defect this pair fixes (E2; see `docs/open-questions.md`).
 *
 * **Why the caret is not merely cosmetic.** Setting `.value` moves the text
 * entry cursor to the END of the control, per the HTML spec — so a re-render
 * arriving while the user is typing mid-draft silently teleports their caret,
 * and the next character they type lands somewhere they did not choose. It fires
 * on any asynchronous render: a streamed delta, a tool result, and — since E2 —
 * the frame that closes the completion menu, which is why the milestone that
 * introduced that frame is the one that pays for the fix.
 */
export interface DraftAnchor {
  readonly text: string;
  readonly focused: boolean;
  readonly start: number;
  readonly end: number;
}

/**
 * Read the anchor off the live composer, before the tree is replaced.
 *
 * `active` is passed rather than read from `document` so this module needs no
 * global — the same reason {@link createRenderScheduler} takes its frame source.
 */
export function draftAnchor(
  input: HTMLTextAreaElement | undefined,
  active: Element | null,
): DraftAnchor {
  if (input === undefined)
    return { text: "", focused: false, start: 0, end: 0 };
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return { text: input.value, focused: active === input, start, end };
}

/**
 * Put the writer back where they were, on the freshly built composer.
 *
 * The selection is restored even when the composer did not have focus: the value
 * and the caret are one fact, and leaving them disagreeing means the next click
 * into the box is the only thing that can repair it. Focus is restored only if
 * it was held — stealing it would move the user out of whatever they clicked
 * into during the frame.
 *
 * Order is deliberate: value, then focus, then selection. `focus()` is the call
 * a browser is entitled to have opinions about, so the selection is written last
 * and wins.
 */
export function restoreDraft(
  input: HTMLTextAreaElement | undefined,
  anchor: DraftAnchor,
): void {
  if (input === undefined) return;
  if (anchor.text !== "") input.value = anchor.text;
  if (anchor.focused) input.focus();
  const max = input.value.length;
  input.setSelectionRange(
    Math.min(anchor.start, max),
    Math.min(anchor.end, max),
  );
}
