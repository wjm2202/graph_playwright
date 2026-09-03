/**
 * P2/state — the ONE document store, the event bus, and the handful of pure
 * helpers every other module borrows.
 *
 * Why it exists: planner v1 kept the graph in a mutable global AND a second
 * copy inside cytoscape, reconciled by a `syncPositions()` you had to
 * remember before every export, save and undo (review §3.3). Here the
 * ProcessGraph is the only model. Views project it (view.js), ops mutate it
 * (ops.js), and everyone else re-reads it after `P2.bus.emit('change')`.
 * Nothing but ops.js writes `state.doc`.
 *
 * The bus is deliberately tiny — three functions — because the only events
 * the shell needs are "the document changed", "the selection changed" and
 * "the library changed". Sprint 3.2's canvas subscribes to the same three.
 */
(function () {
  var P2 = window.P2 = window.P2 || {};

  // ---------- helpers ----------

  /** Structural clone. The graph is plain JSON by construction (schema.ts). */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** HTML-escape — every piece of USER text goes through this before it
   *  reaches innerHTML. Labels, roles, urls and record names are user text. */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** fromAdo.ts's slug, again (the page cannot import TypeScript). */
  function slug(s) {
    return String(s === null || s === undefined ? '' : s)
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  }

  /** A lower_snake_case id not already taken. */
  function uniqueId(taken, base, fallback) {
    var root = slug(base) || fallback || 'x';
    if (!/^[a-z]/.test(root)) root = (fallback || 'n') + '_' + root;
    if (taken.indexOf(root) < 0) return root;
    var n = 2;
    while (taken.indexOf(root + '_' + n) >= 0) n++;
    return root + '_' + n;
  }

  // ---------- the store ----------

  var state = {
    /** THE MODEL: a process-graph/2 document. Never null after boot. */
    doc: null,
    /** Library ref this document came from (`project/id` or a bare id). */
    ref: '',
    /** Project the document saves into. */
    project: '',
    /** {kind:'session'|'step'|'graph'|'none', id} — the line the card follows. */
    sel: { kind: 'none', id: '' },
    /** Is the node card showing? Closes on ✕, Esc and an empty-canvas click. */
    cardOpen: false,
    /** Unsaved edits since the last save/load. */
    dirty: false,
    /** Undo stack of whole-document snapshots, oldest first (ops.js pushes). */
    undo: [],
    /** /__library (served) or window.GRAPH_LIBRARY (file://). */
    library: { version: 0, projects: [], legacy: [], suites: {} },
    /** env NAME → is it set in .env? (/__envstatus; {} over file://). */
    envStatus: null,
    /** /__capabilities, or null when this page is not served. */
    capabilities: null,
    /** 'edit' | 'view' — view hides every editing control (parity `f_mode`). */
    mode: 'edit',
    /** 'split' | 'script' | 'canvas'. */
    tab: 'split',
    /** Canvas multi-selection (3.2 owns the gestures; the id set lives here). */
    msel: [],
    /** sessionId → {id, status, tail} for in-flight `npm run record` runs. */
    recording: {},
  };

  var handlers = {};

  P2.state = state;
  P2.clone = clone;
  P2.esc = esc;
  P2.slug = slug;
  P2.uniqueId = uniqueId;

  P2.bus = {
    on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    off: function (name, fn) {
      var list = handlers[name] || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit: function (name, payload) {
      var list = (handlers[name] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload); } catch (e) { if (window.console) window.console.error(name, e); }
      }
    },
  };

  /** Served = there is a dev server behind us (tests force it with the flag). */
  P2.served = function () {
    return /^https?:$/.test(location.protocol) || !!window.PLANNER_FORCE_SERVED;
  };

  /** The transpiled shared modules, by their window names. One accessor so a
   *  missing global is one clear failure instead of ten scattered ones. */
  P2.lib = {
    schema: function () { return window.ProcessGraphSchema; },
    gaps: function () { return window.ProcessGraphGaps; },
    compose: function () { return window.ProcessGraphCompose; },
    infer: function () { return window.ProcessGraphInfer; },
    upgrade: function () { return window.ProcessGraphUpgrade; },
    script: function () { return window.ProcessGraphScript; },
  };
})();
