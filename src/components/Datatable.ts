/**
 * lightning-datatable component object (founding doc §7).
 * Rows located by accessible row text; cells by the stable data-label
 * attribute Salesforce stamps per column (survives label position changes).
 * Datatable internals are under active performance rework — this wrapper is
 * the single place to absorb that churn.
 */

import { expect, type Locator, type Page } from '@playwright/test';

export class Datatable {
  private readonly scope: Page | Locator;

  constructor(scope: Page | Locator) {
    this.scope = scope;
  }

  row(match: string | RegExp): Locator {
    return this.scope.getByRole('row', { name: match });
  }

  cell(rowMatch: string | RegExp, columnLabel: string): Locator {
    return this.row(rowMatch).locator(`[data-label="${columnLabel}"]`);
  }

  async expectCell(rowMatch: string | RegExp, columnLabel: string, value: string | RegExp) {
    await expect(this.cell(rowMatch, columnLabel)).toContainText(value);
  }

  /** Data rows only — header rows carry columnheader cells, not data-label cells. */
  get dataRows(): Locator {
    return this.scope.getByRole('row').filter({ has: this.scope.locator('[data-label]') });
  }

  async expectRowCount(count: number): Promise<void> {
    await expect(this.dataRows).toHaveCount(count);
  }
}
