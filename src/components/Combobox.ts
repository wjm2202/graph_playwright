/**
 * lightning-combobox / picklist component object (founding doc §7).
 * NOT a native <select> — selectOption() does not work. The SLDS blueprint
 * renders a role=combobox trigger and a role=listbox popup of role=option
 * items; interaction is click-to-open, click-option.
 */

import { expect, type Locator, type Page } from '@playwright/test';

export class Combobox {
  private readonly scope: Page | Locator;

  constructor(
    scope: Page | Locator,
    private readonly label: string | RegExp,
  ) {
    this.scope = scope;
  }

  /** The role=combobox trigger, found by accessible name (release-resilient). */
  get trigger(): Locator {
    return this.scope.getByRole('combobox', { name: this.label });
  }

  /** Open the dropdown and pick an option by its visible text. */
  async select(option: string): Promise<void> {
    await this.trigger.click();
    const opt = this.scope.getByRole('option', { name: option, exact: true });
    await expect(opt).toBeVisible();
    await opt.click();
  }

  /** Assert the currently selected value (rendered on the trigger). */
  async expectValue(value: string | RegExp): Promise<void> {
    await expect(this.trigger).toContainText(value);
  }
}
