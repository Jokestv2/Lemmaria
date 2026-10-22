import { describe, expect, it, vi } from "vitest";
import {
  BOTTOM_SLACK_PX,
  type ScrollCarry,
  createRenderScheduler,
  createScrollFollower,
  draftAnchor,
  replaceScrollPreserving,
  restoreDraft,
  scrollAnchor,
} from "../src/webview/parts/frame.js";

/**
 * D3 round 2, deliverable 2 — the transcript could not be scrolled at all while
 * a response streamed, in either direction.
 *
 * Two defects in one. N synchronous rebuilds per frame left the browser no room
 * to process a wheel event; and the scroll position was read BEFORE the
 * expensive build and written back after it, so any scroll performed during the
 * build was read from a doomed node and then discarded.
 *
 * jsdom performs no layout, so `scrollHeight` and `clientHeight` are always 0 —
 * but `scrollTop` is a stored value that reads back what was set, and the two
 * heights can be given real values with `Object.defineProperty`. That is enough
 * to assert the arithmetic and, more importantly, the ORDER.
 */

/** A scroll container with believable geometry. */
function container(
  scrollHeight: number,
  clientHeight: number,
  top: number,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "lm-content";
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  el.scrollTop = top;
  return el;
}

describe("createRenderScheduler — one rebuild per frame, not one per delta", () => {
  it("coalesces every schedule inside a frame into a single run", () => {
    const run = vi.fn();
    let frame: (() => void) | undefined;
    const scheduler = createRenderScheduler(run, (cb) => {
      frame = cb;
      return 1;
    });
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(run).not.toHaveBeenCalled();
    frame?.();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("schedules again after the frame has run", () => {
    const run = vi.fn();
    let frame: (() => void) | undefined;
    const scheduler = createRenderScheduler(run, (cb) => {
      frame = cb;
      return 1;
    });
    scheduler.schedule();
    frame?.();
    scheduler.schedule();
    frame?.();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("clears its handle before running, so a re-entrant schedule earns a frame", () => {
    // `render()` itself never schedules, but a listener it attaches might, and
    // swallowing that on a stale handle would drop a frame silently.
    const frames: (() => void)[] = [];
    let scheduler = { schedule: (): void => {} };
    const run = vi.fn(() => {
      if (frames.length < 2) scheduler.schedule();
    });
    scheduler = createRenderScheduler(run, (cb) => frames.push(cb));
    scheduler.schedule();
    frames[0]?.();
    expect(frames.length).toBe(2);
    frames[1]?.();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("scrollAnchor — where the reader was", () => {
  it("counts a reader within the slack as following the stream", () => {
    // 1000 - 900 - 100 = 0, and 1000 - 880 - 100 = 20, both under 40.
    expect(scrollAnchor(container(1000, 100, 900)).atBottom).toBe(true);
    expect(scrollAnchor(container(1000, 100, 880)).atBottom).toBe(true);
  });

  it("counts a reader who has scrolled away as not following it", () => {
    // 1000 - 400 - 100 = 500.
    const anchor = scrollAnchor(container(1000, 100, 400));
    expect(anchor.atBottom).toBe(false);
    expect(anchor.top).toBe(400);
  });

  it("treats a missing container as at the bottom", () => {
    // A first render, or a tab with no scroll region: land at the bottom rather
    // than at 0.
    expect(scrollAnchor(null).atBottom).toBe(true);
    expect(scrollAnchor(undefined).atBottom).toBe(true);
    expect(BOTTOM_SLACK_PX).toBe(40);
  });
});

describe("replaceScrollPreserving — the order is the fix", () => {
  /** A root holding one scroll container, as `document.body` does. */
  function root(before?: HTMLElement): HTMLElement {
    const box = document.createElement("div");
    if (before) box.append(before);
    return box;
  }

  /** The transcript's carry. Every other view passes no `scroll` at all. */
  const transcript = (keepPosition: boolean): ScrollCarry => ({
    selector: ".lm-content",
    keepPosition,
  });

  it("leaves scrollTop ALONE when no scroll is being carried", () => {
    // The review's Critical. Five of the six `.lm-content` containers in the
    // webview belong to tabs that are not the transcript — Citations, Models,
    // Venue, Review, Compile — and writing `scrollHeight` into them lands the
    // reader at the BOTTOM of a freshly built panel. Before round 2 the restore
    // sat inside `if (activeTab === 0)`; omitting `scroll` is how that scoping
    // survives the extraction, and this asserts it rather than assuming it.
    const box = root(container(1000, 100, 400));
    const after = container(1400, 100, 0);
    replaceScrollPreserving({ root: box, build: () => after });
    expect(after.scrollTop).toBe(0);
    expect(box.firstChild).toBe(after);
  });

  it("keeps a scroll performed DURING the build, which is the defect", () => {
    // The regression this whole task exists for. `build` is the expensive half —
    // a Markdown parse per streamed delta — and the user turns the wheel while
    // it runs. Read the anchor before it and their gesture is discarded.
    const before = container(1000, 100, 400);
    const box = root(before);
    const after = container(1000, 100, 0);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => {
        before.scrollTop = 250;
        return after;
      },
    });
    expect(after.scrollTop).toBe(250);
  });

  it("follows the bottom for a reader who was at the bottom", () => {
    const before = container(1000, 100, 900);
    const box = root(before);
    const after = container(1400, 100, 0);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => after,
    });
    expect(after.scrollTop).toBe(1400);
  });

  it("stops following once the reader has scrolled away", () => {
    const before = container(1000, 100, 400);
    const box = root(before);
    const after = container(1400, 100, 0);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => after,
    });
    expect(after.scrollTop).toBe(400);
  });

  it("lands at the bottom when the position is not being kept", () => {
    // A tab switch, or a first render.
    const before = container(1000, 100, 400);
    const box = root(before);
    const after = container(1400, 100, 0);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(false),
      build: () => after,
    });
    expect(after.scrollTop).toBe(1400);
  });

  it("replaces the root's children with exactly the built tree", () => {
    const box = root(container(1000, 100, 0));
    const tree = document.createElement("section");
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => tree,
    });
    expect(box.childNodes.length).toBe(1);
    expect(box.firstChild).toBe(tree);
  });

  it("builds exactly once", () => {
    // The build is the expensive half; calling it twice would double the cost of
    // every streamed delta.
    const build = vi.fn(() => container(100, 100, 0));
    replaceScrollPreserving({
      root: root(container(1000, 100, 0)),
      scroll: transcript(true),
      build,
    });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the new tree has no scroll region", () => {
    // Every tab but the Assistant: there is no `.lm-content` to restore into.
    const box = root(container(1000, 100, 400));
    expect(() =>
      replaceScrollPreserving({
        root: box,
        scroll: transcript(true),
        build: () => document.createElement("section"),
      }),
    ).not.toThrow();
  });

  it("does not throw on a first render, with no old tree at all", () => {
    const box = root();
    const after = container(500, 100, 0);
    expect(() =>
      replaceScrollPreserving({
        root: box,
        scroll: transcript(false),
        build: () => after,
      }),
    ).not.toThrow();
    expect(after.scrollTop).toBe(500);
  });
});

/**
 * D3 round 3 — the operator's round on round 2 found item 2 still failing: the
 * wheel moved nothing until the response ended, and the scrollbar thumb could
 * not be dragged at all.
 *
 * Round 2's two halves both work and neither addresses the cause. `render()`
 * replaces `document.body`'s children wholesale and `content()` builds a NEW
 * `.lm-content` — the element that owns the scroll — every call, so while a
 * response streams the scroll container is DESTROYED once per frame. A thumb
 * drag is a pointer capture held by that element's scrollbar, and a wheel notch
 * is a multi-frame animation the compositor runs on it; detaching the element
 * cancels both, so neither ever lands as a `scrollTop` an anchor could carry.
 *
 * The fix keeps the container's node identity across the swap: its siblings are
 * replaced around it and its own children are replaced beneath it, but the node
 * itself — and every ancestor of it — stays attached the whole time.
 *
 * **These assertions are about NODE LIFETIME, not about arithmetic**, which is
 * the layer the previous three rounds' tests kept missing. jsdom has no
 * compositor, no scroll animation and no scrollbar, so it can never observe a
 * cancelled gesture directly — but "was this node ever detached" is exactly the
 * precondition the gesture rides on, and a MutationObserver can answer it.
 */
describe("replaceScrollPreserving — the container itself survives the swap", () => {
  const transcript = (keepPosition: boolean): ScrollCarry => ({
    selector: ".lm-content",
    keepPosition,
  });

  /** The production shape: body > .lm-app > [header, .lm-content, composer]. */
  function shell(live: HTMLElement): { box: HTMLElement; app: HTMLElement } {
    const box = document.createElement("div");
    const app = document.createElement("div");
    app.className = "lm-app";
    const header = document.createElement("div");
    header.className = "lm-header";
    header.textContent = "old header";
    const composer = document.createElement("div");
    composer.className = "lm-composer";
    composer.textContent = "old composer";
    app.append(header, live, composer);
    box.append(app);
    return { box, app };
  }

  /** What `build()` returns: a whole new tree, a fresh container inside it. */
  function rebuilt(fresh: HTMLElement, label: string): HTMLElement {
    const app = document.createElement("div");
    app.className = "lm-app";
    const header = document.createElement("div");
    header.className = "lm-header";
    header.textContent = `${label} header`;
    const composer = document.createElement("div");
    composer.className = "lm-composer";
    composer.textContent = `${label} composer`;
    const line = document.createElement("p");
    line.textContent = `${label} transcript`;
    fresh.append(line);
    app.append(header, fresh, composer);
    return app;
  }

  /** A container that counts every write to `scrollTop`. */
  function counted(
    scrollHeight: number,
    clientHeight: number,
    top: number,
  ): { el: HTMLElement; writes: () => number } {
    const el = container(scrollHeight, clientHeight, top);
    let value = top;
    let writes = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (v: number) => {
        writes++;
        value = v;
      },
    });
    return { el, writes: () => writes };
  }

  /** Every node the swap detached from `box`, however briefly. */
  function detachedBy(box: HTMLElement, act: () => void): Set<Node> {
    const removed = new Set<Node>();
    const observer = new MutationObserver(() => {});
    observer.observe(box, { childList: true, subtree: true });
    act();
    for (const record of observer.takeRecords()) {
      for (const node of record.removedNodes) removed.add(node);
    }
    observer.disconnect();
    return removed;
  }

  it("never detaches the container, which is what the gesture rides on", () => {
    // THE defect. A detached scroller loses its pointer capture and its running
    // scroll animation, which is why the wheel and the thumb were both dead.
    const live = container(1000, 100, 400);
    const { box, app } = shell(live);
    const detached = detachedBy(box, () => {
      replaceScrollPreserving({
        root: box,
        scroll: transcript(true),
        build: () => rebuilt(container(1400, 100, 0), "new"),
      });
    });
    expect(detached.has(live)).toBe(false);
    expect(detached.has(app)).toBe(false);
    expect(box.querySelector(".lm-content")).toBe(live);
  });

  it("still brings the new tree's siblings and content across", () => {
    // Preserving the node must not cost the update: everything around and inside
    // the container is still whatever the build produced.
    const live = container(1000, 100, 400);
    const { box } = shell(live);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => rebuilt(container(1400, 100, 0), "new"),
    });
    expect(box.querySelector(".lm-header")?.textContent).toBe("new header");
    expect(box.querySelector(".lm-composer")?.textContent).toBe("new composer");
    expect(live.textContent).toBe("new transcript");
    expect(box.querySelectorAll(".lm-content").length).toBe(1);
  });

  it("keeps the siblings in their built order", () => {
    const live = container(1000, 100, 400);
    const { box } = shell(live);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => rebuilt(container(1400, 100, 0), "new"),
    });
    const app = box.firstElementChild;
    expect(
      Array.from(app?.children ?? []).map((c) => c.className),
    ).toStrictEqual(["lm-header", "lm-content", "lm-composer"]);
  });

  it("does NOT write scrollTop for a reader who has scrolled away", () => {
    // The other half of the fix, and it is not an optimisation: writing
    // `scrollTop` mid-gesture cancels the very smooth-scroll animation the wheel
    // notch started. A container that is never detached keeps its own offset, so
    // the correct action for a reader who is not following is NOTHING.
    const { el, writes } = counted(1000, 100, 400);
    const { box } = shell(el);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => rebuilt(container(1400, 100, 0), "new"),
    });
    expect(writes()).toBe(0);
    expect(el.scrollTop).toBe(400);
  });

  it("still follows the bottom for a reader who was at the bottom", () => {
    const live = container(1000, 100, 900);
    const { box } = shell(live);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => rebuilt(container(1400, 100, 0), "new"),
    });
    // Its own scrollHeight, not the discarded fresh container's.
    expect(live.scrollTop).toBe(1000);
  });

  it("keeps a scroll performed DURING the build, without writing it back", () => {
    // Round 2's property, restated on the preserved node: the anchor is still
    // read after the build, and now the honouring is done by not interfering.
    const { el, writes } = counted(1000, 100, 400);
    const { box } = shell(el);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => {
        el.scrollTop = 250;
        return rebuilt(container(1400, 100, 0), "new");
      },
    });
    expect(el.scrollTop).toBe(250);
    expect(writes()).toBe(1); // the build's own write, and none of ours
  });

  it("carries the wrapper's own attributes across", () => {
    // The old wrapper stays attached, so anything the build expressed ON it
    // would otherwise be silently dropped — a trap of exactly the kind this
    // milestone has paid for three times.
    const live = container(1000, 100, 400);
    const { box, app } = shell(live);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => {
        const tree = rebuilt(container(1400, 100, 0), "new");
        tree.className = "lm-app lm-app--narrow";
        tree.setAttribute("data-tab", "0");
        return tree;
      },
    });
    expect(app.className).toBe("lm-app lm-app--narrow");
    expect(app.getAttribute("data-tab")).toBe("0");
  });

  it("drops a wrapper attribute the build no longer sets", () => {
    const live = container(1000, 100, 400);
    const { box, app } = shell(live);
    app.setAttribute("data-stale", "yes");
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => rebuilt(container(1400, 100, 0), "new"),
    });
    expect(app.hasAttribute("data-stale")).toBe(false);
  });

  it("lands at the bottom on a tab switch, where the position is not kept", () => {
    // `keepPosition: false` is a different view arriving; it replaces wholesale
    // and lands at the bottom, exactly as before.
    const live = container(1000, 100, 400);
    const { box } = shell(live);
    const fresh = container(1400, 100, 0);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(false),
      build: () => rebuilt(fresh, "new"),
    });
    expect(box.querySelector(".lm-content")).toBe(fresh);
    expect(fresh.scrollTop).toBe(1400);
  });

  it("falls back to the wholesale swap when the built tree IS the container", () => {
    // There is nothing to splice into: the container has no siblings to keep it
    // company and no wrapper to stay attached. Documented fallback, not an edge
    // case — it is the shape every non-transcript caller has.
    const live = container(1000, 100, 400);
    const { box } = shell(live);
    const fresh = container(1400, 100, 0);
    replaceScrollPreserving({
      root: box,
      scroll: transcript(true),
      build: () => fresh,
    });
    expect(box.firstChild).toBe(fresh);
    expect(fresh.scrollTop).toBe(400);
  });

  it("builds exactly once on the preserving path", () => {
    const live = container(1000, 100, 400);
    const { box } = shell(live);
    const build = vi.fn(() => rebuilt(container(1400, 100, 0), "new"));
    replaceScrollPreserving({ root: box, scroll: transcript(true), build });
    expect(build).toHaveBeenCalledTimes(1);
  });
});

/**
 * D3 round 4 — the operator's re-drive of round 3 confirmed the container now
 * survives (the wheel and the thumb are both responsive), and found the last
 * symptom: **the stream keeps dragging the transcript back down while the reader
 * is trying to read further up.**
 *
 * The cause is that "am I following the stream" was RE-DERIVED from pixels on
 * every frame. A wheel notch is a compositor animation over several frames and a
 * thumb drag is a sequence of offsets, so both spend their first frames still
 * INSIDE the 40px bottom band — where a per-frame sample reads "at the bottom",
 * pins to `scrollHeight` and cancels the gesture. Sampling cannot tell *the
 * reader is here* from *the reader is on their way out*.
 *
 * Following is therefore the reader's INTENT, held as state and changed only by
 * their input: an upward wheel or a press on the scrollbar drops it immediately,
 * a scroll that lands back at the bottom restores it, and content arriving
 * changes it never.
 */
describe("createScrollFollower — following is the reader's intent, not a pixel sample", () => {
  /** A container whose geometry a test can move, as a stream would. */
  function scroller(scrollHeight: number, clientHeight: number, top: number) {
    const el = document.createElement("div");
    el.className = "lm-content";
    let height = scrollHeight;
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(el, "clientWidth", {
      configurable: true,
      value: 300,
    });
    el.scrollTop = top;
    const press = (offsetX: number): void => {
      const ev = new MouseEvent("mousedown", { bubbles: true });
      Object.defineProperty(ev, "offsetX", { value: offsetX });
      el.dispatchEvent(ev);
    };
    return {
      el,
      /** The reader moves; the browser then fires `scroll`. */
      scrollTo(next: number): void {
        el.scrollTop = next;
        el.dispatchEvent(new Event("scroll"));
      },
      /** A delta lands: the content grows, and nothing scrolls. */
      grow(by: number): void {
        height += by;
      },
      wheelUp: (): void => {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      },
      wheelDown: (): void => {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
      },
      pressScrollbar: (): void => press(312),
      pressContent: (): void => press(120),
    };
  }

  it("starts by following, so a fresh transcript rides the stream", () => {
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    expect(follower.following()).toBe(true);
  });

  it("stops following on an upward wheel, BEFORE the offset has moved at all", () => {
    // The defect, at its root. The wheel's own animation spends its first frames
    // inside the bottom band; a per-frame sample pins to the bottom there and
    // cancels it, which is what "it keeps scrolling down while responding" was.
    // The event carries the intent, so the intent is taken from the event.
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.wheelUp();
    expect(follower.following()).toBe(false);
    // And by pixels this reader is still exactly AT the bottom, which is why
    // sampling could never have got this right.
    expect(scrollAnchor(box.el).atBottom).toBe(true);
  });

  it("stops following when the scrollbar is pressed, before the drag moves", () => {
    // A thumb drag has the same first-frames problem as the wheel. The press
    // lands in the scrollbar gutter — past `clientWidth`, which excludes it.
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.pressScrollbar();
    expect(follower.following()).toBe(false);
  });

  it("keeps following when a press lands on the content rather than the bar", () => {
    // Clicking a Copy button inside the transcript is not a request to stop
    // following the answer being written.
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.pressContent();
    expect(follower.following()).toBe(true);
  });

  it("stops following when a scroll moves the reader up and away", () => {
    // The catch-all arm, for any route the two above do not originate.
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.scrollTo(400);
    expect(follower.following()).toBe(false);
  });

  it("NEVER resumes following just because content arrived", () => {
    // The whole point. A reader who has scrolled up stays where they are for as
    // long as the answer keeps coming, however much of it arrives.
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.wheelUp();
    box.scrollTo(300);
    for (let i = 0; i < 40; i++) box.grow(200);
    expect(follower.following()).toBe(false);
  });

  it("resumes following once the reader scrolls back to the bottom", () => {
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 400);
    follower.track(box.el);
    box.scrollTo(300);
    expect(follower.following()).toBe(false);
    box.scrollTo(880); // 1000 - 880 - 100 = 20, inside the 40px slack
    expect(follower.following()).toBe(true);
  });

  it("does not resume on a downward scroll that stops short of the bottom", () => {
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.scrollTo(200);
    box.scrollTo(500); // downward, but 400 from the bottom
    expect(follower.following()).toBe(false);
  });

  it("does not read its own pin as the reader moving", () => {
    // `pin` writes `scrollTop`, which the browser answers with a scroll event.
    // Mistaking that for the reader would make following flap every frame.
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    follower.pin(box.el);
    box.el.dispatchEvent(new Event("scroll"));
    expect(follower.following()).toBe(true);
    expect(box.el.scrollTop).toBe(1000);
  });

  it("a downward wheel does not by itself resume following", () => {
    // Only actually reaching the bottom does. A reader nudging down two lines
    // 900px up is still reading, not following.
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.wheelUp();
    box.wheelDown();
    expect(follower.following()).toBe(false);
  });

  it("reset() returns to following, for a tab switch or a first render", () => {
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    box.wheelUp();
    follower.reset();
    expect(follower.following()).toBe(true);
  });

  it("moves to a new container and stops listening to the old one", () => {
    // The wholesale fallback path replaces the container; a listener left on a
    // detached node would keep voting on a view nobody can see.
    const follower = createScrollFollower();
    const first = scroller(1000, 100, 900);
    const second = scroller(1000, 100, 900);
    follower.track(first.el);
    follower.track(second.el);
    first.wheelUp();
    expect(follower.following()).toBe(true);
    second.wheelUp();
    expect(follower.following()).toBe(false);
  });

  it("tracking the same container twice does not stack listeners", () => {
    const follower = createScrollFollower();
    const box = scroller(1000, 100, 900);
    follower.track(box.el);
    follower.track(box.el);
    follower.track(box.el);
    box.scrollTo(400);
    expect(follower.following()).toBe(false);
    box.scrollTo(880);
    expect(follower.following()).toBe(true);
  });
});

describe("replaceScrollPreserving — the follower decides, not the pixels", () => {
  function shell(live: HTMLElement): HTMLElement {
    const box = document.createElement("div");
    const app = document.createElement("div");
    app.className = "lm-app";
    app.append(live);
    box.append(app);
    return box;
  }

  function rebuilt(fresh: HTMLElement): HTMLElement {
    const app = document.createElement("div");
    app.className = "lm-app";
    // The class matters: without it the splice never fires and every assertion
    // below would pass on the fallback path instead, which is the wrong subject.
    fresh.className = "lm-content";
    app.append(fresh);
    return app;
  }

  /** A container that counts writes, so "wrote nothing" is assertable. */
  function counted(scrollHeight: number, clientHeight: number, top: number) {
    const el = document.createElement("div");
    el.className = "lm-content";
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: scrollHeight,
    });
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      value: clientHeight,
    });
    Object.defineProperty(el, "clientWidth", {
      configurable: true,
      value: 300,
    });
    let value = top;
    let writes = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (v: number) => {
        writes++;
        value = v;
      },
    });
    return { el, writes: () => writes };
  }

  it("writes nothing while the reader has taken control, even AT the bottom", () => {
    // The regression in one assertion: by pixels this reader is at the bottom,
    // and the sampling code pinned them there on every streamed delta.
    const { el, writes } = counted(1000, 100, 900);
    const follower = createScrollFollower();
    follower.track(el);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    replaceScrollPreserving({
      root: shell(el),
      scroll: { selector: ".lm-content", keepPosition: true, follower },
      build: () => rebuilt(document.createElement("div")),
    });
    expect(writes()).toBe(0);
  });

  it("still pins a reader who is following", () => {
    const { el, writes } = counted(1000, 100, 900);
    const follower = createScrollFollower();
    follower.track(el);
    replaceScrollPreserving({
      root: shell(el),
      scroll: { selector: ".lm-content", keepPosition: true, follower },
      build: () => rebuilt(document.createElement("div")),
    });
    expect(writes()).toBe(1);
    expect(el.scrollTop).toBe(1000);
  });

  it("a tab switch resets the follower and lands at the bottom", () => {
    // `keepPosition: false` is a different view arriving. Whatever the reader
    // did to the previous one does not follow them into it.
    const { el } = counted(1000, 100, 900);
    const follower = createScrollFollower();
    follower.track(el);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    expect(follower.following()).toBe(false);
    const fresh = counted(1400, 100, 0);
    replaceScrollPreserving({
      root: shell(el),
      scroll: { selector: ".lm-content", keepPosition: false, follower },
      build: () => rebuilt(fresh.el),
    });
    expect(follower.following()).toBe(true);
    expect(fresh.el.scrollTop).toBe(1400);
  });
});

/**
 * E2 — the caret half of the rebuild, which A0 dropped.
 *
 * A0's `render()` captured the composer's value and whether it had focus, and
 * restored both. It captured nothing about the caret, and assigning `.value`
 * moves the text entry cursor to the END of the control per the HTML spec — so
 * every asynchronous render silently teleported the caret of anyone typing
 * mid-draft. E2 makes it reachable a second way (the frame that closes the
 * completion menu after an accept), which is why E2 pays for it.
 *
 * These tests are the reason the mechanism lives here rather than inline in
 * `render()`: `main.ts` is not importable (see `docs/open-questions.md`), so a
 * caret restore written there would ship asserted by nothing at all. The
 * WIRING — that `render()` calls these two around the rebuild — is still
 * untested, and that is the same gap the module header names.
 */
describe("draftAnchor / restoreDraft — where the WRITER was", () => {
  const composer = (value: string, start: number, end = start) => {
    const input = document.createElement("textarea");
    document.body.append(input);
    input.value = value;
    input.setSelectionRange(start, end);
    return input;
  };

  it("carries the caret across a rebuild, not just the text", () => {
    // The defect, stated as the test: type `hello world`, put the caret after
    // `hello`, let a streamed delta land. Before this fix the caret was at 11
    // and the next keystroke appended to the end of someone else's sentence.
    const old = composer("hello world", 5);
    old.focus();
    const anchor = draftAnchor(old, document.activeElement);

    old.remove();
    const fresh = composer("", 0);
    restoreDraft(fresh, anchor);

    expect(fresh.value).toBe("hello world");
    expect(fresh.selectionStart).toBe(5);
    expect(fresh.selectionEnd).toBe(5);
  });

  it("proves the failure it fixes — A0's restore alone lands the caret at the end", () => {
    // Pins the browser behaviour the fix exists for, so a later reader who
    // wonders whether the restore is superfluous can see that it is not. This
    // is A0's restore, exactly: `composer()` builds a FRESH empty textarea and
    // `render()` assigned the captured draft onto it. The assignment changes
    // the value, so the text entry cursor moves to the end of the control.
    const old = composer("hello world", 5);
    const captured = old.value;
    old.remove();

    const fresh = composer("", 0);
    fresh.value = captured;
    expect(fresh.selectionStart).toBe(11);
  });

  it("carries a SELECTION, not merely a collapsed caret", () => {
    // A user who has selected a word and is about to overtype it has the same
    // claim on their state as one who has only a caret.
    const old = composer("hello world", 6, 11);
    const anchor = draftAnchor(old, document.activeElement);
    expect(anchor.start).toBe(6);
    expect(anchor.end).toBe(11);

    const fresh = composer("", 0);
    restoreDraft(fresh, anchor);
    expect(fresh.selectionStart).toBe(6);
    expect(fresh.selectionEnd).toBe(11);
  });

  it("restores focus when it was held, and NEVER steals it when it was not", () => {
    const other = document.createElement("button");
    document.body.append(other);

    const unfocused = composer("draft", 2);
    other.focus();
    const away = draftAnchor(unfocused, document.activeElement);
    expect(away.focused).toBe(false);

    const fresh = composer("", 0);
    restoreDraft(fresh, away);
    // The caret is still restored — value and caret are one fact, and leaving
    // them disagreeing means the next click into the box is the only repair.
    expect(fresh.selectionStart).toBe(2);
    expect(document.activeElement).toBe(other);

    const held = composer("draft", 2);
    held.focus();
    const kept = draftAnchor(held, document.activeElement);
    expect(kept.focused).toBe(true);
    const fresh2 = composer("", 0);
    restoreDraft(fresh2, kept);
    expect(document.activeElement).toBe(fresh2);
    expect(fresh2.selectionStart).toBe(2);
  });

  it("clamps a caret that no longer fits the text", () => {
    // The composer is not the only writer of `.value`: `composerPrefill`
    // replaces the draft wholesale, and `submit()` empties it. A stale offset
    // must land somewhere legal rather than throwing on the render path.
    const fresh = composer("", 0);
    restoreDraft(fresh, { text: "hi", focused: false, start: 99, end: 99 });
    expect(fresh.value).toBe("hi");
    expect(fresh.selectionStart).toBe(2);
  });

  it("leaves an emptied composer empty — a cleared draft is not restored", () => {
    // `submit()` clears the box and then renders. Re-assigning "" would be a
    // no-op, but the guard is what makes that true rather than incidental.
    const fresh = composer("", 0);
    restoreDraft(fresh, { text: "", focused: false, start: 0, end: 0 });
    expect(fresh.value).toBe("");
  });

  it("is safe with no composer at all — the four non-Assistant tabs", () => {
    expect(draftAnchor(undefined, null)).toEqual({
      text: "",
      focused: false,
      start: 0,
      end: 0,
    });
    expect(() =>
      restoreDraft(undefined, { text: "x", focused: true, start: 0, end: 0 }),
    ).not.toThrow();
  });
});
