import { type LoadedAction, loadActionSet } from "@lemmaria/harness";
import expandYaml from "@lemmaria/harness/actions/expand.yaml";
import fixCompileErrorYaml from "@lemmaria/harness/actions/fix-compile-error.yaml";
import polishYaml from "@lemmaria/harness/actions/polish.yaml";
import proofreadYaml from "@lemmaria/harness/actions/proofread.yaml";
import reviewYaml from "@lemmaria/harness/actions/review.yaml";
import shrinkToTargetYaml from "@lemmaria/harness/actions/shrink-to-target.yaml";
import translateYaml from "@lemmaria/harness/actions/translate.yaml";

/**
 * Built-in actions for the bundled extension. esbuild inlines the YAML as text
 * (loadBuiltinActions' import.meta.url dir walk does not survive the CJS
 * bundle), so built-ins flow through the same loadActionSet seam as user and
 * project actions.
 */
export function loadBundledActions(): LoadedAction[] {
  const { actions, errors } = loadActionSet({
    "built-in": [
      { path: "polish.yaml", content: polishYaml },
      { path: "shrink-to-target.yaml", content: shrinkToTargetYaml },
      { path: "expand.yaml", content: expandYaml },
      { path: "proofread.yaml", content: proofreadYaml },
      { path: "translate.yaml", content: translateYaml },
      { path: "review.yaml", content: reviewYaml },
      { path: "fix-compile-error.yaml", content: fixCompileErrorYaml },
    ],
  });
  if (errors.length > 0) {
    throw new Error(
      errors.map((e) => `${e.filePath}: ${e.message}`).join("; "),
    );
  }
  return actions;
}
