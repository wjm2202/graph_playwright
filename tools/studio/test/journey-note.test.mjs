// Tests for lib/journey-note.mjs — run with `node --test` (zero dep).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionSummaryText, checkSummaryText, journeyNoteText } from '../lib/journey-note.mjs';

test('actionSummaryText joins only the non-zero counts, with correct pluralisation', () => {
  assert.equal(actionSummaryText({ nInteract: 1, nNav: 0, nApi: 0 }), '1 interaction with the page.');
  assert.equal(
    actionSummaryText({ nInteract: 3, nNav: 1, nApi: 12 }),
    '3 interactions with the page, 1 navigation, 12 API calls.',
  );
  assert.equal(actionSummaryText({}), 'no recorded interactions.');
  assert.equal(actionSummaryText(), 'no recorded interactions.');
});

test('checkSummaryText shows up to 3 verbatim and truncates the rest, never invents one', () => {
  assert.equal(checkSummaryText([]), '');
  assert.equal(checkSummaryText(['a']), '1 check recorded: a.');
  assert.equal(
    checkSummaryText(['a', 'b', 'c']),
    '3 checks recorded: a; b; c.',
  );
  assert.equal(
    checkSummaryText(['a', 'b', 'c', 'd', 'e']),
    '5 checks recorded: a; b; c; ….',
  );
  // every word in the output must trace back to an input title (no fabrication)
  const titles = ['card number mis-filled', 'Stripe is showing a card validation error before submit'];
  const out = checkSummaryText(titles);
  for (const t of titles) assert.ok(out.includes(t), `output must contain verbatim: ${t}`);
});

test('checkSummaryText applies the shorten function to each shown title', () => {
  const shorten = (s) => s.toUpperCase();
  assert.equal(checkSummaryText(['abc'], shorten), '1 check recorded: ABC.');
});

test('journeyNoteText grounds every clause in a passed-in field — real guide.json shape', () => {
  // fixture mirrors the real "buy STARTER via hosted Stripe checkout" step from a
  // captured guide.json (card values already masked upstream as "•••")
  const note = journeyNoteText({
    title: 'buy STARTER via hosted Stripe checkout (the one card step)',
    nInteract: 5, nNav: 1, nApi: 3,
    seesText: 'Completing your subscription | Parametric Memory',
    checkTitles: [
      'card number mis-filled', 'Stripe is showing a card validation error before submit',
      'substrate has no slug', 'Traefik route not live (mcpEndpoint="https://high-trail-ccf8.droplet-mcp.nz/mcp")',
    ],
    prevTitle: 'authenticate a throwaway account via magic link',
    nextTitle: 'click into the substrate and claim the one-time API key',
  });
  assert.match(note, /^What the user does: buy STARTER via hosted Stripe checkout \(the one card step\)\./);
  assert.match(note, /5 interactions with the page, 1 navigation, 3 API calls\./);
  assert.match(note, /Ends on: Completing your subscription \| Parametric Memory\./);
  assert.match(note, /4 checks recorded: card number mis-filled; Stripe is showing a card validation error before submit; substrate has no slug; …\./);
  assert.match(note, /Follows: “authenticate a throwaway account via magic link”\./);
  assert.match(note, /Leads to: “click into the substrate and claim the one-time API key”\./);
  // no digits invented anywhere in the note beyond the counts we passed in — in
  // particular the masked card values ("•••") never get expanded into real digits
  assert.ok(!note.includes('4242'), 'must never fabricate/expand a masked card number');
});

test('journeyNoteText omits Follows/Leads/Ends clauses when the caller has no data for them', () => {
  const note = journeyNoteText({ title: 'first step', nInteract: 0, nNav: 1, nApi: 0 });
  assert.equal(note, 'What the user does: first step. 1 navigation.');
  assert.doesNotMatch(note, /Ends on|Follows|Leads|checks recorded/);
});
