/**
 * P2/strip — the ONE check surface (review §5.2 "Top — one Check strip").
 *
 * It replaces v1's floating issues panel AND the `check (8)` badge with four
 * counts and a single verb: `Fix next →` selects the line the next problem
 * lives on and opens its card. Must-fix is the union of the three referees
 * the runtime itself uses (validator + login chain + data flow), so "0 must
 * fix" means the runner will accept this graph, not that the UI is happy.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  function chip(cls, n, text, title) {
    return '<span class="chip ' + cls + '" title="' + esc(title) + '"><b>' + n + '</b> ' + esc(text) + '</span>';
  }

  function render(model) {
    var el = document.getElementById('strip');
    if (!el) return;
    var c = model.checks;
    var ready = c.mustFix.length === 0 && c.toFinish.length === 0;
    var html =
      chip(c.mustFix.length ? 'bad' : 'ok', c.mustFix.length, 'must fix', 'the validator, the login chain and the data flow all agree these block a run') +
      chip(c.toFinish.length ? 'warn' : 'ok', c.toFinish.length, 'to finish', 'open questions: unbound roles, unnamed steps, drafted ports and checks') +
      chip('muted', c.hints.length, 'hints', 'advice, never blocking: landing URLs, missing oracles, no must-not line') +
      chip(c.captured === c.sessions && c.sessions ? 'ok' : 'muted', c.captured + '/' + c.sessions, 'captured', 'sessions with recorded steps') +
      '<span class="hint">' + (ready ? 'complete — only recording is left' : 'a graph is complete when only recording is left') + '</span>' +
      '<span class="grow"></span>' +
      (c.mustFix.length || c.toFinish.length
        ? '<button class="small" id="b_fixnext" title="jump to the next open question">Fix next →</button>'
        : runControls());
    el.innerHTML = html;

    var fix = document.getElementById('b_fixnext');
    if (fix) fix.addEventListener('click', function () { fixNext(model); });
    var run = document.getElementById('b_run1');
    if (run) run.addEventListener('click', function () { runNow(); });
    var cmd = document.getElementById('b_runcmd');
    if (cmd) cmd.addEventListener('click', function () { P2.ui.copy(runCommand(), 'copied the run command'); });
    P2.runview.bind(el);
  }

  /** 'graph:<ref>' — the spec the server and the CLI both take. */
  function runSpec() {
    return 'graph:' + (state.ref || state.doc.id);
  }

  /**
   * Served: the button RUNS the graph (the server spawns the same command,
   * then Journey Studio ingests it) and the strip shows one pill per test
   * linking to its review. file://: the button copies the command, as before.
   */
  function runControls() {
    var served = P2.net.served();
    var run = state.runs[runSpec()];
    var busy = run && (run.status === 'starting' || run.status === 'running' || run.status === 'ingesting');
    return P2.runview.render(run, { compact: true, spec: runSpec() }) +
      (served
        ? '<button class="small primary" id="b_run1"' + (busy ? ' disabled' : '') + ' title="run this graph now, then review it in Journey Studio">' + (busy ? 'running…' : 'Run this graph') + '</button>' +
          '<button class="small" id="b_runcmd" title="copy the command that runs this graph (CI, or a terminal)">copy CLI</button>' +
          P2.runview.openToggle()
        : '<button class="small primary" id="b_run1" title="copy the command that runs this graph">Run this graph</button>');
  }

  function runNow() {
    if (!P2.net.served()) { P2.ui.copy(runCommand(), 'copied the run command'); return; }
    var spec = runSpec();
    var tab = P2.net.openReview() ? P2.net.openReviewTab(spec) : null;   // inside the click: allowed
    P2.ui.toast('running ' + spec + '…');
    P2.net.startRun(spec, { tab: tab }).then(function (r) {
      if (r.ok) P2.ui.toast('run finished — review links are in the strip');
      else P2.ui.toast(r.error || ('run ' + (r.status || 'failed')));
    });
  }

  /** The next thing worth a human's attention, and where it lives. */
  function nextIssue(model) {
    return model.checks.mustFix[0] || model.checks.toFinish[0] || null;
  }

  function fixNext(model) {
    var issue = nextIssue(model);
    if (!issue) { P2.ui.toast('nothing open'); return; }
    if (issue.at && issue.at.kind !== 'graph') {
      state.sel = { kind: issue.at.kind, id: issue.at.id };
      state.cardOpen = true;
    } else {
      state.sel = { kind: 'graph', id: '' };
      state.cardOpen = true;
    }
    P2.bus.emit('select', state.sel);
    P2.ui.toast(issue.text);
  }

  function runCommand() {
    var ref = state.ref || state.doc.id;
    return 'npx sfpw suite graph:' + ref;
  }

  P2.strip = { render: render, fixNext: fixNext, nextIssue: nextIssue, runCommand: runCommand, runSpec: runSpec, runNow: runNow };
})();
