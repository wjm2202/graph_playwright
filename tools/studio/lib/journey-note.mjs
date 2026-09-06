// journey-note — PURE: turn a step's already-computed facts into one deterministic,
// grounded reviewer sentence. NO LLM, no invention — every clause is a direct read of
// a value the caller passed in, so it can't hallucinate. This is the "journey context"
// shown above the raw action/API log in studio.html: what the user did, on what screen,
// what it verified, and where this step sits in the journey (what precedes/follows it).
//
// Mirrored inline in web/studio.html (studio.html has no bundler and can't import this
// module over HTTP) — keep the two in sync. See the `short` mirror note there for the
// established pattern this follows.

const cap1 = (s) => s.replace(/^./, (c) => c.toUpperCase());

/** "N interaction(s) with the page, N navigation(s), N API call(s)." — or a fallback
 *  when a step recorded nothing (e.g. a pure wait/assert step). */
export function actionSummaryText({ nInteract = 0, nNav = 0, nApi = 0 } = {}) {
  const parts = [];
  if (nInteract) parts.push(`${nInteract} interaction${nInteract === 1 ? '' : 's'} with the page`);
  if (nNav) parts.push(`${nNav} navigation${nNav === 1 ? '' : 's'}`);
  if (nApi) parts.push(`${nApi} API call${nApi === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') + '.' : 'no recorded interactions.';
}

/** "N check(s) recorded: a; b; c; …" from a flat list of check/assertion titles.
 *  Shows at most 3 verbatim, truncates the rest — never fabricates a check that
 *  isn't in the list. */
export function checkSummaryText(checkTitles = [], shorten = (s) => s) {
  if (!checkTitles.length) return '';
  const shown = checkTitles.slice(0, 3).map(shorten);
  const more = checkTitles.length > shown.length ? '; …' : '';
  return `${checkTitles.length} check${checkTitles.length === 1 ? '' : 's'} recorded: ${shown.join('; ')}${more}.`;
}

/** Assemble the full journey note. All inputs are plain data the caller already has —
 *  this function does no lookups and no formatting decisions beyond assembling the
 *  sentence, so every fact in the output is traceable to a field on the step. */
export function journeyNoteText({
  title, nInteract, nNav, nApi, seesText, checkTitles = [], prevTitle, nextTitle, shorten = (s) => s,
}) {
  const bits = [`What the user does: ${title}.`, cap1(actionSummaryText({ nInteract, nNav, nApi }))];
  if (seesText) bits.push(`Ends on: ${seesText}.`);
  const chk = checkSummaryText(checkTitles, shorten);
  if (chk) bits.push(chk);
  if (prevTitle) bits.push(`Follows: “${shorten(prevTitle)}”.`);
  if (nextTitle) bits.push(`Leads to: “${shorten(nextTitle)}”.`);
  return bits.join(' ');
}
