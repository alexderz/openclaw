import { describe, expect, it } from "vitest";
import {
  promotionProjection,
  type PromotionFixtureKind,
} from "../lib/sessions/session-promotion.test-support.ts";
import { resolveSidebarPromotionMark } from "./app-sidebar-session-types.ts";

describe("resolveSidebarPromotionMark", () => {
  it.each([
    ["authorized-none", "limited"],
    ["authorized-pending", "pending"],
  ] as const satisfies readonly (readonly [PromotionFixtureKind, string])[])(
    "marks a %s row %s",
    (kind, mark) => {
      expect(resolveSidebarPromotionMark(promotionProjection(kind))).toBe(mark);
    },
  );

  it("leaves ordinary, promoted, unknown and unprojected rows unmarked", () => {
    const base = promotionProjection("authorized-none");
    expect(resolveSidebarPromotionMark(undefined)).toBeUndefined();
    expect(resolveSidebarPromotionMark(promotionProjection("promoted-detached"))).toBeUndefined();
    expect(
      resolveSidebarPromotionMark({
        ...base,
        effectiveClass: "ordinary",
        historicalOrigin: "ordinary",
      }),
    ).toBeUndefined();
    expect(
      resolveSidebarPromotionMark({
        ...base,
        effectiveClass: "ordinary",
        promotionState: "activated",
      }),
    ).toBeUndefined();
    expect(
      resolveSidebarPromotionMark({
        ...base,
        effectiveClass: "unknown",
        promotionState: "blocked",
      }),
    ).toBeUndefined();
  });

  it("keeps a promotion activated for someone else limited for this viewer", () => {
    expect(
      resolveSidebarPromotionMark({
        ...promotionProjection("authorized-none"),
        effectiveClass: "delegated",
        promotionState: "activated",
      }),
    ).toBe("limited");
  });
});
