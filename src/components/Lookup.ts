/**
 * Lookup / typeahead component object (founding doc §7).
 * Renders as a combobox-style search input; typing fires an async search XHR
 * that populates a role=listbox. Playwright auto-wait on the option replaces
 * hardcoded sleeps.
 */

import { expect, type Locator, type Page } from '@playwright/test';

export class Lookup {
  constructor(
    private readonly scope: Page | Locator,
    private readonly label: string | RegExp,
  ) {}

  get input(): Locator {
    return this.scope.getByRole('combobox', { name: this.label });
  }

  /** Type a query and select the first option matching `optionText` (defaults to the query). */
  async search(query: string, optionText?: string | RegExp): Promise<void> {
    await this.input.click();
    await this.input.fill(query);
    const name = optionText ?? new RegExp(escapeRegex(query), 'i');
    const opt = this.scope.getByRole('option', { name }).first();
    await expect(opt).toBeVisible();
    await opt.click();
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
