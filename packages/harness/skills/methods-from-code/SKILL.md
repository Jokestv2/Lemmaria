---
name: methods-from-code
description: How to write a Methods section that describes what an implementation actually does, without inventing detail the code does not support.
---

# Methods from an implementation

Write the Methods section from what the implementation actually does, in this order.

1. **State the problem setup before the method.** Name the inputs, the outputs, and
   what is held fixed. A reader who stops after this paragraph should still know what
   the method is for.
2. **Describe the procedure, not the code.** Name the steps a reader would have to
   reproduce. Class names, file names and function names belong in an artifact
   appendix, never in the Methods prose.
3. **Every number is traceable.** A hyperparameter, a dimension, a threshold or a
   learning rate goes in only when you have read the value. If you have not read it,
   write that it is unspecified rather than choosing a plausible one.
4. **Distinguish what is done from what is configurable.** A default in a config file
   is a default, not the experimental setting — say which one you are reporting.
5. **Name the deviations.** Where the implementation departs from the method it cites,
   say so. That is usually the contribution, and a reader who finds it themselves
   stops trusting the rest.
6. **Order the description by the data's path**, not by the order you happened to read
   the files in.

Do not describe behaviour you have not read. An unverified sentence in Methods is the
one a reviewer checks first, and the one that costs the paper its credibility when it
turns out to be a guess.
