import { describe, expect, it } from "vitest";
import type { NoticeItem, SessionLocale } from "../../src/contracts/index.js";
import { NOTICE_MESSAGES } from "../../src/session/notices.js";

/**
 * The harness's notice fallback table, checked for the one property it exists
 * to have: **one language per reader** (invariant 6 rule 2, ADR 0034), with no
 * code reachable in one locale and not the other.
 *
 * Written at X5, which adds five `review.*` codes. The table is a
 * `Record<SessionLocale, Record<NoticeItem["code"], …>>`, so `pnpm typecheck`
 * already refuses a code missing from either locale — what it cannot refuse is
 * a code present with an EMPTY string, or one whose two locales are the same
 * untranslated English.
 */
const LOCALES: SessionLocale[] = ["en", "zh"];

describe("NOTICE_MESSAGES", () => {
  it("gives every code a non-empty message in both locales", () => {
    for (const locale of LOCALES) {
      const table = NOTICE_MESSAGES[locale];
      const codes = Object.keys(table) as NoticeItem["code"][];
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(table[code](3).trim(), `${locale} / ${code}`).not.toBe("");
      }
    }
  });

  it("carries the same code set in both locales", () => {
    expect(Object.keys(NOTICE_MESSAGES.en).sort()).toEqual(
      Object.keys(NOTICE_MESSAGES.zh).sort(),
    );
  });

  it("renders every review.* notice in the reader's own language", () => {
    const codes = (
      Object.keys(NOTICE_MESSAGES.en) as NoticeItem["code"][]
    ).filter((code) => code.startsWith("review."));
    // X5 adds five to R3's four; a sixth is welcome, four would mean one was
    // lost, and the whole point of the row is that it is checked by count.
    expect(codes.length).toBeGreaterThanOrEqual(9);
    for (const code of codes) {
      const en = NOTICE_MESSAGES.en[code](2);
      const zh = NOTICE_MESSAGES.zh[code](2);
      expect(en, code).not.toBe(zh);
      // A Chinese reader is never handed an English sentence, and an English
      // reader is never handed CJK — a string carrying both is the defect
      // invariant 6 rule 2 names.
      expect(/[一-鿿]/.test(en), `en / ${code}`).toBe(false);
      expect(/[一-鿿]/.test(zh), `zh / ${code}`).toBe(true);
    }
  });

  it("interpolates the number its sentence names", () => {
    for (const locale of LOCALES) {
      expect(NOTICE_MESSAGES[locale]["review.seat_budget"](512)).toContain(
        "512",
      );
    }
  });

  it("V1: warns about a starved verifier in both locales, naming the carve", () => {
    // `review.verifier_budget` mirrors `review.seat_budget` with verification
    // as its subject (ADR 0076): a warning, and the panel still runs.
    for (const locale of LOCALES) {
      const text = NOTICE_MESSAGES[locale]["review.verifier_budget"](777);
      expect(text, locale).toContain("777");
    }
    expect(NOTICE_MESSAGES.en["review.verifier_budget"](777)).toMatch(/verif/i);
    expect(NOTICE_MESSAGES.zh["review.verifier_budget"](777)).toContain("核查");
  });
});
