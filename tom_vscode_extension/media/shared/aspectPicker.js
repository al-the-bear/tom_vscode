// @ts-check
/* The guideline picker (gsel5; design role_and_guideline_selector.vscode_extension.md
 * P-1..P-3, L-2): one level's choice of aspect-guideline options, per section.
 *
 * Shared by the Prompt Queue editor (the window, all windows, the run, the
 * item) and the todo panel (the todo). Classic script: it publishes
 * `window.TomAspectPicker`; the page's own script calls it.
 *
 * The data, as the host sends it (src/services/aspectPickerState.ts):
 *
 *   catalogue = { sections: [{ id, name, label, defaultOption?, options: [name…] }], problems?: [] }
 *   levels    = { questDefault?, window?, run?, roleType?, role?, item?, todo? }
 *               each a map section id → option name or `remove`
 *
 * {@link view} resolves every section over the levels up to the one edited
 * (lowest winning, as utils/aspectGuidelines.ts resolveAspects does) and says
 * which level decided; {@link buttonHtml} and {@link indicatorHtml} draw the
 * button and the list indicator; {@link open} shows the two-level popup:
 * sections, and on hover a section's options with *Don't add* and *Remove*.
 * A choice calls `onChoose(section, value)`: value `''` is *Don't add* (no
 * entry on this level), `remove` is *Remove*, anything else an option. */

(function () {
    /** The levels, the highest (overridden by every other) first. */
    var LEVELS = ['sectionDefault', 'questDefault', 'window', 'run', 'roleType', 'role', 'item', 'todo'];
    var REMOVE = 'remove';
    /** Where a choice comes from, as the popup says it (grey). */
    var ORIGIN = {
        sectionDefault: 'default', questDefault: 'from quest', window: 'from window', run: 'from run',
        roleType: 'from role type', role: 'from role', item: 'from item', todo: 'from todo',
    };
    var POPUP_ID = 'tomAspectPopup';

    /**
     * @typedef {{ id: string, name: string, label: string, defaultOption?: string, options: string[], files?: Record<string, string> }} AspectCatalogueSection
     * @typedef {{ sections: AspectCatalogueSection[], problems?: string[] }} AspectCatalogue
     * @typedef {Record<string, Record<string, string> | undefined>} AspectLevels
     * @typedef {{ id: string, name: string, label: string, options: string[], option?: string, removed: boolean, from?: string, here?: string, files?: Record<string, string> }} AspectViewSection
     * @typedef {{ level: string, sections: AspectViewSection[], own: boolean }} AspectView
     */

    /** @param {unknown} s */
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * The effective choice of one section over the levels up to `level`: the
     * lowest level with an entry decides; an entry naming no option of the
     * section is skipped; with none, the section's default.
     * @param {AspectCatalogueSection} section @param {AspectLevels} levels @param {string} level
     * @returns {{ option?: string, removed: boolean, from?: string }}
     */
    function resolveSection(section, levels, level) {
        var top = LEVELS.indexOf(level);
        if (top < 0) { top = LEVELS.length - 1; }
        for (var i = top; i > 0; i--) {
            var choices = levels[LEVELS[i]];
            var entry = choices ? choices[section.id] : undefined;
            if (entry === undefined) { continue; }
            if (entry === REMOVE) { return { removed: true, from: LEVELS[i] }; }
            if (section.options.indexOf(entry) >= 0) { return { option: entry, removed: false, from: LEVELS[i] }; }
        }
        return section.defaultOption
            ? { option: section.defaultOption, removed: false, from: 'sectionDefault' }
            : { removed: false };
    }

    /**
     * The picker's view of `level`: every section with its effective choice,
     * where it comes from and this level's own entry; `own` when this level
     * chose anything.
     * @param {AspectCatalogue | null | undefined} catalogue @param {AspectLevels} levels @param {string} level
     * @returns {AspectView}
     */
    function view(catalogue, levels, level) {
        var lv = levels || {};
        var mine = lv[level] || {};
        var sections = ((catalogue && catalogue.sections) || []).map(function (s) {
            var r = resolveSection(s, lv, level);
            /** @type {AspectViewSection} */
            var out = { id: s.id, name: s.name, label: s.label || s.name, options: s.options.slice(), removed: r.removed };
            if (r.option !== undefined) { out.option = r.option; }
            if (r.from !== undefined) { out.from = r.from; }
            if (mine[s.id] !== undefined) { out.here = mine[s.id]; }
            if (s.files) { out.files = s.files; }
            return out;
        });
        return { level: level, sections: sections, own: sections.some(function (s) { return s.here !== undefined; }) };
    }

    /**
     * The effective selection in a line (`Answer: brief · Night: on`); with
     * `star`, a section this level chose itself is starred.
     * @param {AspectView} v @param {{ star?: boolean }} [opts]
     */
    function summary(v, opts) {
        var star = !!(opts && opts.star);
        var parts = v.sections.filter(function (s) { return s.removed || s.option !== undefined; }).map(function (s) {
            return s.label + ': ' + (s.removed ? 'removed' : s.option) + (star && s.from === v.level ? '*' : '');
        });
        return parts.length ? parts.join(' \u00b7 ') : 'nothing chosen';
    }

    /**
     * The hover help: the title, the effective selection, what this level
     * chose itself, and the file each effective choice's text comes from (own
     * text or a guideline file, gsel17).
     * @param {AspectView} v @param {string} title
     */
    function hoverText(v, title) {
        var own = v.sections.filter(function (s) { return s.here !== undefined; })
            .map(function (s) { return s.label + ': ' + (s.here === REMOVE ? 'Remove' : s.here); });
        var files = v.sections.filter(function (s) { return !s.removed && s.option !== undefined && s.files && s.files[s.option]; })
            .map(function (s) { return s.label + ': ' + /** @type {Record<string, string>} */ (s.files)[/** @type {string} */ (s.option)]; });
        return title + ': ' + summary(v) + (own.length ? '\nChosen here: ' + own.join(' \u00b7 ') : '')
            + (files.length ? '\nFrom: ' + files.join(' \u00b7 ') : '');
    }

    /**
     * The button: an icon, a dot when this level chose something itself, the
     * effective selection as its hover help. `attrs` adds attributes
     * (`data-…` naming what it opens).
     * @param {AspectView} v
     * @param {{ title: string, icon?: string, id?: string, attrs?: Record<string, string>, extraClass?: string }} opts
     */
    function buttonHtml(v, opts) {
        var attrs = opts.attrs || {};
        var extra = Object.keys(attrs).map(function (k) { return ' ' + k + '="' + esc(attrs[k]) + '"'; }).join('');
        return '<button type="button" class="tom-aspect-btn' + (v.own ? ' own' : '') + (opts.extraClass ? ' ' + esc(opts.extraClass) : '') + '"'
            + (opts.id ? ' id="' + esc(opts.id) + '"' : '')
            + ' data-aspect-own="' + (v.own ? 'true' : 'false') + '"'
            + ' title="' + esc(hoverText(v, opts.title)) + '" aria-label="' + esc(opts.title) + '"' + extra + '>'
            + '<span class="codicon ' + esc(opts.icon || 'codicon-book') + '"></span>'
            + (v.own ? '<span class="tom-aspect-dot" aria-hidden="true"></span>' : '')
            + '</button>';
    }

    /**
     * The list indicator: only when this level chose something itself; the
     * details on hover. '' otherwise.
     * @param {AspectView} v @param {string} title
     */
    function indicatorHtml(v, title) {
        if (!v.own) { return ''; }
        return '<span class="tom-aspect-ind" title="' + esc(hoverText(v, title)) + '">'
            + '<span class="codicon codicon-book"></span><span class="tom-aspect-dot" aria-hidden="true"></span></span>';
    }

    /** Close the open popup, if any. */
    function close() {
        var old = document.getElementById(POPUP_ID);
        if (old) { old.remove(); }
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
    }

    /** @param {Event} ev */
    function onOutside(ev) {
        var popup = document.getElementById(POPUP_ID);
        var t = /** @type {Node | null} */ (ev.target);
        if (popup && t && !popup.contains(t)) { close(); }
    }

    /** @param {KeyboardEvent} ev */
    function onKey(ev) {
        if (ev.key === 'Escape') { close(); }
    }

    /** @param {AspectViewSection} s */
    function valueText(s) {
        return s.removed ? 'removed' : (s.option !== undefined ? s.option : 'none');
    }

    /** @param {AspectViewSection} s @param {string} level */
    function originHtml(s, level) {
        if (s.from === level) { return '<span class="tom-aspect-origin here">\u2713 here</span>'; }
        if (!s.from) { return '<span class="tom-aspect-origin">nothing chosen</span>'; }
        return '<span class="tom-aspect-origin">' + esc(ORIGIN[/** @type {keyof typeof ORIGIN} */ (s.from)] || s.from) + '</span>';
    }

    /**
     * One option row of a section's submenu.
     * @param {AspectViewSection} s @param {string} value @param {string} text
     */
    function optionHtml(s, value, text) {
        var here = value === '' ? s.here === undefined : s.here === value;
        var effective = value === REMOVE ? s.removed : (value !== '' && !s.removed && s.option === value);
        return '<div class="tom-aspect-option' + (here ? ' mine' : '') + (effective ? ' effective' : '') + '" role="menuitemradio"'
            + ' aria-checked="' + (here ? 'true' : 'false') + '" tabindex="-1"'
            + ' data-section="' + esc(s.id) + '" data-value="' + esc(value) + '"'
            + (s.files && value && s.files[value] ? ' title="' + esc(s.files[value]) + '"' : '') + '>'
            + '<span class="tom-aspect-mark">' + (here ? '\u25cf' : '') + '</span>'
            + '<span class="tom-aspect-option-text">' + esc(text) + '</span>'
            + (effective && !here ? '<span class="tom-aspect-origin">\u2713</span>' : '')
            + '</div>';
    }

    /** Open one section's submenu (and close the others). @param {HTMLElement} popup @param {HTMLElement | null} row */
    function openSection(popup, row) {
        popup.querySelectorAll('.tom-aspect-section.open').forEach(function (r) { if (r !== row) { r.classList.remove('open'); } });
        if (!row) { return; }
        row.classList.add('open');
        var rect = row.getBoundingClientRect();
        // Not enough room on the right: the options open to the left.
        row.classList.toggle('flip', rect.right + 220 > (window.innerWidth || 0) && rect.left > 220);
    }

    /**
     * The popup, anchored under `anchor`: the title, one row per section (its
     * effective choice and where it comes from), on hover its options with
     * *Don't add* and *Remove* (this level's choice marked ●), and *Edit
     * sections…* at the bottom. A choice closes it.
     * @param {HTMLElement | null} anchor
     * @param {AspectView} v
     * @param {{ title: string, note?: string, onChoose: (section: string, value: string) => void, onEditSections?: () => void }} opts
     * @returns {HTMLElement}
     */
    function open(anchor, v, opts) {
        close();
        var popup = document.createElement('div');
        popup.id = POPUP_ID;
        popup.className = 'tom-aspect-popup';
        popup.setAttribute('role', 'menu');
        popup.setAttribute('data-level', v.level);
        var rows = v.sections.map(function (s) {
            return '<div class="tom-aspect-section' + (s.here !== undefined ? ' chosen-here' : '') + '" role="menuitem" tabindex="0" aria-haspopup="true" data-section="' + esc(s.id) + '">'
                + '<span class="tom-aspect-section-label" title="' + esc(s.name) + '">' + esc(s.label) + '</span>'
                + '<span class="tom-aspect-section-value">' + esc(valueText(s)) + '</span>'
                + originHtml(s, v.level)
                + '<span class="codicon codicon-chevron-right"></span>'
                + '<div class="tom-aspect-options" role="menu">'
                + optionHtml(s, '', 'Don\'t add')
                + s.options.map(function (o) { return optionHtml(s, o, o); }).join('')
                + optionHtml(s, REMOVE, 'Remove')
                + '</div></div>';
        }).join('');
        popup.innerHTML = '<div class="tom-aspect-popup-title">' + esc(opts.title) + '</div>'
            + (opts.note ? '<div class="tom-aspect-popup-note">' + esc(opts.note) + '</div>' : '')
            + (rows || '<div class="tom-aspect-empty">No guideline aspects yet (_ai/aspect_guidelines/).</div>')
            + '<div class="tom-aspect-edit" role="menuitem" tabindex="0">Edit aspects\u2026</div>';
        document.body.appendChild(popup);
        if (anchor && anchor.getBoundingClientRect) {
            var r = anchor.getBoundingClientRect();
            var width = popup.offsetWidth || 260;
            var left = Math.max(4, Math.min(r.left, (window.innerWidth || 0) - width - 4));
            popup.style.left = (isFinite(left) ? left : 4) + 'px';
            popup.style.top = (r.bottom + 2) + 'px';
        }
        popup.querySelectorAll('.tom-aspect-section').forEach(function (row) {
            var el = /** @type {HTMLElement} */ (row);
            el.addEventListener('mouseenter', function () { openSection(popup, el); });
            el.addEventListener('focus', function () { openSection(popup, el); });
            el.addEventListener('click', function (ev) {
                var t = /** @type {HTMLElement | null} */ (ev.target);
                if (t && t.closest && t.closest('.tom-aspect-option')) { return; }
                openSection(popup, el.classList.contains('open') ? null : el);
            });
        });
        popup.querySelectorAll('.tom-aspect-option').forEach(function (opt) {
            opt.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var el = /** @type {HTMLElement} */ (opt);
                var section = el.getAttribute('data-section') || '';
                var value = el.getAttribute('data-value') || '';
                close();
                opts.onChoose(section, value);
            });
        });
        var edit = popup.querySelector('.tom-aspect-edit');
        if (edit) {
            edit.addEventListener('click', function () {
                close();
                if (opts.onEditSections) { opts.onEditSections(); }
            });
        }
        // Opened by this click: listen for the next one outside.
        setTimeout(function () {
            document.addEventListener('mousedown', onOutside, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);
        return popup;
    }

    window.TomAspectPicker = {
        LEVELS: LEVELS.slice(),
        ORIGIN: ORIGIN,
        resolveSection: resolveSection,
        view: view,
        summary: summary,
        hoverText: hoverText,
        buttonHtml: buttonHtml,
        indicatorHtml: indicatorHtml,
        open: open,
        close: close,
    };
})();
