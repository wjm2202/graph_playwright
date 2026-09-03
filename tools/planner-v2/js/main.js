/**
 * P2/main — boot, the shell's wiring, and `P2.ui`: the few things every other
 * module needs to do that are not model changes (toast, copy, select, render).
 *
 * The render loop is deliberately dumb — one projection, four painters, in
 * order. Nothing re-renders itself; an op fires `change`, the loop runs once,
 * and the DOM matches the document. That is what makes undo, the canvas and
 * the sheets all agree without a reconciliation step.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;

  var pending = false;
  /** Bumped by every actual render — see `schedule`. */
  var renderSeq = 0;

  function modelNow() {
    return {
      doc: state.doc,
      lines: P2.view.lines(state.doc),
      checks: P2.view.checks(state.doc, { knownPersonas: window.PERSONA_IDS }),
    };
  }

  function meta(model) {
    var el = document.getElementById('doc_meta');
    if (el) {
      var steps = model.lines.sessions.reduce(function (n, s) { return n + s.steps.length; }, 0);
      el.textContent = state.doc.id + '.graph.json · ' + model.lines.sessions.length + ' sessions · ' + steps + ' steps' + (state.dirty ? ' · unsaved' : '');
    }
    var proj = document.getElementById('proj_label');
    if (proj) proj.textContent = state.project ? 'project · ' + state.project : (state.ref ? 'ref · ' + state.ref : 'no project yet');
    var undo = document.getElementById('b_undo');
    if (undo) undo.disabled = P2.ops.undoDepth() === 0;
  }

  function render() {
    if (!state.doc) return;
    renderSeq += 1;
    var model;
    try { model = modelNow(); }
    catch (err) { toast('render failed: ' + ((err && err.message) || String(err))); return; }
    P2.strip.render(model);
    P2.library.render();
    P2.script.render(model);
    P2.canvas.render(state, model);
    P2.cards.render(model);
    meta(model);
  }

  /**
   * Coalesce the renders a burst of ops would otherwise each trigger — and
   * DROP the scheduled one if a synchronous `render()` has already happened
   * since (which is what `run()` does after every op). Without the sequence
   * check every edit rendered twice: once now, once a frame later, and the
   * late one rebuilt the card's DOM under whoever was typing into it — a
   * kind picked on the check editor was silently reset before the button
   * that reads it was clicked.
   */
  function schedule() {
    if (pending) return;
    pending = true;
    var at = renderSeq;
    var soon = function (fn) {
      if (window.requestAnimationFrame) window.requestAnimationFrame(fn);
      else window.setTimeout(fn, 0);
    };
    soon(function () {
      pending = false;
      if (renderSeq !== at) return;      // someone already drew this change
      render();
    });
  }

  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function copy(text, msg) {
    var done = function () { toast(msg || 'copied'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    } catch (e) { done(); }
  }

  /** Every op result passes through here: refused edits SAY why. */
  function run(res) {
    if (!res) return res;
    if (!res.ok) toast(res.errors && res.errors.length ? res.errors[0] : 'refused');
    render();
    return res;
  }

  function select(sel, openCard) {
    state.sel = sel;
    state.cardOpen = !!openCard;
    P2.canvas.select(sel);
    P2.bus.emit('select', sel);
    render();
  }

  function focusLine(selector) {
    setTimeout(function () {
      var el = document.querySelector('.line.sel ' + selector);
      if (el) el.focus();
    }, 0);
  }

  function openRef(ref) {
    if (state.dirty && !window.confirm('Discard unsaved changes to ' + state.doc.id + '?')) return false;
    var sub = P2.net.graphFor(ref);
    if (!sub) { toast("'" + ref + "' is not in this build of the planner — save it again, or restart npm run planner"); return false; }
    var res = P2.ops.loadDoc(sub, { ref: ref, project: P2.net.projectOf(ref) });
    if (!res.ok) { toast('load refused: ' + res.errors.join(' | ')); return false; }
    render();
    return true;
  }

  /**
   * Save into a project. Two gates before the write: pick the project when
   * this graph has none (the save sheet, not a prompt), and the "logs in as"
   * step for roles that are not in personas.json yet — a graph must not reach
   * disk naming personas the runner cannot resolve.
   */
  function saveToProject(project, overwrite) {
    var target = project || state.project || P2.net.projectOf(state.ref);
    if (!target && P2.net.served()) {
      P2.sheets.open('save', {});
      return Promise.resolve({ ok: false, errors: ['pick a project'] });
    }
    return P2.sheets.personas.ensure().then(function (go) {
      if (!go) { toast('save cancelled — nothing was written'); return { ok: false, errors: ['cancelled'] }; }
      return P2.net.saveToProject(target, overwrite).then(function (res) {
        if (res.exists) {
          if (!window.confirm('"' + target + '/' + state.doc.id + '" already exists. Overwrite it?')) {
            toast('save cancelled — the file on disk is unchanged');
            return { ok: false, errors: ['cancelled'] };
          }
          return saveToProject(target, true);
        }
        toast(res.ok
          ? (res.local ? 'saved in this browser (no dev server)' : (res.overwritten ? 'overwrote ' : 'saved ') + res.file)
          : 'NOT saved — ' + (res.errors || []).join(' | '));
        render();
        return res;
      });
    });
  }

  function record(sessionId) {
    return P2.ops.record(sessionId).then(function (res) {
      if (res && res.missing && res.missing.length) {
        P2.sheets.open('credentials', { missing: res.missing, persona: res.persona });
        return res;
      }
      if (res && !res.ok) toast(res.error || 'the recorder did not start');
      else if (res && res.ok) toast('recorded — the session is marked captured');
      render();
      return res;
    });
  }

  function setMode(m) {
    state.mode = m === 'view' ? 'view' : 'edit';
    document.body.classList.toggle('view', state.mode === 'view');
    var b = document.getElementById('b_mode');
    if (b) b.textContent = state.mode === 'view' ? 'Edit' : 'View';
    render();
  }

  P2.ui = {
    render: render, schedule: schedule, toast: toast, copy: copy, run: run, select: select,
    focusLine: focusLine, openRef: openRef, saveToProject: saveToProject, record: record,
    setMode: setMode, modelNow: modelNow,
  };

  // ---------- legend ----------

  var LEGEND = '<h3>What the lines and pills mean</h3><dl>' +
    '<dt>as …</dt><dd>a session: one role logging into one system. Line order = the login chain.</dd>' +
    '<dt>verb + record</dt><dd>a step: a <span class="mono">does</span> edge onto a record node.</dd>' +
    '<dt>must not</dt><dd>a <span class="mono">denied</span> edge — the security half.</dd>' +
    '<dt>⇒ ⇐ ⇄</dt><dd>the data port: produces · consumes · updates. Dashed = a guess; click to confirm.</dd>' +
    '<dt>✓ / ?</dt><dd>a check on the record. <b>?</b> is machine-guessed — click it to keep it.</dd>' +
    '<dt>● record</dt><dd>starts <span class="mono">npm run record</span> as this session\'s persona.</dd>' +
    '<dt>Esc</dt><dd>close the card or the sheet. <b>Delete</b> removes the selected line. <b>⌘Z</b> undoes.</dd>' +
    '</dl>';

  // ---------- wiring ----------

  function wire() {
    var on = function (id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };

    on('b_new', 'click', function (ev) { ev.stopPropagation(); document.getElementById('m_new').classList.toggle('open'); });
    document.addEventListener('click', function () { var m = document.getElementById('m_new'); if (m) m.classList.remove('open'); });
    // Every New ▾ entry routes through the sheets module, so the menu and
    // `P2.sheets.open('new')` can never mean different things.
    document.querySelectorAll('[data-new]').forEach(function (b) {
      b.addEventListener('click', function () { P2.sheets.route(b.dataset.new); });
    });

    on('b_join', 'click', function () { P2.sheets.open('join', {}); });
    on('b_saveas', 'click', function () { P2.sheets.open('save', {}); });
    on('b_undo', 'click', function () { run(P2.ops.undo()); });
    on('b_save', 'click', function () { saveToProject(); });
    on('b_export', 'click', function () { P2.sheets.open('export'); });
    on('b_mode', 'click', function () { setMode(state.mode === 'view' ? 'edit' : 'view'); });
    on('b_help', 'click', function () {
      var l = document.getElementById('legend');
      if (l.classList.contains('hide')) { l.innerHTML = LEGEND; l.classList.remove('hide'); } else l.classList.add('hide');
    });
    on('ncard_close', 'click', function () { state.cardOpen = false; render(); });
    on('b_fit', 'click', function () { P2.canvas.fit(); });
    on('b_layout', 'click', function () { run(P2.ops.clearLayout()); P2.canvas.layout(); });
    on('b_graphcard2', 'click', function () { select({ kind: 'graph', id: '' }, true); });

    document.querySelectorAll('[role=tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.tab = b.dataset.tab;
        document.querySelectorAll('[role=tab]').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
        var view = document.getElementById('view');
        view.className = 'view fill tab-' + state.tab;
        render();
        P2.canvas.fit();
      });
    });

    var togglePane = function () {
      document.getElementById('panes').classList.toggle('no-left');
      P2.canvas.fit();
      P2.cards.place();
    };
    on('t_left', 'click', togglePane);
    on('rail_left', 'click', togglePane);

    var sheet = document.getElementById('sheet');
    if (sheet) sheet.addEventListener('click', function (ev) { if (ev.target === sheet) P2.sheets.close(); });

    window.addEventListener('resize', function () { P2.canvas.fit(); P2.cards.place(); });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (P2.sheets.isOpen()) { P2.sheets.close(); return; }
        var legend = document.getElementById('legend');
        if (legend && !legend.classList.contains('hide')) { legend.classList.add('hide'); return; }
        if (state.cardOpen) { state.cardOpen = false; render(); }
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); run(P2.ops.undo()); return; }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === '[') { ev.preventDefault(); togglePane(); return; }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        var tag = (ev.target && ev.target.tagName) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (ev.target && ev.target.isContentEditable)) return;
        if (state.mode === 'view') return;
        if (state.sel.kind === 'step' || state.sel.kind === 'session') { ev.preventDefault(); window.planner.deleteSelected(); }
      }
    });

    // The dev server defers its live reload while a wizard is up.
    window.plannerHoldReload = function () { return P2.sheets.isOpen(); };
  }

  // ---------- boot ----------

  function firstRef() {
    try {
      var saved = sessionStorage.getItem('planner.reopen');
      if (saved) { sessionStorage.removeItem('planner.reopen'); if (P2.net.graphFor(saved)) return saved; }
    } catch (e) { /* private window — fine */ }
    var params = new URLSearchParams(location.search);
    var wanted = params.get('graph');
    if (wanted && P2.net.graphFor(wanted)) return wanted;
    var refs = Object.keys(P2.net.builtIn()).sort();
    return refs.length ? refs[0] : '';
  }

  /**
   * After the rebuild + live reload that follows an ADO import: land on the
   * first new graph and put the whole list back in front of the human (owner
   * 2026-09-02 — "I was expecting to see the names of each graph"). The
   * breadcrumb is written by the import sheet just before it applies.
   */
  function resumeImport() {
    var raw = null;
    try {
      raw = sessionStorage.getItem('planner.lastImport');
      if (raw) sessionStorage.removeItem('planner.lastImport');
    } catch (e) { return; }
    if (!raw) return;
    var last;
    try { last = JSON.parse(raw); } catch (e) { return; }
    var results = (last.results || []).filter(function (r) { return !!P2.net.graphFor(last.project + '/' + r.graphId); });
    if (!results.length) return;
    openRef(last.project + '/' + results[0].graphId);
    state.project = last.project;
    P2.sheets.open('ado', { project: last.project, results: results });
    toast('imported ' + results.length + ' graph' + (results.length === 1 ? '' : 's') + ' into ' + last.project + ' — opened the first');
  }

  function boot() {
    wire();
    state.library = P2.net.localLibrary();
    var ref = firstRef();
    if (ref) {
      var sub = P2.net.graphFor(ref);
      var res = P2.ops.loadDoc(sub, { ref: ref, project: P2.net.projectOf(ref) });
      if (!res.ok) P2.ops.newGraph();
    } else {
      P2.ops.newGraph();
    }
    var params = new URLSearchParams(location.search);
    setMode(params.get('mode') === 'view' ? 'view' : 'edit');
    render();

    P2.bus.on('change', schedule);
    P2.bus.on('library', schedule);

    if (P2.net.served()) {
      P2.net.probe();
      P2.net.refreshLibrary();
      P2.net.refreshEnv();
      P2.net.refreshPersonas();
      resumeImport();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
