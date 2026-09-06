/**
 * P2/net — everything that leaves the page, and the file:// answer for each.
 *
 * The planner is ONE file that must work double-clicked (no server, no
 * network) and work better when `npm run planner` is behind it. So every call
 * here has two arms: the dev-server route, and the built-in data inlined at
 * build time (`window.GRAPH_LIBRARY`, `window.PROJECT_LIST`, `window.PERSONA_*`).
 * Nothing in the UI branches on the protocol — it asks net, and net decides.
 *
 * Routes (tools/serve-planner.mjs): /__capabilities /__library /__envstatus
 * /__graphs /__personas /__personas/add /__projects /__record + /__record/<id>
 * /__evidence /__run + /__run/<id> /__runs, and the mounted Journey Studio
 * under /studio/ (pages, api, batch files — same origin).
 * Live reload is injected by the server itself; the page only exposes
 * `window.plannerHoldReload` so a reload cannot close a sheet mid-edit.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  function served() { return P2.served() && !!window.fetch; }

  function getJson(url) {
    if (!served()) return Promise.resolve(null);
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function postJson(url, body) {
    if (!served()) return Promise.resolve({ status: 0, json: { ok: false, error: 'this needs the dev server — run: npm run planner' } });
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.text().then(function (text) {
          var j = null;
          try { j = JSON.parse(text); } catch (e) { j = { ok: false, error: 'the running dev server is older than this page — restart it (Ctrl+C, then npm run planner)' }; }
          return { status: r.status, json: j };
        });
      })
      .catch(function () { return { status: 0, json: { ok: false, error: 'dev server unreachable' } }; });
  }

  // ---------- built-in library (file:// and the ledger) ----------

  /** ref → the whole document, from the build-time inline. Saves update it,
   *  so a graph written this session is openable without a rebuild. */
  function builtIn() { return window.GRAPH_LIBRARY || {}; }

  function rowFor(ref, doc) {
    var sessions = (doc.nodes || []).filter(function (n) { return n.type === 'session'; });
    var v = P2.lib.schema().validateGraph(doc);
    var row = {
      ref: ref,
      id: doc.id || ref,
      title: doc.title || '',
      tags: doc.tags || [],
      sessions: sessions.length,
      captured: sessions.filter(function (n) { return n.steps && n.steps.status === 'captured'; }).length,
      file: '',
    };
    if (!v.ok) row.invalid = v.errors;
    return row;
  }

  /** The /__library shape, built from what the page already carries. */
  function localLibrary() {
    var lib = builtIn();
    var byProject = {};
    var legacy = [];
    for (var ref in lib) {
      if (!Object.prototype.hasOwnProperty.call(lib, ref)) continue;
      var slash = ref.indexOf('/');
      var row = rowFor(ref, lib[ref]);
      if (slash > 0) {
        var project = ref.slice(0, slash);
        (byProject[project] = byProject[project] || []).push(row);
      } else {
        legacy.push(row);
      }
    }
    var projects = (window.PROJECT_LIST || []).map(function (p) { return { name: p.project, graphs: byProject[p.project] || [] }; });
    for (var name in byProject) {
      if (!Object.prototype.hasOwnProperty.call(byProject, name)) continue;
      var known = projects.filter(function (p) { return p.name === name; })[0];
      if (!known) projects.push({ name: name, graphs: byProject[name] });
    }
    return { version: 0, projects: projects, legacy: legacy, suites: window.SUITES || {} };
  }

  function refreshLibrary() {
    return getJson('/__library').then(function (j) {
      var local = localLibrary();
      if (j && j.ok) {
        // The server is the truth about WHICH graphs exist AND, since the
        // build stopped inlining project graphs (customer material) into
        // planner.html, about what each one says: every row carries `doc`,
        // and that is what openFromLibrary opens. Suites still fall back.
        window.GRAPH_LIBRARY = window.GRAPH_LIBRARY || {};
        var groups = (j.projects || []).map(function (p) { return p.graphs || []; }).concat([j.legacy || []]);
        for (var gi = 0; gi < groups.length; gi++) {
          for (var ri = 0; ri < groups[gi].length; ri++) {
            var row = groups[gi][ri];
            if (row && row.doc && row.ref) window.GRAPH_LIBRARY[row.ref] = row.doc;
          }
        }
        state.library = { version: j.version, projects: j.projects || [], legacy: j.legacy || [], suites: j.suites || local.suites };
      } else {
        state.library = local;
      }
      P2.bus.emit('library', state.library);
      return state.library;
    });
  }

  /** The document behind a library row (built-in inline; saves keep it fresh). */
  function graphFor(ref) {
    var lib = builtIn();
    if (lib[ref]) return P2.clone(lib[ref]);
    // A bare id also matches `project/id` when it is unambiguous.
    var hits = [];
    for (var key in lib) {
      if (!Object.prototype.hasOwnProperty.call(lib, key)) continue;
      if (key === ref || key.slice(key.indexOf('/') + 1) === ref) hits.push(key);
    }
    return hits.length === 1 ? P2.clone(lib[hits[0]]) : null;
  }

  function projectOf(ref) {
    var slash = String(ref || '').indexOf('/');
    return slash > 0 ? ref.slice(0, slash) : '';
  }

  // ---------- capabilities + env ----------

  function probe() {
    return getJson('/__capabilities').then(function (j) {
      state.capabilities = j;
      P2.bus.emit('capabilities', j);
      return j;
    });
  }
  function refreshEnv() {
    return getJson('/__envstatus').then(function (j) {
      state.envStatus = j;
      P2.bus.emit('env', j);
      return j;
    });
  }
  function refreshPersonas() {
    return getJson('/__personas').then(function (j) {
      if (j && j.ok) {
        window.PERSONA_ENV = j.wiring || window.PERSONA_ENV;
        window.PERSONA_ACCOUNTS = j.accounts || window.PERSONA_ACCOUNTS;
        window.PERSONA_IDS = (j.roster || []).map(function (r) { return r.id; });
      }
      P2.bus.emit('personas', j);
      return j;
    });
  }

  /** POST /__personas — rename ONE credential env NAME on the login this role
   *  plays as; every role on that account follows (names only, never values). */
  function renamePersonaEnv(personaId, key, value) {
    var field = { url: 'urlEnv', username: 'usernameEnv', password: 'passwordEnv', token: 'tokenEnv', totp: 'totpEnv' }[key];
    if (!field) return Promise.resolve({ ok: false, error: 'unknown credential slot ' + key });
    var body = { personaId: personaId };
    body[field] = value;
    return postJson('/__personas', body).then(function (res) {
      if (res.status !== 200 || !res.json || !res.json.ok) return { ok: false, error: (res.json && res.json.error) || 'server refused' };
      window.PERSONA_ENV = window.PERSONA_ENV || {};
      if (res.json.wiringAll) window.PERSONA_ENV = res.json.wiringAll;
      else if (res.json.wiring) window.PERSONA_ENV[personaId] = res.json.wiring;
      if (res.json.envstatus) state.envStatus = res.json.envstatus;
      P2.bus.emit('personas', res.json);
      return { ok: true, wiring: res.json.wiring, warning: res.json.warning };
    });
  }

  /** POST /__personas/add — roles typed on session lines become personas +
   *  accounts, with their derived env NAMES appended to .env.example. */
  function addPersonas(roles, accounts) {
    return postJson('/__personas/add', { roles: roles, accounts: accounts || {} }).then(function (res) {
      if (res.status !== 200 || !res.json || !res.json.ok) return { ok: false, error: (res.json && res.json.error) || 'server refused' };
      if (res.json.wiring) window.PERSONA_ENV = res.json.wiring;
      if (res.json.accounts) window.PERSONA_ACCOUNTS = res.json.accounts;
      window.PERSONA_IDS = (res.json.roster || []).map(function (r) { return r.id; });
      P2.bus.emit('personas', res.json);
      return { ok: true, added: res.json.added || [], envBlocks: res.json.envBlocks || {} };
    });
  }

  function newProject(name) {
    return postJson('/__projects', { project: String(name || '').trim() }).then(function (res) {
      if (res.status !== 200 || !res.json || !res.json.ok) return { ok: false, error: (res.json && res.json.error) || 'server refused' };
      window.PROJECT_LIST = res.json.projects || window.PROJECT_LIST;
      return refreshLibrary().then(function () { return { ok: true, project: res.json.project.project }; });
    });
  }

  // ---------- saving ----------

  /**
   * POST /__graphs — validated, atomic, 409 → confirm overwrite (the parity
   * row `f_save`). No rebuild and no reload follow: a saved graph is DATA, so
   * the page just re-reads the library (review §5.3 d).
   */
  function saveToProject(project, overwrite) {
    var doc = state.doc;
    var v = P2.lib.schema().validateGraph(doc);
    if (!v.ok) return Promise.resolve({ ok: false, errors: v.errors });
    if (!served()) {
      // file:// keeps the browser-local shelf the old planner had, so a
      // double-clicked planner is not a read-only planner.
      try {
        var all = JSON.parse(localStorage.getItem('planner.graphs.v2') || '{}');
        all[doc.id] = doc;
        localStorage.setItem('planner.graphs.v2', JSON.stringify(all));
        window.GRAPH_LIBRARY = window.GRAPH_LIBRARY || {};
        window.GRAPH_LIBRARY[(project ? project + '/' : '') + doc.id] = P2.clone(doc);
        state.dirty = false;
        return refreshLibrary().then(function () { return { ok: true, ref: doc.id, local: true }; });
      } catch (e) {
        return Promise.resolve({ ok: false, errors: ['this browser refuses local storage — run npm run planner to save to a project'] });
      }
    }
    return postJson('/__graphs', { project: project, graph: doc, overwrite: !!overwrite }).then(function (res) {
      if (res.status === 409 && res.json && res.json.exists) {
        return { ok: false, exists: true, errors: [res.json.error] };
      }
      if (res.status !== 200 || !res.json || !res.json.ok) {
        return { ok: false, errors: [(res.json && res.json.error) || 'dev server refused'] };
      }
      state.project = project;
      state.ref = res.json.ref;
      state.dirty = false;
      // Keep the inlined copy in step so the graph re-opens without a rebuild.
      window.GRAPH_LIBRARY = window.GRAPH_LIBRARY || {};
      window.GRAPH_LIBRARY[res.json.ref] = P2.clone(doc);
      try { sessionStorage.setItem('planner.reopen', res.json.ref); } catch (e) { /* private window — fine */ }
      return refreshLibrary().then(function () {
        return { ok: true, ref: res.json.ref, file: res.json.file, overwritten: !!res.json.overwritten };
      });
    });
  }

  // ---------- recording ----------

  var POLL_MS = 1200;

  /** The env NAMES this session's login needs, and which are missing. */
  function credentialsFor(sessionId) {
    var node = P2.ops.findNode(state.doc, sessionId);
    var alias = node && node.actor;
    var personaId = alias ? state.doc.actors[alias] : '';
    var wiring = (window.PERSONA_ENV || {})[personaId] || {};
    var names = [wiring.username, wiring.password].filter(Boolean);
    var status = state.envStatus;
    var missing = status ? names.filter(function (n) { return !status[n]; }) : [];
    return { personaId: personaId, names: names, missing: missing, wiring: wiring };
  }

  /**
   * POST /__record then poll /__record/<id>. The graph is marked captured
   * only when the recorder exits 0 — a document must never claim a capture
   * that did not happen.
   */
  function startRecording(sessionId) {
    var node = P2.ops.findNode(state.doc, sessionId);
    if (!node || node.type !== 'session') return Promise.resolve({ ok: false, error: 'no such session' });
    if (!node.actor || !node.system) return Promise.resolve({ ok: false, error: 'name the role and the system first' });
    if (!served()) return Promise.resolve({ ok: false, error: 'recording needs the dev server — run: npm run planner' });
    var creds = credentialsFor(sessionId);
    if (creds.missing.length) {
      return Promise.resolve({ ok: false, missing: creds.missing, persona: creds.personaId, error: 'credentials missing from .env' });
    }
    state.recording[sessionId] = { status: 'starting', tail: [] };
    P2.bus.emit('change', { op: 'recording' });
    return postJson('/__record', { persona: creds.personaId, journey: state.doc.id, project: state.project }).then(function (res) {
      if (res.status !== 200 || !res.json || !res.json.ok) {
        delete state.recording[sessionId];
        P2.bus.emit('change', { op: 'recording' });
        return { ok: false, error: (res.json && res.json.error) || 'the recorder did not start' };
      }
      state.recording[sessionId] = { id: res.json.id, status: 'running', tail: [] };
      P2.bus.emit('change', { op: 'recording' });
      return poll(sessionId, res.json.id);
    });
  }

  function poll(sessionId, id) {
    return new Promise(function (done) {
      var tick = function () {
        getJson('/__record/' + id).then(function (j) {
          if (!j || !j.ok) { delete state.recording[sessionId]; P2.bus.emit('change', { op: 'recording' }); done({ ok: false, error: 'lost track of the recording' }); return; }
          state.recording[sessionId] = { id: id, status: j.status, tail: j.tail || [] };
          P2.bus.emit('change', { op: 'recording' });
          if (j.status === 'running') { setTimeout(tick, POLL_MS); return; }
          delete state.recording[sessionId];
          if (j.status === 'done') P2.ops.setSessionField(sessionId, 'captured', true);
          P2.bus.emit('change', { op: 'recording' });
          done({ ok: j.status === 'done', status: j.status, tail: j.tail || [] });
        });
      };
      setTimeout(tick, POLL_MS);
    });
  }

  /**
   * Run a graph or a suite through the dev server (POST /__run), then poll
   * /__run/<id> until Journey Studio has ingested it. The page never runs
   * Playwright itself: the server spawns the SAME `npx sfpw suite <spec>` a
   * human types, then `journey-studio ingest`, and hands back links.
   *   spec: 'graph:<ref>' or 'smoke,sod' (suite names)
   */
  function startRun(spec, opts) {
    if (!served()) return Promise.resolve({ ok: false, error: 'running needs the dev server — run: npm run planner' });
    var body = /^graph:/.test(spec) ? { ref: spec.slice(6) } : { suite: spec };
    var tab = opts && opts.tab;   // a tab opened AT THE CLICK (user gesture) — navigated when done
    state.runs[spec] = { status: 'starting', tail: [] };
    P2.bus.emit('change', { op: 'run' });
    return postJson('/__run', body).then(function (res) {
      if (res.status !== 200 || !res.json || !res.json.ok) {
        var err = (res.json && res.json.error) || 'the run did not start';
        state.runs[spec] = { status: 'failed', error: err, tail: [] };
        P2.bus.emit('change', { op: 'run' });
        return { ok: false, error: err, busy: !!(res.json && res.json.running) };
      }
      state.runs[spec] = { id: res.json.id, batch: res.json.batch, status: 'running', tail: [] };
      P2.bus.emit('change', { op: 'run' });
      return pollRun(spec, res.json.id).then(function (r) { settleTab(tab, r, spec); return r; });
    }).then(null, function (e) { settleTab(tab, { ok: false, error: String(e && e.message || e) }, spec); throw e; });
  }

  /**
   * "open review": popup blockers allow window.open() only inside a user
   * gesture, so the tab is opened when Run is CLICKED, shows a waiting page,
   * and is pointed at the review once the run has finished (same origin —
   * /studio/…). Returns null when the browser refused.
   */
  function openReviewTab(spec) {
    var w = null;
    try { w = window.open('', '_blank'); } catch (e) { w = null; }
    if (!w) return null;
    try {
      w.document.title = 'running ' + spec + '…';
      w.document.body.innerHTML = '<div style="font:14px system-ui;padding:32px;color:#444"><b>running ' + esc(spec) + '…</b><br><br>this tab will show the review in Journey Studio when the run finishes.<br><span style="color:#888">(you can close it — the links stay in the planner)</span></div>';
    } catch (e) { /* cross-origin about:blank quirks — harmless */ }
    return w;
  }
  function settleTab(tab, r, spec) {
    if (!tab) return;
    try {
      if (tab.closed) return;
      var url = r && r.studio && reviewUrl(r.studio, spec);
      // absolute on purpose: a relative assignment resolves against the CALLER's
      // base by spec, but an about:blank tab is the last place to rely on that
      if (r && r.ok && url) { tab.location.href = new URL(url, location.href).href; return; }
      tab.document.body.innerHTML = '<div style="font:14px system-ui;padding:32px;color:#a33"><b>' + (r && r.ok ? 'nothing to review' : 'run ' + esc((r && r.status) || 'failed')) + '</b><br><br>' + esc((r && r.error) || 'the planner has the details') + '</div>';
    } catch (e) { /* the tab is gone */ }
  }
  /**
   * Which page a finished run opens: for `graph:<ref>` the review of THAT
   * graph (its default variant when there are several), else the one linked
   * test, else the batch dashboard.
   */
  function reviewUrl(studio, spec) {
    var linked = (studio.tests || []).filter(function (t) { return t.url; });
    if (spec && /^graph:/.test(spec)) {
      var ref = spec.slice(6);
      var mine = linked.filter(function (t) { return t.ref === ref; });
      if (mine.length === 1) return mine[0].url;
      var def = mine.filter(function (t) { return /--default$/.test(t.slug || ''); });
      if (def.length === 1) return def[0].url;
    }
    return linked.length === 1 ? linked[0].url : studio.dashboard;
  }

  function pollRun(spec, id) {
    return new Promise(function (done) {
      var tick = function () {
        getJson('/__run/' + id).then(function (j) {
          if (!j || !j.ok) { state.runs[spec] = { status: 'failed', error: 'lost track of the run', tail: [] }; P2.bus.emit('change', { op: 'run' }); done({ ok: false }); return; }
          state.runs[spec] = j;
          P2.bus.emit('change', { op: 'run' });
          if (j.status === 'running' || j.status === 'ingesting') { setTimeout(tick, POLL_MS); return; }
          done({ ok: j.status === 'done', status: j.status, studio: j.studio || null });
        });
      };
      setTimeout(tick, POLL_MS);
    });
  }

  /** Earlier runs (survive a planner restart) → state.runs for specs not in flight. */
  function refreshRuns() {
    if (!served()) return Promise.resolve(null);
    return getJson('/__runs').then(function (j) {
      if (!j || !j.ok) return j;
      (j.runs || []).slice().reverse().forEach(function (r) {
        var cur = state.runs[r.spec];
        if (cur && (cur.status === 'running' || cur.status === 'ingesting' || cur.status === 'starting')) return;
        state.runs[r.spec] = r;
      });
      P2.bus.emit('change', { op: 'run' });
      return j;
    });
  }

  /** Remembered per browser: open the review tab when a run finishes (default on). */
  function openReview(set) {
    try {
      if (set !== undefined) localStorage.setItem('planner.openReview', set ? '1' : '0');
      var v = localStorage.getItem('planner.openReview');
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  }

  /**
   * A node's `snapshot.ref` → something an <img> can load, or '' when this
   * page cannot reach it (sprint 4.2: run evidence is a FILE under the
   * graph's `evidence/` folder, not a base64 blob in the document).
   *
   *   data: URL  → itself, always (old graphs, and the manual attach)
   *   served     → /__evidence?ref=<graph ref>&file=<relative ref>
   *   file://    → '' — the card prints the ref instead, because a
   *                double-clicked planner has no reader for a repo path.
   */
  function evidenceUrl(ref, graphRef) {
    var text = String(ref || '');
    if (!text) return '';
    if (/^data:/i.test(text)) return text;
    var target = String(graphRef === undefined ? state.ref : graphRef || '');
    if (!served() || !target) return '';
    return '/__evidence' + '?ref=' + encodeURIComponent(target) + '&file=' + encodeURIComponent(text);
  }

  P2.net = {
    served: served,
    probe: probe,
    evidenceUrl: evidenceUrl,
    refreshLibrary: refreshLibrary,
    refreshEnv: refreshEnv,
    refreshPersonas: refreshPersonas,
    localLibrary: localLibrary,
    builtIn: builtIn,
    graphFor: graphFor,
    projectOf: projectOf,
    saveToProject: saveToProject,
    renamePersonaEnv: renamePersonaEnv,
    addPersonas: addPersonas,
    newProject: newProject,
    startRecording: startRecording,
    startRun: startRun,
    refreshRuns: refreshRuns,
    openReviewTab: openReviewTab,
    reviewUrl: reviewUrl,
    openReview: openReview,
    credentialsFor: credentialsFor,
    getJson: getJson,
    postJson: postJson,
  };
})();
