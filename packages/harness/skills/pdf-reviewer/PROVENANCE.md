# Provenance — `pdf-reviewer`

**Written for:** milestone V4 ([ADR 0081](../../../../Lemmaria-design-doc/docs/adr/0081-the-pdf-reviewer.md)),
2026-09-23, as an addendum to `blind-reviewer` — never a second protocol.

**Sources of its ideas — ideas only, no text copied.**

- **[S6 — the PDF vision spike](../../../../Lemmaria-design-doc/docs/plans/91-v031-pdf-vision-spike.md) §§3–4**,
  Lemmaria's own measurement: a large hole on page 2 was found in 3 of 4
  page-at-a-time runs and in 0 of 6 single-batch runs, which is rule 2; page
  size and font size are facts in the PDF rather than things to be seen, and an
  unreferenced figure is a source property the text reviewers own, which is
  rule 1's *not yours* list.
- **AI Scientist-v2's VLM figure critique** (Yamada et al., arXiv:2504.08066 —
  source [14] of [90-v031-paperreview-study.md](../../../../Lemmaria-design-doc/docs/plans/90-v031-paperreview-study.md))
  and its recorded failure modes — reading values off plots, and
  believing a caption written from the conclusion — which is rule 3.

**Every sentence in `SKILL.md` and `SKILL.zh.md` is Lemmaria's own**, written
for its own ledger: rule 5's `{"page": N}` form is `interpretLedger`'s wire
format (ADR 0081 §4), and rule 4's *anchor in the source* is the protocol's
byte-exact anchor rule applied to a reviewer that sees the page but must quote
the source. Nothing upstream is shipped, vendored or redistributed.
