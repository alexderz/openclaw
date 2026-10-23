import type { Page } from "playwright";

/** Transcript file links ask first: after tapping or pressing a link, choose "Open". */
export async function chooseChatFileLinkOpen(page: Page): Promise<void> {
  await page
    .locator(".chat-file-link-menu")
    .getByRole("menuitem", { name: "Open", exact: true })
    .click();
}
