/**
 * P2/ops — EVERY mutation of the document, one named function each.
 *
 * The contract is the same for all of them:
 *   1. work on a structural CLONE of `state.doc`, never on the live document;
 *   2. run `validateGraph` on the result;
 *   3. invalid → the clone is thrown away and `{ok:false, errors}` comes back,
 *      so a refused edit cannot leave a half-written graph behind (v1 wrote
 *      first and reported afterwards);
 *   4. valid → the PREVIOUS document goes on the undo stack, the clone
 *      becomes `state.doc`, and `change` fires once.
 *
 * That is why nothing else in the planner writes `state.doc`: undo, dirty and
 * validity are properties of this file alone. Where the grillme engine
 * already knows how to write an answer (ports, oracles, roles, policies) the
 * op DELEGATES to `gaps.applyAnswers` rather than reimplementing it — the
 * planner and /grillme must not drift.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;

  var SOBJECT_GUESS = {
    customer: 'Account', account: 'Account', lead: 'Lead', contact: 'Contact', prospect: 'Account',
    opportunity: 'Opportunity', expense: 'Expense__c', address: 'Address__c', case: 'Case', order: 'Order',
    quote: 'Quote', product: 'Product2', invoice: 'Invoice__c', task: 'Task', user: 'User',
  };
  var STEP_TYPES = { does: 1, denied: 1, asserts: 1 };

  function S() { return P2.lib.schema(); }
  function I() { return P2.lib.infer(); }

  /** A record name → the SObject it probably is (the prototype's table). */
  function guessSobject(name) {
    var parts = P2.slug(name).split('_');
    for (var i = parts.length - 1; i >= 0; i--) {
      if (SOBJECT_GUESS[parts[i]]) return SOBJECT_GUESS[parts[i]];
    }
    return '';
  }

  function ids(list) { return list.map(function (x) { return x.id; }); }
  function findNode(g, id) { for (var i = 0; i < g.nodes.length; i++) if (g.nodes[i].id === id) return g.nodes[i]; return null; }
  function findEdge(g, id) { for (var i = 0; i < g.edges.length; i++) if (g.edges[i].id === id) return g.edges[i]; return null; }
  function nodeOfType(g, type) { for (var i = 0; i < g.nodes.length; i++) if (g.nodes[i].type === type) return g.nodes[i]; return null; }
  function freshNodeId(g, base, fallback) { return P2.uniqueId(ids(g.nodes), base, fallback); }
  function freshEdgeId(g, base, extraTaken) { return P2.uniqueId(ids(g.edges).concat(extraTaken || []), base, 'e'); }

  function ensureStart(g) {
    var s = nodeOfType(g, 'start');
    if (!s) { s = { id: freshNodeId(g, 'start', 'start'), type: 'start', label: '' }; g.nodes.unshift(s); }
    return s;
  }
  function ensureEnd(g) {
    var e = nodeOfType(g, 'end');
    if (!e) { e = { id: freshNodeId(g, 'end', 'end'), type: 'end', label: '' }; g.nodes.push(e); }
    return e;
  }
  function firstSystemKey(g) { for (var k in g.systems) if (Object.prototype.hasOwnProperty.call(g.systems, k)) return k; return ''; }
  function ensureSystem(g, key) {
    if (!key) return;
    if (!g.systems[key]) {
      g.systems[key] = key === 'sf'
        ? { label: 'Salesforce', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' }
        : { label: key, kind: 'other' };
    }
  }

  /** The login order the document currently implies, stranded sessions last. */
  function chainOrder(g) {
    var r = P2.lib.compose().runOrder(g);
    var chain = (r.chain || []).slice();
    for (var i = 0; i < g.nodes.length; i++) {
      var n = g.nodes[i];
      if (n.type === 'session' && chain.indexOf(n.id) < 0) chain.push(n.id);
    }
    return chain;
  }

  /**
   * Rebuild the login_as chain (and the closing `next`) so it walks the given
   * session order, and regroup the edge list into the shape the script reads
   * — chain edge, that session's steps, the next session — which is what the
   * shipped graphs look like by hand. Auth stays with the session it logs
   * into, because that is what it describes.
   */
  function rewire(g, order) {
    var start = ensureStart(g);
    var end = ensureEnd(g);
    var keepLogin = {};
    var rest = [];
    var endEdgeId = null;
    for (var i = 0; i < g.edges.length; i++) {
      var e = g.edges[i];
      if (e.type === 'login_as') { keepLogin[e.to] = e; continue; }
      var from = findNode(g, e.from);
      if (e.type === 'next' && e.to === end.id && from && (from.type === 'session' || from.type === 'start')) {
        endEdgeId = e.id;
        continue;
      }
      rest.push(e);
    }
    // Ids already spoken for: the login edges we are keeping, and the closing
    // `next`. Without them a generated id could collide with a kept one.
    var taken = [];
    for (var t in keepLogin) if (Object.prototype.hasOwnProperty.call(keepLogin, t)) taken.push(keepLogin[t].id);
    if (endEdgeId) taken.push(endEdgeId);
    var chainEdges = {};
    var prev = start.id;
    for (var s = 0; s < order.length; s++) {
      var old = keepLogin[order[s]];
      var id = old ? old.id : freshEdgeId({ edges: rest }, 'e_login', taken);
      taken.push(id);
      var edge = { id: id, from: prev, to: order[s], type: 'login_as' };
      if (old && old.label) edge.label = old.label;
      if (old && old.data) edge.data = old.data;
      chainEdges[order[s]] = edge;
      prev = order[s];
    }
    var closing = { id: endEdgeId || freshEdgeId({ edges: rest }, 'e_end', taken), from: prev, to: end.id, type: 'next' };

    var out = [];
    var used = {};
    for (var o = 0; o < order.length; o++) {
      out.push(chainEdges[order[o]]);
      for (var r = 0; r < rest.length; r++) {
        if (rest[r].from === order[o] && !used[rest[r].id]) { out.push(rest[r]); used[rest[r].id] = 1; }
      }
    }
    for (var k = 0; k < rest.length; k++) if (!used[rest[k].id]) out.push(rest[k]);
    out.push(closing);
    g.edges = out;
  }

  /** Aliases no session plays any more are not roles — drop them, or the
   *  check panel nags about personas nobody uses. */
  function pruneActors(g) {
    var live = {};
    for (var i = 0; i < g.nodes.length; i++) if (g.nodes[i].actor) live[g.nodes[i].actor] = 1;
    for (var alias in g.actors) {
      if (!Object.prototype.hasOwnProperty.call(g.actors, alias)) continue;
      if (!live[alias]) {
        delete g.actors[alias];
        if (g.alternatives) delete g.alternatives[alias];
      }
    }
    if (g.alternatives && !Object.keys(g.alternatives).length) delete g.alternatives;
  }

  /** A data node nothing touches any more is litter — the record vanished
   *  with the last step that named it. */
  function pruneOrphanData(g, nodeId) {
    var n = findNode(g, nodeId);
    if (!n || n.type !== 'data') return;
    for (var i = 0; i < g.edges.length; i++) {
      if (g.edges[i].from === nodeId || g.edges[i].to === nodeId) return;
    }
    g.nodes = g.nodes.filter(function (x) { return x.id !== nodeId; });
  }

  /** ONE data node per record NAME — typing an existing name shares it. */
  function findOrCreateData(g, label, type) {
    var want = String(label || '').trim();
    var kind = type || 'data';
    var wantSlug = P2.slug(want);
    for (var i = 0; i < g.nodes.length; i++) {
      var n = g.nodes[i];
      if (n.type !== kind) continue;
      if (String(n.label || '').trim().toLowerCase() === want.toLowerCase()) return n;
      if (P2.slug(n.label || n.id) === wantSlug) return n;
    }
    var node = { id: freshNodeId(g, wantSlug || kind, kind === 'data' ? 'record' : kind), type: kind, label: want || 'Record' };
    if (kind === 'data') {
      var sobj = guessSobject(want);
      if (sobj) node.sobject = sobj;
    }
    g.nodes.push(node);
    return node;
  }

  /**
   * `<record>.<verb>` from infer.ts. The VERB is passed explicitly rather than
   * read off the label: a must-not line's label reads "must not delete
   * Customer", and catalogFor takes the label's first word — which would make
   * the capability `customer.must`.
   */
  function catalogNow(g, edge, verb) {
    var probe = { id: edge.id, from: edge.from, to: edge.to, type: edge.type, label: verb || edge.label, data: {} };
    return I().catalogFor(probe, g);
  }
  function setCatalog(g, edge, catalog) {
    edge.data = edge.data || {};
    if (edge.type === 'denied') edge.data.capability = catalog;
    else edge.data.catalog = catalog;
  }
  function catalogOf(edge) {
    if (!edge.data) return '';
    return edge.type === 'denied' ? (edge.data.capability || '') : (edge.data.catalog || '');
  }
  /** Checks are scoped `after` a catalog — a rename must carry them along. */
  function recatalogChecks(node, oldCat, newCat, edgeId) {
    if (!node || !node.expects) return;
    for (var i = 0; i < node.expects.length; i++) {
      var x = node.expects[i];
      if (x.after === oldCat || x.after === edgeId) x.after = newCat;
    }
  }
  function labelFor(verb, record, kind) {
    var text = (String(verb || '').trim() + ' ' + String(record || '').trim()).trim().toLowerCase();
    if (kind === 'denied') return ('must not ' + text).trim();
    return text || 'step';
  }

  // ---------- the transaction ----------

  /**
   * Run `mutate` against a copy of the document. See the header: the copy is
   * only adopted when the validator accepts it, so `errors` never comes back
   * beside a changed graph.
   */
  function apply(name, mutate, opts) {
    if (!state.doc) return { ok: false, errors: ['no document open'] };
    var before = state.doc;
    var g = P2.clone(state.doc);
    var out = {};
    try { mutate(g, out); } catch (err) { return { ok: false, errors: [(err && err.message) || String(err)] }; }
    var v = S().validateGraph(g);
    if (!v.ok) return { ok: false, errors: v.errors };
    state.undo.push(before);
    if (state.undo.length > 200) state.undo.shift();
    state.doc = g;
    if (!(opts && opts.clean)) state.dirty = true;
    P2.bus.emit('change', { op: name, result: out });
    return { ok: true, errors: [], op: name, value: out.value, id: out.id };
  }

  // ---------- documents ----------

  function blankGraph(id) {
    return {
      schema: 'process-graph/2',
      id: id || 'new_process',
      title: '',
      systems: { sf: { label: 'Salesforce', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' } },
      actors: {},
      nodes: [{ id: 'start', type: 'start', label: '' }, { id: 'end', type: 'end', label: '' }],
      edges: [{ id: 'e_end', from: 'start', to: 'end', type: 'next' }],
    };
  }

  /** A fresh document with one empty session line, exactly as the prototype's
   *  New ▾ → Blank graph does. Not undoable: it replaces the document. */
  function newGraph(id) {
    var g = blankGraph(id);
    state.doc = g;
    state.ref = '';
    state.dirty = false;
    state.undo = [];
    state.sel = { kind: 'graph', id: '' };
    P2.bus.emit('change', { op: 'newGraph' });
    var r = addSession('', 'sf', '');
    state.dirty = false;
    state.undo = [];
    return r.ok ? { ok: true, errors: [] } : r;
  }

  /**
   * The LOAD DOOR — a `process-graph/1` file still opens, as v2
   * (src/graph/upgrade.ts). Nothing past this line knows the v1 vocabulary.
   */
  function loadDoc(input, meta) {
    var doc;
    try { doc = typeof input === 'string' ? JSON.parse(input) : P2.clone(input); }
    catch (err) { return { ok: false, errors: ['not JSON: ' + ((err && err.message) || String(err))] }; }
    if (doc && doc.schema === 'process-graph/1') {
      try { doc = P2.lib.upgrade().upgradeGraph(doc).graph; }
      catch (err) { return { ok: false, errors: ['v1 upgrade refused: ' + ((err && err.message) || String(err))] }; }
    }
    var v = S().validateGraph(doc);
    if (!v.ok) return { ok: false, errors: v.errors };
    state.doc = doc;
    state.ref = (meta && meta.ref) || '';
    state.project = (meta && meta.project !== undefined) ? meta.project : state.project;
    // A DRAFT (a pasted script, a parsed import) opens dirty: it exists
    // nowhere on disk yet, so leaving it "saved" would lose it silently.
    state.dirty = !!(meta && meta.dirty);
    state.undo = [];
    state.cardOpen = false;
    var first = doc.nodes.filter(function (n) { return n.type === 'session'; })[0];
    state.sel = first ? { kind: 'session', id: first.id } : { kind: 'graph', id: '' };
    P2.bus.emit('change', { op: 'loadDoc' });
    return { ok: true, errors: [] };
  }

  // ---------- graph meta ----------

  function setMeta(id, title, tags) {
    return apply('setMeta', function (g) {
      if (id !== undefined && id !== null) g.id = P2.slug(id);
      if (title !== undefined && title !== null) {
        if (String(title).trim()) g.title = String(title).trim(); else delete g.title;
      }
      if (tags !== undefined && tags !== null) {
        var list = (Array.isArray(tags) ? tags : String(tags).split(','))
          .map(function (t) { return P2.slug(t); }).filter(Boolean);
        var uniq = [];
        for (var i = 0; i < list.length; i++) if (uniq.indexOf(list[i]) < 0) uniq.push(list[i]);
        if (uniq.length) g.tags = uniq; else delete g.tags;
      }
    });
  }

  function addSystem(key, def) {
    return apply('addSystem', function (g) {
      var k = P2.slug(key);
      if (!k) throw new Error('a system needs a lower_snake_case key');
      if (g.systems[k]) throw new Error("system '" + k + "' already exists");
      g.systems[k] = {
        label: (def && def.label) || k,
        kind: (def && def.kind) || 'other',
      };
      if (def && def.urlEnv) g.systems[k].urlEnv = String(def.urlEnv).trim();
      if (def && def.maxConcurrent) g.systems[k].sessionPolicy = { maxConcurrent: Number(def.maxConcurrent) };
    });
  }

  function setSystem(key, patch) {
    return apply('setSystem', function (g) {
      var sys = g.systems[key];
      if (!sys) throw new Error("unknown system '" + key + "'");
      if (patch.label !== undefined) sys.label = String(patch.label);
      if (patch.kind !== undefined) sys.kind = patch.kind;
      if (patch.urlEnv !== undefined) {
        if (String(patch.urlEnv).trim()) sys.urlEnv = String(patch.urlEnv).trim(); else delete sys.urlEnv;
      }
      if (patch.maxConcurrent !== undefined) {
        var n = Number(patch.maxConcurrent);
        if (n >= 1) sys.sessionPolicy = { maxConcurrent: Math.round(n) }; else delete sys.sessionPolicy;
      }
      // A system's label is half of every session label on that lane.
      for (var i = 0; i < g.nodes.length; i++) {
        if (g.nodes[i].type === 'session' && g.nodes[i].system === key) g.nodes[i].label = I().sessionLabel(g.nodes[i], g);
      }
    });
  }

  /**
   * Replace a system definition WHOLESALE — the composer's "align the
   * definitions" fix. `composeGraphs` refuses a join when the same system key
   * means two different things in the two documents ("system 'sf' is defined
   * differently … align the definitions (urlEnv/sessionPolicy)"), and the join
   * sheet offers this as the one-click answer. Session labels follow the new
   * label, exactly as setSystem does.
   */
  function setSystemDef(key, def) {
    return apply('setSystemDef', function (g) {
      if (!g.systems[key]) throw new Error("unknown system '" + key + "'");
      if (!def || typeof def !== 'object') throw new Error('a system definition is required');
      g.systems[key] = P2.clone(def);
      for (var i = 0; i < g.nodes.length; i++) {
        if (g.nodes[i].type === 'session' && g.nodes[i].system === key) g.nodes[i].label = I().sessionLabel(g.nodes[i], g);
      }
    });
  }

  // ---------- sessions ----------

  function addSession(role, system, url) {
    return apply('addSession', function (g, out) {
      var alias = P2.slug(role);
      var sysKey = system || firstSystemKey(g) || 'sf';
      ensureSystem(g, sysKey);
      var node = { id: freshNodeId(g, 'sess_' + sysKey + (alias ? '_' + alias : ''), 'sess'), type: 'session', label: '' };
      node.system = sysKey;
      if (alias) {
        if (!g.actors[alias]) g.actors[alias] = alias;
        node.actor = alias;
      }
      if (url) node.url = String(url).trim();
      g.nodes.push(node);
      node.label = I().sessionLabel(node, g);
      rewire(g, chainOrder(g));
      out.id = node.id;
    });
  }

  function setSessionField(id, field, value) {
    return apply('setSessionField', function (g) {
      var node = findNode(g, id);
      if (!node || node.type !== 'session') throw new Error("no session '" + id + "'");
      if (field === 'role') {
        var alias = P2.slug(value);
        if (alias) {
          if (!g.actors[alias]) g.actors[alias] = alias;
          node.actor = alias;
        } else {
          delete node.actor;
        }
        pruneActors(g);
        node.label = I().sessionLabel(node, g);
      } else if (field === 'persona') {
        if (!node.actor) throw new Error('name the role first — a persona binds to a role alias');
        g.actors[node.actor] = String(value).trim();
      } else if (field === 'system') {
        ensureSystem(g, value);
        if (value) node.system = value; else delete node.system;
        node.label = I().sessionLabel(node, g);
      } else if (field === 'url') {
        if (String(value).trim()) node.url = String(value).trim(); else delete node.url;
      } else if (field === 'notes') {
        if (String(value).trim()) node.notes = String(value).trim(); else delete node.notes;
      } else if (field === 'auth') {
        for (var i = 0; i < g.edges.length; i++) {
          var e = g.edges[i];
          if (e.type !== 'login_as' || e.to !== id) continue;
          e.data = e.data || {};
          if (value) e.data.auth = value; else delete e.data.auth;
          if (!Object.keys(e.data).length) delete e.data;
        }
      } else if (field === 'captured') {
        if (value) node.steps = { status: 'captured', journeyId: (node.steps && node.steps.journeyId) || g.id };
        else delete node.steps;
      } else {
        throw new Error("session has no field '" + field + "'");
      }
    });
  }

  function moveSession(id, dir) {
    return apply('moveSession', function (g) {
      var order = chainOrder(g);
      var i = order.indexOf(id);
      if (i < 0) throw new Error("no session '" + id + "' in the chain");
      var j = dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= order.length) throw new Error('already at the ' + (dir === 'up' ? 'start' : 'end') + ' of the chain');
      order.splice(j, 0, order.splice(i, 1)[0]);
      rewire(g, order);
    });
  }

  /**
   * Re-chain: `id` logs in immediately after `afterId` (a lane dragged onto
   * another lane on the canvas, sprint 3.2). `afterId` empty = first in the
   * chain. Same rewire as moveSession, expressed as a destination rather
   * than a direction, because a drag names WHERE, not how many steps.
   */
  function moveSessionAfter(id, afterId) {
    return apply('moveSessionAfter', function (g) {
      var order = chainOrder(g);
      if (order.indexOf(id) < 0) throw new Error("no session '" + id + "' in the chain");
      if (id === afterId) throw new Error('a session cannot follow itself');
      if (afterId && order.indexOf(afterId) < 0) throw new Error("no session '" + afterId + "' in the chain");
      order.splice(order.indexOf(id), 1);
      order.splice(afterId ? order.indexOf(afterId) + 1 : 0, 0, id);
      rewire(g, order);
    });
  }

  function deleteSession(id) {
    return apply('deleteSession', function (g) {
      var node = findNode(g, id);
      if (!node || node.type !== 'session') throw new Error("no session '" + id + "'");
      var touched = [];
      g.edges = g.edges.filter(function (e) {
        if (e.from !== id && e.to !== id) return true;
        if (e.from === id) touched.push(e.to);
        return false;
      });
      g.nodes = g.nodes.filter(function (n) { return n.id !== id; });
      for (var i = 0; i < touched.length; i++) pruneOrphanData(g, touched[i]);
      pruneActors(g);
      rewire(g, chainOrder(g));
    });
  }

  // ---------- steps ----------

  /** kind: 'does' (a step) · 'denied' (a must-not) · 'assert' (a checkpoint). */
  function addStep(sessionId, verb, record, kind) {
    return apply('addStep', function (g, out) {
      var session = findNode(g, sessionId);
      if (!session || session.type !== 'session') throw new Error("no session '" + sessionId + "'");
      var type = kind === 'denied' ? 'denied' : kind === 'assert' || kind === 'asserts' ? 'asserts' : 'does';
      var name = String(record || '').trim() || (type === 'asserts' ? 'Checkpoint' : 'Record');
      var word = String(verb || '').trim() || (type === 'asserts' ? 'verify' : 'step');
      var target = findOrCreateData(g, name, type === 'asserts' ? 'checkpoint' : 'data');
      var edge = {
        id: freshEdgeId(g, 'e_' + P2.slug(word) + '_' + P2.slug(name), []),
        from: sessionId, to: target.id, type: type,
        label: labelFor(word, name, type),
        data: {},
      };
      setCatalog(g, edge, catalogNow(g, edge, word));
      // After this session's LAST step, so declaration order is the order the
      // human sees; the first step of a session lands right after its
      // login_as edge, which keeps the closing `next` last in the file.
      var at = -1;
      for (var i = 0; i < g.edges.length; i++) if (g.edges[i].from === sessionId && STEP_TYPES[g.edges[i].type]) at = i + 1;
      if (at < 0) {
        for (var l = 0; l < g.edges.length; l++) if (g.edges[l].type === 'login_as' && g.edges[l].to === sessionId) at = l + 1;
      }
      if (at < 0) at = g.edges.length;
      g.edges.splice(at, 0, edge);
      out.id = edge.id;
    });
  }

  function setStepField(edgeId, field, value) {
    return apply('setStepField', function (g) {
      var edge = findEdge(g, edgeId);
      if (!edge || !STEP_TYPES[edge.type]) throw new Error("no step '" + edgeId + "'");
      var target = findNode(g, edge.to);
      var oldCat = catalogOf(edge);
      var verb = P2.view.verbOf(edge) || P2.view.verbOfCatalog(oldCat);
      var record = target ? (target.label || target.id) : '';

      if (field === 'verb') {
        verb = String(value).trim();
        edge.label = labelFor(verb, record, edge.type);
        var cat = catalogNow(g, edge, verb);
        setCatalog(g, edge, cat);
        recatalogChecks(target, oldCat, cat, edge.id);
      } else if (field === 'record') {
        var wanted = String(value).trim();
        if (!wanted) throw new Error('a step acts on a record — name it');
        var next = findOrCreateData(g, wanted, edge.type === 'asserts' ? 'checkpoint' : 'data');
        var oldId = edge.to;
        if (next.id !== oldId) {
          // The checks written for THIS step move with it; the ones scoped to
          // another step stay where they are.
          if (target && target.expects) {
            var mine = target.expects.filter(function (x) { return x.after === oldCat || x.after === edge.id; });
            if (mine.length) {
              target.expects = target.expects.filter(function (x) { return mine.indexOf(x) < 0; });
              if (!target.expects.length) delete target.expects;
              next.expects = (next.expects || []).concat(mine);
            }
          }
          edge.to = next.id;
        }
        edge.label = labelFor(verb, wanted, edge.type);
        var cat2 = catalogNow(g, edge, verb);
        setCatalog(g, edge, cat2);
        recatalogChecks(next, oldCat, cat2, edge.id);
        if (next.id !== oldId) pruneOrphanData(g, oldId);
      } else if (field === 'sobject') {
        if (!target || target.type !== 'data') throw new Error('only a record carries an SObject');
        if (String(value).trim()) target.sobject = String(value).trim(); else delete target.sobject;
      } else if (field === 'catalog') {
        var manual = String(value).trim();
        if (!manual) throw new Error('a step needs a catalog name (<noun>.<verb>)');
        setCatalog(g, edge, manual);
        recatalogChecks(target, oldCat, manual, edge.id);
      } else if (field === 'capability') {
        if (edge.type !== 'denied') throw new Error('only a must-not line names a capability');
        edge.data = edge.data || {};
        edge.data.capability = String(value).trim();
        recatalogChecks(target, oldCat, edge.data.capability, edge.id);
      } else if (field === 'io') {
        edge.data = edge.data || {};
        if (String(value).trim()) { edge.data.io = value; delete edge.data.ioDraft; }
        else { delete edge.data.io; delete edge.data.ioDraft; }
      } else if (field === 'origin') {
        if (!target || target.type !== 'data') throw new Error('only a record has an origin');
        if (String(value).trim()) target.origin = value; else delete target.origin;
      } else if (field === 'notes') {
        if (!target) throw new Error('nothing to note');
        if (String(value).trim()) target.notes = String(value).trim(); else delete target.notes;
      } else {
        throw new Error("step has no field '" + field + "'");
      }
    });
  }

  function moveStep(edgeId, dir) {
    return apply('moveStep', function (g) {
      var edge = findEdge(g, edgeId);
      if (!edge || !STEP_TYPES[edge.type]) throw new Error("no step '" + edgeId + "'");
      var positions = [];
      for (var i = 0; i < g.edges.length; i++) {
        if (g.edges[i].from === edge.from && STEP_TYPES[g.edges[i].type]) positions.push(i);
      }
      var at = positions.indexOf(g.edges.indexOf(edge));
      var to = dir === 'up' ? at - 1 : at + 1;
      if (to < 0 || to >= positions.length) throw new Error('already ' + (dir === 'up' ? 'first' : 'last') + ' in this session');
      var a = positions[at];
      var b = positions[to];
      var tmp = g.edges[a];
      g.edges[a] = g.edges[b];
      g.edges[b] = tmp;
    });
  }

  function deleteStep(edgeId) {
    return apply('deleteStep', function (g) {
      var edge = findEdge(g, edgeId);
      if (!edge || !STEP_TYPES[edge.type]) throw new Error("no step '" + edgeId + "'");
      var target = findNode(g, edge.to);
      var cat = catalogOf(edge);
      if (target && target.expects) {
        target.expects = target.expects.filter(function (x) { return x.after !== cat && x.after !== edge.id; });
        if (!target.expects.length) delete target.expects;
      }
      g.edges = g.edges.filter(function (e) { return e.id !== edgeId; });
      pruneOrphanData(g, edge.to);
    });
  }

  // ---------- infra nodes: db · logger · api (parity §2 `b_add` → db/logger/api)
  //
  // v1 offered these on the add ▾ menu and left you to wire them. Here they
  // are created FROM the thing that needs them — a `db.query` check needs a
  // database, a `log.traffic` check needs a log system, a "replicated to"
  // needs an api hop — and the edge that ties them to the flow is written in
  // the same transaction, so an evidence source can never arrive orphaned.

  var INFRA_TYPES = { db: 1, logger: 1, api: 1 };
  var INFRA_NAME = { db: 'Database', logger: 'Log system', api: 'Endpoint' };

  /** An existing infra node of this kind with this label, or a new one. */
  function findOrCreateInfra(g, kind, label, opts) {
    var want = String(label || '').trim() || INFRA_NAME[kind];
    for (var i = 0; i < g.nodes.length; i++) {
      var n = g.nodes[i];
      if (n.type === kind && String(n.label || '').trim().toLowerCase() === want.toLowerCase()) return n;
    }
    var node = { id: freshNodeId(g, P2.slug(want), kind), type: kind, label: want };
    // The validator refuses a db.query onto a db that is not `queryable` and a
    // log.traffic onto a logger marked `searchable:false`, so the default is
    // the reachable one — the checkbox is how you say otherwise.
    if (kind === 'db') node.queryable = !(opts && opts.queryable === false);
    if (kind === 'logger') node.searchable = !(opts && opts.searchable === false);
    if (kind === 'api') {
      var ep = {};
      if (opts && opts.method) ep.method = String(opts.method).trim().toUpperCase();
      if (opts && opts.path) ep.path = String(opts.path).trim();
      if (ep.method || ep.path) node.endpoint = ep;
    }
    g.nodes.push(node);
    return node;
  }

  /**
   * Add (or reuse) an evidence source. `opts.sessionId` wires a `touches` edge
   * from that session — the relation `infer.relationFor('session', 'db')`
   * names — so the node is part of the flow, not a floating picture.
   */
  function addInfraNode(kind, label, opts) {
    return apply('addInfraNode', function (g, out) {
      if (!INFRA_TYPES[kind]) throw new Error("an evidence source is a db, a logger or an api (got '" + kind + "')");
      var node = findOrCreateInfra(g, kind, label, opts);
      var from = opts && opts.sessionId;
      if (from) {
        var session = findNode(g, from);
        if (!session || session.type !== 'session') throw new Error("no session '" + from + "' to reach it from");
        var already = false;
        for (var i = 0; i < g.edges.length; i++) {
          if (g.edges[i].from === from && g.edges[i].to === node.id && g.edges[i].type === 'touches') already = true;
        }
        if (!already) {
          g.edges.push({ id: freshEdgeId(g, 'e_touch_' + P2.slug(node.id), []), from: from, to: node.id, type: 'touches' });
        }
      }
      out.id = node.id;
      out.value = node.id;
    });
  }

  /** label · queryable · searchable · method · path — the db/logger/api form. */
  function setInfraField(nodeId, field, value) {
    return apply('setInfraField', function (g) {
      var n = findNode(g, nodeId);
      if (!n || !INFRA_TYPES[n.type]) throw new Error("no evidence source '" + nodeId + "'");
      if (field === 'label') {
        n.label = String(value).trim() || INFRA_NAME[n.type];
      } else if (field === 'queryable') {
        if (n.type !== 'db') throw new Error('only a database is queryable');
        n.queryable = !!value;
      } else if (field === 'searchable') {
        if (n.type !== 'logger') throw new Error('only a log system is searchable');
        n.searchable = !!value;
      } else if (field === 'method' || field === 'path') {
        if (n.type !== 'api') throw new Error('only an api node names an endpoint');
        n.endpoint = n.endpoint || {};
        var text = String(value).trim();
        if (text) n.endpoint[field] = field === 'method' ? text.toUpperCase() : text;
        else delete n.endpoint[field];
        if (!Object.keys(n.endpoint).length) delete n.endpoint;
      } else {
        throw new Error("an evidence source has no field '" + field + "'");
      }
    });
  }

  /**
   * "replicated to →" (parity §5 `handoff`): the record crosses an integration
   * boundary into an api hop. The api node is found or created with its
   * method/path (`nf_method` / `nf_path`), and a `handoff` edge records the
   * crossing — the edge whose `produces` port the log.traffic check on the far
   * side then proves.
   */
  function addHandoff(recordId, apiLabel, opts) {
    return apply('addHandoff', function (g, out) {
      var rec = findNode(g, recordId);
      if (!rec || rec.type !== 'data') throw new Error("no record '" + recordId + "' to replicate");
      var api = findOrCreateInfra(g, 'api', apiLabel, opts);
      for (var i = 0; i < g.edges.length; i++) {
        if (g.edges[i].from === recordId && g.edges[i].to === api.id && g.edges[i].type === 'handoff') {
          out.id = g.edges[i].id;
          out.value = api.id;
          return;
        }
      }
      var edge = { id: freshEdgeId(g, 'e_handoff_' + P2.slug(api.id), []), from: recordId, to: api.id, type: 'handoff' };
      if (rec.ref || rec.id) edge.data = { recordRef: rec.ref || rec.id };
      g.edges.push(edge);
      out.id = edge.id;
      out.value = api.id;
    });
  }

  function removeHandoff(edgeId) {
    return apply('removeHandoff', function (g) {
      var edge = findEdge(g, edgeId);
      if (!edge || edge.type !== 'handoff') throw new Error("no handoff '" + edgeId + "'");
      g.edges = g.edges.filter(function (e) { return e.id !== edgeId; });
    });
  }

  // ---------- snapshot + notes (parity §4 `nf_snapshot`, `nf_notes`) ----------

  /**
   * The run-evidence image. A merge-back writes `{status:'captured', ref}`;
   * this is the MANUAL half — the file input hands over a data URL (or a
   * relative path once evidence lives on disk, sprint 4.2) and an empty ref
   * clears the slot. Nothing else about the node is touched, so attaching a
   * picture can never invalidate a graph.
   */
  function setSnapshot(nodeId, ref, status) {
    return apply('setSnapshot', function (g) {
      var n = findNode(g, nodeId);
      if (!n) throw new Error("no node '" + nodeId + "'");
      var text = String(ref === null || ref === undefined ? '' : ref).trim();
      if (!text) { delete n.snapshot; return; }
      n.snapshot = {
        status: status === 'captured' ? 'captured' : (n.snapshot && n.snapshot.status) || 'planned',
        ref: text,
      };
      if (n.snapshot.status === 'captured' && !n.snapshot.capturedAt) n.snapshot.capturedAt = new Date().toISOString();
    });
  }

  /** `nf_notes` on any node — the one writer every card's notes field uses. */
  function setNotes(nodeId, text) {
    return apply('setNotes', function (g) {
      var n = findNode(g, nodeId);
      if (!n) throw new Error("no node '" + nodeId + "'");
      var v = String(text === null || text === undefined ? '' : text).trim();
      if (v) n.notes = v; else delete n.notes;
    });
  }

  // ---------- checks (node `expects`) ----------

  function freshExpectId(node, base) {
    var taken = (node.expects || []).map(function (x) { return x.id; });
    return P2.uniqueId(taken, base, 'check');
  }

  /**
   * A new check is a DRAFT with a plausible shape — an api.record_exists when
   * the record knows its SObject, else "the record's name is on the screen".
   * Both are valid documents, so the graph never becomes unsaveable because
   * someone clicked "+ check"; the amber pill asks for confirmation.
   */
  function addCheck(edgeId, kind, target) {
    return apply('addCheck', function (g, out) {
      var edge = findEdge(g, edgeId);
      if (!edge || !STEP_TYPES[edge.type]) throw new Error("no step '" + edgeId + "'");
      var node = findNode(g, edge.to);
      if (!node) throw new Error('this step lands nowhere');
      var cat = catalogOf(edge) || catalogNow(g, edge, P2.view.verbOf(edge));
      var x;
      if (kind) {
        x = { id: freshExpectId(node, P2.slug(cat) + '_' + P2.slug(kind)), kind: kind, draft: true };
        if (/^api\./.test(kind)) x.target = node.sobject || 'Account';
        if (kind === 'ui.visible') x.target = node.label || node.id;
        if (kind === 'api.field_equals') x.value = 'Status=TODO';
        if (kind === 'ui.text' || kind === 'ui.toast') x.value = node.label || node.id;
        if (kind === 'ui.url') x.value = '/lightning/r/';
        // A backend check names the node it interrogates. The card picks or
        // creates that node FIRST and hands the id in — this is the refusal
        // that used to be the only answer (parity §2 db / logger row).
        if (kind === 'db.query' || kind === 'log.traffic') {
          var wantType = kind === 'db.query' ? 'db' : 'logger';
          var infra = target ? findNode(g, target) : null;
          if (!infra || infra.type !== wantType) {
            throw new Error(kind + " needs a " + (wantType === 'db' ? 'database' : 'log system') +
              ' — pick or create one on the card first');
          }
          x.target = infra.id;
          x.value = kind === 'db.query' ? (node.sobject || node.label || node.id) : (node.label || node.id);
        }
      } else if (node.sobject) {
        x = { id: freshExpectId(node, P2.slug(cat) + '_exists'), kind: 'api.record_exists', target: node.sobject, draft: true };
      } else {
        x = { id: freshExpectId(node, P2.slug(cat) + '_text'), kind: 'ui.text', value: node.label || node.id, draft: true };
      }
      x.after = cat;
      node.expects = (node.expects || []).concat([x]);
      out.id = x.id;
      out.value = node.id;
    });
  }

  function setCheck(nodeId, expectId, field, value) {
    return apply('setCheck', function (g) {
      var node = findNode(g, nodeId);
      if (!node) throw new Error("no node '" + nodeId + "'");
      var x = (node.expects || []).filter(function (e) { return e.id === expectId; })[0];
      if (!x) throw new Error("no check '" + expectId + "'");
      if (field === 'kind') {
        x.kind = value;
        if (/^api\./.test(value) && !x.target) x.target = node.sobject || 'Account';
        if (value === 'api.field_equals' && !x.value) x.value = 'Status=TODO';
        if (!/^(api|db|log)\./.test(value)) { delete x.timeoutMs; delete x.pollMs; }
      } else if (field === 'target') {
        if (String(value).trim()) x.target = String(value).trim(); else delete x.target;
      } else if (field === 'value') {
        if (String(value).trim()) x.value = String(value).trim(); else delete x.value;
      } else if (field === 'note') {
        if (String(value).trim()) x.note = String(value).trim(); else delete x.note;
      } else if (field === 'timeoutMs' || field === 'pollMs') {
        var n = Number(value);
        if (!value && value !== 0) delete x[field];
        else x[field] = Math.round(n);
      } else if (field === 'after') {
        if (String(value).trim()) x.after = String(value).trim(); else delete x.after;
      } else {
        throw new Error("a check has no field '" + field + "'");
      }
      // Editing a guess IS confirming it — the human just wrote the value.
      delete x.draft;
    });
  }

  /** Confirm / remove go through the grillme engine so the planner and the
   *  interrogation loop write the SAME answer (parity: `confirmExpect`). */
  function confirmCheck(nodeId, expectId) {
    return applyAnswerOps([{ op: 'confirmExpect', node: nodeId, id: expectId }]);
  }
  function removeCheck(nodeId, expectId) {
    return applyAnswerOps([{ op: 'removeExpect', node: nodeId, id: expectId }]);
  }

  // ---------- ports ----------

  /** Accept the inferred port (or the drafted one) as authored. */
  function confirmPort(edgeId) {
    var edge = findEdge(state.doc, edgeId);
    if (!edge) return { ok: false, errors: ["no step '" + edgeId + "'"] };
    if (edge.data && edge.data.io) return applyAnswerOps([{ op: 'confirmIo', edge: edgeId }]);
    var guess = null;
    try { guess = P2.lib.infer().inferPorts(state.doc).ports.get(edgeId); } catch (e) { guess = null; }
    if (!guess) return { ok: false, errors: ['nothing to confirm — this step does not touch a record on the walk'] };
    return applyAnswerOps([{ op: 'setIo', edge: edgeId, io: guess.io }]);
  }

  // ---------- grillme write-back ----------

  /** The /grillme ops, applied verbatim (gaps.ts owns the semantics). */
  function applyAnswerOps(opsList) {
    return apply('applyAnswerOps', function (g) {
      var res = P2.lib.gaps().applyAnswers(g, opsList);
      g.nodes = res.graph.nodes;
      g.edges = res.graph.edges;
      g.actors = res.graph.actors;
      g.systems = res.graph.systems;
      if (res.graph.alternatives) g.alternatives = res.graph.alternatives;
    });
  }

  // ---------- layout ----------

  /** `(id, x, y)` or `(id, {x, y})` — the canvas thinks in points. */
  function setLayoutPos(nodeId, x, y) {
    var px = x && typeof x === 'object' ? x.x : x;
    var py = x && typeof x === 'object' ? x.y : y;
    return apply('setLayoutPos', function (g) {
      var n = findNode(g, nodeId);
      if (!n) throw new Error("no node '" + nodeId + "'");
      if (!isFinite(px) || !isFinite(py)) throw new Error('a position needs finite x and y');
      n.pos = { x: Math.round(px), y: Math.round(py) };
    });
  }
  function clearLayout() {
    return apply('clearLayout', function (g) {
      for (var i = 0; i < g.nodes.length; i++) delete g.nodes[i].pos;
    });
  }

  // ---------- recording ----------

  /** ● record — the dev server spawns `npm run record` for this session's
   *  persona (parity `nf_capture`). The graph is only marked captured when
   *  the run comes back clean, so the document never claims a capture that
   *  did not happen. */
  function record(sessionId) {
    return P2.net.startRecording(sessionId);
  }

  // ---------- undo ----------

  function undo() {
    if (!state.undo.length) return { ok: false, errors: ['nothing to undo'] };
    state.doc = state.undo.pop();
    state.dirty = true;
    P2.bus.emit('change', { op: 'undo' });
    return { ok: true, errors: [] };
  }
  function undoDepth() { return state.undo.length; }

  P2.ops = {
    newGraph: newGraph,
    blankGraph: blankGraph,
    loadDoc: loadDoc,
    setMeta: setMeta,
    addSystem: addSystem,
    setSystem: setSystem,
    setSystemDef: setSystemDef,
    addSession: addSession,
    setSessionField: setSessionField,
    moveSession: moveSession,
    moveSessionAfter: moveSessionAfter,
    deleteSession: deleteSession,
    addStep: addStep,
    setStepField: setStepField,
    moveStep: moveStep,
    deleteStep: deleteStep,
    addInfraNode: addInfraNode,
    setInfraField: setInfraField,
    addHandoff: addHandoff,
    removeHandoff: removeHandoff,
    setSnapshot: setSnapshot,
    setNotes: setNotes,
    addCheck: addCheck,
    setCheck: setCheck,
    confirmCheck: confirmCheck,
    removeCheck: removeCheck,
    confirmPort: confirmPort,
    applyAnswerOps: applyAnswerOps,
    setLayoutPos: setLayoutPos,
    clearLayout: clearLayout,
    record: record,
    undo: undo,
    undoDepth: undoDepth,
    // shared with the views
    guessSobject: guessSobject,
    findNode: findNode,
    findEdge: findEdge,
    catalogOf: catalogOf,
    apply: apply,
  };
})();
