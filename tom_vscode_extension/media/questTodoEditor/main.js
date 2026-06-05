// @ts-nocheck
/* global acquireVsCodeApi, qtHandleMessage */
// Quest TODO custom-editor boot — extracted from the inline <script> of
// _buildHtml() in src/handlers/questTodoEditor-handler.ts (Phase B.22 webview
// restructuring).
//
// Runs BEFORE the composed shared questTodoPanel script (a separate inline
// <script> after this file). It:
//   1. acquires the VS Code API once and publishes it as the global `vscode`
//      (via `var`, so it becomes a window property) that the shared questTodo
//      script reads — that script does NOT call acquireVsCodeApi() itself;
//   2. seeds the per-document initial selection from window.__INIT__ into the
//      `_initial*` globals consumed by initialSelection.js;
//   3. registers the message listener that dispatches to qtHandleMessage
//      (defined later by the shared script — resolved at call time).

// `var` (not const) so `vscode` is a global the later inline script can read.
var vscode = acquireVsCodeApi();
window.__tomVscodeApi = vscode;

var __qtInit = window.__INIT__ || {};

// Pre-configured initial state derived from the document path.
var _initialQuestId = __qtInit.initialQuestId || '';
var _initialFile = __qtInit.initialFile || '';
var _initialTodoId = __qtInit.initialTodoId || '';

window.addEventListener('message', function (event) { qtHandleMessage(event.data); });
