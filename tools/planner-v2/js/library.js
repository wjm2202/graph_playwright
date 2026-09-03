/**
 * P2/library — the left rail: projects → graphs, the RECORD LEDGER, and the
 * suites (review §5.2 "Left — Library & Suites"; goals 2, 6 and 7 in one
 * pane).
 *
 * The readiness dot on a graph is the same judgment the check strip makes on
 * the open one, so "which of my graphs is closest to running" is answerable
 * without opening any of them. The ledger is computed from the graphs
 * themselves — data nodes and their ports — never from a side index that
 * could disagree with the documents.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  /** Every document the page can see, keyed by ref (open doc wins). */
  function docs() {
    var all = {};
    var lib = P2.net.builtIn();
    for (var ref in lib) if (Object.prototype.hasOwnProperty.call(lib, ref)) all[ref] = lib[ref];
    if (state.doc) all[state.ref || state.doc.id] = state.doc;
    return all;
  }

  /** bad · warn · muted (not fully captured) · ok — the prototype's ladder. */
  function readinessOf(ref, row) {
    var doc = (state.ref === ref && state.doc) ? state.doc : P2.net.builtIn()[ref];
    if (!doc) {
      if (row && row.invalid && row.invalid.length) return { cls: 'bad', n: row.invalid.length, title: row.invalid.join('\n') };
      if (row && row.sessions && row.captured < row.sessions) return { cls: 'muted', n: 0, title: row.captured + '/' + row.sessions + ' sessions recorded' };
      return { cls: '', n: 0, title: 'ready' };
    }
    var c;
    try { c = P2.view.checks(doc, { knownPersonas: window.PERSONA_IDS }); } catch (e) { return { cls: 'bad', n: 1, title: String(e && e.message) }; }
    if (c.mustFix.length) return { cls: 'bad', n: c.mustFix.length, title: c.mustFix.slice(0, 6).map(function (x) { return x.text; }).join('\n') };
    if (c.toFinish.length) return { cls: 'warn', n: c.toFinish.length, title: c.toFinish.slice(0, 6).map(function (x) { return x.text; }).join('\n') };
    if (c.captured < c.sessions) return { cls: 'muted', n: 0, title: c.captured + '/' + c.sessions + ' sessions recorded' };
    return { cls: '', n: 0, title: 'ready to run' };
  }

  function itemFor(row) {
    var r = readinessOf(row.ref, row);
    var d = document.createElement('div');
    d.className = 'item' + (row.ref === state.ref ? ' active' : '');
    d.innerHTML = '<span class="dot ' + r.cls + '"></span><span class="name"></span><span class="hint mono">' + (r.n || '✓') + '</span>';
    d.querySelector('.name').textContent = row.id;
    d.title = (row.title || row.id) + '\n' + r.title + (row.tags && row.tags.length ? '\ntags: ' + row.tags.join(', ') : '');
    d.addEventListener('click', function () { P2.ui.openRef(row.ref); });
    return d;
  }

  function renderGraphs() {
    var el = document.getElementById('library');
    if (!el) return;
    el.innerHTML = '';
    var lib = state.library || { projects: [], legacy: [] };
    var groups = (lib.projects || []).map(function (p) { return { name: 'projects / ' + p.name, rows: p.graphs || [] }; });
    if ((lib.legacy || []).length) groups.push({ name: 'journeys / graphs', rows: lib.legacy });
    if (!groups.length) { el.innerHTML = '<div class="stub">no graphs yet — New ▾ → Blank graph</div>'; return; }
    // The record filter, applied here: only the graphs the ledger row names.
    var only = recordFilter ? graphsTouching(recordFilter) : null;
    var shown = 0;
    for (var g = 0; g < groups.length; g++) {
      var rows = groups[g].rows.filter(function (row) { return !only || only.indexOf(row.id) >= 0; });
      if (!rows.length) continue;
      var head = document.createElement('div');
      head.className = 'proj';
      head.textContent = groups[g].name;
      el.appendChild(head);
      for (var i = 0; i < rows.length; i++) { el.appendChild(itemFor(rows[i])); shown += 1; }
    }
    if (!shown) el.innerHTML = '<div class="stub">no graph touches ' + esc(recordFilter) + ' — click the record again to clear the filter</div>';
  }

  /**
   * The record filter (S3.4): clicking a ledger row narrows the library to the
   * graphs that touch that record — goal 2 asked backwards ("who else uses
   * this?"). Clicking it again clears the filter; '' = no filter.
   */
  var recordFilter = '';

  /** Refs of the graphs that produce or consume `name`. */
  function graphsTouching(name) {
    var rows = P2.view.ledger(docs());
    var row = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].name === name) row = rows[i];
    if (!row) return [];
    var ids = row.produced.concat(row.consumed);
    var out = [];
    for (var k = 0; k < ids.length; k++) if (out.indexOf(ids[k]) < 0) out.push(ids[k]);
    return out;
  }

  /**
   * One line per record: `name · SObject` on the left, a compact `↑ n · ↓ m`
   * on the right whose title names the graphs. The old layout printed every
   * graph id inline, and a project with three graphs per record wrapped into
   * an unreadable block (owner, 2026-09-03).
   */
  function renderLedger() {
    var el = document.getElementById('ledger');
    if (!el) return;
    el.innerHTML = '';
    var rows = P2.view.ledger(docs());
    if (!rows.length) { el.innerHTML = '<div class="stub">no records yet — type a record name on a step line</div>'; return; }
    if (recordFilter) {
      var clear = document.createElement('div');
      clear.className = 'filterbar';
      clear.innerHTML = '<span class="pill ok" title="click to show every graph again">filtered by ' + esc(recordFilter) + ' ✕</span>';
      clear.addEventListener('click', function () { recordFilter = ''; render(); });
      el.appendChild(clear);
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var d = document.createElement('div');
      d.className = 'row' + (recordFilter === r.name ? ' on' : '');
      d.innerHTML = '<span class="what"><span class="rec"></span><span class="hint mono sobj"></span></span>' +
        '<span class="who">↑ ' + r.produced.length + ' · ↓ ' + r.consumed.length + '</span>';
      d.querySelector('.rec').textContent = r.name;
      d.querySelector('.sobj').textContent = r.sobject ? ' · ' + r.sobject : '';
      d.title = 'produced by: ' + (r.produced.join(', ') || 'nobody') +
        '\nconsumed by: ' + (r.consumed.join(', ') || 'nobody') +
        '\n\nclick to show only the graphs that touch it';
      d.dataset.record = r.name;
      d.addEventListener('click', function (ev) {
        var name = ev.currentTarget.dataset.record;
        recordFilter = recordFilter === name ? '' : name;
        render();
      });
      el.appendChild(d);
    }
    // The step line's record input offers what the project already knows.
    var dl = document.getElementById('records');
    if (dl) {
      dl.innerHTML = '';
      for (var k = 0; k < rows.length; k++) dl.appendChild(new Option(rows[k].name));
    }
  }

  var picked = {};

  /** suites.json's three selectors, resolved against the library rows. */
  function membersOf(def) {
    var out = [];
    var lib = state.library || { projects: [], legacy: [] };
    var rows = [];
    for (var p = 0; p < (lib.projects || []).length; p++) {
      for (var i = 0; i < lib.projects[p].graphs.length; i++) rows.push({ project: lib.projects[p].name, row: lib.projects[p].graphs[i] });
    }
    for (var l = 0; l < (lib.legacy || []).length; l++) rows.push({ project: '', row: lib.legacy[l] });
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r].row;
      var hit = false;
      if (def.graphs && (def.graphs.indexOf(row.ref) >= 0 || def.graphs.indexOf(row.id) >= 0)) hit = true;
      if (!hit && def.tags) {
        for (var t = 0; t < def.tags.length; t++) if ((row.tags || []).indexOf(def.tags[t]) >= 0) hit = true;
      }
      if (!hit && def.project && rows[r].project === def.project) hit = true;
      if (hit && out.indexOf(row.ref) < 0) out.push(row.ref);
    }
    return out;
  }

  function renderSuites() {
    var el = document.getElementById('suites');
    var box = document.getElementById('runbox');
    if (!el || !box) return;
    el.innerHTML = '';
    var suites = (state.library && state.library.suites) || {};
    var names = Object.keys(suites).sort();
    if (!names.length) {
      el.innerHTML = '<div class="stub">no suites — add one to suites.json (graphs / tags / project)</div>';
      box.textContent = '';
      return;
    }
    names.forEach(function (name) {
      var m = membersOf(suites[name] || {});
      var label = document.createElement('label');
      label.className = 'suite';
      label.innerHTML = '<input type="checkbox"' + (picked[name] ? ' checked' : '') + '> <span></span><span class="n">' + m.length + ' graphs</span>';
      label.querySelector('span').textContent = name;
      label.title = m.join('\n') || 'no graphs match this suite yet';
      label.querySelector('input').addEventListener('change', function (ev) {
        if (ev.target.checked) picked[name] = 1; else delete picked[name];
        renderSuites();
      });
      el.appendChild(label);
    });
    var chosen = Object.keys(picked).sort().join(',');
    if (!chosen) { box.textContent = 'tick a suite to run a group of graphs'; return; }
    box.innerHTML = 'run locally, or paste into CI (same line):<code class="mono">npx sfpw suite ' + esc(chosen) + '</code>' +
      '<div style="margin-top:6px"><button class="small primary" id="b_runsuite">Copy the ' + esc(chosen) + ' line</button></div>';
    document.getElementById('b_runsuite').addEventListener('click', function () {
      P2.ui.copy('npx sfpw suite ' + chosen, 'copied the suite command');
    });
  }

  function render() {
    renderGraphs();
    renderLedger();
    renderSuites();
  }

  P2.library = {
    render: render, membersOf: membersOf, readinessOf: readinessOf, docs: docs, picked: picked,
    graphsTouching: graphsTouching,
    filter: function (name) {
      if (name !== undefined) { recordFilter = name || ''; render(); }
      return recordFilter;
    },
  };
})();
