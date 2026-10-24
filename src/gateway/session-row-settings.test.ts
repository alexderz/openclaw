import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { projectSessionAuthProfile } from "./session-row-settings.js";

function entry(
  authProfileOverride: string,
  source?: SessionEntry["authProfileOverrideSource"],
): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 1,
    authProfileOverride,
    ...(source ? { authProfileOverrideSource: source } : {}),
  };
}

describe("projectSessionAuthProfile", () => {
  it("redacts a personal id whose owner segment is not a UUID", () => {
    const legacy = "personal:legacy-owner:cred-locator-1";
    const projected = projectSessionAuthProfile(entry(`  ${legacy}  `, "user-link"));
    expect(projected).toEqual({ kind: "personal", source: "user-link" });
    expect(projected).not.toHaveProperty("label");
    const json = JSON.stringify(projected);
    expect(json).not.toContain("legacy-owner");
    expect(json).not.toContain("cred-locator-1");
  });

  it("redacts every case-sensitive personal: id and leaves other names visible", () => {
    expect(projectSessionAuthProfile(entry("personal:work", "user"))).toEqual({
      kind: "personal",
      source: "user",
    });
    expect(projectSessionAuthProfile(entry("Personal:legacy-owner:cred-locator-1"))).toEqual({
      kind: "named",
      label: "Personal:legacy-owner:cred-locator-1",
      source: "user",
    });
    expect(projectSessionAuthProfile(entry("row-fixture:work", "auto"))).toEqual({
      kind: "named",
      label: "row-fixture:work",
      source: "auto",
    });
    expect(projectSessionAuthProfile({ sessionId: "session", updatedAt: 1 })).toBeUndefined();
  });
});
