/**
 * P2/view — the PURE projection of a ProcessGraph into the script the human
 * reads (review §5.1: "the graph has a canonical linear shape … which is a
 * script"). No DOM, no state writes, no inference of its own: `runOrder`
 * gives the session order, declaration order inside a session gives the step
 * order, and `inferPorts` / `catalogFor` / `sessionLabel` (src/graph/infer.ts)
 * supply every value the document leaves unsaid — as a DRAFT, so the UI can
 * show a guess without pretending it is authored.
 *
 * Everything the shell renders comes from `lines()` and `checks()`. A view
 * that needed a field the graph does not carry would be a design bug, not a
 * reason to add state.
 */
(function () {
  var P2 = window.P2;

  /** The first word of a label — the verb the human typed. */
  function firstWord(s) {
    var t = String(s === null || s === undefined ? '' : s).trim();
    return t ? t.split(/\s+/)[0] : '';
  }
  /** `expense.approve` → `approve`. */
  function verbOfCatalog(cat) {
    var parts = String(cat || '').split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  /**
   * The verb a step line shows. A must-not line's label reads "must not
   * delete Customer", so the prefix comes off first — otherwise the verb
   * would be the word "must", and so would the capability derived from it.
   */
  function verbOf(edge) {
    var label = String((edge && edge.label) || '');
    if (edge && edge.type === 'denied') label = label.replace(/^\s*must\s+not\s+/i, '');
    return firstWord(label);
  }

  var STEP_TYPES = { does: 1, denied: 1, asserts: 1 };

  /**
   * The script, line by line.
   *
   * sessions are in `runOrder` order; sessions the login chain never reaches
   * are APPENDED with `stranded: true` (chainHealth's amber list — an insert
   * whose seam is not wired yet). Each session's steps are its does/denied/
   * asserts edges in DECLARATION order, which is what the walker executes.
   */
  function lines(doc) {
    var C = P2.lib.compose();
    var I = P2.lib.infer();
    var order = C.runOrder(doc);
    var nodeById = {};
    for (var i = 0; i < doc.nodes.length; i++) nodeById[doc.nodes[i].id] = doc.nodes[i];

    var chain = order.chain || [];
    var sessionIds = [];
    for (var n = 0; n < doc.nodes.length; n++) if (doc.nodes[n].type === 'session') sessionIds.push(doc.nodes[n].id);
    var ordered = [];
    for (var c = 0; c < chain.length; c++) if (nodeById[chain[c]]) ordered.push({ id: chain[c], stranded: false });
    for (var s = 0; s < sessionIds.length; s++) {
      if (chain.indexOf(sessionIds[s]) < 0) ordered.push({ id: sessionIds[s], stranded: true });
    }

    // Inferred ports, keyed by edge id (drafts included).
    var inferred = {};
    try {
      var ip = I.inferPorts(doc);
      ip.ports.forEach(function (v, k) { inferred[k] = v; });
    } catch (e) { /* an unwalkable chain has no first-touch answer — fine */ }

    // Which step first lands on each data node? Unscoped checks (`after`
    // absent = "every landing") are shown on that step, so a check written
    // without a scope still has one line it belongs to.
    var firstTouch = {};
    for (var o = 0; o < ordered.length; o++) {
      var sid = ordered[o].id;
      for (var e = 0; e < doc.edges.length; e++) {
        var ed = doc.edges[e];
        if (ed.from !== sid || !STEP_TYPES[ed.type]) continue;
        if (firstTouch[ed.to] === undefined) firstTouch[ed.to] = ed.id;
      }
    }

    var sessions = [];
    var records = {};
    for (var k = 0; k < ordered.length; k++) {
      var node = nodeById[ordered[k].id];
      var steps = [];
      for (var x = 0; x < doc.edges.length; x++) {
        var edge = doc.edges[x];
        if (edge.from !== node.id || !STEP_TYPES[edge.type]) continue;
        steps.push(stepOf(doc, nodeById, edge, inferred, firstTouch, node));
      }
      sessions.push({
        id: node.id,
        node: node,
        label: I.sessionLabel(node, doc),
        role: node.actor || '',
        persona: node.actor ? (doc.actors[node.actor] || '') : '',
        system: node.system || '',
        url: node.url || '',
        auth: authOf(doc, node.id),
        captured: !!(node.steps && node.steps.status === 'captured'),
        stranded: ordered[k].stranded,
        steps: steps,
      });
      for (var t = 0; t < steps.length; t++) collectRecord(records, steps[t], node);
    }

    var recordList = [];
    for (var key in records) if (Object.prototype.hasOwnProperty.call(records, key)) recordList.push(records[key]);
    recordList.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

    return {
      sessions: sessions,
      records: recordList,
      ports: inferred,
      problem: order.problem,
      stranded: ordered.filter(function (r) { return r.stranded; }).map(function (r) { return r.id; }),
    };
  }

  /** The auth method declared on the login_as edge INTO this session. */
  function authOf(doc, sessionId) {
    for (var i = 0; i < doc.edges.length; i++) {
      var e = doc.edges[i];
      if (e.type === 'login_as' && e.to === sessionId) return (e.data && e.data.auth) || '';
    }
    return '';
  }

  function stepOf(doc, nodeById, edge, inferred, firstTouch, session) {
    var I = P2.lib.infer();
    var target = nodeById[edge.to];
    var isData = !!target && target.type === 'data';
    var written = edge.data && (edge.type === 'denied' ? edge.data.capability : edge.data.catalog);
    // catalogFor reads the LABEL's first word as the verb; a must-not label
    // starts with "must not", so hand it a probe carrying the real verb.
    var probe = { id: edge.id, from: edge.from, to: edge.to, type: edge.type, label: verbOf(edge), data: {} };
    var catalog = written || I.catalogFor(probe, doc);
    var verb = verbOf(edge) || verbOfCatalog(catalog) || '';
    var port = null;
    if (edge.type === 'does' && isData) {
      if (edge.data && edge.data.io) {
        port = { io: edge.data.io, draft: edge.data.ioDraft === true, reason: 'the port is set on the edge' };
      } else if (inferred[edge.id]) {
        port = { io: inferred[edge.id].io, draft: true, reason: inferred[edge.id].reason };
      }
    }
    return {
      edgeId: edge.id,
      edge: edge,
      sessionId: session.id,
      kind: edge.type,
      verb: verb,
      record: target ? (target.label || target.id) : '',
      recordId: edge.to,
      recordNode: target || null,
      sobject: (target && target.sobject) || '',
      isData: isData,
      catalog: catalog,
      capability: (edge.data && edge.data.capability) || '',
      port: port,
      checks: checksOf(target, edge, catalog, firstTouch),
    };
  }

  /**
   * A node's `expects` that belong to THIS step: `after` naming the edge id
   * or its catalog (docs/DESIGN-EXPECTATIONS.md), plus — on the first step to
   * land here — the unscoped ones, which the runner checks on every landing.
   */
  function checksOf(target, edge, catalog, firstTouch) {
    if (!target || !target.expects) return [];
    var out = [];
    for (var i = 0; i < target.expects.length; i++) {
      var x = target.expects[i];
      var mine = x.after === edge.id || (catalog && x.after === catalog);
      var unscoped = (x.after === undefined || x.after === '') && firstTouch[edge.to] === edge.id;
      if (mine || unscoped) out.push({ nodeId: target.id, expect: x, scoped: !!mine });
    }
    return out;
  }

  function collectRecord(records, step, session) {
    if (!step.isData) return;
    var name = step.record;
    var r = records[name];
    if (!r) r = records[name] = { id: step.recordId, name: name, sobject: step.sobject, producers: [], consumers: [] };
    if (!r.sobject && step.sobject) r.sobject = step.sobject;
    var who = session.actor || session.id;
    var io = step.port ? step.port.io : '';
    var list = io === 'produces' ? r.producers : r.consumers;
    if (io && list.indexOf(who) < 0) list.push(who);
  }

  // ---------- the check strip ----------

  /** Recording is its own counter (`captured n/m`), never a to-finish row. */
  var CAPTURE_KINDS = { not_captured: 1 };

  /** `nodes.x: …` / `edges.y: …` → the line that error belongs to. */
  function whereFor(doc, text) {
    var m = /^(nodes|edges)\.([a-z0-9_]+)/.exec(String(text || ''));
    if (!m) return { kind: 'graph', id: '' };
    return atFor(doc, m[2]);
  }

  /** A node id, edge id or `node.expect` → the selection that shows it. */
  function atFor(doc, at) {
    var id = String(at || '').split(':')[0];
    for (var i = 0; i < doc.edges.length; i++) {
      if (doc.edges[i].id === id) {
        var e = doc.edges[i];
        if (STEP_TYPES[e.type]) return { kind: 'step', id: e.id };
        if (e.type === 'login_as') return { kind: 'session', id: e.to };
        return { kind: 'graph', id: '' };
      }
    }
    var dot = id.indexOf('.');
    var nodeId = dot > 0 ? id.slice(0, dot) : id;
    for (var n = 0; n < doc.nodes.length; n++) {
      var node = doc.nodes[n];
      if (node.id !== nodeId) continue;
      if (node.type === 'session') return { kind: 'session', id: node.id };
      // A check lives on a record; the LINE it belongs to is the step that
      // lands there, so the card that opens is the one carrying the editor.
      for (var x = 0; x < doc.edges.length; x++) {
        if (doc.edges[x].to === node.id && STEP_TYPES[doc.edges[x].type]) return { kind: 'step', id: doc.edges[x].id };
      }
      return { kind: 'graph', id: '' };
    }
    return { kind: 'graph', id: '' };
  }

  /**
   * The strip: what must be fixed before the graph is valid, what is left to
   * finish before it is meaningful, what is only advice, and how much has
   * been recorded. Must-fix is the union of the three referees the runtime
   * uses — the validator, the login chain and the data flow — so a graph the
   * strip calls clean is a graph the runner accepts.
   */
  function checks(doc, opts) {
    var S = P2.lib.schema();
    var C = P2.lib.compose();
    var G = P2.lib.gaps();
    var known = (opts && opts.knownPersonas) || undefined;

    var mustFix = [];
    var v = S.validateGraph(doc);
    for (var i = 0; i < v.errors.length; i++) mustFix.push({ text: v.errors[i], at: whereFor(doc, v.errors[i]) });
    var ch = C.chainHealth(doc);
    for (var c = 0; c < ch.errors.length; c++) mustFix.push({ text: ch.errors[c], at: { kind: 'graph', id: '' } });
    for (var st = 0; st < ch.stranded.length; st++) {
      mustFix.push({ text: 'session \'' + ch.stranded[st] + '\' is not on the login chain — the walker never reaches it', at: { kind: 'session', id: ch.stranded[st] } });
    }
    var df = C.dataflowHealth(doc);
    for (var d = 0; d < df.errors.length; d++) mustFix.push({ text: df.errors[d], at: whereFor(doc, 'edges.' + (/^edge (\S+) /.exec(df.errors[d]) || [])[1]) });

    // Since sprint 4.4 the engine itself splits the two: `gaps` are the
    // eight questions with a write-back op, `hints` the three that have none.
    var report = { gaps: [], hints: [] };
    try { report = G.computeGaps(doc, known ? { knownPersonas: known } : {}); } catch (e) { report = { gaps: [], hints: [] }; }
    var gaps = report.gaps || [];
    var toFinish = [];
    var hints = [];
    var capture = [];
    var row;
    for (var g = 0; g < gaps.length; g++) {
      var gap = gaps[g];
      row = { text: gap.short, question: gap.question, kind: gap.kind, at: atFor(doc, gap.at), gap: gap };
      if (CAPTURE_KINDS[gap.kind]) capture.push(row); else toFinish.push(row);
    }
    for (var h = 0; h < (report.hints || []).length; h++) {
      var hint = report.hints[h];
      hints.push({ text: hint.short, question: hint.question, kind: hint.kind, at: atFor(doc, hint.at), gap: hint });
    }

    var sessions = doc.nodes.filter(function (n) { return n.type === 'session'; });
    var captured = sessions.filter(function (n) { return n.steps && n.steps.status === 'captured'; });
    return {
      mustFix: mustFix,
      toFinish: toFinish,
      hints: hints,
      capture: capture,
      gaps: gaps,
      captured: captured.length,
      sessions: sessions.length,
      dataflow: df,
      chain: ch,
      valid: v,
    };
  }

  /**
   * The RECORD LEDGER — goal 2 in one list: every record name in the library,
   * the SObject it is, and which graphs produce or consume it. Computed from
   * the graphs' own data nodes and ports (the open document overriding its
   * saved copy), never from a side index.
   */
  function ledger(docs) {
    var out = {};
    for (var ref in docs) {
      if (!Object.prototype.hasOwnProperty.call(docs, ref)) continue;
      var doc = docs[ref];
      if (!doc || !doc.nodes) continue;
      var model;
      try { model = lines(doc); } catch (e) { continue; }
      for (var i = 0; i < model.records.length; i++) {
        var r = model.records[i];
        var row = out[r.name] || (out[r.name] = { name: r.name, sobject: r.sobject, produced: [], consumed: [] });
        if (!row.sobject && r.sobject) row.sobject = r.sobject;
        if (r.producers.length && row.produced.indexOf(doc.id) < 0) row.produced.push(doc.id);
        if (r.consumers.length && row.consumed.indexOf(doc.id) < 0) row.consumed.push(doc.id);
      }
    }
    var list = [];
    for (var name in out) if (Object.prototype.hasOwnProperty.call(out, name)) list.push(out[name]);
    list.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return list;
  }

  P2.view = {
    lines: lines,
    checks: checks,
    ledger: ledger,
    atFor: atFor,
    firstWord: firstWord,
    verbOf: verbOf,
    verbOfCatalog: verbOfCatalog,
  };
})();
