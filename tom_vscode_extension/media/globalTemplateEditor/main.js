// @ts-nocheck
/*
 * Prompt Template Editor client script — extracted verbatim from the inline
 * <script> in _getHtml() of src/handlers/globalTemplateEditor-handler.ts
 * (Phase B.15 webview restructuring).
 *
 * All data flows in via postMessage after the 'ready' handshake below; there
 * is no init.state payload. The only init value consumed is codiconsUri,
 * which is injected as a <link> at runtime (no placeholder exists for the
 * node_modules codicons asset).
 */
const vscode = acquireVsCodeApi();

// ── Codicons stylesheet (injected from init; cspSource-served, no placeholder) ──
const __INIT = window.__INIT__ || {};
if (__INIT.codiconsUri) {
    const __codiconsLink = document.createElement('link');
    __codiconsLink.rel = 'stylesheet';
    __codiconsLink.href = __INIT.codiconsUri;
    document.head.appendChild(__codiconsLink);
}

let categories = [];
let currentCategory = '';
let currentItemId = '';
let currentFields = [];

const categorySelect = document.getElementById('categorySelect');
const fileList = document.getElementById('fileList');
const editorArea = document.getElementById('editorArea');
const saveBar = document.getElementById('saveBar');
const panelHeadline = document.getElementById('panelHeadline');

function updateHeadline() {
    const cat = categories.find(c => c.id === currentCategory);
    panelHeadline.textContent = cat ? cat.label + ' — Template Editor' : 'Prompt Template Editor';
}

// ── Category select ──
categorySelect.addEventListener('change', () => {
    currentCategory = categorySelect.value;
    currentItemId = '';
    updateHeadline();
    vscode.postMessage({ type: 'selectCategory', category: currentCategory });
    renderFileList();
    editorArea.innerHTML = '<div class="no-selection">Select a template from the left to edit</div>';
    saveBar.style.display = 'none';
});

document.getElementById('btnAdd').addEventListener('click', () => {
    vscode.postMessage({ type: 'add', category: currentCategory });
});
document.getElementById('btnCopy').addEventListener('click', () => {
    if (!currentItemId) return;
    vscode.postMessage({ type: 'copy', category: currentCategory, itemId: currentItemId });
});
document.getElementById('btnRename').addEventListener('click', () => {
    if (!currentItemId) return;
    vscode.postMessage({ type: 'rename', category: currentCategory, itemId: currentItemId });
});
document.getElementById('btnDelete').addEventListener('click', () => {
    if (!currentItemId) return;
    vscode.postMessage({ type: 'delete', category: currentCategory, itemId: currentItemId });
});
document.getElementById('btnSave').addEventListener('click', () => {
    saveCurrentItem();
});

function renderCategories(initialCategory) {
    categorySelect.innerHTML = '';
    categories.forEach(cat => {
        const o = document.createElement('option');
        o.value = cat.id;
        o.textContent = cat.label;
        if (cat.id === initialCategory) o.selected = true;
        categorySelect.appendChild(o);
    });
    currentCategory = initialCategory || categories[0]?.id || '';
    updateHeadline();
}

function renderFileList(selectId) {
    const cat = categories.find(c => c.id === currentCategory);
    const items = cat?.items || [];
    if (items.length === 0) {
        fileList.innerHTML = '<div class="empty">No templates in this category</div>';
        return;
    }
    fileList.innerHTML = items.map(item =>
        '<div class="item' + (item.id === (selectId || currentItemId) ? ' selected' : '') +
        '" data-id="' + escapeAttr(item.id) + '">' + escapeText(item.label) + '</div>'
    ).join('');

    fileList.querySelectorAll('.item').forEach(el => {
        el.addEventListener('click', () => {
            currentItemId = el.dataset.id;
            fileList.querySelectorAll('.item').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
            vscode.postMessage({ type: 'selectItem', category: currentCategory, itemId: currentItemId });
        });
    });
}

var _helpOverlayAdded = false;
function ensureHelpOverlay() {
    if (_helpOverlayAdded) return;
    _helpOverlayAdded = true;
    var ov = document.createElement('div');
    ov.className = 'help-overlay';
    ov.id = 'helpOverlay';
    ov.innerHTML = '<div class="help-overlay-content"><button class="help-overlay-close" id="helpOverlayClose">&times;</button><div id="helpOverlayBody"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e) { if (e.target === ov) ov.classList.remove('visible'); });
    document.getElementById('helpOverlayClose').addEventListener('click', function() { ov.classList.remove('visible'); });
}
function showHelpOverlay(html) {
    ensureHelpOverlay();
    document.getElementById('helpOverlayBody').innerHTML = html;
    document.getElementById('helpOverlay').classList.add('visible');
}

function renderFields(fields) {
    currentFields = fields;
    if (!fields || fields.length === 0) {
        editorArea.innerHTML = '<div class="no-selection">No editable fields</div>';
        saveBar.style.display = 'none';
        return;
    }

    // Separate name + showInMenu for inline row, and find the textarea field
    var nameField = fields.find(function(f) { return f.name === 'name'; });
    var showInMenuField = fields.find(function(f) { return f.name === 'showInMenu'; });
    var otherFields = fields.filter(function(f) { return f.name !== 'name' && f.name !== 'showInMenu'; });

    var html = '';

    // Render name + showInMenu inline if both exist
    if (nameField && showInMenuField) {
        html += '<div class="field-inline-row">';
        html += '<div class="field"><label for="field_' + nameField.name + '">' + escapeText(nameField.label) + '</label>' +
            '<input type="text" id="field_' + nameField.name + '" value="' + escapeAttr(nameField.value || '') + '"' + (nameField.readonly ? ' readonly disabled' : '') + '></div>';
        html += '<div class="field checkbox-field">' +
            '<input type="checkbox" id="field_' + showInMenuField.name + '"' + (showInMenuField.value === 'true' ? ' checked' : '') +
            (showInMenuField.readonly ? ' disabled' : '') + '>' +
            '<label for="field_' + showInMenuField.name + '">' + escapeText(showInMenuField.label) + '</label></div>';
        html += '</div>';
    } else {
        // Render them normally if only one exists
        if (nameField) {
            html += '<div class="field"><label for="field_' + nameField.name + '">' + escapeText(nameField.label) + '</label>' +
                '<input type="text" id="field_' + nameField.name + '" value="' + escapeAttr(nameField.value || '') + '"' + (nameField.readonly ? ' readonly disabled' : '') + '></div>';
        }
        if (showInMenuField) {
            html += '<div class="field checkbox-field">' +
                '<input type="checkbox" id="field_' + showInMenuField.name + '"' + (showInMenuField.value === 'true' ? ' checked' : '') +
                (showInMenuField.readonly ? ' disabled' : '') + '>' +
                '<label for="field_' + showInMenuField.name + '">' + escapeText(showInMenuField.label) + '</label></div>';
        }
    }

    // Render remaining fields
    html += otherFields.map(function(f) {
        var helpBtn = f.help ? ' <button class="help-icon" type="button" data-help="' + escapeAttr(f.help) + '" title="Show help">?</button>' : '';
        var labelHtml = '<div class="label-row"><label for="field_' + f.name + '">' + escapeText(f.label) + '</label>' + helpBtn + '</div>';
        if (f.type === 'checkbox') {
            return '<div class="field checkbox-field">' +
                '<input type="checkbox" id="field_' + f.name + '"' + (f.value === 'true' ? ' checked' : '') +
                (f.readonly ? ' disabled' : '') + '>' +
                '<label for="field_' + f.name + '">' + escapeText(f.label) + '</label>' + helpBtn + '</div>';
        }
        if (f.type === 'select') {
            var opts = (f.options || []).map(function(o) {
                return '<option value="' + escapeAttr(o.value) + '"' + (o.value === f.value ? ' selected' : '') + '>' + escapeText(o.label) + '</option>';
            }).join('');
            return '<div class="field">' + labelHtml +
                '<select id="field_' + f.name + '"' + (f.readonly ? ' disabled' : '') + '>' + opts + '</select></div>';
        }
        if (f.type === 'multi-checkbox') {
            var checked = [];
            try { checked = JSON.parse(f.value || '[]'); } catch (e) { checked = []; }
            if (!Array.isArray(checked)) { checked = []; }
            var disabledWhen = f.disabledWhen || null;
            var disabledAttr = disabledWhen ? ' data-disabled-when-field="' + escapeAttr(disabledWhen.field) + '" data-disabled-when-equals="' + escapeAttr(disabledWhen.equals) + '"' : '';
            function renderMultiCheckOption(o) {
                var id = 'field_' + f.name + '__' + o.value.replace(/[^a-zA-Z0-9_-]/g, '_');
                var isChecked = checked.indexOf(o.value) >= 0;
                var roAttr = o.readOnly ? ' data-readonly="true"' : '';
                return '<label class="multi-checkbox-row" style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-weight:normal">' +
                    '<input type="checkbox" class="field-multi-option" data-field="' + f.name + '" value="' + escapeAttr(o.value) + '" id="' + id + '"' + roAttr + (isChecked ? ' checked' : '') + '>' +
                    escapeText(o.label) + '</label>';
            }
            if (Array.isArray(f.optionGroups) && f.optionGroups.length > 0) {
                // Grouped layout: global toolbar + per-group bulk buttons.
                // Buttons emit native click events that are picked up by the
                // delegated listener wired after innerHTML is set (see below).
                var globalBar = '<div class="multi-checkbox-toolbar" style="margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border,#444);display:flex;gap:6px;flex-wrap:wrap">' +
                    '<button type="button" class="mc-btn-all">Select All</button>' +
                    '<button type="button" class="mc-btn-none">Select None</button>' +
                    '<button type="button" class="mc-btn-readonly">Select Read-Only</button>' +
                    '</div>';
                var groupsHtml = f.optionGroups.map(function(grp) {
                    var groupRows = (grp.tools || []).map(renderMultiCheckOption).join('');
                    return '<div class="multi-checkbox-group-section" data-group-name="' + escapeAttr(grp.category) + '" style="margin-bottom:8px">' +
                        '<div class="multi-checkbox-group-header" style="display:flex;align-items:center;gap:8px;margin-bottom:2px;font-weight:600">' +
                            '<span>' + escapeText(grp.category) + '</span>' +
                            '<button type="button" class="mc-group-all" data-group="' + escapeAttr(grp.category) + '" style="font-size:0.85em">all</button>' +
                            '<button type="button" class="mc-group-none" data-group="' + escapeAttr(grp.category) + '" style="font-size:0.85em">none</button>' +
                        '</div>' +
                        '<div class="multi-checkbox-group" style="display:flex;flex-wrap:wrap;padding:2px 0 2px 12px">' + groupRows + '</div>' +
                    '</div>';
                }).join('');
                return '<div class="field multi-checkbox-field grouped" data-field-name="' + f.name + '"' + disabledAttr + '>' + labelHtml +
                    globalBar + groupsHtml + '</div>';
            }
            var rows = (f.options || []).map(renderMultiCheckOption).join('');
            return '<div class="field multi-checkbox-field" data-field-name="' + f.name + '"' + disabledAttr + '>' + labelHtml +
                '<div class="multi-checkbox-group" style="display:flex;flex-wrap:wrap;padding:4px 0">' + rows + '</div></div>';
        }
        var ro = f.readonly ? ' readonly disabled' : '';
        var inputType = f.type === 'number' ? 'number' : 'text';
        var isTextarea = f.type === 'textarea';
        var growClass = isTextarea ? ' field-grow' : '';
        var input = isTextarea
            ? '<textarea id="field_' + f.name + '"' + ro + '>' + escapeText(f.value || '') + '</textarea>'
            : '<input type="' + inputType + '" id="field_' + f.name + '" value="' + escapeAttr(f.value || '') + '"' + ro + '>';
        return '<div class="field' + growClass + '">' + labelHtml + input + '</div>';
    }).join('');

    editorArea.innerHTML = html;
    saveBar.style.display = 'flex';

    // Attach help icon click handlers
    editorArea.querySelectorAll('.help-icon').forEach(function(btn) {
        btn.addEventListener('click', function() { showHelpOverlay(btn.getAttribute('data-help')); });
    });

    // Wire conditional-disable for multi-checkbox fields that depend on
    // another field. Applies the current state now and re-runs whenever
    // the target field changes.
    function applyMultiCheckboxDisabled() {
        editorArea.querySelectorAll('.multi-checkbox-field[data-disabled-when-field]').forEach(function(group) {
            var srcName = group.getAttribute('data-disabled-when-field');
            var srcEquals = group.getAttribute('data-disabled-when-equals');
            var src = document.getElementById('field_' + srcName);
            if (!src) return;
            var srcVal = src.type === 'checkbox' ? String(!!src.checked) : src.value;
            var isDisabled = srcVal === srcEquals;
            group.style.opacity = isDisabled ? '0.45' : '';
            group.querySelectorAll('input.field-multi-option').forEach(function(cb) {
                cb.disabled = isDisabled;
            });
        });
    }
    editorArea.querySelectorAll('input[type="checkbox"], input[type="text"], input[type="number"], select').forEach(function(el) {
        el.addEventListener('change', applyMultiCheckboxDisabled);
    });
    applyMultiCheckboxDisabled();

    // Bulk-select buttons on grouped multi-checkbox fields. Three globals
    // (Select All / None / Read-Only) plus per-group all / none. Read-Only
    // selects every checkbox flagged data-readonly="true" and unchecks
    // the rest. Click handlers are delegated on the field root so groups
    // added later still work.
    editorArea.querySelectorAll('.multi-checkbox-field.grouped').forEach(function(field) {
        field.addEventListener('click', function(e) {
            var target = e.target;
            if (!target || target.tagName !== 'BUTTON') return;
            var checks = field.querySelectorAll('input.field-multi-option');
            if (target.classList.contains('mc-btn-all')) {
                checks.forEach(function(c) { c.checked = true; });
            } else if (target.classList.contains('mc-btn-none')) {
                checks.forEach(function(c) { c.checked = false; });
            } else if (target.classList.contains('mc-btn-readonly')) {
                checks.forEach(function(c) { c.checked = c.getAttribute('data-readonly') === 'true'; });
            } else if (target.classList.contains('mc-group-all') || target.classList.contains('mc-group-none')) {
                var groupName = target.getAttribute('data-group');
                var sections = field.querySelectorAll('.multi-checkbox-group-section');
                var on = target.classList.contains('mc-group-all');
                sections.forEach(function(s) {
                    if (s.getAttribute('data-group-name') !== groupName) return;
                    s.querySelectorAll('input.field-multi-option').forEach(function(c) { c.checked = on; });
                });
            } else {
                return;
            }
            e.preventDefault();
        });
    });
}

function saveCurrentItem() {
    if (!currentCategory || !currentItemId || !currentFields.length) return;
    const values = {};
    currentFields.forEach(f => {
        if (f.type === 'multi-checkbox') {
            // Collect the checked values from the field's option rows,
            // serialize as JSON so the extension side gets a stable shape
            // regardless of ordering.
            const picked = [];
            document.querySelectorAll('input.field-multi-option[data-field="' + f.name + '"]').forEach(function(cb) {
                if (cb.checked) { picked.push(cb.value); }
            });
            values[f.name] = JSON.stringify(picked);
            return;
        }
        const el = document.getElementById('field_' + f.name);
        if (!el) return;
        if (f.type === 'checkbox') {
            values[f.name] = String(el.checked);
        } else {
            values[f.name] = el.value;
        }
    });
    vscode.postMessage({ type: 'save', category: currentCategory, itemId: currentItemId, values });
}

function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Messages from extension ──
window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
        case 'allData':
            categories = msg.categories;
            renderCategories(msg.initialCategory);
            renderFileList(msg.initialItemId);
            if (msg.initialItemId) {
                currentItemId = msg.initialItemId;
                vscode.postMessage({ type: 'selectItem', category: currentCategory, itemId: currentItemId });
            }
            break;
        case 'categoryItems': {
            const cat = categories.find(c => c.id === msg.category);
            if (cat) cat.items = msg.items;
            renderFileList();
            break;
        }
        case 'itemFields':
            renderFields(msg.fields);
            break;
        case 'selectItem':
            if (msg.category) {
                var categoryChanged = currentCategory !== msg.category;
                currentCategory = msg.category;
                categorySelect.value = msg.category;
                if (categoryChanged) {
                    // Items for this category may be stale if the file was
                    // edited since the editor was opened — fetch fresh,
                    // same code path as the categorySelect onchange handler
                    // (which the user confirmed recovers the correct list).
                    vscode.postMessage({ type: 'selectCategory', category: currentCategory });
                }
            }
            if (msg.itemId) {
                currentItemId = msg.itemId;
                renderFileList(msg.itemId);
                vscode.postMessage({ type: 'selectItem', category: currentCategory, itemId: currentItemId });
            }
            break;
    }
});

vscode.postMessage({ type: 'ready' });

// ── Splitter logic ──
(function() {
    const fileList = document.getElementById('fileList');
    const vSplitter = document.getElementById('vSplitter');
    let vDragging = false;
    vSplitter.addEventListener('mousedown', function(e) {
        vDragging = true;
        vSplitter.classList.add('dragging');
        e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
        if (vDragging) {
            const newWidth = Math.max(150, Math.min(e.clientX, window.innerWidth - 300));
            fileList.style.width = newWidth + 'px';
        }
    });
    document.addEventListener('mouseup', function() {
        if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
    });
})();
