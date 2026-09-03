/**
 * P2/canvas — the document, DRAWN (sprint 3.2).
 *
 * The canvas is a RENDERING of the ProcessGraph (review §5.1: "the canvas
 * remains — but as the rendering and the report"), never a second model. It
 * reads `P2.state.doc` and the projection main.js hands it, and writes only
 * through `P2.ops.*`. Cytoscape holds no truth: every element is derived from
 * the document on each render, matched BY ID, and patched in place inside one
 * `cy.batch()` — no destroy-and-rebuild, so pan, zoom, hover and an in-flight
 * drag survive an edit somewhere else in the shell (v1 rebuilt and re-fit on
 * every keystroke, which is why its card kept flying off).
 *
 * The picture is the approved one (docs/PROTOTYPE-journey-script-planner.html
 * `renderCanvas`): the login chain is the spine across the top, each session
 * is a LANE — a cytoscape compound parent whose children are its step boxes —
 * and the records sit in a shared row below, so a record two lanes both touch
 * is visibly one node. Ports colour the step→record edges: produces green,
 * consumes grey, updates ochre, must-not red dashed, a drafted guess dashed.
 *
 * Positions. `node.pos` is the saved layout. For a plain node it is the
 * node's CENTRE; for a lane it is the lane's ORIGIN — the top-left of the
 * prototype's lane rectangle — because a compound parent's position is
 * derived from its children and cannot be set. `grid()` turns a lane origin
 * into its children's positions and `laneOrigin()` reads it back, so a
 * dragged lane reloads exactly where it was left.
 *
 * Gestures, all of them ported rather than reinvented (parity §6): drag →
 * `setLayoutPos`; edgehandles drag-to-connect → the relation INFERRED from
 * the endpoint types (`src/graph/infer.ts`) with a `does / must not` choice
 * on drop; SPACE-drag rubber band → group box with a grip; `dbltap` on empty
 * canvas → a new session there; `dbltap` on a lane → ● record; hover → the
 * same sentences v1 explained itself with; run results painted as borders.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  // ---------- geometry (the prototype's lane grid, in code) ----------

  // The lane rectangle is a COMPOUND node: cytoscape derives its box from its
  // children plus one uniform `padding`, so the padding is what reserves the
  // header strip (label + system + the recorded chip) INSIDE the lane top —
  // which is why HEAD_H and LANE_PAD are the same number, and why LANE_W is
  // derived from the step width rather than the other way round.
  var LANE_PAD = 58;     // header strip / lane inset (up to 3 header lines)
  var STEP_W = 176;      // step box width
  var LANE_W = STEP_W + LANE_PAD * 2;   // the drawn lane width
  var LANE_GAP = 40;     // gap between lanes
  var TOP = 40;          // top of the lane row
  var LEFT = 96;         // left of the first lane
  var HEAD_H = LANE_PAD; // lane origin → top of the first step box
  var ROW_H = 80;        // step pitch
  var STEP_H = 66;       // step box height
  var REC_GAP = 120;     // lane bottom → the first record under it
  var REC_ROW = 92;      // pitch of records stacked under one lane
  var EXTRA_GAP = 120;   // a record → the infra node it references
  var INFRA_STEP = 150;  // side-by-side infra under one record
  var TERM_R = 16;       // start / end radius

  var STEP_TYPES = { does: 1, denied: 1, asserts: 1 };
  var THIN_TYPES = { handoff: 1, touches: 1, requires: 1, next: 1 };

  // ---------- module state ----------

  var cy = null;          // the ONE cytoscape instance, mounted once
  var eh = null;          // edgehandles
  var mounted = false;
  var layers = null;      // {overlay, tip, box, anchor, pop} — DOM over the stage
  var model = null;       // the last projection, for the event handlers
  var pendingPos = null;  // ids whose position must be persisted after a drag
  var spaceHeld = false;
  var lastDrop = null;    // {source, target, kind, record} — the open popover
  var asking = false;     // this module is the one asking for the selection
  var glued = false;      // …so the card belongs to the canvas, not the line

  /**
   * Select FROM the canvas. The card glues to the node the human clicked
   * (parity §6: "card flies out, glued through pan zoom drag") — but only
   * then: a selection made in the script pane keeps its card beside the LINE,
   * or the card would sit on top of the pane being typed into.
   */
  function pick(sel) {
    asking = true;
    P2.ui.select(sel, true);
    asking = false;
  }

  function stage() { return document.getElementById('cy'); }
  function editable() { return state.mode !== 'view'; }
  function infer() { return P2.lib.infer(); }

  // ---------- ids ----------
  //
  // One namespace per drawn thing, so a doc node id and a doc edge id can
  // never collide inside cytoscape: nodes keep their own id, steps are
  // `step:<edgeId>`, and the three edge families carry their own prefix.

  function stepId(edgeId) { return 'step:' + edgeId; }
  function chainId(edgeId) { return 'chain:' + edgeId; }
  function ioId(edgeId) { return 'io:' + edgeId; }
  function relId(edgeId) { return 'rel:' + edgeId; }

  /** A drawn element's id → the document id it stands for. */
  function docIdOf(id) {
    var i = String(id).indexOf(':');
    return i < 0 ? String(id) : String(id).slice(i + 1);
  }

  // ---------- little helpers ----------

  function fmtMs(ms) { return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's'; }

  /** pass / fail / '' over a list of `expects` — v1's `expAggregate`. */
  function aggregate(list) {
    var xs = list || [];
    if (!xs.length) return '';
    var fail = false;
    var allPass = true;
    for (var i = 0; i < xs.length; i++) {
      var r = xs[i] && xs[i].lastResult;
      if (r && r.status === 'fail') fail = true;
      if (!r || r.status !== 'pass') allPass = false;
    }
    return fail ? 'fail' : allPass ? 'pass' : '';
  }
  /** A lane is red if ANY step failed, green only if every verdict passed. */
  function worst(a, b) {
    if (a === 'fail' || b === 'fail') return 'fail';
    if (a === 'pass' && (b === 'pass' || b === '')) return 'pass';
    if (b === 'pass' && a === '') return 'pass';
    return '';
  }

  /** Model ↔ screen. Positions arrive from cytoscape events in MODEL space;
   *  the HTML overlays live in the container's rendered space. */
  function toRendered(p) {
    if (!cy || !p) return p;
    var z = cy.zoom();
    var pan = cy.pan();
    return { x: p.x * z + pan.x, y: p.y * z + pan.y };
  }

  function nodeById(id) { return P2.ops.findNode(state.doc, id); }
  function edgeById(id) { return P2.ops.findEdge(state.doc, id); }

  // ---------- the lane grid ----------

  /** The uniform lane height every lane is drawn at (the prototype's rule). */
  function laneHeight(lines) {
    var maxSteps = 1;
    for (var i = 0; i < lines.sessions.length; i++) maxSteps = Math.max(maxSteps, lines.sessions[i].steps.length);
    return HEAD_H + (maxSteps - 1) * ROW_H + STEP_H + LANE_PAD;
  }

  var STATE_TYPES = { data: 1, checkpoint: 1, screen: 1 };
  var INFRA_TYPES = { db: 1, logger: 1, api: 1 };

  /**
   * FIRST TOUCH — data node id → the session that first lands on it, in
   * `lines.sessions` (runOrder) order. The same rule `infer.inferPorts` uses
   * to decide the port, so the picture and the data flow agree by
   * construction: the lane that PRODUCES a record is the lane it hangs under,
   * and a record several lanes touch belongs to the first of them.
   */
  function firstTouch(lines) {
    var owner = {};
    for (var i = 0; i < lines.sessions.length; i++) {
      var steps = lines.sessions[i].steps;
      for (var j = 0; j < steps.length; j++) {
        if (owner[steps[j].recordId] === undefined) owner[steps[j].recordId] = lines.sessions[i].id;
      }
    }
    return owner;
  }

  /**
   * The record an infra node belongs under: the record whose CHECK targets it
   * (`db.query` / `log.traffic`), or the record on the other end of a
   * `handoff`. Infra nothing references has no home and falls to the last
   * lane's column.
   */
  function infraHost(doc, infraId) {
    for (var e = 0; e < doc.edges.length; e++) {
      var edge = doc.edges[e];
      if (edge.type !== 'handoff') continue;
      if (edge.to === infraId) return edge.from;
      if (edge.from === infraId) return edge.to;
    }
    for (var n = 0; n < doc.nodes.length; n++) {
      var node = doc.nodes[n];
      if (!STATE_TYPES[node.type]) continue;
      var xs = node.expects || [];
      for (var x = 0; x < xs.length; x++) if (xs[x] && xs[x].target === infraId) return node.id;
    }
    return '';
  }

  /**
   * Where everything goes when nothing has been dragged.
   *
   * Lanes run left→right in chain order. Every record sits in the COLUMN of
   * the lane that first touches it (records of one lane stacked downwards),
   * so a step→record edge is a short hop straight down instead of a wire
   * across the whole drawing — the owner's finding on the real
   * `lead_to_customer` graph, where one shared record row made every edge
   * cross every other. Infra hangs under the record that references it.
   * A node with a saved `pos` overrides its slot.
   */
  function grid(lines, doc) {
    var laneH = laneHeight(lines);
    var span = Math.max(1, lines.sessions.length * (LANE_W + LANE_GAP) - LANE_GAP);
    var recY = TOP + laneH + REC_GAP;
    var origins = {};
    var centres = {};
    var column = {};      // session id → the x of its column centre
    var i;

    for (i = 0; i < lines.sessions.length; i++) {
      var s = lines.sessions[i];
      var slot = { x: LEFT + i * (LANE_W + LANE_GAP), y: TOP };
      column[s.id] = slot.x + LANE_W / 2;
      origins[s.id] = savedPos(doc, s.id) || slot;
    }
    var lastLane = lines.sessions.length ? lines.sessions[lines.sessions.length - 1].id : '';
    var fallbackX = column[lastLane] !== undefined ? column[lastLane] : LEFT + LANE_W / 2;

    var owner = firstTouch(lines);
    var stack = {};       // session id → how many records are already under it
    var laneOf = {};      // record id → the lane column it landed in
    for (i = 0; i < doc.nodes.length; i++) {
      var node = doc.nodes[i];
      if (!STATE_TYPES[node.type]) continue;
      var lane = owner[node.id] || lastLane;
      var x = column[lane] !== undefined ? column[lane] : fallbackX;
      var k = stack[lane] === undefined ? 0 : stack[lane];
      stack[lane] = k + 1;
      laneOf[node.id] = lane;
      centres[node.id] = savedPos(doc, node.id) || { x: x, y: recY + k * REC_ROW };
    }

    // Infra goes UNDER the whole record column, not under its own host row:
    // a column with two records would otherwise put the second record and the
    // first record's database in the same place.
    var under = {};       // lane → how many infra nodes are already below it
    for (i = 0; i < doc.nodes.length; i++) {
      var infra = doc.nodes[i];
      if (!INFRA_TYPES[infra.type]) continue;
      var host = infraHost(doc, infra.id);
      var col = (host && laneOf[host] !== undefined) ? laneOf[host] : lastLane;
      var cx = (host && centres[host]) ? centres[host].x : (column[col] !== undefined ? column[col] : fallbackX);
      var deep = recY + Math.max(1, stack[col] || 1) * REC_ROW;
      var m = under[col || '*'] === undefined ? 0 : under[col || '*'];
      under[col || '*'] = m + 1;
      centres[infra.id] = savedPos(doc, infra.id) ||
        { x: cx, y: deep + EXTRA_GAP + m * REC_ROW };
    }

    // Anything the two passes above did not place — an orphan of a type the
    // grid has no column for — gets its own row rather than a pile at 0,0.
    var strays = 0;
    for (i = 0; i < doc.nodes.length; i++) {
      var other = doc.nodes[i];
      if (origins[other.id] || centres[other.id]) continue;
      if (other.type === 'start' || other.type === 'end' || other.type === 'session') continue;
      centres[other.id] = savedPos(doc, other.id) ||
        { x: LEFT + strays * INFRA_STEP, y: recY + EXTRA_GAP * 2 };
      strays += 1;
    }

    for (i = 0; i < doc.nodes.length; i++) {
      var term = doc.nodes[i];
      if (term.type !== 'start' && term.type !== 'end') continue;
      centres[term.id] = savedPos(doc, term.id) ||
        (term.type === 'start'
          ? { x: LEFT - 54, y: TOP + laneH / 2 }
          : { x: LEFT + span + 44, y: TOP + laneH / 2 });
    }

    return { origins: origins, centres: centres, laneH: laneH, span: span, recY: recY };
  }

  function savedPos(doc, id) {
    var n = P2.ops.findNode(doc, id);
    return n && n.pos && typeof n.pos.x === 'number' ? { x: n.pos.x, y: n.pos.y } : null;
  }

  /** Step j of a lane whose origin is `o` — its box CENTRE. */
  function stepCentre(o, j) {
    return { x: o.x + LANE_W / 2, y: o.y + HEAD_H + j * ROW_H + STEP_H / 2 };
  }

  /** The inverse: a lane's origin, read back off the elements as drawn. */
  function laneOrigin(laneNode) {
    var kids = laneNode.children();
    if (kids.length) {
      var first = kids[0];
      var p = first.position();
      return { x: p.x - LANE_W / 2, y: p.y - HEAD_H - STEP_H / 2 };
    }
    var q = laneNode.position();
    return { x: q.x - LANE_W / 2, y: q.y - HEAD_H - STEP_H / 2 };
  }

  // ---------- labels ----------

  /** `<system> · <role>` (infer.sessionLabel) over the lane's own state. */
  function laneLabel(session) {
    var live = state.recording[session.id];
    var bits = [live ? 'recording…' : session.captured ? '✓ recorded' : 'not recorded yet'];
    var mean = session.node.timing && session.node.timing.capturedMeanMs;
    if (mean) bits.push(fmtMs(mean));
    if (session.stranded) bits.push('not on the login chain');
    return session.label + '\n' + bits.join(' · ');
  }

  function stepLabel(step) {
    var head = (step.kind === 'denied' ? '✕ must not ' : '') + (step.verb || '?') + ' ' + (step.record || '?');
    var bits = [step.catalog];
    if (step.port) bits.push(step.port.io + (step.port.draft ? '?' : ''));
    if (step.checks.length) bits.push(step.checks.length + ' check' + (step.checks.length === 1 ? '' : 's'));
    var ms = step.edge.data && (step.edge.data.meanMs !== undefined ? step.edge.data.meanMs : step.edge.data.deltaMs);
    if (ms) bits.push(fmtMs(ms));
    return head + '\n' + bits.join(' · ');
  }

  function recordLabel(node) {
    return (node.label || node.id) + '\n' + (node.sobject || 'SObject?');
  }

  // ---------- the element set ----------

  /** The document, as the elements the canvas draws. Pure — no cy calls. */
  function build(doc, lines) {
    var g = grid(lines, doc);
    var nodes = [];
    var edges = [];
    var laneOf = {};        // step edge id → session id
    var stepExp = {};       // step edge id → pass|fail|''
    var drawn = {};

    for (var i = 0; i < lines.sessions.length; i++) {
      var s = lines.sessions[i];
      var o = g.origins[s.id];
      var live = !!state.recording[s.id];
      var laneExp = '';
      for (var j = 0; j < s.steps.length; j++) {
        var step = s.steps[j];
        var exp = aggregate(step.checks.map(function (c) { return c.expect; }));
        laneExp = worst(laneExp, exp);
        stepExp[step.edgeId] = exp;
        laneOf[step.edgeId] = s.id;
        nodes.push({
          data: { id: stepId(step.edgeId), parent: s.id, label: stepLabel(step), kind: 'step', doc: step.edgeId, exp: exp },
          position: stepCentre(o, j),
          classes: 'step ' + step.kind + (exp ? ' ' + exp : ''),
          grabbable: false,
        });
        drawn[stepId(step.edgeId)] = 1;
      }
      nodes.push({
        data: { id: s.id, label: laneLabel(s), kind: 'lane', doc: s.id, exp: laneExp },
        position: s.steps.length ? undefined : stepCentre(o, 0),
        classes: 'lane' + (s.stranded ? ' stranded' : '') + (live ? ' recording' : '') + (laneExp ? ' ' + laneExp : ''),
      });
      drawn[s.id] = 1;
    }

    for (var n = 0; n < doc.nodes.length; n++) {
      var node = doc.nodes[n];
      if (drawn[node.id] || node.type === 'session') continue;
      var kind = node.type === 'data' ? 'record' : node.type === 'start' || node.type === 'end' ? 'terminal' : node.type;
      nodes.push({
        data: {
          id: node.id, kind: kind, doc: node.id, exp: aggregate(node.expects),
          label: kind === 'terminal' ? node.type : kind === 'record' ? recordLabel(node) : (node.label || node.id),
        },
        position: g.centres[node.id] || { x: 0, y: 0 },
        classes: kind + (aggregate(node.expects) ? ' ' + aggregate(node.expects) : ''),
      });
      drawn[node.id] = 1;
    }

    for (var e = 0; e < doc.edges.length; e++) {
      var edge = doc.edges[e];
      if (edge.type === 'login_as') {
        if (!drawn[edge.from] || !drawn[edge.to]) continue;
        edges.push({ data: { id: chainId(edge.id), source: edge.from, target: edge.to, doc: edge.id, kind: 'login_as', label: 'login as' }, classes: 'chain' });
      } else if (STEP_TYPES[edge.type]) {
        var src = drawn[stepId(edge.id)] ? stepId(edge.id) : edge.from;
        if (!drawn[src] || !drawn[edge.to]) continue;
        var port = lines.ports[edge.id];
        var io = (edge.data && edge.data.io) || (port && port.io) || '';
        var draft = edge.data && edge.data.io ? edge.data.ioDraft === true : !!port;
        edges.push({
          data: { id: ioId(edge.id), source: src, target: edge.to, doc: edge.id, kind: edge.type, io: io, label: io || edge.type },
          classes: 'io ' + edge.type + (io ? ' ' + io : '') + (draft ? ' draft' : '') + (stepExp[edge.id] ? ' ' + stepExp[edge.id] : ''),
        });
      } else if (THIN_TYPES[edge.type]) {
        if (!drawn[edge.from] || !drawn[edge.to]) continue;
        edges.push({ data: { id: relId(edge.id), source: edge.from, target: edge.to, doc: edge.id, kind: edge.type, label: edge.type === 'next' ? '' : edge.type }, classes: 'thin ' + edge.type });
      }
    }
    return { nodes: nodes, edges: edges, grid: g, laneOf: laneOf };
  }

  // ---------- style ----------

  /**
   * The palette is READ OFF THE PAGE, not hard-coded: style.css owns the
   * prototype's tokens and flips them for dark mode, and a canvas painted in
   * light-mode hexes over a dark panel is exactly what the owner saw ("small
   * grey boxes with tiny text"). One lookup per mount, re-applied when the
   * scheme changes.
   */
  function cssVar(name, fallback) {
    try {
      var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    } catch (e) { return fallback; }
  }

  function palette() {
    return {
      panel: cssVar('--panel', '#FFFFFF'),
      panel2: cssVar('--panel2', '#F7F8FA'),
      ink: cssVar('--ink', '#171C24'),
      ink2: cssVar('--ink2', '#4B5563'),
      muted: cssVar('--muted', '#7B8494'),
      line: cssVar('--line', '#D8DCE3'),
      accent: cssVar('--accent', '#1D4ED8'),
      accentSoft: cssVar('--accent-soft', '#E4ECFF'),
      record: cssVar('--record', '#A8712A'),
      recordSoft: cssVar('--record-soft', '#F7ECDC'),
      session: cssVar('--session', '#3C6E9E'),
      sessionSoft: cssVar('--session-soft', '#E3EDF7'),
      ok: cssVar('--ok', '#2F855A'),
      okSoft: cssVar('--ok-soft', '#E3F3EA'),
      warn: cssVar('--warn', '#B7791F'),
      warnSoft: cssVar('--warn-soft', '#FBF0D9'),
      bad: cssVar('--bad', '#C53030'),
      badSoft: cssVar('--bad-soft', '#FBE4E4'),
    };
  }

  /**
   * The prototype's look, as cytoscape style. Two deliberate departures from
   * a naive port, both from driving the real graph:
   *
   *  - step→record edges are `taxi` (orthogonal drops) rather than beziers,
   *    so two lanes feeding the same record no longer overprint each other;
   *  - edge labels are drawn ONLY on hover or selection (`.hot`, `:selected`),
   *    because at rest a dozen `produces` captions sat on top of one another.
   */
  function styleSheet() {
    var C = palette();
    return [
      {
        selector: 'node', style: {
          label: 'data(label)', 'font-size': 12, 'text-wrap': 'wrap', 'text-max-width': 168,
          color: C.ink2, 'background-color': C.panel, 'border-width': 1, 'border-color': C.line,
          shape: 'round-rectangle', 'text-valign': 'center', 'corner-radius': 8,
        },
      },
      {
        selector: 'node.lane', style: {
          shape: 'round-rectangle', 'corner-radius': 8,
          'background-color': C.sessionSoft, 'background-opacity': 0.85,
          'border-color': C.session, 'border-width': 1, padding: LANE_PAD,
          // `text-valign: top` anchors a label OUTSIDE the top edge, so the
          // margin is what pulls the two header lines back INSIDE the lane's
          // padding strip — the parity row "header text inside the lane top".
          'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': 53,
          'text-max-width': LANE_W - 66,
          'font-size': 13, 'font-weight': 'bold', color: C.session, 'line-height': 1.35,
          'compound-sizing-wrt-labels': 'exclude',
          // Ignored while the lane has children; the size of an EMPTY lane.
          width: LANE_W, height: HEAD_H + STEP_H + LANE_PAD,
        },
      },
      { selector: 'node.lane.stranded', style: { 'border-style': 'dashed', 'border-color': C.warn, color: C.warn } },
      { selector: 'node.lane.recording', style: { 'border-width': 2.5, 'border-color': C.bad } },
      {
        selector: 'node.step', style: {
          width: STEP_W, height: STEP_H, shape: 'round-rectangle', 'corner-radius': 6,
          'background-color': C.panel, 'border-color': C.line,
          'text-max-width': STEP_W - 16, 'font-size': 12, 'line-height': 1.3, color: C.ink,
        },
      },
      { selector: 'node.step.denied', style: { 'border-color': C.bad, 'border-style': 'dashed', color: C.bad } },
      {
        selector: 'node.record', style: {
          shape: 'round-rectangle', 'corner-radius': 25, width: 172, height: 50,
          'background-color': C.recordSoft, 'border-color': C.record, color: C.record,
          'font-size': 13, 'font-weight': 'bold', 'text-max-width': 152, 'line-height': 1.3,
        },
      },
      { selector: 'node.checkpoint', style: { shape: 'hexagon', width: 146, height: 58, 'background-color': C.okSoft, 'border-color': C.ok, color: C.ok, 'text-max-width': 104 } },
      { selector: 'node.db', style: { shape: 'barrel', width: 138, height: 54, 'background-color': C.okSoft, 'border-color': C.ok, color: C.ok } },
      { selector: 'node.logger', style: { shape: 'round-tag', width: 138, height: 50, 'background-color': C.warnSoft, 'border-color': C.warn, color: C.warn } },
      { selector: 'node.api', style: { shape: 'round-hexagon', width: 144, height: 54, 'background-color': C.accentSoft, 'border-color': C.accent, color: C.accent } },
      { selector: 'node.screen', style: { shape: 'rectangle', width: 124, height: 44 } },
      { selector: 'node.terminal', style: { shape: 'ellipse', width: TERM_R * 2, height: TERM_R * 2, 'background-color': C.panel2, 'border-color': C.line, color: C.muted, 'font-size': 11 } },
      // run paint — the same rules v1 painted after a merge-back
      { selector: 'node.pass', style: { 'border-color': C.ok, 'border-width': 2.5 } },
      { selector: 'node.fail', style: { 'border-color': C.bad, 'border-width': 3 } },
      { selector: 'node:selected', style: { 'border-color': C.accent, 'border-width': 3 } },
      {
        selector: 'edge', style: {
          width: 1.4, 'line-color': C.muted, 'target-arrow-color': C.muted, 'target-arrow-shape': 'triangle',
          'curve-style': 'bezier', 'arrow-scale': 0.9, label: '', 'font-size': 10, color: C.ink2,
          'text-background-color': C.panel, 'text-background-opacity': 0.9, 'text-background-padding': 2,
          'text-rotation': 'autorotate',
        },
      },
      // A label at rest is a label on top of another label: show it when the
      // human asks for it (hover) or has selected the edge.
      // Label only — NEVER a z-index change: raising a hovered edge above the
      // nodes makes it the hit target, and the click that follows the hover
      // selects the edge instead of the record under the pointer.
      { selector: 'edge.hot, edge:selected', style: { label: 'data(label)' } },
      { selector: 'edge.chain', style: { width: 2.5, 'line-color': C.session, 'target-arrow-color': C.session, 'curve-style': 'bezier' } },
      // Relations that schedule nothing still have to be SEEN: `--line` is the
      // panel's own hairline colour, which on a dark panel is invisible (owner
      // report 2026-09-03: "some of the graph looks like it's not connected").
      // Muted ink at rest, one dash pattern per relation so they tell apart.
      { selector: 'edge.thin', style: { width: 1.3, 'line-color': C.muted, 'target-arrow-color': C.muted, 'line-style': 'dotted', 'curve-style': 'unbundled-bezier', opacity: 0.9 } },
      { selector: 'edge.thin.handoff', style: { width: 1.6, 'line-color': C.session, 'target-arrow-color': C.session, 'line-style': 'dashed' } },
      { selector: 'edge.thin.requires', style: { 'line-style': 'dashed' } },
      { selector: 'edge.thin.next', style: { 'line-style': 'solid', 'curve-style': 'bezier' } },
      {
        selector: 'edge.io', style: {
          'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': '38%', 'taxi-turn-min-distance': 8,
          'source-endpoint': 'outside-to-node', 'target-endpoint': 'outside-to-node',
        },
      },
      { selector: 'edge.io.produces', style: { width: 2, 'line-color': C.ok, 'target-arrow-color': C.ok } },
      { selector: 'edge.io.consumes', style: { width: 1.4, 'line-color': C.muted, 'target-arrow-color': C.muted } },
      { selector: 'edge.io.updates', style: { width: 1.8, 'line-color': C.record, 'target-arrow-color': C.record } },
      { selector: 'edge.io.draft', style: { 'line-style': 'dashed' } },
      { selector: 'edge.io.denied', style: { 'line-color': C.bad, 'target-arrow-color': C.bad, 'line-style': 'dashed', width: 1.6 } },
      { selector: 'edge.io.asserts', style: { 'line-color': C.ok, 'target-arrow-color': C.ok, 'line-style': 'dotted' } },
      { selector: 'edge.io.pass', style: { 'line-color': C.ok, 'target-arrow-color': C.ok } },
      { selector: 'edge.io.fail', style: { 'line-color': C.bad, 'target-arrow-color': C.bad } },
      { selector: 'edge:selected', style: { 'line-color': C.accent, 'target-arrow-color': C.accent, width: 3 } },
      { selector: '.eh-ghost-edge, .eh-preview', style: { 'line-color': C.accent, 'target-arrow-color': C.accent, 'line-style': 'dashed', 'curve-style': 'bezier' } },
      { selector: '.eh-handle', style: { 'background-color': C.accent, width: 10, height: 10 } },
    ];
  }

  // ---------- mounting ----------

  /**
   * One instance, created on the FIRST render and never destroyed: tab
   * switching only toggles CSS, so the viewport, the selection and the
   * hover state survive a trip through the script tab.
   */
  function mount() {
    if (cy) return cy;
    var host = stage();
    if (!host || typeof window.cytoscape !== 'function') return null;
    try { if (window.cytoscapeDagre) window.cytoscape.use(window.cytoscapeDagre); } catch (e) { /* already registered */ }
    try { if (window.cytoscapeEdgehandles) window.cytoscape.use(window.cytoscapeEdgehandles); } catch (e) { /* already registered */ }
    host.style.position = 'relative';
    cy = window.cytoscape({
      container: host,
      style: styleSheet(),
      wheelSensitivity: 0.2,
      boxSelectionEnabled: false,
      selectionType: 'additive',
    });
    watchScheme();
    window.cy = cy;   // parity: v1 exposed the instance for the harness too
    eh = cy.edgehandles ? cy.edgehandles({
      snap: true,
      canConnect: function (src, tgt) { return !src.same(tgt) && !src.hasClass('terminal'); },
      edgeParams: function () { return { classes: 'eh-preview' }; },
    }) : null;
    layers = makeLayers(host);
    wire();
    observeSize(host);
    mounted = true;
    return cy;
  }

  /** Re-read the palette when the OS scheme flips under an open planner. */
  function watchScheme() {
    if (!window.matchMedia) return;
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var again = function () { if (cy) cy.style(styleSheet()); };
      if (mq.addEventListener) mq.addEventListener('change', again);
      else if (mq.addListener) mq.addListener(again);
    } catch (e) { /* no matchMedia — the mount palette stands */ }
  }

  /**
   * The stage changes size for three reasons — the window, the tab (script /
   * split / canvas) and the library rail — and cytoscape does not notice any
   * of them: it keeps drawing at the size it was created with, which is how
   * the split view ended up clipped on the right. One observer covers all
   * three, and `autoFit` is guarded on the LAST SIZE so a render never
   * re-fits a canvas the human has panned.
   */
  function observeSize(host) {
    if (!window.ResizeObserver) return;
    try {
      var ro = new window.ResizeObserver(function () { autoFit(); });
      ro.observe(host);
    } catch (e) { /* older engine — window resize still calls fit() */ }
  }

  var lastSize = null;
  /** Set by the ops that REPLACE the document — the next render fits it. */
  var refitNext = false;
  var REFIT_OPS = { loadDoc: 1, newGraph: 1, insertGraph: 1, clearLayout: 1 };

  /** Fit ONCE per size change; a no-op while the stage keeps its dimensions. */
  function autoFit() {
    var host = stage();
    if (!cy || !host) return;
    var w = host.clientWidth;
    var h = host.clientHeight;
    if (!w || !h) return;                       // hidden tab — measure again when it returns
    if (lastSize && lastSize.w === w && lastSize.h === h) return;
    lastSize = { w: w, h: h };
    cy.resize();
    if (cy.elements().length) cy.fit(undefined, 30);
    placeLayers();
  }

  /** The HTML that rides ON TOP of the canvas: ● record buttons, the hover
   *  tip, the group box, the card anchor and the does/must-not popover. */
  function makeLayers(host) {
    var mk = function (cls) {
      var d = document.createElement('div');
      d.className = cls;
      host.appendChild(d);
      return d;
    };
    var overlay = mk('cyover');
    var tip = mk('cytip');
    var boxEl = mk('groupbox hide');
    boxEl.id = 'groupbox';
    boxEl.innerHTML = '<div class="gb_frame"></div>' +
      '<div id="gb_grip" title="drag to move the whole selection">⠿ <span id="gb_count"></span></div>' +
      '<div class="gb_hit" style="left:0;right:0;top:-5px;height:10px"></div>' +
      '<div class="gb_hit" style="left:0;right:0;bottom:-5px;height:10px"></div>' +
      '<div class="gb_hit" style="top:0;bottom:0;left:-5px;width:10px"></div>' +
      '<div class="gb_hit" style="top:0;bottom:0;right:-5px;width:10px"></div>';
    var anchor = mk('cyanchor');
    anchor.id = 'cy_anchor';
    var pop = mk('cypop hide');
    pop.id = 'cy_drop';
    return { overlay: overlay, tip: tip, box: boxEl, anchor: anchor, pop: pop };
  }

  // ---------- render ----------

  function render(_state, m) {
    model = m;
    if (!mount()) { fallback(m); return; }
    var els = build(m.doc, m.lines);
    var want = {};
    var i;
    // Read-only mode is read-only on the canvas too: nothing drags, so no
    // gesture can reach an op that would refuse it a moment later.
    cy.autoungrabify(!editable());
    cy.batch(function () {
      for (i = 0; i < els.nodes.length; i++) want[els.nodes[i].data.id] = els.nodes[i];
      for (i = 0; i < els.edges.length; i++) want[els.edges[i].data.id] = els.edges[i];

      var gone = cy.elements().filter(function (el) { return !want[el.id()]; });
      if (gone.length) gone.remove();

      // Parents FIRST: a child added before its parent has nowhere to live.
      var add = [];
      for (i = 0; i < els.nodes.length; i++) if (cy.getElementById(els.nodes[i].data.id).empty()) add.push(els.nodes[i]);
      add.sort(function (a, b) { return (a.data.parent ? 1 : 0) - (b.data.parent ? 1 : 0); });
      for (i = 0; i < els.edges.length; i++) if (cy.getElementById(els.edges[i].data.id).empty()) add.push(els.edges[i]);
      if (add.length) cy.add(add);

      patch(els.nodes);
      patch(els.edges);
      // A newly (re)drawn element carries no selection: re-assert the shell's
      // one selected line, but never over a box selection the user made.
      if (cy.$(':selected').length === 0) {
        var sel = elementFor(state.sel);
        if (sel && !sel.empty()) sel.select();
      }
    });
    // A NEW document is a new picture: fit it once, exactly as opening a file
    // in any viewer does. Otherwise the stage may simply have changed size
    // since the last draw (tab, rail, window) — `autoFit` is a no-op unless it
    // actually did, so an edit never steals the human's pan and zoom.
    if (refitNext) { refitNext = false; fit(); } else autoFit();
    paintOverlay(m);
    placeLayers();
    hint(m);
  }

  /** Update the elements that already exist — data, classes, position. */
  function patch(list) {
    for (var i = 0; i < list.length; i++) {
      var spec = list[i];
      var el = cy.getElementById(spec.data.id);
      if (el.empty()) continue;
      for (var k in spec.data) {
        if (!Object.prototype.hasOwnProperty.call(spec.data, k)) continue;
        if (k === 'id' || k === 'parent' || k === 'source' || k === 'target') continue;
        if (el.data(k) !== spec.data[k]) el.data(k, spec.data[k]);
      }
      // `eh-*` (edgehandles) and `hot` (the hover label) are the canvas's own
      // transient classes: a re-render must not wipe them off mid-gesture.
      var cls = spec.classes || '';
      var live = el.classes().filter(function (c) { return c.indexOf('eh-') !== 0 && c !== 'hot'; }).join(' ');
      if (live !== cls) {
        el.classes(cls + (el.hasClass('eh-source') ? ' eh-source' : '') + (el.hasClass('hot') ? ' hot' : ''));
      }
      if (spec.grabbable === false && el.grabbable()) el.ungrabify();
      if (spec.position && el.isNode() && !el.grabbed()) {
        var p = el.position();
        if (Math.abs(p.x - spec.position.x) > 0.5 || Math.abs(p.y - spec.position.y) > 0.5) el.position(spec.position);
      }
    }
  }

  /** No cytoscape on the page (a stripped build): say so instead of dying. */
  function fallback(m) {
    var host = stage();
    if (!host) return;
    var sessions = (m && m.lines && m.lines.sessions) || [];
    host.innerHTML = '<div class="stub"><div><b>canvas unavailable</b><br>' +
      esc(sessions.length) + ' lane' + (sessions.length === 1 ? '' : 's') +
      ' — cytoscape is not on this page; the script pane edits the same document.</div></div>';
  }

  function hint(m) {
    var el = document.getElementById('canvas_hint');
    if (!el) return;
    var n = state.msel.length;
    if (m && m.lines && !m.lines.sessions.length) {
      el.textContent = 'no sessions yet — double-click the canvas to add one';
    } else if (n > 1) {
      el.textContent = n + ' selected — drag the frame to move them together · Delete removes the selection';
    } else {
      el.textContent = 'drag a lane or record to move it · shift-drag from a lane onto a record to add a step · hold SPACE and drag to rubber-band · double-click empty canvas for a new session';
    }
  }

  // ---------- overlays ----------

  /** ● record, one per lane, in the lane's top-right corner. */
  function paintOverlay(m) {
    if (!layers) return;
    var host = layers.overlay;
    var sessions = (m && m.lines && m.lines.sessions) || [];
    var html = '';
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var live = !!state.recording[s.id];
      var cls = 'recdot' + (live ? ' recording' : s.captured ? ' captured' : '');
      var title = live ? 'recording — close the browser to finish'
        : s.captured ? 'recorded — click to record again' : 'record this role now';
      html += '<button class="' + cls + ' editonly" data-rec="' + esc(s.id) + '" title="' + esc(title) + '">' +
        (s.captured && !live ? '✓' : '●') + '</button>';
    }
    host.innerHTML = html;
    placeOverlay();
  }

  function placeOverlay() {
    if (!cy || !layers) return;
    var btns = layers.overlay.querySelectorAll('[data-rec]');
    for (var i = 0; i < btns.length; i++) {
      var el = cy.getElementById(btns[i].dataset.rec);
      if (el.empty()) { btns[i].style.display = 'none'; continue; }
      var bb = el.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
      btns[i].style.display = '';
      btns[i].style.left = Math.round(bb.x2 - 26) + 'px';
      btns[i].style.top = Math.round(bb.y1 + 6) + 'px';
    }
  }

  /** The transparent element the node card glues itself to (parity: the card
   *  stays beside its node through `pan zoom position`). */
  function placeAnchor() {
    if (!cy || !layers) return;
    var el = elementFor(state.sel);
    if (!el || el.empty()) { layers.anchor.style.display = 'none'; return; }
    var bb = el.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    layers.anchor.style.display = '';
    layers.anchor.style.left = Math.round(bb.x1) + 'px';
    layers.anchor.style.top = Math.round(bb.y1) + 'px';
    layers.anchor.style.width = Math.max(1, Math.round(bb.w)) + 'px';
    layers.anchor.style.height = Math.max(1, Math.round(bb.h)) + 'px';
  }

  function elementFor(sel) {
    if (!cy || !sel) return null;
    if (sel.kind === 'session') return cy.getElementById(sel.id);
    if (sel.kind === 'step') return cy.getElementById(stepId(sel.id));
    return null;
  }

  // ---------- group box (parity: #groupbox, gb_grip, gb_hit) ----------

  /**
   * Re-place every HTML layer over the canvas. Each call is guarded on its
   * own: one bad bounding box must not stop the other three layers from
   * following the viewport (a swallowed throw here is how the ● buttons
   * silently stopped tracking `fit()` the first time round).
   */
  function placeLayers() {
    try { placeGroupBox(); } catch (e) { /* never break the canvas */ }
    try { placeOverlay(); } catch (e) { /* never break the canvas */ }
    try { placeAnchor(); } catch (e) { /* never break the canvas */ }
    if (P2.cards && P2.cards.place) P2.cards.place();
  }

  /** The same, coalesced — for the events that fire per mouse move. */
  var boxRaf = false;
  function refreshGroupBox() {
    if (boxRaf) return;
    boxRaf = true;
    var soon = function (fn) {
      if (window.requestAnimationFrame) window.requestAnimationFrame(fn);
      else window.setTimeout(fn, 0);
    };
    soon(function () { boxRaf = false; placeLayers(); });
  }

  function placeGroupBox() {
    if (!cy || !layers) return;
    var box = layers.box;
    var sel = cy.$('node:selected');
    state.msel = sel.map(function (n) { return docIdOf(n.id()); });
    if (sel.length < 2) { box.classList.add('hide'); return; }
    var bb = sel.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    box.style.left = Math.round(bb.x1 - 10) + 'px';
    box.style.top = Math.round(bb.y1 - 10) + 'px';
    box.style.width = Math.round(bb.w + 20) + 'px';
    box.style.height = Math.round(bb.h + 20) + 'px';
    var edges = cy.$('edge:selected').length;
    var count = document.getElementById('gb_count');
    if (count) count.textContent = sel.length + ' nodes' + (edges ? ' · ' + edges + ' edges' : '');
    box.classList.remove('hide');
  }

  /** Leaf nodes only: a compound parent's position is derived, so a group
   *  move shifts the CHILDREN and lets cytoscape recompute the frame. */
  function leaves(col) {
    return col.union(col.descendants()).filter(function (n) { return n.isNode() && !n.isParent(); });
  }

  function shift(col, dx, dy) {
    leaves(col).positions(function (n) {
      var p = n.position();
      return { x: p.x + dx, y: p.y + dy };
    });
  }

  // ---------- persistence ----------

  /** A dragged node's new `pos`, written once per gesture. */
  function persist(ids) {
    if (!editable() || !ids.length) return;
    var wanted = {};
    for (var i = 0; i < ids.length; i++) {
      var el = cy.getElementById(ids[i]);
      if (el.empty() || !el.isNode()) continue;
      var docId = docIdOf(el.id());
      if (!nodeById(docId)) continue;                    // a step is an EDGE — it has no pos
      wanted[docId] = el.hasClass('lane') ? laneOrigin(el) : el.position();
    }
    var keys = Object.keys(wanted);
    if (!keys.length) return;
    if (keys.length === 1) {
      P2.ops.setLayoutPos(keys[0], Math.round(wanted[keys[0]].x), Math.round(wanted[keys[0]].y));
    } else {
      // One undo entry for one gesture — a group move is a single edit.
      P2.ops.apply('setLayoutPos', function (g) {
        for (var k = 0; k < keys.length; k++) {
          var n = P2.ops.findNode(g, keys[k]);
          if (n) n.pos = { x: Math.round(wanted[keys[k]].x), y: Math.round(wanted[keys[k]].y) };
        }
      });
    }
    P2.ui.render();
  }

  function queuePersist(id) {
    pendingPos = pendingPos || [];
    if (pendingPos.indexOf(id) < 0) pendingPos.push(id);
    window.setTimeout(function () {
      if (!pendingPos) return;
      var ids = pendingPos;
      pendingPos = null;
      persist(ids);
    }, 0);
  }

  // ---------- relations ----------

  /** The rule that explains a drag (`RELATION_RULES[].why`), or ''. */
  function whyFor(fromType, toType) {
    var rules = infer().RELATION_RULES || [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].from.indexOf(fromType) >= 0 && rules[i].to.indexOf(toType) >= 0) return rules[i].why;
    }
    return '';
  }

  function typeOf(el) {
    if (!el || el.empty()) return '';
    if (el.hasClass('lane') || el.hasClass('step')) return 'session';
    var n = nodeById(docIdOf(el.id()));
    return n ? n.type : '';
  }

  /** A drawn element → the session it belongs to (a step means its lane). */
  function sessionOf(el) {
    if (!el || el.empty()) return '';
    if (el.hasClass('lane')) return el.id();
    if (el.hasClass('step')) {
      var edge = edgeById(docIdOf(el.id()));
      return edge ? edge.from : '';
    }
    return '';
  }

  // ---------- drag-to-connect ----------

  /**
   * ONE code path for every connect gesture, so edgehandles, the popover and
   * the harness all take the same decisions:
   *
   *   lane|step → record      a step. The relation is `does` (infer.ts); the
   *                           popover offers `must not` for the security half.
   *   lane      → lane        re-chain: the target logs in after the source.
   *   lane      → empty       a new session, chained after the source, there.
   *   anything else           refused, with the rule's own words.
   *
   * `pos` is always a MODEL position (what cytoscape events carry).
   */
  function connectFrom(sourceId, targetId, pos) {
    if (!cy) return { ok: false, errors: ['no canvas'] };
    if (!editable()) return refuse('view mode is read-only — switch to Edit');
    var src = cy.getElementById(sourceId);
    if (src.empty()) return refuse("nothing to connect from ('" + sourceId + "')");
    var sessionId = sessionOf(src);
    var tgt = targetId ? cy.getElementById(targetId) : null;

    if (!tgt || tgt.empty()) {
      if (!sessionId) return refuse('drag from a lane to add a session after it');
      return newSessionAfter(sessionId, pos);
    }
    var fromType = typeOf(src);
    var toType = typeOf(tgt);
    var rel = infer().relationFor(fromType, toType);
    if (!rel) {
      return refuse('a ' + (fromType || 'node') + ' cannot connect to a ' + (toType || 'node') +
        ' — drag from a lane onto a record instead');
    }
    if (rel === 'login_as' && tgt.hasClass('lane')) {
      var r = P2.ops.moveSessionAfter(tgt.id(), src.id());
      if (!r.ok) return refuse(r.errors[0]);
      P2.ui.toast(whyFor(fromType, toType) || 're-chained');
      pick({ kind: 'session', id: tgt.id() });
      return { ok: true, errors: [], kind: 'login_as' };
    }
    if (rel === 'does' && sessionId) {
      var node = nodeById(docIdOf(tgt.id()));
      openDropChoice(sessionId, node ? (node.label || node.id) : '', pos, node && node.type === 'checkpoint');
      return { ok: true, errors: [], kind: 'choice' };
    }
    return refuse(whyFor(fromType, toType) ||
      ('a ' + fromType + ' → ' + toType + ' link is a ' + rel + ' — add it from the check editor'));
  }

  function refuse(msg) {
    P2.ui.toast(msg);
    return { ok: false, errors: [msg] };
  }

  function newSessionAfter(afterId, pos) {
    var after = nodeById(afterId);
    var res = P2.ops.addSession('', (after && after.system) || '', '');
    if (!res.ok) return refuse(res.errors[0]);
    var moved = P2.ops.moveSessionAfter(res.id, afterId);
    if (!moved.ok) return refuse(moved.errors[0]);
    if (pos) P2.ops.setLayoutPos(res.id, Math.round(pos.x), Math.round(pos.y - HEAD_H));
    P2.ui.select({ kind: 'session', id: res.id }, true);
    P2.ui.focusLine('input[data-f="role"]');
    return { ok: true, errors: [], kind: 'session', id: res.id };
  }

  /** The two-button choice a drop onto a record asks: does, or must not. */
  function openDropChoice(sessionId, record, pos, isCheckpoint) {
    if (!layers) return;
    lastDrop = { sessionId: sessionId, record: record };
    var p = (pos ? toRendered(pos) : null) || { x: 40, y: 40 };
    layers.pop.style.left = Math.round(p.x) + 'px';
    layers.pop.style.top = Math.round(p.y) + 'px';
    layers.pop.innerHTML = '<div class="cpop_t">' + esc(record || 'this record') + '</div>' +
      '<button data-c="does" class="primary">does</button>' +
      '<button data-c="' + (isCheckpoint ? 'assert' : 'denied') + '">' + (isCheckpoint ? 'verify' : 'must not') + '</button>';
    layers.pop.classList.remove('hide');
    var first = layers.pop.querySelector('[data-c="does"]');
    if (first) first.focus();
  }

  function closeDropChoice() {
    if (layers) layers.pop.classList.add('hide');
    lastDrop = null;
  }

  function takeDropChoice(kind) {
    if (!lastDrop) return { ok: false, errors: ['nothing to choose'] };
    var d = lastDrop;
    closeDropChoice();
    var res = P2.ops.addStep(d.sessionId, '', d.record, kind);
    if (!res.ok) return refuse(res.errors[0]);
    P2.ui.select({ kind: 'step', id: res.id }, true);
    P2.ui.focusLine('input[data-f="verb"]');
    return { ok: true, errors: [], id: res.id };
  }

  // ---------- wiring ----------

  function wire() {
    // Cytoscape calls any two taps inside its double-click window a `dbltap`,
    // wherever they land — so two quick clicks in different places would add
    // a session nobody asked for. Remember where the pair actually was.
    var tapAt = null;
    var prevTapAt = null;
    var samePlace = function () {
      if (!tapAt || !prevTapAt) return false;
      var dx = tapAt.x - prevTapAt.x;
      var dy = tapAt.y - prevTapAt.y;
      return dx * dx + dy * dy <= 400;      // within 20 rendered px
    };

    cy.on('tap', function (ev) {
      prevTapAt = tapAt;
      tapAt = ev.renderedPosition ? { x: ev.renderedPosition.x, y: ev.renderedPosition.y } : null;
      if (ev.target !== cy) return;
      closeDropChoice();
      if (state.cardOpen) { state.cardOpen = false; P2.ui.render(); }
    });

    cy.on('tap', 'node', function (ev) {
      var el = ev.target;
      closeDropChoice();
      if (cy.$('node:selected').length > 1) return;   // a group — no card
      if (el.hasClass('step')) { pick({ kind: 'step', id: docIdOf(el.id()) }); return; }
      if (el.hasClass('lane')) { pick({ kind: 'session', id: el.id() }); return; }
      // A record is shared: the card that opens is the FIRST step that lands
      // on it, which is the line carrying its checks.
      var step = firstStepOnto(docIdOf(el.id()));
      if (step) pick({ kind: 'step', id: step });
      else pick({ kind: 'graph', id: '' });
    });

    cy.on('tap', 'edge', function (ev) {
      var id = docIdOf(ev.target.id());
      var edge = edgeById(id);
      if (!edge) return;
      if (STEP_TYPES[edge.type]) pick({ kind: 'step', id: id });
      else if (edge.type === 'login_as') pick({ kind: 'session', id: edge.to });
    });

    cy.on('dbltap', function (ev) {
      if (ev.target !== cy || !editable() || !samePlace()) return;
      prevTapAt = null;
      newSession(ev.position);
    });
    cy.on('dbltap', 'node', function (ev) {
      if (!editable() || !samePlace()) return;
      prevTapAt = null;
      var id = sessionOf(ev.target);
      if (id) P2.ui.record(id);
    });

    cy.on('dragfree', 'node', function (ev) { queuePersist(ev.target.id()); });
    // pan / zoom / select move the layers NOW (a test, and a human, reads
    // the card position on the next line); drags coalesce through the rAF.
    cy.on('pan zoom', placeLayers);                       // synchronous: the card is glued
    cy.on('select unselect', refreshGroupBox);
    cy.on('drag position', 'node', refreshGroupBox);

    var ehDone = false;
    cy.on('ehcomplete', function (ev, source, target, added) {
      ehDone = true;
      if (added) added.remove();
      connectFrom(source.id(), target.id(), ev.position);
    });
    cy.on('ehstop', function (ev, source) {
      // Dropped on nothing: `ehcomplete` never fired, so this is the "new
      // session over there" gesture. A completed drag clears the flag first.
      var at = ev.position;
      window.setTimeout(function () {
        if (ehDone) { ehDone = false; return; }
        connectFrom(source.id(), null, at);
      }, 0);
    });

    // Shift-drag from a node starts the connect gesture (v4 edgehandles has
    // no hover handle of its own; draw mode would swallow every plain drag).
    cy.on('tapstart', 'node', function (ev) {
      if (!eh || !editable()) return;
      var oe = ev.originalEvent;
      if (!oe || !oe.shiftKey) return;
      eh.start(ev.target);
    });

    // hover tips — every node and edge explains itself (parity `tipFor`) —
    // and the edge LABELS, which are hidden at rest so they cannot overprint.
    cy.on('mouseover', 'node, edge', function (ev) { showTip(ev); heat(ev.target); });
    cy.on('mouseout', 'node, edge', function () { hideTip(); cool(); });
    cy.on('pan zoom drag tapstart', function () { hideTip(); cool(); });

    // The overlays sit INSIDE the cytoscape container, so their mousedown
    // would bubble to it and be treated as a canvas gesture — which re-draws
    // the button out from under the pointer and the click never completes.
    var keep = function (ev) { ev.stopPropagation(); };
    layers.overlay.addEventListener('mousedown', keep);
    layers.pop.addEventListener('mousedown', keep);

    layers.overlay.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-rec]') : null;
      if (!b) return;
      ev.stopPropagation();
      P2.ui.record(b.dataset.rec);
    });

    layers.pop.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-c]') : null;
      if (!b) return;
      ev.stopPropagation();
      takeDropChoice(b.dataset.c);
    });

    groupDrag();
    spaceSelect();

    P2.bus.on('select', function () {
      glued = asking;
      placeAnchor();
    });
    P2.bus.on('change', function (ev) {
      if (ev && REFIT_OPS[ev.op]) refitNext = true;
    });
  }

  function newSession(pos) {
    var res = P2.ops.addSession('', '', '');
    if (!res.ok) { P2.ui.toast(res.errors[0]); return null; }
    if (pos) P2.ops.setLayoutPos(res.id, Math.round(pos.x), Math.round(pos.y));
    P2.ui.select({ kind: 'session', id: res.id }, true);
    P2.ui.focusLine('input[data-f="role"]');
    return res.id;
  }

  function firstStepOnto(nodeId) {
    if (!model) return '';
    for (var i = 0; i < model.lines.sessions.length; i++) {
      var steps = model.lines.sessions[i].steps;
      for (var j = 0; j < steps.length; j++) if (steps[j].recordId === nodeId) return steps[j].edgeId;
    }
    return '';
  }

  function showTip(ev) {
    if (!layers) return;
    var id = docIdOf(ev.target.id());
    var text = (window.planner && window.planner.tipFor) ? window.planner.tipFor(id) : '';
    if (!text) return;
    layers.tip.textContent = text;
    var p = ev.renderedPosition || ev.position;
    if (!p) return;
    layers.tip.style.left = Math.round(p.x + 14) + 'px';
    layers.tip.style.top = Math.round(p.y + 14) + 'px';
    layers.tip.classList.add('on');
  }
  function hideTip() { if (layers) layers.tip.classList.remove('on'); }

  /**
   * Show the labels of the edges the pointer is over: the edge itself, or —
   * hovering a lane, a step or a record — every edge that touches it. That is
   * the parity row "edge labels with port glyph", moved from ALWAYS to ON
   * DEMAND, because a dozen `produces` captions at rest sat on top of one
   * another (owner, on the real lead_to_customer graph).
   */
  function heat(el) {
    if (!cy || !el) return;
    cool();
    var edges = el.isEdge && el.isEdge() ? el : el.connectedEdges ? el.connectedEdges() : null;
    if (edges) edges.addClass('hot');
  }
  function cool() { if (cy) cy.edges('.hot').removeClass('hot'); }

  /** The frame's grip and edges drag the whole selection (parity gb_grip). */
  function groupDrag() {
    var last = null;
    layers.box.addEventListener('mousedown', function (ev) {
      if (!editable()) return;
      var t = ev.target;
      if (!t.closest || !(t.closest('.gb_hit') || t.closest('#gb_grip'))) return;
      last = { x: ev.clientX, y: ev.clientY };
      ev.preventDefault();
      ev.stopPropagation();
    });
    document.addEventListener('mousemove', function (ev) {
      if (!last || !cy) return;
      var z = cy.zoom() || 1;
      shift(cy.$('node:selected'), (ev.clientX - last.x) / z, (ev.clientY - last.y) / z);
      last = { x: ev.clientX, y: ev.clientY };
      refreshGroupBox();
    });
    document.addEventListener('mouseup', function () {
      if (!last || !cy) return;
      last = null;
      persist(cy.$('node:selected').map(function (n) { return n.id(); }));
    });
  }

  /** SPACE held = rubber band; plain drag stays pan/zoom (owner-corrected). */
  function spaceSelect() {
    var end = function () {
      if (!spaceHeld) return;
      spaceHeld = false;
      cy.boxSelectionEnabled(false);
      cy.userPanningEnabled(true);
      var host = stage();
      if (host) host.style.cursor = '';
    };
    document.addEventListener('keydown', function (ev) {
      if (ev.code !== 'Space' || spaceHeld || !editable()) return;
      var t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      spaceHeld = true;
      cy.boxSelectionEnabled(true);
      cy.userPanningEnabled(false);
      var host = stage();
      if (host) host.style.cursor = 'crosshair';
      ev.preventDefault();
    });
    document.addEventListener('keyup', function (ev) { if (ev.code === 'Space') end(); });
    window.addEventListener('blur', end);
    cy.on('boxend', function () { window.setTimeout(refreshGroupBox, 0); });
  }

  // ---------- the contract main.js and window.planner call ----------

  function fit() {
    if (!cy) return;
    var host = stage();
    if (!host || !host.clientWidth) return;
    lastSize = { w: host.clientWidth, h: host.clientHeight };
    cy.resize();
    cy.fit(undefined, 30);
    placeLayers();
  }

  /** Auto-arrange: forget the saved positions, fall back to the lane grid,
   *  and let dagre place anything the grid has no slot for. */
  function layout() {
    if (!cy) return;
    var any = state.doc && state.doc.nodes.some(function (n) { return !!n.pos; });
    if (any) P2.ops.clearLayout();
    P2.ui.render();
    var stray = cy.nodes().filter(function (n) {
      return !n.isParent() && !n.hasClass('step') && !n.hasClass('lane') && !n.hasClass('record') && !n.hasClass('terminal');
    });
    if (stray.length && cy.layout) {
      try { stray.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 70, fit: false }).run(); }
      catch (e) { /* dagre absent — the grid row already placed them */ }
    }
    fit();
  }

  function select(sel) {
    if (!cy) return;
    cy.batch(function () {
      cy.elements(':selected').unselect();
      var el = elementFor(sel);
      if (el && !el.empty()) el.select();
    });
    placeAnchor();
  }

  function selectMany(ids) {
    state.msel = (ids || []).slice();
    if (!cy) return;
    cy.batch(function () {
      cy.elements(':selected').unselect();
      for (var i = 0; i < state.msel.length; i++) {
        var raw = state.msel[i];
        var el = cy.getElementById(raw);
        if (el.empty()) el = cy.getElementById(stepId(raw));
        if (!el.empty()) el.select();
      }
    });
    placeGroupBox();
  }

  function selection() {
    if (!cy) {
      var s = state.sel;
      return { nodes: s.kind === 'session' ? [s.id] : state.msel.slice(), edges: s.kind === 'step' ? [s.id] : [] };
    }
    var nodes = [];
    var edges = [];
    cy.$('node:selected').forEach(function (n) {
      if (n.hasClass('step')) edges.push(docIdOf(n.id()));
      else nodes.push(docIdOf(n.id()));
    });
    cy.$('edge:selected').forEach(function (e) { edges.push(docIdOf(e.id())); });
    return { nodes: nodes, edges: edges };
  }

  function anchor(sel) {
    if (!cy || !layers || !glued) return null;
    var host = stage();
    if (!host || !host.clientWidth || host.offsetParent === null) return null;   // canvas tab hidden
    var el = elementFor(sel);
    if (!el || el.empty()) return null;
    placeAnchor();
    return layers.anchor;
  }

  function groupBox() {
    var visible = !!(layers && !layers.box.classList.contains('hide'));
    var count = document.getElementById('gb_count');
    return { visible: visible, count: count ? count.textContent : String(state.msel.length) };
  }

  function nodes() { return cy ? cy.nodes().map(function (n) { return n.id(); }) : []; }
  function edges() { return cy ? cy.edges().map(function (e) { return e.id(); }) : []; }

  /** The visual half of window.planner.addNode. The model half already wrote
   *  the node (with its `pos` when the caller gave one), and the caller
   *  renders straight after — so there is nothing left for the canvas to do
   *  but agree. Kept for the contract, and so the API reads symmetrically. */
  function addNode(_partial) { /* the next render draws it */ }

  /** The visual half of window.planner.connect: a new step opens its card,
   *  exactly as a drag-to-connect does. */
  function connect(from, to, type) {
    if (!STEP_TYPES[type]) { P2.ui.render(); return; }
    var doc = state.doc;
    var found = '';
    for (var i = 0; i < doc.edges.length; i++) {
      var e = doc.edges[i];
      if (e.from === from && e.to === to && e.type === type) found = e.id;
    }
    if (found) P2.ui.select({ kind: 'step', id: found }, true);
  }

  function isMounted() { return mounted; }

  P2.canvas = {
    render: render, fit: fit, layout: layout, select: select, selectMany: selectMany,
    selection: selection, anchor: anchor, groupBox: groupBox, nodes: nodes, edges: edges,
    addNode: addNode, connect: connect, isMounted: isMounted,
    // sprint 3.2 additions the gestures and the harness share
    connectFrom: connectFrom, dropChoice: takeDropChoice, closeDropChoice: closeDropChoice,
    newSession: newSession, instance: function () { return cy; }, edgehandles: function () { return eh; },
    geometry: { LANE_W: LANE_W, LANE_GAP: LANE_GAP, ROW_H: ROW_H, HEAD_H: HEAD_H, TOP: TOP, LEFT: LEFT },
  };
})();
