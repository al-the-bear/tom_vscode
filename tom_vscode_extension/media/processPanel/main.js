// @ts-nocheck
// PROCESS sidebar view — where the active quest is in its process.
// Host: src/handlers/processPanel-handler.ts. State arrives as one 'state'
// message; every user action is posted back and the host answers with the
// new state, so this script holds no state of its own beyond what is shown
// and which descriptions are open.
/* global acquireVsCodeApi, marked */
(function () {
    var vscode = acquireVsCodeApi();
    // Shared components (media/shared/questHint.js) reuse it: acquireVsCodeApi() may be called only once.
    window.__tomVscodeApi = vscode;
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

    var OPENER_ICON = { mdBrowser: 'codicon-markdown', processEditor: 'codicon-type-hierarchy', editor: 'codicon-go-to-file' };
    var OPENER_TITLE = { mdBrowser: 'Open in the MD Browser', processEditor: 'Open in the process editor', editor: 'Open in its editor' };

    /**
     * The documents the position puts in front of the user (vscimpb64): one link each; a click opens it (the host
     * decides where). A document whose path is not set yet, or that does not exist yet, is shown and disabled.
     */
    function documentsBlock(docs) {
        if (!docs || !docs.length) { return ''; }
        return '<div class="documents"><div class="doc-head"><span class="codicon codicon-files"></span> Documents</div>'
            + docs.map(function (d, i) {
                var off = d.unresolved && d.unresolved.length ? 'Not set yet: ' + d.unresolved.join(', ')
                    : !d.exists ? 'Does not exist yet: ' + d.path : '';
                return '<button class="doc-link" data-doc="' + i + '"' + (off ? ' disabled' : '') + ' title="' + esc(off || (OPENER_TITLE[d.opener] || 'Open') + ': ' + d.path) + '">'
                    + '<span class="codicon ' + (OPENER_ICON[d.opener] || 'codicon-file') + '"></span> ' + esc(d.label)
                    + (d.path ? ' <span class="muted">' + esc(d.path) + '</span>' : '') + '</button>';
            }).join('') + '</div>';
    }

    function userActionBanner(action, confirmed) {
        return '<div class="user-action">'
            + '<div class="ua-head"><span class="codicon codicon-person"></span> Your turn — user action</div>'
            + '<div class="ua-name">' + esc(action.node.name || action.node.id) + '</div>'
            + (action.node.description ? '<div class="ua-desc">' + md(action.node.description) + '</div>' : '')
            + documentsBlock(current && current.documents)
            + '<div class="ua-hint">' + (confirmed
                ? 'Confirmed as done — decide how the process goes on.'
                : 'This ' + action.level + ' is done by you, not by an agent. Do it, then click Proceed to confirm it is done.') + '</div>'
            // The processes the step lists (subprocesses and branches) open in the process branching editor.
            + (!confirmed && current && current.startable
                ? '<button class="ua-branching" data-branching="1" title="The processes this step lists: a subprocess hands a result back, a branch hands nothing back"><span class="codicon codicon-debug-step-into"></span> Start a subprocess or branch…</button>'
                : '')
            + '</div>';
    }

    /**
     * The agent's suggestions for the running step (tomAi_suggestSubprocess): listed while the step runs,
     * Review live once its queue items are done (or when nothing runs), Dismiss drops them.
     */
    function suggestionsBanner(c) {
        var running = !!(c.stepRun && !c.stepRun.held);
        var due = !!c.state.suggestionsDue;
        return '<div class="suggestions">'
            + '<div class="sg-head"><span class="codicon codicon-lightbulb"></span> Suggested: '
            + c.state.suggestions.map(function (s) { return '<span title="' + esc(s.reason) + '">' + esc(s.process) + ' <span class="muted">(' + esc(s.kind) + ')</span></span>'; }).join(', ') + '</div>'
            + '<ul class="sg-reasons">' + c.state.suggestions.map(function (s) { return '<li><code>' + esc(s.process) + '</code> — ' + esc(s.reason) + '</li>'; }).join('') + '</ul>'
            + '<div class="sg-actions">'
            + '<button data-branching="1"' + (running ? ' disabled title="The step is still running: you decide once its queue items are done"' : ' title="Open the process branching editor"') + '><span class="codicon codicon-debug-step-into"></span> Review…</button>'
            + '<button data-dismiss-suggestions="1" title="' + (due ? 'Drop them; the process moves on as the step\'s run would have (' + esc(c.state.suggestionsDue.label) + ')' : 'Drop the suggestions') + '">Dismiss</button>'
            + (due ? '<span class="muted">The step is done — its move waits for your choice.</span>' : running ? '<span class="muted">Shown once the step\'s queue items are done.</span>' : '')
            + '</div></div>';
    }

    /** Lower levels of the process stack the user opened (by index), kept across re-renders. */
    var levelOpen = {};
    var KIND_LABEL = { process: 'Quest process', subprocess: 'Subprocess', branch: 'Branch' };

    function kvList(title, values) {
        var keys = Object.keys(values || {});
        if (!keys.length) { return ''; }
        return '<div class="lv-kv"><span class="lv-label">' + esc(title) + '</span> ' + keys.map(function (k) {
            return '<code>' + esc(k) + '</code> = ' + esc(values[k]);
        }).join('; ') + '</div>';
    }

    function handedBack(subOutputs) {
        var parts = [];
        Object.keys(subOutputs || {}).forEach(function (p) {
            Object.keys(subOutputs[p]).forEach(function (n) { parts.push('<code>${sub.' + esc(p) + '.' + esc(n) + '}</code> = ' + esc(subOutputs[p][n])); });
        });
        return parts.length ? '<div class="lv-kv"><span class="lv-label">Handed back</span> ' + parts.join('; ') + '</div>' : '';
    }

    /** A level below the running one: collapsed by default, it waits at its step. */
    function lowerLevel(l, processRow) {
        return '<details class="level waiting" data-level-index="' + l.index + '"' + (levelOpen[l.index] ? ' open' : '') + '>'
            + '<summary><span class="lv-kind ' + esc(l.kind) + '">' + esc(KIND_LABEL[l.kind] || l.kind) + '</span> '
            + '<span class="lv-name">' + esc(l.name) + '</span> <span class="muted">— ' + esc(l.position) + ' · waiting</span></summary>'
            + '<div class="lv-body">'
            + (processRow || '<div class="lv-kv"><span class="lv-label">Process</span> ' + esc(l.name) + ' <code>' + esc(l.process) + '</code></div>')
            + '<div class="lv-kv"><span class="lv-label">At</span> ' + esc(l.position) + ' — waits for the level above</div>'
            + (l.followUp ? '<div class="lv-kv"><span class="lv-label">When it ends</span> ' + esc(l.followUp) + '</div>' : '')
            + kvList('Inputs', l.inputs) + handedBack(l.subOutputs)
            + '</div></details>';
    }

    /** The running level's head: what it is, and Abort for a subprocess or branch. */
    function runningHead(l) {
        if (!l || l.kind === 'process') { return ''; }
        return '<div class="level-head running"><span class="lv-kind ' + esc(l.kind) + '">' + esc(KIND_LABEL[l.kind]) + '</span> '
            + '<span class="lv-name">' + esc(l.name) + '</span>'
            + '<span class="spacer"></span><button class="icon" data-abort="1" title="Abort ' + (l.kind === 'branch' ? 'the branch' : 'the subprocess') + ' (asks first); the step below goes on with: ' + esc(l.followUp) + '"><span class="codicon codicon-debug-stop"></span> Abort</button></div>'
            + (l.followUp ? '<div class="lv-kv"><span class="lv-label">When it ends</span> the step below: ' + esc(l.followUp) + '</div>' : '')
            + kvList('Inputs', l.inputs) + kvList('Outputs set', l.outputs);
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
        'gate-failed': 'error', 'finish-process': 'check-all', 'follow-up': 'arrow-swap', skip: 'debug-step-over', 'leave-out': 'debug-step-out', back: 'arrow-left',
    };
    var LEVEL_SHORT = { phase: 'phase', step: 'step', substep: 'sub' };

    /** The decision the quest is at — its options, from the host's moves — or null. */
    function decisionHere(c) {
        // A position that has run, or a subprocess / branch above that ended with "ask me at the end".
        if (!c || !c.state || !(c.state.decision || c.state.nestedEnded) || c.state.completed) { return null; }
        var options = (c.moves || []).filter(function (m) { return m.branchOption; });
        return options.length ? { options: options } : null;
    }

    function decisionReason(c) {
        var ended = c && c.state && c.state.nestedEnded;
        if (!ended) { return 'This position has run.'; }
        return 'The ' + ended.kind + ' ' + ended.process + (ended.outcome === 'aborted' ? ' was aborted.' : ' finished.');
    }

    function decisionBanner(decision) {
        return '<div class="branch-decision">'
            + '<div class="bd-head"><span class="codicon codicon-repo-forked"></span> Decision — how does the process go on?</div>'
            + '<div class="bd-name">' + esc(decisionReason(current)) + '</div>'
            + '<ul class="bd-options">' + decision.options.map(function (o) { return '<li title="' + esc(o.to) + '">' + esc(o.label) + '</li>'; }).join('') + '</ul>'
            + '<div class="bd-hint">Click Decide… to choose.</div>'
            + '</div>';
    }

    /** The step a Proceed started, while its queue items run (or one failed). */
    function stepRunBanner(run) {
        if (run.held) {
            return '<div class="step-run held"><span class="codicon codicon-error"></span> failed — see the queue'
                + '<div class="sr-hint">Proceed: repeat the step, or move on to ' + esc(run.to) + '.</div></div>';
        }
        return '<div class="step-run"><span class="codicon codicon-loading codicon-modifier-spin"></span> ⏳ running — '
            + run.left + ' item' + (run.left === 1 ? '' : 's') + ' left'
            + '<div class="sr-hint">Then the process moves to ' + esc(run.to) + '.</div></div>';
    }

    function actionBar(moves) {
        var byUser = !!userActionHere(current);
        var atDecision = !!decisionHere(current);
        var running = current && current.stepRun && !current.stepRun.held;
        // A decision's options are chosen in its dialog (Decide…), not here.
        var buttons = (moves || []).filter(function (m) { return !m.branchOption; }).map(function (m) {
            var user = byUser && !atDecision && m.kind === 'proceed';
            var decide = atDecision && m.kind === 'proceed';
            var icon = m.kind === 'back' && m.label === 'Reopen' ? 'debug-reverse-continue'
                : decide ? 'repo-forked'
                    : user ? 'person' : MOVE_ICON[m.kind] || 'circle';
            var text = m.level && (m.kind === 'repeat' || m.kind === 'finish' || m.kind === 'leave-out') ? '<span class="lvl">' + LEVEL_SHORT[m.level] + '</span>' : '';
            // While the step runs, Proceed waits for its queue.
            var wait = running && m.kind === 'proceed';
            var title = wait ? 'The step is running — ' + current.stepRun.left + ' item(s) left; then ' + current.stepRun.to : m.label + ' → ' + m.to;
            return '<button class="icon act act-' + m.kind + (user ? ' act-user' : '') + (decide ? ' act-branch' : '') + '" data-move="' + esc(m.kind) + '" data-level="' + esc(m.level || '') + '" title="'
                + esc(title) + '"' + (wait ? ' disabled' : '') + '><span class="codicon codicon-' + icon + '"></span>' + text + '</button>';
        }).join('');
        return '<div class="actions">' + (buttons || '<span class="muted">No move from here.</span>')
            + '<span class="spacer"></span><button class="icon" data-templates="1" title="Edit the Proceed prompt template"><span class="codicon codicon-symbol-snippet"></span></button></div>';
    }

    /** A phase's or step's condition note: optional, `runs only when …` and how it stands now. */
    function conditionNote(note) {
        if (!note) { return ''; }
        var parts = [];
        if (note.optional) { parts.push('optional'); }
        if (note.when) { parts.push('runs only when ' + note.when + (note.verdict ? ' — ' + note.verdict : '')); }
        return '<div class="cond-note"><span class="codicon codicon-filter"></span> ' + esc(parts.join('; ')) + '</div>';
    }

    /** What was left out (newest first): which alternative ran is what is not listed. */
    function leftOutBox(items) {
        if (!items || !items.length) { return ''; }
        var BY = { condition: 'by its condition', user: 'by the user', agent: 'by the agent' };
        return '<details class="left-out"><summary><span class="codicon codicon-debug-step-out"></span> Left out (' + items.length + ')</summary><ul>'
            + items.map(function (r) {
                return '<li title="' + esc(r.at || '') + '"><b>' + esc(r.where) + '</b>' + (r.phaseIteration > 1 ? ' <span class="muted">(iteration ' + r.phaseIteration + ')</span>' : '')
                    + ' — ' + esc(r.reason) + ' <span class="muted">(' + esc(BY[r.by] || r.by) + ')</span></li>';
            }).join('') + '</ul></details>';
    }

    /** The follow-up chain: the processes this one was switched to from, oldest first, with what each switch took along. */
    function originBox(origins, process) {
        if (!origins || !origins.length) { return ''; }
        var kv = function (rec) {
            return Object.keys(rec || {}).map(function (k) { return k + ' = ' + (rec[k] || '(not set)'); }).join(', ');
        };
        return '<details class="origin-chain" open><summary><span class="codicon codicon-arrow-swap"></span> Continued from '
            + esc(origins[origins.length - 1].process) + '</summary><ol>'
            + origins.map(function (o) {
                var extra = [kv(o.carried) ? 'carried: ' + kv(o.carried) : '', kv(o.context) ? 'context: ' + kv(o.context) : ''].filter(Boolean).join('; ');
                return '<li title="' + esc(o.at || '') + '"><b>' + esc(o.process) + '</b> › ' + esc(o.where)
                    + ' <span class="muted">(the ' + esc(o.level) + '\'s follow-up)</span>' + (extra ? '<div class="muted">' + esc(extra) + '</div>' : '') + '</li>';
            }).join('') + '<li><b>' + esc(process) + '</b> <span class="muted">(now)</span></li></ol></details>';
    }

    /** When a run's state file was last written, as `YYYY-MM-DD HH:MM` local time; '' when never. */
    function changedText(iso) {
        if (!iso) { return ''; }
        var d = new Date(iso);
        if (isNaN(d.getTime())) { return ''; }
        var two = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
    }

    /** The run list at the top: every run with its process and position, the current one marked; + and trash. */
    function runList(c) {
        var runs = c.runs || [];
        var deletable = runs.some(function (r) { return r.run !== 'default'; });
        var rows = runs.map(function (r) {
            var where = r.process ? r.process + (r.position ? ' — ' + r.position : '') : 'no process yet';
            var when = changedText(r.changed);
            return '<button class="run-item' + (r.current ? ' current' : '') + '" data-run-select="' + esc(r.run) + '"'
                + ' title="' + esc(r.current ? 'This window works on this run' : 'Work on this run in this window') + (when ? ' — last changed ' + esc(when) : '') + '">'
                + '<span class="codicon codicon-' + (r.current ? 'circle-filled' : 'circle-outline') + '"></span>'
                + '<span class="run-name">' + esc(r.run) + '</span>'
                + '<span class="run-where">' + esc(where) + '</span>'
                + (when ? '<span class="run-when">' + esc(when) + '</span>' : '')
                + '</button>';
        }).join('');
        return '<div class="runs">'
            + '<div class="runs-head"><span class="codicon codicon-run-all"></span> Runs'
            + '<span class="spacer"></span>'
            + '<button class="icon" data-run-create="1" title="New run: a name, then the process it follows (optional); it becomes this window\'s run"><span class="codicon codicon-add"></span></button>'
            + '<button class="icon" data-run-delete="1" title="Delete runs (default is never deleted)"' + (deletable ? '' : ' disabled') + '><span class="codicon codicon-trash"></span></button>'
            + '<button class="icon" data-run-reset="process" title="Reset Process: this run back to the first position of its process; the run parameters the process declares are cleared (asks first)"' + (current && current.state && current.state.process ? '' : ' disabled') + '><span class="codicon codicon-debug-restart"></span></button>'
            + '<button class="icon" data-run-reset="run" title="Reset Run: everything process-related of this run goes — no process yet (default keeps its process, from its first position), every custom chat variable cleared (asks first)"><span class="codicon codicon-discard"></span></button>'
            + '</div>'
            + '<div class="run-list">' + (rows || '<span class="muted">No runs.</span>') + '</div>'
            + '</div>';
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
        var levels = c.levels || [];
        var nested = levels.length > 1;
        var running = levels[levels.length - 1];
        var html = '';
        var action = userActionHere(c);
        var decision = decisionHere(c);
        if (c.stepRun) { html += stepRunBanner(c.stepRun); }
        else if (decision) { html += decisionBanner(decision); }
        else if (action) { html += userActionBanner(action, false); }
        // Documents outside the Your turn box: a position that names them without being the user's, or while it runs.
        if (!(action && !c.stepRun && !decision)) { html += documentsBlock(c.documents); }
        if (c.state.suggestions && c.state.suggestions.length) { html += suggestionsBanner(c); }
        if (c.state.completed) { html += '<div class="done"><span class="codicon codicon-check-all"></span> The process is finished.</div>'; }
        var procOptions = [{ value: '', label: '— none —' }].concat(c.processes.map(function (p) {
            return { value: p.id, label: p.valid ? p.name + ' (' + p.id + ')' : p.id + ' (invalid)', disabled: !p.valid && p.id !== c.state.process };
        }));
        var edit = '<button class="icon" data-edit="1" title="Open the process editor"><span class="codicon codicon-edit"></span></button>';
        // The quest's own process is switched only here, in the bottom level's dropdown (any process);
        // a subprocess or branch level shows its process, which is what its step listed.
        var questProcessRow = row('Process', select('sel-process', procOptions, nested ? levels[0].process : c.state.process, 'The process this quest follows' + (nested ? ' — switching leaves every level above' : '')),
            edit, 'quest-process', '');
        var top = '';
        if (nested) {
            top += '<div class="levels">' + levels.slice(0, -1).map(function (l) { return lowerLevel(l, l.index === 0 ? questProcessRow : ''); }).join('') + '</div>';
            top += '<div class="level running-level">' + runningHead(running);
        }
        html = top + (c.state.process && c.definition ? actionBar(c.moves) : '') + html;
        // Several runs of the quest (process positions of their own): which one this view shows and moves.
        // The quest's runs (process positions of their own), the last changed first: click one to work on it.
        html = runList(c) + html;
        html += nested
            ? row('Process', '<span class="lv-name">' + esc(running.name) + '</span> <code>' + esc(running.process) + '</code>', help('process') + edit, 'process', c.description)
            : row('Process', select('sel-process', procOptions, c.state.process, 'The process this quest follows'),
                (c.state.process ? help('process') : '') + edit, 'process', c.description);
        if (c.processInvalid) {
            html += '<div class="warn">The definition of "' + esc(c.state.process) + '" has errors — fix it in the process editor.</div>';
        }
        var def = c.definition;
        if (def) {
            var phase = def.phases.find(function (p) { return p.id === c.state.phase; });
            var cond = c.conditions || { phase: null, steps: {} };
            var leftIds = (c.state.skipped || []).filter(function (r) { return r.phase === c.state.phase && r.phaseIteration === c.state.phaseIteration && r.step; })
                .map(function (r) { return r.step; });
            html += row('Phase', select('sel-phase', def.phases.map(function (p, i) { return { value: p.id, label: (i + 1) + '. ' + label(p) + (p.optional || p.when ? ' ⁇' : '') }; }), c.state.phase, 'Phase (⁇: optional or conditional)'),
                iteration('phase', phase, c.state.phaseIteration) + help('phase'), 'phase', phase && phase.description);
            html += conditionNote(cond.phase);
            if (phase) {
                var entries = stepsOf(phase);
                var entry = entries.find(function (e) { return e.step.id === c.state.step; });
                var stepOptions = entries.map(function (e, i) {
                    var prefix = e.kind === 'gate' ? 'Gate: ' : e.kind === 'post-gate' ? 'Post-gate: ' : '';
                    var mark = leftIds.indexOf(e.step.id) >= 0 ? ' — left out' : cond.steps[e.step.id] ? ' ⁇' : '';
                    return { value: e.step.id, label: (i + 1) + '. ' + prefix + label(e.step) + mark };
                });
                var step = entry && entry.step;
                html += row('Step', select('sel-step', stepOptions, c.state.step, 'Step of the phase (⁇: optional or conditional)'),
                    iteration('step', step, c.state.stepIteration, entry && entry.kind === 'gate') + help('step'), 'step', step && step.description);
                html += conditionNote(step && cond.steps[step.id]);
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
        html += originBox(c.origins, (c.definition && (c.definition.name || c.definition.id)) || (c.state && c.state.process) || '');
        html += leftOutBox(c.leftOut);
        if (c.processes.length === 0) {
            html += '<div class="muted">No processes yet — create one in the process editor (_ai/processes/).</div>';
        }
        if (nested) { html += '</div>'; }
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
        if (btn.dataset.runSelect !== undefined) {
            if (!btn.classList.contains('current')) { post({ type: 'selectRun', run: btn.dataset.runSelect }); }
        } else if (btn.dataset.runCreate) {
            post({ type: 'createRun' });
        } else if (btn.dataset.runDelete) {
            post({ type: 'deleteRuns' });
        } else if (btn.dataset.runReset) {
            post({ type: 'resetRun', mode: btn.dataset.runReset });
        } else if (btn.dataset.move) {
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
        } else if (btn.dataset.abort) {
            post({ type: 'abortNested' });
        } else if (btn.dataset.branching) {
            post({ type: 'openBranching' });
        } else if (btn.dataset.doc !== undefined) {
            post({ type: 'openDocument', index: Number(btn.dataset.doc) });
        } else if (btn.dataset.dismissSuggestions) {
            post({ type: 'dismissSuggestions' });
        }
    });

    root.addEventListener('toggle', function (e) {
        var d = e.target;
        if (d && d.classList && d.classList.contains('level')) { levelOpen[d.getAttribute('data-level-index')] = d.open; }
    }, true);

    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (msg && msg.type === 'state') {
            current = msg;
            render();
        }
    });

    post({ type: 'ready' });
})();
