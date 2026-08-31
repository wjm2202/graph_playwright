/**
 * Thin record-page object (founding doc §4.2, §9.2 tip: deep-link, don't
 * click-navigate). URL format /lightning/r/<Object>/<Id>/view is the standard
 * practice; Salesforce warns formats can change (historically low risk).
 */

import { expect, type Page } from '@playwright/test';
import { waitForSpinnersGone } from '../components/waits';

export class RecordPage {
  constructor(private readonly page: Page) {}

  static url(objectApiName: string, recordId: string): string {
    return `/lightning/r/${objectApiName}/${recordId}/view`;
  }

  static listUrl(objectApiName: string, filterName = 'Recent'): string {
    return `/lightning/o/${objectApiName}/list?filterName=${encodeURIComponent(filterName)}`;
  }

  /** Deep-link to a record and wait on app-visible readiness (not networkidle). */
  async open(objectApiName: string, recordId: string): Promise<void> {
    await this.page.goto(RecordPage.url(objectApiName, recordId));
    await waitForSpinnersGone(this.page);
  }

  /** The record header — presence proves the record actually rendered for this user. */
  async expectHeading(name: string | RegExp): Promise<void> {
    await expect(this.page.getByRole('heading', { name }).first()).toBeVisible();
  }
}
