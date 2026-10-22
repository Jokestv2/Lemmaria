import { describe, expect, it } from "vitest";
import { ADAPTERS_PACKAGE_NAME } from "../src/index.js";

describe("@lemmaria/adapters", () => {
  it("exports its package name", () => {
    expect(ADAPTERS_PACKAGE_NAME).toBe("@lemmaria/adapters");
  });
});
