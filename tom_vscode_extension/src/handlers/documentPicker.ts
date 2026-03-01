/**
 * Document Picker — Reusable shared component for selecting workspace documents.
 *
 * Generates HTML, CSS, and JavaScript for a three-level document picker:
 *   Type (group) → Project (conditional) → File
 *
 * Special "Other file:" type allows browsing for any workspace file.
 *
 * Used by:
 *  - @WS Documentation subpanel (T3 panel accordion)
 *  - Markdown Browser custom editor
 */

// ============================================================================
// Configuration
// ============================================================================

/** Unique prefix for all DOM element IDs in a picker instance. */
export interface DocumentPickerConfig {
    /** Unique ID prefix for DOM elements (e.g. 'mdBrowser', 'docs'). */
    idPrefix: string;
    /** Whether to include the "Other file:" option for arbitrary file browsing. */
    allowOtherFile?: boolean;
    /** Whether to include the Type/Group dropdown (false = file-only mode). */
    showGroupSelector?: boolean;
    /** Label for the Type dropdown (default: 'Type:'). */
    groupLabel?: string;
    /** Label for the File dropdown (default: 'File:'). */
    fileLabel?: string;
}

// ============================================================================
// Group/File data structures (used by backend handlers)
// ============================================================================

export interface DocPickerGroup {
    id: string;
    label: string;
}

export interface DocPickerProject {
    id: string;
    label: string;
}

/** Categories of workspace document groups. */
export const DOC_GROUP_IDS = {
    GLOBAL_GUIDELINES: 'global',
    PROJECT_GUIDELINES: 'project',
    ROLES: 'roles',
    COPILOT_INSTRUCTIONS: 'copilot-instructions',
    WORKSPACE_DOCS: 'workspace',
    PROJECT_DOCS: 'project',
    NOTES: 'notes',
    OTHER_FILE: 'other',
} as const;

// ============================================================================
// HTML Generation
// ============================================================================

/**
 * Generate the HTML for a document picker toolbar.
 *
 * @param config Picker configuration
 * @returns HTML string for the toolbar row
 */
export function getDocumentPickerHtml(config: DocumentPickerConfig): string {
    const p = config.idPrefix;
    const showGroup = config.showGroupSelector !== false;
    const groupLabel = config.groupLabel || 'Type:';
    const fileLabel = config.fileLabel || 'File:';

    let html = '<div class="doc-picker-toolbar" id="' + p + '-toolbar">\n';

    if (showGroup) {
        html += '  <label for="' + p + '-group">' + groupLabel + '</label>\n';
        html += '  <select id="' + p + '-group" title="Group"></select>\n';
        html += '  <label id="' + p + '-project-label" for="' + p + '-project" style="display:none;">Project:</label>\n';
        html += '  <select id="' + p + '-project" title="Project" style="display:none;"></select>\n';
    }

    html += '  <label for="' + p + '-file">' + fileLabel + '</label>\n';
    html += '  <select id="' + p + '-file" title="File"></select>\n';

    // "Other file" input (shown only when group is "other")
    if (config.allowOtherFile) {
        html += '  <input id="' + p + '-other-input" type="text" placeholder="Enter file path..." '
            + 'style="display:none; flex:1; min-width:150px;" />\n';
        html += '  <button class="icon-btn" id="' + p + '-other-browse" style="display:none;" title="Browse...">'
            + '<span class="codicon codicon-folder-opened"></span></button>\n';
    }

    html += '</div>\n';
    return html;
}

// ============================================================================
// CSS Generation
// ============================================================================

/**
 * Generate the CSS for the document picker.
 */
export function getDocumentPickerCss(): string {
    return `
.doc-picker-toolbar {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    padding: 4px 0;
}
.doc-picker-toolbar label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}
.doc-picker-toolbar select {
    max-width: 220px;
    min-width: 100px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    padding: 2px 4px;
    font-size: var(--vscode-font-size);
}
.doc-picker-toolbar input[type="text"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    padding: 2px 4px;
    font-size: var(--vscode-font-size);
}
`;
}

// ============================================================================
// JavaScript Generation
// ============================================================================

/**
 * Generate the client-side JavaScript for a document picker instance.
 *
 * The generated code exposes functions on the `window` object with
 * the prefix as a namespace:
 *   - `{prefix}_selectGroup(group)`
 *   - `{prefix}_selectProject(project)`
 *   - `{prefix}_selectFile(file)`
 *   - `{prefix}_updateUI()`
 *   - `{prefix}_setGroups(groups, projects)`
 *   - `{prefix}_setFiles(files, selectedFile)`
 *   - `{prefix}_getSelectedFile()` → string
 *   - `{prefix}_getEffectiveGroup()` → string
 *   - `{prefix}_setSelectedFile(filePath)` — programmatic selection
 *
 * Message types emitted (via vscode.postMessage):
 *   - `{prefix}GetFiles`    — { group }
 *   - `{prefix}LoadFile`    — { file, group }
 *   - `{prefix}BrowseFile`  — {}
 *
 * Message types consumed (via window message listener):
 *   - `{prefix}Groups`      — { groups, projects }
 *   - `{prefix}Files`       — { files, selectedFile }
 *
 * @param config Picker configuration
 * @returns JavaScript string to embed in webview
 */
export function getDocumentPickerScript(config: DocumentPickerConfig): string {
    const p = config.idPrefix;
    const showGroup = config.showGroupSelector !== false;
    const allowOther = config.allowOtherFile === true;

    return `
// ============================================================================
// Document Picker: ${p}
// ============================================================================
(function() {
    var _${p}_groups = [];
    var _${p}_projects = [];
    var _${p}_files = [];
    var _${p}_selectedGroup = '';
    var _${p}_selectedProject = '';
    var _${p}_selectedFile = '';

    function _${p}_effectiveGroup() {
        return _${p}_selectedGroup === 'project' ? _${p}_selectedProject : _${p}_selectedGroup;
    }

    function _${p}_updateUI() {
        ${showGroup ? `
        var groupSel = document.getElementById('${p}-group');
        if (groupSel) {
            groupSel.innerHTML = (_${p}_groups || []).map(function(g) {
                return '<option value="' + g.id + '"' + (g.id === _${p}_selectedGroup ? ' selected' : '') + '>' + g.label + '</option>';
            }).join('');
        }

        var projectSel = document.getElementById('${p}-project');
        var projectLabel = document.getElementById('${p}-project-label');
        if (projectSel) {
            if (_${p}_selectedGroup === 'project' && (_${p}_projects || []).length > 0) {
                if (projectLabel) projectLabel.style.display = '';
                projectSel.style.display = '';
                projectSel.innerHTML = '<option value="">(Select project)</option>' + (_${p}_projects || []).map(function(pp) {
                    return '<option value="' + pp.id + '"' + (pp.id === _${p}_selectedProject ? ' selected' : '') + '>' + pp.label + '</option>';
                }).join('');
            } else {
                if (projectLabel) projectLabel.style.display = 'none';
                projectSel.style.display = 'none';
                projectSel.innerHTML = '';
            }
        }
        ` : ''}

        var fileSel = document.getElementById('${p}-file');
        if (fileSel) {
            ${allowOther ? `
            if (_${p}_selectedGroup === 'other') {
                fileSel.style.display = 'none';
            } else {
                fileSel.style.display = '';
                fileSel.innerHTML = '<option value="">(Select file)</option>' + (_${p}_files || []).map(function(f) {
                    return '<option value="' + f + '"' + (f === _${p}_selectedFile ? ' selected' : '') + '>' + f + '</option>';
                }).join('');
            }
            ` : `
            fileSel.innerHTML = '<option value="">(Select file)</option>' + (_${p}_files || []).map(function(f) {
                return '<option value="' + f + '"' + (f === _${p}_selectedFile ? ' selected' : '') + '>' + f + '</option>';
            }).join('');
            `}
        }

        ${allowOther ? `
        var otherInput = document.getElementById('${p}-other-input');
        var otherBrowse = document.getElementById('${p}-other-browse');
        if (otherInput && otherBrowse) {
            if (_${p}_selectedGroup === 'other') {
                otherInput.style.display = '';
                otherBrowse.style.display = '';
            } else {
                otherInput.style.display = 'none';
                otherBrowse.style.display = 'none';
            }
        }
        ` : ''}
    }

    function _${p}_selectGroup(group) {
        _${p}_selectedGroup = (group === 'projects' ? 'project' : (group || ''));
        _${p}_selectedProject = '';
        _${p}_selectedFile = '';
        _${p}_updateUI();
        if (_${p}_selectedGroup !== 'project' && _${p}_selectedGroup !== 'other') {
            vscode.postMessage({ type: '${p}GetFiles', group: _${p}_selectedGroup });
        }
    }

    function _${p}_selectProject(proj) {
        _${p}_selectedProject = proj || '';
        _${p}_selectedFile = '';
        _${p}_updateUI();
        if (_${p}_selectedProject) {
            vscode.postMessage({ type: '${p}GetFiles', group: _${p}_selectedProject });
        }
    }

    function _${p}_selectFile(file) {
        _${p}_selectedFile = file || '';
        if (_${p}_selectedFile) {
            vscode.postMessage({ type: '${p}LoadFile', file: _${p}_selectedFile, group: _${p}_effectiveGroup() });
        }
    }

    function _${p}_setGroups(groups, projects) {
        _${p}_groups = groups || [];
        _${p}_projects = projects || [];
        _${p}_updateUI();
    }

    function _${p}_setFiles(files, selectedFile) {
        _${p}_files = files || [];
        if (selectedFile) _${p}_selectedFile = selectedFile;
        else if (_${p}_files.length > 0 && !_${p}_selectedFile) _${p}_selectedFile = _${p}_files[0];
        _${p}_updateUI();
        if (_${p}_selectedFile) {
            vscode.postMessage({ type: '${p}LoadFile', file: _${p}_selectedFile, group: _${p}_effectiveGroup() });
        }
    }

    function _${p}_getSelectedFile() { return _${p}_selectedFile; }
    function _${p}_getEffectiveGroup() { return _${p}_effectiveGroup(); }

    function _${p}_setSelectedFile(filePath) {
        _${p}_selectedFile = filePath || '';
        _${p}_updateUI();
    }

    // ---- Wire up DOM event listeners ----
    setTimeout(function() {
        ${showGroup ? `
        var groupSel = document.getElementById('${p}-group');
        if (groupSel) groupSel.addEventListener('change', function() { _${p}_selectGroup(groupSel.value); });
        var projectSel = document.getElementById('${p}-project');
        if (projectSel) projectSel.addEventListener('change', function() { _${p}_selectProject(projectSel.value); });
        ` : ''}
        var fileSel = document.getElementById('${p}-file');
        if (fileSel) fileSel.addEventListener('change', function() { _${p}_selectFile(fileSel.value); });
        ${allowOther ? `
        var otherInput = document.getElementById('${p}-other-input');
        if (otherInput) {
            otherInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    _${p}_selectedFile = otherInput.value;
                    vscode.postMessage({ type: '${p}LoadFile', file: otherInput.value, group: 'other' });
                }
            });
        }
        var otherBrowse = document.getElementById('${p}-other-browse');
        if (otherBrowse) otherBrowse.addEventListener('click', function() {
            vscode.postMessage({ type: '${p}BrowseFile' });
        });
        ` : ''}
    }, 0);

    // ---- Message listener ----
    window.addEventListener('message', function(e) {
        var msg = e.data;
        if (!msg || !msg.type) return;
        if (msg.type === '${p}Groups') {
            _${p}_setGroups(msg.groups, msg.projects);
        } else if (msg.type === '${p}Files') {
            _${p}_setFiles(msg.files, msg.selectedFile);
        }${allowOther ? ` else if (msg.type === '${p}BrowsedFile') {
            var otherInput = document.getElementById('${p}-other-input');
            if (otherInput) otherInput.value = msg.file || '';
            _${p}_selectedFile = msg.file || '';
            if (_${p}_selectedFile) {
                vscode.postMessage({ type: '${p}LoadFile', file: _${p}_selectedFile, group: 'other' });
            }
        }` : ''}
    });

    // ---- Expose API on window ----
    window['${p}_selectGroup'] = _${p}_selectGroup;
    window['${p}_selectProject'] = _${p}_selectProject;
    window['${p}_selectFile'] = _${p}_selectFile;
    window['${p}_updateUI'] = _${p}_updateUI;
    window['${p}_setGroups'] = _${p}_setGroups;
    window['${p}_setFiles'] = _${p}_setFiles;
    window['${p}_getSelectedFile'] = _${p}_getSelectedFile;
    window['${p}_getEffectiveGroup'] = _${p}_getEffectiveGroup;
    window['${p}_setSelectedFile'] = _${p}_setSelectedFile;
})();
`;
}
