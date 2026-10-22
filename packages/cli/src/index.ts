import type { ActionDefinition } from "@lemmaria/harness";

export const CLI_PACKAGE_NAME = "@lemmaria/cli";
/** M3 runs actions here; the import pins the M1 contract seam. */
export type { ActionDefinition };
export {
  FsWorkspace,
  STUB_BINDING,
  runCliAction,
  type CliRunOptions,
} from "./run-action.js";
export { main } from "./main.js";
