/**
 * P2/api — `window.planner`, the test surface.
 *
 * docs/PLANNER-FEATURE-PARITY.md §8 lists every name the harness drives, all
 * disposition KEPT: the whole point of the rewrite is that the specs keep
 * meaning something. Names whose v1 implementation was cytoscape-shaped
 * (`addNode`, `connect`, `selectMany`, `groupBox`, `layout`) do the MODEL half
 * here and delegate the visual half to the `P2.canvas` hooks, which are
 * stub-safe until sprint 3.2 — so the API is complete today and gains its
 * pictures later.
 *
 * Two additions the parity table names: `script()` (the document as script
 * text, via src/graph/script.ts) and `record(sessionId)`.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;

  var LS_KEY = 'planner.graphs.v2';

  function doc() { return state.doc; }
  function nodeById(id) { return P2.ops.findNode(state.doc, id); }
  function edgeById(id) { return P2.ops.findEdge(state.doc, id); }

  function browserSaves() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }

  function readiness() {
    var g = doc();
    var sess = g.nodes.filter(function (n) { return n.type === 'session'; });
    var cap = sess.filter(function (n) { return n.steps && n.steps.status === 'captured'; }).length;
    var does = g.edges.filter(function (e) { return e.type === 'does'; });
    var bound = does.filter(function (e) { return e.data && e.data.catalog; }).length;
    var checks = 0;
    var drafts = 0;
    g.nodes.forEach(function (n) { (n.expects || []).forEach(function (x) { checks += 1; if (x.draft) drafts += 1; }); });
    var parts = [];
    if (sess.length) parts.push('captured ' + cap + '/' + sess.length);
    if (does.length) parts.push('bound ' + bound + '/' + does.length);
    if (checks) parts.push('checks ' + checks + (drafts ? ' (' + drafts + ' draft' + (drafts === 1 ? '' : 's') + ')' : ''));
    return parts.join(' · ');
  }

  /** The same sentences v1 hovered — one per node and edge type. */
  function tipFor(id) {
    var g = doc();
    var n = nodeById(id);
    if (n) {
      switch (n.type) {
        case 'start': return 'start — every run begins here';
        case 'end': return 'end — the flow is complete';
        case 'session': {
          var persona = n.actor && g.actors ? (g.actors[n.actor] || n.actor) : '(no role yet)';
          var cap = n.steps && n.steps.status === 'captured' ? 'captured ✓' : 'not recorded yet — ● record on the line starts it';
          return 'session — ' + (n.actor || '?') + " acts as persona '" + persona + "'" + (n.url ? ' · starts at ' + n.url : '') + ' · ' + cap;
        }
        case 'data': {
          var c = (n.expects || []).length;
          var d = (n.expects || []).filter(function (x) { return x.draft; }).length;
          return 'data record — ' + (c ? c + ' check' + (c === 1 ? '' : 's') + (d ? ' (' + d + ' draft to confirm)' : '') : 'no checks yet: what proves this record is right?');
        }
        case 'checkpoint': return 'checkpoint — an asserts edge into it runs its checks' + ((n.expects || []).length ? '' : ' (none defined yet)');
        case 'screen': return 'screen — a place in the app';
        case 'db': return n.queryable
          ? "database — QUERYABLE: db.query checks elsewhere can target '" + n.id + "'"
          : 'database — NOT queryable: tests cannot reach it; verify via the app API or a log system';
        case 'logger': return n.searchable === false
          ? 'log system — marked NOT searchable'
          : 'log system — log.traffic checks can search it, e.g. for an endpoint name';
        case 'api': {
          var ep = n.endpoint || {};
          return 'api endpoint' + (ep.method ? ' · ' + ep.method : '') + (ep.path ? ' ' + ep.path : '') + ' — integration hop; prove traffic with a log.traffic check';
        }
        default: return n.type + ' — ' + (n.label || n.id);
      }
    }
    var e = edgeById(id);
    if (e) {
      switch (e.type) {
        case 'login_as': return 'login as — this role signs in' + (e.data && e.data.auth ? ' (' + e.data.auth + ')' : '');
        case 'does': return 'does — the step' + (e.data && e.data.catalog ? " '" + e.data.catalog + "'" : ' (unbound: name or capture it)');
        case 'asserts': return "asserts — runs the target node's checks";
        case 'denied': return 'must NOT be able to' + (e.data && e.data.capability ? ': ' + e.data.capability : '') + ' — a security check';
        case 'handoff': return 'handoff — a record crosses here' + (e.data && e.data.recordRef ? ' (' + e.data.recordRef + ')' : '');
        case 'touches': return 'touches — writes/reads this system on the way through';
        case 'requires': return 'requires — must be true before this can run';
        default: return e.type;
      }
    }
    return '';
  }

  function issues() {
    var c = P2.view.checks(doc(), { knownPersonas: window.PERSONA_IDS });
    return {
      errors: c.mustFix.map(function (r) { return r.text; }),
      gaps: c.gaps,
    };
  }

  /** MODEL half of the old canvas `add ▾`. Sessions go through addSession so
   *  the login chain stays linear; everything else is a plain typed node. */
  function addNode(partial) {
    partial = partial || {};
    var type = partial.type || 'data';
    if (type === 'session') {
      var r = P2.ops.addSession(partial.actor || '', partial.system || '', partial.url || '');
      P2.canvas.addNode(partial);
      P2.ui.render();
      return r.ok ? r.id : null;
    }
    var res = P2.ops.apply('addNode', function (g, out) {
      var base = partial.label || ({ data: 'Record', checkpoint: 'Checkpoint', screen: 'Screen', db: 'Database', logger: 'Log system', api: 'Endpoint' }[type] || type);
      var node = { id: P2.uniqueId(g.nodes.map(function (x) { return x.id; }), partial.id || base, type), type: type, label: base };
      if (type === 'db') node.queryable = partial.queryable !== false;
      if (type === 'logger') node.searchable = partial.searchable !== false;
      if (type === 'data' && partial.sobject) node.sobject = partial.sobject;
      if (partial.url) node.url = partial.url;
      if (partial.pos) node.pos = partial.pos;
      g.nodes.push(node);
      out.id = node.id;
    });
    if (!res.ok) return null;
    P2.canvas.addNode(partial);
    P2.ui.render();
    return res.id;
  }

  /** The relation is INFERRED from the endpoints (parity: the 10-item
   *  dropdown is gone) — `type` only overrides a guess the human disputes. */
  function connect(from, to, type) {
    var a = nodeById(from);
    var b = nodeById(to);
    if (!a || !b) return null;
    var rel = type || P2.lib.infer().relationFor(a.type, b.type) || 'next';
    var res = P2.ops.apply('connect', function (g, out) {
      var edge = { id: P2.uniqueId(g.edges.map(function (x) { return x.id; }), 'e_' + rel, 'e'), from: from, to: to, type: rel };
      if (rel === 'does' || rel === 'denied') {
        edge.label = ((b.label || b.id) + '').toLowerCase();
        edge.data = {};
        var cat = P2.lib.infer().catalogFor({ id: edge.id, from: from, to: to, type: rel, label: edge.label, data: {} }, g);
        if (rel === 'denied') edge.data.capability = cat; else edge.data.catalog = cat;
      }
      g.edges.push(edge);
      out.id = edge.id;
    });
    if (!res.ok) return null;
    P2.canvas.connect(from, to, rel);
    P2.ui.render();
    return res.id;
  }

  /** A node or edge id → the line it is, so `select` means the same thing
   *  whether the harness names a session node or a step edge. */
  function selectId(id) {
    var sel = P2.view.atFor(doc(), id);
    state.sel = sel;
    state.cardOpen = sel.kind !== 'graph';
    P2.canvas.select(sel);
    P2.bus.emit('select', sel);
    P2.ui.render();
  }

  function deleteSelected() {
    var sel = state.sel;
    var res = { ok: false, errors: ['nothing selected'] };
    if (sel.kind === 'step') res = P2.ops.deleteStep(sel.id);
    else if (sel.kind === 'session') res = P2.ops.deleteSession(sel.id);
    if (res.ok) { state.sel = { kind: 'graph', id: '' }; state.cardOpen = false; }
    P2.ui.render();
    return res;
  }

  function save(mode) {
    var v = P2.lib.schema().validateGraph(doc());
    if (!v.ok) return { ok: false, errors: v.errors };
    if (mode === 'saveas') {
      var id = window.prompt('save as id (lower_snake_case):', doc().id + '_copy');
      if (id === null) return { ok: false, errors: ['cancelled'] };
      var r = P2.ops.setMeta(id, null, null);
      if (!r.ok) return r;
    }
    try {
      var all = browserSaves();
      all[doc().id] = doc();
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) {
      return { ok: false, errors: ['this browser refuses local storage'] };
    }
    state.dirty = false;
    P2.ui.render();
    return { ok: true, errors: [] };
  }

  function insertGraph(ref, opts) {
    var sub = P2.net.graphFor(ref);
    if (!sub) return { ok: false, errors: ["unknown graph '" + ref + "'"] };
    var composed;
    try { composed = P2.lib.compose().composeGraphs(doc(), sub, opts || {}); }
    catch (err) { return { ok: false, errors: [(err && err.message) || String(err)] }; }
    var res = P2.ops.apply('insertGraph', function (g) {
      Object.keys(g).forEach(function (k) { if (!(k in composed.graph)) delete g[k]; });
      Object.keys(composed.graph).forEach(function (k) { g[k] = composed.graph[k]; });
    });
    if (res.ok) { res.summary = composed.summary; P2.ui.render(); }
    return res;
  }

  window.planner = {
    version: 'planner/2',

    // ---- document ----
    load: function (input) { var r = P2.ops.loadDoc(input); P2.ui.render(); return { ok: r.ok, errors: r.errors }; },
    export: function () {
      var v = P2.lib.schema().validateGraph(doc());
      return { json: JSON.stringify(doc(), null, 2), ok: v.ok, errors: v.errors };
    },
    get: function () { return doc(); },
    script: function () {
      var S = P2.lib.script();
      if (!S || !S.printScript) return { text: '', dropped: ['the script codec is not inlined on this page'] };
      return S.printScript(doc());
    },
    newGraph: function (force) {
      if (state.dirty && !force && !window.confirm('Discard unsaved changes?')) return false;
      P2.ops.newGraph();
      P2.ui.render();
      return true;
    },
    validate: function () { return P2.lib.schema().validateGraph(doc()); },
    runOrder: function () { return P2.lib.compose().runOrder(doc()); },
    issues: issues,
    readiness: readiness,
    tipFor: tipFor,
    suggestCatalog: function (edgeId) {
      var e = edgeById(edgeId);
      return e ? P2.lib.infer().catalogFor({ id: e.id, from: e.from, to: e.to, type: e.type, label: e.label, data: {} }, doc()) : null;
    },
    testCommands: function () {
      var id = (doc().id || '').trim();
      if (!id) return null;
      return { run: 'npx sfpw suite graph:' + id };
    },

    // ---- structure ----
    addNode: addNode,
    addTyped: function (type) { return addNode({ type: type }); },
    connect: connect,
    deleteSelected: deleteSelected,
    undo: function () { var r = P2.ops.undo(); P2.ui.render(); return r; },
    undoDepth: function () { return P2.ops.undoDepth(); },
    layout: function () { P2.ops.clearLayout(); P2.canvas.layout(); P2.ui.render(); },
    setLayoutPos: function (id, x, y) { return P2.ops.setLayoutPos(id, x, y); },
    insertGraph: insertGraph,

    // ---- selection ----
    select: selectId,
    selectMany: function (ids) { P2.canvas.selectMany(ids); P2.ui.render(); },
    selection: function () { return P2.canvas.selection(); },
    groupBox: function () { return P2.canvas.groupBox(); },
    nodes: function () { return doc().nodes.map(function (n) { return n.id; }); },
    edges: function () { return doc().edges.map(function (e) { return e.id; }); },

    // ---- saving + the library ----
    save: save,
    saveToProject: function (project, overwrite) { return P2.ui.saveToProject(project, overwrite); },
    library: function () {
      return {
        builtIn: Object.keys(P2.net.builtIn()).sort(),
        saved: Object.keys(browserSaves()).sort(),
      };
    },
    projects: function () {
      var lib = state.library || { projects: [] };
      return { list: (lib.projects || []).map(function (p) { return p.name; }), current: state.project };
    },
    setProject: function (p) { state.project = p || ''; P2.ui.render(); },
    graphProject: function () { return state.project || P2.net.projectOf(state.ref); },
    openFromLibrary: function (ref) { return P2.ui.openRef(ref); },

    // ---- personas + imports ----
    personas: {
      open: function () { P2.sheets.open('personas'); },
      apply: function (roles, accounts) { return P2.net.addPersonas(roles, accounts); },
      parse: function (text) {
        return String(text || '').split(/[\n,]/).map(function (s) { return s.trim(); }).filter(Boolean);
      },
      roster: function () { return (window.PERSONA_IDS || []).slice(); },
      accounts: function () { return (window.PERSONA_ACCOUNTS || []).slice(); },
    },
    applyPersonaWiring: function (persona, wiring, envstatus, wiringAll) {
      window.PERSONA_ENV = window.PERSONA_ENV || {};
      if (persona && wiring) window.PERSONA_ENV[persona] = wiring;
      if (wiringAll) for (var pid in wiringAll) window.PERSONA_ENV[pid] = wiringAll[pid];
      if (envstatus) state.envStatus = envstatus;
      P2.ui.render();
    },
    // The ADO wizard (P2/sheets-server): the sheet's own steps, so the API
    // and the buttons drive one implementation.
    importCases: {
      open: function (args) { P2.sheets.open('ado', args || {}); },
      read: function () { return P2.sheets.ado.read(); },
      apply: function () { return P2.sheets.ado.apply(); },
      checked: function () { return P2.sheets.ado.checked(); },
      state: function () { return P2.sheets.ado.state(); },
    },

    // ---- modes ----
    setMode: function (m) { P2.ui.setMode(m); },
    record: function (sessionId) { return P2.ops.record(sessionId); },
  };
})();
