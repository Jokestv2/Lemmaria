---
name: experiments-from-results
description: How to write an Experiments section whose every number comes from the results files, and which says what is missing instead of filling the gap.
---

# Experiments from a results directory

1. **Say what was run before you say how it did.** Datasets, splits, the number of
   runs, and what varies between them. A result with no stated setup cannot be
   compared to anything.
2. **Every number in the prose exists in a file you read.** Never round a number into
   existence, never average two numbers to get a third you did not find, and never
   carry a figure from an abstract you read into a table you are building.
3. **Report the spread, not just the centre.** If the results carry several runs, give
   the variance or the range. If they carry a single run, write that it is a single
   run — a lone number presented as a result implies a stability nobody measured.
4. **A missing number is reported as missing.** If a cell in your table has no source,
   leave it empty and say why in the caption. An invented cell is the failure this
   whole skill exists to prevent.
5. **If some entries could not be read** — hidden, excluded, unparseable — say so in
   the text. A results directory reported as empty when it was merely unreadable is a
   claim about the experiments that is not true.
6. **Comparisons need a stated basis.** "Ours is better" requires the same dataset,
   the same metric and the same split; when any of those differ, say which.
7. **Describe the trend before the table.** A reader should learn what happened from
   the prose and use the table to check it, not the other way round.
