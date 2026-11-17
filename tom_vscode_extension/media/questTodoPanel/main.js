// @ts-nocheck
/* global vscode, qtViewConfig, qtGroupTodosByPrefix, qtTodoGroupsOf, qtTodoPrefix, qtCompareTodoIds, tomMdOverlayShow */
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
// The quests of the quest select (qtQuests), for the After done group's quest picker.
var qtQuestList = [];
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
    return { status: [], priority: [], tags: [], userAction: [], blocking: [], overdue: [], createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', completedFrom: '', completedTo: '' };
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
/** The template list has arrived once: before it, the select's placeholder is no pick to keep. */
var qtTemplatesLoaded = false;
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
/*
 * The quest scope (vscimpb137), from the host's qtScope: the scope, the quests it shows, whether
 * the panel shows several quests or files beyond the live ones (`qtScopeMulti`: the list is
 * `__all_quests__`, each row's source file `<quest>/<file>`), how they are arranged, the quest prefix.
 */
var qtScopeState = null;
var qtScopeQuests = [];
var qtScopeMulti = false;
var qtScopeOrder = 'combined';
var qtShowQuestPrefix = false;
/**
 * Queue buttons of todo groups (the group's header and its detail view) queue
 * the group as a GROUP item to the panel's queue target (vscimpb127).
 */
var QT_GROUP_QUEUE_AVAILABLE = true;

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
    var templateSelect = document.getElementById('qt-template-select');
    var addQueueBtn = document.getElementById('qt-btn-add-queue');
    var sendCopilotBtn = document.getElementById('qt-btn-send-copilot');
    if (searchInput) searchInput.addEventListener('input', function() { qtFilterSearch = this.value.toLowerCase(); qtRenderList(); });
    if (btnFilter) btnFilter.addEventListener('click', function(e) { e.stopPropagation(); qtToggleFilterPicker(); });
    if (btnSort) btnSort.addEventListener('click', function(e) { e.stopPropagation(); qtToggleSortPicker(); });
    if (btnReload) btnReload.addEventListener('click', function() { qtReloadView(); });
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
        qtRenderTemplateButton();
    });
    qtInitScopeControls();
    var templateBtn = document.getElementById('qt-template-btn');
    if (templateBtn) templateBtn.addEventListener('click', function(e) {
        e.preventDefault();
        qtPickTemplate();
    });
    /**
     * Save to Queue (the bar): the stacked todos, else the selected one. `defaultTarget` (the default queue
     * button, vscimpb151): straight into the default run's default session (default@default) at the end;
     * without it the host asks quest → run → session → next / end.
     */
    function qtQueueFromBar(btn, defaultTarget) {
        // Paused 2 s after a click: a double click or a bouncing mouse queues once (the host guards too).
        if (btn.disabled) return;
        qtPauseButton(btn);
        var tplId = qtSelectedTemplateId();
        var target = defaultTarget ? { defaultTarget: true } : {};
        // Stacked todos win: one queue prompt per stacked todo, in stack order.
        if (qtStack.length) {
            vscode.postMessage(Object.assign({
                type: 'qtQueueStackedTodos',
                questId: qtCurrentQuestId,
                file: qtCurrentFile,
                todos: qtStackPayload(),
                template: tplId,
            }, target));
            return;
        }
        if (!qtSelectedTodoId) {
            vscode.postMessage({ type: 'qtShowError', message: 'Select a todo first.' });
            return;
        }
        var effectiveTodoId = (qtDetailTodo && qtDetailTodo.id) ? qtDetailTodo.id : qtSelectedTodoId;
        vscode.postMessage(Object.assign({
            type: 'qtAddCurrentTodoToQueue',
            questId: qtCurrentQuestId,
            file: qtCurrentFile,
            todoId: effectiveTodoId,
            sourceFile: qtDetailTodo && qtDetailTodo._sourceFile ? qtDetailTodo._sourceFile : undefined,
            template: tplId,
        }, target));
    }
    if (addQueueBtn) addQueueBtn.addEventListener('click', function() { qtQueueFromBar(addQueueBtn, false); });
    var addQueueDefaultBtn = document.getElementById('qt-btn-add-queue-default');
    if (addQueueDefaultBtn) addQueueDefaultBtn.addEventListener('click', function() { qtQueueFromBar(addQueueDefaultBtn, true); });
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
    // The quest scope (vscimpb137): the host answers qtScope.
    vscode.postMessage({ type: 'qtGetScope' });
    // The Done notification toggle's state: the host answers qtDoneNotification, and again on every change.
    // (Where an item goes is asked per queue add and send, vscimpb139: no run or session in the bar.)
    vscode.postMessage({ type: 'qtGetDoneNotification' });
    var qtDoneNotificationBtn = document.getElementById('qt-done-notification');
    if (qtDoneNotificationBtn) {
        // Off and disabled until the host says a template is set (vscimpb146).
        qtSetDoneNotificationLook(false, false);
        qtDoneNotificationBtn.addEventListener('click', function(e) {
            e.preventDefault();
            if (qtDoneNotificationBtn.disabled) { return; }
            var on = qtDoneNotificationBtn.getAttribute('aria-pressed') !== 'true';
            qtSetDoneNotificationLook(on, true);
            vscode.postMessage({ type: 'qtSetDoneNotification', on: on });
        });
    }
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

/** Load again what the panel shows: its scope's quests, or its quest and file (session and workspace views too). */
function qtReloadView() {
    if (!qtCurrentQuestId) return;
    vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
}

/** The scope controls: the quest picker, the three file toggles, the order, the quest prefix. */
function qtInitScopeControls() {
    var scopeBtn = document.getElementById('qt-scope-btn');
    if (scopeBtn) scopeBtn.addEventListener('click', function(e) { e.preventDefault(); vscode.postMessage({ type: 'qtPickScope' }); });
    ['live', 'archived', 'deleted'].forEach(function(kind) {
        var btn = document.getElementById('qt-files-' + kind);
        if (!btn) return;
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            if (!qtScopeState) return;
            var files = Object.assign({}, qtScopeState.files);
            files[kind] = !files[kind];
            qtSetScope({ files: files });
        });
    });
    var order = document.getElementById('qt-quest-order');
    if (order) order.addEventListener('change', function() { qtSetScope({ order: order.value }); });
    var prefixBtn = document.getElementById('qt-quest-prefix');
    if (prefixBtn) prefixBtn.addEventListener('click', function(e) {
        e.preventDefault();
        qtSetScope({ prefix: !qtShowQuestPrefix });
    });
}

/** Change the scope: the host keeps it for this panel and answers qtScope. */
function qtSetScope(change) {
    if (!qtScopeState) return;
    vscode.postMessage({ type: 'qtSetScope', scope: Object.assign({}, qtScopeState, change) });
}

var QT_FILE_TITLES = {
    live: ['Live todos', 'the quest and session todo files'],
    archived: ['Archived todos', 'the -archived siblings: read-only, with Restore'],
    deleted: ['Deleted todos', 'the -deleted siblings: read-only, with Restore'],
};

function qtSetToggle(btn, on, title) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('pressed', !!on);
    if (title) btn.title = title;
}

/**
 * The host's scope: show the controls, then load. Its own quest with live files (`plain`) is the
 * panel as it always was; anything else lists `__all_quests__` (the host reads the scope).
 */
function qtApplyScope(msg) {
    var box = document.getElementById('qt-scope-controls');
    if (!msg.available) { if (box) box.style.display = 'none'; return; }
    qtScopeState = msg.scope;
    qtScopeQuests = msg.quests || [];
    qtScopeOrder = (msg.scope && msg.scope.order) || 'combined';
    qtShowQuestPrefix = msg.prefix === true;
    if (box) box.style.display = '';
    // The scope picker takes the quest select's place.
    var questSel = document.getElementById('qt-quest-select');
    if (questSel) { questSel.style.display = 'none'; if (questSel.previousElementSibling) questSel.previousElementSibling.style.display = 'none'; }
    var scopeBtn = document.getElementById('qt-scope-btn');
    if (scopeBtn) {
        var nameEl = scopeBtn.querySelector('.qt-scope-name');
        if (nameEl) nameEl.textContent = msg.buttonText || '';
        scopeBtn.title = 'Quests: ' + (qtScopeQuests.join(', ') || 'none') + ' \u2014 click to pick one quest, the open windows\' quests or all quests';
    }
    ['live', 'archived', 'deleted'].forEach(function(kind) {
        var on = !!(msg.scope && msg.scope.files && msg.scope.files[kind]);
        qtSetToggle(document.getElementById('qt-files-' + kind), on, QT_FILE_TITLES[kind][0] + ': ' + (on ? 'shown' : 'hidden') + ' \u2014 ' + QT_FILE_TITLES[kind][1] + '. Click to ' + (on ? 'hide' : 'show') + ' them.');
    });
    var order = document.getElementById('qt-quest-order');
    if (order) { order.value = qtScopeOrder; order.style.display = qtScopeQuests.length > 1 ? '' : 'none'; }
    qtSetToggle(document.getElementById('qt-quest-prefix'), qtShowQuestPrefix, 'Quest in front of todo ids: ' + (qtShowQuestPrefix ? 'on' : 'off') + '. Click to turn it ' + (qtShowQuestPrefix ? 'off' : 'on') + '.');
    var fileSel = document.getElementById('qt-file-select');
    if (msg.plain) {
        var quest = qtScopeQuests[0];
        var wasMulti = qtScopeMulti;
        qtScopeMulti = false;
        if (fileSel && !qtViewConfig.hideFileSelect) { fileSel.style.display = ''; }
        if (wasMulti || quest !== qtCurrentQuestId) {
            qtCurrentQuestId = quest;
            qtCurrentFile = qtViewConfig.defaultFile || 'all';
            if (questSel) questSel.value = quest;
            if (fileSel) fileSel.value = qtCurrentFile;
            vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            qtPersistState();
        } else {
            qtRenderList();
        }
        return;
    }
    qtScopeMulti = true;
    qtCurrentQuestId = '__all_quests__';
    qtCurrentFile = 'all';
    if (fileSel) fileSel.style.display = 'none';
    vscode.postMessage({ type: 'qtGetTodos', questId: '__all_quests__', file: 'all' });
}

/** Restore an archived or deleted todo into the live file it came from. */
function qtRestoreTodo(id) {
    if (!id) return;
    vscode.postMessage({ type: 'qtRestoreTodo', questId: qtCurrentQuestId, todoId: id, sourceFile: qtSourceFileForId(id) });
}

/** A template name on the template button: at most 20 characters, cut with an ellipsis. */
function qtTemplateButtonText(name) {
    var s = String(name || '');
    return s.length > 20 ? s.slice(0, 19) + '\u2026' : s;
}

/** The template button shows the hidden select's selection (its label); the full name is in the tooltip. */
function qtRenderTemplateButton() {
    var btn = document.getElementById('qt-template-btn');
    var sel = document.getElementById('qt-template-select');
    if (!btn || !sel) { return; }
    var opt = sel.options[sel.selectedIndex];
    var label = opt ? opt.textContent : '(None)';
    var nameEl = btn.querySelector('.qt-template-name');
    if (nameEl) { nameEl.textContent = qtTemplateButtonText(label); }
    btn.title = 'Template: ' + label + ' \u2014 the template the Save to Queue and Send buttons use; click to pick another';
}

/** Open the template picker (a QuickPick in the host) with the templates the select offers. */
function qtPickTemplate() {
    var sel = document.getElementById('qt-template-select');
    if (!sel) { return; }
    var templates = Array.prototype.map.call(sel.options, function(o) { return { id: o.value, label: o.textContent }; });
    vscode.postMessage({ type: 'qtPickTemplate', templates: templates, selected: sel.value });
}

/**
 * The Done notification toggle: pressed (on) or not, disabled while no template is set (`available` false), with a
 * tooltip naming what it does and its state.
 */
function qtSetDoneNotificationLook(on, available) {
    var btn = document.getElementById('qt-done-notification');
    if (!btn) { return; }
    on = !!on && available !== false;
    btn.disabled = available === false;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('pressed', on);
    var icon = btn.querySelector('.codicon');
    if (icon) { icon.className = 'codicon ' + (on ? 'codicon-bell' : 'codicon-bell-slash'); }
    var what = 'When on, a todo this panel queues or sends reports back when it is completed and its After done asks for notify: into the run and session it was queued into (a todo without After done notify gets none). The text is its notify prompt, else Todo \u2014 Done Notification in the Prompt Template Editor. Kept per quest.';
    btn.title = available === false
        ? 'Done notification: unavailable — no Todo \u2014 Done Notification template is set (Prompt Template Editor). ' + what
        : 'Done notification: ' + (on ? 'ON' : 'OFF') + '. ' + what + ' Click to turn it ' + (on ? 'off' : 'on') + '.';
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
    // Several quests by quest: every quest and each quest's groups.
    if (qtScopeMulti) {
        qtTodos.forEach(function(t) {
            var q = qtQuestKey(t);
            qtExpandedGroups['#' + qtQuestGroupKey(q)] = true;
            qtExpandedGroups['#' + q + '::' + qtTodoPrefix(t.id)] = true;
        });
    }
    qtTodoGroupsOf(qtTodos, qtCurrentQuestId).forEach(function(g) { qtExpandedGroups['#' + qtTodoGroupKey(g.todo.id)] = true; });
}

/** The expand-state key of a todo group (vscimpb126); `:` never occurs in a prefix. */
function qtTodoGroupKey(id) {
    return 'todogroup:' + String(id);
}

/**
 * Go to the todo `ref` names (an id of this quest, `<quest>/<id>` of another):
 * select it, open its group section when it is a group, show its details.
 */
function qtGoToTodoRef(ref) {
    if (!ref) return;
    var targetQuestId = qtCurrentQuestId;
    var targetTodoId = ref;
    var slashIdx = ref.indexOf('/');
    if (slashIdx > 0) {
        targetQuestId = ref.substring(0, slashIdx);
        targetTodoId = ref.substring(slashIdx + 1);
        if (targetQuestId === qtCurrentQuestId) { ref = targetTodoId; }
    }
    if (ref === targetTodoId) { qtExpandedGroups['#' + qtTodoGroupKey(ref)] = true; }
    qtSelectedTodoId = ref;
    qtNavPush(ref);
    qtRenderList();
    vscode.postMessage({ type: 'qtGetTodo', questId: targetQuestId, todoId: targetTodoId });
}

/** The chips of the groups a todo belongs to (`part_of`); a click goes to the group. */
function qtPartOfChips(t) {
    if (!t || !Array.isArray(t.part_of) || !t.part_of.length) return '';
    return t.part_of.map(function(ref) {
        var title = 'Member of the group ' + ref;
        var tg = qtTodos.filter(function(x) { return x.id === ref; })[0];
        if (tg && tg.title) title += ' (' + tg.title + ')';
        return '<span class="qt-partof-chip" data-qt-partof="' + qtEsc(ref) + '" title="' + qtEsc(title + ' \u2014 click to go to it') + '">\ud83d\uddc2\ufe0f ' + qtEsc(ref) + '</span>';
    }).join('');
}

/** The header of a todo group: its title, member count, progress and (with GROUP items) its queue button. */
function qtRenderTodoGroupHeader(g, expanded) {
    var t = g.todo;
    var name = t.title || String(t.id);
    var done = t.status === 'completed';
    return '<div class="qt-todogroup-header' + (expanded ? '' : ' collapsed') + (String(t.id) === qtSelectedTodoId ? ' selected' : '') + '"' +
        ' data-qt-todogroup="' + qtEsc(t.id) + '"' +
        ' title="' + qtEsc('Group ' + name + ' (' + t.id + '): click to open it; the arrow expands or collapses its members') + '">' +
        '<span class="codicon codicon-chevron-down qt-todogroup-toggle" title="' + (expanded ? 'Collapse' : 'Expand') + '"></span>' +
        '<span class="qt-todogroup-icon">' + (done ? '\u2705' : '\ud83d\uddc2\ufe0f') + '</span>' +
        '<span class="qt-group-label">' + qtEsc(name) + '</span>' +
        '<span class="qt-group-count">(' + g.total + ')</span>' +
        '<span class="qt-todogroup-progress" title="' + g.done + ' of ' + g.total + ' members done">' + g.done + '/' + g.total + '</span>' +
        qtTodoGroupQueueButton(t, 'qt-todogroup-queue-btn') +
        '</div>';
}

/**
 * "Queue as todo item" (vscimpb127): a TODO item for a todo, a GROUP item for a
 * group todo — a walk the queue knows, with claim and completion check — to the
 * panel's queue target. Beside it the Queue button still queues a plain prompt.
 */
function qtQueueItemButton(t) {
    var group = t.status === 'group' || (Array.isArray(t.comprised_of) && t.comprised_of.length > 0);
    return '<button class="qt-queue-item-btn" data-qt-queue-item="' + qtEsc(t.id) + '" title="' +
        (group ? 'Queue as todo item: a GROUP item that walks the group\'s members in order' : 'Queue as todo item: a TODO item with claim and completion check') +
        ', to the panel\'s session and run">\u23e9</button>';
}

/** Queue todo `id` as a TODO item (a GROUP item for a group todo). */
function qtQueueAsTodoItem(id) {
    vscode.postMessage({ type: 'qtQueueAsTodoItem', questId: qtCurrentQuestId, todoId: id });
}

/** The queue button of a todo group (header or detail view); hidden until GROUP items exist (vscimpb127). */
function qtTodoGroupQueueButton(t, cls) {
    if (!QT_GROUP_QUEUE_AVAILABLE || !t) return '';
    return '<button class="' + cls + '" data-qt-todogroup-queue="' + qtEsc(t.id) + '" title="Queue this group as a GROUP item to the panel\'s queue target">\u23f5</button>';
}

/** Queue todo group `id` (a GROUP item) to the panel's queue target. */
function qtQueueTodoGroup(id) {
    vscode.postMessage({ type: 'qtQueueTodoGroup', questId: qtCurrentQuestId, todoId: id });
}

/** A member line for a member this list has no row of: another quest's, archived, or missing. */
function qtRenderGroupMemberLine(m) {
    var where = m.foreign ? '' : (m.found ? ' (archived)' : ' (not found)');
    return '<div class="qt-group-member-line' + (m.found ? '' : ' missing') + '" data-qt-member-ref="' + qtEsc(m.ref) + '"' +
        ' title="' + qtEsc((m.foreign ? 'A member from another quest: ' : 'A member: ') + m.ref + (m.title ? ' \u2014 ' + m.title : '') + where + (m.found ? ' \u2014 click to open it' : '')) + '">' +
        '<span class="status-icon">' + (m.found ? qtStatusIcon(m.status) : '\u2753') + '</span>' +
        '<span class="tid">' + qtEsc(m.ref) + '</span>' +
        '<span class="ttitle">' + qtEsc(m.title || '') + where + '</span></div>';
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
    if (qtScopeMulti) {
        var row = qtTodos.find(function(t) { return t.id === id; });
        var q = row ? qtQuestKey(row) : '';
        if (q) {
            qtExpandedGroups['#' + qtQuestGroupKey(q)] = true;
            qtExpandedGroups['#' + q + '::' + qtTodoPrefix(id)] = true;
        }
    }
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

/**
 * A todo's target date (`due`): overdue (the date has passed and the todo is
 * open, computed by the host) a red calendar with the date; otherwise the date
 * as a quiet chip (vscimpb152aa).
 */
function qtDueMark(t) {
    if (!t.due) return '';
    if (t.overdue === true) {
        return '<span class="qt-due qt-overdue" title="Overdue: it was due on ' + qtEsc(t.due) + '"><span class="codicon codicon-calendar"></span> ' + qtEsc(t.due) + '</span>';
    }
    return '<span class="qt-due" title="Due on ' + qtEsc(t.due) + '"><span class="codicon codicon-calendar"></span> ' + qtEsc(t.due) + '</span>';
}

function qtRenderTodoRow(t) {
    var icon = qtStatusIcon(t.status);
    var cls = 'qt-todo-item status-' + (t.status || 'not-started');
    if (t.user_action === true) cls += ' user-action';
    if (t.overdue === true) cls += ' overdue';
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
    var queueItemBtn = '';
    // Terminal (-archived / -deleted) files refuse archive/delete moves,
    // so suppress the per-item trash button for todos sourced from them.
    var isTerminalSrc = qtIsTerminalTodoFileName(t.sourceFile || qtCurrentFile);
    // An archived or deleted todo (the scope's file toggles, vscimpb137): read-only, one action, Restore.
    var retired = t.retired || '';
    var restoreBtn = '';
    if (retired) {
        cls += ' retired';
        restoreBtn = '<span class="qt-retired-badge" title="An ' + retired + ' todo: read-only">' + retired + '</span>' +
            '<button class="qt-restore-btn" data-qt-restore="' + qtEsc(t.id) + '" title="Restore: back into the live file it came from">↩️ Restore</button>';
    } else if (isDone) {
        trashBtn = isTerminalSrc ? '' : '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Delete (move to -archived/-deleted file)">🗑️</button>';
        reopenBtn = '<button class="qt-reopen-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Reopen (set to not-started)">🔄</button>';
    } else if (t.status === 'waiting-for-repeat') {
        // A repeated todo waiting for its next repetition: Repeat now brings it back at once.
        reopenBtn = '<button class="qt-reopen-btn qt-repeat-now-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Repeat now (set to not-started)' + (t.next_repeat ? ' — otherwise due ' + qtEsc(t.next_repeat.replace('T', ' ')) : '') + '">⏭️</button>';
    } else {
        queueItemBtn = isQuestMode ? qtQueueItemButton(t) : '';
        moveBtn = isQuestMode && qtCurrentFile === 'all' ? '<button class="qt-move-btn" data-qt-move="' + qtEsc(t.id) + '" title="Move to main quest todo file">➡️</button>' : '';
        moveWsBtn = '<button class="qt-move-ws-btn" data-qt-movews="' + qtEsc(t.id) + '" title="' + (qtStack.length > 1 ? 'Move ' + qtStack.length + ' stacked todos to another group / quest / workspace / another quest…' : 'Move this todo to another group / quest / workspace / another quest…') + '">⬆️</button>';
    }
    var priorityBadge = t.priority && (t.priority === 'critical' || t.priority === 'high') ? '<span class="priority-badge ' + t.priority + '">' + t.priority.toUpperCase() + '</span>' : '';
    var priorityDot = t.priority ? '<span class="qt-priority-dot ' + qtEsc(t.priority) + '">●</span>' : '';
    var stackIdx = qtStackIndexOf(t.id);
    var circleTitle = stackIdx >= 0
        ? 'Remove from todo stack (#' + (stackIdx + 1) + ')'
        : 'Add to todo stack (shift-click: add range from last picked)';
    var stackCircle = retired ? '' : '<span class="qt-stack-circle' + (stackIdx >= 0 ? ' stacked' : '') + '" data-qt-stackid="' + qtEsc(t.id) + '" title="' + circleTitle + '">' + (stackIdx >= 0 ? (stackIdx + 1) : '') + '</span>';
    // The quest in front of the id (the prefix toggle, vscimpb137).
    var shownId = qtShowQuestPrefix && qtQuestKey(t) ? qtQuestKey(t) + '/' + t.id : t.id;
    return '<div class="' + cls + '" data-qt-id="' + qtEsc(t.id) + '">' +
        '<div class="qt-todo-item-row1">' +
        '<span class="status-icon">' + icon + '</span>' +
        (t.user_action === true ? '<span class="qt-user-action" title="Your to do: a prefix* queue walk passes it">👤</span>' : '') +
        qtRepeatMark(t) +
        qtQueuedMark(t) +
        qtBlockingMark(t) +
        qtDueMark(t) +
        '<span class="ttitle">' + qtEsc(t.title || '') + '</span>' +
        qtDecisionChip(t) +
        qtPartOfChips(t) +
        priorityBadge + queueItemBtn + moveBtn + moveWsBtn + trashBtn + reopenBtn + restoreBtn + '</div>' +
        '<div class="qt-todo-item-row2">' +
        stackCircle +
        priorityDot +
        '<span class="tid">' + qtEsc(shownId) + '</span>' +
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
    // A walk runs in one quest: the group's (several quests by quest), else the panel's own; a group
    // combining several quests has none.
    var showWalk = !!group.prefix && !(qtScopeMulti && !group.quest);
    return '<div class="qt-group-header' + (expanded ? '' : ' collapsed') + '"' +
        ' data-qt-group="' + qtEsc(group.key || group.prefix) + '"' +
        (group.quest ? ' data-qt-group-quest="' + qtEsc(group.quest) + '"' : '') +
        ' title="' + (expanded ? 'Collapse' : 'Expand') + ' ' + qtEsc(group.label) + ' (' + count + ')">' +
        '<span class="codicon codicon-chevron-down"></span>' +
        '<span class="qt-group-label">' + qtEsc(group.label) + '</span>' +
        '<span class="qt-group-count">(' + count + ')</span>' +
        qtGroupQueuedMark(group) +
        qtGroupDecisionMark(group) +
        (showWalk
            ? '<button class="qt-group-walk-btn" data-qt-group-walk="' + qtEsc(group.prefix) + '" title="Queue Group Prompt: a walk over the todos of ' + qtEsc(group.prefix) + '* with a group prompt you pick…">🔁</button>'
            : '') +
        (group.prefix && qtCurrentQuestId && qtCurrentQuestId.indexOf('__') !== 0
            ? '<button class="qt-group-rename-btn" data-qt-group-rename="' + qtEsc(group.prefix) + '" title="Rename group ' + qtEsc(group.prefix) + '…: a new prefix for its live todos, references following, a stub per old id">✏️</button>'
            : '') +
        (qtGroupOpenTodos(group).length
            ? '<button class="qt-group-move-btn" data-qt-group-move="' + qtEsc(group.key || group.prefix) + '" title="Move the open todos of this group to another group / quest / workspace / another quest…">⬆️</button>'
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

/**
 * The rows of one set of todos: the todo groups (vscimpb126) and the prefix groups, or a plain list.
 * `quest` (several quests by quest): the groups are that quest's, their expand keys its own. Every
 * group rendered goes into `groups` (the move button finds it there); the rows on screen into `renderOrder`.
 */
function qtListHtml(filtered, renderOrder, groups, quest, grouped) {
    var html = '';
    var prefixGroups = grouped ? qtGroupTodosByPrefix(filtered) : [];
    prefixGroups.forEach(function(g) {
        if (quest) { g.key = quest + '::' + g.prefix; g.quest = quest; }
        groups.push(g);
    });
    // Todo groups (vscimpb126): a group todo heads its members, in `comprised_of`
    // order; a member also stays in its prefix group (shown twice). Members are
    // not in renderOrder, so a shift-click range never counts a row twice.
    var todoGroups = grouped ? qtTodoGroupsOf(filtered, quest || qtCurrentQuestId) : [];
    for (var tgi = 0; tgi < todoGroups.length; tgi++) {
        var tg = todoGroups[tgi];
        var tgExpanded = qtIsGroupExpanded(qtTodoGroupKey(tg.todo.id));
        html += qtRenderTodoGroupHeader(tg, tgExpanded);
        if (!tgExpanded) continue;
        html += '<div class="qt-todogroup-members">';
        for (var tm = 0; tm < tg.members.length; tm++) {
            var member = tg.members[tm];
            if (member.row) { html += qtRenderTodoRow(member.row); continue; }
            // A member of this quest the filter hides is left out, like any row.
            var inList = !member.foreign && qtTodos.some(function(x) { return String(x.id) === (member.ref.indexOf('/') >= 0 ? member.ref.slice(member.ref.indexOf('/') + 1) : member.ref); });
            if (inList) continue;
            html += qtRenderGroupMemberLine(member);
        }
        html += '</div>';
    }
    for (var gi = 0; gi < prefixGroups.length; gi++) {
        var group = prefixGroups[gi];
        var expanded = qtIsGroupExpanded(group.key || group.prefix);
        html += qtRenderGroupHeader(group, expanded);
        if (!expanded) continue;
        for (var gt = 0; gt < group.todos.length; gt++) {
            html += qtRenderTodoRow(group.todos[gt]);
            renderOrder.push(group.todos[gt].id);
        }
    }
    if (!grouped) {
        for (var pt = 0; pt < filtered.length; pt++) {
            html += qtRenderTodoRow(filtered[pt]);
            renderOrder.push(filtered[pt].id);
        }
    }
    return html;
}

/** The expand key of a quest in a list arranged by quest. */
function qtQuestGroupKey(quest) {
    return 'quest:' + quest;
}

/** A quest's header in a list arranged by quest: its name and how many todos it shows. */
function qtRenderQuestHeader(quest, count, expanded) {
    return '<div class="qt-quest-header' + (expanded ? '' : ' collapsed') + '" data-qt-quest="' + qtEsc(quest) + '"' +
        ' title="' + (expanded ? 'Collapse' : 'Expand') + ' quest ' + qtEsc(quest) + ' (' + count + ')">' +
        '<span class="codicon codicon-chevron-down"></span>' +
        '<span class="codicon codicon-library"></span>' +
        '<span class="qt-group-label">' + qtEsc(quest) + '</span>' +
        '<span class="qt-group-count">(' + count + ')</span>' +
        '</div>';
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
        if ((qtFilterState.overdue || []).length && qtFilterState.overdue.indexOf(t.overdue === true ? 'yes' : 'no') === -1) return false;
        if (qtFilterSearch) {
            var hay = ((t.id || '') + ' ' + (t.title || '') + ' ' + (t.sourceFile || '')).toLowerCase();
            if (hay.indexOf(qtFilterSearch) === -1) return false;
        }
        return true;
    });

    // Apply multi-field sort; ties (and no field chosen) by id in natural order.
    {
        var priOrd = { critical: 0, high: 1, medium: 2, low: 3 };
        var staOrd = { 'in-progress': 0, 'blocked': 1, 'decision-needed': 2, 'not-started': 3, 'waiting-for-repeat': 4, 'group': 5, 'completed': 6, 'cancelled': 7 };
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

    // Several quests (the scope, vscimpb137), arranged by quest: quests first, then each quest's groups
    // or its todos as a list. Otherwise one set: the groups of every quest shown together.
    var renderOrder = [];
    var html = '';
    var groups = [];
    var byQuest = qtScopeMulti && qtScopeQuests.length > 1 && qtScopeOrder !== 'combined';
    if (byQuest) {
        var questOrder = [];
        var perQuest = {};
        filtered.forEach(function(t) {
            var q = qtQuestKey(t);
            if (!perQuest[q]) { perQuest[q] = []; questOrder.push(q); }
            perQuest[q].push(t);
        });
        questOrder.sort();
        questOrder.forEach(function(q) {
            var qExpanded = qtIsGroupExpanded(qtQuestGroupKey(q));
            html += qtRenderQuestHeader(q, perQuest[q].length, qExpanded);
            if (!qExpanded) return;
            html += '<div class="qt-quest-members">';
            if (qtScopeOrder === 'quest-groups') {
                html += qtListHtml(perQuest[q], renderOrder, groups, q, true);
            } else {
                perQuest[q].forEach(function(t) { html += qtRenderTodoRow(t); renderOrder.push(t.id); });
            }
            html += '</div>';
        });
    } else {
        html = qtListHtml(filtered, renderOrder, groups, '', qtGroupByPrefix);
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
                vscode.postMessage({ type: 'qtQueueGroupPrompt', questId: hdr.getAttribute('data-qt-group-quest') || qtCurrentQuestId, prefix: walkBtn.getAttribute('data-qt-group-walk') || '' });
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
                var group = groups.find(function(g) { return (g.key || g.prefix) === prefix; });
                if (!group) { return; }
                var todos = qtGroupOpenTodos(group).map(function(t) { return { todoId: t.id, sourceFile: t.sourceFile || undefined }; });
                vscode.postMessage({ type: 'qtMoveTodosToDestination', questId: qtCurrentQuestId, file: qtCurrentFile, todos: todos });
                return;
            }
            qtToggleGroup(hdr.getAttribute('data-qt-group') || '');
        });
    });
    pane.querySelectorAll('.qt-quest-header').forEach(function(hdr) {
        hdr.addEventListener('click', function() { qtToggleGroup(qtQuestGroupKey(hdr.getAttribute('data-qt-quest') || '')); });
    });
    pane.querySelectorAll('.qt-restore-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            qtRestoreTodo(btn.getAttribute('data-qt-restore') || '');
        });
    });
    pane.querySelectorAll('.qt-todogroup-header').forEach(function(hdr) {
        hdr.addEventListener('click', function(e) {
            var id = hdr.getAttribute('data-qt-todogroup') || '';
            if (e.target.closest('.qt-todogroup-toggle')) { qtToggleGroup(qtTodoGroupKey(id)); return; }
            var queueBtn = e.target.closest('.qt-todogroup-queue-btn');
            if (queueBtn) {
                e.stopPropagation();
                qtPauseButton(queueBtn);
                qtQueueTodoGroup(id);
                return;
            }
            // The header opens the group todo's details, as its tile does.
            qtSelectedTodoId = id;
            qtNavPush(id);
            qtRenderList();
            qtRequestTodoDetail(id);
        });
    });
    pane.querySelectorAll('.qt-group-member-line').forEach(function(el) {
        el.addEventListener('click', function() {
            if (el.classList.contains('missing')) return;
            qtGoToTodoRef(el.getAttribute('data-qt-member-ref') || '');
        });
    });
    pane.querySelectorAll('.qt-todo-item').forEach(function(el) {
        el.addEventListener('click', function(e) {
            var chip = e.target.closest('.qt-partof-chip');
            if (chip) {
                e.stopPropagation();
                qtGoToTodoRef(chip.getAttribute('data-qt-partof') || '');
                return;
            }
            var circleEl = e.target.closest('.qt-stack-circle');
            if (circleEl) {
                qtToggleStack(circleEl.getAttribute('data-qt-stackid'), e.shiftKey);
                return;
            }
            var queueItem = e.target.closest('.qt-queue-item-btn');
            if (queueItem) {
                e.stopPropagation();
                if (queueItem.disabled) return;
                qtPauseButton(queueItem);
                qtQueueAsTodoItem(queueItem.getAttribute('data-qt-queue-item') || '');
                return;
            }
            if (e.target.closest('.qt-move-btn') || e.target.closest('.qt-move-ws-btn') || e.target.closest('.qt-trash-btn') || e.target.closest('.qt-reopen-btn') || e.target.closest('.qt-restore-btn')) return;
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
        case 'group': return '🗂️';
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
        qtFilterState.userAction.length > 0 || qtFilterState.blocking.length > 0 || (qtFilterState.overdue || []).length > 0 ||
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
    var statuses = ['not-started','in-progress','blocked','decision-needed','waiting-for-repeat','group','completed','cancelled'];
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
    html += '<div class="qt-picker-section-header">Overdue</div>';
    if (!qtFilterState.overdue) qtFilterState.overdue = [];
    [['yes', '📅 overdue (the due date has passed, still open)'], ['no', 'not overdue']].forEach(function(o) {
        var checked = qtFilterState.overdue.indexOf(o[0]) >= 0;
        html += '<div class="qt-picker-option" data-qt-filter-type="overdue" data-qt-filter-val="' + o[0] + '">' +
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

/**
 * The detail form's group rows (vscimpb126): Members — a group's
 * `comprised_of`, editable (add, remove, reorder), shown for a group todo and
 * when the status is set to `group` — with its queue button, and Part of — the
 * groups the todo belongs to (derived, read-only).
 */
function qtRenderGroupRows(todo) {
    var isGroup = todo.status === 'group' || Array.isArray(todo.comprised_of);
    var members = todo.comprised_of || [];
    var done = 0;
    members.forEach(function(ref) { var i = qtMemberInfo(ref); if (i && (i.status === 'completed' || i.status === 'cancelled')) done++; });
    var html = '<div id="qt-d-members-row"' + (isGroup ? '' : ' style="display:none;"') + '>' +
        qtFormRow('Members' + (members.length ? ' (' + done + '/' + members.length + ' done)' : ''),
            '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-comprised-wrap" title="The group\'s members (comprised_of), in order; the group completes once every member is done">' +
            qtRenderTodoBadges(members, 'comprised-of') +
            '<button class="qt-edit-btn" id="qt-d-comprised-add" title="Add member">\u2795</button></div>' +
            (QT_GROUP_QUEUE_AVAILABLE ? '<button class="qt-edit-btn" id="qt-d-group-queue" title="Queue this group as a GROUP item to the panel\'s queue target">\u23f5 Queue group</button>' : '')) +
        '</div>';
    if ((todo.part_of || []).length) {
        html += qtFormRow('Part of', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-partof-wrap" title="The groups whose members include this todo; edit Members on the group to change it">' +
            qtRenderTodoBadges(todo.part_of, 'part-of') + '</div>');
    }
    return html;
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
        qtRenderGroupRows(todo) +
        ((todo.blocking || []).length
            ? qtFormRow('Blocking', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-blocking-wrap" title="The todos whose Blocked By names this one; set Blocked By on those to change it">' +
                qtRenderTodoBadges(todo.blocking, 'blocking') + '</div>')
            : '') +
        qtFormRow('Notes' + qtMdButtons('notes', 'Notes'), '<textarea id="qt-d-notes" data-completion="on">' + qtEsc(todo.notes || '') + '</textarea>') +
        qtRenderDecisionsSection() +
        qtRenderScopeSection(qtFormScope) +
        qtRenderRefsSection(qtFormRefs) +
        qtOnDoneSection(todo) +
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
    qtAttachOnDoneHandlers(todo);
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
        // A group's members row shows once the status is `group`.
        var membersRow = document.getElementById('qt-d-members-row');
        if (membersRow && newStatus === 'group') { membersRow.style.display = ''; }
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
    qtAttachTodoBadgeHandlers('comprised-of');
    qtAttachTodoBadgeHandlers('part-of');
    document.getElementById('qt-d-comprised-add').addEventListener('click', function() { qtShowTodoPicker('comprised-of'); });
    var groupQueueBtn = document.getElementById('qt-d-group-queue');
    if (groupQueueBtn) { groupQueueBtn.addEventListener('click', function() { qtPauseButton(groupQueueBtn); qtQueueTodoGroup(todo.id); }); }
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
    if (todo._retired) qtMakeDetailReadOnly(todo);
}

/**
 * An archived or deleted todo's detail (vscimpb137): read-only, marked as such, with one action,
 * Restore. Every field and button of the form is disabled; links and the Markdown views still open.
 */
function qtMakeDetailReadOnly(todo) {
    var pane = document.getElementById('qt-detail-pane');
    var form = pane && pane.querySelector('.qt-detail-form');
    if (!form) return;
    form.classList.add('retired');
    form.querySelectorAll('input, textarea, select, button').forEach(function(el) {
        if (el.classList.contains('qt-md-btn') || el.closest('.qt-md-btns')) return;
        el.disabled = true;
    });
    var banner = document.createElement('div');
    banner.className = 'qt-retired-banner';
    banner.innerHTML = '<span class="codicon codicon-' + (todo._retired === 'archived' ? 'archive' : 'trash') + '"></span>' +
        '<span>' + (todo._retired === 'archived' ? 'Archived' : 'Deleted') + ' todo \u2014 read-only.</span>' +
        '<button type="button" class="qt-restore-btn" data-qt-restore="' + qtEsc(todo.id) + '" title="Restore: back into the live file it came from">↩️ Restore</button>';
    form.insertBefore(banner, form.firstChild);
    banner.querySelector('.qt-restore-btn').addEventListener('click', function() { qtRestoreTodo(todo.id); });
}

// ── Todo badge rendering for blocked-by / dependencies ──
/**
 * The todo-id badge lists of the detail form, by category: the field they
 * edit, their wrapper and add button. `blocking` and `part-of` are read-only
 * (derived from the others' blocked_by / comprised_of); `comprised-of` (a
 * group's members) keeps its order and can be reordered (vscimpb126).
 */
var QT_BADGE_CATS = {
    'blocked-by': { field: 'blocked_by', wrap: 'qt-d-blocked-wrap', add: 'qt-d-blocked-add', addTitle: 'Add blocked-by', pickTitle: 'Blocked By' },
    'deps': { field: 'dependencies', wrap: 'qt-d-deps-wrap', add: 'qt-d-deps-add', addTitle: 'Add dependency', pickTitle: 'Dependencies' },
    'comprised-of': { field: 'comprised_of', wrap: 'qt-d-comprised-wrap', add: 'qt-d-comprised-add', addTitle: 'Add member', pickTitle: 'Members', ordered: true },
    'blocking': { wrap: 'qt-d-blocking-wrap', readOnly: true },
    'part-of': { wrap: 'qt-d-partof-wrap', readOnly: true },
};

/** A group member's title and status from the detail payload (`group_members`), for its badge. */
function qtMemberInfo(ref) {
    var members = qtDetailTodo && Array.isArray(qtDetailTodo.group_members) ? qtDetailTodo.group_members : [];
    for (var i = 0; i < members.length; i++) { if (members[i].ref === ref) return members[i]; }
    var local = qtTodos.filter(function(t) { return t.id === ref; })[0];
    return local ? { ref: ref, title: local.title, status: local.status, found: true } : null;
}

/** Badges of todo ids; read-only categories have no remove button, `comprised-of` badges carry ◀ ▶ to reorder. */
function qtRenderTodoBadges(ids, category) {
    var cat = QT_BADGE_CATS[category] || {};
    return ids.map(function(id, idx) {
        var info = category === 'comprised-of' ? qtMemberInfo(id) : null;
        var title = 'Navigate to ' + id + (info && info.title ? ' \u2014 ' + info.title : '') + (info && info.status ? ' (' + info.status + ')' : '');
        return '<span class="qt-todo-badge" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '" title="' + qtEsc(title) + '">' +
            (info ? '<span class="qt-badge-status">' + qtStatusIcon(info.status) + '</span>' : '') +
            qtEsc(id) +
            (cat.ordered && idx > 0 ? '<span class="qt-badge-move" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '" data-qt-move-dir="-1" title="Move up">\u25c0</span>' : '') +
            (cat.ordered && idx < ids.length - 1 ? '<span class="qt-badge-move" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '" data-qt-move-dir="1" title="Move down">\u25b6</span>' : '') +
            (cat.readOnly ? '' : '<span class="qt-badge-remove" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '">\u00d7</span>') +
            '</span>';
    }).join('');
}

/** Render a category's badges and its add button again, with their handlers. */
function qtRefreshTodoBadges(category) {
    var cat = QT_BADGE_CATS[category];
    var wrap = cat ? document.getElementById(cat.wrap) : null;
    if (!wrap || !qtDetailTodo) return;
    var arr = qtDetailTodo[cat.field] || [];
    wrap.innerHTML = qtRenderTodoBadges(arr, category) +
        (cat.readOnly ? '' : '<button class="qt-edit-btn" id="' + cat.add + '" title="' + cat.addTitle + '">\u2795</button>');
    qtAttachTodoBadgeHandlers(category);
    if (!cat.readOnly) { document.getElementById(cat.add).addEventListener('click', function() { qtShowTodoPicker(category); }); }
}

function qtAttachTodoBadgeHandlers(category) {
    var cat = QT_BADGE_CATS[category];
    var wrap = cat ? document.getElementById(cat.wrap) : null;
    if (!wrap) return;
    wrap.querySelectorAll('.qt-todo-badge[data-qt-badge-cat="' + category + '"]').forEach(function(badge) {
        badge.addEventListener('click', function(e) {
            if (e.target.closest('.qt-badge-remove') || e.target.closest('.qt-badge-move')) return;
            qtGoToTodoRef(badge.dataset.qtBadgeId || '');
        });
    });
    wrap.querySelectorAll('.qt-badge-remove[data-qt-badge-cat="' + category + '"]').forEach(function(rm) {
        rm.addEventListener('click', function(e) {
            e.stopPropagation();
            var arr = qtDetailTodo[cat.field] || [];
            var idx = arr.indexOf(rm.dataset.qtBadgeId);
            if (idx >= 0) arr.splice(idx, 1);
            qtDetailTodo[cat.field] = arr;
            qtRefreshTodoBadges(category);
            qtAutoSave();
        });
    });
    wrap.querySelectorAll('.qt-badge-move[data-qt-badge-cat="' + category + '"]').forEach(function(mv) {
        mv.addEventListener('click', function(e) {
            e.stopPropagation();
            var arr = (qtDetailTodo[cat.field] || []).slice();
            var idx = arr.indexOf(mv.dataset.qtBadgeId);
            var to = idx + Number(mv.dataset.qtMoveDir || 0);
            if (idx < 0 || to < 0 || to >= arr.length) return;
            arr.splice(to, 0, arr.splice(idx, 1)[0]);
            qtDetailTodo[cat.field] = arr;
            qtRefreshTodoBadges(category);
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
    var field = QT_BADGE_CATS[category].field;
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
    var html = '<h4>Select ' + QT_BADGE_CATS[category].pickTitle + '</h4>' +
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
        qtRefreshTodoBadges(category);
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
    var field = QT_BADGE_CATS[category].field;
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
        // The target completion date (vscimpb152aa): past it, an open todo is overdue; on it, one reminder.
        '<div class="qt-inline-row">' +
        qtFormRow('Due', '<input type="date" id="qt-d-due-date" value="' + qtEsc(todo.due || '') + '"' +
            (todo.overdue === true ? ' class="qt-overdue-input" title="Overdue"' : '') + '>' +
            (todo.due_reminded ? '<span class="qt-due-reminded" title="The one reminder for this date went out">🔔 ' + qtEsc(String(todo.due_reminded).replace('T', ' ')) + '</span>' : '')) +
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
    var dueEl = document.getElementById('qt-d-due-date');
    if (dueEl) dueEl.addEventListener('change', qtAutoSave);
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
    var dueEl = document.getElementById('qt-d-due-date');
    return {
        title: document.getElementById('qt-d-title') ? document.getElementById('qt-d-title').value : '',
        status: document.getElementById('qt-d-status') ? document.getElementById('qt-d-status').value : '',
        priority: document.getElementById('qt-d-priority') ? document.getElementById('qt-d-priority').value || undefined : undefined,
        description: document.getElementById('qt-d-desc') ? document.getElementById('qt-d-desc').value : '',
        tags: tags.length ? tags : undefined,
        dependencies: deps.length ? deps : undefined,
        blocked_by: blockedBy.length ? blockedBy : undefined,
        // A group's members, in order; [] clears them. Absent when the todo has none and is no group.
        comprised_of: qtDetailTodo && (Array.isArray(qtDetailTodo.comprised_of) || qtDetailTodo.status === 'group')
            ? (qtDetailTodo.comprised_of || []).slice() : undefined,
        notes: document.getElementById('qt-d-notes') ? document.getElementById('qt-d-notes').value || undefined : undefined,
        scope: qtFormScope || undefined,
        references: qtFormRefs.length ? qtFormRefs : undefined,
        decisions: qtFormDecisions.length ? qtFormDecisions : undefined,
        created: createdValue || undefined,
        // '' clears the date (the host removes it); absent when the form has no Due field.
        due: dueEl ? dueEl.value.trim() : undefined,
        completed_date: completedDateValue || undefined,
        completed_by: completedByValue || undefined,
        // Absent on the new-todo form (undefined: nothing to write); false
        // clears the mark on an existing todo.
        user_action: document.getElementById('qt-d-user-action') ? document.getElementById('qt-d-user-action').checked : undefined,
        // null clears a rule; absent (no Repeat section) leaves it as it is.
        repeat: qtReadRepeatForm(),
        // null removes it; absent (no After done group: the new-todo form) leaves it.
        on_done: qtReadOnDoneForm(),
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
// ── After done: the todo's on_done, and filed_by read-only ──
var QT_OD_ACTIONS = [
    ['unblock', 'unblock', 'Remove this todo from the targets\' Blocked By (written there now, while this todo is open)'],
    ['notify', 'notify', 'The todo done notification: the notify prompt, else the configured template (none without either), into the run and session that queued the todo'],
    ['queue', 'queue', 'Queue the targets in the target quest and run'],
    ['none', 'none', 'Nothing but the instructions'],
];

/**
 * The After done group: the quest and run the targets are in (default this
 * quest; the run picker lists that quest's process runs), the targets, the
 * actions, instructions for the agent, the notify prompt and where the result
 * is reported. Saved as `on_done` (replaced as a whole); `filed_by` is shown
 * below it, read-only.
 */
function qtOnDoneSection(todo) {
    var od = (todo && todo.on_done) || {};
    var acts = od.action || [];
    var quests = qtQuestList.filter(function(q) { return q && q.indexOf('__') !== 0; });
    if (od.quest && quests.indexOf(od.quest) < 0) quests = quests.concat([od.quest]);
    var questOpts = '<option value="">(this quest)</option>' + quests.map(function(q) {
        return '<option value="' + qtEsc(q) + '"' + (q === od.quest ? ' selected' : '') + '>' + qtEsc(q) + '</option>';
    }).join('');
    var fb = (todo && todo.filed_by) || null;
    var filedBy = fb
        ? [fb.quest ? 'quest ' + fb.quest : '', fb.run ? 'run ' + fb.run : '', fb.session ? 'session ' + fb.session : '', fb.todo ? 'todo ' + fb.todo : '', fb.at ? fb.at.replace('T', ' ') : '']
            .filter(Boolean).join(' · ')
        : '';
    return '<div class="qt-section-header" data-qt-section="ondone">' +
        '<span class="codicon codicon-chevron-down"></span> After done</div>' +
        '<div class="qt-section-body" data-qt-section-body="ondone" id="qt-od">' +
        '<div class="qt-inline-row">' +
        qtFormRow('Quest', '<select id="qt-od-quest" title="The quest the targets are in">' + questOpts + '</select>') +
        qtFormRow('Run', '<input id="qt-od-run" list="qt-od-runs" placeholder="default" value="' + qtEsc(od.run || '') + '"><datalist id="qt-od-runs"></datalist>') +
        '</div>' +
        qtFormRow('Targets', '<input id="qt-od-todos" placeholder="todo ids, comma-separated" value="' + qtEsc((od.todos || []).join(', ')) + '">') +
        qtFormRow('Actions', '<span class="qt-od-actions">' + QT_OD_ACTIONS.map(function(a) {
            return '<label title="' + qtEsc(a[2]) + '"><input type="checkbox" data-od-action="' + a[0] + '"' + (acts.indexOf(a[0]) >= 0 ? ' checked' : '') + '>' + a[1] + '</label>';
        }).join('') + '</span>') +
        qtFormRow('Instructions', '<textarea id="qt-od-instructions" placeholder="What the agent does when the todo is completed">' + qtEsc(od.instructions || '') + '</textarea>') +
        qtFormRow('Notify prompt', '<textarea id="qt-od-notify" placeholder="The done notification notify queues (empty: the Todo — Done Notification template, else none)">' + qtEsc(od.notify_prompt || '') + '</textarea>') +
        qtFormRow('Report to', '<input id="qt-od-report" placeholder="path#section" value="' + qtEsc(od.report_to || '') + '">') +
        qtFormRow('Filed by', '<input id="qt-od-filed-by" readonly class="qt-readonly" value="' + qtEsc(filedBy || '(not recorded)') + '" title="Written when the todo was filed; not editable">') +
        '</div>';
}

/** The After done group as `on_done`: null when it holds nothing, undefined when the form has no such group. */
function qtReadOnDoneForm() {
    var root = document.getElementById('qt-od');
    if (!root) return undefined;
    var val = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var od = {};
    if (val('qt-od-quest').trim()) od.quest = val('qt-od-quest').trim();
    if (val('qt-od-run').trim()) od.run = val('qt-od-run').trim();
    var todos = val('qt-od-todos').split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    if (todos.length) od.todos = todos;
    var acts = [];
    root.querySelectorAll('input[data-od-action]').forEach(function(cb) { if (cb.checked) acts.push(cb.dataset.odAction); });
    if (acts.length) od.action = acts;
    if (val('qt-od-instructions').trim()) od.instructions = val('qt-od-instructions');
    if (val('qt-od-notify').trim()) od.notify_prompt = val('qt-od-notify');
    if (val('qt-od-report').trim()) od.report_to = val('qt-od-report').trim();
    return Object.keys(od).length ? od : null;
}

/** Ask the host for the process runs of the quest the targets are in. */
function qtRequestOnDoneRuns() {
    var q = document.getElementById('qt-od-quest');
    var quest = (q && q.value) || (qtDetailTodo && qtDetailTodo._resolvedQuestId) || qtCurrentQuestId;
    if (quest && quest.indexOf('__') !== 0) vscode.postMessage({ type: 'qtGetRuns', questId: quest });
}

function qtFillOnDoneRuns(questId, runs) {
    var list = document.getElementById('qt-od-runs');
    if (!list) return;
    list.innerHTML = runs.map(function(r) { return '<option value="' + qtEsc(r) + '"></option>'; }).join('');
}

function qtAttachOnDoneHandlers() {
    var root = document.getElementById('qt-od');
    if (!root) return;
    // Saved on change (leaving a field), not per keystroke: a target id is checked when it is written.
    root.querySelectorAll('input, textarea, select').forEach(function(el) {
        if (el.readOnly) return;
        el.addEventListener('change', qtAutoSave);
    });
    var q = document.getElementById('qt-od-quest');
    if (q) q.addEventListener('change', qtRequestOnDoneRuns);
    qtRequestOnDoneRuns();
}

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

/**
 * The Send and Queue buttons of a saved todo (qtTodoButton): Send runs the todo
 * now in a free session the host asks for, Queue adds it to a prompt queue the
 * host asks for (quest → run → free session → next / end, vscimpb139), both on
 * Anthropic whatever the queue's transport, with the template the Status Page's
 * Todo buttons setting names for the todo — the user-action one for a 👤
 * user-action todo, the other one for the rest.
 */
function qtTodoButtonsRow(todo) {
    var which = todo && todo.user_action === true ? 'user-action' : 'other';
    // Icon buttons (vscimpb151): the default queue button first (the default run, default@default, the end),
    // then the ones that ask where.
    return qtFormRow('Run', '<div class="qt-todo-buttons">' +
        '<button class="icon-btn qt-todo-btn" type="button" data-qt-todo-btn="queueDefault" title="Queue this todo in the default run (default@default), at the end (Anthropic), with the Todo buttons template for ' + which + ' todos (Status Page)">' +
            '<span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
        '<button class="icon-btn qt-todo-btn" type="button" data-qt-todo-btn="chat" title="Send this todo now in a free session of this window (asked for), with the ANTHROPIC/LLM panel\'s profile and the Todo buttons template for ' + which + ' todos (Status Page)">' +
            '<span class="codicon codicon-send"></span></button>' +
        '<button class="icon-btn qt-todo-btn" type="button" data-qt-todo-btn="queue" title="Add this todo to a prompt queue (Anthropic): asks the quest, run, free session and next / end; with the Todo buttons template for ' + which + ' todos (Status Page)">' +
            '<span class="codicon codicon-account"></span><span class="codicon codicon-list-ordered"></span></button>' +
        '<button class="icon-btn qt-queue-item-detail-btn" type="button" title="Queue as todo item: ' +
            (todo && (todo.status === 'group' || (Array.isArray(todo.comprised_of) && todo.comprised_of.length)) ? 'a GROUP item that walks the group\'s members in order' : 'a TODO item — the queue claims the todo when it is sent and checks it is completed') +
            '; asks the quest, run, free session and next / end">' +
            '<span class="codicon codicon-run-all"></span></button>' +
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
    var which = btn.getAttribute('data-qt-todo-btn');
    vscode.postMessage(Object.assign({
        type: 'qtTodoButton',
        target: which === 'queue' || which === 'queueDefault' ? 'queue' : 'chat',
        questId: qtCurrentQuestId,
        todoId: qtDetailTodo.id,
        sourceFile: qtDetailTodo._sourceFile || undefined,
    }, which === 'queueDefault' ? { defaultTarget: true } : {}));
}
document.addEventListener('click', qtHandleTodoButtonClick);

/** The detail view's "Queue as todo item" button (vscimpb127). */
document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.qt-queue-item-detail-btn') : null;
    if (!btn || !qtDetailTodo || btn.disabled) { return; }
    e.preventDefault();
    qtPauseButton(btn);
    qtQueueAsTodoItem(qtDetailTodo.id);
});

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
    var opts = ['not-started','in-progress','blocked','decision-needed','waiting-for-repeat','group','completed','cancelled'];
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
            qtQuestList = (msg.quests || []).slice();
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
        case 'qtRuns':
            qtFillOnDoneRuns(msg.questId, msg.runs || []);
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
                        overdue: fs.overdue || [],
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
        case 'qtDoneNotification':
            // The Done notification toggle, kept per quest by the host (unset: off; disabled without a template).
            qtSetDoneNotificationLook(msg.on === true, msg.available !== false);
            break;
        case 'qtScope':
            qtApplyScope(msg);
            break;
        case 'qtRefreshRequest':
            // A todo file changed: load again what the panel shows.
            qtReloadView();
            break;
        case 'qtTemplatePicked': {
            // The template picker's choice: set as the select's change did, and shown on the button.
            var pickedSel = document.getElementById('qt-template-select');
            var offered = pickedSel && typeof msg.id === 'string'
                && Array.prototype.some.call(pickedSel.options, function(o) { return o.value === msg.id; });
            if (offered) {
                pickedSel.value = msg.id;
                pickedSel.dispatchEvent(new Event('change'));
            }
            break;
        }
        case 'qtTemplates': {
            var templateSel = document.getElementById('qt-template-select');
            if (templateSel) {
                var available = msg.templates || [];
                // Preserve the user's current pick across refreshes when it is
                // still an offered option; otherwise use the computed default.
                // A transport switch changes the options, so a now-invalid pick
                // correctly falls back to the new transport's default (Bug 3).
                var prev = templateSel.value;
                // The placeholder (None) before the first list is no pick: the host's default applies then.
                var stillValid = qtTemplatesLoaded && available.some(function(t) { return t.id === prev; });
                qtTemplatesLoaded = true;
                var selected = stillValid ? prev : (msg.selected || '__none__');
                templateSel.innerHTML = available.map(function(t) {
                    return '<option value="' + qtEsc(t.id) + '">' + qtEsc(t.label) + '</option>';
                }).join('');
                templateSel.value = selected;
                if (templateSel.value !== selected) templateSel.value = '__none__';
                qtCurrentTemplate = templateSel.value || '__none__';
                qtRenderTemplateButton();
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
