/**
 * P2/cards — the node card, glued beside the selected line (v1's n8n-style
 * card, kept: parity §4). Three shapes, one per selection kind:
 *
 *  session — role, persona, the LOGIN it plays as, auth, landing URL, the
 *            credential env NAMES (editable: a rename follows every role on
 *            that login), ● record and the terminal equivalent;
 *  step    — verb, record, SObject, catalog, port (+ override), who else
 *            produces/consumes this record across the project, and the check
 *            editor with LABELLED fields per kind (v1's four unlabelled
 *            placeholder inputs were the review's worst finding);
 *  graph   — id, title, tags, systems as pills plus the system form.
 *
 * Each card ends with "open on this line": the gaps that belong to exactly
 * this element, so the check strip's counts always have a place to land.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  var KINDS = ['ui.visible', 'ui.text', 'ui.toast', 'ui.url', 'api.record_exists', 'api.field_equals', 'db.query', 'log.traffic'];
  var SYSTEM_KINDS = ['salesforce', 'siebel', 'web', 'api', 'other'];
  var AUTHS = ['', 'frontdoor', 'singleaccess', 'ui'];
  var CRED_SLOTS = [
    { key: 'username', label: 'username', required: true },
    { key: 'password', label: 'password', required: true },
    { key: 'token', label: 'token', required: false },
    { key: 'totp', label: 'TOTP secret', required: false },
  ];
  /** Per kind: what `target` and `value` actually mean (labelled fields). */
  var FIELD_WORDS = {
    'ui.visible': ['role / label to find', '(not used)'],
    'ui.text': ['locator (optional)', 'text that must appear'],
    'ui.toast': ['(not used)', 'toast text'],
    'ui.url': ['(not used)', 'url fragment'],
    'api.record_exists': ['SObject', '(not used)'],
    'api.field_equals': ['SObject', 'Field=Value'],
    'db.query': ['db node id', 'query / where clause'],
    'log.traffic': ['logger node id', 'what to search for'],
  };

  function el(id) { return document.getElementById(id); }
  function isBackend(kind) { return /^(api|db|log)\./.test(String(kind || '')); }
  /** The infra TYPE a check kind interrogates, or '' for a UI/api oracle. */
  function infraKindFor(kind) {
    if (kind === 'db.query') return 'db';
    if (kind === 'log.traffic') return 'logger';
    return '';
  }
  function nodesOfType(type) {
    return (state.doc.nodes || []).filter(function (n) { return n.type === type; });
  }

  /**
   * The `lastResult` dot (parity §4 `xf_list` … `lastResult`): green when the
   * last run proved this check, red when it did not, nothing before a run.
   * The title is the runner's own message, so a red dot always says why.
   */
  function resultDot(x) {
    var r = x && x.lastResult;
    if (!r) return '';
    var cls = r.status === 'pass' ? 'ok' : 'bad';
    var when = r.at ? ' · ' + r.at : '';
    var msg = (r.status === 'pass' ? 'passed' : 'FAILED') + when + (r.message ? ' — ' + r.message : '');
    return '<span class="rdot ' + cls + '" title="' + esc(msg) + '"></span>';
  }

  /**
   * The image a run left on this node, plus the manual attach (nf_snapshot).
   *
   * Since sprint 4.2 a run's `snapshot.ref` is a PATH inside the graph's
   * evidence folder, not a base64 blob: served, it loads over /__evidence;
   * over file:// there is nothing to load, so the card shows the ref itself
   * and says where the image is. A `data:` ref (an old graph, or the manual
   * attach below — a hand-picked reference, not run evidence) still renders
   * as it always did.
   */
  function snapshotBlock(node) {
    if (!node) return '';
    var snap = node.snapshot || null;
    var when = snap && snap.status === 'captured'
      ? 'from the last run' + (snap.capturedAt ? ' · ' + snap.capturedAt : '')
      : 'attached by hand';
    var src = snap && snap.ref ? P2.net.evidenceUrl(snap.ref) : '';
    var shot;
    if (src) {
      shot = '<img class="shot" src="' + esc(src) + '" alt="run evidence for ' + esc(node.label || node.id) + '">' +
        '<div class="hint">' + esc(when) + '</div>';
    } else if (snap && snap.ref) {
      shot = '<div class="hint reffile">' + esc(snap.ref) + '</div>' +
        '<div class="hint">' + esc(when) + ' — open the planner with <code>npm run planner</code> to see it</div>';
    } else {
      shot = '<div class="hint">no image yet — a run attaches one, or attach it yourself</div>';
    }
    return '<h3>snapshot</h3><div class="snap" data-snapnode="' + esc(node.id) + '">' + shot +
      '<div class="snaprow"><input type="file" accept="image/*" data-snap="file" title="attach an image from disk">' +
      (snap && snap.ref ? '<button class="small ghost" data-snap="clear" title="remove the attached image">✕ clear</button>' : '') +
      '</div></div>';
  }

  function bindSnapshot(host) {
    var box = host.querySelector('[data-snapnode]');
    if (!box) return;
    var nodeId = box.dataset.snapnode;
    var file = box.querySelector('[data-snap="file"]');
    if (file) {
      file.addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () { P2.ui.run(P2.ops.setSnapshot(nodeId, String(reader.result))); };
        reader.onerror = function () { P2.ui.toast('could not read that image'); };
        reader.readAsDataURL(f);
      });
    }
    var clear = box.querySelector('[data-snap="clear"]');
    if (clear) clear.addEventListener('click', function () { P2.ui.run(P2.ops.setSnapshot(nodeId, '')); });
  }

  function gapList(rows) {
    if (!rows.length) return '<div class="hint">nothing open here</div>';
    return '<ul class="gaplist">' + rows.map(function (r) {
      var sev = r.severity === 'bad' ? 'bad' : 'warn';
      return '<li class="' + sev + '"><span>' + esc(r.text) + '</span></li>';
    }).join('') + '</ul>';
  }

  /** Everything the strip counts that belongs to THIS selection. */
  function openHere(model, kind, id) {
    var rows = [];
    model.checks.mustFix.forEach(function (r) { if (r.at.kind === kind && (kind === 'graph' || r.at.id === id)) rows.push({ text: r.text, severity: 'bad' }); });
    model.checks.toFinish.forEach(function (r) { if (r.at.kind === kind && (kind === 'graph' || r.at.id === id)) rows.push({ text: r.text, severity: 'warn' }); });
    model.checks.hints.forEach(function (r) { if (r.at.kind === kind && (kind === 'graph' || r.at.id === id)) rows.push({ text: r.text, severity: 'warn' }); });
    return rows;
  }

  // ---------- session ----------

  function credRows(personaId) {
    var wiring = (window.PERSONA_ENV || {})[personaId] || {};
    var status = state.envStatus;
    return CRED_SLOTS.map(function (slot) {
      var name = wiring[slot.key] || '';
      var set = !!(status && name && status[name]);
      var cls = set ? '' : (name ? (slot.required ? 'bad' : 'muted') : 'muted');
      var title = !status ? 'set/unset is shown when using npm run planner'
        : set ? 'set in .env' : name ? (slot.required ? 'MISSING from .env' : 'optional, not set') : 'not wired';
      return '<div class="credrow"><span class="dot ' + cls + '" title="' + esc(title) + '"></span>' +
        '<input class="mono" data-env="' + slot.key + '" value="' + esc(name) + '" spellcheck="false" placeholder="ENV_NAME" ' +
        'title="the .env variable NAME this login reads — renaming it rewrites personas.json for every role on this login">' +
        '<span class="hint">' + (slot.required ? '' : 'optional') + '</span></div>';
    }).join('');
  }

  /**
   * `nf_steps_status` · `nf_journey` · `nf_planned`, READ-ONLY (parity §4):
   * the pipeline and the merge-back write these, and editing them by hand
   * made the graph lie about a capture — so they are chips, not fields.
   */
  function statusChips(node) {
    var steps = node.steps || null;
    var timing = node.timing || {};
    var chips = [];
    chips.push('<span class="chip ' + (steps && steps.status === 'captured' ? 'ok' : 'muted') + '" title="written by npm run record / the pipeline — never by hand">' +
      (steps ? esc(steps.status) : 'not recorded') + '</span>');
    if (steps && steps.journeyId) {
      chips.push('<span class="chip muted" title="the recording this lane was captured from">journey <b class="mono">' + esc(steps.journeyId) + '</b></span>');
    }
    if (steps && steps.stepIndexes && steps.stepIndexes.length) {
      chips.push('<span class="chip muted" title="which recorded steps this lane owns">steps ' + esc(steps.stepIndexes.join(',')) + '</span>');
    }
    if (timing.plannedMs) chips.push('<span class="chip muted" title="the budget this lane was planned with">planned ' + esc(timing.plannedMs) + 'ms</span>');
    if (timing.capturedMeanMs) chips.push('<span class="chip ok" title="mean of the captured runs">mean ' + esc(Math.round(timing.capturedMeanMs)) + 'ms</span>');
    return '<div class="chiprow">' + chips.join('') + '</div>';
  }

  function sessionCard(model, session) {
    var wiring = (window.PERSONA_ENV || {})[session.persona] || {};
    var account = wiring.account || session.persona || '';
    var others = [];
    var env = window.PERSONA_ENV || {};
    for (var pid in env) {
      if (!Object.prototype.hasOwnProperty.call(env, pid)) continue;
      if (pid !== session.persona && env[pid] && env[pid].account && env[pid].account === account) others.push(pid);
    }
    var known = (window.PERSONA_IDS || []).indexOf(session.persona) >= 0;
    var live = state.recording[session.id];
    return '<div class="kv">' +
      '<label>role</label><input value="' + esc(session.role) + '" data-f="role" placeholder="Client Associate">' +
      '<label>persona</label><span class="mono">' + esc(session.persona || '—') + (known ? '' : ' <span class="pill gap">new</span>') + '</span>' +
      '<label>logs in as</label><span class="mono">' + esc(account || '—') + (others.length ? ' <span class="hint">shared with ' + esc(others.join(', ')) + '</span>' : '') + '</span>' +
      '<label>auth</label><select data-f="auth">' + AUTHS.map(function (a) {
        return '<option value="' + a + '"' + (session.auth === a ? ' selected' : '') + '>' + (a || 'from the persona') + '</option>';
      }).join('') + '</select>' +
      '<label>system</label><select data-f="system">' + Object.keys(state.doc.systems).map(function (k) {
        return '<option value="' + esc(k) + '"' + (session.system === k ? ' selected' : '') + '>' + esc(state.doc.systems[k].label || k) + '</option>';
      }).join('') + '</select>' +
      '<label>landing URL</label><input class="mono" value="' + esc(session.url) + '" data-f="url" placeholder="/lightning/o/Account/list">' +
      '<label>notes</label><input value="' + esc(session.node.notes || '') + '" data-n="notes" placeholder="why this lane exists">' +
      '</div>' +
      statusChips(session.node) +
      '<h3>credentials — login <span class="mono">' + esc(account || '?') + '</span></h3>' +
      '<div class="creds">' + credRows(session.persona) + '</div>' +
      '<div class="hint" style="margin-top:4px">variable <b>names</b> only — values live in <span class="mono">.env</span> and never leave your machine.' +
      ' <button class="small" id="b_envlines" style="margin-top:4px">Copy missing lines</button></div>' +
      '<h3>capture</h3><div style="display:flex;gap:6px;align-items:center">' +
      '<button class="small editonly ' + (session.captured ? '' : 'primary') + '" id="b_rec">' +
      (live ? '● recording…' : session.captured ? '● record again' : '● record now') + '</button>' +
      '<span class="hint">' + (session.captured ? 'recorded' : 'opens a headed browser as this persona') + '</span></div>' +
      (live && live.tail && live.tail.length ? '<div class="env mono" style="margin-top:6px">' + esc(live.tail.slice(-6).join('\n')) + '</div>' : '') +
      '<details style="margin-top:6px"><summary class="hint" style="cursor:pointer">terminal equivalent</summary>' +
      '<div class="env mono" style="margin-top:4px">npx sfpw record ' + esc(session.persona || '?') + ' ' + esc(state.doc.id) + '</div></details>' +
      snapshotBlock(session.node) +
      '<h3>open on this line</h3>' + gapList(openHere(model, 'session', session.id));
  }

  function bindSession(host, session) {
    host.querySelectorAll('[data-f]').forEach(function (input) {
      input.addEventListener('change', function (ev) {
        P2.ui.run(P2.ops.setSessionField(session.id, ev.target.dataset.f, ev.target.value));
      });
    });
    host.querySelectorAll('[data-n="notes"]').forEach(function (input) {
      input.addEventListener('change', function (ev) { P2.ui.run(P2.ops.setNotes(session.id, ev.target.value)); });
    });
    bindSnapshot(host);
    var rec = el('b_rec');
    if (rec) rec.addEventListener('click', function () { P2.ui.record(session.id); });
    var lines = el('b_envlines');
    if (lines) {
      lines.addEventListener('click', function () {
        var creds = P2.net.credentialsFor(session.id);
        var missing = creds.missing.length ? creds.missing : creds.names;
        P2.ui.copy(missing.map(function (n) { return n + '='; }).join('\n'), 'copied ' + missing.length + ' .env line(s)');
      });
    }
    host.querySelectorAll('[data-env]').forEach(function (input) {
      input.addEventListener('change', function (ev) {
        var v = String(ev.target.value).trim();
        if (v && !/^[A-Z][A-Z0-9_]*$/.test(v)) { P2.ui.toast('an env NAME: A-Z, digits, _ — never a value'); P2.ui.render(); return; }
        P2.net.renamePersonaEnv(session.persona, ev.target.dataset.env, v).then(function (res) {
          P2.ui.toast(res.ok ? 'personas.json updated — every role on this login follows' : 'NOT saved — ' + res.error);
          P2.ui.render();
        });
      });
    });
  }

  // ---------- step ----------

  /** The target field: a free input, or — for db.query / log.traffic — a
   *  picker over the evidence sources this graph declares. */
  function targetField(x, words) {
    var kind = infraKindFor(x.kind);
    if (!kind) {
      return '<input data-c="target" value="' + esc(x.target || '') + '" placeholder="' + esc(words[0]) + '" title="' + esc(words[0]) + '">';
    }
    var list = nodesOfType(kind);
    var opts = '<option value="">' + (kind === 'db' ? 'pick a database…' : 'pick a log system…') + '</option>' +
      list.map(function (n) {
        return '<option value="' + esc(n.id) + '"' + (x.target === n.id ? ' selected' : '') + '>' + esc(n.label || n.id) + '</option>';
      }).join('');
    return '<select data-c="target" title="the ' + (kind === 'db' ? 'database' : 'log system') + ' this check interrogates">' + opts + '</select>';
  }

  function checkEditor(step) {
    if (step.kind === 'denied') return '';
    var rows = step.checks.map(function (c) {
      var x = c.expect;
      var words = FIELD_WORDS[x.kind] || ['target', 'value'];
      return '<div class="checkrow" data-node="' + esc(c.nodeId) + '" data-check="' + esc(x.id) + '">' +
        '<div class="fields">' +
        '<select data-c="kind">' + KINDS.map(function (k) { return '<option' + (x.kind === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>' +
        targetField(x, words) +
        '<input data-c="value" value="' + esc(x.value || '') + '" placeholder="' + esc(words[1]) + '" title="' + esc(words[1]) + '">' +
        '<label>' + resultDot(x) + esc(words[0]) + ' · ' + esc(words[1]) + (x.draft ? ' · guessed' : '') + '</label>' +
        (isBackend(x.kind)
          ? '<div class="budget"><input data-c="timeoutMs" value="' + esc(x.timeoutMs === undefined ? '' : x.timeoutMs) + '" placeholder="timeout ms (default 10000)" title="how long the oracle polls — async integrations outlive the default">' +
            '<input data-c="pollMs" value="' + esc(x.pollMs === undefined ? '' : x.pollMs) + '" placeholder="poll ms (default 1000)" title="how often it re-checks while waiting"></div>'
          : '') +
        '</div>' +
        '<button class="small ghost" data-c="remove" title="remove this check">✕</button>' +
        '</div>';
    }).join('');
    return '<h3>what proves it worked</h3>' + (rows || '<div class="hint">no checks yet — a step with no oracle proves nothing</div>') +
      '<div class="addcheck">' +
      '<button class="small" id="b_addcheck">+ check</button>' +
      '<select id="f_checkkind" title="the oracle kind to add — db.query and log.traffic ask which system first">' +
      '<option value="">a sensible default</option>' +
      KINDS.map(function (k) { return '<option value="' + k + '">' + k + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="hint" style="margin-top:4px">backend checks (api / db / log) poll; set a budget only for async integrations.</div>';
  }

  /**
   * The evidence sources this graph declares — the db / logger / api nodes v1
   * offered on `add ▾` and left you to wire (parity §2, §4 `nf_queryable` /
   * `nf_searchable` / `nf_method` / `nf_path`). They are created HERE, from
   * the step that needs one, and `addInfraNode` writes the `touches` edge in
   * the same transaction.
   */
  function infraBlock(step) {
    var rows = ['db', 'logger', 'api'].map(function (kind) {
      return nodesOfType(kind).map(function (n) { return infraRow(n); }).join('');
    }).join('');
    return '<h3>evidence sources</h3>' + (rows || '<div class="hint">none yet — a db.query check needs a database, a log.traffic check needs a log system</div>') +
      '<div class="addcheck">' +
      '<input id="f_infralabel" placeholder="name it (Siebel DB, API gateway logs…)" style="flex:1">' +
      '</div><div class="addcheck">' +
      '<button class="small" data-infra="db" title="a database a db.query check can interrogate">+ database</button>' +
      '<button class="small" data-infra="logger" title="a log system a log.traffic check can search">+ log system</button>' +
      '<button class="small" data-infra="api" title="an integration hop a record can be replicated to">+ api hop</button>' +
      '</div>' +
      '<div class="hint" style="margin-top:4px">created against <span class="mono">' + esc(step.sessionId) + '</span> as a <span class="mono">touches</span> edge — part of the flow, not a floating picture.</div>';
  }

  function infraRow(n) {
    var ep = n.endpoint || {};
    return '<div class="infrarow" data-infra-node="' + esc(n.id) + '">' +
      '<div class="fields">' +
      '<span class="pill" title="' + esc(n.type) + ' node ' + esc(n.id) + '">' + esc(n.type) + '</span>' +
      '<input data-i="label" value="' + esc(n.label || '') + '" placeholder="name">' +
      (n.type === 'db'
        ? '<label class="flag"><input type="checkbox" data-i="queryable"' + (n.queryable ? ' checked' : '') + '> queryable</label>' : '') +
      (n.type === 'logger'
        ? '<label class="flag"><input type="checkbox" data-i="searchable"' + (n.searchable === false ? '' : ' checked') + '> searchable</label>' : '') +
      (n.type === 'api'
        ? '<input data-i="method" value="' + esc(ep.method || '') + '" placeholder="POST" style="width:70px">' +
          '<input data-i="path" value="' + esc(ep.path || '') + '" placeholder="/v2/customers">' : '') +
      '</div></div>';
  }

  /** "replicated to →": the record's handoff edges, and the form that adds one. */
  function handoffBlock(step) {
    if (!step.isData || !step.recordId) return '';
    var doc = state.doc;
    var rows = doc.edges.filter(function (e) { return e.type === 'handoff' && e.from === step.recordId; }).map(function (e) {
      var api = P2.ops.findNode(doc, e.to);
      var ep = (api && api.endpoint) || {};
      return '<div class="infrarow" data-handoff="' + esc(e.id) + '">' +
        '<div class="fields"><span class="pill">→ ' + esc((api && (api.label || api.id)) || e.to) + '</span>' +
        '<span class="hint mono">' + esc(((ep.method || '') + ' ' + (ep.path || '')).trim() || 'no endpoint named') + '</span></div>' +
        '<button class="small ghost" data-handoff-remove="' + esc(e.id) + '" title="this record does not cross here">✕</button>' +
        '</div>';
    }).join('');
    return '<h3>replicated to</h3>' + (rows || '<div class="hint">nowhere — this record stays in one system</div>') +
      '<div class="addcheck">' +
      '<input id="f_hop" placeholder="api hop (create_customer_v2)" style="flex:1">' +
      '</div><div class="addcheck">' +
      '<input id="f_hopmethod" placeholder="POST" style="width:70px">' +
      '<input id="f_hoppath" placeholder="/v2/customers" style="flex:1">' +
      '<button class="small" id="b_addhop" title="the record crosses an integration boundary here">+ hop</button>' +
      '</div>';
  }

  function stepCard(model, step) {
    var led = P2.view.ledger(P2.library.docs()).filter(function (r) { return r.name === step.record; })[0];
    return '<div class="kv">' +
      '<label>verb</label><input value="' + esc(step.verb) + '" data-f="verb">' +
      '<label>record</label><input value="' + esc(step.record) + '" data-f="record" list="records">' +
      (step.isData ? '<label>SObject</label><input class="mono" value="' + esc(step.sobject) + '" data-f="sobject" placeholder="Account">' : '') +
      '<label>catalog</label><input class="mono" value="' + esc(step.catalog) + '" data-f="' + (step.kind === 'denied' ? 'capability' : 'catalog') + '" title="derived from &lt;record&gt;.&lt;verb&gt; — override only if the vocabulary differs">' +
      (step.port
        ? '<label>port</label><span><span class="pill ' + step.port.io + (step.port.draft ? ' draft' : '') + '">' + step.port.io + (step.port.draft ? ' ?' : '') + '</span>' +
          ' <select data-f="io" class="small" style="margin-left:6px">' +
          ['', 'produces', 'consumes', 'updates'].map(function (io) {
            var chosen = step.edge.data && step.edge.data.io === io;
            return '<option value="' + io + '"' + (chosen ? ' selected' : '') + '>' + (io || 'inferred') + '</option>';
          }).join('') + '</select></span>'
        : '') +
      (step.isData
        ? '<label>exists already</label><span><label class="flag"><input type="checkbox" data-f="external"' +
          ((step.recordNode && step.recordNode.external) ? ' checked' : '') +
          '> the run finds this record rather than creating it</label></span>'
        : '') +
      '<label>notes</label><input value="' + esc((step.recordNode && step.recordNode.notes) || '') + '" data-n="notes" placeholder="what this step is really for">' +
      '</div>' +
      (step.record
        ? '<h3>' + esc(step.record) + ' across the project</h3><div class="hint">produced by ' +
          esc((led && led.produced.join(', ')) || 'nobody yet') + ' · consumed by ' + esc((led && led.consumed.join(', ')) || 'nobody yet') + '</div>'
        : '') +
      checkEditor(step) +
      infraBlock(step) +
      handoffBlock(step) +
      snapshotBlock(step.recordNode) +
      '<h3>open on this line</h3>' + gapList(openHere(model, 'step', step.edgeId));
  }

  function bindStep(host, step) {
    host.querySelectorAll('.kv [data-f]').forEach(function (input) {
      input.addEventListener('change', function (ev) {
        var v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
        P2.ui.run(P2.ops.setStepField(step.edgeId, ev.target.dataset.f, v));
      });
    });
    host.querySelectorAll('.checkrow').forEach(function (row) {
      var nodeId = row.dataset.node;
      var id = row.dataset.check;
      row.querySelectorAll('[data-c]').forEach(function (field) {
        if (field.dataset.c === 'remove') {
          field.addEventListener('click', function () { P2.ui.run(P2.ops.removeCheck(nodeId, id)); });
          return;
        }
        field.addEventListener('change', function (ev) {
          P2.ui.run(P2.ops.setCheck(nodeId, id, ev.target.dataset.c, ev.target.value));
        });
      });
    });
    // notes live on the RECORD the step lands on — one writer for every card
    host.querySelectorAll('.kv [data-n="notes"]').forEach(function (input) {
      input.addEventListener('change', function (ev) {
        if (!step.recordId) { P2.ui.toast('name a record first — notes hang off it'); return; }
        P2.ui.run(P2.ops.setNotes(step.recordId, ev.target.value));
      });
    });

    var add = el('b_addcheck');
    if (add) {
      add.addEventListener('click', function () {
        var picker = el('f_checkkind');
        var kind = picker ? picker.value : '';
        var infra = infraKindFor(kind);
        // A backend check names the system it interrogates: offer the first
        // one of the right type rather than refusing with a puzzle.
        var target = infra ? (nodesOfType(infra)[0] || {}).id : undefined;
        if (infra && !target) {
          P2.ui.toast('add a ' + (infra === 'db' ? 'database' : 'log system') + ' below first — ' + kind + ' has to name one');
          return;
        }
        P2.ui.run(P2.ops.addCheck(step.edgeId, kind || undefined, target));
      });
    }

    host.querySelectorAll('[data-infra]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var label = el('f_infralabel');
        P2.ui.run(P2.ops.addInfraNode(btn.dataset.infra, label ? label.value : '', { sessionId: step.sessionId }));
      });
    });
    host.querySelectorAll('[data-infra-node]').forEach(function (row) {
      var id = row.dataset.infraNode;
      row.querySelectorAll('[data-i]').forEach(function (field) {
        field.addEventListener('change', function (ev) {
          var v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
          P2.ui.run(P2.ops.setInfraField(id, ev.target.dataset.i, v));
        });
      });
    });

    var hop = el('b_addhop');
    if (hop) {
      hop.addEventListener('click', function () {
        var name = el('f_hop');
        P2.ui.run(P2.ops.addHandoff(step.recordId, name ? name.value : '', {
          method: (el('f_hopmethod') || {}).value,
          path: (el('f_hoppath') || {}).value,
        }));
      });
    }
    host.querySelectorAll('[data-handoff-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { P2.ui.run(P2.ops.removeHandoff(btn.dataset.handoffRemove)); });
    });

    bindSnapshot(host);
  }

  // ---------- graph ----------

  function graphCard(model) {
    var doc = state.doc;
    var pills = Object.keys(doc.systems).map(function (k) {
      var s = doc.systems[k];
      return '<span class="pill" data-system="' + esc(k) + '" title="click to edit this system">' + esc(s.label || k) + ' <span class="hint mono">' + esc(k) + '</span></span>';
    }).join(' ');
    return '<div class="kv">' +
      '<label>id</label><input class="mono" value="' + esc(doc.id) + '" data-f="id">' +
      '<label>title</label><input value="' + esc(doc.title || '') + '" data-f="title">' +
      '<label>tags</label><input value="' + esc((doc.tags || []).join(', ')) + '" data-f="tags" placeholder="smoke, sod">' +
      '<label>systems</label><span>' + pills + ' <button class="small ghost" id="b_addsystem">+ system</button></span>' +
      '</div>' +
      '<div id="sysform"></div>' +
      '<div class="hint" style="margin-top:8px">systems carry their session policy once per project (Siebel: one session at a time) — the graph never repeats it.</div>' +
      '<h3>everything open</h3>' + gapList(
        model.checks.mustFix.map(function (r) { return { text: r.text, severity: 'bad' }; })
          .concat(model.checks.toFinish.map(function (r) { return { text: r.text, severity: 'warn' }; })),
      );
  }

  function systemForm(key) {
    var host = el('sysform');
    if (!host) return;
    var sys = key ? state.doc.systems[key] : { label: '', kind: 'other' };
    host.innerHTML = '<h3>' + (key ? 'system ' + esc(key) : 'new system') + '</h3><div class="kv">' +
      (key ? '' : '<label>key</label><input class="mono" data-s="key" placeholder="siebel">') +
      '<label>label</label><input data-s="label" value="' + esc(sys.label || '') + '" placeholder="Siebel UAT">' +
      '<label>kind</label><select data-s="kind">' + SYSTEM_KINDS.map(function (k) {
        return '<option' + ((sys.kind || 'other') === k ? ' selected' : '') + '>' + k + '</option>';
      }).join('') + '</select>' +
      '<label>url env</label><input class="mono" data-s="urlEnv" value="' + esc(sys.urlEnv || '') + '" placeholder="SIEBEL_URL">' +
      '<label>max sessions</label><input data-s="maxConcurrent" value="' + esc(sys.sessionPolicy ? sys.sessionPolicy.maxConcurrent : '') + '" placeholder="1 = logout-to-comply">' +
      '</div><div style="margin-top:6px"><button class="small primary" id="b_sysapply">' + (key ? 'Apply' : 'Add system') + '</button></div>';
    el('b_sysapply').addEventListener('click', function () {
      var patch = {};
      host.querySelectorAll('[data-s]').forEach(function (f) { patch[f.dataset.s] = f.value; });
      P2.ui.run(key ? P2.ops.setSystem(key, patch) : P2.ops.addSystem(patch.key, patch));
    });
  }

  function bindGraph(host, model) {
    host.querySelectorAll('.kv [data-f]').forEach(function (input) {
      input.addEventListener('change', function (ev) {
        var f = ev.target.dataset.f;
        if (f === 'id') P2.ui.run(P2.ops.setMeta(ev.target.value, null, null));
        else if (f === 'title') P2.ui.run(P2.ops.setMeta(null, ev.target.value, null));
        else P2.ui.run(P2.ops.setMeta(null, null, ev.target.value));
      });
    });
    host.querySelectorAll('[data-system]').forEach(function (pill) {
      pill.addEventListener('click', function () { systemForm(pill.dataset.system); });
    });
    var add = el('b_addsystem');
    if (add) add.addEventListener('click', function () { systemForm(''); });
  }

  // ---------- placement ----------

  /** The element the card hangs off — the selected line, or the canvas node
   *  when 3.2 reports one (P2.canvas.anchor). */
  function anchorEl() {
    var fromCanvas = P2.canvas && P2.canvas.anchor ? P2.canvas.anchor(state.sel) : null;
    if (fromCanvas) return fromCanvas;
    if (state.sel.kind === 'session') return document.querySelector('.line.session.sel');
    if (state.sel.kind === 'step') return document.querySelector('.line.step.sel');
    return document.querySelector('.script .head') || document.querySelector('.tabs');
  }

  function place() {
    var card = el('ncard');
    if (!card) return;
    if (!state.cardOpen || state.sel.kind === 'none') { card.classList.add('hide'); return; }
    card.classList.remove('hide');
    var a = anchorEl();
    var r = a ? a.getBoundingClientRect() : { left: window.innerWidth / 2, right: window.innerWidth / 2, top: 120, bottom: 160 };
    var w = 320;
    var gap = 12;
    var h = Math.min(card.offsetHeight || 400, window.innerHeight * 0.78);
    var x = r.right + gap;
    if (x + w > window.innerWidth - 8) x = r.left - w - gap;
    if (x < 8) x = Math.max(8, window.innerWidth - w - 8);
    var y = r.top;
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  function render(model) {
    var host = el('insp');
    var title = el('ncard_title');
    if (!host) return;
    if (!state.cardOpen || state.sel.kind === 'none') { place(); return; }

    if (state.sel.kind === 'session') {
      var session = model.lines.sessions.filter(function (s) { return s.id === state.sel.id; })[0];
      if (!session) { state.sel = { kind: 'graph', id: '' }; return render(model); }
      title.textContent = 'session';
      host.innerHTML = sessionCard(model, session);
      bindSession(host, session);
    } else if (state.sel.kind === 'step') {
      var step = null;
      model.lines.sessions.forEach(function (s) {
        s.steps.forEach(function (t) { if (t.edgeId === state.sel.id) step = t; });
      });
      if (!step) { state.sel = { kind: 'graph', id: '' }; return render(model); }
      title.textContent = step.kind === 'denied' ? 'must not' : step.kind === 'asserts' ? 'checkpoint' : 'step';
      host.innerHTML = stepCard(model, step);
      bindStep(host, step);
    } else {
      title.textContent = 'graph';
      host.innerHTML = graphCard(model);
      bindGraph(host, model);
    }
    place();
  }

  P2.cards = { render: render, place: place, openHere: openHere };
})();
