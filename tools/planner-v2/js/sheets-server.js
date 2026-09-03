/**
 * P2/sheets-server — the sheets that need `npm run planner` behind them:
 *
 *   ado       the import-cases wizard (/__imports, /__imports/apply) — pick a
 *             project (or create one), upload the ADO .xlsx/.csv or reopen a
 *             stored import, tick the cases, one draft graph each.
 *   rec       the recordings under recordings/<journey>/ (/__recordings) and
 *             the pipeline command that turns one into a graph. It PREPARES
 *             the command — it does not run the pipeline.
 *   project   ＋ new project (/__projects), the same scaffolder npm run
 *             project:new runs.
 *   save      save this graph into ANOTHER project (or a new one).
 *   personas  the "logs in as" step: roles typed on session lines that are not
 *             in personas.json yet become personas + logins on save
 *             (/__personas/add), and the .env block comes back to paste.
 *
 * Every one of them degrades honestly over file://: the sheet SAYS what the
 * dev server would do rather than pretending or failing silently. Nothing here
 * fetches unless `P2.net.served()`.
 *
 * The live reload is held while any sheet is open (sheets.js) — creating a
 * project or applying an import triggers a rebuild, and a reload mid-wizard
 * closed the window on the owner once already (2026-09-02).
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;
  var sheets = P2.sheets;
  var html = sheets.html;
  var close = sheets.close;
  var say = sheets.say;

  function el(id) { return document.getElementById(id); }
  function on(id, ev, fn) { var e = el(id); if (e) e.addEventListener(ev, fn); }
  function served() { return P2.net.served() && !!window.fetch; }

  var STALE = 'the running dev server predates this page — stop it (Ctrl+C) and run: npm run planner';
  var NO_SERVER = 'this needs the dev server — run: npm run planner';

  /**
   * One fetch with one honest failure mode. A 404 or an HTML body means the
   * process answering is older than this page (it does not reload its own
   * code); `{ok:false}` means the server refused and said why.
   */
  function ask(url, body) {
    if (!served()) return Promise.reject(new Error(NO_SERVER));
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
      .then(function (r) {
        return r.text().then(function (text) {
          var j = null;
          try { j = JSON.parse(text); } catch (e) { throw new Error(r.status === 404 || /^\s*</.test(text) ? STALE : 'dev server returned no JSON (' + r.status + ')'); }
          if (!r.ok || j.ok === false) throw new Error((j && j.error) || 'server refused');
          return j;
        });
      });
  }

  /** Project names the page knows about, server first, build-time inline second. */
  function projectNames() {
    var lib = state.library || { projects: [] };
    var names = (lib.projects || []).map(function (p) { return p.name; });
    (window.PROJECT_LIST || []).forEach(function (p) { if (names.indexOf(p.project) < 0) names.push(p.project); });
    return names.sort();
  }

  function projectOptions(current) {
    return '<option value="">— choose a project —</option>' +
      projectNames().map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === current ? ' selected' : '') + '>' + esc(n) + '</option>';
      }).join('') +
      '<option value="__new">＋ new project…</option>';
  }

  // =====================================================================
  // ADO import wizard
  // =====================================================================

  /** The wizard's whole state — `window.planner.importCases.state()` reads it. */
  var IC = { project: '', importId: '', cases: [], results: [] };

  function icShow(step) {
    [1, 2, 3].forEach(function (n) {
      var e = el('ic_step' + n);
      if (e) e.classList.toggle('hide', n !== step);
    });
  }

  sheets.register('ado', function (args) {
    if (!served()) {
      sheets.notice('From an ADO export',
        'importing test cases needs the dev server: it stores the .xlsx/.csv under projects/<project>/imports/ and writes one draft graph per ticked case. Run: npm run planner (then open http://127.0.0.1:8765/planner.html).');
      return;
    }
    IC.project = (args && args.project) || IC.project || state.project || '';
    html('<h3>Import test cases</h3>' +
      '<div class="hint" style="margin-bottom:8px">an ADO export (.xlsx / .csv) → one draft graph per case, kept in the project.</div>' +
      '<div id="ic_step1">' +
        '<div class="kv"><label>project</label><select id="ic_project">' + projectOptions(IC.project) + '</select></div>' +
        '<div class="kv"><label></label><input class="mono hide" id="ic_newproject" placeholder="new project name (lower-case, digits, _ or -)"></div>' +
        '<div class="kv"><label>previous imports</label><select id="ic_previous"><option value="">— upload a new file —</option></select></div>' +
        '<div class="kv" id="ic_filerow"><label>ADO export file</label><input id="ic_file" type="file" accept=".xlsx,.xls,.xlsm,.csv"></div>' +
        '<div class="row"><span class="hint grow" id="ic_msg"></span><button data-sheet="close">Cancel</button>' +
        '<button class="primary" id="ic_read">Read test cases</button></div>' +
      '</div>' +
      '<div id="ic_step2" class="hide">' +
        '<div class="listhead"><span class="hint" id="ic_summary"></span>' +
        '<button class="small" id="ic_all">all</button><button class="small" id="ic_none">none</button></div>' +
        '<div class="caselist" id="ic_list"></div>' +
        '<div class="row"><span class="hint grow" id="ic_msg2"></span><button id="ic_back">← back</button>' +
        '<button class="primary" id="ic_apply">Import selected</button></div>' +
      '</div>' +
      '<div id="ic_step3" class="hide">' +
        '<div class="caselist" id="ic_results"></div>' +
        '<div class="hint" style="margin-top:8px">Each graph is a DRAFT: the session(s), the steps in order and the expected results as <span class="mono">?</span> checks. Nothing is invented — open one and work the check strip, or hand the files under <span class="mono">projects/&lt;p&gt;/graphs/</span> to your AI with <span class="mono">skills/graph-author/SKILL.md</span>.</div>' +
        '<div class="row"><button id="ic_more">Import more</button><button class="primary" id="ic_done">Done</button></div>' +
      '</div>');

    on('ic_project', 'change', function (ev) {
      el('ic_newproject').classList.toggle('hide', ev.target.value !== '__new');
      icRefreshPrevious();
    });
    on('ic_previous', 'change', function (ev) { el('ic_filerow').classList.toggle('hide', !!ev.target.value); });
    on('ic_read', 'click', function () { icRead(); });
    on('ic_back', 'click', function () { icShow(1); });
    on('ic_apply', 'click', function () { icApply(); });
    on('ic_all', 'click', function () {
      el('ic_list').querySelectorAll('input[type=checkbox]').forEach(function (cb) { if (!cb.disabled) cb.checked = true; });
    });
    on('ic_none', 'click', function () {
      el('ic_list').querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
    });
    on('ic_more', 'click', function () { sheets.open('ado', { project: IC.project }); });
    on('ic_done', 'click', close);

    el('ic_newproject').classList.toggle('hide', el('ic_project').value !== '__new');
    // An older server process answers these routes with 404/HTML — say so up
    // front rather than after the human has chosen a file.
    ask('/__capabilities').then(function (c) {
      if (!c.imports || !c.graphs) throw new Error(STALE);
    }).catch(function (e) { say('ic_msg', e.message, true); });
    icRefreshPrevious();

    if (args && args.results && args.results.length) { icRenderResults(args.results); icShow(3); }
  });

  function icRefreshPrevious() {
    var prev = el('ic_previous');
    if (!prev) return;
    prev.innerHTML = '<option value="">— upload a new file —</option>';
    var row = el('ic_filerow');
    if (row) row.classList.remove('hide');
    var project = el('ic_project').value;
    if (!project || project === '__new') return;
    ask('/__imports?project=' + encodeURIComponent(project)).then(function (j) {
      (j.imports || []).forEach(function (m) {
        var left = m.cases.filter(function (c) { return !c.graphId; }).length;
        var o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.originalName + ' · ' + m.at.slice(0, 16).replace('T', ' ') + ' · ' + m.cases.length + ' cases, ' + left + ' not yet imported';
        prev.appendChild(o);
      });
    }).catch(function () { /* no previous imports is not a failure */ });
  }

  /** Resolve the project (creating it when asked), then upload the file or
   *  reopen a stored import. Every refusal stays on step 1. */
  function icRead() {
    var sel = el('ic_project');
    var project = sel ? sel.value : '';
    var ensure;
    if (project === '__new') {
      var name = el('ic_newproject').value.trim();
      if (!name) { say('ic_msg', 'name the new project first', true); return Promise.resolve(); }
      ensure = ask('/__projects', { project: name }).then(function (j) {
        window.PROJECT_LIST = j.projects || window.PROJECT_LIST;
        return P2.net.refreshLibrary().then(function () { return j.project.project; });
      });
    } else if (!project) {
      say('ic_msg', 'choose a project (or create one)', true);
      return Promise.resolve();
    } else {
      ensure = Promise.resolve(project);
    }
    var prevId = el('ic_previous').value;
    var file = el('ic_file').files[0];
    if (!prevId && !file) { say('ic_msg', 'choose the ADO export file (.xlsx or .csv)', true); return Promise.resolve(); }
    say('ic_msg', prevId ? 'opening stored import…' : 'uploading + reading ' + file.name + '…');
    return ensure.then(function (p) {
      IC.project = p;
      state.project = p;
      if (prevId) {
        return ask('/__imports?project=' + encodeURIComponent(p)).then(function (j) {
          var m = (j.imports || []).filter(function (x) { return x.id === prevId; })[0];
          if (!m) throw new Error('stored import not found any more');
          return m;
        });
      }
      return new Promise(function (resolveFile, rejectFile) {
        var r = new FileReader();
        r.onerror = function () { rejectFile(new Error('could not read the file')); };
        r.onload = function () {
          var b64 = String(r.result).split(',')[1] || '';
          ask('/__imports', { project: p, filename: file.name, contentBase64: b64 })
            .then(function (j) { resolveFile(j['import']); }, rejectFile);
        };
        r.readAsDataURL(file);
      });
    }).then(function (manifest) {
      IC.importId = manifest.id;
      IC.cases = manifest.cases;
      icRenderCases(manifest);
      icShow(2);
      say('ic_msg', '');
    }).catch(function (e) { say('ic_msg', e.message, true); });
  }

  function icRenderCases(manifest) {
    var list = el('ic_list');
    list.innerHTML = '';
    var pending = 0;
    manifest.cases.forEach(function (c) {
      var row = document.createElement('label');
      row.className = 'caserow';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.index = String(c.index);
      if (c.graphId) cb.disabled = true;
      else if (c.steps > 0) { cb.checked = true; pending += 1; }
      var text = document.createElement('span');
      text.innerHTML = (c.id ? '<span class="mono hint">' + esc(c.id) + '</span> ' : '') + esc(c.title) +
        ' <span class="hint">· ' + c.steps + ' step' + (c.steps === 1 ? '' : 's') + '</span>' +
        (c.steps === 0 && !c.graphId ? ' <span class="pill gap">⚠ no steps in ADO — would be an empty graph</span>' : '') +
        (c.graphId ? ' <span class="pill ok">→ ' + esc(c.graphId) + ' (imported)</span>' : '');
      row.appendChild(cb);
      row.appendChild(text);
      list.appendChild(row);
    });
    el('ic_summary').textContent = manifest.originalName + ' — ' + manifest.cases.length + ' test case' +
      (manifest.cases.length === 1 ? '' : 's') + ', ' + pending + ' to import into ' + IC.project;
  }

  function icChecked() {
    var list = el('ic_list');
    if (!list) return [];
    return Array.prototype.slice.call(list.querySelectorAll('input[type=checkbox]'))
      .filter(function (cb) { return cb.checked && !cb.disabled; })
      .map(function (cb) { return parseInt(cb.dataset.index, 10); });
  }

  function icApply() {
    var indexes = icChecked();
    if (!indexes.length) { say('ic_msg2', 'tick at least one test case', true); return Promise.resolve(); }
    say('ic_msg2', 'creating ' + indexes.length + ' graph' + (indexes.length === 1 ? '' : 's') + '…');
    return ask('/__imports/apply', { project: IC.project, importId: IC.importId, indexes: indexes }).then(function (j) {
      var res = (j.results || []).map(function (r) {
        return { graphId: r.graphId, title: r.title, nodes: r.nodes, edges: r.edges, flags: r.flags || [] };
      });
      IC.results = res;
      // The server rebuilds the inlined library and live-reloads this tab (the
      // reload is held while this sheet is up). Leave a breadcrumb so the
      // reload lands on the first new graph with the list still in front of
      // the human (owner 2026-09-02: "I was expecting to see the names").
      try { sessionStorage.setItem('planner.lastImport', JSON.stringify({ project: IC.project, results: res })); } catch (e) { /* private window — fine */ }
      say('ic_msg2', '');
      icRenderResults(res);
      icShow(3);
      return P2.net.refreshLibrary().then(function () {
        P2.ui.toast('imported ' + res.length + ' test case' + (res.length === 1 ? '' : 's') + ' into projects/' + IC.project + '/graphs/');
        P2.ui.render();
      });
    }).catch(function (e) { say('ic_msg2', e.message, true); });
  }

  function icRenderResults(res) {
    var out = el('ic_results');
    if (!out) return;
    out.innerHTML = '';
    res.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'caserow';
      row.innerHTML = '<span class="mono">' + esc(IC.project + '/' + r.graphId) + '</span>' +
        '<span class="hint">' + esc(r.title) + ' · ' + r.nodes + ' nodes · ' + r.edges + ' edges · ' +
        (r.flags || []).length + ' flag' + ((r.flags || []).length === 1 ? '' : 's') + '</span>';
      var b = document.createElement('button');
      b.className = 'small';
      b.textContent = 'open';
      b.style.marginLeft = 'auto';
      b.dataset.ref = IC.project + '/' + r.graphId;
      b.addEventListener('click', function () { icOpen(b.dataset.ref); });
      row.appendChild(b);
      out.appendChild(row);
    });
  }

  /** Open a just-imported graph. The library ROWS refresh over /__library, but
   *  the DOCUMENTS are inlined at build time — until the rebuild lands, say so
   *  instead of opening the wrong thing. */
  function icOpen(ref) {
    P2.net.refreshLibrary().then(function () {
      if (P2.net.graphFor(ref)) {
        close();
        P2.ui.openRef(ref);
        return;
      }
      P2.ui.toast('"' + ref + '" is on disk; the dev server is re-inlining it — this tab reloads when you close this sheet');
    });
  }

  P2.sheets.ado = {
    read: icRead,
    apply: icApply,
    checked: icChecked,
    state: function () { return IC; },
    results: icRenderResults,
  };

  // =====================================================================
  // From a recording
  // =====================================================================

  sheets.register('rec', function () {
    if (!served()) {
      sheets.notice('From a recording',
        'listing recordings needs the dev server — run: npm run planner. Then pick a recording under recordings/<journey>/ and the sheet hands you the pipeline command that drafts a graph from it.');
      return;
    }
    html('<h3>From a recording</h3>' +
      '<div class="hint" style="margin-bottom:8px">capture-first: <span class="mono">sfpw pipeline --graph</span> builds sessions per actor, one step per save-bounded group, records per SObject with ports from def-use. Pick the journey you recorded.</div>' +
      '<div id="rc_list" class="caselist"><div class="stub">reading recordings/…</div></div>' +
      '<div id="rc_cmd"></div>' +
      '<div class="row"><button data-sheet="close">Close</button></div>');
    ask('/__recordings').then(function (j) {
      var rows = j.recordings || [];
      var box = el('rc_list');
      if (!box) return;
      if (!rows.length) {
        box.innerHTML = '<div class="stub">nothing under <span class="mono">recordings/</span> yet — press ● record on a session line first.</div>';
        return;
      }
      box.innerHTML = rows.map(function (r) {
        return '<div class="caserow"><span class="mono">' + esc(r.journey) + '</span>' +
          '<span class="hint">' + r.runs.length + ' capture' + (r.runs.length === 1 ? '' : 's') + ' · ' +
          esc(r.runs.map(function (x) { return x.persona; }).join(', ')) + ' · latest ' + esc(r.latest || '—') + '</span>' +
          '<button class="small primary" data-journey="' + esc(r.journey) + '" style="margin-left:auto">use this</button></div>';
      }).join('');
      box.querySelectorAll('[data-journey]').forEach(function (b) {
        b.addEventListener('click', function () { showCommand(b.dataset.journey); });
      });
    }).catch(function (e) {
      var box = el('rc_list');
      if (box) box.innerHTML = '<div class="stub">' + esc(e.message) + '</div>';
    });

    function showCommand(journey) {
      var cmd = 'npx sfpw pipeline ' + journey + ' --graph';
      var box = el('rc_cmd');
      box.innerHTML = '<div class="warnbox"><b>run this in the repo:</b>' +
        '<div class="cmd mono">' + esc(cmd) + '</div>' +
        'the planner does not run the pipeline for you — it reads the traces, writes the draft graph under <span class="mono">journeys/graphs/</span>, and this page picks it up on the next rebuild.' +
        '<div class="row" style="justify-content:flex-start"><button class="primary" id="rc_copy">Copy the command</button></div></div>';
      on('rc_copy', 'click', function () { P2.ui.copy(cmd, 'copied the pipeline command'); });
    }
  });

  // =====================================================================
  // New project
  // =====================================================================

  var NAME_RE = /^[a-z][a-z0-9_-]*$/;

  /** tools/scaffold-project.mjs badProjectName(), client-side: the refusal is
   *  the same sentence whether it comes from here or from the server. */
  function badProjectName(name) {
    if (!name) return 'project name required';
    if (!NAME_RE.test(name)) return "'" + name + "' — lower-case letters, digits, _ or - only (start with a letter)";
    if (name.length > 40) return 'name too long (max 40)';
    if (name === 'shared' || name === 'projects') return "'" + name + "' is reserved";
    return null;
  }

  sheets.register('project', function (args) {
    if (!served()) {
      sheets.notice('New project',
        'a project is a folder — projects/<name>/{graphs,steps,specs,journeys/baselines,recordings,evidence,docs} + project.json. The dev server (npm run planner) scaffolds it, or run: npm run project:new -- <name>');
      return;
    }
    html('<h3>New project</h3>' +
      '<div class="hint" style="margin-bottom:8px">the same scaffolder <span class="mono">npm run project:new</span> runs: a folder with graphs, steps, specs, baselines and a project.json.</div>' +
      '<div class="kv"><label>name</label><input class="mono" id="pj_name" placeholder="lower-case, digits, _ or -"></div>' +
      '<div class="kv"><label>team</label><input id="pj_team" placeholder="optional — who owns it"></div>' +
      '<div class="row"><span class="hint grow" id="pj_msg"></span><button data-sheet="close">Cancel</button>' +
      '<button class="primary" id="pj_make">Create project</button></div>');
    on('pj_make', 'click', function () {
      var name = el('pj_name').value.trim();
      var bad = badProjectName(name);
      if (bad) { say('pj_msg', bad, true); return; }
      say('pj_msg', 'creating projects/' + name + '/…');
      ask('/__projects', { project: name, team: el('pj_team').value.trim() }).then(function (j) {
        window.PROJECT_LIST = j.projects || window.PROJECT_LIST;
        return P2.net.refreshLibrary().then(function () {
          state.project = j.project.project;
          P2.ui.toast('created projects/' + j.project.project + '/ — it is the current project now');
          var then = args && args.then;
          close();
          P2.ui.render();
          if (then) then(j.project.project);
        });
      }).catch(function (e) { say('pj_msg', e.message, true); });
    });
  });

  // =====================================================================
  // Save into another project
  // =====================================================================

  sheets.register('save', function () {
    var names = projectNames();
    if (!served()) {
      sheets.notice('Save to project',
        'without the dev server a graph is saved in THIS BROWSER only (the Save button does that). Run npm run planner to write projects/<project>/graphs/' + state.doc.id + '.graph.json.');
      return;
    }
    var current = state.project || P2.net.projectOf(state.ref);
    html('<h3>Save “' + esc(state.doc.id) + '” to a project</h3>' +
      '<div class="hint" style="margin-bottom:8px">writes <span class="mono">projects/&lt;project&gt;/graphs/' + esc(state.doc.id) + '.graph.json</span> — validated first, atomic, and it asks before overwriting.</div>' +
      (names.length
        ? '<div class="pick">' + names.map(function (n) {
          return '<button data-project="' + esc(n) + '">' + esc(n) + '<small>' + (n === current ? 'the current project' : 'save here') + '</small></button>';
        }).join('') + '</div>'
        : '<div class="stub">no projects yet.</div>') +
      '<div class="row"><button data-sheet="close">Cancel</button><button id="sv_new">＋ new project…</button></div>');
    P2.sheets.body().querySelectorAll('[data-project]').forEach(function (b) {
      b.addEventListener('click', function () {
        var project = b.dataset.project;
        close();
        P2.ui.saveToProject(project);
      });
    });
    on('sv_new', 'click', function () {
      sheets.open('project', { then: function (name) { P2.ui.saveToProject(name); } });
    });
  });

  // =====================================================================
  // Personas — the "logs in as" step on save
  // =====================================================================

  /** Roles a session actually uses whose persona is not in personas.json. */
  function unknownRoles() {
    var known = window.PERSONA_IDS || [];
    var used = {};
    (state.doc.nodes || []).forEach(function (n) { if (n.type === 'session' && n.actor) used[n.actor] = 1; });
    var out = [];
    var actors = state.doc.actors || {};
    Object.keys(actors).forEach(function (alias) {
      if (!used[alias]) return;
      var persona = actors[alias];
      if (persona && known.indexOf(persona) < 0 && out.indexOf(persona) < 0) out.push(persona);
    });
    return out;
  }

  /** Set once the human has said "save it without creating the logins", so
   *  the same save (and its overwrite retry) does not ask twice. */
  var skipped = false;

  /**
   * The gate `P2.ui.saveToProject` runs before writing: resolve(true) to go
   * ahead, resolve(false) to cancel the save. Over file:// there is nothing to
   * create, so it never interrupts.
   */
  function ensurePersonas() {
    var roles = unknownRoles();
    if (!roles.length || skipped || !served()) return Promise.resolve(true);
    return new Promise(function (resolve) { openPersonas(roles, resolve); });
  }

  function accountOptions(role, fresh) {
    var opts = ['<option value="' + esc(role) + '">new login: ' + esc(role) + '  (SF_' + esc(role.toUpperCase()) + '_*)</option>'];
    fresh.forEach(function (other) {
      if (other !== role) opts.push('<option value="' + esc(other) + '">same login as ' + esc(other) + '</option>');
    });
    (window.PERSONA_ACCOUNTS || []).forEach(function (a) {
      opts.push('<option value="' + esc(a.id) + '">existing login: ' + esc(a.id) +
        (a.roles && a.roles.length ? '  (plays ' + esc(a.roles.join(', ')) + ')' : '') + '</option>');
    });
    return opts.join('');
  }

  function openPersonas(roles, resolve) {
    var done = false;
    var finish = function (go) { if (!done) { done = true; resolve(go); } };
    if (!served()) {
      sheets.notice('New roles in this graph',
        'the dev server would create ' + roles.join(', ') + ' in personas.json, give each one a login, and append the derived env NAMES to .env.example. Over file:// nothing is written — run npm run planner to do it for real.');
      sheets.onClose(function () { finish(true); });
      return;
    }
    html('<h3>' + roles.length + ' new role' + (roles.length === 1 ? '' : 's') + ' — who do they log in as?</h3>' +
      '<div class="hint" style="margin-bottom:8px">These roles are not in <span class="mono">personas.json</span> yet. Each one plays a LOGIN: a new one named after the role, an account that already exists, or another new role\'s login (roles may share one account — env names come from the login).</div>' +
      '<div class="castgrid" id="pp_cast">' + roles.map(function (role) {
        return '<span class="mono">' + esc(role) + '</span><select data-role="' + esc(role) + '">' + accountOptions(role, roles) + '</select>';
      }).join('') + '</div>' +
      '<div id="pp_result"></div>' +
      '<div class="row"><span class="hint grow" id="pp_msg"></span>' +
      '<button id="pp_skip">Save without creating them</button>' +
      '<button class="primary" id="pp_apply">Create the logins</button></div>');
    sheets.onClose(function () { finish(false); });
    // finish() BEFORE close(): close runs the cancel hook, and the first
    // answer wins — the other order would cancel the save we just approved.
    on('pp_skip', 'click', function () { skipped = true; finish(true); close(); });
    on('pp_apply', 'click', function () {
      var accounts = {};
      P2.sheets.body().querySelectorAll('#pp_cast select[data-role]').forEach(function (sel) { accounts[sel.dataset.role] = sel.value; });
      say('pp_msg', 'creating ' + roles.length + ' persona' + (roles.length === 1 ? '' : 's') + '…');
      P2.net.addPersonas(roles, accounts).then(function (res) {
        if (!res.ok) { say('pp_msg', res.error, true); return; }
        var blocks = res.envBlocks || {};
        var text = Object.keys(blocks).map(function (a) { return (blocks[a] || []).join('\n'); }).filter(Boolean).join('\n\n');
        say('pp_msg', '');
        el('pp_result').innerHTML = '<div class="warnbox"><b>created in personas.json:</b> <span class="mono">' +
          esc((res.added || []).join(', ') || 'nothing new') + '</span>' +
          (text ? '<div class="hint" style="margin-top:6px">paste this into <span class="mono">.env</span> and fill the values — the names are already in <span class="mono">.env.example</span>:</div>' +
            '<textarea class="mono" readonly id="pp_env" style="min-height:80px;margin-top:4px">' + esc(text) + '</textarea>' : '') +
          '</div>';
        // The card's credential rows read these — repaint before the save.
        P2.ui.render();
        // The button becomes the way ON: a fresh clone drops the apply
        // listener, so a second click cannot create the personas twice.
        var apply = el('pp_apply');
        apply.textContent = 'Continue the save';
        apply.replaceWith(apply.cloneNode(true));
        on('pp_apply', 'click', function () { finish(true); close(); });
        var skip = el('pp_skip');
        if (skip) skip.remove();
        if (text) {
          var copy = document.createElement('button');
          copy.className = 'small';
          copy.textContent = 'Copy the .env block';
          copy.addEventListener('click', function () { P2.ui.copy(text, 'copied'); });
          el('pp_result').appendChild(copy);
        }
      });
    });
  }

  /** `window.planner.personas.open()` — the same sheet, asked for by hand. */
  sheets.register('personas', function (args) {
    var roles = (args && args.roles) || unknownRoles();
    if (!roles.length) {
      sheets.notice('Personas', 'every role on a session line is already in personas.json — nothing to create. Type a new role on a session line and it appears here on save.');
      return;
    }
    openPersonas(roles, function () { /* opened by hand: nothing waits on it */ });
  });

  P2.sheets.personas = { ensure: ensurePersonas, unknownRoles: unknownRoles };
})();
