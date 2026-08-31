/**
 * Toast component object (founding doc §3.2, §6).
 * Platform toasts auto-dismiss at 4.8s (9.6s with a link): assert IMMEDIATELY
 * after the triggering action, before any other waiting.
 */

import { expect, type Locator, type Page } from '@playwright/test';

const TOAST = '.slds-notify_toast';

export class Toast {
  constructor(private readonly page: Page) {}

  get root(): Locator {
    return this.page.locator(TOAST);
  }

  /** Assert a toast is visible and contains `text`. Call right after the action. */
  async expectMessage(text: string | RegExp, timeout = 12_000): Promise<void> {
    const toast = this.root.first();
    await expect(toast).toBeVisible({ timeout });
    await expect(toast).toContainText(text);
  }

  async expectSuccess(timeout = 12_000): Promise<void> {
    await expect(this.page.locator(`${TOAST}.slds-theme_success`).first()).toBeVisible({ timeout });
  }

  async expectError(timeout = 12_000): Promise<void> {
    await expect(this.page.locator(`${TOAST}.slds-theme_error`).first()).toBeVisible({ timeout });
  }
}
