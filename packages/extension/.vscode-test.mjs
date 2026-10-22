import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

/**
 * The ext-host suite drives the REAL session store, so every run leaves its
 * sessions in the test profile's globalStorage — and the profile persists
 * between runs, so they accumulate for ever (3.6k JSONL files by the time this
 * was noticed). `SessionStore.list()` validates every file on every listing by
 * design (ADR 0014: the files are the source of truth, the index is only an
 * accelerator), so that pile turned each listing into seconds of I/O and made
 * the suite's timeouts a coin flip.
 *
 * The profile is disposable local state, not a fixture: each run starts from an
 * empty store, which is also what an installed extension's first run looks like.
 */
rmSync(
  fileURLToPath(
    new URL(
      "./.vscode-test/user-data/User/globalStorage/lemmaria.lemmaria/sessions",
      import.meta.url,
    ),
  ),
  { recursive: true, force: true },
);

/**
 * E1: clear the profile's `globalState` too, for the same reason.
 *
 * `lemmaria.skills.disabled` is the first user selection this build persists in
 * `globalState` (ADR 0045), and `globalState` is the one piece of profile state
 * the two resets around it did NOT cover — it lives in `state.vscdb`, not in
 * `globalStorage/<extension id>/`. So a run that failed part-way through the
 * toggle tests left a skill disabled, and the NEXT run started with it still
 * off: `related-work` already in the selection makes a by-name toggle
 * re-ENABLE where the test expects it to disable. Found while re-running the
 * suite at E1's gate-review round — three consecutive runs, three different
 * single failures, each one the previous run's residue rather than a defect.
 *
 * VS Code recreates the file on launch, and everything in it (window layout,
 * view state) is disposable by the same argument as the sessions above.
 */
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  rmSync(
    fileURLToPath(
      new URL(
        `./.vscode-test/user-data/User/globalStorage/state.vscdb${suffix}`,
        import.meta.url,
      ),
    ),
    { force: true },
  );
}

/**
 * E1: point `~/.lemmaria` at disposable state inside the test profile.
 *
 * The `user` skills source is `~/.lemmaria/skills`, and without this the suite
 * would BOTH read whatever the developer running it happens to have installed
 * — making "the bundled set is exactly these three" depend on their machine —
 * and WRITE its own fixtures into their real home. Neither is acceptable in a
 * test, so `LEMMARIA_HOME` (the seam `skills-ui.ts` reads) is redirected here,
 * before the extension host starts and therefore before activation.
 *
 * Cleared on every run for the same reason the session store above is: it is
 * disposable local state, not a fixture.
 */
const home = fileURLToPath(
  new URL("./.vscode-test/lemmaria-home", import.meta.url),
);
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "skills"), { recursive: true });
process.env.LEMMARIA_HOME = home;

export default defineConfig({
  files: "out/test/**/*.test.js",
  version: "stable",
  launchArgs: ["--disable-extensions"],
  env: { LEMMARIA_HOME: home },
});
