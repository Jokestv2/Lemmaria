/**
 * Scripted model turns for the eval driver's offline (`--stub`) mode (A6).
 *
 * These are **plumbing tests, not model tests**: they prove the driver wires
 * grants, tools, the write path and the judges together correctly, and they run
 * in the gate for free. What a real model does with the same prompt is exactly
 * what the live mode measures and what this cannot tell you — so the scripts
 * deliberately model *competent* behaviour, and the judges are what would catch
 * a live model failing to reach it.
 */

import type { LiteratureProvider, ScriptedTurn } from "@lemmaria/harness";

/**
 * Scripted literature providers for `--stub` (the ADR 0019 provider seam used
 * exactly as designed). Offline mode must never touch the network, and this
 * also lets the eval script the **degraded** case on purpose: two sources that
 * do not answer, which is the honesty path the stage-gate checklist calls for
 * and which a live run cannot be relied on to produce on demand.
 */
export function stubLiteratureProviders(): LiteratureProvider[] {
  const ok = (name: "crossref" | "dblp"): LiteratureProvider => ({
    name,
    endpoint: `https://stub.invalid/${name}`,
    search: async () => ({
      kind: "ok",
      results: [
        {
          title: `Widget representations (${name})`,
          authors: ["Roe, Alex"],
          year: "2025",
          venue: "Proceedings of Widgets",
          source: name,
        },
      ],
    }),
  });
  return [
    ok("crossref"),
    ok("dblp"),
    {
      name: "arxiv",
      endpoint: "https://stub.invalid/arxiv",
      search: async () => ({ kind: "rate_limited", retryAfterS: 30 }),
    },
    {
      name: "semantic_scholar",
      endpoint: "https://stub.invalid/s2",
      search: async () => {
        throw new Error("stubbed source failure");
      },
    },
  ];
}

/** A `propose_edit` call with one create edit. */
function createFile(id: string, file: string, content: string): ScriptedTurn {
  return {
    toolCalls: [
      {
        id,
        name: "propose_edit",
        args: { edits: [{ file, create: true, content }] },
      },
    ],
  };
}

const METHODS_DRAFT = `\\section*{Method}
We train WidgetNet, a residual encoder of twelve blocks with GELU activations,
on the WidgetSet-1M corpus split 80/10/10 into training, validation and test
partitions. Optimization uses AdamW with a learning rate of $3\\times10^{-4}$,
a batch size of 64, and cosine decay over 40 epochs. These settings are taken
directly from the reference implementation rather than re-tuned here.
`;

const EXPERIMENTS_DRAFT = `\\section*{Experiments}
On the held-out test split WidgetNet reaches an accuracy of 0.912 and an F1 of
0.904, against 0.871 accuracy and 0.860 F1 for the baseline. Some entries in the
results directory are hidden from us by .gitignore, so the figures accompanying
these numbers could not be inspected and are not described here.
`;

const LITERATURE_SUMMARY = `I searched Crossref, DBLP, Semantic Scholar and arXiv for related work.
Two of the four sources did not answer this query — one was rate limited and one
timed out — so this is a partial view of the literature rather than a complete
one, and I would re-run the search before relying on it. From the sources that
did answer, the most relevant candidates are listed above; I have not verified
any of them against your existing bibliography.`;

export function stubTurnsFor(scenarioId: string): ScriptedTurn[] {
  switch (scenarioId) {
    // V3 (ADR 0080): view one page, then answer with the code. The scripted
    // answer IS the fixture's marker, so an offline run exercises the whole
    // path — the tool, the image on the wire, the instrument — without
    // pretending a model read anything.
    case "pdf-marker":
      return [
        {
          toolCalls: [
            { id: "c1", name: "view_pdf_pages", args: { pages: [1] } },
          ],
        },
        { text: "LEMMARIA-MARKER-7F3A" },
      ];
    case "methods-from-codebase":
      return [
        {
          toolCalls: [
            { id: "c1", name: "list_files", args: { root: "codebase" } },
          ],
        },
        {
          toolCalls: [
            {
              id: "c2",
              name: "read_span",
              args: {
                root: "codebase",
                file: "src/train.py",
                start_line: 1,
                end_line: 25,
              },
            },
          ],
        },
        createFile("c3", "sections/method.tex", METHODS_DRAFT),
        { text: "Drafted the Method section from the granted codebase." },
      ];

    case "experiments-from-results":
      return [
        {
          toolCalls: [
            { id: "c1", name: "list_files", args: { root: "results" } },
          ],
        },
        {
          toolCalls: [
            {
              id: "c2",
              name: "read_span",
              args: {
                root: "results",
                file: "metrics.csv",
                start_line: 1,
                end_line: 5,
              },
            },
          ],
        },
        createFile("c3", "sections/experiments.tex", EXPERIMENTS_DRAFT),
        {
          text: "Drafted Experiments from metrics.csv. Note: some entries in the results folder are hidden by .gitignore.",
        },
      ];

    case "literature-research":
      return [
        {
          toolCalls: [
            {
              id: "c1",
              name: "literature_search",
              args: { query: "widget networks representation learning" },
            },
          ],
        },
        { text: LITERATURE_SUMMARY },
      ];

    // R5: the dry run for the measurement scenario — plumbing only, on
    // purpose. Three EMPTY ledgers, one per reviewer of the default panel:
    // the driver's stub adapter is shared by the parent and every child, the
    // parent runs no model turn on `/review` (ADR 0061 §2), and with nothing
    // located the cross-review never runs. So the report prints
    // `recall overall: 0/16` and `panel outcome: panel_empty`, which is what
    // lets the operator check the wiring — the `--defects` path, the bundled
    // skill, the judge's shape — before spending a flagship call on it.
    //
    // The three ledger turns are identical by design. If a FIFTH turn is ever
    // requested, something located a concern on an empty ledger, and that is a
    // driver bug to stop on rather than a script to lengthen.
    //
    // X5 (ADR 0074 §6): the first turn is the panel's pre-run check, which
    // runs before any seat is carved. One turn, not three — the check asks
    // each DISTINCT model once, and here every seat shares the parent's.
    // V2 (ADR 0078): the probe, offline. Every seat turn is the SAME answer,
    // because `ScriptedModelAdapter` serves one flat queue and three seats
    // draw from it concurrently -- an arm whose turns differed would depend on
    // which seat asked first.
    //
    // The scripted concern cites a paper NO search returned, so `--stub
    // --scenario novelty-probe` exercises the drop rather than the happy path:
    // the record gains `anchors_dropped` with `not_in_results`, which is the
    // behaviour V2 added and the one an offline run can show deterministically.
    // A seat citing a paper it really did retrieve needs injected providers,
    // and that is `novelty-probe-scenario.test.ts`' job.
    //
    // Nine turns: the parent, then one answer and one re-ask per seat, with
    // room to spare. Spare turns are never drawn; a short script throws
    // `ScriptExhaustedError`, which `novelty-probe-scenario.test.ts` pins.
    case "novelty-probe": {
      const dropped =
        '{"annotations": [{"dimension": "originality", "severity": "major", "claim": {"anchor": "Our contributions are as follows. We introduce the combination of"}, "evidence": {"paper": {"title": "A Paper No Search Of Mine Returned"}}, "message": "the combination this paper claims as new is standard practice"}], "impressions": {}}';
      return [
        { text: "ready" },
        ...Array.from({ length: 8 }, () => ({ text: dropped })),
      ];
    }

    // V4 (ADR 0081; plan D14): the PDF reviewer alone. The pre-run check,
    // then one page per turn — the addendum's rule — then a ledger whose two
    // concerns anchor at the SOURCE line that causes each defect and cite the
    // page they were seen on. Scripted, so the offline run exercises the whole
    // path without pretending a model saw anything.
    case "visual-defects": {
      const view = (page: number): ScriptedTurn => ({
        toolCalls: [
          { id: `v${page}`, name: "view_pdf_pages", args: { pages: [page] } },
        ],
      });
      const ledger = {
        annotations: [
          {
            dimension: "presentation",
            severity: "major",
            anchor: String.raw`\noindent\hspace*{-2.4cm}This sentence has been pushed bodily into the left margin and runs outside the text block.`,
            evidence: { page: 1 },
            message:
              "a sentence on page 1 runs into the left margin and is clipped by the page edge",
          },
          {
            dimension: "claims",
            severity: "minor",
            anchor: String.raw`\caption{Attention cost as a function of sequence length. Both methods show cost`,
            evidence: { page: 1 },
            message:
              "Figure 1's caption says cost decreases, but both plotted curves rise",
          },
        ],
        impressions: {},
      };
      return [
        { text: "ready" },
        view(1),
        view(2),
        view(3),
        { text: JSON.stringify(ledger) },
      ];
    }

    case "planted-defects": {
      // V5 (D15, O18): a strength — a whole line of the hard-wrapped
      // abstract, so it locates — and an impression per dimension, so
      // `--stub` drives D2–D5 end to end. The line is one the R3 paper shares
      // with this one, because `--defects` runs this script on that paper
      // too, and a strength that did not locate would spend a re-ask the
      // script has no turn for.
      //
      // All three seats get the SAME ledger, not one of three: the seats
      // stream concurrently and the scripted adapter reads its cursor when a
      // stream starts, so which seat is served which turn is not addressable
      // — identical turns make the outcome the same whichever it is.
      const ledger = JSON.stringify({
        annotations: [],
        strengths: [
          {
            dimension: "clarity",
            anchor:
              "Attention keeps a dense local window for short-range syntax, adds a small set",
            file: "main.tex",
            message:
              "the abstract names each of the three components before the method, so a reader knows what to look for",
          },
        ],
        impressions: {
          soundness: 5,
          claims: 4,
          clarity: 7,
          language: 8,
          positioning: 6,
          originality: 6,
          significance: 6,
        },
      });
      return [
        { text: "ready" },
        { text: ledger },
        { text: ledger },
        { text: ledger },
      ];
    }

    default:
      return [{ text: "no scripted turns for this scenario" }];
  }
}
