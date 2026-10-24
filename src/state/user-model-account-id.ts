import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";

const UUID_PATTERN = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
/** Mint prefix from connectUserModelAccount. Case-sensitive; `Personal:` is a different name. */
const PERSONAL_AUTH_PROFILE_PREFIX = "personal:";
const PERSONAL_AUTH_PROFILE_PATTERN = new RegExp(
  `^${PERSONAL_AUTH_PROFILE_PREFIX}(${UUID_PATTERN}|${GATEWAY_OWNER_PROFILE_ID}):${UUID_PATTERN}$`,
  "u",
);

/** Every minted personal id, including a legacy owner segment the locator grammar rejects. */
export function hasPersonalAuthProfilePrefix(authProfileId: string): boolean {
  return authProfileId.startsWith(PERSONAL_AUTH_PROFILE_PREFIX);
}

// Reserve only generated locators; shared profile names such as personal:work remain valid names.
export function isUserModelAuthProfileId(authProfileId: string): boolean {
  return parseUserModelAuthProfileId(authProfileId) !== undefined;
}

/** A storage locator only; the live owner and exact credential still need to exist. */
export function parseUserModelAuthProfileId(
  authProfileId: string,
): { ownerProfileId: string } | undefined {
  const ownerProfileId = PERSONAL_AUTH_PROFILE_PATTERN.exec(authProfileId)?.[1];
  return ownerProfileId ? { ownerProfileId } : undefined;
}
