/**
 * R3 — distiller: every recognizer on synthetic events, settle attribution
 * windows, duration semantics, raw flagging, and an integration pass over the
 * committed fixture trace (reader → distiller end-to-end).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { distill, networkFamily } from '../../src/pipeline/distill';
import { readTrace, type RawEvent } from '../../src/pipeline/traceReader';

const click = (selector: string, startMs: number, endMs: number): RawEvent =>
  ({ kind: 'action', api: 'click', selector, startMs, endMs });
const fill = (selector: string, value: string, startMs: number, endMs: number): RawEvent =>
  ({ kind: 'action', api: 'fill', selector, value, startMs, endMs });
const net = (url: string, method: string, startMs: number, endMs: number): RawEvent =>
  ({ kind: 'network', url, method, status: 200, startMs, endMs });

test.describe('recognizers', () => {
  test('combobox.select consumes the trigger + option pair', () => {
    const d = distill([
      click('internal:role=combobox[name="Stage"i]', 100, 120),
      click('internal:role=option[name="Closed Won"i]', 130, 160),
    ]);
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0]).toMatchObject({
      catalog: 'combobox.select',
      args: { label: 'Stage', option: 'Closed Won' },
      recognized: true,
      startMs: 100,
      endMs: 160,
      durationMs: 60,
      sourceEvents: [0, 1],
    });
  });

  test('a combobox click NOT followed by an option stays a ui.click', () => {
    const d = distill([
      click('internal:role=combobox[name="Stage"i]', 100, 120),
      click('internal:role=button[name="Cancel"i]', 130, 160),
    ]);
    expect(d.steps.map((s) => s.catalog)).toEqual(['ui.click', 'ui.click']);
  });

  test('form.fill maps label + typed value into args', () => {
    const d = distill([fill('internal:label="Amount"i', '4999', 10, 30)]);
    expect(d.steps[0]).toMatchObject({ catalog: 'form.fill', args: { label: 'Amount', value: '4999' } });
  });

  test('recordPage.open parses sobject + id from LEX record URLs and harvests the id', () => {
    const d = distill([
      { kind: 'nav', url: 'https://x.my.salesforce.com/lightning/r/Expense__c/a03xx0000012AbCDEF/view', startMs: 0, endMs: 50 },
    ]);
    expect(d.steps[0]).toMatchObject({ catalog: 'recordPage.open', args: { sobject: 'Expense__c', id: 'a03xx0000012AbCDEF' } });
    expect(d.harvestedIds).toEqual([{ id: 'a03xx0000012AbCDEF', sobject: 'Expense__c', firstEvent: 0 }]);
    expect(d.flags.join()).toContain('literal record id a03xx0000012AbCDEF');
  });

  test('non-record navigation stays nav.goto', () => {
    const d = distill([{ kind: 'nav', url: 'https://x.my.salesforce.com/lightning/page/home', startMs: 0, endMs: 10 }]);
    expect(d.steps[0]).toMatchObject({ catalog: 'nav.goto', args: { url: 'https://x.my.salesforce.com/lightning/page/home' } });
  });

  test('modal.save attributes the following aura burst as its settle signal', () => {
    const d = distill([
      click('internal:role=button[name="Save"i]', 100, 130),
      net('https://x.my.salesforce.com/aura?r=3', 'POST', 140, 900),
      net('https://x.my.salesforce.com/aura?r=4', 'POST', 150, 400),
      click('internal:role=button[name="Close"i]', 1000, 1010),
    ]);
    const save = d.steps[0];
    expect(save!.catalog).toBe('modal.save');
    expect(save!.settle).toEqual({ family: 'aura', method: 'POST', observedCount: 2 });
    // duration runs to the end of the burst, not the click ack:
    expect(save!.durationMs).toBe(800);
    expect(save!.sourceEvents).toEqual([0, 1, 2]);
    // the burst does NOT leak into the next step:
    expect(d.steps[1]).toMatchObject({ catalog: 'ui.click', durationMs: 10 });
  });

  test('network outside the window is not attributed', () => {
    const d = distill([
      click('internal:role=button[name="Save"i]', 100, 130),
      click('internal:role=button[name="Next"i]', 200, 230),
      net('https://x.my.salesforce.com/aura', 'POST', 250, 300), // belongs to Next
    ]);
    expect(d.steps[0]!.settle).toBeUndefined();
    expect(d.steps[1]!.settle).toEqual({ family: 'aura', method: 'POST', observedCount: 1 });
  });

  test('save-ish vocabulary covers Submit/Confirm/Next', () => {
    const d = distill([
      click('internal:role=button[name="Submit for Approval"i]', 0, 10),
      click('internal:role=button[name="Confirm"i]', 20, 30),
    ]);
    expect(d.steps.map((s) => s.catalog)).toEqual(['modal.save', 'modal.save']);
    expect(d.steps[0]!.args).toEqual({ button: 'Submit for Approval' });
  });

  test('semantically addressable clicks become ui.click with a typed target', () => {
    const d = distill([
      click('internal:role=tab[name="Details"i]', 0, 5),
      click('internal:text="Related"i', 10, 15),
      click('internal:testid=[data-testid="expense-row"s]', 20, 25),
    ]);
    expect(d.steps.map((s) => [s.catalog, s.args])).toEqual([
      ['ui.click', { role: 'tab', name: 'Details' }],
      ['ui.click', { text: 'Related' }],
      ['ui.click', { testId: 'expense-row' }],
    ]);
  });

  test('unparseable selectors become RAW, flagged for naming', () => {
    const d = distill([click('div.slds-weird > span:nth-child(3)', 0, 5)]);
    expect(d.steps[0]).toMatchObject({ kind: 'raw', catalog: 'raw.name_me', recognized: false, flag: 'name-me' });
    expect(d.flags.join()).toContain('name it to grow the grammar');
  });
});

test.describe('networkFamily', () => {
  test('families map correctly', () => {
    expect(networkFamily('https://x/aura?r=1')).toBe('aura');
    expect(networkFamily('https://x/s/sfsites/aura')).toBe('aura');
    expect(networkFamily('https://x/services/data/v61.0/sobjects/Account')).toBe('services_data');
    expect(networkFamily('https://x/lightning/r/Account/1/view')).toBe('lightning_nav');
    expect(networkFamily('https://x/analytics/beacon')).toBe('other');
  });
});

test.describe('integration: fixture trace → distilled journey', () => {
  test('reader + distiller produce the recorded flow end-to-end', () => {
    const data = readTrace(path.resolve(__dirname, '../fixtures/trace-demo/trace.zip'));
    const d = distill(data.events);

    expect(d.steps.map((s) => s.catalog)).toEqual([
      'recordPage.open', // nav to /lightning/r/Account/001FIXTURE0000001/view
      'form.fill',       // Amount = 4999
      'combobox.select', // Stage → Closed Won
      'modal.save',      // Save + aura POST settle
    ]);
    expect(d.steps[1]!.args).toEqual({ label: 'Amount', value: '4999' });
    expect(d.steps[2]!.args).toEqual({ label: 'Stage', option: 'Closed Won' });
    expect(d.steps[3]!.settle).toMatchObject({ family: 'aura', method: 'POST' });
    expect(d.harvestedIds[0]).toMatchObject({ id: '001FIXTURE0000001', sobject: 'Account' });
    expect(d.steps.every((s) => s.durationMs >= 0)).toBe(true);
  });
});
