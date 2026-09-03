/**
 * P2/script — the script editor: the graph as a numbered outline.
 *
 * One session line per lane (`as <role> on <system> at <url>`), one step line
 * per does/denied/asserts edge under it, checks as pills under the step. The
 * line order IS the login chain and the declaration order, so ↑ ↓ on a line
 * is a graph rewrite, not a display preference — which is why every control
 * here calls an op rather than touching the document.
 *
 * Inputs commit on `change` (blur / Enter), never on keystroke: a re-render
 * per character was one of v1's costs (review §3.3) and it stole focus.
 */
(function () {
  var P2 = window.P2;
  var state = P2.state;
  var esc = P2.esc;

  var PORT_GLYPH = { produces: '⇒', consumes: '⇐', updates: '⇄' };

  function sel(kind, id) { return state.sel.kind === kind && state.sel.id === id; }

  function personaPill(session) {
    if (!session.role) return '';
    var known = (window.PERSONA_IDS || []).indexOf(session.persona) >= 0;
    var wiring = (window.PERSONA_ENV || {})[session.persona] || {};
    var account = wiring.account || session.persona;
    return '<span class="pill ' + (known ? 'persona' : 'gap') + '" data-act="persona" title="' +
      esc(known ? 'persona ' + session.persona + ' → login ' + account : 'not in personas.json yet — created on save as a new login') + '">' +
      (known ? '👤 ' + esc(account) : 'new login: ' + esc(session.persona)) + '</span>';
  }

  function recordPill(session) {
    var live = state.recording[session.id];
    var cls = live ? 'rec live recording' : session.captured ? 'ok' : 'rec';
    var text = live ? '● recording…' : session.captured ? '✓ recorded' : '● record';
    var title = live ? 'recording — close the browser to finish'
      : session.captured ? 'recorded — click to record again'
        : 'record this role now (opens a headed browser as this persona)';
    return '<span class="pill ' + cls + ' editonly" data-act="record" title="' + esc(title) + '">' + text + '</span>';
  }

  function systemOptions(doc, current) {
    var out = '';
    for (var key in doc.systems) {
      if (!Object.prototype.hasOwnProperty.call(doc.systems, key)) continue;
      out += '<option value="' + esc(key) + '"' + (current === key ? ' selected' : '') + '>' + esc(doc.systems[key].label || key) + '</option>';
    }
    return out + '<option value=""' + (current ? '' : ' selected') + '>—</option>';
  }

  function sessionLine(doc, session, index, total) {
    var line = document.createElement('div');
    line.className = 'line session' + (sel('session', session.id) ? ' sel' : '') + (session.stranded ? ' stranded' : '');
    line.dataset.session = session.id;
    line.innerHTML = '<div class="num">' + (index + 1) + '</div><div class="body">' +
      '<div class="who"><span class="as" title="' + (session.stranded ? 'not on the login chain — the walker never reaches this session' : 'the login chain runs top to bottom') + '">as</span>' +
      '<input class="inline" data-f="role" value="' + esc(session.role) + '" placeholder="role, as the test case names it" style="width:180px;font-weight:500">' +
      '<span class="hint">on</span>' +
      '<select data-f="system" class="small">' + systemOptions(doc, session.system) + '</select>' +
      '<span class="hint">at</span>' +
      '<input class="inline mono" data-f="url" value="' + esc(session.url) + '" placeholder="/lightning/o/…/list" style="width:150px;font-size:12px">' +
      personaPill(session) + recordPill(session) +
      (session.stranded ? '<span class="pill bad" title="wire it into the chain with ↑ ↓, or delete it">stranded</span>' : '') +
      '</div>' +
      '<div class="tools editonly">' +
      '<button class="small" data-act="addstep">+ step</button>' +
      '<button class="small" data-act="adddeny">+ must not</button>' +
      '<button class="small" data-act="join">insert graph after…</button>' +
      '<button class="small ghost" data-act="up"' + (index === 0 ? ' disabled' : '') + ' title="earlier in the login chain">↑</button>' +
      '<button class="small ghost" data-act="down"' + (index === total - 1 ? ' disabled' : '') + ' title="later in the login chain">↓</button>' +
      '<button class="small ghost" data-act="del">delete</button>' +
      '</div></div>';
    return line;
  }

  /**
   * The `lastResult` dot (parity §4): after a run, every check pill carries a
   * green or red dot whose title is the runner's own message — so a failing
   * oracle is visible on the LINE, not only inside the card.
   */
  function resultDot(x) {
    var r = x.lastResult;
    if (!r) return '';
    var msg = (r.status === 'pass' ? 'passed' : 'FAILED') + (r.at ? ' · ' + r.at : '') + (r.message ? ' — ' + r.message : '');
    return '<span class="rdot ' + (r.status === 'pass' ? 'ok' : 'bad') + '" title="' + esc(msg) + '"></span>';
  }

  function checkPill(step, check) {
    var x = check.expect;
    var text = (x.draft ? '?' : '✓') + ' ' + x.kind + ' ' + (x.value || x.target || '');
    var res = x.lastResult ? ' ' + x.lastResult.status : '';
    return '<span class="pill check' + (x.draft ? ' draft' : '') + res + '" data-check="' + esc(x.id) + '" data-checknode="' + esc(check.nodeId) + '" title="' +
      esc(x.draft ? 'guessed — click to keep it' : 'click to edit it on the card') + '">' + resultDot(x) + esc(text) + '</span>';
  }

  function stepLine(step, num, index, total) {
    var line = document.createElement('div');
    line.className = 'line step ' + step.kind + (sel('step', step.edgeId) ? ' sel' : '');
    line.dataset.step = step.edgeId;
    var port = step.port
      ? '<span class="pill ' + step.port.io + (step.port.draft ? ' draft' : '') + '" data-act="confirmio" title="' +
        esc(step.port.reason + (step.port.draft ? ' — click to confirm' : ' (confirmed)')) + '">' +
        PORT_GLYPH[step.port.io] + ' ' + step.port.io + (step.port.draft ? ' ?' : '') + '</span>'
      : '';
    var checks = step.kind === 'denied' ? '' :
      '<div class="checks">' + step.checks.map(function (c) { return checkPill(step, c); }).join('') +
      '<span class="pill editonly" data-act="addcheck" title="what proves this step worked?">+ check</span></div>';
    line.innerHTML = '<div class="num">' + num + '</div><div class="body">' +
      '<div class="what">' +
      (step.kind === 'denied' ? '<span class="verb" style="color:var(--bad);font-weight:600">must not</span>' : '') +
      '<input class="inline verb" data-f="verb" value="' + esc(step.verb) + '" placeholder="verb">' +
      '<input class="inline rec" data-f="record" value="' + esc(step.record) + '" placeholder="record" list="records">' +
      port +
      '<span class="hint mono" title="the step-catalog name this line binds to">' + esc(step.catalog) +
      (step.kind === 'denied' ? ' · security half' : '') + '</span>' +
      '</div>' + checks +
      '<div class="tools editonly">' +
      '<button class="small ghost" data-act="up"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="small ghost" data-act="down"' + (index === total - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="small ghost" data-act="del">delete</button>' +
      '</div></div>';
    return line;
  }

  function bindSession(line, session, index) {
    line.addEventListener('click', function (ev) {
      if (ev.target.closest('input,select,button,.pill')) return;
      P2.ui.select({ kind: 'session', id: session.id }, true);
    });
    line.querySelectorAll('[data-f]').forEach(function (input) {
      input.addEventListener('change', function (ev) {
        P2.ui.run(P2.ops.setSessionField(session.id, ev.target.dataset.f, ev.target.value));
      });
    });
    line.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        sessionAct(session, index, btn.dataset.act);
      });
    });
  }

  function sessionAct(session, index, act) {
    if (act === 'addstep' || act === 'adddeny') {
      var r = P2.ops.addStep(session.id, '', '', act === 'adddeny' ? 'denied' : 'does');
      P2.ui.run(r);
      if (r.ok) { P2.ui.select({ kind: 'step', id: r.id }, true); P2.ui.focusLine('input[data-f="verb"]'); }
    } else if (act === 'join') {
      P2.sheets.open('join', { after: session.id });
    } else if (act === 'record') {
      P2.ui.record(session.id);
    } else if (act === 'persona') {
      P2.ui.select({ kind: 'session', id: session.id }, true);
    } else if (act === 'up' || act === 'down') {
      P2.ui.run(P2.ops.moveSession(session.id, act));
    } else if (act === 'del') {
      P2.ui.run(P2.ops.deleteSession(session.id));
      P2.ui.select({ kind: 'graph', id: '' }, false);
    }
  }

  function bindStep(line, step, index) {
    line.addEventListener('click', function (ev) {
      if (ev.target.closest('input,select,button,.pill')) return;
      P2.ui.select({ kind: 'step', id: step.edgeId }, true);
    });
    line.querySelectorAll('[data-f]').forEach(function (input) {
      input.addEventListener('change', function (ev) {
        P2.ui.run(P2.ops.setStepField(step.edgeId, ev.target.dataset.f, ev.target.value));
      });
    });
    line.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var act = btn.dataset.act;
        if (act === 'confirmio') P2.ui.run(P2.ops.confirmPort(step.edgeId));
        else if (act === 'addcheck') { P2.ui.run(P2.ops.addCheck(step.edgeId)); P2.ui.select({ kind: 'step', id: step.edgeId }, true); }
        else if (act === 'up' || act === 'down') P2.ui.run(P2.ops.moveStep(step.edgeId, act));
        else if (act === 'del') { P2.ui.run(P2.ops.deleteStep(step.edgeId)); P2.ui.select({ kind: 'session', id: step.sessionId }, false); }
      });
    });
    line.querySelectorAll('[data-check]').forEach(function (pill) {
      pill.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var nodeId = pill.dataset.checknode;
        var id = pill.dataset.check;
        var node = P2.ops.findNode(state.doc, nodeId);
        var x = node && (node.expects || []).filter(function (e) { return e.id === id; })[0];
        if (x && x.draft) P2.ui.run(P2.ops.confirmCheck(nodeId, id));
        else P2.ui.select({ kind: 'step', id: step.edgeId }, true);
      });
    });
  }

  function head(doc) {
    var box = document.createElement('div');
    box.className = 'head';
    var systems = [];
    for (var key in doc.systems) if (Object.prototype.hasOwnProperty.call(doc.systems, key)) systems.push(doc.systems[key].label || key);
    box.innerHTML = '<input class="inline title" id="f_title" value="' + esc(doc.title || '') + '" placeholder="what this process is called">' +
      '<span class="sys mono">' + esc(systems.join(' · ')) + '</span>' +
      '<button class="small ghost" id="b_graphcard" title="graph settings — id, title, tags, systems">⚙</button>';
    box.querySelector('#f_title').addEventListener('change', function (ev) {
      P2.ui.run(P2.ops.setMeta(null, ev.target.value, null));
    });
    box.querySelector('#b_graphcard').addEventListener('click', function () { P2.ui.select({ kind: 'graph', id: '' }, true); });
    return box;
  }

  function render(model) {
    var host = document.getElementById('scriptwrap');
    if (!host) return;
    var doc = state.doc;
    var box = document.createElement('div');
    box.className = 'script';
    box.appendChild(head(doc));

    if (model.lines.problem) {
      var warn = document.createElement('div');
      warn.className = 'stub';
      warn.textContent = model.lines.problem;
      box.appendChild(warn);
    }

    model.lines.sessions.forEach(function (session, si) {
      var line = sessionLine(doc, session, si, model.lines.sessions.length);
      bindSession(line, session, si);
      box.appendChild(line);
      session.steps.forEach(function (step, ti) {
        var sl = stepLine(step, (si + 1) + '.' + (ti + 1), ti, session.steps.length);
        bindStep(sl, step, ti);
        box.appendChild(sl);
      });
      var add = document.createElement('div');
      add.className = 'addrow editonly';
      add.innerHTML = '<button class="small ghost" data-act="addstep">+ step</button>' +
        '<button class="small ghost" data-act="adddeny">+ must not</button>' +
        '<span class="hint" style="align-self:center">verb + record → port, catalog and checks are inferred</span>';
      add.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () { sessionAct(session, si, b.dataset.act); });
      });
      box.appendChild(add);
    });

    var addS = document.createElement('div');
    addS.className = 'addrow session-add editonly';
    addS.innerHTML = '<button class="small" id="b_addsession">+ session (next role in the chain)</button>' +
      '<span class="hint" style="align-self:center">the login chain is the line order — reorder with ↑ ↓</span>';
    addS.querySelector('button').addEventListener('click', function () {
      var first = '';
      for (var k in state.doc.systems) { if (Object.prototype.hasOwnProperty.call(state.doc.systems, k)) { first = k; break; } }
      var r = P2.ops.addSession('', first, '');
      P2.ui.run(r);
      if (r.ok) { P2.ui.select({ kind: 'session', id: r.id }, true); P2.ui.focusLine('input[data-f="role"]'); }
    });
    box.appendChild(addS);

    host.innerHTML = '';
    host.appendChild(box);
  }

  P2.script = { render: render };
})();
