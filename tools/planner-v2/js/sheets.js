/**
 * P2/sheets — the ONE modal surface, and the sheets that need nothing but the
 * page itself: New ▾ (the picker), Paste a script, Join another graph, Export
 * JSON, Open a file… and the missing-credentials sheet the ● record button
 * raises. The server-backed wizards (ADO import, recordings, new project,
 * save-to-project, the personas "logs in as" step) live in sheets-server.js,
 * which registers into the same machinery.
 *
 * A sheet is the only modal in the planner: one `#sheet` overlay, one
 * `#sheet_card` body, closed by Esc, by the ✕/Cancel its content provides, or
 * by a click on the backdrop. No sheet writes the document directly — every
 * one calls a `P2.ops.*` op, so undo, validity and dirty keep meaning what
 * they mean everywhere else.
 *
 * Live reload: the dev server asks `window.plannerHoldReload()` before
 * reloading a tab (main.js answers `isOpen()`), so a rebuild triggered from
 * inside a wizard — creating a project, applying an import — cannot close the
 * window on the human mid-edit. `close()` releases the held reload.
 *
 *   open(name, args)   name ∈ 'new' | 'paste' | 'ado' | 'rec' | 'file' |
 *                      'join' | 'export' | 'project' | 'save' | 'personas' |
 *                      'credentials'; args is a plain object.
 *   close()            hide, clear, run the one-shot close hook, release reload.
 *   isOpen()           true while one is up.
 *   html(markup)       render markup into the card (helper).
 *   register(name, fn) add or replace a sheet: fn(args) renders and binds.
 *   onClose(fn)        one-shot: fired by the NEXT close() (cancel semantics).
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  var open = false;
  var sheets = {};
  var closeHook = null;

  function card() { return document.getElementById('sheet_card'); }
  function body() { return card(); }
  function el(id) { return document.getElementById(id); }
  function on(id, ev, fn) { var e = el(id); if (e) e.addEventListener(ev, fn); }

  function html(markup) {
    var c = card();
    if (!c) return;
    c.innerHTML = markup;
    var s = el('sheet');
    if (s) s.classList.add('open');
    open = true;
    c.querySelectorAll('[data-sheet="close"]').forEach(function (b) { b.addEventListener('click', close); });
  }

  /** The reload the server asked for while a wizard was up (serve-planner's
   *  RELOAD_SNIPPET parks it in `__plannerReloadPending`). */
  function releaseReload() {
    if (window.__plannerReloadPending && typeof window.__plannerReload === 'function') {
      window.__plannerReloadPending = false;
      window.__plannerReload();
    }
  }

  function close() {
    var s = el('sheet');
    if (s) s.classList.remove('open');
    var c = card();
    if (c) c.innerHTML = '';
    open = false;
    var hook = closeHook;
    closeHook = null;
    if (hook) { try { hook(); } catch (e) { if (window.console) window.console.error('sheet close hook', e); } }
    releaseReload();
  }

  function isOpen() { return open; }
  function register(name, fn) { sheets[name] = fn; }
  function onClose(fn) { closeHook = fn; }

  function notice(title, what) {
    html('<h3>' + esc(title) + '</h3><div class="hint">' + esc(what) +
      '</div><div class="row"><button data-sheet="close">Close</button></div>');
  }

  function download(name, text) {
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    } catch (e) {
      P2.ui.toast('this browser refused the download — copy the JSON instead');
    }
  }

  /** A message line inside a sheet: quiet by default, red when it refuses. */
  function say(id, text, bad) {
    var e = el(id);
    if (!e) return;
    e.textContent = text || '';
    e.style.color = bad ? 'var(--bad)' : 'var(--muted)';
  }

  // ---------- New ▾ ----------

  var NEW_ROUTES = [
    ['blank', 'Blank graph', 'start + one session line'],
    ['paste', 'Paste a script', 'the grammar an AI or a test case can write'],
    ['ado', 'From an ADO export', '.xlsx / .csv → one draft per test case'],
    ['rec', 'From a recording', 'capture-first: sessions, steps and records inferred'],
    ['file', 'Open a file…', 'a .graph.json from disk (v1 opens as v2)'],
  ];

  /** `New ▾` opens each entry directly; this sheet is the same list for
   *  anything that reaches `P2.sheets.open('new')` (the API, a shortcut). */
  register('new', function () {
    html('<h3>New graph</h3><div class="hint" style="margin-bottom:8px">every door leads to the same document — a process-graph/2 you can run.</div>' +
      '<div class="pick">' + NEW_ROUTES.map(function (r) {
        return '<button data-route="' + r[0] + '">' + esc(r[1]) + '<small>' + esc(r[2]) + '</small></button>';
      }).join('') + '</div>' +
      '<div class="row"><button data-sheet="close">Cancel</button></div>');
    card().querySelectorAll('[data-route]').forEach(function (b) {
      b.addEventListener('click', function () { route(b.dataset.route); });
    });
  });

  /** The New ▾ routing, shared with main.js's menu. */
  function route(kind) {
    if (kind === 'blank') {
      if (state.dirty && !window.confirm('Discard unsaved changes?')) return;
      close();
      P2.ops.newGraph();
      var first = P2.view.lines(state.doc).sessions[0];
      if (first) P2.ui.select({ kind: 'session', id: first.id }, true);
      P2.ui.focusLine('input[data-f="role"]');
      return;
    }
    P2.sheets.open(kind, {});
  }

  // ---------- paste a script ----------

  var EXAMPLE = [
    'create_customer  Create a customer',
    'as Client Associate on sf at /lightning/o/Account/list',
    '  create Customer (Account)',
    '    ✓ api.record_exists Account',
    '    ✓ ui.toast was created',
    '  must not delete Customer',
    'as Billing Collections on sf',
    '  verify Customer',
    '    ✓ ui.url /lightning/r/Account/',
  ].join('\n');

  register('paste', function (args) {
    var S = P2.lib.script();
    if (!S || !S.parseScript) { notice('Paste a script', 'the script codec is not inlined on this page — rebuild with npm run build:planner'); return; }
    var start = (args && args.text) || EXAMPLE;
    html('<h3>Paste a script</h3>' +
      '<div class="hint" style="margin-bottom:6px">One session per <span class="mono">as</span> line, one step per indented line. This is the same grammar the ADO importer reads and the graph-author skill writes (docs/GRAPH-SPEC.md §13).</div>' +
      '<textarea class="mono" id="s_txt" spellcheck="false"></textarea>' +
      '<div id="s_problems"></div>' +
      '<div class="row"><span class="hint grow" id="s_msg"></span><button data-sheet="close">Cancel</button>' +
      '<button class="primary" id="s_ok">Draft the graph</button></div>');
    el('s_txt').value = start;
    on('s_ok', 'click', draft);

    function draft(force) {
      var text = el('s_txt').value;
      var res;
      try { res = S.parseScript(text); }
      catch (err) { say('s_msg', 'the parser refused: ' + ((err && err.message) || String(err)), true); return; }
      var valid = P2.lib.schema().validateGraph(res.graph);
      if (res.problems.length && force !== true) {
        renderProblems(res.problems, valid.ok);
        say('s_msg', res.problems.length + ' line' + (res.problems.length === 1 ? '' : 's') + ' to look at', true);
        return;
      }
      if (!valid.ok) {
        renderProblems(res.problems.concat(valid.errors.map(function (e) { return { line: 1, message: e }; })), false);
        say('s_msg', 'the drafted graph would be invalid', true);
        return;
      }
      var loaded = P2.ops.loadDoc(res.graph, { ref: '', dirty: true });
      if (!loaded.ok) { say('s_msg', 'refused: ' + loaded.errors.join(' | '), true); return; }
      close();
      var sess = P2.view.lines(state.doc).sessions[0];
      if (sess) P2.ui.select({ kind: 'session', id: sess.id }, false);
      P2.ui.toast('drafted — every guess is a dashed pill; click to confirm');
      P2.ui.render();
    }

    function renderProblems(problems, canForce) {
      var box = el('s_problems');
      if (!box) return;
      box.innerHTML = '<ul class="problems">' + problems.map(function (p) {
        return '<li><span class="mono num">line ' + esc(p.line) + '</span> ' + esc(p.message) + '</li>';
      }).join('') + '</ul>' +
        (canForce ? '<div class="row" style="justify-content:flex-start"><button id="s_force">Draft anyway</button></div>' : '');
      on('s_force', 'click', function () { draft(true); });
    }
  });

  // ---------- open a graph file ----------

  register('file', function () {
    html('<h3>Open a graph file</h3>' +
      '<div class="hint">a <span class="mono">.graph.json</span> from disk. A <span class="mono">process-graph/1</span> file opens too — it is upgraded at the door.</div>' +
      '<div style="margin-top:10px"><input type="file" id="s_file" accept=".json,.graph.json"></div>' +
      '<div class="row"><button data-sheet="close">Cancel</button></div>');
    el('s_file').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var res = P2.ops.loadDoc(String(reader.result), { ref: '' });
        if (!res.ok) { P2.ui.toast('load refused: ' + res.errors.join(' | ')); return; }
        close();
        P2.ui.toast('opened ' + file.name);
        P2.ui.render();
      };
      reader.readAsText(file);
    });
  });

  // ---------- export ----------

  register('export', function () {
    var json = JSON.stringify(state.doc, null, 2);
    html('<h3>process-graph/2 JSON</h3>' +
      '<div class="hint">what the script compiles to — the validator, walker and runner read exactly this.</div>' +
      '<textarea class="mono" id="s_json" readonly style="min-height:320px;font-size:11px"></textarea>' +
      '<div id="s_dropped"></div>' +
      '<div class="row"><button data-sheet="close">Close</button>' +
      '<button id="s_script">Copy as script</button>' +
      '<button id="s_copy">Copy</button>' +
      '<button class="primary" id="s_download">Download ' + esc(state.doc.id) + '.graph.json</button></div>');
    el('s_json').value = json;
    on('s_copy', 'click', function () { P2.ui.copy(json, 'graph JSON copied'); });
    on('s_download', 'click', function () { download(state.doc.id + '.graph.json', json); });
    on('s_script', 'click', function () {
      var S = P2.lib.script();
      if (!S || !S.printScript) { P2.ui.toast('the script codec is not inlined on this page'); return; }
      var out = S.printScript(state.doc);
      el('s_json').value = out.text;
      // What the script form cannot carry is NAMED, never dropped silently.
      el('s_dropped').innerHTML = out.dropped.length
        ? '<div class="warnbox"><b>the script cannot carry:</b><ul class="problems">' +
          out.dropped.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') +
          '</ul>the JSON above (Export) still has all of it — this is the text form only.</div>'
        : '';
      P2.ui.copy(out.text, out.dropped.length
        ? 'script copied — ' + out.dropped.length + ' thing' + (out.dropped.length === 1 ? '' : 's') + ' the text cannot carry are listed'
        : 'script copied');
    });
  });

  // ---------- join another graph ----------

  var PORTED = { does: 1, touches: 1, handoff: 1 };
  /** system 'sf' is defined differently in 'x' — align the definitions … */
  var SYSTEM_CLASH = /^system '([^']+)' is defined differently in '([^']+)'/;

  /** What a library graph brings and what it needs — the prototype's line. */
  function summarise(doc) {
    var byId = {};
    doc.nodes.forEach(function (n) { byId[n.id] = n; });
    var produces = [];
    var needs = [];
    doc.edges.forEach(function (e) {
      if (!e.data || !e.data.io || !PORTED[e.type]) return;
      var target = byId[e.to];
      if (!target || target.type !== 'data') return;
      var name = target.label || target.id;
      var list = e.data.io === 'produces' ? produces : needs;
      if (list.indexOf(name) < 0) list.push(name);
    });
    needs = needs.filter(function (n) { return produces.indexOf(n) < 0; });
    return {
      sessions: doc.nodes.filter(function (n) { return n.type === 'session'; }).length,
      produces: produces,
      needs: needs,
    };
  }

  function chainOf(doc) {
    try { return P2.lib.compose().runOrder(doc).chain || []; } catch (e) { return []; }
  }

  register('join', function (args) {
    var after = (args && args.after) || '';
    var chain = chainOf(state.doc);
    if (!after) after = chain.length ? chain[chain.length - 1] : '';
    var afterNode = after ? P2.ops.findNode(state.doc, after) : null;
    var afterLabel = afterNode ? 'after ' + (afterNode.actor || afterNode.label || afterNode.id) : 'at the start';

    var lib = P2.net.builtIn();
    var refs = Object.keys(lib).sort().filter(function (ref) {
      return ref !== state.ref && lib[ref] && lib[ref].id !== state.doc.id;
    });
    if (!refs.length) {
      notice('Join another graph', 'this build of the planner carries no other graph to join. Save one into a project first (or restart npm run planner so it is inlined).');
      return;
    }
    html('<h3>Join another graph ' + esc(afterLabel) + '</h3>' +
      '<div class="hint" style="margin-bottom:8px">Its sessions splice into the chain here; records with the same name become one record, so the joined flow uses what this one created. Same role + system merge into one session.</div>' +
      '<div class="pick">' + refs.map(function (ref) {
        var s = summarise(lib[ref]);
        return '<button data-ref="' + esc(ref) + '">' + esc(lib[ref].id) +
          '<small>' + esc(lib[ref].title || ref) + ' · ' + s.sessions + ' session' + (s.sessions === 1 ? '' : 's') +
          ' · produces ' + esc(s.produces.join(', ') || '—') +
          (s.needs.length ? ' · needs ' + esc(s.needs.join(', ')) : '') + '</small></button>';
      }).join('') + '</div>' +
      '<div id="s_join_msg"></div>' +
      '<div class="row"><button data-sheet="close">Cancel</button></div>');
    card().querySelectorAll('[data-ref]').forEach(function (b) {
      b.addEventListener('click', function () { attempt(b.dataset.ref, { after: after }); });
    });

    /** One insert attempt; a refusal stays in the sheet and names the fix. */
    function attempt(ref, opts) {
      var before = {};
      state.doc.nodes.forEach(function (n) { if (n.type === 'session') before[n.id] = 1; });
      // `window.planner.insertGraph` is the one door — the sheet and the test
      // API can never take different paths through the composer.
      var res = window.planner.insertGraph(ref, opts);
      if (res.ok) { done(ref, before, res); return; }
      refuse(ref, opts, (res.errors || []).join(' | '));
    }

    function refuse(ref, opts, message) {
      var box = el('s_join_msg');
      if (!box) { P2.ui.toast(message); return; }
      var clash = SYSTEM_CLASH.exec(message);
      var sub = P2.net.graphFor(ref);
      var fix = '';
      if (clash && sub && sub.systems[clash[1]]) {
        var key = clash[1];
        var mine = JSON.stringify(state.doc.systems[key]);
        var theirs = JSON.stringify(sub.systems[key]);
        fix = '<div class="hint" style="margin-top:6px">this graph: <span class="mono">' + esc(mine) + '</span><br>' +
          esc(sub.id) + ': <span class="mono">' + esc(theirs) + '</span></div>' +
          '<div class="row" style="justify-content:flex-start">' +
          '<button class="primary" id="s_align">align system definitions</button>' +
          '<button id="s_island">insert as an island instead</button></div>';
      } else {
        fix = '<div class="row" style="justify-content:flex-start"><button id="s_island">insert as an island instead</button></div>';
      }
      box.innerHTML = '<div class="warnbox"><b>refused:</b> ' + esc(message) + fix + '</div>';
      on('s_align', 'click', function () {
        var key = clash[1];
        var r = P2.ops.setSystemDef(key, sub.systems[key]);
        if (!r.ok) { box.innerHTML = '<div class="warnbox"><b>could not align:</b> ' + esc(r.errors.join(' | ')) + '</div>'; return; }
        P2.ui.toast("system '" + key + "' now matches " + sub.id + " — ⌘Z undoes it");
        attempt(ref, opts);
      });
      on('s_island', 'click', function () {
        var before = {};
        state.doc.nodes.forEach(function (n) { if (n.type === 'session') before[n.id] = 1; });
        var res = window.planner.insertGraph(ref, { mode: 'island' });
        if (!res.ok) { box.innerHTML = '<div class="warnbox"><b>refused:</b> ' + esc((res.errors || []).join(' | ')) + '</div>'; return; }
        done(ref, before, res, true);
      });
    }

    function done(ref, before, res, island) {
      var summary = res.summary || [];
      var merged = [];
      summary.forEach(function (line) {
        var m = /^data ([a-z0-9_]+) merged/.exec(line);
        if (m) merged.push(m[1]);
      });
      var df = { errors: [] };
      try { df = P2.lib.compose().dataflowHealth(state.doc); } catch (e) { /* reported by the strip */ }
      // First session the join added, in chain order — the human's next line.
      var fresh = chainOf(state.doc).filter(function (id) { return !before[id]; })[0];
      close();
      if (fresh) P2.ui.select({ kind: 'session', id: fresh }, false);
      var sub = P2.net.graphFor(ref);
      P2.ui.toast('joined ' + ((sub && sub.id) || ref) +
        (island ? ' as an island — wire it in' : '') +
        (merged.length ? ' — merged ' + merged.join(', ') : '') +
        (df.errors.length ? ' · ' + df.errors.length + ' record' + (df.errors.length === 1 ? '' : 's') + ' still unproduced' : ''));
      P2.ui.render();
    }
  });

  // ---------- can't record yet: the .env lines to paste ----------

  register('credentials', function (args) {
    var missing = (args && args.missing) || [];
    var lines = missing.map(function (n) { return n + '='; }).join('\n');
    html('<h3>Can\'t record yet</h3>' +
      '<div class="hint">The login <span class="mono">' + esc((args && args.persona) || '?') + '</span> has no credentials in <span class="mono">.env</span>. Paste these lines, fill the values, and click ● again — the names are already in <span class="mono">.env.example</span>.</div>' +
      '<textarea class="mono" readonly style="min-height:70px;margin-top:8px">' + esc(lines) + '</textarea>' +
      '<div class="row"><button data-sheet="close">Close</button><button class="primary" id="s_copy">Copy lines</button></div>');
    on('s_copy', 'click', function () { P2.ui.copy(lines, 'copied'); close(); });
  });

  P2.sheets = {
    open: function (name, args) {
      var fn = sheets[name];
      if (!fn) { notice(String(name), 'no sheet registered under this name'); return; }
      fn(args || {});
    },
    close: close,
    isOpen: isOpen,
    html: html,
    body: body,
    register: register,
    onClose: onClose,
    download: download,
    notice: notice,
    say: say,
    route: route,
    summarise: summarise,
    example: EXAMPLE,
  };
})();
