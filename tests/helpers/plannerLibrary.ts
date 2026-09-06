/**
 * The planner's built-in library, for harness tests.
 *
 * The built planner inlines `journeys/graphs/` as `window.GRAPH_LIBRARY` at
 * build time — and that folder ships EMPTY (real graphs are customer material
 * under the gitignored projects/). A harness test that needs graphs in the
 * rail hands the page the fixtures and refreshes the library the way the
 * planner does after a save: `state.library = net.localLibrary()`.
 */
import type { Page } from '@playwright/test';
import type { ProcessGraph } from '../../src/graph/schema';
import { loadFixture } from './fixtures';
import { goodGraphV2 } from './sampleGraph';

/** `ref → document`: the two fixture files plus the in-code SoD sample, as bare (legacy) refs. */
export function fixtureLibrary(): Record<string, ProcessGraph> {
  return {
    request_to_fulfilment: loadFixture('request_to_fulfilment'),
    imported_draft: loadFixture('imported_draft'),
    expense_to_siebel: goodGraphV2(),
  };
}

export async function injectLibrary(page: Page, lib: Record<string, ProcessGraph> = fixtureLibrary()): Promise<void> {
  await page.evaluate((docs) => {
    const w = window as unknown as {
      GRAPH_LIBRARY: Record<string, unknown>;
      P2: { state: { library: unknown }; net: { localLibrary(): unknown }; ui: { render(): void } };
    };
    w.GRAPH_LIBRARY = docs;
    w.P2.state.library = w.P2.net.localLibrary();
    w.P2.ui.render();
  }, lib);
}
