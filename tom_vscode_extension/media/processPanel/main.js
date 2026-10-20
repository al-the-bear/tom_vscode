// @ts-nocheck
// PROCESS sidebar view — where the active quest is in its process.
// Host: src/handlers/processPanel-handler.ts. State arrives as one 'state'
// message; every user action is posted back and the host answers with the
// new state, so this script holds no state of its own beyond what is shown
// and which descriptions are open.
/* global acquireVsCodeApi, marked */
(function () {
    var vscode = acquireVsCodeApi();
    var INIT = window.__INIT__ || {};
    var nonce = (document.currentScript && document.currentScript.nonce) || '';

    // Codicons and marked come from node_modules: no loader placeholder exists
    // for them, so they are added here (the script with this script's nonce).
    if (INIT.codiconsUri) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = INIT.codiconsUri;
        document.head.appendChild(link);
    }
    if (INIT.markedUri) {
        var s = document.createElement('script');
        s.src = INIT.markedUri;
        s.nonce = nonce;
        s.onload = function () { render(); };
        document.head.appendChild(s);
    }

    var root = /** @type {HTMLElement} */ (document.getElementById('root'));
    var current = null;
    /** Which descriptions are open, by level ('process', 'phase', 'step', 'substep'). */
    var open = {};

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function md(text) {
        if (!text) { return '<div class="muted">No description.</div>'; }
        // eslint-disable-next-line no-undef
        if (typeof marked !== 'undefined' && marked.parse) { return marked.parse(text); }
        return '<pre>' + esc(text) + '</pre>';
    }

    function label(node) {
        return (node.userAction ? '👤 ' : '') + (node.name ? node.name + ' (' + node.id + ')' : node.id);
    }

    /** The user action at the current position (a flagged sub-step, or step without sub-steps), or null. */
    function userActionHere(c) {
        if (!c.definition || !c.state.process || c.state.completed) { return null; }
        var phase = c.definition.phases.find(function (p) { return p.id === c.state.phase; });
        var entry = phase && stepsOf(phase).find(function (e) { return e.step.id === c.state.step; });
        var step = entry && entry.step;
        if (!step) { return null; }
        if (step.substeps && step.substeps.length) {
            var sub = step.substeps.find(function (x) { return x.id === c.state.substep; });
            return sub && sub.userAction ? { level: 'sub-step', node: sub } : null;
        }
        return step.userAction ? { level: 'step', node: step } : null;
    }

    function userActionBanner(action, confirmed) {
        return '<div class="user-action">'
            + '<div class="ua-head"><span class="codicon codicon-person"></span> Your turn — user action</div>'
            + '<div class="ua-name">' + esc(action.node.name || action.node.id) + '</div>'
            + (action.node.description ? '<div class="ua-desc">' + md(action.node.description) + '</div>' : '')
            + '<div class="ua-hint">' + (confirmed
                ? 'Confirmed as done — decide how the process goes on.'
                : 'This ' + action.level + ' is done by you, not by an agent. Do it, then click Proceed to confirm it is done.') + '</div>'
            + '</div>';
    }

    /** The steps of a phase in order: steps, gate, post-gate. */
    function stepsOf(phase) {
        var out = phase.steps.map(function (st) { return { kind: 'step', step: st }; });
        out.push({ kind: 'gate', step: phase.gate });
        if (phase.postGate) { out.push({ kind: 'post-gate', step: phase.postGate }); }
        return out;
    }

    function select(id, options, value, title) {
        return '<select id="' + id + '" title="' + esc(title) + '">' + options.map(function (o) {
            return '<option value="' + esc(o.value) + '"' + (o.value === value ? ' selected' : '') + (o.disabled ? ' disabled' : '') + '>' + esc(o.label) + '</option>';
        }).join('') + '</select>';
    }

    /** Icon and short text of each move kind in the action bar. */
    var MOVE_ICON = {
        proceed: 'play', finish: 'check', repeat: 'debug-restart', 'gate-passed': 'pass',
        'gate-failed': 'error', 'finish-process': 'check-all', skip: 'debug-step-over', back: 'arrow-left',
    };
    var LEVEL_SHORT = { phase: 'phase', step: 'step', substep: 'sub' };

    function actionBar(moves) {
        var byUser = !!userActionHere(current);
        var buttons = (moves || []).map(function (m) {
            var user = byUser && m.kind === 'proceed';
            var icon = m.kind === 'back' && m.label === 'Reopen' ? 'debug-reverse-continue'
                : user ? 'person'
                    : m.kind === 'proceed' && m.label === 'Run again' ? 'debug-rerun' : MOVE_ICON[m.kind] || 'circle';
            var text = m.level && (m.kind === 'repeat' || m.kind === 'finish') ? '<span class="lvl">' + LEVEL_SHORT[m.level] + '</span>' : '';
            return '<button class="icon act act-' + m.kind + (user ? ' act-user' : '') + '" data-move="' + esc(m.kind) + '" data-level="' + esc(m.level || '') + '" title="'
                + esc(m.label + ' → ' + m.to) + '"><span class="codicon codicon-' + icon + '"></span>' + text + '</button>';
        }).join('');
        return '<div class="actions">' + (buttons || '<span class="muted">No move from here.</span>')
            + '<span class="spacer"></span><button class="icon" data-templates="1" title="Edit the Proceed prompt template"><span class="codicon codicon-symbol-snippet"></span></button></div>';
    }

    function iteration(level, node, n, alwaysRepeatable) {
        var repeatable = node && (node.repeatable === true || !!alwaysRepeatable);
        var max = node && node.repeatable === true && node.maxIterations;
        var text = repeatable ? (max ? n + '/' + max : String(n)) : '1';
        return '<span class="iter" title="' + (repeatable ? 'Iteration' + (max ? ' (at most ' + max + ')' : '') : 'Not repeatable') + '">'
            + '<button class="icon" data-iter="' + level + '" data-delta="-1"' + (!repeatable || n <= 1 ? ' disabled' : '') + ' title="Previous iteration (corrects the number)"><span class="codicon codicon-remove"></span></button>'
            + '<span class="iter-n">' + esc(text) + '</span>'
            + '<button class="icon" data-iter="' + level + '" data-delta="1"' + (!repeatable || (max && n >= max) ? ' disabled' : '') + ' title="Start the next iteration"><span class="codicon codicon-add"></span></button>'
            + '</span>';
    }

    function help(level) {
        return '<button class="icon' + (open[level] ? ' active' : '') + '" data-help="' + level + '" title="Show the description"><span class="codicon codicon-question"></span></button>';
    }

    function row(title, control, extra, level, text) {
        return '<div class="row"><label>' + title + '</label><div class="control">' + control + '</div>' + extra + '</div>'
            + (open[level] ? '<div class="desc">' + md(text) + '</div>' : '');
    }

    function render() {
        var c = current;
        if (!c) { return; }
        if (!c.quest) {
            root.innerHTML = '<div class="muted">No quest is active. A process state belongs to a quest — choose one in the Chat Variables.</div>';
            return;
        }
        var html = c.state.process && c.definition ? actionBar(c.moves) : '';
        var action = userActionHere(c);
        if (action) { html += userActionBanner(action, !!c.state.ran); }
        if (c.state.completed) { html += '<div class="done"><span class="codicon codicon-check-all"></span> The process is finished.</div>'; }
        else if (c.state.ran && !action) { html += '<div class="ran"><span class="codicon codicon-debug-pause"></span> This position has been run — decide how the process goes on.</div>'; }
        var procOptions = [{ value: '', label: '— none —' }].concat(c.processes.map(function (p) {
            return { value: p.id, label: p.valid ? p.name + ' (' + p.id + ')' : p.id + ' (invalid)', disabled: !p.valid && p.id !== c.state.process };
        }));
        var edit = '<button class="icon" data-edit="1" title="Open the process editor"><span class="codicon codicon-edit"></span></button>';
        html += row('Process', select('sel-process', procOptions, c.state.process, 'The process this quest follows'),
            (c.state.process ? help('process') : '') + edit, 'process', c.description);
        if (c.processInvalid) {
            html += '<div class="warn">The definition of "' + esc(c.state.process) + '" has errors — fix it in the process editor.</div>';
        }
        var def = c.definition;
        if (def) {
            var phase = def.phases.find(function (p) { return p.id === c.state.phase; });
            html += row('Phase', select('sel-phase', def.phases.map(function (p, i) { return { value: p.id, label: (i + 1) + '. ' + label(p) }; }), c.state.phase, 'Phase'),
                iteration('phase', phase, c.state.phaseIteration) + help('phase'), 'phase', phase && phase.description);
            if (phase) {
                var entries = stepsOf(phase);
                var entry = entries.find(function (e) { return e.step.id === c.state.step; });
                var stepOptions = entries.map(function (e, i) {
                    var prefix = e.kind === 'gate' ? 'Gate: ' : e.kind === 'post-gate' ? 'Post-gate: ' : '';
                    return { value: e.step.id, label: (i + 1) + '. ' + prefix + label(e.step) };
                });
                var step = entry && entry.step;
                html += row('Step', select('sel-step', stepOptions, c.state.step, 'Step of the phase'),
                    iteration('step', step, c.state.stepIteration, entry && entry.kind === 'gate') + help('step'), 'step', step && step.description);
                if (step && step.substeps && step.substeps.length) {
                    var sub = step.substeps.find(function (x) { return x.id === c.state.substep; });
                    html += row('Sub-step', select('sel-substep', step.substeps.map(function (x, i) { return { value: x.id, label: (i + 1) + '. ' + label(x) }; }), c.state.substep, 'Sub-step'),
                        iteration('substep', sub, c.state.substepIteration) + help('substep'), 'substep', sub && sub.description);
                }
                var roleNote = c.stepRole
                    ? '<code>' + esc(c.stepRole) + '</code>' + (c.chatRole && c.chatRole !== c.stepRole ? ' <span class="muted">(chat role: ' + esc(c.chatRole) + ')</span>' : '')
                    : '<span class="muted">none named' + (c.chatRole ? ' — chat role: ' + esc(c.chatRole) : '') + '</span>';
                html += '<div class="row"><label>Role</label><div class="control role">' + roleNote + '</div></div>';
                if (entry && entry.kind === 'post-gate' && (step.todos && step.todos.length || step.todoPrefix)) {
                    html += '<div class="todos"><div class="todos-title">Before the next phase:</div><ul>'
                        + (step.todos || []).map(function (t) { return '<li title="' + esc(t.description || '') + '">' + esc(t.title) + '</li>'; }).join('')
                        + (step.todoPrefix ? '<li>quest todos <code>' + esc(step.todoPrefix) + '*</code></li>' : '')
                        + '</ul></div>';
                }
            }
        }
        if (c.processes.length === 0) {
            html += '<div class="muted">No processes yet — create one in the process editor (_ai/processes/).</div>';
        }
        root.innerHTML = html;
    }

    function post(msg) { vscode.postMessage(msg); }

    root.addEventListener('change', function (e) {
        var t = /** @type {HTMLSelectElement} */ (e.target);
        if (!t || t.tagName !== 'SELECT') { return; }
        var key = { 'sel-process': 'process', 'sel-phase': 'phase', 'sel-step': 'step', 'sel-substep': 'substep' }[t.id];
        if (!key) { return; }
        var change = {};
        change[key] = t.value;
        post({ type: 'change', change: change });
    });

    root.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement} */ (e.target);
        var btn = target && target.closest ? /** @type {HTMLButtonElement|null} */ (target.closest('button')) : null;
        if (!btn || btn.disabled) { return; }
        if (btn.dataset.move) {
            post({ type: 'action', kind: btn.dataset.move, level: btn.dataset.level || undefined });
        } else if (btn.dataset.templates) {
            post({ type: 'openTemplates' });
        } else if (btn.dataset.iter) {
            post({ type: 'iteration', level: btn.dataset.iter, delta: Number(btn.dataset.delta) });
        } else if (btn.dataset.help) {
            open[btn.dataset.help] = !open[btn.dataset.help];
            render();
        } else if (btn.dataset.edit) {
            post({ type: 'openEditor', id: current && current.state.process });
        }
    });

    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (msg && msg.type === 'state') {
            current = msg;
            render();
        }
    });

    post({ type: 'ready' });
})();
