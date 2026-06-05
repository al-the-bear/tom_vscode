// @ts-check
// Template Editor webview client — migrated from the inline <script> of
// showTemplateEditorPanel() in src/handlers/handler_shared.ts (Phase B.18
// webview restructuring).
//
// The panel renders a dynamic list of text/textarea fields. Previously the
// field HTML was string-built host-side and the field names were interpolated
// into the inline script. Both now flow through window.__INIT__ (first paint)
// and the field DOM is built here; Save/Cancel are wired with addEventListener
// (no inline handlers), so the loader's default nonce-only CSP applies.

/**
 * @typedef {Object} TemplateEditorField
 * @property {string} name
 * @property {string} label
 * @property {'text' | 'textarea'} type
 * @property {string} [placeholder]
 * @property {string} [value]
 * @property {string} [help]
 * @property {boolean} [readonly]
 */

(function () {
    const vscode = acquireVsCodeApi();
    const init = window.__INIT__ || {};
    const title = typeof init.title === 'string' ? init.title : '';
    /** @type {TemplateEditorField[]} */
    const fields = Array.isArray(init.fields) ? /** @type {TemplateEditorField[]} */ (init.fields) : [];

    const titleEl = document.getElementById('title');
    if (titleEl) {
        titleEl.textContent = title;
    }

    /**
     * Build the DOM for a single field.
     * @param {TemplateEditorField} f
     * @returns {HTMLDivElement}
     */
    function buildField(f) {
        const wrap = document.createElement('div');
        wrap.className = 'field';

        const label = document.createElement('label');
        label.setAttribute('for', f.name);
        label.textContent = f.label;
        wrap.appendChild(label);

        /** @type {HTMLInputElement | HTMLTextAreaElement} */
        let input;
        if (f.type === 'textarea') {
            const textarea = document.createElement('textarea');
            textarea.rows = 6;
            input = textarea;
        } else {
            const text = document.createElement('input');
            text.type = 'text';
            input = text;
        }
        input.id = f.name;
        input.value = f.value || '';
        if (f.placeholder) {
            input.placeholder = f.placeholder;
        }
        if (f.readonly) {
            input.readOnly = true;
            input.disabled = true;
            input.style.opacity = '0.7';
            input.style.cursor = 'not-allowed';
        }
        wrap.appendChild(input);

        if (f.help) {
            const help = document.createElement('div');
            help.className = 'help';
            // help is developer-provided trusted HTML (e.g. <code> snippets),
            // matching the original `<div class="help">${f.help}</div>` behavior.
            help.innerHTML = f.help;
            wrap.appendChild(help);
        }

        return wrap;
    }

    const fieldsContainer = document.getElementById('fields');
    if (fieldsContainer) {
        for (const f of fields) {
            fieldsContainer.appendChild(buildField(f));
        }
    }

    const cancelBtn = document.getElementById('cancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'cancel' });
        });
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', function () {
            /** @type {Record<string, string>} */
            const values = {};
            for (const f of fields) {
                const el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (
                    document.getElementById(f.name)
                );
                values[f.name] = el ? el.value : '';
            }
            vscode.postMessage({ type: 'save', values });
        });
    }
})();
