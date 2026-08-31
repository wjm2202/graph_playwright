import { test, expect } from '@playwright/test';
import { isAuraActionUrl } from '../../src/components/waits';

test.describe('isAuraActionUrl', () => {
  test('matches LEX and portal Aura endpoints, incl. custom site prefixes', () => {
    expect(isAuraActionUrl('https://org.lightning.force.com/aura?r=1')).toBe(true);
    expect(isAuraActionUrl('https://org.lightning.force.com/aura')).toBe(true);
    expect(isAuraActionUrl('https://site.my.site.com/s/sfsites/aura?r=2')).toBe(true);
    expect(isAuraActionUrl('https://site.my.site.com/partners/s/sfsites/aura')).toBe(true);
  });

  test('does not match unrelated URLs (no false waits)', () => {
    expect(isAuraActionUrl('https://org.my.salesforce.com/services/data/v61.0/sobjects/Account')).toBe(false);
    expect(isAuraActionUrl('https://cdn.example.com/auraria.js')).toBe(false);
    expect(isAuraActionUrl('https://org.lightning.force.com/auraFW/resources/x.js')).toBe(false);
  });
});
