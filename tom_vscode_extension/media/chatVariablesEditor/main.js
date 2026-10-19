// @ts-nocheck
// Chat Variables Editor webview script — extracted verbatim from the inline
// <script> of getHtml() in src/handlers/chatVariablesEditor-handler.ts (Phase
// B.12 webview restructuring). Wrapped in an IIFE so its top-level vars stay
// off the global scope; loaded under the loader's default nonce-only CSP (no
// inline on*= handlers — every listener is attached via addEventListener).
(function () {
var vscode = acquireVsCodeApi();
var stateData = {};

// ── Render variable table ──
function renderTable(s) {
    stateData = s;
    var body = document.getElementById('var-body');
    var rows = '';

    // Built-in variables
    rows += varRow('quest', s.quest || '', false);
    // role: dropdown populated from available roles
    var roleOptions = '<option value="">(None)</option>' + (s.roles || []).map(function(r) {
        return '<option value="' + esc(r) + '"' + (r === (s.role || '') ? ' selected' : '') + '>' + esc(r) + '</option>';
    }).join('');
    rows += '<tr><td class="var-name">role</td>' +
        '<td class="var-value"><select data-var="role" style="width:100%;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);color:var(--vscode-dropdown-foreground);border-radius:3px;padding:3px 6px;font-size:12px;font-family:inherit;">' + roleOptions + '</select></td>' +
        '<td class="var-actions"></td></tr>';
    // activeProjects: special row with Select... button
    var apVal = JSON.stringify(s.activeProjects || []);
    rows += '<tr><td class="var-name">activeProjects</td>' +
        '<td class="var-value"><input data-var="activeProjects" value="' + esc(apVal) + '"></td>' +
        '<td class="var-actions"><button class="select-btn" id="btn-pick-projects" title="Select projects">Select…</button></td></tr>';
    rows += varRow('todo', s.todo || '', false);
    rows += varRow('todoFile', s.todoFile || '', false);

    // Custom variables
    var custom = s.custom || {};
    Object.keys(custom).sort().forEach(function(k) {
        rows += varRow('custom.' + k, custom[k] || '', true, k);
    });

    // The active quest's process (read-only: set in the PROCESS view or by tomAi_setProcessState)
    var proc = s.process || {};
    var procKeys = ['process', 'phase', 'step', 'substep', 'phase-iteration', 'step-iteration', 'substep-iteration',
        'process-description', 'phase-description', 'step-description', 'substep-description',
        'phase-prompt', 'step-prompt', 'substep-prompt'];
    rows += '<tr><td colspan="3" class="var-section">Process <span class="var-note">(read-only — the quest\'s position, set in the PROCESS view)</span></td></tr>';
    procKeys.forEach(function(k) { rows += readonlyRow(k, proc[k] || ''); });

    // New variable input row (hidden by default)
    rows += '<tr class="new-row" id="new-row"><td><input id="new-key" placeholder="key.name"></td><td><input id="new-value" placeholder="value"></td><td class="var-actions"><button class="confirm-btn" id="btn-confirm-add">✓</button></td></tr>';

    body.innerHTML = rows;
    attachInputListeners();
}

/** A value shown but not edited here; long text shortened, the whole of it in a scrollable popup on hover. */
function readonlyRow(name, value) {
    var text = String(value).trim();
    var shortened = text.length > 120;
    var shown = !text ? '—' : shortened ? text.slice(0, 120).replace(/\s+\S*$/, '') + '…' : text;
    return '<tr><td class="var-name">' + esc(name) + '</td>' +
        '<td class="var-value"><span class="var-readonly' + (shortened ? ' var-more' : '') + '"' + (shortened ? ' data-full="' + esc(text) + '"' : '') + '>' + esc(shown) + '</span></td>' +
        '<td class="var-actions"></td></tr>';
}

// ── Popup with the whole of a shortened value ──
// A native tooltip cannot be scrolled and closes as soon as the pointer
// leaves the text; this one has its own scrollbar and stays open while the
// pointer is on the value or on the popup (a short grace lets it cross).
var popup = document.createElement('div');
popup.className = 'var-popup';
document.body.appendChild(popup);
var popupFor = null;
var showTimer = null;
var hideTimer = null;

function showPopup(el) {
    popupFor = el;
    popup.textContent = el.getAttribute('data-full');
    popup.classList.add('visible');
    popup.scrollTop = 0;
    var r = el.getBoundingClientRect();
    var w = Math.min(560, window.innerWidth - 16);
    popup.style.width = w + 'px';
    popup.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    var below = window.innerHeight - r.bottom;
    if (below >= 160 || below >= r.top) {
        popup.style.top = (r.bottom + 4) + 'px';
        popup.style.maxHeight = Math.max(120, below - 12) + 'px';
    } else {
        popup.style.top = '';
        popup.style.bottom = (window.innerHeight - r.top + 4) + 'px';
        popup.style.maxHeight = Math.max(120, r.top - 12) + 'px';
    }
}

function hidePopup() {
    popup.classList.remove('visible');
    popup.style.bottom = '';
    popupFor = null;
}

document.addEventListener('mouseover', function(e) {
    var t = e.target;
    if (popup.contains(t)) { clearTimeout(hideTimer); return; }
    var el = t && t.closest ? t.closest('.var-more') : null;
    if (!el) { return; }
    clearTimeout(hideTimer);
    if (popupFor === el) { return; }
    clearTimeout(showTimer);
    showTimer = setTimeout(function() { showPopup(el); }, 200);
});
document.addEventListener('mouseout', function(e) {
    var from = e.target;
    var onValue = from && from.closest && from.closest('.var-more');
    if (!onValue && !popup.contains(from)) { return; }
    var to = e.relatedTarget;
    if (to && (popup.contains(to) || (popupFor && popupFor.contains(to)))) { return; }
    clearTimeout(showTimer);
    hideTimer = setTimeout(hidePopup, 300);
});


function varRow(name, value, deletable, label) {
    var escapedValue = esc(value);
    var deleteBtn = deletable ? '<button class="delete-btn" data-delete="' + esc(name.replace('custom.', '')) + '" title="Delete">🗑️</button>' : '';
    return '<tr>' +
    '<td class="var-name">' + esc(label || name) + '</td>' +
        '<td class="var-value"><input data-var="' + esc(name) + '" value="' + escapedValue + '"></td>' +
        '<td class="var-actions">' + deleteBtn + '</td></tr>';
}

function attachInputListeners() {
    document.querySelectorAll('[data-var]').forEach(function(el) {
        el.addEventListener('change', function() {
            var name = el.dataset.var;
            var val = el.value;
            if (name === 'quest') vscode.postMessage({ type: 'setQuest', value: val });
            else if (name === 'role') vscode.postMessage({ type: 'setRole', value: val });
            else if (name === 'activeProjects') {
                try { vscode.postMessage({ type: 'setActiveProjects', value: JSON.parse(val) }); } catch {}
            }
            else if (name === 'todo') vscode.postMessage({ type: 'setTodo', value: val });
            else if (name === 'todoFile') vscode.postMessage({ type: 'setTodoFile', value: val });
            else if (name.startsWith('custom.')) vscode.postMessage({ type: 'setCustom', key: name.replace('custom.', ''), value: val });
        });
    });

    document.querySelectorAll('[data-delete]').forEach(function(el) {
        el.addEventListener('click', function() {
            vscode.postMessage({ type: 'deleteCustom', key: el.dataset.delete });
        });
    });

    var confirmBtn = document.getElementById('btn-confirm-add');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', function() {
            var key = document.getElementById('new-key').value.trim();
            var val = document.getElementById('new-value').value;
            if (!key) return;
            key = key.replace(/[^a-z0-9._]/g, '');
            if (!key) return;
            vscode.postMessage({ type: 'setCustom', key: key, value: val });
            document.getElementById('new-row').classList.remove('visible');
        });
    }

    var pickBtn = document.getElementById('btn-pick-projects');
    if (pickBtn) {
        pickBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'pickProjects' });
        });
    }
}

// ── Render change log ──
function renderLog(entries) {
    var list = document.getElementById('log-list');
    if (!entries || !entries.length) { list.innerHTML = '<div style="color:var(--vscode-descriptionForeground)">No changes yet</div>'; return; }

    // Group consecutive entries with the same requestId into a single line
    var reversed = entries.slice().reverse();
    var grouped = [];
    var i = 0;
    while (i < reversed.length) {
        var e = reversed[i];
        if (e.requestId) {
            // Collect all entries with the same requestId that are adjacent
            var batch = [e];
            var j = i + 1;
            while (j < reversed.length && reversed[j].requestId === e.requestId) {
                batch.push(reversed[j]);
                j++;
            }
            grouped.push({ type: 'batch', requestId: e.requestId, timestamp: e.timestamp, source: e.source, items: batch });
            i = j;
        } else {
            grouped.push({ type: 'single', entry: e });
            i++;
        }
    }

    list.innerHTML = grouped.map(function(g) {
        if (g.type === 'batch') {
            var time = g.timestamp ? new Date(g.timestamp).toLocaleTimeString([], { hour12: false }) : '';
            var reqShort = g.requestId.length > 16 ? g.requestId.substring(0, 8) + '..' + g.requestId.substring(g.requestId.length - 4) : g.requestId;
            var pairs = g.items.map(function(e) { return esc(e.key) + '=' + esc(String(e.newValue != null ? e.newValue : '').substring(0, 40)); }).join(' ');
            return '<div class="log-entry"><span class="log-time">' + esc(time) + '</span>' +
                '<span class="log-var" title="' + esc(g.requestId) + '">' + esc(reqShort) + '</span> ' + pairs +
                '<span class="log-source"> (' + esc(g.source) + ')</span></div>';
        } else {
            var e = g.entry;
            var time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour12: false }) : '';
            return '<div class="log-entry"><span class="log-time">' + esc(time) + '</span>' +
                '<span class="log-var">' + esc(e.key) + '</span> = "' + esc(String(e.newValue != null ? e.newValue : '').substring(0, 60)) + '"' +
                '<span class="log-source"> (' + esc(e.source) + ')</span></div>';
        }
    }).join('');
}

// ── Add button ──
document.getElementById('btn-add').addEventListener('click', function() {
    var row = document.getElementById('new-row');
    if (row) { row.classList.toggle('visible'); }
});

// ── Show file button ──
document.getElementById('btn-file').addEventListener('click', function() {
    vscode.postMessage({ type: 'showFile' });
});

// ── Message listener ──
window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'state') {
        renderTable(msg);
        renderLog(msg.changeLog);
    }
});

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Initial request
vscode.postMessage({ type: 'getState' });
})();
