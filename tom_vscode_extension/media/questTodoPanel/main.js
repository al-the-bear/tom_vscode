// @ts-nocheck
/* global vscode, qtViewConfig */
// Quest TODO panel client script — static body extracted from
// getQuestTodoScript() in src/handlers/questTodoPanel-handler.ts (Phase B.5
// webview restructuring). The single config-dependent line
// (var qtViewConfig = ...) is prepended by getQuestTodoScript() at load time;
// everything here is fully static. Uses the global 'vscode' handle defined by
// the host wrapper (popout / embedded / accordion), so it does NOT call
// acquireVsCodeApi() itself.

var qtCurrentQuestId = '';
var qtCurrentFile = 'all';
var qtSelectedTodoId = '';
var qtTodos = [];
var qtDetailTodo = null;
var qtFormScope = null;
var qtFormRefs = [];
var qtFormTags = [];
var qtTagPickerCallback = null;
var qtFilterSearch = '';
var qtFilterState = { status: [], priority: [], tags: [], createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', completedFrom: '', completedTo: '' };
var qtSortFields = []; // [{field,asc}]
var SORTABLE_FIELDS = ['status','priority','title','created','updated','completed_date'];
var qtUserName = '';
var qtNavHistory = [];
var qtNavIndex = -1;
var qtNavPushing = true;
var qtAutoSaveTimer = null;
var qtAllTodosForPicker = [];
var qtTagPickerScope = 'all';
var qtPathExtAppAvailability = {};
var qtPendingStatusChange = null;
var qtCurrentTemplate = '__none__';
var qtViewingBackup = false;
var qtPendingSelectTodoId = '';

function qtPersistState() {
    vscode.postMessage({ type: 'qtSaveState', state: {
        questId: qtCurrentQuestId,
        file: qtCurrentFile,
        tagScope: qtTagPickerScope,
        sortFields: qtSortFields,
        filterState: qtFilterState
    }});
}

function qtNavPush(todoId) {
    if (!qtNavPushing) return;
    qtNavHistory = qtNavHistory.slice(0, qtNavIndex + 1);
    qtNavHistory.push(todoId);
    qtNavIndex = qtNavHistory.length - 1;
    var navBack = document.getElementById('qt-btn-nav-back');
    var navFwd = document.getElementById('qt-btn-nav-fwd');
    if (navBack) { navBack.disabled = qtNavIndex <= 0; navBack.style.opacity = qtNavIndex <= 0 ? '0.3' : '1'; }
    if (navFwd) { navFwd.disabled = true; navFwd.style.opacity = '0.3'; }
}

(function initQuestTodoSection() {
    var questSel = document.getElementById('qt-quest-select');
    var fileSel = document.getElementById('qt-file-select');
    var openBtn = document.getElementById('qt-btn-open-yaml');
    var addBtn = document.getElementById('qt-btn-add-todo');
    var questLabel = questSel ? questSel.previousElementSibling : null;
    var fileLabel = fileSel ? fileSel.previousElementSibling : null;
    var fixedFileLabel = document.getElementById('qt-fixed-file-label');
    var navBack = document.getElementById('qt-btn-nav-back');
    var navFwd = document.getElementById('qt-btn-nav-fwd');
    if (!questSel) return; // section not rendered yet

    function qtNavUpdateButtons() {
        if (navBack) { navBack.disabled = qtNavIndex <= 0; navBack.style.opacity = qtNavIndex <= 0 ? '0.3' : '1'; }
        if (navFwd) { navFwd.disabled = qtNavIndex >= qtNavHistory.length - 1; navFwd.style.opacity = qtNavIndex >= qtNavHistory.length - 1 ? '0.3' : '1'; }
    }
    function qtNavGo(todoId) {
        qtNavPushing = false;
        qtSelectedTodoId = todoId;
        qtRenderList();
        vscode.postMessage({ type: 'qtGetTodo', questId: qtCurrentQuestId, todoId: todoId });
        qtNavPushing = true;
        qtNavUpdateButtons();
    }
    if (navBack) navBack.addEventListener('click', function() {
        if (qtNavIndex > 0) { qtNavIndex--; qtNavGo(qtNavHistory[qtNavIndex]); }
    });
    if (navFwd) navFwd.addEventListener('click', function() {
        if (qtNavIndex < qtNavHistory.length - 1) { qtNavIndex++; qtNavGo(qtNavHistory[qtNavIndex]); }
    });

    if (qtViewConfig.hideQuestSelect && questSel) {
        questSel.style.display = 'none';
        if (questLabel) { questLabel.style.display = 'none'; }
    }
    if (qtViewConfig.hideFileSelect && fileSel) {
        fileSel.style.display = 'none';
        if (fileLabel) { fileLabel.style.display = 'none'; }
    }
    if (qtViewConfig.fixedFileLabel && fixedFileLabel) {
        fixedFileLabel.textContent = qtViewConfig.fixedFileLabel;
        fixedFileLabel.style.display = '';
    }
    if (qtViewConfig.disableFileActions) {
        if (openBtn) {
            openBtn.disabled = true;
            openBtn.style.opacity = '0.3';
        }
        var popoutBtn0 = document.getElementById('qt-btn-popout');
        if (popoutBtn0) {
            popoutBtn0.style.display = 'none';
        }
    }

    questSel.addEventListener('change', function() {
        qtCurrentQuestId = this.value;
        qtCurrentFile = 'all';
        fileSel.value = 'all';
        var isSpecial = qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__';
        addBtn.disabled = isSpecial;
        addBtn.style.opacity = isSpecial ? '0.4' : '1';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: 'all' });
        qtPersistState();
    });
    fileSel.addEventListener('change', function() {
        qtCurrentFile = this.value;
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        qtPersistState();
    });
    openBtn.addEventListener('click', function() {
        if (qtCurrentQuestId) {
            vscode.postMessage({ type: 'qtOpenYaml', questId: qtCurrentQuestId, file: qtCurrentFile || 'all' });
        }
    });
    var popoutBtn = document.getElementById('qt-btn-popout');
    if (popoutBtn) popoutBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtPopout' });
    });
    addBtn.addEventListener('click', function() {
        var isSession = qtViewConfig && qtViewConfig.mode === 'session';
        var isWorkspaceFile = qtViewConfig && qtViewConfig.mode === 'workspace-file';
        if (!isSession && !isWorkspaceFile && qtCurrentFile === 'all') return;
        if (qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__') return;
        var id = 'todo-' + Date.now().toString(36);
        qtShowNewTodoForm(id);
    });
    // Mass Add button
    var massAddBtn = document.getElementById('qt-btn-mass-add');
    if (massAddBtn) massAddBtn.addEventListener('click', function() {
        var isSession = qtViewConfig && qtViewConfig.mode === 'session';
        var isWorkspaceFile = qtViewConfig && qtViewConfig.mode === 'workspace-file';
        if (!isSession && !isWorkspaceFile && qtCurrentFile === 'all') return;
        if (qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__') return;
        qtShowMassAddOverlay();
    });
    // Filter/sort bar — new icon buttons with picker overlays
    var searchInput = document.getElementById('qt-search');
    var btnFilter = document.getElementById('qt-btn-filter');
    var btnSort = document.getElementById('qt-btn-sort');
    var btnReload = document.getElementById('qt-btn-reload');
    var btnDeleteAll = document.getElementById('qt-btn-delete-all');
    var btnOpenExt = document.getElementById('qt-btn-open-ext');
    var btnOpenTrail = document.getElementById('qt-btn-open-trail');
    var templateSelect = document.getElementById('qt-template-select');
    var addQueueBtn = document.getElementById('qt-btn-add-queue');
    var sendCopilotBtn = document.getElementById('qt-btn-send-copilot');
    if (searchInput) searchInput.addEventListener('input', function() { qtFilterSearch = this.value.toLowerCase(); qtRenderList(); });
    if (btnFilter) btnFilter.addEventListener('click', function(e) { e.stopPropagation(); qtToggleFilterPicker(); });
    if (btnSort) btnSort.addEventListener('click', function(e) { e.stopPropagation(); qtToggleSortPicker(); });
    if (btnReload) btnReload.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
    });
    if (btnDeleteAll) {
        if (qtViewConfig.mode === 'session') {
            btnDeleteAll.style.display = '';
        }
        btnDeleteAll.addEventListener('click', function() {
            vscode.postMessage({ type: 'qtDeleteAllSessionTodos' });
        });
    }
    if (btnOpenExt) btnOpenExt.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtOpenExtApp', questId: qtCurrentQuestId, file: qtCurrentFile });
    });
    if (btnOpenTrail) btnOpenTrail.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtOpenTrailFiles' });
    });
    // Import button — show in all modes
    var btnImport = document.getElementById('qt-btn-import');
    if (btnImport) {
        btnImport.style.display = '';
        btnImport.addEventListener('click', function() {
            vscode.postMessage({ type: 'qtImportFromFile', questId: qtCurrentQuestId, file: qtCurrentFile });
        });
    }
    // Backup toggle button
    var btnToggleBackup = document.getElementById('qt-btn-toggle-backup');
    if (btnToggleBackup) {
        btnToggleBackup.addEventListener('click', function() {
            qtViewingBackup = !qtViewingBackup;
            if (qtViewingBackup) {
                btnToggleBackup.classList.add('active-indicator');
                btnToggleBackup.title = 'Switch to normal file';
                vscode.postMessage({ type: 'qtGetBackupTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            } else {
                btnToggleBackup.classList.remove('active-indicator');
                btnToggleBackup.title = 'Switch to backup file';
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            }
        });
    }
    if (templateSelect) templateSelect.addEventListener('change', function() {
        qtCurrentTemplate = this.value || '__none__';
    });
    if (addQueueBtn) addQueueBtn.addEventListener('click', function() {
        if (!qtSelectedTodoId) {
            vscode.postMessage({ type: 'qtShowError', message: 'Select a todo first.' });
            return;
        }
        var effectiveTodoId = (qtDetailTodo && qtDetailTodo.id) ? qtDetailTodo.id : qtSelectedTodoId;
        vscode.postMessage({
            type: 'qtAddCurrentTodoToQueue',
            questId: qtCurrentQuestId,
            file: qtCurrentFile,
            todoId: effectiveTodoId,
            sourceFile: qtDetailTodo && qtDetailTodo._sourceFile ? qtDetailTodo._sourceFile : undefined,
            template: qtCurrentTemplate,
        });
    });
    if (sendCopilotBtn) sendCopilotBtn.addEventListener('click', function() {
        if (!qtSelectedTodoId) {
            vscode.postMessage({ type: 'qtShowError', message: 'Select a todo first.' });
            return;
        }
        var effectiveTodoId = (qtDetailTodo && qtDetailTodo.id) ? qtDetailTodo.id : qtSelectedTodoId;
        vscode.postMessage({
            type: 'qtSendCurrentTodoToCopilot',
            questId: qtCurrentQuestId,
            file: qtCurrentFile,
            todoId: effectiveTodoId,
            sourceFile: qtDetailTodo && qtDetailTodo._sourceFile ? qtDetailTodo._sourceFile : undefined,
            template: qtCurrentTemplate,
        });
    });
    // Close pickers on outside click
    document.addEventListener('click', function(e) {
        var fp = document.getElementById('qt-filter-picker');
        var sp = document.getElementById('qt-sort-picker');
        if (fp && fp.style.display !== 'none' && !fp.contains(e.target) && e.target !== btnFilter && !btnFilter.contains(e.target)) fp.style.display = 'none';
        if (sp && sp.style.display !== 'none' && !sp.contains(e.target) && e.target !== btnSort && !btnSort.contains(e.target)) sp.style.display = 'none';
    });

    // Draggable split between todo list and detail panel
    (function initQtSplitDrag() {
        var split = document.querySelector('.qt-split');
        var listPane = document.getElementById('qt-list-pane');
        var splitter = document.getElementById('qt-splitter');
        if (!split || !listPane || !splitter) return;
        var dragging = false;
        splitter.addEventListener('mousedown', function(e) {
            dragging = true;
            splitter.classList.add('dragging');
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            var rect = split.getBoundingClientRect();
            var left = e.clientX - rect.left;
            var pct = (left / rect.width) * 100;
            pct = Math.max(20, Math.min(70, pct));
            listPane.style.width = pct + '%';
            listPane.style.flex = '0 0 ' + pct + '%';
        });
        document.addEventListener('mouseup', function() {
            if (!dragging) return;
            dragging = false;
            splitter.classList.remove('dragging');
        });
    })();
    // Request username from config
    // Send config + request initial data
    vscode.postMessage({ type: 'qtInitConfig', config: qtViewConfig });
    vscode.postMessage({ type: 'qtGetTemplates' });
    if (qtViewConfig.mode === 'session') {
        qtCurrentQuestId = '__session__';
        qtCurrentFile = 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else if (qtViewConfig.mode === 'workspace-file') {
        qtCurrentQuestId = '__all_workspace__';
        qtCurrentFile = 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else if (qtViewConfig.fixedQuestId) {
        qtCurrentQuestId = qtViewConfig.fixedQuestId;
        qtCurrentFile = qtViewConfig.fixedFile || 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        vscode.postMessage({ type: 'qtGetFiles', questId: qtCurrentQuestId });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else {
        vscode.postMessage({ type: 'qtGetQuests' });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: '', file: 'all' });
    }
})();

function qtRenderList() {
    var pane = document.getElementById('qt-list-pane');
    if (!pane) return;
    if (!qtTodos.length) { pane.innerHTML = '<div class="qt-empty-detail">No todos found</div>'; return; }

    // Apply filters
    var filtered = qtTodos.filter(function(t) {
        if (qtFilterState.status.length && qtFilterState.status.indexOf(t.status || 'not-started') === -1) return false;
        if (qtFilterState.priority.length && qtFilterState.priority.indexOf(t.priority || '') === -1) return false;
        if (qtFilterState.tags.length) {
            var tTags = t.tags || [];
            var hasTag = false;
            for (var ti = 0; ti < qtFilterState.tags.length; ti++) { if (tTags.indexOf(qtFilterState.tags[ti]) >= 0) { hasTag = true; break; } }
            if (!hasTag) return false;
        }
        if (qtFilterState.createdFrom && (t.created || '') < qtFilterState.createdFrom) return false;
        if (qtFilterState.createdTo && (t.created || '') > qtFilterState.createdTo) return false;
        if (qtFilterState.updatedFrom && (t.updated || '') < qtFilterState.updatedFrom) return false;
        if (qtFilterState.updatedTo && (t.updated || '') > qtFilterState.updatedTo) return false;
        if (qtFilterSearch) {
            var hay = ((t.id || '') + ' ' + (t.title || '') + ' ' + (t.sourceFile || '')).toLowerCase();
            if (hay.indexOf(qtFilterSearch) === -1) return false;
        }
        return true;
    });

    // Apply multi-field sort
    if (qtSortFields.length) {
        var priOrd = { critical: 0, high: 1, medium: 2, low: 3 };
        var staOrd = { 'in-progress': 0, 'blocked': 1, 'not-started': 2, 'completed': 3, 'cancelled': 4 };
        filtered = filtered.slice().sort(function(a, b) {
            for (var si = 0; si < qtSortFields.length; si++) {
                var sf = qtSortFields[si];
                var cmp = 0;
                switch (sf.field) {
                    case 'status': cmp = (staOrd[a.status] || 9) - (staOrd[b.status] || 9); break;
                    case 'priority': cmp = (priOrd[a.priority] || 9) - (priOrd[b.priority] || 9); break;
                    case 'title': cmp = (a.title || '').localeCompare(b.title || ''); break;
                    case 'created': cmp = (a.created || '').localeCompare(b.created || ''); break;
                    case 'updated': cmp = (b.updated || '').localeCompare(a.updated || ''); break;
                    case 'completed_date': cmp = (a.completed_date || '').localeCompare(b.completed_date || ''); break;
                }
                if (!sf.asc) cmp = -cmp;
                if (cmp !== 0) return cmp;
            }
            return 0;
        });
    }

    if (!filtered.length) { pane.innerHTML = '<div class="qt-empty-detail">No matching todos</div>'; return; }

    pane.innerHTML = filtered.map(function(t) {
        var icon = qtStatusIcon(t.status);
        var cls = 'qt-todo-item status-' + (t.status || 'not-started');
        if (t.id === qtSelectedTodoId) cls += ' selected';
        var showSrc = (qtCurrentFile === 'all' || qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__') && t.sourceFile;
        var srcLabel = showSrc ? '<span class="source-file">' + qtEsc(t.sourceFile) + '</span>' : '';
        var isSpecialMode = qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__';
        var isQuestMode = !isSpecialMode && qtCurrentQuestId;
        var isDone = t.status === 'completed' || t.status === 'cancelled';
        var moveBtn = '';
        var moveWsBtn = '';
        var trashBtn = '';
        var reopenBtn = '';
        var restoreBtn = '';
        if (qtViewingBackup) {
            // Backup mode: completed/cancelled -> reopen + delete; reopened -> move back to file
            if (isDone) {
                reopenBtn = '<button class="qt-reopen-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Reopen (set to not-started)">🔄</button>';
                trashBtn = '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Permanently delete">🗑️</button>';
            } else {
                restoreBtn = '<button class="qt-restore-btn" data-qt-restore="' + qtEsc(t.id) + '" title="Move back to todo file">↩️</button>';
                trashBtn = '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Permanently delete">🗑️</button>';
            }
        } else if (isDone) {
            trashBtn = '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Delete (move to backup)">🗑️</button>';
            reopenBtn = '<button class="qt-reopen-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Reopen (set to not-started)">🔄</button>';
        } else {
            moveBtn = isQuestMode && qtCurrentFile === 'all' ? '<button class="qt-move-btn" data-qt-move="' + qtEsc(t.id) + '" title="Move to main quest todo file">➡️</button>' : '';
            moveWsBtn = '<button class="qt-move-ws-btn" data-qt-movews="' + qtEsc(t.id) + '" title="Move to workspace todos">⬆️</button>';
        }
        var priorityBadge = t.priority && (t.priority === 'critical' || t.priority === 'high') ? '<span class="priority-badge ' + t.priority + '">' + t.priority.toUpperCase() + '</span>' : '';
        var priorityDot = t.priority ? '<span class="qt-priority-dot ' + qtEsc(t.priority) + '">●</span>' : '';
        return '<div class="' + cls + '" data-qt-id="' + qtEsc(t.id) + '">' +
            '<div class="qt-todo-item-row1">' +
            '<span class="status-icon">' + icon + '</span>' +
            '<span class="ttitle">' + qtEsc(t.title || '') + '</span>' +
            priorityBadge + moveBtn + moveWsBtn + restoreBtn + trashBtn + reopenBtn + '</div>' +
            '<div class="qt-todo-item-row2">' +
            priorityDot +
            '<span class="tid">' + qtEsc(t.id) + '</span>' +
            srcLabel + '</div></div>';
    }).join('');

    pane.querySelectorAll('.qt-todo-item').forEach(function(el) {
        el.addEventListener('click', function(e) {
            if (e.target.closest('.qt-move-btn') || e.target.closest('.qt-move-ws-btn') || e.target.closest('.qt-trash-btn') || e.target.closest('.qt-reopen-btn') || e.target.closest('.qt-restore-btn')) return;
            qtSelectedTodoId = el.dataset.qtId;
            qtNavPush(qtSelectedTodoId);
            qtRenderList();
            vscode.postMessage({ type: 'qtGetTodo', questId: qtCurrentQuestId, todoId: qtSelectedTodoId, fromBackup: qtViewingBackup });
        });
    });
    pane.querySelectorAll('.qt-move-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtMove;
            var mainFile = 'todos.' + qtCurrentQuestId + '.todo.yaml';
            vscode.postMessage({ type: 'qtMoveTodo', questId: qtCurrentQuestId, todoId: tid, targetFile: mainFile });
        });
    });
    pane.querySelectorAll('.qt-move-ws-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtMovews;
            vscode.postMessage({ type: 'qtMoveToWorkspace', questId: qtCurrentQuestId, todoId: tid });
        });
    });
    pane.querySelectorAll('.qt-trash-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtTrash;
            var srcFile = '';
            var match = qtTodos.filter(function(t) { return t.id === tid; });
            if (match.length) srcFile = match[0].sourceFile || '';
            vscode.postMessage({ type: 'qtDeleteTodo', questId: qtCurrentQuestId, todoId: tid, sourceFile: srcFile, fromBackup: qtViewingBackup });
        });
    });
    pane.querySelectorAll('.qt-reopen-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtReopen;
            vscode.postMessage({ type: 'qtReopenTodo', questId: qtCurrentQuestId, todoId: tid, fromBackup: qtViewingBackup });
        });
    });
    pane.querySelectorAll('.qt-restore-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtRestore;
            vscode.postMessage({ type: 'qtRestoreFromBackup', questId: qtCurrentQuestId, todoId: tid, file: qtCurrentFile });
        });
    });
}

function qtStatusIcon(s) {
    switch(s) {
        case 'in-progress': return '🔄';
        case 'completed': return '✅';
        case 'blocked': return '⛔';
        case 'cancelled': return '🚫';
        default: return '⬜';
    }
}

// ── Filter picker ──
function qtToggleFilterPicker() {
    var el = document.getElementById('qt-filter-picker');
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    document.getElementById('qt-sort-picker').style.display = 'none';
    qtRenderFilterPicker();
    el.style.display = '';
}

function qtHasActiveFilters() {
    return qtFilterState.status.length > 0 || qtFilterState.priority.length > 0 || qtFilterState.tags.length > 0 ||
        qtFilterState.createdFrom || qtFilterState.createdTo || qtFilterState.updatedFrom || qtFilterState.updatedTo;
}

function qtUpdateFilterIndicator() {
    var btn = document.getElementById('qt-btn-filter');
    if (!btn) return;
    if (qtHasActiveFilters()) btn.classList.add('active-indicator');
    else btn.classList.remove('active-indicator');
}

function qtRenderFilterPicker() {
    var el = document.getElementById('qt-filter-picker');
    if (!el) return;
    var statuses = ['not-started','in-progress','blocked','completed','cancelled'];
    var priorities = ['critical','high','medium','low'];
    // Collect all tags from current todos
    var allTags = [];
    var tagSet = {};
    qtTodos.forEach(function(t) { (t.tags || []).forEach(function(tag) { if (!tagSet[tag]) { tagSet[tag] = true; allTags.push(tag); } }); });
    allTags.sort();

    var html = '<div class="qt-picker-section-header">Status</div>';
    statuses.forEach(function(s) {
        var checked = qtFilterState.status.indexOf(s) >= 0;
        html += '<div class="qt-picker-option" data-qt-filter-type="status" data-qt-filter-val="' + s + '">' +
            '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + s + '</div>';
    });
    html += '<div class="qt-picker-section-header">Priority</div>';
    priorities.forEach(function(p) {
        var checked = qtFilterState.priority.indexOf(p) >= 0;
        html += '<div class="qt-picker-option" data-qt-filter-type="priority" data-qt-filter-val="' + p + '">' +
            '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + p + '</div>';
    });
    if (allTags.length) {
        html += '<div class="qt-picker-section-header">Tags</div>';
        allTags.forEach(function(tag) {
            var checked = qtFilterState.tags.indexOf(tag) >= 0;
            html += '<div class="qt-picker-option" data-qt-filter-type="tags" data-qt-filter-val="' + qtEsc(tag) + '">' +
                '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + qtEsc(tag) + '</div>';
        });
    }
    html += '<div class="qt-picker-section-header">Date Ranges</div>';
    html += '<div class="qt-picker-date-row"><label>Created</label><input type="date" id="qt-fp-created-from" value="' + (qtFilterState.createdFrom || '') + '"><span>–</span><input type="date" id="qt-fp-created-to" value="' + (qtFilterState.createdTo || '') + '"></div>';
    html += '<div class="qt-picker-date-row"><label>Updated</label><input type="date" id="qt-fp-updated-from" value="' + (qtFilterState.updatedFrom || '') + '"><span>–</span><input type="date" id="qt-fp-updated-to" value="' + (qtFilterState.updatedTo || '') + '"></div>';
    html += '<div class="qt-picker-footer"><button class="secondary" id="qt-fp-reset">Reset</button><button class="primary" id="qt-fp-ok">OK</button></div>';
    el.innerHTML = html;

    // Attach click handlers for checkboxes (inline toggle)
    el.querySelectorAll('.qt-picker-option').forEach(function(opt) {
        opt.addEventListener('click', function() {
            var type = opt.dataset.qtFilterType;
            var val = opt.dataset.qtFilterVal;
            var arr = qtFilterState[type];
            var idx = arr.indexOf(val);
            if (idx >= 0) arr.splice(idx, 1); else arr.push(val);
            var icon = opt.querySelector('.qt-check-box .codicon');
            if (icon) { icon.className = 'codicon ' + (arr.indexOf(val) >= 0 ? 'codicon-check' : ''); }
        });
    });
    // Date range inputs
    var cfEl = document.getElementById('qt-fp-created-from');
    var ctEl = document.getElementById('qt-fp-created-to');
    var ufEl = document.getElementById('qt-fp-updated-from');
    var utEl = document.getElementById('qt-fp-updated-to');
    if (cfEl) cfEl.addEventListener('change', function() { qtFilterState.createdFrom = this.value; });
    if (ctEl) ctEl.addEventListener('change', function() { qtFilterState.createdTo = this.value; });
    if (ufEl) ufEl.addEventListener('change', function() { qtFilterState.updatedFrom = this.value; });
    if (utEl) utEl.addEventListener('change', function() { qtFilterState.updatedTo = this.value; });
    // Reset
    document.getElementById('qt-fp-reset').addEventListener('click', function() {
        qtFilterState = { status: [], priority: [], tags: [], createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', completedFrom: '', completedTo: '' };
        qtRenderFilterPicker();
        qtUpdateFilterIndicator();
        qtRenderList();
        qtPersistState();
    });
    // OK
    document.getElementById('qt-fp-ok').addEventListener('click', function() {
        el.style.display = 'none';
        qtUpdateFilterIndicator();
        qtRenderList();
        qtPersistState();
    });
}

// ── Sort picker ──
function qtToggleSortPicker() {
    var el = document.getElementById('qt-sort-picker');
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    document.getElementById('qt-filter-picker').style.display = 'none';
    qtRenderSortPicker();
    el.style.display = '';
}

function qtRenderSortPicker() {
    var el = document.getElementById('qt-sort-picker');
    if (!el) return;
    var pending = qtSortFields.slice(); // copy for editing
    var html = '<div class="qt-picker-section-header">Sort Fields</div>';
    SORTABLE_FIELDS.forEach(function(field) {
        var idx = -1; var asc = true;
        for (var i = 0; i < pending.length; i++) { if (pending[i].field === field) { idx = i; asc = pending[i].asc; break; } }
        var numCls = idx >= 0 ? 'qt-sort-number' : 'qt-sort-number empty';
        var numLabel = idx >= 0 ? String(idx + 1) : '';
        var dirIcon = asc ? '↑' : '↓';
        html += '<div class="qt-picker-option" data-qt-sort-field="' + field + '">' +
            '<span class="' + numCls + '">' + numLabel + '</span> ' +
            field + ' <span class="qt-sort-dir" style="margin-left:auto;cursor:pointer;">' + (idx >= 0 ? dirIcon : '') + '</span></div>';
    });
    html += '<div class="qt-picker-footer"><button class="secondary" id="qt-sp-reset">Reset</button><button class="primary" id="qt-sp-ok">OK</button></div>';
    el.innerHTML = html;

    el.querySelectorAll('.qt-picker-option').forEach(function(opt) {
        opt.addEventListener('click', function(e) {
            e.stopPropagation();
            var field = opt.dataset.qtSortField;
            var existing = -1;
            for (var i = 0; i < pending.length; i++) { if (pending[i].field === field) { existing = i; break; } }
            if (e.target.closest('.qt-sort-dir') && existing >= 0) {
                pending[existing].asc = !pending[existing].asc;
            } else if (existing >= 0) {
                pending.splice(existing, 1);
            } else {
                pending.push({ field: field, asc: true });
            }
            qtSortFields = pending;
            qtRenderSortPicker();
        });
    });
    document.getElementById('qt-sp-reset').addEventListener('click', function(e) {
        e.stopPropagation();
        qtSortFields = []; pending = [];
        var sortBtn = document.getElementById('qt-btn-sort');
        if (sortBtn) sortBtn.classList.remove('active-indicator');
        qtRenderSortPicker();
        qtRenderList();
        qtPersistState();
    });
    document.getElementById('qt-sp-ok').addEventListener('click', function(e) {
        e.stopPropagation();
        qtSortFields = pending;
        el.style.display = 'none';
        var sortBtn = document.getElementById('qt-btn-sort');
        if (sortBtn) { if (qtSortFields.length) sortBtn.classList.add('active-indicator'); else sortBtn.classList.remove('active-indicator'); }
        qtRenderList();
        qtPersistState();
    });
}

// ── Autosave helper ──
function qtAutoSave() {
    if (qtAutoSaveTimer) clearTimeout(qtAutoSaveTimer);
    qtAutoSaveTimer = setTimeout(function() {
        if (!qtDetailTodo) return;
        var updates = qtCollectFormData();
        var saveQuestId = (qtDetailTodo._resolvedQuestId) || qtCurrentQuestId;
        vscode.postMessage({
            type: 'qtSaveTodo',
            questId: saveQuestId,
            todoId: qtDetailTodo.id,
            sourceFile: qtDetailTodo && qtDetailTodo._sourceFile ? qtDetailTodo._sourceFile : undefined,
            updates: updates,
        });
    }, 600);
}

function qtRenderDetail(todo) {
    qtDetailTodo = todo;
    var pane = document.getElementById('qt-detail-pane');
    if (!pane) return;
    if (!todo) { pane.innerHTML = '<div class="qt-empty-detail">Select a todo to view details</div>'; return; }

    qtFormTags = (todo.tags || []).slice();
    qtFormScope = todo.scope ? JSON.parse(JSON.stringify(todo.scope)) : null;
    qtFormRefs = todo.references ? JSON.parse(JSON.stringify(todo.references)) : [];

    var blockedByBadges = qtRenderTodoBadges(todo.blocked_by || [], 'blocked-by');
    var depsBadges = qtRenderTodoBadges(todo.dependencies || [], 'deps');

    pane.innerHTML = '<div class="qt-detail-form">' +
        qtFormRow('ID', '<input id="qt-d-id" value="' + qtEsc(todo.id) + '" readonly class="qt-readonly">') +
        qtFormRow('Title', '<input id="qt-d-title" value="' + qtEsc(todo.title || '') + '">') +
        qtFormRow('Description', '<textarea id="qt-d-desc" data-completion="on">' + qtEsc(todo.description || '') + '</textarea>') +
        '<div class="qt-inline-row">' +
        qtFormRow('Status', '<select id="qt-d-status">' + qtStatusOptions(todo.status) + '</select>') +
        qtFormRow('Priority', '<select id="qt-d-priority">' + qtPriorityOptions(todo.priority) + '</select>') +
        '</div>' +
        qtFormRow('Tags', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div class="qt-tag-chips" id="qt-d-tags">' + qtRenderTagChipsHtml(qtFormTags) + '</div>' +
            '<input class="qt-tag-input" id="qt-d-tag-input" placeholder="Add tag...">' +
            '<button class="qt-edit-btn" id="qt-d-tag-picker-btn" title="Pick from existing tags">🏷️</button></div>') +
        qtFormRow('Dependencies', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-deps-wrap">' + depsBadges +
            '<button class="qt-edit-btn" id="qt-d-deps-add" title="Add dependency">➕</button></div>') +
        qtFormRow('Blocked By', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-blocked-wrap">' + blockedByBadges +
            '<button class="qt-edit-btn" id="qt-d-blocked-add" title="Add blocked-by">➕</button></div>') +
        qtFormRow('Notes', '<textarea id="qt-d-notes" data-completion="on">' + qtEsc(todo.notes || '') + '</textarea>') +
        qtRenderScopeSection(qtFormScope) +
        qtRenderRefsSection(qtFormRefs) +
        qtRenderDatesSection(todo) +
        '<div class="qt-form-actions">' +
        '<button class="icon-btn" id="qt-btn-delete" style="color:var(--vscode-errorForeground);">🗑️ Delete</button>' +
        '</div></div>';

    ['qt-d-title','qt-d-desc','qt-d-notes'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', qtAutoSave);
    });

    document.getElementById('qt-d-priority').addEventListener('change', qtAutoSave);
    document.getElementById('qt-btn-delete').addEventListener('click', function() {
        var delQuestId = (todo._resolvedQuestId) || qtCurrentQuestId;
        vscode.postMessage({ type: 'qtDeleteTodo', questId: delQuestId, todoId: todo.id, sourceFile: todo._sourceFile, fromBackup: qtViewingBackup });
    });

    document.getElementById('qt-d-tag-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && this.value.trim()) {
            qtFormTags.push(this.value.trim());
            this.value = '';
            qtRefreshTagChips();
            qtAutoSave();
        }
    });
    document.getElementById('qt-d-tag-picker-btn').addEventListener('click', function() { qtShowTagPicker(); });

    document.getElementById('qt-d-status').addEventListener('change', function() {
        var newStatus = this.value;
        var sel = this;
        var cdInput = document.getElementById('qt-d-completed-date');
        var cbInput = document.getElementById('qt-d-completed-by');
        if (newStatus === 'completed' || newStatus === 'cancelled') {
            var prev = (qtDetailTodo && qtDetailTodo.status) ? qtDetailTodo.status : 'not-started';
            sel.value = prev;
            qtPendingStatusChange = { status: newStatus, previous: prev };
            vscode.postMessage({ type: 'qtConfirmStatusUpdate', status: newStatus });
            return;
        }
        // Any non-terminal status clears completion metadata
        if (cdInput) cdInput.value = '';
        if (cbInput) cbInput.value = '';
        if (qtDetailTodo) qtDetailTodo.status = newStatus;
        qtAutoSave();
    });

    qtAttachTodoBadgeHandlers('blocked-by');
    qtAttachTodoBadgeHandlers('deps');
    document.getElementById('qt-d-blocked-add').addEventListener('click', function() { qtShowTodoPicker('blocked-by'); });
    document.getElementById('qt-d-deps-add').addEventListener('click', function() { qtShowTodoPicker('deps'); });

    qtAttachTagRemoveHandlers();
    qtAttachSectionHandlers();
    qtAttachScopeFileHandlers();
    qtAttachRefHandlers();

    var pathsToCheck = [];
    (qtFormScope && qtFormScope.files ? qtFormScope.files : []).forEach(function(p) { pathsToCheck.push(p); });
    qtFormRefs.forEach(function(r) { if (r.path) pathsToCheck.push(r.path); });
    qtRequestPathExtAppAvailability(pathsToCheck);

    vscode.postMessage({ type: 'qtCheckExtApp', questId: qtCurrentQuestId, file: qtCurrentFile });
}

// ── Todo badge rendering for blocked-by / dependencies ──
function qtRenderTodoBadges(ids, category) {
    return ids.map(function(id) {
        return '<span class="qt-todo-badge" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '" title="Navigate to ' + qtEsc(id) + '">' +
            qtEsc(id) +
            '<span class="qt-badge-remove" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '">×</span>' +
            '</span>';
    }).join('');
}

function qtAttachTodoBadgeHandlers(category) {
    var wrapId = category === 'blocked-by' ? 'qt-d-blocked-wrap' : 'qt-d-deps-wrap';
    var wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.querySelectorAll('.qt-todo-badge[data-qt-badge-cat="' + category + '"]').forEach(function(badge) {
        badge.addEventListener('click', function(e) {
            if (e.target.closest('.qt-badge-remove')) return;
            // Navigate to the referenced todo
            var tid = badge.dataset.qtBadgeId;
            if (tid) {
                var targetQuestId = qtCurrentQuestId;
                var targetTodoId = tid;
                var slashIdx = tid.indexOf('/');
                if (slashIdx > 0) {
                    targetQuestId = tid.substring(0, slashIdx);
                    targetTodoId = tid.substring(slashIdx + 1);
                }
                qtSelectedTodoId = tid;
                qtNavPush(tid);
                qtRenderList();
                vscode.postMessage({ type: 'qtGetTodo', questId: targetQuestId, todoId: targetTodoId });
            }
        });
    });
    wrap.querySelectorAll('.qt-badge-remove[data-qt-badge-cat="' + category + '"]').forEach(function(rm) {
        rm.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = rm.dataset.qtBadgeId;
            var field = category === 'blocked-by' ? 'blocked_by' : 'dependencies';
            var arr = qtDetailTodo[field] || [];
            var idx = arr.indexOf(tid);
            if (idx >= 0) arr.splice(idx, 1);
            qtDetailTodo[field] = arr;
            // Re-render badges
            var badgesHtml = qtRenderTodoBadges(arr, category);
            var addBtn = wrap.querySelector('#qt-d-' + (category === 'blocked-by' ? 'blocked' : 'deps') + '-add');
            wrap.innerHTML = badgesHtml + addBtn.outerHTML;
            qtAttachTodoBadgeHandlers(category);
            wrap.querySelector('#qt-d-' + (category === 'blocked-by' ? 'blocked' : 'deps') + '-add').addEventListener('click', function() { qtShowTodoPicker(category); });
            qtAutoSave();
        });
    });
}

function qtShowTodoPicker(category) {
    qtClosePopup();
    window._qtTodoPickerCategory = category;
    qtShowPopup('<h4>Loading todos...</h4>');
    var currentQuest = qtCurrentQuestId;
    var pickerScope = 'local';
    if (!currentQuest || currentQuest === '__all_quests__' || currentQuest === '__all_workspace__') {
        pickerScope = 'workspace';
    }
    vscode.postMessage({ type: 'qtGetTodosForPicker', source: pickerScope, questId: currentQuest });
    qtTagPickerCallback = null; // reuse mechanism
}

function qtRenderTodoPickerPopup(allTodos, category) {
    var field = category === 'blocked-by' ? 'blocked_by' : 'dependencies';
    var current = (qtDetailTodo && qtDetailTodo[field]) || [];
    var currentSet = {};
    current.forEach(function(id) { currentSet[id] = true; });
    var filtered = allTodos.filter(function(t) {
        if (!qtDetailTodo) return true;
        var ownRefs = [qtDetailTodo.id, (qtCurrentQuestId ? (qtCurrentQuestId + '/' + qtDetailTodo.id) : '')];
        return ownRefs.indexOf(t.ref || t.id) === -1;
    });
    var questSel = document.getElementById('qt-quest-select');
    var questOptions = [];
    // If main quest select is hidden (session/workspace mode), use cached quest list
    if (questSel && questSel.style.display !== 'none') {
        questSel.querySelectorAll('option').forEach(function(o) {
            var v = o.value;
            if (!v || v.indexOf('__') === 0) return;
            questOptions.push('<option value="' + qtEsc(v) + '">' + qtEsc(v) + '</option>');
        });
    } else if (window._qtPickerQuestList) {
        window._qtPickerQuestList.forEach(function(q) {
            questOptions.push('<option value="' + qtEsc(q) + '">' + qtEsc(q) + '</option>');
        });
    }
    var html = '<h4>Select ' + (category === 'blocked-by' ? 'Blocked By' : 'Dependencies') + '</h4>' +
        '<div class="qt-inline-row" style="margin-bottom:6px;">' +
        '<select id="qt-tp-source" style="flex:1;">' +
        '<option value="local">Local todos (current quest)</option>' +
        '<option value="quest">Quest todos (select quest)</option>' +
        '<option value="workspace">Workspace todos</option>' +
        '</select>' +
        '<select id="qt-tp-quest" style="flex:1;display:none;">' + questOptions.join('') + '</select>' +
        '</div>' +
        '<input id="qt-tp-filter" placeholder="Filter todos..." style="width:100%;margin-bottom:6px;">' +
        '<div class="qt-tag-picker-list" id="qt-todo-picker-list" style="max-height:250px;overflow-y:auto;">';
    filtered.forEach(function(t) {
        var refId = t.ref || t.id;
        var checked = currentSet[refId];
        html += '<div class="qt-tag-picker-item" data-qt-pick-tag="' + qtEsc(refId) + '">' +
            '<input type="checkbox"' + (checked ? ' checked' : '') + '> ' +
            '<span style="font-weight:600;">' + qtEsc(refId) + '</span> — ' + qtEsc(t.title || '') + '</div>';
    });
    html += '</div><div class="qt-popup-actions">' +
        '<button class="primary" id="qt-tp-ok">OK</button>' +
        '<button class="icon-btn" id="qt-tp-cancel">Cancel</button></div>';
    qtShowPopup(html);
    var sourceEl = document.getElementById('qt-tp-source');
    var questPickEl = document.getElementById('qt-tp-quest');
    var refreshPickerData = function() {
        var source = sourceEl ? sourceEl.value : 'local';
        var questId = source === 'quest' && questPickEl ? questPickEl.value : qtCurrentQuestId;
        if (questPickEl) questPickEl.style.display = source === 'quest' ? '' : 'none';
        vscode.postMessage({ type: 'qtGetTodosForPicker', source: source, questId: questId });
    };
    if (sourceEl) {
        // Default to 'local' for regular quests and session mode, 'workspace' for __all_workspace__/__all_quests__
        var isSessionOrReal = qtCurrentQuestId && (qtCurrentQuestId === '__session__' || qtCurrentQuestId.indexOf('__') !== 0);
        sourceEl.value = isSessionOrReal ? 'local' : 'workspace';
        sourceEl.addEventListener('change', refreshPickerData);
    }
    if (questPickEl) {
        if (qtCurrentQuestId && qtCurrentQuestId.indexOf('__') !== 0) questPickEl.value = qtCurrentQuestId;
        questPickEl.addEventListener('change', refreshPickerData);
    }
    // Filter
    document.getElementById('qt-tp-filter').addEventListener('input', function() {
        var q = this.value.toLowerCase();
        document.querySelectorAll('#qt-todo-picker-list .qt-tag-picker-item').forEach(function(item) {
            item.style.display = (item.dataset.qtPickTag || '').toLowerCase().indexOf(q) >= 0 || item.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
        });
    });
    qtAttachTagPickerItemHandlers();
    document.getElementById('qt-tp-ok').addEventListener('click', function() {
        var selected = [];
        document.querySelectorAll('#qt-todo-picker-list .qt-tag-picker-item').forEach(function(item) {
            var cb = item.querySelector('input[type="checkbox"]');
            if (cb && cb.checked) selected.push(item.dataset.qtPickTag);
        });
        var merged = (qtDetailTodo && qtDetailTodo[field]) ? qtDetailTodo[field].slice() : [];
        selected.forEach(function(id) {
            if (merged.indexOf(id) < 0) merged.push(id);
        });
        if (qtDetailTodo) qtDetailTodo[field] = merged;
        qtClosePopup();
        window._qtTodoPickerCategory = null;
        // Re-render the badges
        var wrapId = category === 'blocked-by' ? 'qt-d-blocked-wrap' : 'qt-d-deps-wrap';
        var wrap = document.getElementById(wrapId);
        if (wrap) {
            var addBtnId = category === 'blocked-by' ? 'qt-d-blocked-add' : 'qt-d-deps-add';
            wrap.innerHTML = qtRenderTodoBadges(merged, category) +
                '<button class="qt-edit-btn" id="' + addBtnId + '" title="Add ' + (category === 'blocked-by' ? 'blocked-by' : 'dependency') + '">➕</button>';
            qtAttachTodoBadgeHandlers(category);
            document.getElementById(addBtnId).addEventListener('click', function() { qtShowTodoPicker(category); });
        }
        qtAutoSave();
    });
    document.getElementById('qt-tp-cancel').addEventListener('click', function() {
        window._qtTodoPickerCategory = null;
        qtClosePopup();
    });
}

function qtUpdateTodoPickerList(allTodos, category) {
    var list = document.getElementById('qt-todo-picker-list');
    if (!list) {
        qtRenderTodoPickerPopup(allTodos, category);
        return;
    }
    var field = category === 'blocked-by' ? 'blocked_by' : 'dependencies';
    var current = (qtDetailTodo && qtDetailTodo[field]) || [];
    var currentSet = {};
    current.forEach(function(id) { currentSet[id] = true; });
    var filtered = allTodos.filter(function(t) {
        if (!qtDetailTodo) return true;
        var ownRefs = [qtDetailTodo.id, (qtCurrentQuestId ? (qtCurrentQuestId + '/' + qtDetailTodo.id) : '')];
        return ownRefs.indexOf(t.ref || t.id) === -1;
    });
    list.innerHTML = filtered.map(function(t) {
        var refId = t.ref || t.id;
        var checked = currentSet[refId];
        return '<div class="qt-tag-picker-item" data-qt-pick-tag="' + qtEsc(refId) + '">' +
            '<input type="checkbox"' + (checked ? ' checked' : '') + '> ' +
            '<span style="font-weight:600;">' + qtEsc(refId) + '</span> — ' + qtEsc(t.title || '') + '</div>';
    }).join('');
    qtAttachTagPickerItemHandlers();
}

// ── Section renderers ──
function qtRenderScopeSection(scope) {
    var summary = qtBuildScopeSummary(scope);
    var filesBody = '';
    if (scope && scope.files && scope.files.length) {
        filesBody = '<div id="qt-scope-files-wrap" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px;">' +
            qtRenderScopeFilesBadges(scope.files) + '</div>';
    }
    return '<div class="qt-section-header" data-qt-section="scope">' +
        '<span class="codicon codicon-chevron-down"></span> Scope ' +
        '<button class="qt-edit-btn" id="qt-scope-edit-btn" title="Edit scope">✏️</button></div>' +
        '<div class="qt-section-body" data-qt-section-body="scope">' +
        '<div class="qt-scope-summary">' + qtEsc(summary) + '</div>' + filesBody + '</div>';
}

function qtGetScopeProjects(scope) {
    if (!scope) return [];
    if (scope.projects && scope.projects.length) return scope.projects.slice();
    if (scope.project) return [scope.project];
    return [];
}

function qtBuildScopeSummary(scope) {
    var summary = '(none)';
    if (scope) {
        var parts = [];
        var projects = qtGetScopeProjects(scope);
        if (projects.length) parts.push('projects: ' + projects.join(', '));
        if (scope.module) parts.push('module: ' + scope.module);
        if (scope.area) parts.push('area: ' + scope.area);
        if (scope.files && scope.files.length) parts.push(scope.files.length + ' file(s)');
        if (parts.length) summary = parts.join(', ');
    }
    return summary;
}

function qtRenderScopeFilesBadges(files) {
    return files.map(function(filePath) {
        var extBtn = qtPathExtAppAvailability[filePath] ? '<span class="qt-file-badge-ext" data-qt-file-ext="' + qtEsc(filePath) + '" title="Open in external app">🖥️</span>' : '';
        return '<span class="qt-file-badge" data-qt-file-path="' + qtEsc(filePath) + '" title="Open in editor">' +
            extBtn +
            '<span class="qt-file-badge-name">' + qtEsc(filePath) + '</span>' +
            '<span class="qt-file-badge-rm" data-qt-file-rm="' + qtEsc(filePath) + '" title="Remove">×</span>' +
            '</span>';
    }).join('');
}

function qtAttachScopeFileHandlers() {
    var wrap = document.getElementById('qt-scope-files-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.qt-file-badge').forEach(function(badge) {
        badge.addEventListener('click', function(e) {
            if (e.target.closest('.qt-file-badge-rm') || e.target.closest('.qt-file-badge-ext')) return;
            var p = badge.dataset.qtFilePath;
            if (p) vscode.postMessage({ type: 'qtOpenInEditor', path: p });
        });
    });
    wrap.querySelectorAll('.qt-file-badge-rm').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var p = btn.dataset.qtFileRm;
            if (!qtFormScope || !qtFormScope.files || !p) return;
            qtFormScope.files = qtFormScope.files.filter(function(f) { return f !== p; });
            if (!qtFormScope.files.length) delete qtFormScope.files;
            qtRefreshScopeBody();
            qtAutoSave();
        });
    });
    wrap.querySelectorAll('.qt-file-badge-ext').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var p = btn.dataset.qtFileExt;
            if (p) vscode.postMessage({ type: 'qtOpenRefExtApp', path: p });
        });
    });
}

function qtRefreshScopeBody(skipAvailabilityRefresh) {
    var body = document.querySelector('[data-qt-section-body="scope"]');
    if (!body) return;
    var summary = qtBuildScopeSummary(qtFormScope);
    var files = (qtFormScope && qtFormScope.files) ? qtFormScope.files : [];
    var filesBody = files.length
        ? '<div id="qt-scope-files-wrap" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px;">' + qtRenderScopeFilesBadges(files) + '</div>'
        : '';
    body.innerHTML = '<div class="qt-scope-summary">' + qtEsc(summary) + '</div>' + filesBody;
    qtAttachScopeFileHandlers();
    if (!skipAvailabilityRefresh) {
        qtRequestPathExtAppAvailability(files);
    }
}

function qtRenderRefsSection(refs) {
    var body = '';
    if (refs && refs.length) {
        body = '<div class="qt-ref-list">' + refs.map(function(r, i) {
            var pathText = r.path || '';
            if (pathText && r.lines) pathText += ' [' + r.lines + ']';
            var urlText = r.url || '';
            var descLine = r.description ? '<div style="font-size:11px;font-weight:600;">' + qtEsc(r.description) + '</div>' : '';
            var pathLine = pathText ? '<div style="font-size:11px;opacity:0.7;">Path: ' + qtEsc(pathText) + '</div>' : '';
            var urlLine = urlText ? '<div style="font-size:11px;opacity:0.7;">URL: ' + qtEsc(urlText) + '</div>' : '';
            var targetLine = (pathLine || urlLine) ? (pathLine + urlLine) : '<div style="font-size:11px;opacity:0.7;">(ref)</div>';
            var openInEditorBtn = '<button class="qt-edit-btn qt-ref-open-btn" data-qt-ref-idx="' + i + '" title="Open in editor">📄</button>';
            var openInExtBtn = (r.path && qtPathExtAppAvailability[r.path]) ? '<button class="qt-edit-btn qt-ref-ext-btn" data-qt-ref-idx="' + i + '" title="Open in external app">🖥️</button>' : '';
            return '<div class="qt-ref-item">' +
                '<span class="qt-ref-text">' + (descLine || '<div style="font-size:11px;font-weight:600;">(no description)</div>') + targetLine + '</span>' +
                openInEditorBtn + openInExtBtn +
                '<button class="qt-edit-btn qt-ref-edit-btn" data-qt-ref-idx="' + i + '" title="Edit">✏️</button>' +
                '<button class="qt-edit-btn qt-ref-rm-btn" data-qt-ref-idx="' + i + '" title="Remove">🗑️</button></div>';
        }).join('') + '</div>';
    } else {
        body = '<div class="qt-scope-summary">(none)</div>';
    }
    return '<div class="qt-section-header" data-qt-section="refs">' +
        '<span class="codicon codicon-chevron-down"></span> References ' +
        '<button class="qt-edit-btn" id="qt-ref-add-btn" title="Add reference">➕</button></div>' +
        '<div class="qt-section-body" data-qt-section-body="refs">' + body + '</div>';
}

function qtRenderDatesSection(todo) {
    return '<div class="qt-section-header" data-qt-section="dates">' +
        '<span class="codicon codicon-chevron-down"></span> Dates</div>' +
        '<div class="qt-section-body" data-qt-section-body="dates">' +
        '<div class="qt-inline-row">' +
        qtFormRow('Created', '<input type="date" id="qt-d-created-date" value="' + qtEsc(todo.created || '') + '">') +
        qtFormRow('Updated', '<input type="date" value="' + qtEsc(todo.updated || '') + '" readonly class="qt-readonly">') +
        '</div>' +
        '<div class="qt-inline-row">' +
        qtFormRow('Completed', '<input type="date" id="qt-d-completed-date" value="' + qtEsc(todo.completed_date || '') + '">') +
        qtFormRow('By', '<input id="qt-d-completed-by" value="' + qtEsc(todo.completed_by || '') + '">') +
        '</div></div>';
}

// Wire autosave on date fields (called after section rendered)
function qtAttachDateAutoSave() {
    var crEl = document.getElementById('qt-d-created-date');
    var cdEl = document.getElementById('qt-d-completed-date');
    var cbEl = document.getElementById('qt-d-completed-by');
    if (crEl) crEl.addEventListener('change', qtAutoSave);
    if (cdEl) cdEl.addEventListener('change', qtAutoSave);
    if (cbEl) cbEl.addEventListener('input', qtAutoSave);
}

// ── Tag helpers ──
function qtRenderTagChipsHtml(tags) {
    return tags.map(function(t) {
        return '<span class="qt-tag-chip">' + qtEsc(t) +
            '<span class="qt-remove-tag" data-qt-tag="' + qtEsc(t) + '">×</span></span>';
    }).join('');
}

function qtRefreshTagChips() {
    var c = document.getElementById('qt-d-tags');
    if (!c) return;
    c.innerHTML = qtRenderTagChipsHtml(qtFormTags);
    qtAttachTagRemoveHandlers();
}

function qtAttachTagRemoveHandlers() {
    document.querySelectorAll('#qt-d-tags .qt-remove-tag').forEach(function(el) {
        el.addEventListener('click', function() {
            var idx = qtFormTags.indexOf(el.dataset.qtTag);
            if (idx >= 0) qtFormTags.splice(idx, 1);
            qtRefreshTagChips();
            qtAutoSave();
        });
    });
}

// ── Collapsible section + scope/ref event wiring ──
function qtAttachSectionHandlers() {
    document.querySelectorAll('.qt-section-header').forEach(function(hdr) {
        hdr.addEventListener('click', function(e) {
            if (e.target.closest('.qt-edit-btn')) return;
            hdr.classList.toggle('collapsed');
            var key = hdr.dataset.qtSection;
            var body = document.querySelector('[data-qt-section-body="' + key + '"]');
            if (body) body.classList.toggle('hidden');
        });
    });
    var scopeBtn = document.getElementById('qt-scope-edit-btn');
    if (scopeBtn) scopeBtn.addEventListener('click', function(e) { e.stopPropagation(); qtShowScopePopup(); });
}

function qtAttachRefHandlers() {
    var addBtn = document.getElementById('qt-ref-add-btn');
    if (addBtn) addBtn.addEventListener('click', function(e) { e.stopPropagation(); qtShowRefPopup(-1); });
    document.querySelectorAll('.qt-ref-edit-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); qtShowRefPopup(parseInt(btn.dataset.qtRefIdx)); });
    });
    document.querySelectorAll('.qt-ref-rm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            qtFormRefs.splice(parseInt(btn.dataset.qtRefIdx), 1);
            qtRefreshRefsBody();
            qtAutoSave();
        });
    });
    document.querySelectorAll('.qt-ref-open-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var ref = qtFormRefs[parseInt(btn.dataset.qtRefIdx)];
            if (ref && (ref.path || ref.url)) {
                vscode.postMessage({ type: 'qtOpenInEditor', path: ref.path, url: ref.url, lines: ref.lines });
            }
        });
    });
    document.querySelectorAll('.qt-ref-ext-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var ref = qtFormRefs[parseInt(btn.dataset.qtRefIdx)];
            if (ref && ref.path) vscode.postMessage({ type: 'qtOpenRefExtApp', path: ref.path });
        });
    });
    qtAttachDateAutoSave();
}

function qtRefreshRefsBody(skipAvailabilityRefresh) {
    var body = document.querySelector('[data-qt-section-body="refs"]');
    if (!body) return;
    if (qtFormRefs.length) {
        body.innerHTML = '<div class="qt-ref-list">' + qtFormRefs.map(function(r, i) {
            var pathText = r.path || '';
            if (pathText && r.lines) pathText += ' [' + r.lines + ']';
            var urlText = r.url || '';
            var descLine = r.description ? '<div style="font-size:11px;font-weight:600;">' + qtEsc(r.description) + '</div>' : '';
            var pathLine = pathText ? '<div style="font-size:11px;opacity:0.7;">Path: ' + qtEsc(pathText) + '</div>' : '';
            var urlLine = urlText ? '<div style="font-size:11px;opacity:0.7;">URL: ' + qtEsc(urlText) + '</div>' : '';
            var targetLine = (pathLine || urlLine) ? (pathLine + urlLine) : '<div style="font-size:11px;opacity:0.7;">(ref)</div>';
            var openInEditorBtn = '<button class="qt-edit-btn qt-ref-open-btn" data-qt-ref-idx="' + i + '" title="Open in editor">📄</button>';
            var openInExtBtn = (r.path && qtPathExtAppAvailability[r.path]) ? '<button class="qt-edit-btn qt-ref-ext-btn" data-qt-ref-idx="' + i + '" title="Open in external app">🖥️</button>' : '';
            return '<div class="qt-ref-item">' +
                '<span class="qt-ref-text">' + (descLine || '<div style="font-size:11px;font-weight:600;">(no description)</div>') + targetLine + '</span>' +
                openInEditorBtn + openInExtBtn +
                '<button class="qt-edit-btn qt-ref-edit-btn" data-qt-ref-idx="' + i + '" title="Edit">✏️</button>' +
                '<button class="qt-edit-btn qt-ref-rm-btn" data-qt-ref-idx="' + i + '" title="Remove">🗑️</button></div>';
        }).join('') + '</div>';
    } else {
        body.innerHTML = '<div class="qt-scope-summary">(none)</div>';
    }
    if (!skipAvailabilityRefresh) {
        var refPaths = qtFormRefs.filter(function(r) { return !!r.path; }).map(function(r) { return r.path; });
        qtRequestPathExtAppAvailability(refPaths);
    }
    qtAttachRefHandlers();
}

function qtRequestPathExtAppAvailability(paths) {
    var uniq = [];
    var seen = {};
    (paths || []).forEach(function(p) {
        if (!p || seen[p]) return;
        seen[p] = true;
        uniq.push(p);
    });
    if (uniq.length) {
        vscode.postMessage({ type: 'qtCheckPathExtApps', paths: uniq });
    }
}

// ── Popup infrastructure ──
function qtShowPopup(html) {
    var ov = document.getElementById('qt-popup-overlay');
    var ct = document.getElementById('qt-popup-content');
    if (!ov || !ct) return;
    ct.innerHTML = html;
    ov.classList.add('visible');
    if (!window._qtPopupOverlayCloseBound) {
        window._qtPopupOverlayCloseBound = true;
        ov.addEventListener('click', function(e) {
            if (e.target === ov) {
                window._qtTodoPickerCategory = null;
                qtClosePopup();
            }
        });
    }
}
function qtClosePopup() {
    var ov = document.getElementById('qt-popup-overlay');
    var ct = document.getElementById('qt-popup-content');
    if (ov) ov.classList.remove('visible');
    if (ct) ct.innerHTML = '';
}

function qtShowScopePopup() {
    var s = qtFormScope || {};
    var projects = qtGetScopeProjects(s);
    window._qtScopePopupProjects = projects.slice();
    window._qtScopePopupFiles = (s.files || []).slice();

    var html = '<h4>Edit Scope</h4>' +
        qtFormRow('Projects', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div id="qt-p-scope-projects" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;flex:1;"></div>' +
            '<button class="qt-edit-btn" id="qt-p-scope-projects-pick" title="Pick projects">📦 Pick...</button></div>') +
        qtFormRow('Module', '<input id="qt-p-scope-module" list="qt-dl-modules" value="' + qtEsc(s.module || '') + '" placeholder="Select or type...">' +
            '<datalist id="qt-dl-modules"></datalist>') +
        qtFormRow('Area', '<input id="qt-p-scope-area" list="qt-dl-areas" value="' + qtEsc(s.area || '') + '" placeholder="Select or type...">' +
            '<datalist id="qt-dl-areas"></datalist>') +
        qtFormRow('Files', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div id="qt-p-scope-files-badges" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;flex:1;"></div>' +
            '<button class="qt-edit-btn" id="qt-p-scope-files-browse" title="Browse workspace files">📂 Browse...</button></div>') +
        '<div class="qt-popup-actions">' +
        '<button class="primary" id="qt-p-scope-ok">OK</button>' +
        '<button class="icon-btn" id="qt-p-scope-cancel">Cancel</button></div>';
    qtShowPopup(html);

    var renderProjects = function() {
        var el = document.getElementById('qt-p-scope-projects');
        if (!el) return;
        var arr = window._qtScopePopupProjects || [];
        if (!arr.length) {
            el.innerHTML = '<span class="qt-scope-summary">(none)</span>';
            return;
        }
        el.innerHTML = arr.map(function(p) {
            return '<span class="qt-tag-chip" data-qt-scope-proj="' + qtEsc(p) + '">' + qtEsc(p) +
                '<span class="qt-remove-tag" data-qt-scope-proj-rm="' + qtEsc(p) + '">×</span></span>';
        }).join('');
        el.querySelectorAll('[data-qt-scope-proj-rm]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var p = btn.dataset.qtScopeProjRm;
                window._qtScopePopupProjects = (window._qtScopePopupProjects || []).filter(function(v) { return v !== p; });
                renderProjects();
            });
        });
    };

    var renderFiles = function() {
        var el = document.getElementById('qt-p-scope-files-badges');
        if (!el) return;
        var arr = window._qtScopePopupFiles || [];
        if (!arr.length) {
            el.innerHTML = '<span class="qt-scope-summary">(none)</span>';
            return;
        }
        el.innerHTML = arr.map(function(p) {
            var extBtn = qtPathExtAppAvailability[p] ? '<span class="qt-file-badge-ext" data-qt-scope-file-ext="' + qtEsc(p) + '" title="Open in external app">🖥️</span>' : '';
            return '<span class="qt-file-badge" data-qt-scope-file="' + qtEsc(p) + '">' +
                extBtn +
                '<span class="qt-file-badge-name">' + qtEsc(p) + '</span>' +
                '<span class="qt-file-badge-rm" data-qt-scope-file-rm="' + qtEsc(p) + '" title="Remove">×</span></span>';
        }).join('');
        el.querySelectorAll('[data-qt-scope-file]').forEach(function(badge) {
            badge.addEventListener('click', function(e) {
                if (e.target.closest('[data-qt-scope-file-rm]') || e.target.closest('[data-qt-scope-file-ext]')) return;
                var p = badge.dataset.qtScopeFile;
                if (p) vscode.postMessage({ type: 'qtOpenInEditor', path: p });
            });
        });
        el.querySelectorAll('[data-qt-scope-file-rm]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var p = btn.dataset.qtScopeFileRm;
                window._qtScopePopupFiles = (window._qtScopePopupFiles || []).filter(function(v) { return v !== p; });
                renderFiles();
            });
        });
        el.querySelectorAll('[data-qt-scope-file-ext]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var p = btn.dataset.qtScopeFileExt;
                if (p) vscode.postMessage({ type: 'qtOpenRefExtApp', path: p });
            });
        });
        qtRequestPathExtAppAvailability(arr);
    };

    window._qtRenderScopePopupProjects = renderProjects;
    window._qtRenderScopePopupFiles = renderFiles;
    renderProjects();
    renderFiles();

    vscode.postMessage({ type: 'qtGetScopeData' });
    document.getElementById('qt-p-scope-projects-pick').addEventListener('click', function() {
        vscode.postMessage({ type: 'qtPickProjects', selected: window._qtScopePopupProjects || [] });
    });
    document.getElementById('qt-p-scope-files-browse').addEventListener('click', function() {
        vscode.postMessage({ type: 'qtBrowseFile', purpose: 'scope-files' });
    });
    document.getElementById('qt-p-scope-ok').addEventListener('click', function() {
        var projList = (window._qtScopePopupProjects || []).slice();
        var mod = document.getElementById('qt-p-scope-module').value.trim();
        var area = document.getElementById('qt-p-scope-area').value.trim();
        var files = (window._qtScopePopupFiles || []).slice();
        if (!projList.length && !mod && !area && !files.length) {
            qtFormScope = null;
        } else {
            qtFormScope = {};
            if (projList.length) {
                qtFormScope.projects = projList;
                qtFormScope.project = projList[0];
            }
            if (mod) qtFormScope.module = mod;
            if (area) qtFormScope.area = area;
            if (files.length) qtFormScope.files = files;
        }
        qtClosePopup();
        qtRefreshScopeBody();
        qtAutoSave();
    });
    document.getElementById('qt-p-scope-cancel').addEventListener('click', function() {
        qtClosePopup();
    });
}

function qtShowRefPopup(editIdx) {
    var r = editIdx >= 0 ? (qtFormRefs[editIdx] || {}) : {};
    var title = editIdx >= 0 ? 'Edit Reference' : 'Add Reference';
    var html = '<h4>' + title + '</h4>' +
        qtFormRow('Path', '<div style="display:flex;gap:4px;align-items:center;"><input id="qt-p-ref-path" value="' + qtEsc(r.path || '') + '" placeholder="Relative file path" style="flex:1;">' +
            '<button class="qt-edit-btn" id="qt-p-ref-browse" title="Browse...">📂</button></div>') +
        qtFormRow('URL', '<input id="qt-p-ref-url" value="' + qtEsc(r.url || '') + '" placeholder="https://...">') +
        qtFormRow('Description', '<input id="qt-p-ref-desc" value="' + qtEsc(r.description || '') + '">') +
        qtFormRow('Lines', '<input id="qt-p-ref-lines" value="' + qtEsc(r.lines || '') + '" placeholder="e.g. 10-20">') +
        '<div class="qt-popup-actions">' +
        '<button class="primary" id="qt-p-ref-ok">OK</button>' +
        '<button class="icon-btn" id="qt-p-ref-cancel">Cancel</button></div>';
    qtShowPopup(html);
    document.getElementById('qt-p-ref-browse').addEventListener('click', function() {
        vscode.postMessage({ type: 'qtBrowseFile', purpose: 'ref-path' });
    });
    document.getElementById('qt-p-ref-ok').addEventListener('click', function() {
        var ref = {};
        var p = document.getElementById('qt-p-ref-path').value.trim();
        var u = document.getElementById('qt-p-ref-url').value.trim();
        var d = document.getElementById('qt-p-ref-desc').value.trim();
        var l = document.getElementById('qt-p-ref-lines').value.trim();
        if (p) ref.path = p;
        if (u) ref.url = u;
        if (d) ref.description = d;
        if (l) ref.lines = l;
        if (!p && !u && !d) { qtClosePopup(); return; }
        if (editIdx >= 0) { qtFormRefs[editIdx] = ref; } else { qtFormRefs.push(ref); }
        qtClosePopup();
        qtRefreshRefsBody();
        qtAutoSave();
    });
    document.getElementById('qt-p-ref-cancel').addEventListener('click', qtClosePopup);
}

function qtShowTagPicker() {
    qtTagPickerCallback = function(allTags) {
        var currentSet = {};
        qtFormTags.forEach(function(t) { currentSet[t] = true; });
        var selectedQuest = qtTagPickerScope === 'quest' ? ' selected' : '';
        var selectedAll = qtTagPickerScope === 'all' ? ' selected' : '';
        var html = '<h4>Select Tags</h4>' +
            '<div class="qt-inline-row" style="margin-bottom:6px;">' +
            '<select id="qt-p-tag-scope" style="flex:1;">' +
            '<option value="quest"' + selectedQuest + '>Only this quest</option>' +
            '<option value="all"' + selectedAll + '>All quests in workspace</option></select></div>' +
            '<input id="qt-p-tag-filter" placeholder="Filter tags..." style="width:100%;margin-bottom:6px;">' +
            '<div class="qt-tag-picker-list" id="qt-tag-picker-list">' +
            qtBuildTagPickerItems(allTags, currentSet) +
            '</div>' +
            '<input id="qt-p-new-tag" placeholder="New tag...">' +
            '<div class="qt-popup-actions">' +
            '<button class="primary" id="qt-p-tag-ok">OK</button>' +
            '<button class="icon-btn" id="qt-p-tag-cancel">Cancel</button></div>';
        qtShowPopup(html);
        qtAttachTagPickerItemHandlers();
        document.getElementById('qt-p-tag-scope').addEventListener('change', function() {
            var scope = this.value;
            qtTagPickerScope = (scope === 'quest') ? 'quest' : 'all';
            qtPersistState();
            var questId = scope === 'quest' ? qtCurrentQuestId : '';
            vscode.postMessage({ type: 'qtGetAllTags', questId: questId });
        });
        document.getElementById('qt-p-tag-filter').addEventListener('input', function() {
            var q = this.value.toLowerCase();
            document.querySelectorAll('.qt-tag-picker-item').forEach(function(item) {
                item.style.display = (item.dataset.qtPickTag || '').toLowerCase().indexOf(q) >= 0 ? '' : 'none';
            });
        });
        document.getElementById('qt-p-tag-ok').addEventListener('click', function() {
            var selected = [];
            document.querySelectorAll('.qt-tag-picker-item').forEach(function(item) {
                var cb = item.querySelector('input[type="checkbox"]');
                if (cb && cb.checked) selected.push(item.dataset.qtPickTag);
            });
            var newTag = document.getElementById('qt-p-new-tag').value.trim();
            if (newTag && selected.indexOf(newTag) < 0) selected.push(newTag);
            qtFormTags = selected;
            qtClosePopup();
            qtRefreshTagChips();
            qtAutoSave();
        });
        document.getElementById('qt-p-tag-cancel').addEventListener('click', qtClosePopup);
    };
    vscode.postMessage({ type: 'qtGetAllTags', questId: qtTagPickerScope === 'quest' ? qtCurrentQuestId : '' });
}

function qtBuildTagPickerItems(tags, currentSet) {
    return tags.map(function(t) {
        var sel = currentSet[t] ? ' selected' : '';
        return '<div class="qt-tag-picker-item' + sel + '" data-qt-pick-tag="' + qtEsc(t) + '">' +
            '<input type="checkbox"' + (currentSet[t] ? ' checked' : '') + '> ' + qtEsc(t) + '</div>';
    }).join('');
}

function qtAttachTagPickerItemHandlers() {
    document.querySelectorAll('.qt-tag-picker-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            var cb = item.querySelector('input[type="checkbox"]');
            if (cb && e.target !== cb) cb.checked = !cb.checked;
            item.classList.toggle('selected', cb ? cb.checked : false);
        });
    });
}

function qtCollectFormData() {
    var tags = qtFormTags.slice();
    // Collect blocked-by and deps from badges in the detail todo
    var deps = qtDetailTodo && qtDetailTodo.dependencies ? qtDetailTodo.dependencies.slice() : [];
    var blockedBy = qtDetailTodo && qtDetailTodo.blocked_by ? qtDetailTodo.blocked_by.slice() : [];
    // Fallback: collect from input fields if present (new todo form)
    var depsEl = document.getElementById('qt-d-deps');
    if (depsEl) {
        var depsVal = depsEl.value.trim();
        deps = depsVal ? depsVal.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
    }
    var blockedByEl = document.getElementById('qt-d-blocked-by');
    if (blockedByEl) {
        var blockedByVal = blockedByEl.value.trim();
        blockedBy = blockedByVal ? blockedByVal.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
    }
    var completedDate = document.getElementById('qt-d-completed-date');
    var completedBy = document.getElementById('qt-d-completed-by');
    var completedDateValue = completedDate ? completedDate.value.trim() : '';
    var completedByValue = completedBy ? completedBy.value.trim() : '';
    if (completedDateValue && !completedByValue && qtUserName) {
        completedByValue = qtUserName;
        if (completedBy) completedBy.value = completedByValue;
    }
    var createdEl = document.getElementById('qt-d-created-date') || document.getElementById('qt-d-created');
    var createdValue = createdEl ? createdEl.value.trim() : '';
    return {
        title: document.getElementById('qt-d-title') ? document.getElementById('qt-d-title').value : '',
        status: document.getElementById('qt-d-status') ? document.getElementById('qt-d-status').value : '',
        priority: document.getElementById('qt-d-priority') ? document.getElementById('qt-d-priority').value || undefined : undefined,
        description: document.getElementById('qt-d-desc') ? document.getElementById('qt-d-desc').value : '',
        tags: tags.length ? tags : undefined,
        dependencies: deps.length ? deps : undefined,
        blocked_by: blockedBy.length ? blockedBy : undefined,
        notes: document.getElementById('qt-d-notes') ? document.getElementById('qt-d-notes').value || undefined : undefined,
        scope: qtFormScope || undefined,
        references: qtFormRefs.length ? qtFormRefs : undefined,
        created: createdValue || undefined,
        completed_date: completedDateValue || undefined,
        completed_by: completedByValue || undefined,
    };
}

function qtShowNewTodoForm(id) {
    qtSelectedTodoId = '';
    qtFormTags = [];
    qtFormScope = null;
    qtFormRefs = [];
    qtRenderList();
    var pane = document.getElementById('qt-detail-pane');
    if (!pane) return;
    var today = new Date().toISOString().slice(0, 10);
    pane.innerHTML = '<div class="qt-detail-form">' +
        qtFormRow('ID', '<input id="qt-d-id" value="' + qtEsc(id) + '">') +
        qtFormRow('Created', '<div style="display:flex;gap:4px;align-items:center;">' +
            '<input type="date" id="qt-d-created" value="' + qtEsc(today) + '" style="flex:1;">' +
            '<button class="icon-btn" id="qt-d-created-pick" title="Select date"><span class="codicon codicon-calendar"></span></button></div>') +
        qtFormRow('Title', '<input id="qt-d-title" value="">') +
        qtFormRow('Description', '<textarea id="qt-d-desc" data-completion="on"></textarea>') +
        '<div class="qt-inline-row">' +
        qtFormRow('Status', '<select id="qt-d-status">' + qtStatusOptions('not-started') + '</select>') +
        qtFormRow('Priority', '<select id="qt-d-priority">' + qtPriorityOptions('medium') + '</select>') +
        '</div>' +
        qtFormRow('Tags', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div class="qt-tag-chips" id="qt-d-tags"></div>' +
            '<input class="qt-tag-input" id="qt-d-tag-input" placeholder="Add tag...">' +
            '<button class="qt-edit-btn" id="qt-d-tag-picker-btn" title="Pick from existing tags">🏷️</button></div>') +
        qtFormRow('Dependencies', '<input id="qt-d-deps" placeholder="Comma-separated IDs">') +
        qtFormRow('Blocked By', '<input id="qt-d-blocked-by" placeholder="Comma-separated: todoId or questId/todoId">') +
        qtFormRow('Notes', '<textarea id="qt-d-notes" data-completion="on"></textarea>') +
        qtRenderScopeSection(null) +
        qtRenderRefsSection([]) +
        '<div class="qt-form-actions">' +
        '<button class="primary" id="qt-btn-create"><span class="codicon codicon-add"></span> Create</button>' +
        '<button class="qt-btn-secondary" id="qt-btn-cancel-create">Cancel</button>' +
        '</div></div>';

    document.getElementById('qt-d-tag-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && this.value.trim()) {
            qtFormTags.push(this.value.trim());
            this.value = '';
            qtRefreshTagChips();
        }
    });
    document.getElementById('qt-d-tag-picker-btn').addEventListener('click', function() { qtShowTagPicker(); });
    var createdPickBtn = document.getElementById('qt-d-created-pick');
    if (createdPickBtn) createdPickBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var createdEl = document.getElementById('qt-d-created');
        if (!createdEl) return;
        if (typeof createdEl.showPicker === 'function') createdEl.showPicker();
        else createdEl.focus();
    });
    qtAttachSectionHandlers();
    qtAttachRefHandlers();
    document.getElementById('qt-btn-create').addEventListener('click', function() {
        var data = qtCollectFormData();
        data.id = document.getElementById('qt-d-id') ? document.getElementById('qt-d-id').value.trim() : '';
        var missing = [];
        if (!data.id) missing.push('ID');
        if (!data.description) missing.push('Description');
        if (missing.length) {
            vscode.postMessage({ type: 'qtShowError', message: 'Please enter: ' + missing.join(', ') });
            return;
        }
        vscode.postMessage({ type: 'qtCreateTodo', questId: qtCurrentQuestId, todo: data, file: qtCurrentFile });
    });
    document.getElementById('qt-btn-cancel-create').addEventListener('click', function() {
        var pane = document.getElementById('qt-detail-pane');
        if (pane) pane.innerHTML = '<div class="qt-empty-detail">Select a todo to view details</div>';
    });
}

function qtFormRow(label, input) { return '<div class="qt-form-row"><label>' + label + '</label>' + input + '</div>'; }

function qtShowMassAddOverlay() {
    var overlay = document.getElementById('qt-mass-overlay');
    var panel = document.getElementById('qt-mass-panel');
    if (!overlay || !panel) return;
    var count = 15;
    var html = '<h3>Mass Add Todos</h3>';
    for (var i = 0; i < count; i++) {
        var num = i + 1;
        var defId = 'todo-' + Date.now().toString(36) + '-' + num;
        html += '<div class="qt-mass-row" data-qt-mass-idx="' + i + '">' +
            '<div class="qt-mass-r1">' +
            '<span class="qt-mass-row-num">' + num + '</span>' +
            '<input name="id" placeholder="ID" value="' + defId + '">' +
            '<input name="title" placeholder="Title (required)">' +
            '<select name="priority"><option value="low">low</option><option value="medium" selected>medium</option><option value="high">high</option><option value="critical">critical</option></select>' +
            '</div>' +
            '<div class="qt-mass-r2"><textarea name="description" placeholder="Description (optional)" data-completion="on"></textarea></div>' +
            '</div>';
    }
    html += '<div class="qt-mass-footer">' +
        '<button class="secondary" id="qt-mass-cancel">Cancel</button>' +
        '<button class="primary" id="qt-mass-create">Create Todos</button>' +
        '</div>';
    panel.innerHTML = html;
    overlay.classList.add('visible');
    document.getElementById('qt-mass-cancel').addEventListener('click', function() {
        overlay.classList.remove('visible');
    });
    document.getElementById('qt-mass-create').addEventListener('click', function() {
        var rows = panel.querySelectorAll('.qt-mass-row');
        var todos = [];
        for (var j = 0; j < rows.length; j++) {
            var row = rows[j];
            var idVal = row.querySelector('input[name="id"]').value.trim();
            var titleVal = row.querySelector('input[name="title"]').value.trim();
            var priVal = row.querySelector('select[name="priority"]').value;
            var descVal = row.querySelector('textarea[name="description"]').value.trim();
            if (!idVal || !titleVal) continue;
            todos.push({ id: idVal, title: titleVal, priority: priVal, description: descVal || titleVal, status: 'not-started' });
        }
        if (!todos.length) {
            vscode.postMessage({ type: 'qtShowError', message: 'Fill in at least one row (ID + Title required).' });
            return;
        }
        vscode.postMessage({ type: 'qtMassCreate', questId: qtCurrentQuestId, file: qtCurrentFile, todos: todos });
        overlay.classList.remove('visible');
    });
    // Close overlay on background click
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) overlay.classList.remove('visible');
    });
}
function qtEsc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function qtStatusOptions(cur) {
    var opts = ['not-started','in-progress','blocked','completed','cancelled'];
    return opts.map(function(o) { return '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>'; }).join('');
}
function qtPriorityOptions(cur) {
    var opts = ['','low','medium','high','critical'];
    return '<option value="">(none)</option>' + opts.filter(Boolean).map(function(o) { return '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>'; }).join('');
}

// ── Quest TODO Message listener (handled via accordion message routing) ──
function qtHandleMessage(msg) {
    switch(msg.type) {
        case 'qtQuests':
            var sel = document.getElementById('qt-quest-select');
            if (sel) {
                sel.innerHTML = msg.quests.map(function(q) { return '<option value="' + q + '"' + (q === msg.activeQuest ? ' selected' : '') + '>' + q + '</option>'; }).join('') +
                    '<option disabled>──────────</option>' +
                    '<option value="__all_quests__">All quests</option>' +
                    '<option value="__all_workspace__">All workspace todos</option>';
                if (msg.activeQuest) qtCurrentQuestId = msg.activeQuest;
                else if (msg.quests.length) qtCurrentQuestId = msg.quests[0];
            }
            // Pre-select the default file if the backend specifies one
            if (msg.defaultFile) {
                qtCurrentFile = msg.defaultFile;
                var dfsel = document.getElementById('qt-file-select');
                if (dfsel) dfsel.value = msg.defaultFile;
            }
            break;
        case 'qtFiles':
            var fsel = document.getElementById('qt-file-select');
            if (fsel) {
                var curFile = qtCurrentFile;
                fsel.innerHTML = '<option value="all">All files</option>' +
                    msg.files.map(function(f) { return '<option value="' + qtEsc(f) + '"' + (f === curFile ? ' selected' : '') + '>' + qtEsc(f) + '</option>'; }).join('');
                // Explicitly set value after innerHTML rebuild to ensure selection sticks
                if (curFile && curFile !== 'all') fsel.value = curFile;
            }
            break;
        case 'qtTodos':
            // If viewing backup, ignore non-backup refreshes (e.g. from file watchers)
            if (qtViewingBackup && !msg.fromBackup) break;
            qtTodos = msg.todos || [];
            qtRenderList();
            // If the previously-selected todo is gone (file emptied, switched,
            // or the entry removed externally), revert the detail pane to the
            // empty "pick a todo" state instead of stranding a stale edit form
            // for an entry that no longer exists (Bug 2).
            if (qtSelectedTodoId && !qtTodos.some(function(t) { return t.id === qtSelectedTodoId; })) {
                qtSelectedTodoId = '';
                var dpStale = document.getElementById('qt-detail-pane');
                if (dpStale) dpStale.innerHTML = '<div class="qt-empty-detail">Select a todo to view details</div>';
            }
            if (qtPendingSelectTodoId) {
                var exists = qtTodos.some(function(t) { return t.id === qtPendingSelectTodoId; });
                if (exists) {
                    qtSelectedTodoId = qtPendingSelectTodoId;
                    qtNavPush(qtSelectedTodoId);
                    qtRenderList();
                    vscode.postMessage({ type: 'qtGetTodo', questId: qtCurrentQuestId, todoId: qtSelectedTodoId });
                    qtPendingSelectTodoId = '';
                    vscode.postMessage({ type: 'qtConsumePendingSelect' });
                }
            }
            break;
        case 'qtTodoDetail':
            if (msg.todo) qtRenderDetail(msg.todo);
            break;
        case 'qtSaved':
            if (msg.success) qtRenderList();
            break;
        case 'qtCreated':
            if (msg.success) {
                qtSelectedTodoId = msg.todo ? (msg.todo.id || '') : '';
                // Auto-refresh list from backend to pick up new todo
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                if (msg.todo) qtRenderDetail(msg.todo);
            }
            break;
        case 'qtDeleted':
            if (msg.success) {
                qtSelectedTodoId = '';
                var dp = document.getElementById('qt-detail-pane');
                if (dp) dp.innerHTML = '<div class="qt-empty-detail">Select a todo to view details</div>';
                // Remove deleted item client-side and re-render immediately
                qtTodos = qtTodos.filter(function(t) { return t.id !== msg.todoId; });
                qtRenderList();
                if (qtViewingBackup) {
                    // Backup deletes need a backend refresh (no server-side push)
                    vscode.postMessage({ type: 'qtGetBackupTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                }
                // Re-check backup existence after delete (backup may now exist or be empty)
                vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
            }
            break;
        case 'qtBackupStatus': {
            var bkBtn = document.getElementById('qt-btn-toggle-backup');
            if (bkBtn) {
                bkBtn.style.display = msg.exists ? '' : 'none';
                if (!msg.exists && qtViewingBackup) {
                    qtViewingBackup = false;
                    bkBtn.classList.remove('active-indicator');
                    bkBtn.title = 'Switch to backup file';
                }
            }
            break;
        }
        case 'qtStatusConfirmResult':
            if (!qtPendingStatusChange) break;
            var pending = qtPendingStatusChange;
            qtPendingStatusChange = null;
            if (!msg.confirmed) break;
            var statusSel = document.getElementById('qt-d-status');
            if (statusSel) statusSel.value = pending.status;
            var today = new Date().toISOString().slice(0, 10);
            var cdInput = document.getElementById('qt-d-completed-date');
            var cbInput = document.getElementById('qt-d-completed-by');
            if (cdInput) cdInput.value = today;
            if (cbInput) cbInput.value = qtUserName || cbInput.value || '';
            if (qtDetailTodo) qtDetailTodo.status = pending.status;
            qtAutoSave();
            break;
        case 'qtState':
            if (msg.state) {
                var st = msg.state;
                if (st.sortFields && st.sortFields.length) {
                    qtSortFields = st.sortFields;
                    var sortBtn = document.getElementById('qt-btn-sort');
                    if (sortBtn) sortBtn.classList.add('active-indicator');
                }
                if (st.tagScope === 'quest' || st.tagScope === 'all') {
                    qtTagPickerScope = st.tagScope;
                }
                if (st.filterState) {
                    var fs = st.filterState;
                    qtFilterState = {
                        status: fs.status || [],
                        priority: fs.priority || [],
                        tags: fs.tags || [],
                        createdFrom: fs.createdFrom || '',
                        createdTo: fs.createdTo || '',
                        updatedFrom: fs.updatedFrom || '',
                        updatedTo: fs.updatedTo || '',
                        completedFrom: fs.completedFrom || '',
                        completedTo: fs.completedTo || ''
                    };
                    qtUpdateFilterIndicator();
                }
            }
            break;
        case 'qtPickedProjects':
            if (Array.isArray(msg.projects)) {
                window._qtScopePopupProjects = msg.projects;
                if (window._qtRenderScopePopupProjects) window._qtRenderScopePopupProjects();
            }
            break;
        case 'qtPathExtAppAvailability':
            if (msg.paths) {
                Object.keys(msg.paths).forEach(function(p) { qtPathExtAppAvailability[p] = !!msg.paths[p]; });
                qtRefreshRefsBody(true);
                qtRefreshScopeBody(true);
            }
            break;
        case 'qtAllTags':
            if (msg.tags) {
                if (qtTagPickerCallback) {
                    qtTagPickerCallback(msg.tags);
                    qtTagPickerCallback = null;
                } else {
                    // Scope changed — refresh list in-place preserving checked state
                    var list = document.getElementById('qt-tag-picker-list');
                    if (list) {
                        var checked = {};
                        list.querySelectorAll('.qt-tag-picker-item').forEach(function(it) {
                            var cb = it.querySelector('input[type="checkbox"]');
                            if (cb && cb.checked) checked[it.dataset.qtPickTag] = true;
                        });
                        qtFormTags.forEach(function(t) { checked[t] = true; });
                        list.innerHTML = qtBuildTagPickerItems(msg.tags, checked);
                        qtAttachTagPickerItemHandlers();
                    }
                }
            }
            break;
        case 'qtScopeData':
            // Populate datalists in scope popup
            var dlProj = document.getElementById('qt-dl-projects');
            var dlMod = document.getElementById('qt-dl-modules');
            var dlArea = document.getElementById('qt-dl-areas');
            if (dlProj && msg.projects) dlProj.innerHTML = msg.projects.map(function(p) { return '<option value="' + qtEsc(p) + '">'; }).join('');
            if (dlMod && msg.modules) dlMod.innerHTML = msg.modules.map(function(m) { return '<option value="' + qtEsc(m) + '">'; }).join('');
            if (dlArea && msg.areas) dlArea.innerHTML = msg.areas.map(function(a) { return '<option value="' + qtEsc(a) + '">'; }).join('');
            break;
        case 'qtBrowsedFile':
            if (msg.purpose === 'scope-files') {
                if (!window._qtScopePopupFiles) window._qtScopePopupFiles = [];
                if (window._qtScopePopupFiles.indexOf(msg.path) < 0) {
                    window._qtScopePopupFiles.push(msg.path);
                }
                if (window._qtRenderScopePopupFiles) {
                    window._qtRenderScopePopupFiles();
                } else {
                    var ta = document.getElementById('qt-p-scope-files');
                    if (ta) { ta.value = ta.value ? ta.value + '\\n' + msg.path : msg.path; }
                }
            } else if (msg.purpose === 'ref-path') {
                var inp = document.getElementById('qt-p-ref-path');
                if (inp) inp.value = msg.path;
            }
            break;
        case 'qtUserNameResult':
            if (msg.userName) qtUserName = msg.userName;
            break;
        case 'qtExtAppAvailable':
            var extBtn = document.getElementById('qt-btn-open-ext');
            if (extBtn) extBtn.style.display = msg.available ? '' : 'none';
            break;
        case 'qtTodosForPicker':
            if (msg.questIds) { window._qtPickerQuestList = msg.questIds; }
            if (msg.todos && window._qtTodoPickerCategory) {
                qtUpdateTodoPickerList(msg.todos, window._qtTodoPickerCategory);
                // Update quest dropdown if it was empty and we now have quest list
                var tpQuest = document.getElementById('qt-tp-quest');
                if (tpQuest && tpQuest.options.length === 0 && window._qtPickerQuestList) {
                    window._qtPickerQuestList.forEach(function(q) {
                        var opt = document.createElement('option');
                        opt.value = q;
                        opt.textContent = q;
                        tpQuest.appendChild(opt);
                    });
                }
            }
            break;
        case 'qtTemplates': {
            var templateSel = document.getElementById('qt-template-select');
            if (templateSel) {
                var selected = msg.selected || '__none__';
                templateSel.innerHTML = (msg.templates || []).map(function(t) {
                    return '<option value="' + qtEsc(t.id) + '">' + qtEsc(t.label) + '</option>';
                }).join('');
                templateSel.value = selected;
                if (templateSel.value !== selected) templateSel.value = '__none__';
                qtCurrentTemplate = templateSel.value || '__none__';
            }
            break;
        }
        case 'qtMassCreated':
            if (msg.success) {
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            }
            break;
        case 'qtPendingSelect': {
            var st = msg.state || {};
            var todoId = st.todoId || '';
            var targetFile = st.file || '';
            var targetQuestId = st.questId || '';
            if (todoId) {
                qtPendingSelectTodoId = todoId;
                // Switch quest if specified and different
                if (targetQuestId && targetQuestId !== qtCurrentQuestId) {
                    qtCurrentQuestId = targetQuestId;
                    var qsel0 = document.getElementById('qt-quest-select');
                    if (qsel0) qsel0.value = targetQuestId;
                    // Request updated file list for the new quest
                    vscode.postMessage({ type: 'qtGetFiles', questId: targetQuestId });
                }
                if (targetFile) {
                    qtCurrentFile = targetFile;
                    var fsel0 = document.getElementById('qt-file-select');
                    if (fsel0) fsel0.value = targetFile;
                }
                // Always request a refresh so the pending select gets consumed
                vscode.postMessage({ type: 'qtGetTodos', questId: targetQuestId || qtCurrentQuestId, file: targetFile || qtCurrentFile || 'all' });
            }
            break;
        }
    }
}
