// @ts-nocheck
/* global vscode, qtViewConfig, qtGroupTodosByPrefix, qtTodoPrefix, qtCompareTodoIds, tomMdOverlayShow */
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
// Decisions the user still has to make. `qtDecisionOpen` is index-aligned and
// spliced in lock-step so an expanded row stays expanded across a re-render.
var qtFormDecisions = [];
var qtDecisionOpen = [];
var qtTagPickerCallback = null;
var qtFilterSearch = '';
/** A filter that keeps every todo. `userAction`: [] all, ['yes'] the user's own todos, ['no'] the others. */
function qtEmptyFilterState() {
    return { status: [], priority: [], tags: [], userAction: [], blocking: [], createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', completedFrom: '', completedTo: '' };
}
var qtFilterState = qtEmptyFilterState();
var qtSortFields = []; // [{field,asc}]
var SORTABLE_FIELDS = ['id','quest','status','priority','title','created','updated','completed_date'];
/** Group the list by id prefix (the sort picker's Group checkbox; default on). */
var qtGroupByPrefix = true;
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
var qtPendingSelectTodoId = '';
// ── Todo stack (batch send/queue) ──
// Ordered list of stacked todos ({id, sourceFile}); the circle under each
// row's status icon shows the 1-based stack index. Save-to-Queue enqueues one
// prompt per stacked todo (in stack order); Send combines all stacked todos
// into a single prompt.
var qtStack = [];
var qtLastStackedId = '';
var qtLastRenderOrder = [];
// ── Prefix groups ──
// Which groups are currently open, keyed by '#' + prefix (see
// qtGroupTodosByPrefix for why the keys are namespaced). Deliberately NOT
// persisted through qtPersistState: the list must come up fully collapsed
// after a window reload or a VS Code restart, and an empty set on every fresh
// script load IS that state — nothing to store, nothing to migrate.
var qtExpandedGroups = {};

function qtPersistState() {
    vscode.postMessage({ type: 'qtSaveState', state: {
        questId: qtCurrentQuestId,
        file: qtCurrentFile,
        tagScope: qtTagPickerScope,
        sortFields: qtSortFields,
        grouped: qtGroupByPrefix,
        filterState: qtFilterState
    }});
}

/** Source file (basename) of a todo currently in the list, or undefined. */
function qtSourceFileForId(id) {
    for (var i = 0; i < qtTodos.length; i++) {
        if (qtTodos[i].id === id) return qtTodos[i].sourceFile || undefined;
    }
    return undefined;
}

/**
 * Quest id a todo belongs to, for the "quest" sort field. In the all-quests
 * aggregate the backend prefixes each todo's sourceFile with `<questId>/`
 * (readAllQuestsTodos), so the quest is the segment before the first slash;
 * in any single-quest view every todo shares the current quest.
 */
function qtQuestKey(t) {
    var sf = (t && t.sourceFile) || '';
    var slash = sf.indexOf('/');
    if (slash > 0) return sf.substring(0, slash);
    return qtCurrentQuestId || '';
}

/**
 * Ask the backend for a todo's detail. Always includes the todo's source file
 * so the detail resolves from whichever quest file is being browsed — not just
 * the main todos.<quest>.todo.yaml (bug: detail pane empty on secondary files).
 */
function qtRequestTodoDetail(id) {
    vscode.postMessage({ type: 'qtGetTodo', questId: qtCurrentQuestId, todoId: id, sourceFile: qtSourceFileForId(id) });
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
        qtRequestTodoDetail(todoId);
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
    // Collapse-all button — closes every prefix group in the list pane.
    var btnCollapseAll = document.getElementById('qt-btn-collapse-all');
    if (btnCollapseAll) btnCollapseAll.addEventListener('click', function() { qtCollapseAllGroups(); });
    var btnExpandAll = document.getElementById('qt-btn-expand-all');
    if (btnExpandAll) btnExpandAll.addEventListener('click', function() { qtExpandAllGroups(); });
    var btnOnlyMine = document.getElementById('qt-btn-only-mine');
    if (btnOnlyMine) btnOnlyMine.addEventListener('click', function() { qtToggleOnlyUserActions(); });
    // Clear todo stack button
    var btnClearStack = document.getElementById('qt-btn-clear-stack');
    if (btnClearStack) btnClearStack.addEventListener('click', function() { qtClearStack(); });
    qtUpdateStackButtons();
    // Archive / delete-to-file buttons (TRA02)
    var btnArchive = document.getElementById('qt-btn-archive');
    var btnArchiveAll = document.getElementById('qt-btn-archive-all');
    var btnDeleteFile = document.getElementById('qt-btn-delete-file');
    var btnDeleteCancelled = document.getElementById('qt-btn-delete-cancelled');
    if (btnArchive) btnArchive.addEventListener('click', function() {
        // Stacked todos win: archive the whole stack (server confirms first).
        if (qtStack.length) {
            vscode.postMessage({ type: 'qtArchiveStackedTodos', questId: qtCurrentQuestId, file: qtCurrentFile, todos: qtStackPayload() });
            return;
        }
        var sel = qtSelectedTodoEntry();
        if (!sel) return;
        vscode.postMessage({ type: 'qtArchiveTodo', questId: qtCurrentQuestId, file: qtCurrentFile, todoId: sel.id, sourceFile: sel.sourceFile });
    });
    if (btnDeleteFile) btnDeleteFile.addEventListener('click', function() {
        // Stacked todos win: delete the whole stack (server confirms first).
        if (qtStack.length) {
            vscode.postMessage({ type: 'qtDeleteStackedTodos', questId: qtCurrentQuestId, file: qtCurrentFile, todos: qtStackPayload() });
            return;
        }
        var sel = qtSelectedTodoEntry();
        if (!sel) return;
        vscode.postMessage({ type: 'qtDeleteTodoToFile', questId: qtCurrentQuestId, file: qtCurrentFile, todoId: sel.id, sourceFile: sel.sourceFile });
    });
    if (btnArchiveAll) btnArchiveAll.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtArchiveAllCompleted', questId: qtCurrentQuestId, file: qtCurrentFile });
    });
    if (btnDeleteCancelled) btnDeleteCancelled.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtDeleteAllCancelled', questId: qtCurrentQuestId, file: qtCurrentFile });
    });
    // Complete / cancel buttons (set status in place; no file move).
    var btnComplete = document.getElementById('qt-btn-complete');
    var btnCancel = document.getElementById('qt-btn-cancel');
    if (btnComplete) btnComplete.addEventListener('click', function() {
        if (qtStack.length) {
            vscode.postMessage({ type: 'qtCompleteStackedTodos', questId: qtCurrentQuestId, file: qtCurrentFile, todos: qtStackPayload(), completedBy: qtUserName || undefined });
            return;
        }
        var sel = qtSelectedTodoEntry();
        if (!sel) return;
        vscode.postMessage({ type: 'qtCompleteTodo', questId: qtCurrentQuestId, file: qtCurrentFile, todoId: sel.id, sourceFile: sel.sourceFile, completedBy: qtUserName || undefined });
    });
    if (btnCancel) btnCancel.addEventListener('click', function() {
        if (qtStack.length) {
            vscode.postMessage({ type: 'qtCancelStackedTodos', questId: qtCurrentQuestId, file: qtCurrentFile, todos: qtStackPayload() });
            return;
        }
        var sel = qtSelectedTodoEntry();
        if (!sel) return;
        vscode.postMessage({ type: 'qtCancelTodo', questId: qtCurrentQuestId, file: qtCurrentFile, todoId: sel.id, sourceFile: sel.sourceFile });
    });
    // Reopen (set not-started) button — mirrors cancel.
    var btnReopenSel = document.getElementById('qt-btn-reopen-sel');
    if (btnReopenSel) btnReopenSel.addEventListener('click', function() {
        if (qtStack.length) {
            vscode.postMessage({ type: 'qtReopenStackedTodos', questId: qtCurrentQuestId, file: qtCurrentFile, todos: qtStackPayload() });
            return;
        }
        var sel = qtSelectedTodoEntry();
        if (!sel) return;
        vscode.postMessage({ type: 'qtReopenSelectedTodo', questId: qtCurrentQuestId, file: qtCurrentFile, todoId: sel.id, sourceFile: sel.sourceFile });
    });
    // Move selected todo(s) to another todo file (file picker on the server).
    var btnMoveFile = document.getElementById('qt-btn-move-file');
    if (btnMoveFile) btnMoveFile.addEventListener('click', function() {
        if (qtStack.length) {
            vscode.postMessage({ type: 'qtMoveTodosToPickedFile', questId: qtCurrentQuestId, file: qtCurrentFile, todos: qtStackPayload() });
            return;
        }
        var sel = qtSelectedTodoEntry();
        if (!sel) return;
        vscode.postMessage({ type: 'qtMoveTodosToPickedFile', questId: qtCurrentQuestId, file: qtCurrentFile, todos: [{ todoId: sel.id, sourceFile: sel.sourceFile }] });
    });
    qtUpdateArchiveButtons();
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
    if (templateSelect) templateSelect.addEventListener('change', function() {
        qtCurrentTemplate = this.value || '__none__';
    });
    if (addQueueBtn) addQueueBtn.addEventListener('click', function() {
        // Paused 2 s after a click: a double click or a bouncing mouse queues once (the host guards too).
        if (addQueueBtn.disabled) return;
        qtPauseButton(addQueueBtn);
        var tplId = qtSelectedTemplateId();
        // Stacked todos win: one queue prompt per stacked todo, in stack order.
        if (qtStack.length) {
            vscode.postMessage({
                type: 'qtQueueStackedTodos',
                questId: qtCurrentQuestId,
                file: qtCurrentFile,
                todos: qtStackPayload(),
                template: tplId,
            });
            return;
        }
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
            template: tplId,
        });
    });
    if (sendCopilotBtn) sendCopilotBtn.addEventListener('click', function() {
        if (sendCopilotBtn.disabled) return;
        qtPauseButton(sendCopilotBtn);
        var tplId = qtSelectedTemplateId();
        // Stacked todos win: all stacked todos combine into a SINGLE prompt.
        if (qtStack.length) {
            vscode.postMessage({
                type: 'qtSendStackedTodos',
                questId: qtCurrentQuestId,
                file: qtCurrentFile,
                todos: qtStackPayload(),
                template: tplId,
            });
            return;
        }
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
            template: tplId,
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
    // The panel's session and run (vscimpb60d): the host answers qtRunSession, and again on every change.
    vscode.postMessage({ type: 'qtGetRunSession' });
    qtRenderRunSessionControls();
    if (qtViewConfig.mode === 'session') {
        qtCurrentQuestId = '__session__';
        qtCurrentFile = 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else if (qtViewConfig.mode === 'workspace-file') {
        qtCurrentQuestId = '__all_workspace__';
        qtCurrentFile = 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else if (qtViewConfig.fixedQuestId) {
        qtCurrentQuestId = qtViewConfig.fixedQuestId;
        // A hard fixedFile locks the view; otherwise pre-select defaultFile but
        // keep the file picker live so the user can switch files (Bug 4 + Bug 5).
        qtCurrentFile = qtViewConfig.fixedFile || qtViewConfig.defaultFile || 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        vscode.postMessage({ type: 'qtGetFiles', questId: qtCurrentQuestId });
    } else {
        vscode.postMessage({ type: 'qtGetQuests' });
    }
})();

// ── Todo stack helpers ──

function qtStackIndexOf(id) {
    for (var i = 0; i < qtStack.length; i++) { if (qtStack[i].id === id) return i; }
    return -1;
}

function qtStackSourceFor(id) {
    for (var i = 0; i < qtTodos.length; i++) { if (qtTodos[i].id === id) return qtTodos[i].sourceFile || ''; }
    return '';
}

/**
 * Toggle a todo's stack membership (circle click). Un-stacking renumbers the
 * remaining entries automatically (indices derive from array position at
 * render time). Shift-click with an existing stack adds every todo between
 * the last picked one and the clicked one (in the current list order,
 * walking in the click direction), skipping already-stacked entries.
 */
function qtToggleStack(id, shiftKey) {
    if (!id) return;
    var existing = qtStackIndexOf(id);
    if (existing >= 0) {
        qtStack.splice(existing, 1);
        if (qtLastStackedId === id) qtLastStackedId = qtStack.length ? qtStack[qtStack.length - 1].id : '';
        qtRenderList();
        return;
    }
    if (shiftKey && qtStack.length && qtLastStackedId) {
        var from = qtLastRenderOrder.indexOf(qtLastStackedId);
        var to = qtLastRenderOrder.indexOf(id);
        if (from !== -1 && to !== -1) {
            var step = to >= from ? 1 : -1;
            for (var ri = from + step; step > 0 ? ri <= to : ri >= to; ri += step) {
                var rid = qtLastRenderOrder[ri];
                if (qtStackIndexOf(rid) === -1) qtStack.push({ id: rid, sourceFile: qtStackSourceFor(rid) });
            }
            qtLastStackedId = id;
            qtRenderList();
            return;
        }
    }
    qtStack.push({ id: id, sourceFile: qtStackSourceFor(id) });
    qtLastStackedId = id;
    qtRenderList();
}

function qtClearStack() {
    if (!qtStack.length) return;
    qtStack = [];
    qtLastStackedId = '';
    qtRenderList();
}

/** Message payload shape shared by qtQueueStackedTodos / qtSendStackedTodos. */
function qtStackPayload() {
    return qtStack.map(function(s) { return { todoId: s.id, sourceFile: s.sourceFile || undefined }; });
}

/**
 * Resolve the template id to use for a queue/send action, read LIVE from the
 * dropdown so the user's current pick is always honoured — the module-level
 * qtCurrentTemplate can lag behind a template-list refresh. Falls back to the
 * cached value, then '__none__'.
 */
function qtSelectedTemplateId() {
    var sel = document.getElementById('qt-template-select');
    if (sel && sel.value) { qtCurrentTemplate = sel.value; }
    return qtCurrentTemplate || '__none__';
}

/** Is the group with this prefix currently expanded? Unknown ⇒ collapsed. */
function qtIsGroupExpanded(prefix) {
    return Object.prototype.hasOwnProperty.call(qtExpandedGroups, '#' + prefix);
}

/** Open/close one prefix group and re-render the list. */
function qtToggleGroup(prefix) {
    var key = '#' + prefix;
    if (Object.prototype.hasOwnProperty.call(qtExpandedGroups, key)) {
        delete qtExpandedGroups[key];
    } else {
        qtExpandedGroups[key] = true;
    }
    qtRenderList();
}

/** Open every prefix group of the todos loaded (the list is not re-rendered). */
function qtExpandAllGroupsState() {
    qtGroupTodosByPrefix(qtTodos).forEach(function(g) { qtExpandedGroups['#' + g.prefix] = true; });
}

/** Open every prefix group — the "Expand all" action-bar button. */
function qtExpandAllGroups() {
    qtExpandAllGroupsState();
    qtRenderList();
}

/** Close every prefix group — the "Collapse all" action-bar button. */
function qtCollapseAllGroups() {
    qtExpandedGroups = {};
    qtRenderList();
}

/**
 * Open the group a todo belongs to. The reveal path (`qtPendingSelect`) is an
 * explicit "show me this todo" request from elsewhere in the extension, so it
 * must not leave the row hidden inside a collapsed group — that would look
 * like the reveal did nothing.
 */
function qtExpandGroupForTodo(id) {
    qtExpandedGroups['#' + qtTodoPrefix(id)] = true;
}

/**
 * The todos in `t.blocking` that are still open: a todo of this list that is
 * neither completed nor cancelled, and any todo the list does not hold (one of
 * another quest, `<quest>/<id>`, or of a file not shown), whose state the
 * panel cannot see.
 */
function qtOpenBlockedTodos(t) {
    return (t.blocking || []).filter(function(ref) {
        for (var i = 0; i < qtTodos.length; i++) {
            if (qtTodos[i].id === ref) {
                return qtTodos[i].status !== 'completed' && qtTodos[i].status !== 'cancelled';
            }
        }
        return true;
    });
}

/** ⛓️ beside the status icon of a todo that blocks open todos; its tooltip names them. */
function qtBlockingMark(t) {
    var open = qtOpenBlockedTodos(t);
    if (!open.length) return '';
    return '<span class="qt-blocking" title="Blocks: ' + qtEsc(open.join(', ')) + '">⛓️</span>';
}

/** One todo row of the list pane. */
/**
 * The prompt queue will run this todo: the number of the queue item that runs
 * it first (as the queue editor shows it), the tooltip naming every one
 * (`queued` / `queuedTitle`, set by the host from the items' todo id patterns).
 */
function qtQueuedMark(t) {
    if (!Array.isArray(t.queued) || t.queued.length === 0) return '';
    return '<span class="qt-queued" title="' + qtEsc(t.queuedTitle || ('Queued: #' + t.queued.join(', #'))) + '">⏵#' + qtEsc(String(t.queued[0])) + '</span>';
}

/** The 🔁 mark of a repeated todo, its rule (and when it is due again) in the tooltip. */
function qtRepeatMark(t) {
    if (!t.repeat) return '';
    var title = 'Repeated: ' + t.repeat + (t.status === 'waiting-for-repeat'
        ? (t.next_repeat ? ' — next ' + t.next_repeat.replace('T', ' ') : ' — waiting to be repeated by hand')
        : '');
    return '<span class="qt-repeat" title="' + qtEsc(title) + '">🔁</span>';
}

/**
 * The SESSION TODOS view's session switch (the host's plan, src/utils/sessionSwitch.ts):
 * a button for each of the most recent sessions that have todos, a dropdown with
 * all of them when there are more, each with its open-todo count.
 */
function qtRenderSessionSwitch(state) {
    var box = document.getElementById('qt-session-switch');
    if (!box) return;
    if (!state || !state.plan) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var plan = state.plan;
    var counts = state.counts || {};
    var label = function(name) {
        var c = counts[name];
        return qtEsc(name) + ' <span class="qt-session-count" title="' + (c ? c.open + ' open, ' + c.total + ' in all' : 'no todos') + '">' + (c ? c.open : 0) + '</span>';
    };
    var html = '<span class="qt-session-label">Session:</span>';
    if (plan.showDropdown) {
        html += '<select class="qt-session-select" data-qt-session-select title="Every session with todos, most recently written first">' +
            plan.sessions.map(function(n) {
                var c = counts[n];
                return '<option value="' + qtEsc(n) + '"' + (n === plan.selected ? ' selected' : '') + '>' + qtEsc(n) + ' (' + (c ? c.open : 0) + ')</option>';
            }).join('') + '</select>';
    }
    html += plan.buttons.map(function(n) {
        return '<button class="qt-session-btn' + (n === plan.selected ? ' active' : '') + '" data-qt-session="' + qtEsc(n) + '" title="The todos of session ' + qtEsc(n) + '">' + label(n) + '</button>';
    }).join('');
    box.innerHTML = html;
    box.style.display = '';
}
document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-qt-session]') : null;
    if (!btn) return;
    vscode.postMessage({ type: 'qtSelectSession', session: btn.dataset.qtSession });
});
document.addEventListener('change', function(e) {
    if (e.target && e.target.dataset && e.target.dataset.qtSessionSelect !== undefined) {
        vscode.postMessage({ type: 'qtSelectSession', session: e.target.value });
    }
});

function qtRenderTodoRow(t) {
    var icon = qtStatusIcon(t.status);
    var cls = 'qt-todo-item status-' + (t.status || 'not-started');
    if (t.user_action === true) cls += ' user-action';
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
    // Terminal (-archived / -deleted) files refuse archive/delete moves,
    // so suppress the per-item trash button for todos sourced from them.
    var isTerminalSrc = qtIsTerminalTodoFileName(t.sourceFile || qtCurrentFile);
    if (isDone) {
        trashBtn = isTerminalSrc ? '' : '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Delete (move to -archived/-deleted file)">🗑️</button>';
        reopenBtn = '<button class="qt-reopen-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Reopen (set to not-started)">🔄</button>';
    } else if (t.status === 'waiting-for-repeat') {
        // A repeated todo waiting for its next repetition: Repeat now brings it back at once.
        reopenBtn = '<button class="qt-reopen-btn qt-repeat-now-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Repeat now (set to not-started)' + (t.next_repeat ? ' — otherwise due ' + qtEsc(t.next_repeat.replace('T', ' ')) : '') + '">⏭️</button>';
    } else {
        moveBtn = isQuestMode && qtCurrentFile === 'all' ? '<button class="qt-move-btn" data-qt-move="' + qtEsc(t.id) + '" title="Move to main quest todo file">➡️</button>' : '';
        moveWsBtn = '<button class="qt-move-ws-btn" data-qt-movews="' + qtEsc(t.id) + '" title="' + (qtStack.length > 1 ? 'Move ' + qtStack.length + ' stacked todos to another group / quest / workspace / another quest…' : 'Move this todo to another group / quest / workspace / another quest…') + '">⬆️</button>';
    }
    var priorityBadge = t.priority && (t.priority === 'critical' || t.priority === 'high') ? '<span class="priority-badge ' + t.priority + '">' + t.priority.toUpperCase() + '</span>' : '';
    var priorityDot = t.priority ? '<span class="qt-priority-dot ' + qtEsc(t.priority) + '">●</span>' : '';
    var stackIdx = qtStackIndexOf(t.id);
    var circleTitle = stackIdx >= 0
        ? 'Remove from todo stack (#' + (stackIdx + 1) + ')'
        : 'Add to todo stack (shift-click: add range from last picked)';
    var stackCircle = '<span class="qt-stack-circle' + (stackIdx >= 0 ? ' stacked' : '') + '" data-qt-stackid="' + qtEsc(t.id) + '" title="' + circleTitle + '">' + (stackIdx >= 0 ? (stackIdx + 1) : '') + '</span>';
    return '<div class="' + cls + '" data-qt-id="' + qtEsc(t.id) + '">' +
        '<div class="qt-todo-item-row1">' +
        '<span class="status-icon">' + icon + '</span>' +
        (t.user_action === true ? '<span class="qt-user-action" title="Your to do: a prefix* queue walk passes it">👤</span>' : '') +
        qtRepeatMark(t) +
        qtQueuedMark(t) +
        qtBlockingMark(t) +
        '<span class="ttitle">' + qtEsc(t.title || '') + '</span>' +
        qtDecisionChip(t) +
        priorityBadge + moveBtn + moveWsBtn + trashBtn + reopenBtn + '</div>' +
        '<div class="qt-todo-item-row2">' +
        stackCircle +
        priorityDot +
        '<span class="tid">' + qtEsc(t.id) + '</span>' +
        srcLabel + '</div></div>';
}

/**
 * A group with queued todos (a collapsed group hides its rows' marks): the
 * first queue item that runs any of them, the tooltip naming every item and
 * how many of the group's todos are queued.
 */
function qtGroupQueuedMark(group) {
    var numbers = [];
    var queuedTodos = 0;
    group.todos.forEach(function(t) {
        if (!Array.isArray(t.queued) || !t.queued.length) return;
        queuedTodos++;
        t.queued.forEach(function(n) { if (numbers.indexOf(n) === -1) numbers.push(n); });
    });
    if (!numbers.length) return '';
    numbers.sort(function(a, b) { return a - b; });
    var title = 'Queued: ' + numbers.map(function(n, k) { return '#' + n + (k === 0 && numbers.length > 1 ? ' (first)' : ''); }).join(', ') +
        ' \u2014 ' + queuedTodos + ' of ' + group.todos.length + ' todos';
    return '<span class="qt-queued qt-group-queued" title="' + qtEsc(title) + '">\u23f5#' + numbers[0] + '</span>';
}

/** The open decisions of a `decision-needed` todo, as the tooltips list them. */
function qtOpenDecisionText(t) {
    var open = Array.isArray(t.open_decisions) ? t.open_decisions : [];
    return open.length ? open.join('; ') : 'answer its decisions in the todo';
}

/**
 * A `decision-needed` todo's yellow chip: something to answer. A prefix* walk
 * runs the todos before it and holds only when it reaches this one.
 */
function qtDecisionChip(t) {
    if (!t || t.status !== 'decision-needed') { return ''; }
    var open = Array.isArray(t.open_decisions) ? t.open_decisions.length : 0;
    var title = 'Decision needed' + (open ? ' (' + open + ' open)' : '') + ': ' + qtOpenDecisionText(t) +
        ' \u2014 a prefix* walk holds when it reaches this todo';
    return '<span class="qt-decision-chip" title="' + qtEsc(title) + '">decision-needed</span>';
}

/** A group holding `decision-needed` todos: a yellow ❓ with their count, the tooltip naming them. */
function qtGroupDecisionMark(group) {
    var waiting = group.todos.filter(function(t) { return t && t.status === 'decision-needed'; });
    if (!waiting.length) { return ''; }
    var title = waiting.length + ' todo' + (waiting.length === 1 ? '' : 's') + ' with open decisions: ' +
        waiting.map(function(t) { return t.id + (t.title ? ' (' + t.title + ')' : '') + ' \u2014 ' + qtOpenDecisionText(t); }).join('; ');
    return '<span class="qt-decision-chip qt-group-decisions" title="' + qtEsc(title) + '">\u2753' + waiting.length + '</span>';
}

/** The thin separator line that heads one prefix group. */
function qtRenderGroupHeader(group, expanded) {
    var count = group.todos.length;
    return '<div class="qt-group-header' + (expanded ? '' : ' collapsed') + '"' +
        ' data-qt-group="' + qtEsc(group.prefix) + '"' +
        ' title="' + (expanded ? 'Collapse' : 'Expand') + ' ' + qtEsc(group.label) + ' (' + count + ')">' +
        '<span class="codicon codicon-chevron-down"></span>' +
        '<span class="qt-group-label">' + qtEsc(group.label) + '</span>' +
        '<span class="qt-group-count">(' + count + ')</span>' +
        qtGroupQueuedMark(group) +
        qtGroupDecisionMark(group) +
        (group.prefix
            ? '<button class="qt-group-walk-btn" data-qt-group-walk="' + qtEsc(group.prefix) + '" title="Queue Group Prompt: a walk over the todos of ' + qtEsc(group.prefix) + '* with a group prompt you pick…">🔁</button>'
            : '') +
        (group.prefix && qtCurrentQuestId && qtCurrentQuestId.indexOf('__') !== 0
            ? '<button class="qt-group-rename-btn" data-qt-group-rename="' + qtEsc(group.prefix) + '" title="Rename group ' + qtEsc(group.prefix) + '…: a new prefix for its live todos, references following, a stub per old id">✏️</button>'
            : '') +
        (qtGroupOpenTodos(group).length
            ? '<button class="qt-group-move-btn" data-qt-group-move="' + qtEsc(group.prefix) + '" title="Move the open todos of this group to another group / quest / workspace / another quest…">⬆️</button>'
            : '') +
        '</div>';
}

/** The todos of a group a move takes: every one not completed or cancelled. */
function qtGroupOpenTodos(group) {
    return group.todos.filter(function(t) { return t && t.status !== 'completed' && t.status !== 'cancelled'; });
}

function qtUpdateStackButtons() {
    var btn = document.getElementById('qt-btn-clear-stack');
    if (!btn) return;
    btn.disabled = !qtStack.length;
    btn.style.opacity = qtStack.length ? '1' : '0.4';
    btn.title = qtStack.length ? 'Clear todo stack (' + qtStack.length + ' stacked)' : 'Clear todo stack (empty)';
}

function qtRenderList() {
    var pane = document.getElementById('qt-list-pane');
    if (!pane) return;
    // Prune stack entries whose todo vanished (reload, quest/file switch).
    if (qtStack.length) {
        var qtLiveIds = {};
        for (var li = 0; li < qtTodos.length; li++) qtLiveIds[qtTodos[li].id] = true;
        qtStack = qtStack.filter(function(s) { return !!qtLiveIds[s.id]; });
        if (qtLastStackedId && !qtLiveIds[qtLastStackedId]) {
            qtLastStackedId = qtStack.length ? qtStack[qtStack.length - 1].id : '';
        }
    }
    qtUpdateStackButtons();
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
        if (qtFilterState.userAction.length && qtFilterState.userAction.indexOf(t.user_action === true ? 'yes' : 'no') === -1) return false;
        if (qtFilterState.createdFrom && (t.created || '') < qtFilterState.createdFrom) return false;
        if (qtFilterState.createdTo && (t.created || '') > qtFilterState.createdTo) return false;
        if (qtFilterState.updatedFrom && (t.updated || '') < qtFilterState.updatedFrom) return false;
        if (qtFilterState.updatedTo && (t.updated || '') > qtFilterState.updatedTo) return false;
        // A todo without a completed_date is outside every Completed range.
        if (qtFilterState.completedFrom && (!t.completed_date || t.completed_date < qtFilterState.completedFrom)) return false;
        if (qtFilterState.completedTo && (!t.completed_date || t.completed_date > qtFilterState.completedTo)) return false;
        if (qtFilterState.blocking.length && qtFilterState.blocking.indexOf(qtOpenBlockedTodos(t).length ? 'yes' : 'no') === -1) return false;
        if (qtFilterSearch) {
            var hay = ((t.id || '') + ' ' + (t.title || '') + ' ' + (t.sourceFile || '')).toLowerCase();
            if (hay.indexOf(qtFilterSearch) === -1) return false;
        }
        return true;
    });

    // Apply multi-field sort; ties (and no field chosen) by id in natural order.
    {
        var priOrd = { critical: 0, high: 1, medium: 2, low: 3 };
        var staOrd = { 'in-progress': 0, 'blocked': 1, 'decision-needed': 2, 'not-started': 3, 'waiting-for-repeat': 4, 'completed': 5, 'cancelled': 6 };
        // Rank 0 is falsy, so `|| 9` would sort the *first* rank last. Look the
        // key up instead of leaning on truthiness.
        var rank = function(table, key) {
            return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 9;
        };
        filtered = filtered.slice().sort(function(a, b) {
            for (var si = 0; si < qtSortFields.length; si++) {
                var sf = qtSortFields[si];
                var cmp = 0;
                switch (sf.field) {
                    case 'id': cmp = qtCompareTodoIds(a, b); break;
                    case 'quest': cmp = qtQuestKey(a).localeCompare(qtQuestKey(b)); break;
                    case 'status': cmp = rank(staOrd, a.status) - rank(staOrd, b.status); break;
                    case 'priority': cmp = rank(priOrd, a.priority) - rank(priOrd, b.priority); break;
                    case 'title': cmp = (a.title || '').localeCompare(b.title || ''); break;
                    case 'created': cmp = (a.created || '').localeCompare(b.created || ''); break;
                    case 'updated': cmp = (b.updated || '').localeCompare(a.updated || ''); break;
                    case 'completed_date': cmp = (a.completed_date || '').localeCompare(b.completed_date || ''); break;
                }
                if (!sf.asc) cmp = -cmp;
                if (cmp !== 0) return cmp;
            }
            return qtCompareTodoIds(a, b);
        });
    }

    if (!filtered.length) { pane.innerHTML = '<div class="qt-empty-detail">No matching todos</div>'; return; }

    // Group by id prefix: the groups alphabetically (the "Unprefixed"
    // catch-all last), the todos in each in the sort above (grouping.js).
    // Ungrouped (the sort picker's Group checkbox off): one plain list.
    var groups = qtGroupByPrefix ? qtGroupTodosByPrefix(filtered) : [];
    var html = '';
    // Visual order — basis for shift-click stack ranges. Only rows the user can
    // actually see belong in it, so a range never reaches into a collapsed
    // group and silently stacks todos that are not on screen.
    var renderOrder = [];
    for (var gi = 0; gi < groups.length; gi++) {
        var group = groups[gi];
        var expanded = qtIsGroupExpanded(group.prefix);
        html += qtRenderGroupHeader(group, expanded);
        if (!expanded) continue;
        for (var gt = 0; gt < group.todos.length; gt++) {
            html += qtRenderTodoRow(group.todos[gt]);
            renderOrder.push(group.todos[gt].id);
        }
    }
    if (!qtGroupByPrefix) {
        for (var pt = 0; pt < filtered.length; pt++) {
            html += qtRenderTodoRow(filtered[pt]);
            renderOrder.push(filtered[pt].id);
        }
    }
    qtLastRenderOrder = renderOrder;
    pane.innerHTML = html;

    pane.querySelectorAll('.qt-group-header').forEach(function(hdr) {
        hdr.addEventListener('click', function(e) {
            var walkBtn = e.target.closest ? e.target.closest('.qt-group-walk-btn') : null;
            if (walkBtn) {
                // The host asks which group prompt and queues the walk over `<prefix>*`.
                e.stopPropagation();
                if (walkBtn.disabled) return;
                qtPauseButton(walkBtn);
                vscode.postMessage({ type: 'qtQueueGroupPrompt', questId: qtCurrentQuestId, prefix: walkBtn.getAttribute('data-qt-group-walk') || '' });
                return;
            }
            var renameBtn = e.target.closest ? e.target.closest('.qt-group-rename-btn') : null;
            if (renameBtn) {
                // The host asks for the new prefix and renames the group.
                e.stopPropagation();
                vscode.postMessage({ type: 'qtRenameGroup', questId: qtCurrentQuestId, prefix: renameBtn.getAttribute('data-qt-group-rename') || '' });
                return;
            }
            var moveBtn = e.target.closest ? e.target.closest('.qt-group-move-btn') : null;
            if (moveBtn) {
                // The whole group in one move: one destination, one id decision.
                e.stopPropagation();
                var prefix = moveBtn.getAttribute('data-qt-group-move') || '';
                var group = groups.find(function(g) { return g.prefix === prefix; });
                if (!group) { return; }
                var todos = qtGroupOpenTodos(group).map(function(t) { return { todoId: t.id, sourceFile: t.sourceFile || undefined }; });
                vscode.postMessage({ type: 'qtMoveTodosToDestination', questId: qtCurrentQuestId, file: qtCurrentFile, todos: todos });
                return;
            }
            qtToggleGroup(hdr.getAttribute('data-qt-group') || '');
        });
    });
    pane.querySelectorAll('.qt-todo-item').forEach(function(el) {
        el.addEventListener('click', function(e) {
            var circleEl = e.target.closest('.qt-stack-circle');
            if (circleEl) {
                qtToggleStack(circleEl.getAttribute('data-qt-stackid'), e.shiftKey);
                return;
            }
            if (e.target.closest('.qt-move-btn') || e.target.closest('.qt-move-ws-btn') || e.target.closest('.qt-trash-btn') || e.target.closest('.qt-reopen-btn')) return;
            qtSelectedTodoId = el.dataset.qtId;
            qtNavPush(qtSelectedTodoId);
            qtRenderList();
            qtRequestTodoDetail(qtSelectedTodoId);
            // Refresh the send button + templates so they track the prompt
            // queue's current transport even if it changed since load (Bug 3).
            vscode.postMessage({ type: 'qtGetTemplates' });
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
            // More than one stacked todo: the move applies to the whole stack
            // (the server's picker says so). Otherwise the clicked todo.
            var todos = qtStack.length > 1 ? qtStackPayload() : [{ todoId: tid, sourceFile: qtStackSourceFor(tid) || undefined }];
            vscode.postMessage({ type: 'qtMoveTodosToDestination', questId: qtCurrentQuestId, file: qtCurrentFile, todos: todos });
        });
    });
    pane.querySelectorAll('.qt-trash-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtTrash;
            var srcFile = '';
            var match = qtTodos.filter(function(t) { return t.id === tid; });
            if (match.length) srcFile = match[0].sourceFile || '';
            vscode.postMessage({ type: 'qtDeleteTodo', questId: qtCurrentQuestId, todoId: tid, sourceFile: srcFile });
        });
    });
    pane.querySelectorAll('.qt-reopen-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtReopen;
            vscode.postMessage({ type: 'qtReopenTodo', questId: qtCurrentQuestId, todoId: tid, sourceFile: qtSourceFileForId(tid) });
        });
    });
    qtUpdateArchiveButtons();
}

// ── Archive / delete-to-file buttons (TRA02) ──

/**
 * Client-side mirror of isArchivedOrDeletedTodoFile (todoArchiveNames.ts):
 * a todo file is TERMINAL when the FIRST dot-separated segment of its
 * basename ends in -archived or -deleted. Terminal files can never be
 * archive/delete sources, so all four buttons hide for them.
 */
function qtIsTerminalTodoFileName(name) {
    if (!name) return false;
    var base = String(name).split(/[\\/]/).pop() || '';
    var dot = base.indexOf('.');
    var seg = dot === -1 ? base : base.substring(0, dot);
    return /-archived$/.test(seg) || /-deleted$/.test(seg);
}

/** Selected todo's list entry, with the (fresher) detail-pane status when the detail matches. */
function qtSelectedTodoEntry() {
    if (!qtSelectedTodoId) return null;
    var entry = null;
    for (var i = 0; i < qtTodos.length; i++) {
        if (qtTodos[i].id === qtSelectedTodoId) { entry = qtTodos[i]; break; }
    }
    if (!entry) return null;
    var status = entry.status;
    if (qtDetailTodo && qtDetailTodo.id === entry.id && qtDetailTodo.status) status = qtDetailTodo.status;
    return { id: entry.id, status: status || 'not-started', sourceFile: entry.sourceFile || '' };
}

/**
 * Recompute visibility + enablement of the four archive/delete buttons.
 * Called on selection change (via qtRenderList), status edits, and
 * quest/file switches.
 */
function qtUpdateArchiveButtons() {
    var btnArchive = document.getElementById('qt-btn-archive');
    var btnArchiveAll = document.getElementById('qt-btn-archive-all');
    var btnDelete = document.getElementById('qt-btn-delete-file');
    var btnDeleteCancelled = document.getElementById('qt-btn-delete-cancelled');
    var btnComplete = document.getElementById('qt-btn-complete');
    var btnCancel = document.getElementById('qt-btn-cancel');
    if (!btnArchive || !btnArchiveAll || !btnDelete || !btnDeleteCancelled) return;

    var isSession = qtViewConfig && qtViewConfig.mode === 'session';
    var isWorkspaceFile = qtViewConfig && qtViewConfig.mode === 'workspace-file';
    var isSpecialQuest = qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__';

    // Concrete file scope (empty when browsing "All files" / aggregate views).
    var scopeFile = '';
    if (isWorkspaceFile) scopeFile = 'workspace.todo.yaml';
    else if (qtCurrentFile && qtCurrentFile !== 'all') scopeFile = qtCurrentFile;

    // Session todos live in the stable per-host session file (TRA04);
    // TRB1 adds the archive/delete top-bar buttons for session mode.
    var hideAll = isSession ||
        (scopeFile && qtIsTerminalTodoFileName(scopeFile));

    function setBtn(btn, visible, enabled) {
        btn.style.display = (!hideAll && visible) ? '' : 'none';
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? '1' : '0.4';
    }

    var stackCount = qtStack.length;
    var sel = qtSelectedTodoEntry();
    // Source file the single-todo actions would operate on.
    var selSource = sel ? (sel.sourceFile || scopeFile) : scopeFile;
    var selSourceTerminal = selSource ? qtIsTerminalTodoFileName(selSource) : false;

    // Archive/Delete work on ANY status and act on the whole stack when one
    // exists, otherwise on the single selected todo. Visible when a stack
    // exists OR a non-terminal single todo is selected; the stack path is
    // confirmed server-side before it moves anything.
    var singleVisible = stackCount > 0 || (!!sel && !selSourceTerminal);
    var actionable = stackCount > 0 || !!sel;
    setBtn(btnArchive, singleVisible, actionable);
    setBtn(btnDelete, singleVisible, actionable);
    btnArchive.title = stackCount > 0 ? 'Archive ' + stackCount + ' stacked todo(s)' : 'Archive selected todo';
    btnDelete.title = stackCount > 0 ? 'Delete ' + stackCount + ' stacked todo(s)' : 'Delete selected todo';

    // Complete/Cancel set the status in place (no file move). Same visibility
    // rule as archive/delete: whole stack, otherwise a non-terminal single todo.
    if (btnComplete) {
        setBtn(btnComplete, singleVisible, actionable);
        btnComplete.title = stackCount > 0 ? 'Mark ' + stackCount + ' stacked todo(s) completed' : 'Mark selected todo completed';
    }
    if (btnCancel) {
        setBtn(btnCancel, singleVisible, actionable);
        btnCancel.title = stackCount > 0 ? 'Mark ' + stackCount + ' stacked todo(s) cancelled' : 'Mark selected todo cancelled';
    }

    // Reopen (set not-started) — same visibility rule as complete/cancel.
    var btnReopenSel = document.getElementById('qt-btn-reopen-sel');
    if (btnReopenSel) {
        setBtn(btnReopenSel, singleVisible, actionable);
        btnReopenSel.title = stackCount > 0 ? 'Mark ' + stackCount + ' stacked todo(s) not-started' : 'Mark selected todo not-started';
    }

    // Move to another todo file — only in a concrete quest (not aggregates,
    // workspace-file, or session mode). Acts on the stack, otherwise the
    // single selected todo.
    var btnMoveFile = document.getElementById('qt-btn-move-file');
    if (btnMoveFile) {
        var moveVisible = !isWorkspaceFile && !isSpecialQuest && singleVisible;
        setBtn(btnMoveFile, moveVisible, actionable);
        btnMoveFile.title = stackCount > 0 ? 'Move ' + stackCount + ' stacked todo(s) to another todo file' : 'Move selected todo(s) to another todo file';
    }

    // Bulk buttons need a concrete, non-terminal file scope.
    var bulkVisible = !!scopeFile && (isWorkspaceFile || !isSpecialQuest);
    setBtn(btnArchiveAll, bulkVisible, bulkVisible);
    setBtn(btnDeleteCancelled, bulkVisible, bulkVisible);
}

function qtStatusIcon(s) {
    switch(s) {
        case 'in-progress': return '🔄';
        case 'completed': return '✅';
        case 'blocked': return '⛔';
        case 'decision-needed': return '❓';
        case 'waiting-for-repeat': return '⏳';
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
        qtFilterState.userAction.length > 0 || qtFilterState.blocking.length > 0 ||
        !!(qtFilterState.createdFrom || qtFilterState.createdTo || qtFilterState.updatedFrom || qtFilterState.updatedTo ||
            qtFilterState.completedFrom || qtFilterState.completedTo);
}

function qtUpdateFilterIndicator() {
    var btn = document.getElementById('qt-btn-filter');
    if (btn) {
        if (qtHasActiveFilters()) btn.classList.add('active-indicator');
        else btn.classList.remove('active-indicator');
    }
    var mine = document.getElementById('qt-btn-only-mine');
    if (mine) mine.classList.toggle('active-indicator', qtShowsOnlyUserActions());
}

/** Is the list showing only the user's own todos (the 👤 toggle)? */
function qtShowsOnlyUserActions() {
    return qtFilterState.userAction.length === 1 && qtFilterState.userAction[0] === 'yes';
}

/**
 * The 👤 toggle: only the user's own todos (`user_action: true`), or all todos
 * again. Showing only them opens every prefix group, so none hides in a
 * collapsed one.
 */
function qtToggleOnlyUserActions() {
    if (qtShowsOnlyUserActions()) {
        qtFilterState.userAction = [];
    } else {
        qtFilterState.userAction = ['yes'];
        qtExpandAllGroupsState();
    }
    qtUpdateFilterIndicator();
    qtRenderList();
    qtPersistState();
}

function qtRenderFilterPicker() {
    var el = document.getElementById('qt-filter-picker');
    if (!el) return;
    var statuses = ['not-started','in-progress','blocked','decision-needed','waiting-for-repeat','completed','cancelled'];
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
    html += '<div class="qt-picker-section-header">User action</div>';
    [['yes', '👤 the user\'s own todos'], ['no', 'the other todos']].forEach(function(o) {
        var checked = qtFilterState.userAction.indexOf(o[0]) >= 0;
        html += '<div class="qt-picker-option" data-qt-filter-type="userAction" data-qt-filter-val="' + o[0] + '">' +
            '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + o[1] + '</div>';
    });
    html += '<div class="qt-picker-section-header">Blocking</div>';
    [['yes', '⛓️ blocks open todos'], ['no', 'blocks no open todo']].forEach(function(o) {
        var checked = qtFilterState.blocking.indexOf(o[0]) >= 0;
        html += '<div class="qt-picker-option" data-qt-filter-type="blocking" data-qt-filter-val="' + o[0] + '">' +
            '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + o[1] + '</div>';
    });
    html += '<div class="qt-picker-section-header">Date Ranges</div>';
    html += '<div class="qt-picker-date-row"><label>Created</label><input type="date" id="qt-fp-created-from" value="' + (qtFilterState.createdFrom || '') + '"><span>–</span><input type="date" id="qt-fp-created-to" value="' + (qtFilterState.createdTo || '') + '"></div>';
    html += '<div class="qt-picker-date-row"><label>Updated</label><input type="date" id="qt-fp-updated-from" value="' + (qtFilterState.updatedFrom || '') + '"><span>–</span><input type="date" id="qt-fp-updated-to" value="' + (qtFilterState.updatedTo || '') + '"></div>';
    html += '<div class="qt-picker-date-row"><label>Completed</label><input type="date" id="qt-fp-completed-from" value="' + (qtFilterState.completedFrom || '') + '"><span>–</span><input type="date" id="qt-fp-completed-to" value="' + (qtFilterState.completedTo || '') + '"></div>';
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
    var cofEl = document.getElementById('qt-fp-completed-from');
    var cotEl = document.getElementById('qt-fp-completed-to');
    if (cofEl) cofEl.addEventListener('change', function() { qtFilterState.completedFrom = this.value; });
    if (cotEl) cotEl.addEventListener('change', function() { qtFilterState.completedTo = this.value; });
    // Reset
    document.getElementById('qt-fp-reset').addEventListener('click', function() {
        qtFilterState = qtEmptyFilterState();
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
/** The Sort button is marked while the list is not in its default order (no field, grouped). */
function qtUpdateSortIndicator() {
    var sortBtn = document.getElementById('qt-btn-sort');
    if (!sortBtn) return;
    if (qtSortFields.length || !qtGroupByPrefix) sortBtn.classList.add('active-indicator');
    else sortBtn.classList.remove('active-indicator');
}

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
    var html = '<label class="qt-picker-option qt-sp-group" title="Group the list by id prefix; off: one plain list">'
        + '<input type="checkbox" id="qt-sp-group"' + (qtGroupByPrefix ? ' checked' : '') + '> Group by prefix</label>'
        + '<div class="qt-picker-section-header">Sort Fields</div>'
        + '<div class="qt-picker-hint">None chosen: by id (number order). Groups stay in alphabetical order.</div>';
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

    var groupBox = document.getElementById('qt-sp-group');
    if (groupBox) {
        groupBox.addEventListener('click', function(e) { e.stopPropagation(); });
        groupBox.addEventListener('change', function() {
            qtGroupByPrefix = !!groupBox.checked;
            qtUpdateSortIndicator();
            qtRenderList();
            qtPersistState();
        });
    }
    el.querySelectorAll('.qt-picker-option[data-qt-sort-field]').forEach(function(opt) {
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
        qtGroupByPrefix = true;
        qtUpdateSortIndicator();
        qtRenderSortPicker();
        qtRenderList();
        qtPersistState();
    });
    document.getElementById('qt-sp-ok').addEventListener('click', function(e) {
        e.stopPropagation();
        qtSortFields = pending;
        el.style.display = 'none';
        qtUpdateSortIndicator();
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
    qtFormDecisions = todo.decisions ? JSON.parse(JSON.stringify(todo.decisions)) : [];
    // Start collapsed — the point of the summary is to scan the list at a glance.
    qtDecisionOpen = qtFormDecisions.map(function() { return false; });

    var blockedByBadges = qtRenderTodoBadges(todo.blocked_by || [], 'blocked-by');
    var depsBadges = qtRenderTodoBadges(todo.dependencies || [], 'deps');

    pane.innerHTML = '<div class="qt-detail-form">' +
        qtFormRow('ID', '<span class="qt-id-row"><input id="qt-d-id" value="' + qtEsc(todo.id) + '" readonly class="qt-readonly">' + qtIdEditButton(todo) + '</span>') +
        qtFormRow('Title', '<input id="qt-d-title" value="' + qtEsc(todo.title || '') + '">') +
        qtFormRow('Description' + qtMdButtons('desc', 'Description'), '<textarea id="qt-d-desc" data-completion="on">' + qtEsc(todo.description || '') + '</textarea>') +
        '<div class="qt-inline-row">' +
        qtFormRow('Status', '<select id="qt-d-status">' + qtStatusOptions(todo.status) + '</select>' + qtDecisionChip({
            status: todo.status,
            open_decisions: (todo.decisions || []).filter(function(d) { return !(d && typeof d.decision === 'string' && d.decision.trim()); })
                .map(function(d) { return d && d.summary ? String(d.summary) : '(a decision)'; }),
        })) +
        qtFormRow('Priority', '<select id="qt-d-priority">' + qtPriorityOptions(todo.priority) + '</select>') +
        '</div>' +
        qtTodoButtonsRow(todo) +
        qtUserActionRow(todo.user_action === true, true) +
        qtRepeatSection(todo) +
        qtFormRow('Tags', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div class="qt-tag-chips" id="qt-d-tags">' + qtRenderTagChipsHtml(qtFormTags) + '</div>' +
            '<input class="qt-tag-input" id="qt-d-tag-input" placeholder="Add tag...">' +
            '<button class="qt-edit-btn" id="qt-d-tag-picker-btn" title="Pick from existing tags">🏷️</button></div>') +
        qtFormRow('Dependencies', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-deps-wrap">' + depsBadges +
            '<button class="qt-edit-btn" id="qt-d-deps-add" title="Add dependency">➕</button></div>') +
        qtFormRow('Blocked By', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-blocked-wrap">' + blockedByBadges +
            '<button class="qt-edit-btn" id="qt-d-blocked-add" title="Add blocked-by">➕</button></div>') +
        ((todo.blocking || []).length
            ? qtFormRow('Blocking', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-blocking-wrap" title="The todos whose Blocked By names this one; set Blocked By on those to change it">' +
                qtRenderTodoBadges(todo.blocking, 'blocking') + '</div>')
            : '') +
        qtFormRow('Notes' + qtMdButtons('notes', 'Notes'), '<textarea id="qt-d-notes" data-completion="on">' + qtEsc(todo.notes || '') + '</textarea>') +
        qtRenderDecisionsSection() +
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
    document.getElementById('qt-d-user-action').addEventListener('change', qtAutoSave);
    qtRepeatFormSync();
    // A rule is saved once it is complete (a weekly rule needs a weekday).
    document.getElementById('qt-rp').addEventListener('change', function() {
        var r = qtReadRepeatForm();
        if (r && r.rule === 'weekly' && (!r.weekdays || r.weekdays.length === 0)) return;
        qtAutoSave();
    });
    document.getElementById('qt-btn-delete').addEventListener('click', function() {
        var delQuestId = (todo._resolvedQuestId) || qtCurrentQuestId;
        vscode.postMessage({ type: 'qtDeleteTodo', questId: delQuestId, todoId: todo.id, sourceFile: todo._sourceFile });
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
        qtUpdateArchiveButtons();
    });

    qtAttachTodoBadgeHandlers('blocked-by');
    qtAttachTodoBadgeHandlers('deps');
    qtAttachTodoBadgeHandlers('blocking');
    document.getElementById('qt-d-blocked-add').addEventListener('click', function() { qtShowTodoPicker('blocked-by'); });
    document.getElementById('qt-d-deps-add').addEventListener('click', function() { qtShowTodoPicker('deps'); });

    qtAttachTagRemoveHandlers();
    qtAttachSectionHandlers();
    qtAttachDecisionHandlers();
    qtAttachScopeFileHandlers();
    qtAttachRefHandlers();

    var pathsToCheck = [];
    (qtFormScope && qtFormScope.files ? qtFormScope.files : []).forEach(function(p) { pathsToCheck.push(p); });
    qtFormRefs.forEach(function(r) { if (r.path) pathsToCheck.push(r.path); });
    qtRequestPathExtAppAvailability(pathsToCheck);

    vscode.postMessage({ type: 'qtCheckExtApp', questId: qtCurrentQuestId, file: qtCurrentFile });
}

// ── Todo badge rendering for blocked-by / dependencies ──
/** Badges of todo ids; `blocking` badges are read-only (the list is derived from the others' blocked_by). */
function qtRenderTodoBadges(ids, category) {
    var removable = category !== 'blocking';
    return ids.map(function(id) {
        return '<span class="qt-todo-badge" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '" title="Navigate to ' + qtEsc(id) + '">' +
            qtEsc(id) +
            (removable ? '<span class="qt-badge-remove" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '">×</span>' : '') +
            '</span>';
    }).join('');
}

function qtAttachTodoBadgeHandlers(category) {
    var wrapId = category === 'blocked-by' ? 'qt-d-blocked-wrap' : category === 'blocking' ? 'qt-d-blocking-wrap' : 'qt-d-deps-wrap';
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

// ── Decisions section ──
// One collapsible row per decision: collapsed shows only the summary, expanded
// shows all three fields. The user scans the list by summary, so a row without
// one would be unidentifiable — hence the `(unnamed decision)` placeholder.
function qtDecisionRowHtml(d, i) {
    var open = qtDecisionOpen[i] === true;
    var resolved = !!(d.decision && d.decision.trim());
    var summary = (d.summary && d.summary.trim()) ? d.summary : '(unnamed decision)';
    return '<div class="qt-decision-item">' +
        '<div class="qt-decision-header' + (open ? '' : ' collapsed') + '" data-qt-decision-idx="' + i + '">' +
        '<span class="codicon codicon-chevron-down"></span>' +
        '<span class="qt-decision-mark" title="' + (resolved ? 'Decided' : 'Waiting on you') + '">' + (resolved ? '\u2705' : '\u2753') + '</span>' +
        '<span class="qt-decision-summary" data-qt-decision-label="' + i + '">' + qtEsc(summary) + '</span>' +
        '<button class="qt-edit-btn qt-decision-rm-btn" data-qt-decision-idx="' + i + '" title="Remove decision">\uD83D\uDDD1\uFE0F</button></div>' +
        '<div class="qt-decision-body' + (open ? '' : ' hidden') + '" data-qt-decision-body="' + i + '">' +
        qtFormRow('Summary', '<input class="qt-decision-field" data-qt-decision-idx="' + i + '" data-qt-decision-field="summary" value="' + qtEsc(d.summary || '') + '">') +
        qtFormRow('Decision needed', '<textarea class="qt-decision-field" data-qt-decision-idx="' + i + '" data-qt-decision-field="decision_needed" data-completion="on">' + qtEsc(d.decision_needed || '') + '</textarea>') +
        qtFormRow('Decision', '<textarea class="qt-decision-field" data-qt-decision-idx="' + i + '" data-qt-decision-field="decision" data-completion="on">' + qtEsc(d.decision || '') + '</textarea>') +
        '</div></div>';
}

function qtDecisionsBodyHtml() {
    if (!qtFormDecisions.length) { return '<div class="qt-scope-summary">(none)</div>'; }
    return '<div class="qt-decision-list">' + qtFormDecisions.map(qtDecisionRowHtml).join('') + '</div>';
}

function qtRenderDecisionsSection() {
    return '<div class="qt-section-header" data-qt-section="decisions">' +
        '<span class="codicon codicon-chevron-down"></span> Decisions ' +
        '<button class="qt-edit-btn" id="qt-decision-add-btn" title="Add decision">\u2795</button></div>' +
        '<div class="qt-section-body" data-qt-section-body="decisions">' + qtDecisionsBodyHtml() + '</div>';
}

function qtRefreshDecisionsBody() {
    var body = document.querySelector('[data-qt-section-body="decisions"]');
    if (!body) return;
    body.innerHTML = qtDecisionsBodyHtml();
    qtAttachDecisionHandlers();
}

function qtAttachDecisionHandlers() {
    var addBtn = document.getElementById('qt-decision-add-btn');
    if (addBtn && !addBtn.dataset.qtWired) {
        addBtn.dataset.qtWired = '1';
        addBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            qtFormDecisions.push({ summary: '' });
            // A new row has nothing to show collapsed, so open it to be filled in.
            qtDecisionOpen.push(true);
            qtRefreshDecisionsBody();
            qtAutoSave();
        });
    }
    document.querySelectorAll('.qt-decision-header').forEach(function(hdr) {
        hdr.addEventListener('click', function(e) {
            if (e.target.closest('.qt-edit-btn')) return;
            var i = parseInt(hdr.dataset.qtDecisionIdx, 10);
            qtDecisionOpen[i] = !qtDecisionOpen[i];
            hdr.classList.toggle('collapsed');
            var body = document.querySelector('[data-qt-decision-body="' + i + '"]');
            if (body) body.classList.toggle('hidden');
        });
    });
    document.querySelectorAll('.qt-decision-rm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var i = parseInt(btn.dataset.qtDecisionIdx, 10);
            qtFormDecisions.splice(i, 1);
            qtDecisionOpen.splice(i, 1);
            qtRefreshDecisionsBody();
            qtAutoSave();
        });
    });
    document.querySelectorAll('.qt-decision-field').forEach(function(el) {
        el.addEventListener('input', function() {
            var i = parseInt(el.dataset.qtDecisionIdx, 10);
            var d = qtFormDecisions[i];
            if (!d) return;
            d[el.dataset.qtDecisionField] = el.value;
            if (el.dataset.qtDecisionField === 'summary') {
                // Keep the collapsed label honest while it is being typed.
                var label = document.querySelector('[data-qt-decision-label="' + i + '"]');
                if (label) label.textContent = el.value.trim() || '(unnamed decision)';
            }
            qtAutoSave();
        });
    });
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
        '</div>' + qtAnswerRow(todo) + '</div>';
}

/**
 * The agent answer of a saved todo, whatever its status: the two markdown
 * preview buttons. The host finds the newest answer in the quest's session
 * trails that reported the todo (TODO=<ref>, a chat send or a queue run),
 * else the stored `last_answer` of a todo walk. Never editable.
 */
function qtAnswerRow(todo) {
    if (!todo) return '';
    return '<div class="qt-inline-row qt-answer-row">' +
        qtFormRow('Agent answer', qtMdButtons('answer', 'the newest agent answer that reported this todo')) +
        '</div>';
}

/**
 * The two markdown preview buttons of a field (`desc`, `notes`, `answer`): show
 * it rendered in the overlay over the whole panel (media/shared/mdOverlay.js),
 * or open it in the markdown preview editor. One delegated click handler
 * (qtHandleMdButtonClick) serves every form, so re-rendering needs no wiring.
 */
function qtMdButtons(field, what) {
    return '<span class="qt-md-btns">' +
        '<button class="icon-btn qt-md-btn" type="button" data-qt-md-field="' + field + '" data-qt-md-mode="overlay" title="Show ' + qtEsc(what) + ' as markdown over the panel">' +
            '<span class="codicon codicon-eye"></span></button>' +
        '<button class="icon-btn qt-md-btn" type="button" data-qt-md-field="' + field + '" data-qt-md-mode="editor" title="Open ' + qtEsc(what) + ' in the markdown preview editor">' +
            '<span class="codicon codicon-open-preview"></span></button>' +
        '</span>';
}

var QT_MD_FIELD_LABELS = { desc: 'Description', notes: 'Notes' };

/** The field's text as it is now: the form's value, unsaved edits included. */
function qtMdFieldText(field) {
    var el = document.getElementById(field === 'desc' ? 'qt-d-desc' : 'qt-d-notes');
    return el ? el.value : '';
}

function qtHandleMdButtonClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.qt-md-btn') : null;
    if (!btn) return;
    e.preventDefault();
    var field = btn.getAttribute('data-qt-md-field');
    var mode = btn.getAttribute('data-qt-md-mode') === 'editor' ? 'editor' : 'overlay';
    if (field === 'answer') {
        // The host looks the answer up in the trails; the stored one is the fallback.
        if (!qtDetailTodo) return;
        vscode.postMessage({
            type: 'qtShowAgentAnswer',
            mode: mode,
            questId: qtCurrentQuestId,
            todoId: qtDetailTodo.id,
            sourceFile: qtDetailTodo._sourceFile || undefined,
            fallback: qtDetailTodo.last_answer || '',
        });
        return;
    }
    var isNew = !!document.getElementById('qt-btn-create');
    var owner = isNew ? 'New todo' : ((qtDetailTodo && qtDetailTodo.id) || 'Todo');
    vscode.postMessage({
        type: btn.getAttribute('data-qt-md-mode') === 'editor' ? 'qtOpenMarkdownPreview' : 'qtRenderMarkdown',
        title: owner + ' \u2014 ' + (QT_MD_FIELD_LABELS[field] || field),
        markdown: qtMdFieldText(field),
    });
}
document.addEventListener('click', qtHandleMdButtonClick);

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
        decisions: qtFormDecisions.length ? qtFormDecisions : undefined,
        created: createdValue || undefined,
        completed_date: completedDateValue || undefined,
        completed_by: completedByValue || undefined,
        // Absent on the new-todo form (undefined: nothing to write); false
        // clears the mark on an existing todo.
        user_action: document.getElementById('qt-d-user-action') ? document.getElementById('qt-d-user-action').checked : undefined,
        // null clears a rule; absent (no Repeat section) leaves it as it is.
        repeat: qtReadRepeatForm(),
    };
}

function qtShowNewTodoForm(id) {
    qtSelectedTodoId = '';
    qtFormTags = [];
    qtFormScope = null;
    qtFormRefs = [];
    qtFormDecisions = [];
    qtDecisionOpen = [];
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
        qtFormRow('Description' + qtMdButtons('desc', 'Description'), '<textarea id="qt-d-desc" data-completion="on"></textarea>') +
        '<div class="qt-inline-row">' +
        qtFormRow('Status', '<select id="qt-d-status">' + qtStatusOptions('not-started') + '</select>') +
        qtFormRow('Priority', '<select id="qt-d-priority">' + qtPriorityOptions('medium') + '</select>') +
        '</div>' +
        qtUserActionRow(false) +
        qtFormRow('Tags', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div class="qt-tag-chips" id="qt-d-tags"></div>' +
            '<input class="qt-tag-input" id="qt-d-tag-input" placeholder="Add tag...">' +
            '<button class="qt-edit-btn" id="qt-d-tag-picker-btn" title="Pick from existing tags">🏷️</button></div>') +
        qtFormRow('Dependencies', '<input id="qt-d-deps" placeholder="Comma-separated IDs">') +
        qtFormRow('Blocked By', '<input id="qt-d-blocked-by" placeholder="Comma-separated: todoId or questId/todoId">') +
        qtFormRow('Notes' + qtMdButtons('notes', 'Notes'), '<textarea id="qt-d-notes" data-completion="on"></textarea>') +
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

/**
 * The ID field's edit button (quest todos only): asks the host for the new id
 * (VS Code's input box), which renames the todo and every reference to it in
 * the quest (questTodoManager.renameQuestTodo).
 */
function qtIdEditButton(todo) {
    var mode = (typeof qtViewConfig !== 'undefined' && qtViewConfig && qtViewConfig.mode) || '';
    if (mode === 'session' || mode === 'workspace-file' || !qtCurrentQuestId || qtCurrentQuestId.indexOf('__') === 0) return '';
    return '<button type="button" class="icon-btn qt-id-edit-btn" id="qt-d-id-edit" data-qt-rename="' + qtEsc(todo.id) + '"' +
        ' data-qt-rename-file="' + qtEsc(todo._sourceFile || todo.sourceFile || '') + '"' +
        ' title="Rename this todo: a new id, references in the quest follow"><span class="codicon codicon-edit"></span></button>';
}

function qtFormRow(label, input) { return '<div class="qt-form-row"><label>' + label + '</label>' + input + '</div>'; }

/**
 * The "Your to do" checkbox (`user_action`), the same in the new-todo and the
 * detail form. On a saved todo (`withGuide`) two buttons follow it: Guide me
 * through the todo in the chat, or via the prompt queue, both with the Status
 * Page's Todo buttons template for user-action todos (default "Guide me through
 * a user action", qtGuideUserAction).
 */
// ── Repeated todos: the Repeat section of the detail form ──
var QT_RP_WEEKDAYS = [['mon','Mo'],['tue','Tu'],['wed','We'],['thu','Th'],['fri','Fr'],['sat','Sa'],['sun','Su']];
var QT_RP_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/**
 * The Repeat section: the rule (none, by hand, after N days / weeks / months,
 * daily, weekly on weekdays, monthly or yearly on a day, the last day, the nth
 * weekday or the first / last working day), the time, and an end (until a
 * date, or after N repetitions). Done, a repeated todo waits for its next
 * repetition instead of completing (the next moment is computed by the host).
 */
function qtRepeatSection(todo) {
    var r = (todo && todo.repeat) || null;
    var rule = r ? r.rule : '';
    var opt = function(v, label, cur) { return '<option value="' + v + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + label + '</option>'; };
    var dayMode = !r ? 'day' : r.day === 'last' ? 'last' : r.nth !== undefined ? 'nth' : r.working_day === 'first' ? 'first-working' : r.working_day === 'last' ? 'last-working' : 'day';
    var wds = (r && r.weekdays) || [];
    var info = '';
    if (todo && todo.repeat) {
        info = '<div class="qt-rp-info">' + (todo.repeat_count ? 'Done ' + todo.repeat_count + ' time' + (todo.repeat_count === 1 ? '' : 's') + '. ' : '') +
            (todo.status === 'waiting-for-repeat' ? (todo.next_repeat ? 'Next: ' + qtEsc(String(todo.next_repeat).replace('T', ' ')) : 'Waits to be repeated by hand.') : '') + '</div>';
    }
    return qtFormRow('Repeat', '<div class="qt-repeat-form" id="qt-rp">' +
        '<select id="qt-rp-rule" title="Done, a repeated todo waits for its next repetition instead of completing">' +
            opt('', '(not repeated)', rule) + opt('manual', 'by hand', rule) + opt('after', 'after it is done', rule) +
            opt('daily', 'daily', rule) + opt('weekly', 'weekly', rule) + opt('monthly', 'monthly', rule) + opt('yearly', 'yearly', rule) +
        '</select>' +
        '<span data-rp="every"> every <input type="number" id="qt-rp-every" min="1" value="' + qtEsc(String((r && r.every) || 1)) + '" style="width:48px"></span>' +
        '<select id="qt-rp-unit" data-rp="unit">' + ['days','weeks','months','years'].map(function(u) { return opt(u, u, (r && r.unit) || 'days'); }).join('') + '</select>' +
        '<span data-rp="weekdays" class="qt-rp-weekdays">' + QT_RP_WEEKDAYS.map(function(w) {
            return '<label><input type="checkbox" data-rp-wd="' + w[0] + '"' + (wds.indexOf(w[0]) >= 0 ? ' checked' : '') + '>' + w[1] + '</label>';
        }).join('') + '</span>' +
        '<span data-rp="month"> in <select id="qt-rp-month">' + QT_RP_MONTHS.map(function(m, i) { return opt(i + 1, m, (r && r.month) || 1); }).join('') + '</select></span>' +
        '<span data-rp="daymode"> on <select id="qt-rp-daymode">' +
            opt('day', 'day', dayMode) + opt('last', 'the last day', dayMode) + opt('nth', 'the nth weekday', dayMode) +
            opt('first-working', 'the first working day', dayMode) + opt('last-working', 'the last working day', dayMode) +
        '</select></span>' +
        '<input type="number" id="qt-rp-day" data-rp="day" min="1" max="31" value="' + qtEsc(String(r && typeof r.day === 'number' ? r.day : 1)) + '" style="width:48px">' +
        '<span data-rp="nth"><select id="qt-rp-nth">' + opt(1, 'first', r && r.nth) + opt(2, 'second', r && r.nth) + opt(3, 'third', r && r.nth) + opt(4, 'fourth', r && r.nth) + opt(5, 'fifth', r && r.nth) + opt('last', 'last', r && r.nth) + '</select>' +
            '<select id="qt-rp-weekday">' + QT_RP_WEEKDAYS.map(function(w) { return opt(w[0], w[1], (r && r.weekday) || 'mon'); }).join('') + '</select></span>' +
        '<span data-rp="time"> at <input type="time" id="qt-rp-time" value="' + qtEsc((r && r.time) || '') + '"></span>' +
        '<span data-rp="end"> until <input type="date" id="qt-rp-until" value="' + qtEsc((r && r.until) || '') + '"> or <input type="number" id="qt-rp-count" min="1" placeholder="∞" value="' + qtEsc(r && r.count ? String(r.count) : '') + '" style="width:48px"> times</span>' +
        info +
        '</div>');
}

/** Show the fields the chosen rule takes. */
function qtRepeatFormSync() {
    var form = document.getElementById('qt-rp');
    if (!form) return;
    var rule = document.getElementById('qt-rp-rule').value;
    var dm = document.getElementById('qt-rp-daymode').value;
    var show = {
        every: rule === 'after' || rule === 'daily' || rule === 'weekly' || rule === 'monthly' || rule === 'yearly',
        unit: rule === 'after',
        weekdays: rule === 'weekly',
        month: rule === 'yearly',
        daymode: rule === 'monthly' || rule === 'yearly',
        day: (rule === 'monthly' || rule === 'yearly') && dm === 'day',
        nth: (rule === 'monthly' || rule === 'yearly') && dm === 'nth',
        time: !!rule && rule !== 'manual',
        end: !!rule,
    };
    form.querySelectorAll('[data-rp]').forEach(function(el) { el.style.display = show[el.dataset.rp] ? '' : 'none'; });
}

/**
 * The rule the Repeat section holds: a `repeat` map, null for "not repeated"
 * (clears an existing rule), undefined when the form has no Repeat section.
 */
function qtReadRepeatForm() {
    var ruleEl = document.getElementById('qt-rp-rule');
    if (!ruleEl) return undefined;
    var rule = ruleEl.value;
    if (!rule) return null;
    var r = { rule: rule };
    var num = function(id) { var v = parseInt(document.getElementById(id).value, 10); return isNaN(v) ? undefined : v; };
    var every = num('qt-rp-every');
    if (rule !== 'manual' && every && every > 1) r.every = every;
    if (rule === 'after') r.unit = document.getElementById('qt-rp-unit').value;
    if (rule === 'weekly') {
        r.weekdays = Array.prototype.map.call(document.querySelectorAll('#qt-rp [data-rp-wd]:checked'), function(b) { return b.dataset.rpWd; });
    }
    if (rule === 'yearly') r.month = num('qt-rp-month');
    if (rule === 'monthly' || rule === 'yearly') {
        var dm = document.getElementById('qt-rp-daymode').value;
        if (dm === 'day') r.day = num('qt-rp-day') || 1;
        if (dm === 'last') r.day = 'last';
        if (dm === 'nth') {
            var nth = document.getElementById('qt-rp-nth').value;
            r.nth = nth === 'last' ? 'last' : parseInt(nth, 10);
            r.weekday = document.getElementById('qt-rp-weekday').value;
        }
        if (dm === 'first-working') r.working_day = 'first';
        if (dm === 'last-working') r.working_day = 'last';
    }
    var time = document.getElementById('qt-rp-time').value;
    if (time && rule !== 'manual') r.time = time;
    var until = document.getElementById('qt-rp-until').value;
    if (until) r.until = until;
    var count = num('qt-rp-count');
    if (count && count > 0) r.count = count;
    return r;
}
document.addEventListener('change', function(e) {
    if (e.target && e.target.closest && e.target.closest('#qt-rp')) qtRepeatFormSync();
});

function qtUserActionRow(checked, withGuide) {
    var guide = withGuide
        ? '<span class="qt-guide-btns">' +
            '<button class="icon-btn qt-guide-btn" type="button" data-qt-guide="chat" title="Guide me through this todo in the chat — the panel\'s session and run, the ANTHROPIC/LLM panel\'s profile, the Todo buttons template for user-action todos">' +
                '<span class="codicon codicon-comment-discussion"></span></button>' +
            '<button class="icon-btn qt-guide-btn" type="button" data-qt-guide="queue" title="Add this todo to the prompt queue in the panel\'s session and run, with the Todo buttons template for user-action todos (staged)">' +
                '<span class="codicon codicon-list-ordered"></span></button>' +
          '</span>'
        : '';
    return qtFormRow('Your to do', '<div class="qt-user-action-line"><label title="A prefix* queue walk passes this todo and goes on with the next one">' +
        '<input type="checkbox" id="qt-d-user-action"' + (checked ? ' checked' : '') + '> 👤 user action</label>' + guide + '</div>');
}

/* ── The panel's session and run (vscimpb60d) ──────────────────────────────
 * One selection for the top bar and the detail panel (and for both quest todo
 * views): the session the panel's sends run in and the run they belong to.
 * Kept per window and quest by the host; a run deleted elsewhere is default. */
var qtRunSessionState;

/** What the panel is on: the host's last answer, else the defaults (the init code runs before this file's end). */
function qtRunSessionNow() {
    return qtRunSessionState || { session: 'chat', effectiveSession: 'chat', run: 'default', windowRun: 'default', runs: [{ run: 'default', label: 'default' }] };
}

/** The session button (speech bubble + name) and the Run select, as the @CHAT panel has them. */
function qtRunSessionControlsHtml() {
    var st = qtRunSessionNow();
    var options = st.runs.map(function(o) {
        return '<option value="' + qtEsc(o.run) + '"' + (o.run === st.run ? ' selected' : '') + '>' + qtEsc(o.label) + '</option>';
    }).join('');
    return '<button class="icon-btn qt-session-btn" type="button" data-qt-pick-session="1" title="The session the panel\'s todos are sent in and queued for (' + qtEsc(st.effectiveSession) + ') — click to pick another or create one">'
        + '<span class="codicon codicon-comment-discussion"></span><span class="qt-session-name">' + qtEsc(st.effectiveSession) + '</span></button>'
        + '<select class="qt-run-select' + (st.run !== st.windowRun ? ' run-other' : '') + '" title="The process run the panel\'s todos are sent and queued for: its chat variables, its process position, its own sessions">' + options + '</select>';
}

/** Fill every place that shows the controls: the top bar and the detail's Run row. */
function qtRenderRunSessionControls() {
    var html = qtRunSessionControlsHtml();
    var run = qtRunSessionNow().run;
    document.querySelectorAll('.qt-run-session').forEach(function(el) { el.innerHTML = html; el.dataset.run = run; });
}

function qtHandleRunSessionClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.qt-session-btn') : null;
    if (!btn) { return; }
    e.preventDefault();
    vscode.postMessage({ type: 'qtPickSession' });
}
document.addEventListener('click', qtHandleRunSessionClick);

function qtHandleRunSelectChange(e) {
    var sel = e.target && e.target.classList && e.target.classList.contains('qt-run-select') ? e.target : null;
    if (!sel) { return; }
    qtRunSessionState = Object.assign({}, qtRunSessionNow(), { run: sel.value });
    qtRenderRunSessionControls();
    vscode.postMessage({ type: 'qtSetRun', run: sel.value });
}
document.addEventListener('change', qtHandleRunSelectChange);

/**
 * The Send and Queue buttons of a saved todo (qtTodoButton): Send runs the todo
 * now in the @CHAT ANTHROPIC/LLM panel, Queue adds it to the prompt queue
 * (staged), both on Anthropic whatever the queue's transport, with the template
 * the Status Page's Todo buttons setting names for the todo — the user-action
 * one for a 👤 user-action todo, the other one for the rest.
 */
function qtTodoButtonsRow(todo) {
    var which = todo && todo.user_action === true ? 'user-action' : 'other';
    return qtFormRow('Run', '<div class="qt-todo-buttons">' +
        '<span class="qt-run-session" data-run="' + qtEsc(qtRunSessionNow().run) + '">' + qtRunSessionControlsHtml() + '</span>' +
        '<button class="icon-btn qt-todo-btn" type="button" data-qt-todo-btn="chat" title="Send this todo now in the panel\'s session and run (the session and Run beside it), with the ANTHROPIC/LLM panel\'s profile and the Todo buttons template for ' + which + ' todos (Status Page)">' +
            '<span class="codicon codicon-send"></span> Send</button>' +
        '<button class="icon-btn qt-todo-btn" type="button" data-qt-todo-btn="queue" title="Add this todo to the prompt queue (staged, Anthropic) in the panel\'s session and run, with the Todo buttons template for ' + which + ' todos (Status Page)">' +
            '<span class="codicon codicon-list-ordered"></span> Queue</button>' +
        '</div>');
}

/**
 * The double-click guard of the todo buttons (Send / Queue, Guide me): the
 * clicked button is paused for 2 s; the host also ignores the same todo sent
 * the same way within 3 s.
 */
function qtPauseButton(btn) {
    btn.disabled = true;
    setTimeout(function() { btn.disabled = false; }, 2000);
}

/** The Send and Queue buttons (qtTodoButtonsRow): one delegated handler. */
function qtHandleTodoButtonClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.qt-todo-btn') : null;
    if (!btn || !qtDetailTodo || btn.disabled) { return; }
    e.preventDefault();
    qtPauseButton(btn);
    vscode.postMessage({
        type: 'qtTodoButton',
        target: btn.getAttribute('data-qt-todo-btn') === 'queue' ? 'queue' : 'chat',
        questId: qtCurrentQuestId,
        todoId: qtDetailTodo.id,
        sourceFile: qtDetailTodo._sourceFile || undefined,
    });
}
document.addEventListener('click', qtHandleTodoButtonClick);

/** The Guide me buttons (qtUserActionRow): one delegated handler. */
function qtHandleGuideButtonClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.qt-guide-btn') : null;
    if (!btn || !qtDetailTodo || btn.disabled) { return; }
    e.preventDefault();
    qtPauseButton(btn);
    vscode.postMessage({
        type: 'qtGuideUserAction',
        target: btn.getAttribute('data-qt-guide') === 'queue' ? 'queue' : 'chat',
        questId: qtCurrentQuestId,
        todoId: qtDetailTodo.id,
        sourceFile: qtDetailTodo._sourceFile || undefined,
    });
}
document.addEventListener('click', qtHandleGuideButtonClick);

/** The ID field's edit button (qtIdEditButton): the host asks for the new id and renames. */
function qtHandleIdEditClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.qt-id-edit-btn') : null;
    if (!btn) return;
    e.preventDefault();
    vscode.postMessage({
        type: 'qtRenameTodo',
        questId: qtCurrentQuestId,
        todoId: btn.getAttribute('data-qt-rename') || '',
        sourceFile: btn.getAttribute('data-qt-rename-file') || undefined,
    });
}
document.addEventListener('click', qtHandleIdEditClick);

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
    var opts = ['not-started','in-progress','blocked','decision-needed','waiting-for-repeat','completed','cancelled'];
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
        case 'qtQueueChanged':
            // Queued todos changed: load the list shown again, with its marks.
            vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            break;
        case 'qtTodos':
            qtTodos = msg.todos || [];
            if (msg.questId === '__session__') qtRenderSessionSwitch(msg.sessionSwitch);
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
                    qtExpandGroupForTodo(qtSelectedTodoId);
                    qtRenderList();
                    qtRequestTodoDetail(qtSelectedTodoId);
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
        case 'qtGroupRenamed':
            // A group renamed by its separator's button: keep the selection under its new id, load the list again.
            (msg.renames || []).forEach(function(r) { if (r && r.from === qtSelectedTodoId) { qtSelectedTodoId = r.to; } });
            vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            break;
        case 'qtRenamed':
            // Renamed by the ID edit button: select it under its new id and load the list again.
            qtSelectedTodoId = msg.todoId || '';
            vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
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
            }
            break;
        case 'qtArchiveResult':
            // Archive/delete-to-file completed (TRA02): refresh the list from
            // the backend; the qtTodos handler clears a now-missing selection.
            if (msg.success) {
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                if (qtCurrentQuestId && qtCurrentQuestId.indexOf('__') !== 0) {
                    // The -archived/-deleted sibling may have just been created.
                    vscode.postMessage({ type: 'qtGetFiles', questId: qtCurrentQuestId });
                }
            }
            break;
        case 'qtStatusResult':
            // Complete/cancel/reopen set status in place: refresh the list from
            // the backend and clear the stack after a stack operation. Also
            // re-fetch the open detail so the details pane reflects the new
            // status (fix b) — a single-todo change leaves the selection intact.
            if (msg.success) {
                if (msg.wasStack) qtClearStack();
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                if (!msg.wasStack && qtSelectedTodoId) qtRequestTodoDetail(qtSelectedTodoId);
            }
            break;
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
            qtUpdateArchiveButtons();
            break;
        case 'qtMarkdownHtml':
            tomMdOverlayShow(msg.title, msg.html);
            break;
        case 'qtState':
            if (msg.state) {
                var st = msg.state;
                if (st.sortFields && st.sortFields.length) {
                    qtSortFields = st.sortFields;
                }
                if (st.grouped === false) { qtGroupByPrefix = false; }
                qtUpdateSortIndicator();
                if (st.tagScope === 'quest' || st.tagScope === 'all') {
                    qtTagPickerScope = st.tagScope;
                }
                if (st.filterState) {
                    var fs = st.filterState;
                    qtFilterState = {
                        status: fs.status || [],
                        priority: fs.priority || [],
                        tags: fs.tags || [],
                        userAction: fs.userAction || [],
                        blocking: fs.blocking || [],
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
        case 'qtRunSession':
            qtRunSessionState = {
                session: msg.session || 'chat',
                effectiveSession: msg.effectiveSession || msg.session || 'chat',
                run: msg.run || 'default',
                windowRun: msg.windowRun || 'default',
                runs: Array.isArray(msg.runs) && msg.runs.length ? msg.runs : [{ run: 'default', label: 'default' }],
            };
            qtRenderRunSessionControls();
            break;
        case 'qtTemplates': {
            var templateSel = document.getElementById('qt-template-select');
            if (templateSel) {
                var available = msg.templates || [];
                // Preserve the user's current pick across refreshes when it is
                // still an offered option; otherwise use the computed default.
                // A transport switch changes the options, so a now-invalid pick
                // correctly falls back to the new transport's default (Bug 3).
                var prev = templateSel.value;
                var stillValid = available.some(function(t) { return t.id === prev; });
                var selected = stillValid ? prev : (msg.selected || '__none__');
                templateSel.innerHTML = available.map(function(t) {
                    return '<option value="' + qtEsc(t.id) + '">' + qtEsc(t.label) + '</option>';
                }).join('');
                templateSel.value = selected;
                if (templateSel.value !== selected) templateSel.value = '__none__';
                qtCurrentTemplate = templateSel.value || '__none__';
            }
            // Label the send button after the prompt queue's transport (Bug 3).
            var sendBtn = document.getElementById('qt-btn-send-copilot');
            if (sendBtn) {
                var isAnthropic = msg.transport === 'anthropic';
                var sendLabel = isAnthropic ? 'Send to Anthropic' : 'Send to Copilot';
                sendBtn.title = sendLabel;
                if (sendBtn.textContent && sendBtn.textContent.trim()) sendBtn.textContent = sendLabel;
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
