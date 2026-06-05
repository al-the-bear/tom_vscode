// @ts-nocheck
/* global vscode, qtHandleMessage, qtCurrentQuestId, qtCurrentFile, qtPendingSelectTodoId, _initialQuestId, _initialFile, _initialTodoId */
// Quest TODO custom-editor initial-selection override — extracted verbatim from
// the inline <script> of _buildHtml() in
// src/handlers/questTodoEditor-handler.ts (Phase B.22 webview restructuring).
//
// Loaded as a separate <script> AFTER the shared questTodoPanel script, because
// it reads and reassigns the global `qtHandleMessage` (defined there) and uses
// the qt* globals. The per-document `_initial*` values are seeded by main.js
// from window.__INIT__. After the quest dropdown is populated (qtQuests
// message) it overrides the selection; if a specific file is given it waits for
// the qtFiles message, selects the file, requests its todos, and queues the
// pending todo selection.

(function applyInitialSelection() {
    if (!_initialQuestId) return;
    // Wait for the qtQuests message to populate the dropdown, then override
    var origHandler = qtHandleMessage;
    var patched = false;
    qtHandleMessage = function(msg) {
        origHandler(msg);
        if (!patched && msg.type === 'qtQuests') {
            patched = true;
            qtHandleMessage = origHandler; // restore
            var sel = document.getElementById('qt-quest-select');
            if (sel) {
                // Ensure the option exists
                var found = false;
                for (var i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].value === _initialQuestId) { found = true; break; }
                }
                if (found) {
                    sel.value = _initialQuestId;
                    qtCurrentQuestId = _initialQuestId;
                }
            }
            // If specific file, wait for file list then select it
            if (_initialFile && _initialQuestId !== '__all_workspace__') {
                var origHandler2 = qtHandleMessage;
                qtHandleMessage = function(msg2) {
                    origHandler2(msg2);
                    if (msg2.type === 'qtFiles') {
                        qtHandleMessage = origHandler2;
                        var fsel = document.getElementById('qt-file-select');
                        if (fsel) {
                            for (var j = 0; j < fsel.options.length; j++) {
                                if (fsel.options[j].value === _initialFile) {
                                    fsel.value = _initialFile;
                                    qtCurrentFile = _initialFile;
                                    vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                                    if (_initialTodoId) {
                                        qtPendingSelectTodoId = _initialTodoId;
                                    }
                                    break;
                                }
                            }
                        }
                    }
                };
            } else if (_initialTodoId) {
                qtPendingSelectTodoId = _initialTodoId;
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile || 'all' });
            }
        }
    };
})();
