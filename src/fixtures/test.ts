/**
 * Fixture composition (founding doc §9.1): POM for structure, fixtures for
 * wiring — no inheritance chains. Specs import { test, expect } from here.
 *
 * The `lightning` fixture bundles the component objects so specs read as
 * intent: await lightning.combobox('Stage').select('Closed Won').
 */

import { test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { Combobox } from '../components/Combobox';
import { Lookup } from '../components/Lookup';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { Datatable } from '../components/Datatable';
import { waitForSpinnersGone, auraResponsePromise } from '../components/waits';
import { RecordPage } from '../pages/RecordPage';

export class Lightning {
  constructor(readonly page: Page) {}

  combobox(label: string | RegExp, scope: Page | Locator = this.page): Combobox {
    return new Combobox(scope, label);
  }

  lookup(label: string | RegExp, scope: Page | Locator = this.page): Lookup {
    return new Lookup(scope, label);
  }

  get modal(): Modal {
    return new Modal(this.page);
  }

  get toast(): Toast {
    return new Toast(this.page);
  }

  datatable(scope: Page | Locator = this.page): Datatable {
    return new Datatable(scope);
  }

  get recordPage(): RecordPage {
    return new RecordPage(this.page);
  }

  waitForIdle(scope: Page | Locator = this.page): Promise<void> {
    return waitForSpinnersGone(scope);
  }

  /** Set up BEFORE the triggering action. */
  auraResponse() {
    return auraResponsePromise(this.page);
  }
}

export const test = base.extend<{ lightning: Lightning }>({
  lightning: async ({ page }, use) => {
    await use(new Lightning(page));
  },
});

export { expect } from '@playwright/test';
