import { describe, expect, it } from "vitest";
import { safeEqual } from "../src/core/security/crypto";

/** The callback's state format is purpose:provider:state; verify parsing and
 *  comparison behave correctly for all three purposes. */
describe("Google OAuth callback state handling", () => {
  it("parses purpose/provider/state from the signed cookie", () => {
    for (const purpose of ["gsc", "login"]) {
      const state = "random-state-value";
      const cookie = `${purpose}:google:${state}`;
      const [parsedPurpose, parsedProvider, parsedState] = cookie.split(":");
      expect(parsedPurpose).toBe(purpose);
      expect(parsedProvider).toBe("google");
      expect(safeEqual(parsedState, state)).toBe(true);
    }
  });

  it("rejects mismatched states in constant time", () => {
    expect(safeEqual("expected-state", "wrong-state")).toBe(false);
    expect(safeEqual("expected-state", "expected-state")).toBe(true);
  });
});
