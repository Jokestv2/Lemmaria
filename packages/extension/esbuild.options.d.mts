/**
 * Types for `esbuild.options.mjs`, so `test-bundle/` can import the SHIPPED
 * build options under `tsc --noEmit` (V3, ADR 0080 §9).
 *
 * A declaration file rather than `allowJs`: the options module is one literal,
 * and turning on `allowJs` for the whole webview-test project to type it would
 * pull every other `.mjs` at the package root into the program.
 */
import type { BuildOptions } from "esbuild";

export declare const extensionBuildOptions: BuildOptions;
