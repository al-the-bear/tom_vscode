// @ts-nocheck
// Process editor — host: src/handlers/processEditor-handler.ts.
//
// The selected process is one model, `doc.def` (the .process.yaml as an
// object) plus `doc.description` (its .md). The form is rendered from the
// model; typing writes into the model without re-rendering (focus stays), the
// structural buttons (add, remove, move) change the model and re-render.
// Every change is validated by the host (validateProcessDefinition), debounced.
/* global acquireVsCodeApi */
(function () {
    var vscode = acquireVsCodeApi();
    var INIT = window.__INIT__ || {};
    if (INIT.codiconsUri) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = INIT.codiconsUri;
        document.head.appendChild(link);
    }

    var listEl = /** @type {HTMLElement} */ (document.getElementById('list'));
    var mainEl = /** @type {HTMLElement} */ (document.getElementById('main'));
    var processes = [];
    var roles = [];
    var currentProcess = '';
    var selected = '';
    /** @type {{id: string, def: any, description: string, errors: any[], files: any, dirty: boolean, status: string} | null} */
    var doc = null;
    /** Phases folded by the user, by index — kept across re-renders. */
    var folded = {};
    var validateTimer = null;

    function post(msg) { vscode.postMessage(msg); }

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---- The model ----------------------------------------------------------

    function parsePath(p) { return p.split('.').map(function (k) { return /^\d+$/.test(k) ? Number(k) : k; }); }

    function getAt(path) {
        var node = doc && doc.def;
        for (var i = 0; i < path.length && node !== null && node !== undefined; i++) { node = node[path[i]]; }
        return node;
    }

    /** Set a field; an empty optional value removes the key, so the YAML stays minimal. */
    function setAt(path, value) {
        var parent = getAt(path.slice(0, -1));
        var key = path[path.length - 1];
        if (!parent) { return; }
        if ((value === '' || value === false || value === undefined) && key !== 'id' && key !== 'title') { delete parent[key]; } else { parent[key] = value; }
    }

    /** An id not used among `items` yet: base, base2, base3, … */
    function freshId(base, items) {
        var used = {};
        (items || []).forEach(function (x) { if (x) { used[x.id] = true; } });
        if (!used[base]) { return base; }
        for (var n = 2; ; n++) { if (!used[base + n]) { return base + n; } }
    }

    function phaseNodes(phase) {
        return (phase.steps || []).concat([phase.gate, phase.postGate]).filter(Boolean);
    }

    function changed() {
        if (!doc) { return; }
        doc.dirty = true;
        doc.status = '';
        updateHead();
        clearTimeout(validateTimer);
        validateTimer = setTimeout(function () { post({ type: 'validate', definition: doc && doc.def }); }, 300);
    }

    // ---- Rendering ----------------------------------------------------------

    function renderList() {
        listEl.innerHTML = processes.map(function (p) {
            return '<li class="item' + (p.id === selected ? ' selected' : '') + '" data-id="' + esc(p.id) + '">'
                + '<span class="item-name">' + esc(p.name) + '</span>'
                + '<span class="item-id">' + esc(p.id) + '</span>'
                + (p.id === currentProcess ? '<span class="badge" title="The active quest follows this process">current</span>' : '')
                + (p.valid ? '' : '<span class="badge error" title="' + p.errorCount + ' problem(s)">invalid</span>')
                + '</li>';
        }).join('') || '<li class="muted">No processes yet.</li>';
    }

    function roleSelect(path, value) {
        var options = [''].concat(roles);
        if (value && options.indexOf(value) < 0) { options.push(value); }
        return '<select data-path="' + path + '" title="The role doing this step">' + options.map(function (r) {
            return '<option value="' + esc(r) + '"' + (r === (value || '') ? ' selected' : '') + '>' + (r ? esc(r) : '— no role —') + '</option>';
        }).join('') + '</select>';
    }

    function text(path, value, placeholder, cls) {
        return '<input type="text" class="' + (cls || '') + '" data-path="' + path + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '">';
    }

    function repeatFields(path, node, what) {
        return '<label class="check" title="May run in several iterations"><input type="checkbox" data-path="' + path + '.repeatable" data-kind="bool"' + (node.repeatable ? ' checked' : '') + '> repeatable</label>'
            + '<input type="number" min="1" class="max" data-path="' + path + '.maxIterations" data-kind="int" value="' + esc(node.maxIterations || '') + '" placeholder="max" title="At most this many iterations of the ' + what + ' (needs repeatable)">';
    }

    function moveButtons(path, index, count, removable) {
        return '<span class="card-ops">'
            + '<button class="icon" data-op="up" data-path="' + path + '"' + (index === 0 ? ' disabled' : '') + ' title="Move up"><span class="codicon codicon-arrow-up"></span></button>'
            + '<button class="icon" data-op="down" data-path="' + path + '"' + (index === count - 1 ? ' disabled' : '') + ' title="Move down"><span class="codicon codicon-arrow-down"></span></button>'
            + (removable ? '<button class="icon" data-op="remove" data-path="' + path + '" title="Remove"><span class="codicon codicon-trash"></span></button>' : '')
            + '</span>';
    }

    function description(path, value, rows) {
        return '<textarea data-path="' + path + '.description" rows="' + (rows || 2) + '" placeholder="Description (Markdown) — shown behind the ? in the PROCESS view and in the system prompt">' + esc(value || '') + '</textarea>';
    }

    function promptField(path, value) {
        return '<textarea class="prompt" data-path="' + path + '.prompt" rows="2" placeholder="Prompt — what is to be done when it starts; the PROCESS view\'s action buttons put it into the prompt they queue (${action-prompt})">' + esc(value || '') + '</textarea>';
    }

    /**
     * The Agent SDK session fields of a node: name, based on, mode. Empty name
     * = inherit (from the step, then the phase). A string spec shows as its
     * name; the object form is written once a base or mode is set.
     */
    function sessionFields(path, spec) {
        var s = typeof spec === 'string' ? { name: spec } : (spec || {});
        var mode = s.mode || '';
        return '<span class="session-fields" title="The Agent SDK session the prompts of this node run in; empty = inherited">'
            + '<span class="codicon codicon-comment-discussion"></span>'
            + text(path + '.session.name', s.name, 'session (inherited)', 'session-name')
            + text(path + '.session.basedOn', s.basedOn, 'based on', 'session-base')
            + '<select data-path="' + path + '.session.mode" title="How a session based on another starts">'
            + '<option value=""' + (mode === '' ? ' selected' : '') + '>continue</option>'
            + '<option value="fork-from-base"' + (mode === 'fork-from-base' ? ' selected' : '') + '>fresh from base per prompt</option>'
            + '</select></span>';
    }

    /** The gate's failure target: one of the phase's steps, or the gate run again (unset). */
    function onFailField(path, gate, phaseStepsList) {
        var value = gate.onFail || '';
        var options = [{ value: '', label: 'Run the gate again' }].concat(phaseStepsList.map(function (s, i) {
            return { value: s.id, label: 'Back to ' + (i + 1) + '. ' + (s.name || s.id) };
        }));
        return '<label class="on-fail" title="Where the decision after the gate goes when the gate failed">If the gate fails: '
            + '<select data-path="' + path + '.onFail">' + options.map(function (o) {
                return '<option value="' + esc(o.value) + '"' + (o.value === value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
            }).join('') + '</select></label>';
    }

    /** A step card; `kind` is step, gate, post-gate or substep. */
    function stepCard(step, path, kind, index, count, phaseStepsList) {
        var title = { step: 'Step ' + (index + 1), gate: 'Quality gate', 'post-gate': 'Post-gate step', substep: 'Sub-step ' + (index + 1) }[kind];
        var html = '<div class="card ' + kind + '" data-node="' + path + '">'
            + '<div class="card-head"><span class="kind">' + title + '</span>'
            + text(path + '.id', step.id, 'id', 'id')
            + text(path + '.name', step.name, 'name', 'name')
            + roleSelect(path + '.role', step.role)
            + repeatFields(path, step, kind === 'substep' ? 'sub-step' : 'step')
            + (kind !== 'gate' && !(step.substeps && step.substeps.length)
                ? '<label class="check user-action-check" title="Done by the user, not by an agent: runs no prompt; Proceed asks to confirm it is done"><input type="checkbox" data-path="' + path + '.userAction" data-kind="bool"' + (step.userAction ? ' checked' : '') + '> user action</label>'
                : '')
            + (kind === 'step' || kind === 'substep' ? moveButtons(path, index, count, true) : '')
            + (kind === 'post-gate' ? '<span class="card-ops"><button class="icon" data-op="remove-postgate" data-path="' + path + '" title="Remove the post-gate step"><span class="codicon codicon-trash"></span></button></span>' : '')
            + '</div>'
            + description(path, step.description, 2)
            + promptField(path, step.prompt)
            + sessionFields(path, step.session)
            + (kind === 'gate' ? onFailField(path, step, phaseStepsList || []) : '');
        if (kind !== 'substep') {
            var subs = step.substeps || [];
            if (subs.length) {
                html += '<div class="subs"><div class="note">A step with sub-steps is a group: the sub-steps are the actions' + (step.role ? '; its role applies to those that name none' : '') + '.</div>'
                    + subs.map(function (s, k) { return stepCard(s, path + '.substeps.' + k, 'substep', k, subs.length); }).join('') + '</div>';
            }
            html += '<button class="add" data-op="add-substep" data-path="' + path + '"><span class="codicon codicon-add"></span> sub-step</button>';
        }
        if (kind === 'post-gate') {
            var todos = step.todos || [];
            html += '<div class="todos"><div class="note">Todos done after the gate passed, before the next phase starts.</div>'
                + todos.map(function (t, k) {
                    var tp = path + '.todos.' + k;
                    return '<div class="todo">' + text(tp + '.title', t.title, 'title', 'todo-title') + text(tp + '.description', t.description, 'description (optional)', 'todo-desc')
                        + '<button class="icon" data-op="remove" data-path="' + tp + '" title="Remove"><span class="codicon codicon-trash"></span></button></div>';
                }).join('')
                + '<button class="add" data-op="add-todo" data-path="' + path + '"><span class="codicon codicon-add"></span> todo</button>'
                + '<label class="prefix">and quest todos with the id prefix ' + text(path + '.todoPrefix', step.todoPrefix, 'e.g. phasetodos1', 'todo-prefix') + '</label>'
                + '</div>';
        }
        return html + '</div>';
    }

    function phaseCard(phase, i, count) {
        var path = 'phases.' + i;
        var steps = phase.steps || [];
        return '<details class="phase" data-phase="' + i + '"' + (folded[i] ? '' : ' open') + '>'
            + '<summary><span class="phase-title">Phase ' + (i + 1) + (phase.name ? ': ' + esc(phase.name) : '') + '</span>' + moveButtons(path, i, count, count > 1) + '</summary>'
            + '<div class="card-head">' + text(path + '.id', phase.id, 'id', 'id') + text(path + '.name', phase.name, 'name', 'name') + repeatFields(path, phase, 'phase') + '</div>'
            + description(path, phase.description, 3)
            + promptField(path, phase.prompt)
            + sessionFields(path, phase.session)
            + '<div class="steps">' + steps.map(function (s, k) { return stepCard(s, path + '.steps.' + k, 'step', k, steps.length); }).join('') + '</div>'
            + '<button class="add" data-op="add-step" data-path="' + path + '"><span class="codicon codicon-add"></span> step</button>'
            + stepCard(phase.gate || { id: '' }, path + '.gate', 'gate', 0, 1, steps)
            + (phase.postGate ? stepCard(phase.postGate, path + '.postGate', 'post-gate', 0, 1)
                : '<button class="add" data-op="add-postgate" data-path="' + path + '"><span class="codicon codicon-add"></span> post-gate step (todos after the gate passed)</button>')
            + '</details>';
    }

    function headHtml() {
        if (!doc) { return ''; }
        return '<div class="head" id="head">'
            + '<span class="head-title">' + esc(doc.def && doc.def.name || doc.id) + ' <span class="item-id">' + esc(doc.id) + '</span></span>'
            + (doc.dirty ? '<span class="dirty">unsaved</span>' : '')
            + '<span class="status">' + esc(doc.status) + '</span>'
            + '<span class="head-ops">'
            + '<button class="icon" data-op="open-yaml" title="Open the .process.yaml"><span class="codicon codicon-go-to-file"></span></button>'
            + '<button class="btn" data-op="revert"' + (doc.dirty ? '' : ' disabled') + '>Revert</button>'
            + '<button class="btn primary" data-op="save"' + (doc.dirty ? '' : ' disabled') + ' title="Save (Ctrl/Cmd+S)">Save</button>'
            + '</span></div>';
    }

    function errorsHtml() {
        if (!doc || !doc.errors.length) { return '<div id="errors"></div>'; }
        return '<div id="errors" class="errors"><div class="errors-title">' + doc.errors.length + ' problem(s) — fix them to save:</div><ul>'
            + doc.errors.map(function (e) { return '<li><code>' + esc(e.path || '(root)') + '</code> ' + esc(e.message) + '</li>'; }).join('')
            + '</ul></div>';
    }

    function updateHead() {
        var head = document.getElementById('head');
        if (head) { head.outerHTML = headHtml(); }
    }

    function updateErrors() {
        var el = document.getElementById('errors');
        if (el) { el.outerHTML = errorsHtml(); }
        document.querySelectorAll('.has-error').forEach(function (x) { x.classList.remove('has-error'); });
        (doc ? doc.errors : []).forEach(function (e) {
            var field = mainEl.querySelector('[data-path="' + String(e.path || '').replace(/\[(\d+)\]/g, '.$1') + '"]');
            if (field) { field.classList.add('has-error'); }
        });
    }

    function renderMain() {
        if (!doc) { mainEl.innerHTML = '<div class="muted">Select a process, or create one.</div>'; return; }
        if (!doc.def || typeof doc.def !== 'object') {
            mainEl.innerHTML = headHtml() + '<div class="errors">The YAML does not parse: ' + esc(doc.errors.map(function (e) { return e.message; }).join('; '))
                + '. Fix it in the file (button above), then select the process again.</div>';
            return;
        }
        var def = doc.def;
        if (!Array.isArray(def.phases)) { def.phases = []; }
        mainEl.innerHTML = headHtml()
            + errorsHtml()
            + '<div class="card-head top">' + '<label>Name ' + text('name', def.name, 'display name', 'name') + '</label>'
            + '<label class="grow">Summary ' + text('summary', def.summary, 'one line', 'summary') + '</label></div>'
            + '<div class="section-title">Description <span class="muted">(' + esc(doc.files ? doc.files.description.split(/[\\/]/).pop() : '') + ', Markdown)</span></div>'
            + '<textarea id="process-description" rows="8" placeholder="What this process is for and how it is worked through.">' + esc(doc.description) + '</textarea>'
            + '<div class="section-title">Phases <span class="muted">— each ends with a quality gate; an optional post-gate step holds the todos done before the next phase</span></div>'
            + def.phases.map(function (p, i) { return phaseCard(p, i, def.phases.length); }).join('')
            + '<button class="add" data-op="add-phase"><span class="codicon codicon-add"></span> phase</button>';
        updateErrors();
    }

    // ---- Operations ---------------------------------------------------------

    function op(name, pathText) {
        var path = pathText ? parsePath(pathText) : [];
        var def = doc && doc.def;
        if (!def) { return; }
        var node = getAt(path);
        switch (name) {
            case 'add-phase':
                def.phases.push({ id: freshId('phase' + (def.phases.length + 1), def.phases), name: '', steps: [{ id: 'step1' }], gate: { id: 'gate', name: 'Quality gate' } });
                break;
            case 'add-step':
                node.steps = node.steps || [];
                node.steps.push({ id: freshId('step' + (node.steps.length + 1), phaseNodes(node)) });
                break;
            case 'add-substep':
                node.substeps = node.substeps || [];
                node.substeps.push({ id: freshId('substep' + (node.substeps.length + 1), node.substeps) });
                break;
            case 'add-postgate':
                node.postGate = { id: freshId('post-gate', phaseNodes(node)), name: 'After the gate', todos: [{ title: '' }] };
                break;
            case 'remove-postgate':
                delete getAt(path.slice(0, -1)).postGate;
                break;
            case 'add-todo':
                node.todos = node.todos || [];
                node.todos.push({ title: '' });
                break;
            case 'remove': {
                var list = getAt(path.slice(0, -1));
                list.splice(path[path.length - 1], 1);
                // An empty sub-step or todo list is dropped: a step with sub-steps has at least one.
                var owner = getAt(path.slice(0, -2));
                var key = path[path.length - 2];
                if (list.length === 0 && (key === 'substeps' || key === 'todos') && owner) { delete owner[key]; }
                break;
            }
            case 'up':
            case 'down': {
                var arr = getAt(path.slice(0, -1));
                var i = path[path.length - 1];
                var j = name === 'up' ? i - 1 : i + 1;
                if (j < 0 || j >= arr.length) { return; }
                var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
                break;
            }
            default:
                return;
        }
        changed();
        renderMain();
    }

    function save() {
        if (!doc || !doc.dirty) { return; }
        var desc = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('process-description'));
        if (desc) { doc.description = desc.value; }
        doc.status = 'Saving…';
        updateHead();
        post({ type: 'save', definition: doc.def, description: doc.description });
    }

    // ---- Events ---------------------------------------------------------------

    function onField(e) {
        var t = /** @type {HTMLInputElement} */ (e.target);
        if (!doc || !t) { return; }
        if (t.id === 'process-description') { doc.description = t.value; changed(); return; }
        var p = t.dataset && t.dataset.path;
        if (!p) { return; }
        var kind = t.dataset.kind;
        var value = kind === 'bool' ? t.checked : kind === 'int' ? (t.value === '' ? '' : Number(t.value)) : t.value;
        var sessionAt = /^(.*)\.session\.(name|basedOn|mode)$/.exec(p);
        if (sessionAt) {
            // The session is an object of up to three fields; a name alone is
            // written as a plain string, nothing set removes it (inherit).
            var node = getAt(parsePath(sessionAt[1]));
            if (!node) { return; }
            var spec = typeof node.session === 'string' ? { name: node.session } : Object.assign({}, node.session || {});
            if (value === '') { delete spec[sessionAt[2]]; } else { spec[sessionAt[2]] = value; }
            if (!spec.name && !spec.basedOn && !spec.mode) { delete node.session; }
            else if (spec.name && !spec.basedOn && !spec.mode) { node.session = spec.name; }
            else { node.session = spec; }
            changed();
            return;
        }
        setAt(parsePath(p), value);
        // A phase title follows its name.
        var phase = t.closest('details.phase');
        if (phase && /^phases\.\d+\.name$/.test(p)) {
            var title = phase.querySelector('.phase-title');
            if (title) { title.textContent = 'Phase ' + (Number(phase.getAttribute('data-phase')) + 1) + (t.value ? ': ' + t.value : ''); }
        }
        changed();
    }

    mainEl.addEventListener('input', onField);
    mainEl.addEventListener('change', function (e) {
        var t = /** @type {HTMLElement} */ (e.target);
        if (t && (t.tagName === 'SELECT' || /** @type {HTMLInputElement} */ (t).type === 'checkbox')) { onField(e); }
    });
    mainEl.addEventListener('toggle', function (e) {
        var d = /** @type {HTMLDetailsElement} */ (e.target);
        if (d && d.classList && d.classList.contains('phase')) { folded[d.getAttribute('data-phase')] = !d.open; }
    }, true);
    mainEl.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement} */ (e.target);
        var btn = target && target.closest ? /** @type {HTMLButtonElement|null} */ (target.closest('button')) : null;
        if (!btn || btn.disabled || !btn.dataset.op) { return; }
        e.preventDefault();
        var name = btn.dataset.op;
        if (name === 'save') { save(); return; }
        if (name === 'revert') { post({ type: 'revert' }); return; }
        if (name === 'open-yaml') { post({ type: 'openYaml', id: doc && doc.id }); return; }
        op(name, btn.dataset.path || '');
    });
    listEl.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement} */ (e.target);
        var item = target && target.closest ? /** @type {HTMLElement|null} */ (target.closest('.item')) : null;
        if (!item || !item.dataset.id || (doc && item.dataset.id === doc.id)) { return; }
        post({ type: 'select', id: item.dataset.id, dirty: !!(doc && doc.dirty), definition: doc && doc.def, description: doc && doc.description });
    });
    /** @type {HTMLElement} */ (document.getElementById('btn-new')).addEventListener('click', function () { post({ type: 'create' }); });
    /** @type {HTMLElement} */ (document.getElementById('btn-copy')).addEventListener('click', function () { post({ type: 'copy', id: selected }); });
    document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    });

    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (!msg) { return; }
        switch (msg.type) {
            case 'list':
                processes = msg.processes;
                roles = msg.roles;
                currentProcess = msg.currentProcess;
                if (msg.selected && !doc) { selected = msg.selected; }
                renderList();
                break;
            case 'load':
                selected = msg.id;
                folded = {};
                doc = { id: msg.id, def: msg.definition ? JSON.parse(JSON.stringify(msg.definition)) : null, description: msg.description || '', errors: msg.errors || [], files: msg.files, dirty: false, status: '' };
                renderList();
                renderMain();
                break;
            case 'selectCancelled':
                renderList();
                break;
            case 'validation':
                if (doc) { doc.errors = msg.errors || []; updateErrors(); }
                break;
            case 'saved':
                if (!doc) { break; }
                if (msg.ok) {
                    doc.dirty = false;
                    doc.status = 'Saved.';
                } else {
                    doc.status = 'Not saved.';
                    post({ type: 'validate', definition: doc.def });
                }
                updateHead();
                break;
        }
    });

    post({ type: 'ready' });
})();
