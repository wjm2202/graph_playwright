/**
 * Modal component object (founding doc §7).
 * All interaction is scoped to role=dialog so strict mode never collides with
 * same-named elements on the page behind. Never click by coordinates —
 * WCAG 2.2 changes (Summer '25) make modals reflow at zoom.
 */

import { expect, type Locator, type Page } from '@playwright/test';

export class Modal {
  constructor(private readonly page: Page) {}

  get root(): Locator {
    return this.page.getByRole('dialog');
  }

  async expectOpen(title?: string | RegExp): Promise<void> {
    await expect(this.root).toBeVisible();
    if (title) await expect(this.root.getByRole('heading', { name: title })).toBeVisible();
  }

  async fillLabel(label: string | RegExp, value: string): Promise<void> {
    await this.root.getByLabel(label).fill(value);
  }

  async clickButton(name: string | RegExp): Promise<void> {
    await this.root.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }

  /** Save-and-close in one motion; asserts the modal actually went away. */
  async saveAndExpectClosed(saveLabel: string | RegExp = 'Save', timeout = 15_000): Promise<void> {
    await this.clickButton(saveLabel);
    await expect(this.root).toBeHidden({ timeout });
  }
}
