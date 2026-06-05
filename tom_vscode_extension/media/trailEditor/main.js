// @ts-nocheck
/* global acquireVsCodeApi, marked */
// Trail (Summary) viewer custom-editor client — extracted from the two inline
// <script> IIFEs of buildHtml() in src/handlers/trailEditor-handler.ts
// (Phase B.23 webview restructuring).
//
// Both IIFEs are concatenated here verbatim, in their original order:
//   1. PRIMARY renderer — acquires the vscode API (once), reads the four
//      <script type="application/json"> data blocks, renders the quest /
//      subsystem dropdowns, entry list, preview and metadata, and wires the
//      splitters / toolbar / message handler. On success it sets
//      window.__trailPrimaryActive = true.
//   2. FALLBACK renderer — guarded by window.__trailPrimaryActive and
//      window.__trailSwitchFallbackInit; returns early when the primary script
//      is active, so it only renders if the primary IIFE threw before marking
//      itself active. (In the original template-literal form a stray newline in
//      one regex made this block fail to parse and silently die; merged into a
//      single real .js file that whole-file parse can no longer be tolerated, so
//      the regex is written as the intended `\n` escape — behaviour is unchanged
//      on the common path because the guard still short-circuits it.)
//
// The data flows in via the JSON <script> blocks (first paint) and live
// `updateEntries` postMessages (quest switch / fs.watch refresh).

(function() {
    function readJsonData(scriptId, fallback) {
        try {
            var el = document.getElementById(scriptId);
            if (!el) { return fallback; }
            var raw = el.textContent || '';
            if (!raw) { return fallback; }
            return JSON.parse(raw);
        } catch (_err) {
            return fallback;
        }
    }

    let vscode;
    try {
    vscode = (window.__trailVscodeApi) || acquireVsCodeApi();
    window.__trailVscodeApi = vscode;
    vscode.postMessage({ type: 'clientReady', quest: 'primary-script', entries: -1 });

    let allEntries = readJsonData('trail-data-entries', []);
    let entriesBySet = readJsonData('trail-data-entries-by-set', {});
    let currentQuest = readJsonData('trail-data-current-set', 'unknown');
    let trailSets = readJsonData('trail-data-sets', {});
    let selectedIndex = -1;
    if (!entriesBySet || typeof entriesBySet !== 'object') {
        entriesBySet = {};
    }
    if (!entriesBySet[currentQuest]) {
        entriesBySet[currentQuest] = allEntries;
    }

    // ---- Quest/subsystem dropdowns ----
    const questSelect = document.getElementById('quest-select');
    const subsystemSelect = document.getElementById('subsystem-select');

    function normalizeSetName(setName, fallbackName) {
        var value = (setName || '').trim();
        if (value.length > 0) {
            return value;
        }
        var fallback = (fallbackName || currentQuest || 'unknown').trim();
        return fallback.length > 0 ? fallback : 'unknown';
    }

    function splitSetName(setName) {
        var normalized = normalizeSetName(setName, 'unknown');
        var idx = normalized.lastIndexOf('.');
        if (idx < 0) {
            return { quest: normalized, subsystem: 'unknown' };
        }
        return {
            quest: normalized.substring(0, idx) || normalized,
            subsystem: normalized.substring(idx + 1) || 'unknown'
        };
    }

    function ensureTrailSets(sets, selectedSetName) {
        if (sets && Object.keys(sets).length > 0) {
            return sets;
        }
        var fallbackName = normalizeSetName(selectedSetName, currentQuest || 'unknown');
        var fallback = {};
        fallback[fallbackName] = {};
        return fallback;
    }

    function buildQuestSubsystemIndex(sets) {
        var names = Object.keys(sets || {});
        var idx = {};
        for (var i = 0; i < names.length; i++) {
            var setName = normalizeSetName(names[i], currentQuest || 'unknown');
            var parsed = splitSetName(setName);
            if (!idx[parsed.quest]) {
                idx[parsed.quest] = [];
            }
            idx[parsed.quest].push({ subsystem: parsed.subsystem, setName: setName });
        }
        var quests = Object.keys(idx);
        function subsystemRank(name) {
            if (name === 'unknown') return 0;
            if (name === 'copilot') return 2;
            return 1;
        }
        for (var q = 0; q < quests.length; q++) {
            idx[quests[q]].sort(function(a, b) {
                var rankCmp = subsystemRank(a.subsystem) - subsystemRank(b.subsystem);
                if (rankCmp !== 0) {
                    return rankCmp;
                }
                return a.subsystem.localeCompare(b.subsystem);
            });
        }
        return idx;
    }

    function resolveSelection(sets, selectedSetName) {
        var names = Object.keys(sets || {}).map(function(n) { return normalizeSetName(n, selectedSetName || currentQuest || 'unknown'); }).sort();
        if (names.length === 0) {
            return { quest: '', subsystem: '', setName: '' };
        }
        var chosen = selectedSetName && sets[selectedSetName] ? selectedSetName : names[0];
        chosen = normalizeSetName(chosen, names[0]);
        var parsed = splitSetName(chosen);
        return { quest: parsed.quest, subsystem: parsed.subsystem, setName: chosen };
    }

    function populateSelectors(sets, selectedSetName) {
        sets = ensureTrailSets(sets, selectedSetName);
        trailSets = sets;
        var selection = resolveSelection(sets, selectedSetName);
        var index = buildQuestSubsystemIndex(sets);

        questSelect.innerHTML = '';
        var questNames = Object.keys(index).sort();
        if (questNames.length === 0) {
            var parsedFallback = splitSetName(selection.setName || currentQuest || 'unknown');
            var fallbackQuest = parsedFallback.quest || 'unknown';
            var fallbackSubsystem = parsedFallback.subsystem || 'unknown';
            index[fallbackQuest] = [{ subsystem: fallbackSubsystem, setName: normalizeSetName(selection.setName, fallbackQuest + '.' + fallbackSubsystem) }];
            questNames = [fallbackQuest];
        }
        for (var i = 0; i < questNames.length; i++) {
            var opt = document.createElement('option');
            opt.value = questNames[i];
            opt.textContent = questNames[i];
            if (questNames[i] === selection.quest) { opt.selected = true; }
            questSelect.appendChild(opt);
        }

        subsystemSelect.innerHTML = '';
        var selectedQuest = selection.quest || questNames[0] || 'unknown';
        var subs = index[selectedQuest] || [];
        if (subs.length === 0) {
            subs = [{ subsystem: 'unknown', setName: normalizeSetName(selection.setName, selectedQuest + '.unknown') }];
        }
        for (var s = 0; s < subs.length; s++) {
            var subOpt = document.createElement('option');
            subOpt.value = subs[s].setName;
            subOpt.textContent = subs[s].subsystem;
            if (subs[s].setName === selection.setName) { subOpt.selected = true; }
            subsystemSelect.appendChild(subOpt);
        }

        currentQuest = normalizeSetName(selection.setName, subs[0].setName);
        if (!subsystemSelect.value || subsystemSelect.value !== currentQuest) {
            subsystemSelect.value = currentQuest;
        }
    }

    populateSelectors(trailSets, currentQuest);

    function applyCurrentSetEntries() {
        allEntries = entriesBySet[currentQuest] || [];
        renderEntryList();
        if (allEntries.length > 0) {
            selectEntry(0);
        } else {
            selectedIndex = -1;
            previewPanel.innerHTML = '<div class="empty-state">Select a prompt or answer to preview</div>';
            metaPanel.innerHTML = '<div class="meta-title">Metadata</div><div class="empty-state" style="height:auto;padding:12px 0;">No entry selected</div>';
        }
    }

    questSelect.addEventListener('change', function() {
        var index = buildQuestSubsystemIndex(trailSets);
        var subs = index[questSelect.value] || [];
        if (subs.length === 0) {
            return;
        }

        var preferredIdx = 0;
        for (var si = 0; si < subs.length; si++) {
            if (subs[si].subsystem === 'unknown') {
                preferredIdx = si;
                break;
            }
        }

        subsystemSelect.innerHTML = '';
        for (var s = 0; s < subs.length; s++) {
            var subOpt = document.createElement('option');
            subOpt.value = subs[s].setName;
            subOpt.textContent = subs[s].subsystem;
            subsystemSelect.appendChild(subOpt);
        }

        currentQuest = subs[preferredIdx].setName;
        subsystemSelect.value = currentQuest;
        selectedIndex = -1;
        applyCurrentSetEntries();
    });

    subsystemSelect.addEventListener('change', function() {
        currentQuest = subsystemSelect.value;
        selectedIndex = -1;
        applyCurrentSetEntries();
    });

    // ---- Entry list ----
    var entryListEl = document.getElementById('entry-list');

    function extractTodoRefsFromVars(vars) {
        if (!vars) return [];
        var refs = [];
        var lines = vars.split('\n');
        for (var k = 0; k < lines.length; k++) {
            var line = lines[k].replace(/^\s*-\s*/, '').trim();
            // Match <KEY-with-TODO>=<value> — key must contain uppercase TODO
            var eqIdx = line.indexOf('=');
            if (eqIdx < 1) continue;
            var key = line.substring(0, eqIdx);
            if (key.indexOf('TODO') === -1) continue;
            var val = line.substring(eqIdx + 1).trim();
            if (val) refs.push(val);
        }
        return refs;
    }

    function formatTodoDisplay(todoPath) {
        var parts = todoPath.split('/');
        if (parts.length < 2) return todoPath;
        var todoId = parts[parts.length - 1];
        var todoFile = parts[parts.length - 2];
        return todoId + '@' + todoFile;
    }

    function formatTimestamp(ts) {
        // ts is ISO format like 2026-02-22T01:38:28.288Z or compact like 2026-02-22T01:38:28
        try {
            var d = new Date(ts);
            if (isNaN(d.getTime())) { return ts; }
            var yy = String(d.getFullYear()).slice(2);
            var mo = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            var hh = String(d.getHours()).padStart(2, '0');
            var mm = String(d.getMinutes()).padStart(2, '0');
            var ss = String(d.getSeconds()).padStart(2, '0');
            return yy + mo + dd + '-' + hh + mm + ss;
        } catch(e) { return ts; }
    }

    function renderEntryList() {
        entryListEl.innerHTML = '';
        for (var i = 0; i < allEntries.length; i++) {
            var e = allEntries[i];
            var div = document.createElement('div');
            div.className = 'entry-item entry-type-' + e.type.toLowerCase();
            if (i === selectedIndex) { div.classList.add('selected'); }
            div.setAttribute('data-index', String(i));

            var ts = formatTimestamp(e.timestamp);
            var label = ts + '-' + e.type + '-' + e.requestId.substring(0, 8);

            var labelDiv = document.createElement('div');
            labelDiv.className = 'entry-label';
            labelDiv.textContent = label;
            div.appendChild(labelDiv);

            var previewDiv = document.createElement('div');
            previewDiv.className = 'entry-preview';
            previewDiv.textContent = (e.content || '').substring(0, 100).replace(/\n/g, ' ');
            div.appendChild(previewDiv);

            if (e.type === 'ANSWER' && e.variables) {
                var todoRefs = extractTodoRefsFromVars(e.variables);
                if (todoRefs.length > 0) {
                    var todoLinksDiv = document.createElement('div');
                    todoLinksDiv.className = 'entry-todo-links';
                    for (var t = 0; t < todoRefs.length; t++) {
                        var link = document.createElement('a');
                        link.className = 'entry-todo-link';
                        link.textContent = formatTodoDisplay(todoRefs[t]);
                        link.setAttribute('data-todopath', todoRefs[t]);
                        link.addEventListener('click', (function(ref) {
                            return function(ev) {
                                ev.stopPropagation();
                                ev.preventDefault();
                                var segs = ref.split('/');
                                var tid = segs.length >= 2 ? segs[segs.length - 1] : ref;
                                var tpath = segs.length >= 2 ? segs.slice(0, segs.length - 1).join('/') : '';
                                vscode.postMessage({ type: 'gotoTodo', todoId: tid, todoPath: tpath });
                            };
                        })(todoRefs[t]));
                        todoLinksDiv.appendChild(link);
                    }
                    div.appendChild(todoLinksDiv);
                }
            }

            div.addEventListener('click', (function(idx) { return function() { selectEntry(idx); }; })(i));
            entryListEl.appendChild(div);
        }
    }

    function selectEntry(idx) {
        selectedIndex = idx;
        // Update selection highlight
        var items = entryListEl.querySelectorAll('.entry-item');
        for (var j = 0; j < items.length; j++) {
            items[j].classList.toggle('selected', j === idx);
        }
        // Update preview and metadata
        var entry = allEntries[idx];
        if (!entry) { return; }
        renderPreview(entry);
        renderMeta(entry);
    }

    // ---- Preview ----
    var previewPanel = document.getElementById('preview-panel');

    function renderPreview(entry) {
        var md = entry.content || '';
        var html;
        if (typeof marked !== 'undefined' && marked.parse) {
            try { html = marked.parse(md); } catch(e) { html = '<pre>' + escapeHtml(md) + '</pre>'; }
        } else {
            html = '<pre>' + escapeHtml(md) + '</pre>';
        }
        previewPanel.innerHTML = '<div class="markdown-body">' + html + '</div>';
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- Metadata ----
    var metaPanel = document.getElementById('meta-panel');

    function renderMeta(entry) {
        var html = '<div class="meta-title">' + entry.type + ' Metadata</div>';
        html += metaRow('Request ID', entry.requestId);
        html += metaRow('Timestamp', entry.rawTimestamp);
        html += metaRow('Sequence', String(entry.sequence));

        if (entry.type === 'PROMPT') {
            html += metaRow('Template', entry.templateName || '(none)');
            html += metaRow('Answer Wrapper', entry.answerWrapper || '(none)');
        } else {
            if (entry.comments) { html += metaRow('Comment', entry.comments); }
            if (entry.variables) { html += metaVariablesRow('Chat Values', entry.variables); }
            if (entry.references && entry.references.length) {
                html += '<div class="meta-row"><div class="meta-key">References</div><div class="meta-value"><ul class="meta-list">';
                for (var i = 0; i < entry.references.length; i++) {
                    html += '<li>' + escapeHtml(entry.references[i]) + '</li>';
                }
                html += '</ul></div></div>';
            }
            if (entry.attachments && entry.attachments.length) {
                html += '<div class="meta-row"><div class="meta-key">Attachments</div><div class="meta-value"><ul class="meta-list">';
                for (var i = 0; i < entry.attachments.length; i++) {
                    html += '<li>' + escapeHtml(entry.attachments[i]) + '</li>';
                }
                html += '</ul></div></div>';
            }
        }

        metaPanel.innerHTML = html;
    }

    function metaRow(key, value) {
        return '<div class="meta-row"><div class="meta-key">' + escapeHtml(key) + '</div><div class="meta-value">' + escapeHtml(value || '') + '</div></div>';
    }

    function parseVariablePairs(value) {
        if (!value) return [];
        var pairs = [];
        var lines = value.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            // Strip leading YAML list marker '- '
            if (line.indexOf('- ') === 0) { line = line.substring(2).trim(); }
            if (!line) continue;
            var eqIdx = line.indexOf('=');
            if (eqIdx > 0) {
                pairs.push({ key: line.substring(0, eqIdx).trim(), val: line.substring(eqIdx + 1).trim() });
            } else {
                pairs.push({ key: line, val: '' });
            }
        }
        return pairs;
    }

    function metaVariablesRow(key, value) {
        var pairs = parseVariablePairs(value);
        if (pairs.length === 0) return metaRow(key, value || '');
        var html = '<div class="meta-row"><div class="meta-key">' + escapeHtml(key) + '</div><div class="meta-value"><ul class="meta-list">';
        for (var i = 0; i < pairs.length; i++) {
            var k = escapeHtml(pairs[i].key);
            var v = escapeHtml(pairs[i].val);
            if (pairs[i].key === 'TODO' && pairs[i].val) {
                // Extract todo ID from path: last segment after /
                var todoPath = pairs[i].val;
                var slashIdx = todoPath.lastIndexOf('/');
                var todoId = slashIdx >= 0 ? todoPath.substring(slashIdx + 1) : todoPath;
                html += '<li>' + k + ' = <a class="todo-value-link" data-todo-id="' + escapeHtml(todoId) + '" data-todo-path="' + v + '" href="#">' + v + '</a></li>';
            } else {
                html += '<li>' + k + ' = ' + v + '</li>';
            }
        }
        html += '</ul></div></div>';
        return html;
    }

    // ---- TODO link click handler ----
    metaPanel.addEventListener('click', function(e) {
        var target = e.target;
        if (target.classList && target.classList.contains('todo-value-link')) {
            e.preventDefault();
            var todoId = target.getAttribute('data-todo-id');
            var todoPath = target.getAttribute('data-todo-path');
            if (todoId) {
                vscode.postMessage({ type: 'gotoTodo', todoId: todoId, todoPath: todoPath || '' });
            }
        }
    });

    // ---- Splitter logic ----
    var sidebar = document.getElementById('sidebar');
    var vSplitter = document.getElementById('v-splitter');
    var hSplitter = document.getElementById('h-splitter');
    var rightPanels = document.getElementById('right-panels');

    // Vertical splitter (left column width)
    var vDragging = false;
    vSplitter.addEventListener('mousedown', function(e) {
        vDragging = true;
        vSplitter.classList.add('dragging');
        e.preventDefault();
    });

    // Horizontal splitter (meta panel height)
    var hDragging = false;
    hSplitter.addEventListener('mousedown', function(e) {
        hDragging = true;
        hSplitter.classList.add('dragging');
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (vDragging) {
            var newWidth = Math.max(200, Math.min(e.clientX, window.innerWidth - 300));
            sidebar.style.width = newWidth + 'px';
            document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px');
        }
        if (hDragging) {
            var rpRect = rightPanels.getBoundingClientRect();
            var newMetaHeight = Math.max(80, Math.min(rpRect.bottom - e.clientY, rpRect.height - 100));
            metaPanel.style.height = newMetaHeight + 'px';
            document.documentElement.style.setProperty('--meta-height', newMetaHeight + 'px');
        }
    });

    document.addEventListener('mouseup', function() {
        if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
        if (hDragging) { hDragging = false; hSplitter.classList.remove('dragging'); }
    });

    // ---- Toolbar buttons ----
    document.getElementById('btn-open-prompts').addEventListener('click', function() {
        vscode.postMessage({ type: 'openInEditor', quest: currentQuest, fileType: 'prompts' });
    });
    document.getElementById('btn-open-answers').addEventListener('click', function() {
        vscode.postMessage({ type: 'openInEditor', quest: currentQuest, fileType: 'answers' });
    });
    document.getElementById('btn-md-viewer').addEventListener('click', function() {
        vscode.postMessage({ type: 'openInMdViewer', quest: currentQuest, fileType: 'prompts' });
    });

    // ---- Message handler ----
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'updateEntries') {
            if (msg.entriesBySet && typeof msg.entriesBySet === 'object') {
                entriesBySet = msg.entriesBySet;
            }
            if (msg.quest) { currentQuest = msg.quest; }
            if (msg.trailSets) {
                trailSets = msg.trailSets;
            }
            if (!entriesBySet[currentQuest]) {
                entriesBySet[currentQuest] = msg.entries || [];
            }
            populateSelectors(trailSets, currentQuest);
            applyCurrentSetEntries();
        } else if (msg.type === 'focusEntry') {
            var targetId = msg.requestId || '';
            if (targetId) {
                for (var fi = 0; fi < allEntries.length; fi++) {
                    if (allEntries[fi].requestId === targetId) {
                        selectEntry(fi);
                        var items = entryListEl.querySelectorAll('.entry-item');
                        if (items[fi]) { items[fi].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
                        break;
                    }
                }
            }
        }
    });

    // ---- Initial render ----
    window.__trailPrimaryActive = true;
    renderEntryList();
    if (allEntries.length > 0) {
        selectEntry(0);
    }
    vscode.postMessage({ type: 'clientReady', quest: currentQuest, entries: allEntries.length });
    } catch (error) {
        try {
            if (vscode && typeof vscode.postMessage === 'function') {
                vscode.postMessage({
                    type: 'clientError',
                    where: 'trailEditor:init',
                    error: (error && error.message) ? error.message : String(error),
                    stack: (error && error.stack) ? error.stack : '',
                });
            }
        } catch (_ignored) {
            // no-op
        }
    }
})();

(function() {
        function readJsonData(scriptId, fallback) {
            try {
                var el = document.getElementById(scriptId);
                if (!el) { return fallback; }
                var raw = el.textContent || '';
                if (!raw) { return fallback; }
                return JSON.parse(raw);
            } catch (_err) {
                return fallback;
            }
        }

    if (window.__trailPrimaryActive) {
        return;
    }

    if (window.__trailSwitchFallbackInit) {
        return;
    }
    window.__trailSwitchFallbackInit = true;

    var vscodeApi = null;
    try {
        if (window.__trailVscodeApi && typeof window.__trailVscodeApi.postMessage === 'function') {
            vscodeApi = window.__trailVscodeApi;
        } else if (typeof acquireVsCodeApi === 'function') {
            vscodeApi = acquireVsCodeApi();
            window.__trailVscodeApi = vscodeApi;
        }
        if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
            vscodeApi.postMessage({ type: 'clientReady', quest: 'fallback-script', entries: -1 });
        }
    } catch (_e) {
        vscodeApi = null;
    }

    if (!vscodeApi || typeof vscodeApi.postMessage !== 'function') {
        return;
    }

    var questSelect = document.getElementById('quest-select');
    var subsystemSelect = document.getElementById('subsystem-select');
    var entryListEl = document.getElementById('entry-list');
    var previewPanel = document.getElementById('preview-panel');
    var metaPanel = document.getElementById('meta-panel');
    if (!questSelect || !subsystemSelect || !entryListEl || !previewPanel || !metaPanel) {
        return;
    }

    var trailSets = readJsonData('trail-data-sets', {});
    var currentSet = readJsonData('trail-data-current-set', 'unknown');
    var allEntries = readJsonData('trail-data-entries', []);
    var selectedIndex = -1;

    function normalizeSetName(value) {
        var v = (value || '').trim();
        return v || 'unknown';
    }

    function splitSetName(setName) {
        var normalized = normalizeSetName(setName);
        var idx = normalized.lastIndexOf('.');
        if (idx < 0) {
            return { quest: normalized, subsystem: 'unknown' };
        }
        return {
            quest: normalized.substring(0, idx) || normalized,
            subsystem: normalized.substring(idx + 1) || 'unknown',
        };
    }

    function listQuestNames() {
        var names = Object.keys(trailSets || {});
        var quests = {};
        for (var i = 0; i < names.length; i++) {
            quests[splitSetName(names[i]).quest] = true;
        }
        return Object.keys(quests).sort();
    }

    function getSetsForQuest(questName) {
        var names = Object.keys(trailSets || {});
        var out = [];
        for (var i = 0; i < names.length; i++) {
            var parsed = splitSetName(names[i]);
            if (parsed.quest === questName) {
                out.push({ setName: names[i], subsystem: parsed.subsystem });
            }
        }
        out.sort(function(a, b) {
            function rank(name) {
                if (name === 'unknown') return 0;
                if (name === 'copilot') return 2;
                return 1;
            }
            var rankCmp = rank(a.subsystem) - rank(b.subsystem);
            if (rankCmp !== 0) return rankCmp;
            return a.subsystem.localeCompare(b.subsystem);
        });
        return out;
    }

    function populateQuestDropdown(selectedQuest) {
        var quests = listQuestNames();
        var preferred = selectedQuest;
        if (!preferred || quests.indexOf(preferred) < 0) {
            preferred = quests.length > 0 ? quests[0] : 'unknown';
        }
        questSelect.innerHTML = '';
        for (var i = 0; i < quests.length; i++) {
            var opt = document.createElement('option');
            opt.value = quests[i];
            opt.textContent = quests[i];
            if (quests[i] === preferred) {
                opt.selected = true;
            }
            questSelect.appendChild(opt);
        }
        return preferred;
    }

    function populateSubsystemDropdown(questName, preferredSetName) {
        var subs = getSetsForQuest(questName);
        subsystemSelect.innerHTML = '';
        for (var i = 0; i < subs.length; i++) {
            var opt = document.createElement('option');
            opt.value = subs[i].setName;
            opt.textContent = subs[i].subsystem;
            subsystemSelect.appendChild(opt);
        }
        if (subs.length === 0) {
            currentSet = 'unknown';
            return currentSet;
        }
        var next = subs[0].setName;
        if (preferredSetName) {
            for (var j = 0; j < subs.length; j++) {
                if (subs[j].setName === preferredSetName) {
                    next = subs[j].setName;
                    break;
                }
            }
        }
        subsystemSelect.value = next;
        currentSet = next;
        return next;
    }

    function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function formatTs(ts) {
        var d = new Date(ts);
        if (isNaN(d.getTime())) {
            return String(ts || '');
        }
        var yy = String(d.getFullYear()).slice(2);
        var mo = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        return yy + mo + dd + '-' + hh + mm + ss;
    }

    function renderMeta(entry) {
        var html = '<div class="meta-title">' + escapeHtml(entry.type) + ' Metadata</div>';
        html += '<div class="meta-row"><div class="meta-key">Request ID</div><div class="meta-value">' + escapeHtml(entry.requestId) + '</div></div>';
        html += '<div class="meta-row"><div class="meta-key">Timestamp</div><div class="meta-value">' + escapeHtml(entry.rawTimestamp) + '</div></div>';
        html += '<div class="meta-row"><div class="meta-key">Sequence</div><div class="meta-value">' + escapeHtml(String(entry.sequence)) + '</div></div>';
        if (entry.type === 'PROMPT') {
            html += '<div class="meta-row"><div class="meta-key">Template</div><div class="meta-value">' + escapeHtml(entry.templateName || '(none)') + '</div></div>';
            html += '<div class="meta-row"><div class="meta-key">Answer Wrapper</div><div class="meta-value">' + escapeHtml(entry.answerWrapper || '(none)') + '</div></div>';
        }
        metaPanel.innerHTML = html;
    }

    function selectEntry(idx) {
        selectedIndex = idx;
        var items = entryListEl.querySelectorAll('.entry-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('selected', i === idx);
        }
        var entry = allEntries[idx];
        if (!entry) {
            return;
        }
        previewPanel.innerHTML = '<div class="markdown-body"><pre>' + escapeHtml(entry.content || '') + '</pre></div>';
        renderMeta(entry);
    }

    function renderEntries() {
        entryListEl.innerHTML = '';
        for (var i = 0; i < allEntries.length; i++) {
            var e = allEntries[i];
            var div = document.createElement('div');
            div.className = 'entry-item entry-type-' + String(e.type || '').toLowerCase();
            var label = document.createElement('div');
            label.className = 'entry-label';
            label.textContent = formatTs(e.timestamp) + '-' + e.type + '-' + String(e.requestId || '').substring(0, 8);
            var prev = document.createElement('div');
            prev.className = 'entry-preview';
            prev.textContent = String(e.content || '').substring(0, 100).replace(/\n/g, ' ');
            div.appendChild(label);
            div.appendChild(prev);
            (function(index) {
                div.addEventListener('click', function() {
                    selectEntry(index);
                });
            })(i);
            entryListEl.appendChild(div);
        }
        if (allEntries.length > 0) {
            selectEntry(0);
        } else {
            previewPanel.innerHTML = '<div class="empty-state">No entries available for this quest/subsystem</div>';
            metaPanel.innerHTML = '<div class="meta-title">Metadata</div><div class="empty-state" style="height:auto;padding:12px 0;">No entry selected</div>';
        }
    }

    function switchToSet(setName) {
        currentSet = normalizeSetName(setName);
        vscodeApi.postMessage({ type: 'switchQuest', quest: currentSet });
    }

    questSelect.addEventListener('change', function() {
        var setName = populateSubsystemDropdown(questSelect.value, null);
        switchToSet(setName);
    });

    subsystemSelect.addEventListener('change', function() {
        switchToSet(subsystemSelect.value);
    });

    window.addEventListener('message', function(event) {
        var msg = event.data || {};
        if (msg.type === 'updateEntries') {
            if (msg.trailSets) {
                trailSets = msg.trailSets;
            }
            allEntries = msg.entries || [];
            currentSet = normalizeSetName(msg.quest || currentSet);
            var parsed = splitSetName(currentSet);
            var selectedQuest = populateQuestDropdown(parsed.quest);
            populateSubsystemDropdown(selectedQuest, currentSet);
            renderEntries();
        }
    });

    var startParsed = splitSetName(currentSet);
    var startQuest = populateQuestDropdown(startParsed.quest);
    populateSubsystemDropdown(startQuest, currentSet);
    renderEntries();
})();
