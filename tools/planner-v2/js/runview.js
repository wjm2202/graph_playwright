/**
 * P2/runview — what a run looks like once the server has it (M3,
 * docs/SCOPE-JOURNEY-STUDIO-INTEGRATION.md §3.3). Shared by the check strip
 * (one graph) and the suites box (several graphs): a status chip while the
 * run is in flight, then ONE PILL PER TEST — green/red by its own outcome —
 * that opens that test's review in Journey Studio in a new tab, plus the
 * batch's dashboard. A run's `status` is the machinery; a test's `outcome`
 * is the verdict. Both are shown, never conflated.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  function link(href, cls, text, title) {
    return '<a class="chip ' + cls + '" href="' + esc(href) + '" target="_blank" rel="noopener" title="' + esc(title) + '">' + text + '</a>';
  }

  function pill(t) {
    var cls = t.outcome === 'passed' ? 'ok' : t.outcome === 'failed' ? 'bad' : t.outcome === 'flaky' ? 'warn' : 'muted';
    var mark = t.outcome === 'passed' ? '✓' : t.outcome === 'failed' ? '✗' : t.outcome === 'flaky' ? '⚡' : '○';
    var label = mark + ' ' + esc(t.ref || t.title || '?');
    if (t.url) return link(t.url, cls + ' review', label + ' <span class="arrow">↗</span>', 'review ' + (t.ref || '') + ' in Journey Studio (' + t.outcome + ')');
    var why = t.error ? String(t.error) : t.outcome === 'skipped' ? 'skipped — no page to review' : 'no review page (no video for this test)';
    return '<span class="chip ' + cls + '" title="' + esc(why) + '">' + label + '</span>';
  }

  /** The in-flight tail, last line only — enough to see it moving. */
  function tailLine(run) {
    var t = run.tail || [];
    return t.length ? '<span class="hint mono runtail" title="' + esc(t.slice(-8).join('\n')) + '">' + esc(t[t.length - 1]) + '</span>' : '';
  }

  /**
   * @param run   state.runs[spec] or undefined
   * @param opts  { compact } — the strip has one line; the suites box can wrap
   */
  function render(run, opts) {
    if (!run) return '';
    var compact = opts && opts.compact;
    var st = run.status;
    if (st === 'starting' || st === 'running' || st === 'ingesting') {
      return '<span class="chip warn run"><b>' + (st === 'ingesting' ? 'ingesting' : 'running') + '…</b></span>' + tailLine(run);
    }
    if (st === 'failed' || st === 'lost') {
      return '<span class="chip bad run" title="' + esc(run.error || '') + '"><b>run ' + st + '</b> ' + esc((run.error || '').slice(0, 80)) + '</span>';
    }
    var studio = run.studio;
    if (!studio) return '<span class="chip muted run">done — nothing ingested</span>';
    var tests = studio.tests || [];
    var open = P2.net.reviewUrl(studio);
    var html = '<span class="runpills' + (compact ? ' compact' : '') + '">' +
      tests.map(pill).join('') +
      link(studio.dashboard, 'muted', 'dashboard <span class="arrow">↗</span>', 'this run in Journey Studio') +
      (open ? link(open, 'primary review-open', 'open review <span class="arrow">↗</span>', 'open this run\'s review in a new tab') : '') +
      '</span>';
    return html;
  }

  /** The "open review when done" toggle, shared by the strip and the suites box. */
  /** `suffix` keeps ids unique when both hosts are on the page (the `b_graphcard2` convention). */
  function openToggle(suffix) {
    return '<label class="hint openreview" title="when a run finishes, the planner opens its review in a new tab">' +
      '<input type="checkbox" id="f_openreview' + (suffix || '') + '"' + (P2.net.openReview() ? ' checked' : '') + '> open review</label>';
  }

  /** Wire the toggle openToggle() emits — call after innerHTML. */
  function bind(root) {
    var el = root || document;
    var tog = el.querySelector('#f_openreview, #f_openreview2');
    if (tog) tog.addEventListener('change', function () { P2.net.openReview(tog.checked); });
  }

  P2.runview = { render: render, pill: pill, openToggle: openToggle, bind: bind };
})();
