// @ts-nocheck
// wsPanel webview client (the @WS accordion panel: Guidelines, Documentation,
// Logs, Settings, Issues, Tests, Quest TODO).
//
// Verbatim extraction of the guidelines + documentation editor logic that used
// to live inside the `additionalScript` template literal of
// `src/handlers/wsPanel-handler.ts`. It is loaded via `readMediaText('wsPanel',
// 'main.js')` and concatenated into the accordion's inline <script> AFTER the
// embedded fragment scripts (issues / tests / questTodo / documentPicker /
// status listeners) and the accordion base script — so the shared scope
// (`vscode`, `toggleSection`, `isExpanded`, `qtHandleMessage`, `docs_*`,
// `attachStatusPanelListeners`) is identical to before. `@ts-nocheck` because
// this is a legacy verbatim extraction that references those ambient globals;
// it tightens to `@ts-check` when the accordion shell is migrated (plan B.24).
//
// These symbols are provided at runtime by the accordion base script (`vscode`,
// `isExpanded`, `toggleSection`) and the sibling fragment scripts concatenated
// AHEAD of this file by wsPanel-handler.ts: the documentPicker fragment exposes
// the `docs_*` API (and wires the docs group/project/quest/file selectors
// itself), the questTodo fragment exposes
// `qtHandleMessage`, and the status-listeners fragment exposes
// `attachStatusPanelListeners`. Declared here so `no-undef` lint passes.
/* global vscode, isExpanded, toggleSection, qtHandleMessage,
   attachStatusPanelListeners, docs_getEffectiveGroup, docs_getSelectedFile,
   docs_updateUI, docs_selectGroup */

// Publish the host bridge so the shared completion component
// (media/shared/completion.js) can reuse it without calling acquireVsCodeApi()
// a second time (the accordion base script already acquired it as `vscode`).
window.__tomVscodeApi = vscode;

var guidelinesFiles = [];
var guidelinesSelectedFile = '';
var guidelinesSelectedGroup = 'global';
var guidelinesGroups = [];
var guidelinesProjects = [];
var guidelinesSelectedProject = '';
var guidelinesQuests = [];
var guidelinesSelectedQuest = '';
var guidelinesContent = '';
var guidelinesSaveTimer = null;

function effectiveGuidelinesGroup() {
    if (guidelinesSelectedGroup === 'project') return guidelinesSelectedProject;
    if (guidelinesSelectedGroup === 'quest') return guidelinesSelectedQuest;
    return guidelinesSelectedGroup;
}

function selectGuidelinesGroup(group) {
    guidelinesSelectedGroup = (group === 'projects' ? 'project' : (group || 'global'));
    guidelinesSelectedProject = '';
    guidelinesSelectedQuest = '';
    guidelinesSelectedFile = '';
    guidelinesContent = '';
    updateGuidelinesUI();
    if (guidelinesSelectedGroup !== 'project' && guidelinesSelectedGroup !== 'quest') {
        vscode.postMessage({ type: 'getGuidelinesFiles', group: guidelinesSelectedGroup });
    }
}

function selectGuidelinesProject(projectGroup) {
    guidelinesSelectedProject = projectGroup || '';
    guidelinesSelectedFile = '';
    guidelinesContent = '';
    updateGuidelinesUI();
    if (guidelinesSelectedProject) {
        vscode.postMessage({ type: 'getGuidelinesFiles', group: guidelinesSelectedProject });
    }
}

function selectGuidelinesQuest(questGroup) {
    guidelinesSelectedQuest = questGroup || '';
    guidelinesSelectedFile = '';
    guidelinesContent = '';
    updateGuidelinesUI();
    if (guidelinesSelectedQuest) {
        vscode.postMessage({ type: 'getGuidelinesFiles', group: guidelinesSelectedQuest });
    }
}

function selectGuidelinesFile(file) {
    guidelinesSelectedFile = file || '';
    if (guidelinesSelectedFile) {
        vscode.postMessage({ type: 'loadGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
    } else {
        guidelinesContent = '';
        updateGuidelinesUI();
    }
}

function reloadGuidelines() {
    vscode.postMessage({ type: 'getGuidelinesGroups' });
    if (effectiveGuidelinesGroup()) {
        vscode.postMessage({ type: 'getGuidelinesFiles', group: effectiveGuidelinesGroup() });
    }
}

function addGuidelinesFile() {
    vscode.postMessage({ type: 'addGuidelinesFile', group: effectiveGuidelinesGroup() });
}

function deleteGuidelinesFile() {
    if (!guidelinesSelectedFile) return;
    vscode.postMessage({ type: 'deleteGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function openGuidelinesInEditor() {
    if (!guidelinesSelectedFile) return;
    vscode.postMessage({ type: 'openGuidelinesInEditor', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function previewGuidelines() {
    if (!guidelinesSelectedFile) return;
    vscode.postMessage({ type: 'previewGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function openGuidelinesExternal() {
    if (!guidelinesSelectedFile) { vscode.postMessage({ type: 'showWarning', text: 'No file selected' }); return; }
    vscode.postMessage({ type: 'openGuidelinesExternal', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function updateGuidelinesUI() {
    var groupSel = document.getElementById('guidelines-group');
    if (groupSel) {
        groupSel.innerHTML = (guidelinesGroups || []).map(function(g) {
            return '<option value="' + g.id + '"' + (g.id === guidelinesSelectedGroup ? ' selected' : '') + '>' + g.label + '</option>';
        }).join('');
    }

    var projectSel = document.getElementById('guidelines-project');
    var projectLabel = document.getElementById('guidelines-project-label');
    if (projectSel) {
        if (guidelinesSelectedGroup === 'project' && (guidelinesProjects || []).length > 0) {
            if (projectLabel) projectLabel.style.display = '';
            projectSel.style.display = '';
            projectSel.innerHTML = '<option value="">(Select project)</option>' + (guidelinesProjects || []).map(function(p) {
                return '<option value="' + p.id + '"' + (p.id === guidelinesSelectedProject ? ' selected' : '') + '>' + p.label + '</option>';
            }).join('');
        } else {
            if (projectLabel) projectLabel.style.display = 'none';
            projectSel.style.display = 'none';
            projectSel.innerHTML = '';
        }
    }

    var questSel = document.getElementById('guidelines-quest');
    var questLabel = document.getElementById('guidelines-quest-label');
    if (questSel) {
        if (guidelinesSelectedGroup === 'quest' && (guidelinesQuests || []).length > 0) {
            if (questLabel) questLabel.style.display = '';
            questSel.style.display = '';
            questSel.innerHTML = '<option value="">(Select quest)</option>' + (guidelinesQuests || []).map(function(q) {
                return '<option value="' + q.id + '"' + (q.id === guidelinesSelectedQuest ? ' selected' : '') + '>' + q.label + '</option>';
            }).join('');
        } else {
            if (questLabel) questLabel.style.display = 'none';
            questSel.style.display = 'none';
            questSel.innerHTML = '';
        }
    }

    var fileSel = document.getElementById('guidelines-file');
    if (fileSel) {
        fileSel.innerHTML = '<option value="">(Select file)</option>' + (guidelinesFiles || []).map(function(f) {
            return '<option value="' + f + '"' + (f === guidelinesSelectedFile ? ' selected' : '') + '>' + f + '</option>';
        }).join('');
    }

    var ta = document.getElementById('guidelines-text');
    if (ta) {
        ta.value = guidelinesContent || '';
    }
}

function onGuidelinesInput() {
    var ta = document.getElementById('guidelines-text');
    if (!ta || !guidelinesSelectedFile) return;
    guidelinesContent = ta.value;
    if (guidelinesSaveTimer) clearTimeout(guidelinesSaveTimer);
    guidelinesSaveTimer = setTimeout(function() {
        vscode.postMessage({ type: 'saveGuidelinesFile', file: guidelinesSelectedFile, content: guidelinesContent, group: effectiveGuidelinesGroup() });
    }, 500);
}

// ---- Documentation panel (using shared documentPicker) ----
// (the documentPicker client script is injected ahead of this file by the
//  handler, so the docs_* API is already on `window`.)

// Local state for content (textarea)
var docsContent = '';
var docsSaveTimer = null;
// One-shot guard: default-select the first docs group on the initial
// `docsGroups` message (see the docsGroups handler below).
var docsDefaultApplied = false;

function reloadDocs() {
    vscode.postMessage({ type: 'getDocsGroups' });
    var group = docs_getEffectiveGroup();
    if (group) {
        vscode.postMessage({ type: 'docsGetFiles', group: group });
    }
}

function addDocsFile() {
    vscode.postMessage({ type: 'addDocsFile', group: docs_getEffectiveGroup() });
}

function deleteDocsFile() {
    var file = docs_getSelectedFile();
    if (!file) return;
    vscode.postMessage({ type: 'deleteDocsFile', file: file, group: docs_getEffectiveGroup() });
}

function openDocsInEditor() {
    var file = docs_getSelectedFile();
    if (!file) return;
    vscode.postMessage({ type: 'openDocsInEditor', file: file, group: docs_getEffectiveGroup() });
}

function previewDocs() {
    var file = docs_getSelectedFile();
    if (!file) return;
    vscode.postMessage({ type: 'previewDocsFile', file: file, group: docs_getEffectiveGroup() });
}

function openDocsExternal() {
    var file = docs_getSelectedFile();
    if (!file) { vscode.postMessage({ type: 'showWarning', text: 'No file selected' }); return; }
    vscode.postMessage({ type: 'openDocsExternal', file: file, group: docs_getEffectiveGroup() });
}

function updateDocsContent() {
    var ta = document.getElementById('docs-text');
    if (ta) {
        ta.value = docsContent || '';
    }
}

function onDocsInput() {
    var ta = document.getElementById('docs-text');
    var file = docs_getSelectedFile();
    if (!ta || !file) return;
    docsContent = ta.value;
    if (docsSaveTimer) clearTimeout(docsSaveTimer);
    docsSaveTimer = setTimeout(function() {
        vscode.postMessage({ type: 'saveDocsFile', file: file, content: docsContent, group: docs_getEffectiveGroup() });
    }, 500);
}

window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'guidelinesGroups') {
        guidelinesGroups = msg.groups || [];
        guidelinesProjects = msg.projects || [];
        guidelinesQuests = msg.quests || [];
        updateGuidelinesUI();
    } else if (msg.type === 'guidelinesFiles') {
        guidelinesFiles = msg.files || [];
        if (msg.selectedFile) guidelinesSelectedFile = msg.selectedFile;
        else if (guidelinesFiles.length > 0 && !guidelinesSelectedFile) guidelinesSelectedFile = guidelinesFiles[0];
        updateGuidelinesUI();
        if (guidelinesSelectedFile) {
            vscode.postMessage({ type: 'loadGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
        }
    } else if (msg.type === 'guidelinesContent') {
        guidelinesContent = msg.content || '';
        updateGuidelinesUI();
    } else if (msg.type === 'docsGroups') {
        // The documentPicker fragment already applied these groups via its own
        // message listener. Default-select the FIRST group once, so the initial
        // file list matches the selected group. Previously main.js instead
        // hard-requested the 'notes' files while the dropdown visually defaulted
        // to 'workspace' — the panel then showed Notes files under the Workspace
        // label, and a real Workspace selection later showed nothing.
        if (!docsDefaultApplied) {
            var firstDocsGroup = (msg.groups && msg.groups[0]) ? msg.groups[0].id : '';
            if (firstDocsGroup && typeof docs_selectGroup === 'function') {
                docsDefaultApplied = true;
                docs_selectGroup(firstDocsGroup);
            }
        }
    } else if (msg.type === 'docsFiles') {
        // Owned by the documentPicker fragment's own message listener; nothing
        // to do here (main.js only owns the docs editor text area).
    } else if (msg.type === 'docsContent') {
        docsContent = msg.content || '';
        updateDocsContent();
    }
});

// Called by accordion after each render (initial and toggle).
// Re-applies UI state so freshly-expanded sections show current data.
// Guards needed: during initial render() var assignments haven't executed yet
// (function declarations are hoisted but var assignments are not).
function onRenderComplete() {
    if (guidelinesGroups) updateGuidelinesUI();
    if (typeof docs_updateUI === 'function') docs_updateUI();
}

setTimeout(function() {
    var groupSel = document.getElementById('guidelines-group');
    if (groupSel) groupSel.addEventListener('change', function() { selectGuidelinesGroup(groupSel.value); });
    var projectSel = document.getElementById('guidelines-project');
    if (projectSel) projectSel.addEventListener('change', function() { selectGuidelinesProject(projectSel.value); });
    var questSel = document.getElementById('guidelines-quest');
    if (questSel) questSel.addEventListener('change', function() { selectGuidelinesQuest(questSel.value); });
    var guidelinesFileSel = document.getElementById('guidelines-file');
    if (guidelinesFileSel) guidelinesFileSel.addEventListener('change', function() { selectGuidelinesFile(guidelinesFileSel.value); });
    var guidelinesText = document.getElementById('guidelines-text');
    if (guidelinesText) guidelinesText.addEventListener('input', onGuidelinesInput);

    // NOTE: the docs group/project/quest/file <select> change handlers are wired
    // by the documentPicker fragment (getDocumentPickerScript, idPrefix 'docs'),
    // which is concatenated AHEAD of this file and owns those selectors. Do NOT
    // re-wire them here — an earlier extraction did, referencing non-existent
    // `selectDocs*` functions and throwing a ReferenceError on every change.
    // main.js only owns the editor text area below.
    var docsText = document.getElementById('docs-text');
    if (docsText) docsText.addEventListener('input', onDocsInput);

    vscode.postMessage({ type: 'getGuidelinesGroups' });
    vscode.postMessage({ type: 'getGuidelinesFiles', group: 'global' });
    vscode.postMessage({ type: 'getDocsGroups' });
    // No hardcoded initial file fetch: the docsGroups handler default-selects
    // the first group and the documentPicker fragment fetches its files.
    vscode.postMessage({ type: 'getStatusData' });
}, 0);

// Status panel listeners
// (attachStatusPanelListeners is provided by the status-listeners fragment
//  injected ahead of this file by the handler.)

// Route Quest TODO messages from extension to qtHandleMessage
// Route statusData messages to populate the settings panel
window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'expandSection') {
        // Programmatically expand an accordion section by ID
        var sid = msg.sectionId || '';
        if (sid && typeof isExpanded === 'function' && !isExpanded(sid)) {
            toggleSection(sid);
        }
        return;
    }
    if (typeof msg.type === 'string' && msg.type.startsWith('qt')) {
        qtHandleMessage(msg);
    } else if (msg.type === 'statusData') {
        var panel = document.getElementById('settings-status-panel');
        if (panel) {
            // Preserve collapse/expand states before replacing HTML
            var __savedCollapseStates = {};
            panel.querySelectorAll('.sp-collapse-content').forEach(function(el) {
                if (el.id) __savedCollapseStates[el.id] = el.classList.contains('sp-collapsed');
            });
            panel.innerHTML = msg.html || '<div class="sp-loading">No data</div>';
            // Restore collapse/expand states after replacing HTML
            Object.keys(__savedCollapseStates).forEach(function(elId) {
                var el = document.getElementById(elId);
                if (!el) return;
                var icon = el.previousElementSibling ? el.previousElementSibling.querySelector('.sp-collapse-icon') : null;
                if (__savedCollapseStates[elId]) {
                    el.classList.add('sp-collapsed');
                    if (icon) icon.textContent = '▶';
                } else {
                    el.classList.remove('sp-collapsed');
                    if (icon) icon.textContent = '▼';
                }
            });
        }
        attachStatusPanelListeners();
    }
});
