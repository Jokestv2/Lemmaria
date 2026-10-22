import { describe, expect, it, vi } from "vitest";
import {
  type Candidate,
  MAX_ROWS,
  SIGIL_AT,
  SIGIL_SLASH,
  activeToken,
  commandCandidates,
} from "../src/webview/parts/completion.js";
import {
  MENU_ID,
  highlightAt,
  menuElement,
  menuHandles,
  menuRows,
  menuState,
  mountMenu,
  moveHighlight,
  reRank,
  rowId,
  scrollWindow,
  syncMenuAria,
  visibleRows,
} from "../src/webview/parts/menu.js";

const verb = (name: string): Candidate => ({
  name,
  description: `does ${name}`,
  kind: "command",
  group: "commands",
  command: "newSession",
});

const skill = (name: string, description = "a skill"): Candidate => ({
  name: `skill:${name}`,
  description,
  kind: "insert",
  group: "skills",
  insertion: `/skill:${name}`,
});

const token = (text: string, caret = text.length) => {
  const t = activeToken(text, caret, SIGIL_SLASH);
  if (!t) throw new Error(`no token in ${JSON.stringify(text)}`);
  return t;
};

const stateOf = (candidates: readonly Candidate[], text: string) =>
  menuState(token(text), SIGIL_SLASH, menuRows(candidates, token(text).query));

describe("menuRows — two groups, fixed order, ranked within (D3)", () => {
  const all = [verb("new"), verb("compact"), skill("tone"), skill("abstract")];

  it("puts every command before every skill, whatever the scores", () => {
    // A single merged ranking cannot have group headers, and §8 asks for them.
    // The fixed order is also the stable one: a score tie between a verb and a
    // skill would otherwise be broken by whatever the catalogue happened to
    // load.
    const groups = menuRows(all, "").map((r) => r.candidate.group);
    expect(groups).toEqual(["commands", "commands", "skills", "skills"]);
  });

  it("ranks WITHIN a group, so a better skill still sorts above a worse one", () => {
    const rows = menuRows([skill("bbb-a"), skill("abstract")], "abs");
    expect(rows[0]?.candidate.name).toBe("skill:abstract");
  });

  it("drops a group entirely when nothing in it matches", () => {
    const rows = menuRows(all, "tone");
    expect(rows.every((r) => r.candidate.group === "skills")).toBe(true);
  });

  it("returns nothing at all when nothing matches", () => {
    expect(menuRows(all, "zzzz")).toHaveLength(0);
  });
});

describe("the selection state machine", () => {
  const many = Array.from({ length: 12 }, (_, i) => skill(`s${i}`));

  it("starts on the first row, scrolled to the top", () => {
    const s = stateOf(many, "/");
    expect(s.index).toBe(0);
    expect(s.top).toBe(0);
  });

  it("moves down and up", () => {
    let s = stateOf(many, "/");
    s = moveHighlight(s, 1);
    expect(s.index).toBe(1);
    s = moveHighlight(s, -1);
    expect(s.index).toBe(0);
  });

  it("wraps off the top to the LAST row, and shows it", () => {
    const s = moveHighlight(stateOf(many, "/"), -1);
    expect(s.index).toBe(11);
    // The window must follow, or the highlight is off-screen and the menu
    // looks like it did nothing.
    expect(visibleRows(s).map((r) => r.candidate.name)).toContain("skill:s11");
  });

  it("wraps off the bottom back to the FIRST row, and scrolls back", () => {
    let s = stateOf(many, "/");
    for (let i = 0; i < 12; i++) s = moveHighlight(s, 1);
    expect(s.index).toBe(0);
    expect(s.top).toBe(0);
  });

  it("shows at most MAX_ROWS rows", () => {
    expect(visibleRows(stateOf(many, "/"))).toHaveLength(MAX_ROWS);
  });

  it("scrolls the window only once the highlight would leave it", () => {
    let s = stateOf(many, "/");
    for (let i = 0; i < MAX_ROWS - 1; i++) s = moveHighlight(s, 1);
    expect(s.index).toBe(MAX_ROWS - 1);
    expect(s.top).toBe(0);
    s = moveHighlight(s, 1);
    expect(s.top).toBe(1);
    expect(visibleRows(s)[MAX_ROWS - 1]?.candidate.name).toBe("skill:s8");
  });

  it("does not scroll at all when everything fits", () => {
    const few = [verb("new"), verb("compact")];
    let s = stateOf(few, "/");
    s = moveHighlight(s, -1);
    expect(s.top).toBe(0);
    expect(visibleRows(s)).toHaveLength(2);
  });

  it("survives an empty row set rather than dividing by zero", () => {
    const s = stateOf([verb("new")], "/zzz");
    expect(s.rows).toHaveLength(0);
    expect(moveHighlight(s, 1).index).toBe(0);
    expect(visibleRows(s)).toHaveLength(0);
  });
});

describe("menuHandles — an empty menu consumes only Esc", () => {
  it("lets Enter through when there is nothing to accept", () => {
    // `/foo` is prose and must still send (design §3: an unrecognised verb
    // stays prose). A menu that ate Enter because it happened to be open
    // would make an unmatched slash unsendable.
    const empty = stateOf([verb("new")], "/zzz");
    expect(menuHandles(empty, "accept")).toBe(false);
    expect(menuHandles(empty, "up")).toBe(false);
    expect(menuHandles(empty, "down")).toBe(false);
    expect(menuHandles(empty, "dismiss")).toBe(true);
  });

  it("handles everything once there is a row", () => {
    const s = stateOf([verb("new")], "/n");
    for (const a of ["accept", "up", "down", "dismiss"] as const) {
      expect(menuHandles(s, a)).toBe(true);
    }
  });
});

describe("menuElement — the DOM (design §7, §8)", () => {
  const on = { onPick: () => {}, onScroll: () => {}, onHover: () => {} };

  it("renders one selectable row per visible candidate", () => {
    const el = menuElement(
      stateOf([verb("new"), skill("tone")], "/"),
      "en",
      on,
    );
    const rows = el.querySelectorAll("button.lm-menu__row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("role")).toBe("option");
  });

  it("shows the sigil on the label, so a row reads as what it inserts", () => {
    const el = menuElement(stateOf([verb("new")], "/"), "en", on);
    expect(el.querySelector(".lm-menu__name")?.textContent).toBe("/new");
  });

  it("bolds the matched characters as ELEMENT NODES, never markup", () => {
    // §7: `check-webview-innerhtml` is deny-by-default with no allowlist, and
    // the webview's CSP has no 'unsafe-inline'. The highlight is built node by
    // node or it is not built.
    const el = menuElement(stateOf([verb("new")], "/nw"), "en", on);
    const name = el.querySelector(".lm-menu__name");
    const marks = [...(name?.querySelectorAll("strong.lm-menu__match") ?? [])];
    expect(marks.map((m) => m.textContent)).toEqual(["n", "w"]);
  });

  it("leaves the row's text identical whether or not it is highlighted", () => {
    // The highlight decorates; it must not add, drop or reorder a character.
    const plain = menuElement(stateOf([verb("new")], "/"), "en", on);
    const marked = menuElement(stateOf([verb("new")], "/nw"), "en", on);
    expect(marked.querySelector(".lm-menu__name")?.textContent).toBe(
      plain.querySelector(".lm-menu__name")?.textContent,
    );
  });

  it("keeps contiguous matched characters in ONE element", () => {
    const el = menuElement(stateOf([verb("new")], "/ne"), "en", on);
    const marks = [...el.querySelectorAll("strong.lm-menu__match")];
    expect(marks.map((m) => m.textContent)).toEqual(["ne"]);
  });

  it("marks the highlighted row, and only it", () => {
    const s = moveHighlight(stateOf([verb("new"), verb("compact")], "/"), 1);
    const rows = [
      ...menuElement(s, "en", on).querySelectorAll(".lm-menu__row"),
    ];
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    expect(rows[1]?.classList.contains("lm-menu__row--on")).toBe(true);
    expect(rows[0]?.classList.contains("lm-menu__row--on")).toBe(false);
  });

  it("gives every row an id, so the composer can point at the active one", () => {
    const el = menuElement(
      stateOf([verb("new"), verb("compact")], "/"),
      "en",
      on,
    );
    const ids = [...el.querySelectorAll(".lm-menu__row")].map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => i.length > 0)).toBe(true);
  });

  it("fires onPick with the row's index in the FULL list, not the window", () => {
    // The window scrolls; an index into it would select the wrong candidate
    // the moment the user has paged down.
    const onPick = vi.fn();
    const many = Array.from({ length: 12 }, (_, i) => skill(`s${i}`));
    let s = stateOf(many, "/");
    for (let i = 0; i < 9; i++) s = moveHighlight(s, 1);
    const el = menuElement(s, "en", {
      onPick,
      onScroll: () => {},
      onHover: () => {},
    });
    const rows = [...el.querySelectorAll<HTMLButtonElement>(".lm-menu__row")];
    rows[0]?.click();
    expect(onPick).toHaveBeenCalledWith(s.top);
  });

  it("takes a REAL mouse press, and preventDefaults it so focus stays put", () => {
    // The row is a `<button>`, and a real click blurs the textarea before it
    // fires. The composer's caret is what the splice is measured against, so
    // the accept runs on `mousedown` with `preventDefault` — and that
    // `preventDefault` IS the fix, not decoration. Neither jsdom nor the probe
    // covered this arm before E2's code review.
    const onPick = vi.fn();
    const el = menuElement(stateOf([verb("new")], "/"), "en", {
      onPick,
      onScroll: () => {},
      onHover: () => {},
    });
    const row = el.querySelector<HTMLButtonElement>(".lm-menu__row");
    if (!row) throw new Error("no row rendered");

    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    row.dispatchEvent(down);
    expect(onPick).toHaveBeenCalledWith(0);
    expect(down.defaultPrevented).toBe(true);

    // And the click that follows a real press does NOT pick a second time —
    // `detail` is 1 for a pointer, and only the 0 of an assistive activation
    // reaches the other arm.
    onPick.mockClear();
    row.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
    );
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps every row OUT of the tab order", () => {
    // `<button>` is tabbable by default, and the menu renders BEFORE the input
    // box inside `.lm-composer` — so a tabbable row makes Shift+Tab out of the
    // composer land on the last row instead of leaving the composer. That
    // undoes `menuKeyAction`'s modified-Tab decline one layer down, which is
    // the kind of wiring defect an assertion on the rule alone cannot see.
    const el = menuElement(
      stateOf([verb("new"), skill("tone")], "/"),
      "en",
      on,
    );
    const rows = [...el.querySelectorAll<HTMLButtonElement>(".lm-menu__row")];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, -1]);
  });

  it("carries the id the composer's aria-activedescendant has to resolve through", () => {
    // `aria-activedescendant` names an element that must be OWNED by the one
    // carrying it. A `<textarea>` owns nothing by containment, so the composer
    // points `aria-owns` at this id — and without the id the whole reference
    // is inert rather than merely imperfect.
    const el = menuElement(stateOf([verb("new")], "/"), "en", on);
    expect(el.id).toBe(MENU_ID);
    expect(el.getAttribute("role")).toBe("listbox");
  });

  it("heads each group, and only a group that has a visible row (D3)", () => {
    const both = menuElement(
      stateOf([verb("new"), skill("tone")], "/"),
      "en",
      on,
    );
    expect(
      [...both.querySelectorAll(".lm-menu__group")].map((g) => g.textContent),
    ).toEqual(["Commands", "Writing skills"]);

    const onlySkills = menuElement(
      stateOf([verb("new"), skill("tone")], "/tone"),
      "en",
      on,
    );
    expect(
      [...onlySkills.querySelectorAll(".lm-menu__group")].map(
        (g) => g.textContent,
      ),
    ).toEqual(["Writing skills"]);
  });

  it("makes a header unselectable, so arrow keys cannot land on one", () => {
    const el = menuElement(stateOf([verb("new")], "/"), "en", on);
    const header = el.querySelector(".lm-menu__group");
    expect(header?.tagName).toBe("DIV");
    expect(header?.getAttribute("role")).toBe("presentation");
  });

  it("says so when nothing matches, rather than rendering an empty box", () => {
    const el = menuElement(stateOf([verb("new")], "/zzz"), "en", on);
    // "No match", not "No matching command": the same box answers a skill
    // query (`/skill:zzz`), and naming only one of the two groups is wrong for
    // whichever group the user was actually in.
    expect(el.querySelector(".lm-menu__empty")?.textContent).toBe("No match");
    expect(el.querySelectorAll(".lm-menu__row")).toHaveLength(0);
  });

  it("writes its own chrome in Chinese under zh, with no English in it", () => {
    // Driven with the REAL verb rows, not a hand-made fixture: the group
    // heading and the empty state come from `menuElement`, the verb
    // descriptions from `commandCandidates`, and invariant 6 rule 2 governs
    // all three — so all three are read back here.
    const el = menuElement(
      menuState(token("/"), SIGIL_SLASH, menuRows(commandCandidates("zh"), "")),
      "zh",
      on,
    );
    const header = el.querySelector(".lm-menu__group")?.textContent ?? "";
    const desc = el.querySelector(".lm-menu__desc")?.textContent ?? "";
    const empty =
      menuElement(
        menuState(
          token("/zzz"),
          SIGIL_SLASH,
          menuRows(commandCandidates("zh"), "zzz"),
        ),
        "zh",
        on,
      ).querySelector(".lm-menu__empty")?.textContent ?? "";
    for (const s of [header, desc, empty]) {
      expect(s).toMatch(/[一-鿿]/);
      expect(s).not.toMatch(/[A-Za-z]{2,}\s+[A-Za-z]{2,}/);
    }
  });

  it("passes a mixed-script skill description through AS AUTHORED, under zh too", () => {
    // Invariant 6's stated boundary (E1, ADR 0045). The menu displays a
    // third party's description as theirs; rewriting or filtering it would be
    // Lemmaria putting words in someone else's mouth. 14 of 19 nature-skills
    // descriptions mix scripts, and locale-filtering them re-blocked them.
    const mixed = "Reference verifier · 检查参考文献 · DOI first";
    const el = menuElement(stateOf([skill("ref", mixed)], "/"), "zh", on);
    expect(el.querySelector(".lm-menu__desc")?.textContent).toBe(mixed);
  });

  it("is a listbox, so the row roles are legal", () => {
    const el = menuElement(stateOf([verb("new")], "/"), "en", on);
    expect(el.getAttribute("role")).toBe("listbox");
  });
});

describe("the `@` sigil and the paths group (E3, D5 / D7)", () => {
  const on = { onPick: () => {}, onScroll: () => {}, onHover: () => {} };

  const path = (name: string): Candidate => ({
    name,
    description: "",
    kind: "insert",
    group: "paths",
    insertion: name,
  });

  const atState = (text: string, rows: readonly Candidate[], note?: string) => {
    const t = activeToken(text, text.length, SIGIL_AT);
    if (!t) throw new Error(`no @ token in ${JSON.stringify(text)}`);
    return menuState(t, SIGIL_AT, menuRows(rows, t.query), note);
  };

  it("labels a row with the sigil the STATE carries, not one passed in", () => {
    // D7: the rule travels with the menu, so a menu cannot render as one sigil
    // and splice as another. The three `main.ts` call sites that used to name
    // `SIGIL_SLASH` read it from here instead.
    const el = menuElement(atState("@main", [path("main.tex")]), "en", on);
    expect(el.querySelector(".lm-menu__name")?.textContent).toBe("@main.tex");
  });

  it("renders the paths heading, and no description node", () => {
    const el = menuElement(atState("@", [path("a.tex")]), "en", on);
    expect(el.querySelector(".lm-menu__group")?.textContent).toBe(
      "Files and folders",
    );
    // A path has no description, and an EMPTY element would still take its gap
    // in the flex row — so it is omitted rather than emptied (D5).
    expect(el.querySelector(".lm-menu__desc")).toBeNull();
  });

  it("marks path rows with the modifier the stylesheet keys on", () => {
    const el = menuElement(atState("@", [path("a.tex")]), "en", on);
    const row = el.querySelector("button.lm-menu__row");
    expect(row?.classList.contains("lm-menu__row--path")).toBe(true);
    // And only path rows: a slug row must keep `white-space: nowrap`, because
    // its name IS what it inserts and truncating it would show a lie.
    const slug = menuElement(stateOf([skill("tone")], "/"), "en", on);
    expect(
      slug
        .querySelector("button.lm-menu__row")
        ?.classList.contains("lm-menu__row--path"),
    ).toBe(false);
  });

  it("bolds a match INSIDE the path, not a shared prefix", () => {
    // D5: because the qualifier lives inside the path (`codebase/results/…` is
    // a path, not a prefix plus a path), the ranker sees one string and needs
    // no change. A `g1:` prefix on every granted row would have been exactly
    // the pathological shared prefix `rank`'s own comment warns about.
    const el = menuElement(
      atState("@fin", [path("codebase/results/final.csv")]),
      "en",
      on,
    );
    const marks = [...el.querySelectorAll(".lm-menu__match")].map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(["fin"]);
  });

  it("renders a path byte-identical under zh — it is NOT Lemmaria's text", () => {
    // Invariant 6's stated boundary. The heading is Chinese; the path is the
    // filesystem's, whatever scripts it mixes, exactly as a skill description
    // is its author's.
    const mixed = "论文/results/final draft.csv";
    const el = menuElement(atState("@", [path(mixed)]), "zh", on);
    expect(el.querySelector(".lm-menu__group")?.textContent).toBe(
      "文件与文件夹",
    );
    expect(el.querySelector(".lm-menu__name")?.textContent).toBe(`@${mixed}`);
  });
});

describe("the note — what the list could not show (B4 / A6)", () => {
  const on = { onPick: () => {}, onScroll: () => {}, onHover: () => {} };
  const path = (name: string): Candidate => ({
    name,
    description: "",
    kind: "insert",
    group: "paths",
    insertion: name,
  });
  const atState = (text: string, rows: readonly Candidate[], note?: string) => {
    const t = activeToken(text, text.length, SIGIL_AT);
    if (!t) throw new Error("no @ token");
    return menuState(t, SIGIL_AT, menuRows(rows, t.query), note);
  };

  it("appends the note BELOW the rows, unselectable", () => {
    const el = menuElement(
      atState("@", [path("a.tex")], "12 hidden"),
      "en",
      on,
    );
    const line = el.querySelector(".lm-menu__note");
    expect(line?.textContent).toBe("12 hidden");
    expect(line?.getAttribute("role")).toBe("presentation");
    // Last child: it is about what the list does NOT contain, so it is a
    // footer rather than a header.
    expect(el.lastElementChild).toBe(line);
    // Unreachable by arrow keys by construction — `rows` holds candidates only.
    expect(el.querySelectorAll("button.lm-menu__row")).toHaveLength(1);
  });

  it("renders nothing at all when there is no note", () => {
    const el = menuElement(atState("@", [path("a.tex")]), "en", on);
    expect(el.querySelector(".lm-menu__note")).toBeNull();
  });

  it("REPLACES the generic empty line rather than stacking above it", () => {
    // Whatever the note says is the better answer to "why is this empty" —
    // nothing to reference at all, or entries a filter refused. "No match"
    // repeated above it explains nothing twice.
    const el = menuElement(
      atState("@zzz", [path("a.tex")], "none here"),
      "en",
      on,
    );
    expect(el.querySelector(".lm-menu__empty")).toBeNull();
    expect(el.querySelector(".lm-menu__note")?.textContent).toBe("none here");
  });

  it("still shows the generic empty line when nothing was hidden", () => {
    const el = menuElement(atState("@zzz", [path("a.tex")]), "en", on);
    expect(el.querySelector(".lm-menu__empty")?.textContent).toBe("No match");
  });
});

describe("mountMenu — reconciling the menu without rebuilding the composer", () => {
  // The operator's E-3 round found Ctrl+Z dead after accepting a completion.
  // Root cause: every menu interaction called `scheduleRender()`, `render()`
  // rebuilds `.lm-app`'s children wholesale, and `composer()` built a NEW
  // <textarea> each time. A browser's undo stack is per-element state that no
  // value-and-caret restore can carry, so the undoable `execCommand` splice was
  // thrown away one frame after it was made — and typing `/rel` had already
  // thrown away four more, one per keystroke, because the menu was open.
  //
  // These tests pin the property the fix establishes: reconciling the menu
  // leaves the textarea the SAME NODE. `main.ts` is not importable (the D2
  // DEFERRED entry), so the reconciliation is extracted here where it can be
  // asserted, exactly as `replaceScrollPreserving` and `restoreDraft` were.
  const composer = (): { root: HTMLElement; input: HTMLTextAreaElement } => {
    const root = document.createElement("div");
    root.className = "lm-composer";
    const box = document.createElement("div");
    box.className = "lm-composer__box";
    const input = document.createElement("textarea");
    input.className = "lm-input";
    box.append(input);
    root.append(box);
    return { root, input };
  };

  const on = { onPick: () => {}, onScroll: () => {}, onHover: () => {} };
  const menuNode = (): HTMLElement =>
    menuElement(stateOf([verb("new")], "/"), "en", on);

  it("inserts the menu without replacing the textarea node", () => {
    const { root, input } = composer();
    mountMenu(root, menuNode(), ".lm-composer__box");
    expect(root.querySelector(".lm-menu")).not.toBeNull();
    // `toBe`, not `toEqual`: node IDENTITY is the whole property. An equal but
    // different element is exactly the defect.
    expect(root.querySelector("textarea")).toBe(input);
  });

  it("removes the menu without replacing the textarea node", () => {
    const { root, input } = composer();
    mountMenu(root, menuNode(), ".lm-composer__box");
    mountMenu(root, undefined, ".lm-composer__box");
    expect(root.querySelector(".lm-menu")).toBeNull();
    expect(root.querySelector("textarea")).toBe(input);
  });

  it("keeps the textarea across a whole open→filter→filter→accept sequence", () => {
    // The operator's actual sequence: four keystrokes of `/rel` each refresh
    // the menu, then the accept closes it. Before the fix every one of those
    // was a rebuild; the undo stack could not survive the first.
    const { root, input } = composer();
    for (const _ of ["/", "/r", "/re", "/rel"]) {
      mountMenu(root, menuNode(), ".lm-composer__box");
      expect(root.querySelector("textarea")).toBe(input);
    }
    mountMenu(root, undefined, ".lm-composer__box");
    expect(root.querySelector("textarea")).toBe(input);
  });

  it("puts the menu BEFORE the box, so it rises out of the composer", () => {
    // The stylesheet positions `.lm-menu` with `bottom: 100%` against
    // `.lm-composer`; order is what keeps the geometry item 3 passed on.
    const { root } = composer();
    mountMenu(root, menuNode(), ".lm-composer__box");
    const kids = Array.from(root.children).map((c) => c.className);
    expect(kids.indexOf("lm-menu")).toBeLessThan(
      kids.indexOf("lm-composer__box"),
    );
  });

  it("replaces an open menu rather than stacking a second one", () => {
    const { root } = composer();
    mountMenu(root, menuNode(), ".lm-composer__box");
    mountMenu(root, menuNode(), ".lm-composer__box");
    expect(root.querySelectorAll(".lm-menu")).toHaveLength(1);
  });
});

describe("syncMenuAria — the composer's ARIA, updated without a render", () => {
  // These three attributes were set inside `composer()`, so they were only ever
  // correct because a render followed every menu change. With the render gone
  // they need their own home, and it has to clear them as well as set them.
  const input = () => document.createElement("textarea");

  it("names the open listbox and the active row", () => {
    const el = input();
    syncMenuAria(el, stateOf([verb("new"), verb("compact")], "/"));
    expect(el.getAttribute("aria-owns")).toBe(MENU_ID);
    expect(el.getAttribute("aria-expanded")).toBe("true");
    expect(el.getAttribute("aria-activedescendant")).toBe(rowId(0));
  });

  it("follows the highlight", () => {
    const el = input();
    const moved = moveHighlight(
      stateOf([verb("new"), verb("compact")], "/"),
      1,
    );
    syncMenuAria(el, moved);
    expect(el.getAttribute("aria-activedescendant")).toBe(rowId(1));
  });

  it("CLEARS all three when the menu closes", () => {
    // The half a set-only implementation forgets. A stale `aria-expanded` tells
    // a screen reader a list is open over a composer that has none.
    const el = input();
    syncMenuAria(el, stateOf([verb("new")], "/"));
    syncMenuAria(el, undefined);
    expect(el.hasAttribute("aria-owns")).toBe(false);
    expect(el.hasAttribute("aria-expanded")).toBe(false);
    expect(el.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("clears them for an EMPTY menu, which owns no row to point at", () => {
    const el = input();
    syncMenuAria(el, stateOf([verb("new")], "/zzzz"));
    expect(el.hasAttribute("aria-activedescendant")).toBe(false);
    expect(el.hasAttribute("aria-owns")).toBe(false);
  });
});

describe("scrollWindow — the mouse wheel over the menu", () => {
  // Operator request: the menu could only be moved with the arrow keys. It has
  // `overflow-y: auto` and a 268px box, but `visibleRows` puts at most MAX_ROWS
  // rows in the DOM at once, so eight rows always FIT — there was never
  // anything for the browser's own scrolling to do.
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => verb(`v${String(i).padStart(2, "0")}`));

  it("moves the window without moving the highlight", () => {
    // A wheel scrolls the VIEW; it does not choose. This is VS Code's own
    // suggest widget, which is what a user of this editor already has.
    const s = stateOf(many(12), "/");
    const scrolled = scrollWindow(s, 1);
    expect(scrolled.top).toBe(1);
    expect(scrolled.index).toBe(s.index);
  });

  it("stops at the end of the list rather than scrolling past it", () => {
    const s = stateOf(many(12), "/");
    expect(scrollWindow(s, 99).top).toBe(12 - MAX_ROWS);
  });

  it("stops at the top rather than going negative", () => {
    const s = stateOf(many(12), "/");
    expect(scrollWindow(scrollWindow(s, 2), -99).top).toBe(0);
  });

  it("does nothing when everything already fits", () => {
    // Six candidates is the default workspace — three verbs and three bundled
    // skills — so the wheel must be a no-op there rather than jitter the list.
    const s = stateOf(many(6), "/");
    expect(scrollWindow(s, 1)).toBe(s);
    expect(scrollWindow(s, -1)).toBe(s);
  });

  it("leaves an off-window highlight alone, so Enter still takes what ARIA names", () => {
    // Deliberate: the highlight is the user's choice and a scroll is not a
    // choice. `syncMenuAria` keeps naming it, so what Enter takes and what the
    // screen reader announces stay the same row.
    const s = stateOf(many(12), "/");
    const scrolled = scrollWindow(s, 5);
    expect(scrolled.index).toBe(0);
    expect(visibleRows(scrolled).map((r) => r.candidate.name)).not.toContain(
      "v00",
    );
  });

  it("an arrow key after a wheel brings the highlight back into view", () => {
    // The escape hatch that makes the previous test safe rather than a trap.
    const s = scrollWindow(stateOf(many(12), "/"), 5);
    const moved = moveHighlight(s, 1);
    expect(visibleRows(moved).map((r) => r.candidate.name)).toContain("v01");
  });
});

describe("the wheel, wired into the menu element", () => {
  const wheel = (node: HTMLElement, deltaY: number): boolean => {
    const e = new window.WheelEvent("wheel", { deltaY, cancelable: true });
    node.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("reports one notch down as +1 and one up as -1", () => {
    const seen: number[] = [];
    const node = menuElement(stateOf([verb("new")], "/"), "en", {
      onPick: () => {},
      onScroll: (d) => seen.push(d),
      onHover: () => {},
    });
    wheel(node, 120);
    wheel(node, -120);
    // Sign, not magnitude: a notch is a row whatever the device calls it.
    expect(seen).toEqual([1, -1]);
  });

  it("consumes the gesture, so the transcript behind does not scroll away", () => {
    const node = menuElement(stateOf([verb("new")], "/"), "en", {
      onPick: () => {},
      onScroll: () => {},
      onHover: () => {},
    });
    expect(wheel(node, 120)).toBe(true);
  });

  it("ignores a horizontal-only wheel rather than reporting a 0 notch", () => {
    const seen: number[] = [];
    const node = menuElement(stateOf([verb("new")], "/"), "en", {
      onPick: () => {},
      onScroll: (d) => seen.push(d),
      onHover: () => {},
    });
    expect(wheel(node, 0)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("is wired on the EMPTY menu too, which is still an overlay", () => {
    // `menuElement` returns early for an empty menu. The listener has to be
    // attached before that return, or hovering "No match" scrolls the
    // transcript underneath it.
    const seen: number[] = [];
    const node = menuElement(stateOf([verb("new")], "/zzzz"), "en", {
      onPick: () => {},
      onScroll: (d) => seen.push(d),
      onHover: () => {},
    });
    expect(node.querySelector(".lm-menu__empty")).not.toBeNull();
    expect(wheel(node, 120)).toBe(true);
    expect(seen).toEqual([1]);
  });
});

describe("reRank — a push must not move the highlight (E3 code review)", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    verb(`v${String(i).padStart(2, "0")}`),
  );

  it("keeps the index and the window across a rebuild", () => {
    // D6 makes a `contextPaths` push arrive a beat AFTER the `@` menu opens,
    // which is exactly when a fast user is arrowing. `menuState` resets to row
    // 0 — correct for a new token, wrong for a new candidate SET — and the
    // cost is that Enter takes a row the user never aimed at.
    let s = stateOf(many, "/");
    for (let i = 0; i < 10; i++) s = moveHighlight(s, 1);
    expect(s.index).toBe(10);
    const before = { index: s.index, top: s.top };

    const again = reRank(s, s.rows);
    expect(again.index).toBe(before.index);
    expect(again.top).toBe(before.top);
    // And the token is untouched — a push is not a user action (E2's D4).
    expect(again.token).toEqual(s.token);
  });

  it("CLAMPS the index when the new set is shorter", () => {
    // A revoked grant makes the list shorter than the index; `index` must stay
    // addressable or `rows[index]` is undefined on the next Enter.
    let s = stateOf(many, "/");
    for (let i = 0; i < 15; i++) s = moveHighlight(s, 1);
    const shrunk = reRank(s, s.rows.slice(0, 3));
    expect(shrunk.index).toBe(2);
    expect(shrunk.top).toBe(0);
    expect(shrunk.rows[shrunk.index]).toBeDefined();
  });

  it("survives the set emptying entirely", () => {
    let s = stateOf(many, "/");
    for (let i = 0; i < 5; i++) s = moveHighlight(s, 1);
    const gone = reRank(s, []);
    expect(gone.rows).toEqual([]);
    expect(gone.index).toBe(0);
    expect(gone.top).toBe(0);
  });

  it("keeps the preserved index VISIBLE in the window", () => {
    // Preserving `index` without checking `top` would scroll the highlight off
    // screen — the same invariant `moveHighlight` maintains, stated here
    // because a different function now also writes both fields.
    let s = stateOf(many, "/");
    for (let i = 0; i < 12; i++) s = moveHighlight(s, 1);
    const again = reRank(s, s.rows.slice(0, 14));
    expect(again.index).toBeGreaterThanOrEqual(again.top);
    expect(again.index).toBeLessThan(again.top + MAX_ROWS);
  });

  it("carries the note through, and drops it when it is gone", () => {
    const s = stateOf(many, "/");
    expect(reRank(s, s.rows, "3 more not shown").note).toBe("3 more not shown");
    expect(reRank(s, s.rows).note).toBeUndefined();
  });
});

describe("hover — the pointer must be able to aim before it picks", () => {
  // Operator round, 2026-08-26: the wheel scrolled the menu but hovering a row
  // did nothing, so the mouse could move the list without being able to choose
  // from it.
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => verb(`v${String(i).padStart(2, "0")}`));

  const move = (node: HTMLElement, i: number, x: number, y: number) => {
    const rows = node.querySelectorAll<HTMLElement>(".lm-menu__row");
    rows[i]?.dispatchEvent(
      new window.MouseEvent("mousemove", {
        clientX: x,
        clientY: y,
        bubbles: true,
      }),
    );
  };

  it("highlightAt moves the highlight and leaves the window alone", () => {
    // The row was pointed at, so it is visible by construction — recomputing
    // `top` would shift the list under the pointer mid-aim.
    const s = scrollWindow(stateOf(many(12), "/"), 3);
    const hovered = highlightAt(s, 5);
    expect(hovered.index).toBe(5);
    expect(hovered.top).toBe(s.top);
  });

  it("highlightAt ignores an index off the end", () => {
    const s = stateOf(many(3), "/");
    expect(highlightAt(s, 9)).toBe(s);
    expect(highlightAt(s, -1)).toBe(s);
  });

  it("reports the ABSOLUTE row index, not the one within the window", () => {
    // The same bug `onPick` had to avoid: the visible eight are a slice.
    const seen: number[] = [];
    const scrolled = scrollWindow(stateOf(many(12), "/"), 3);
    const node = menuElement(scrolled, "en", {
      onPick: () => {},
      onScroll: () => {},
      onHover: (i) => seen.push(i),
    });
    move(node, 0, 10, 10);
    expect(seen).toEqual([scrolled.top]);
  });

  it("a STATIONARY pointer does not steal the highlight when the menu re-mounts", () => {
    // The whole reason this is `mousemove` plus a coordinate guard rather than
    // `mouseenter`: the menu is re-mounted on every keystroke, and a browser
    // fires enter/over at a pointer that has not moved when the node under it
    // is replaced. Without the guard, typing would yank the highlight to
    // wherever the mouse happened to be resting.
    const seen: number[] = [];
    const on2 = {
      onPick: () => {},
      onScroll: () => {},
      onHover: (i: number) => seen.push(i),
    };
    const first = menuElement(stateOf(many(12), "/"), "en", on2);
    move(first, 2, 40, 40);
    expect(seen).toEqual([2]);
    // A rebuild, then the same coordinates again — the pointer never moved.
    const second = menuElement(stateOf(many(12), "/"), "en", on2);
    move(second, 5, 40, 40);
    expect(seen).toEqual([2]);
    // A real move is still reported.
    move(second, 5, 41, 40);
    expect(seen).toEqual([2, 5]);
  });
});
