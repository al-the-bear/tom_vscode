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
    var LEVELS = ['sectionDefault', 'workspace', 'questDefault', 'window', 'run', 'roleType', 'role', 'item', 'todo'];
    var REMOVE = 'remove';
    /** Where a choice comes from, as the popup says it (grey). */
    var ORIGIN = {
        sectionDefault: 'default', workspace: 'from workspace', questDefault: 'from quest', window: 'from window', run: 'from run',
        roleType: 'from role type', role: 'from role', item: 'from item', todo: 'from todo',
    };
    var POPUP_ID = 'tomAspectPopup';

    /**
     * @typedef {{ id: string, name: string, label: string, defaultOption?: string, options: string[], files?: Record<string, string>, when?: Record<string, string>, removeWhen?: string, holds?: Record<string, Record<string, boolean | 'error'>> }} AspectCatalogueSection
     * @typedef {{ sections: AspectCatalogueSection[], problems?: string[] }} AspectCatalogue
     * @typedef {Record<string, Record<string, string | string[]> | undefined>} AspectLevels
     * @typedef {{ id: string, name: string, label: string, options: string[], chosen?: string[], fromBy?: Record<string, string>, option?: string, removed: boolean, from?: string, here?: string | string[], files?: Record<string, string>, when?: Record<string, string>, removeWhen?: string, holds?: Record<string, Record<string, boolean | 'error'>>, kind?: string }} AspectViewSection
     * @typedef {{ level: string, sections: AspectViewSection[], own: boolean }} AspectView
     */

    /** @param {unknown} s */
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** A level's value read (gsel20): `remove`, or the choices it replaces with or (every entry with `+`) adds; undefined when it is none. */
    /** @param {unknown} value @returns {{ kind: string, choices: string[] } | undefined} */
    function parseValue(value) {
        if (typeof value === 'string') {
            if (value === REMOVE) { return { kind: 'remove', choices: [] }; }
            if (value.charAt(0) === '+') { return value.length > 1 ? { kind: 'add', choices: [value.slice(1)] } : undefined; }
            return value ? { kind: 'replace', choices: [value] } : undefined;
        }
        if (!Array.isArray(value)) { return undefined; }
        var list = /** @type {unknown[]} */ (value).filter(function (v) { return typeof v === 'string'; }).map(String);
        if (list.length !== value.length) { return undefined; }
        var adds = list.filter(function (v) { return v.charAt(0) === '+'; }).length;
        if (adds && adds !== list.length) { return undefined; }
        var names = list.map(function (v) { return adds ? v.slice(1) : v; });
        return { kind: adds ? 'add' : 'replace', choices: names.filter(function (n, k) { return n && names.indexOf(n) === k; }) };
    }

    /** A level's entry in its stored form: one choice as a string, else a list (`+` on every entry that adds). */
    /** @param {{ kind: string, choices: string[] }} entry @returns {string | string[]} */
    function formatValue(entry) {
        if (entry.kind === 'remove') { return REMOVE; }
        if (entry.kind === 'replace') { return entry.choices.length === 1 ? entry.choices[0] : entry.choices.slice(); }
        return entry.choices.map(function (c) { return '+' + c; });
    }

    /**
     * The effective choices of one aspect over the levels up to `level`, as
     * utils/aspectGuidelines.ts resolveAspects combines them: from the default
     * up, `remove` clears the set, a replacing entry sets it, an adding one adds
     * to it; an entry with no choice the aspect has is skipped. In the aspect's
     * choice order, with the level each comes from.
     * @param {AspectCatalogueSection} section @param {AspectLevels} levels @param {string} level
     * @returns {{ options: string[], option?: string, fromBy: Record<string, string>, removed: boolean, from?: string }}
     */
    function resolveSection(section, levels, level) {
        var top = LEVELS.indexOf(level);
        if (top < 0) { top = LEVELS.length - 1; }
        /** @type {Record<string, string>} */
        var set = {};
        var removed = false;
        /** @type {string | undefined} */
        var from;
        if (section.defaultOption) { set[section.defaultOption] = 'sectionDefault'; from = 'sectionDefault'; }
        for (var i = 1; i <= top; i++) {
            var choices = levels[LEVELS[i]];
            var entry = parseValue(choices ? choices[section.id] : undefined);
            if (!entry) { continue; }
            if (entry.kind === 'remove') { set = {}; removed = true; from = LEVELS[i]; continue; }
            var usable = entry.choices.filter(function (c) { return section.options.indexOf(c) >= 0; });
            if (!usable.length && entry.choices.length) { continue; }
            if (entry.kind === 'replace') { set = {}; }
            for (var k = 0; k < usable.length; k++) { if (!set[usable[k]]) { set[usable[k]] = LEVELS[i]; } }
            removed = false;
            from = LEVELS[i];
        }
        var options = section.options.filter(function (o) { return !!set[o]; });
        /** @type {{ options: string[], option?: string, fromBy: Record<string, string>, removed: boolean, from?: string }} */
        var out = { options: options, fromBy: set, removed: removed };
        if (options.length) { out.option = options[0]; }
        if (from !== undefined) { out.from = from; }
        return out;
    }

    /** The prompt kind a level stands for, for the conditions (gsel20): a todo's, a queue prompt's, else a chat send's. */
    /** @param {string} level */
    function kindOfLevel(level) {
        return level === 'todo' ? 'todo' : (level === 'item' || level === 'run') ? 'queue' : 'chat';
    }

    /**
     * The picker's view of `level`: every aspect with its effective choices,
     * where each comes from and this level's own entry; `own` when this level
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
            var out = { id: s.id, name: s.name, label: s.label || s.name, options: s.options.slice(), chosen: r.options, fromBy: r.fromBy, removed: r.removed, kind: kindOfLevel(level) };
            if (r.option !== undefined) { out.option = r.option; }
            if (r.from !== undefined) { out.from = r.from; }
            if (mine[s.id] !== undefined) { out.here = mine[s.id]; }
            if (s.files) { out.files = s.files; }
            if (s.when) { out.when = s.when; }
            if (s.removeWhen !== undefined) { out.removeWhen = s.removeWhen; }
            if (s.holds) { out.holds = s.holds; }
            return out;
        });
        return { level: level, sections: sections, own: sections.some(function (s) { return s.here !== undefined; }) };
    }

    /** Whether a condition of `s` (a choice's, or `''` for remove_when) holds for the view's prompt kind: true, false, or 'error'. */
    /** @param {AspectViewSection} s @param {string} choice @returns {boolean | 'error' | undefined} */
    function holdsFor(s, choice) {
        var h = s.holds && s.holds[choice];
        return h ? h[s.kind || 'chat'] : undefined;
    }

    /** @param {AspectViewSection} s @param {string} c */
    function choiceText(s, c) {
        return c + (s.when && s.when[c] !== undefined ? '?' : '');
    }

    /**
     * The effective selection in a line (`Answer: brief, long · Night: on?`, a
     * conditional choice with `?`); with `star`, an aspect this level chose
     * itself is starred.
     * @param {AspectView} v @param {{ star?: boolean }} [opts]
     */
    function summary(v, opts) {
        var star = !!(opts && opts.star);
        var parts = v.sections.filter(function (s) { return s.removed || (s.chosen || []).length; }).map(function (s) {
            return s.label + ': ' + (s.removed ? 'removed' : (s.chosen || []).map(function (c) { return choiceText(s, c); }).join(', ')) + (star && s.from === v.level ? '*' : '');
        });
        return parts.length ? parts.join(' · ') : 'nothing chosen';
    }

    /** @param {string | string[]} value */
    function valueLine(value) {
        var e = parseValue(value);
        if (!e) { return String(value); }
        if (e.kind === 'remove') { return 'Remove'; }
        return (e.kind === 'add' ? 'add ' : '') + e.choices.join(', ');
    }

    /** @param {string} level */
    function originWord(level) {
        var o = ORIGIN[/** @type {keyof typeof ORIGIN} */ (level)] || level;
        return o.indexOf('from ') === 0 ? o.slice(5) : o;
    }

    /**
     * The hover help: the title, the effective selection, what this level
     * chose itself, where each effective choice comes from, the file of each
     * (own text or a guideline file, gsel17), and the conditions with whether
     * they hold for the level's prompt kind (gsel20).
     * @param {AspectView} v @param {string} title
     */
    function hoverText(v, title) {
        var own = v.sections.filter(function (s) { return s.here !== undefined; })
            .map(function (s) { return s.label + ': ' + valueLine(/** @type {string | string[]} */ (s.here)); });
        var where = v.sections.filter(function (s) { return !s.removed && (s.chosen || []).length; })
            .map(function (s) {
                return s.label + ': ' + (s.chosen || []).map(function (c) {
                    var lv = (s.fromBy || {})[c];
                    return c + ' (' + (lv === v.level ? 'here' : originWord(lv || '')) + ')';
                }).join(', ');
            });
        var files = v.sections.filter(function (s) { return !s.removed && s.files; })
            .flatMap(function (s) {
                return (s.chosen || []).filter(function (c) { return s.files && s.files[c]; })
                    .map(function (c) { return s.label + ': ' + /** @type {Record<string, string>} */ (s.files)[c]; });
            });
        var conditions = v.sections.flatMap(function (s) {
            var out = (s.chosen || []).filter(function (c) { return s.when && s.when[c] !== undefined; }).map(function (c) {
                return s.label + ': ' + c + ' — when ' + /** @type {Record<string, string>} */ (s.when)[c] + ' (' + holdsWord(holdsFor(s, c), s.kind) + ')';
            });
            if (s.removeWhen !== undefined) { out.push(s.label + ': removed when ' + s.removeWhen + ' (' + holdsWord(holdsFor(s, ''), s.kind) + ')'); }
            return out;
        });
        return title + ': ' + summary(v)
            + (own.length ? '\nChosen here: ' + own.join(' · ') : '')
            + (where.length ? '\nWhere from: ' + where.join(' · ') : '')
            + (files.length ? '\nFrom: ' + files.join(' · ') : '')
            + (conditions.length ? '\nConditions: ' + conditions.join(' · ') : '');
    }

    /** @param {boolean | 'error' | undefined} h @param {string | undefined} kind */
    function holdsWord(h, kind) {
        var k = kind === 'todo' ? 'a todo prompt' : kind === 'queue' ? 'a queue prompt' : 'a chat prompt';
        return h === true ? 'holds now for ' + k : h === false ? 'does not hold now for ' + k : h === 'error' ? 'cannot be evaluated: not sent' : 'decided at send';
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
        return s.removed ? 'removed' : ((s.chosen || []).length ? (s.chosen || []).map(function (c) { return choiceText(s, c); }).join(', ') : 'none');
    }

    /** @param {AspectViewSection} s @param {string} level */
    function originHtml(s, level) {
        if (s.from === level) { return '<span class="tom-aspect-origin here">\u2713 here</span>'; }
        if (!s.from) { return '<span class="tom-aspect-origin">nothing chosen</span>'; }
        return '<span class="tom-aspect-origin">' + esc(ORIGIN[/** @type {keyof typeof ORIGIN} */ (s.from)] || s.from) + '</span>';
    }

    /** This level's own entry of `s`, read; undefined for Don't add. @param {AspectViewSection} s */
    function hereEntry(s) {
        return s.here === undefined ? undefined : parseValue(s.here);
    }

    /**
     * The Don't add and Remove rows of an aspect's submenu (radio-like).
     * @param {AspectViewSection} s @param {string} value @param {string} text
     */
    function optionHtml(s, value, text) {
        var here = value === '' ? s.here === undefined : s.here === value;
        var effective = value === REMOVE && s.removed;
        return '<div class="tom-aspect-option' + (here ? ' mine' : '') + (effective ? ' effective' : '') + '" role="menuitemradio"'
            + ' aria-checked="' + (here ? 'true' : 'false') + '" tabindex="-1"'
            + ' data-section="' + esc(s.id) + '" data-value="' + esc(value) + '">'
            + '<span class="tom-aspect-mark">' + (here ? '●' : '') + '</span>'
            + '<span class="tom-aspect-option-text">' + esc(text) + '</span>'
            + (effective && !here ? '<span class="tom-aspect-origin">✓</span>' : '')
            + '</div>';
    }

    /**
     * A choice's row: a checkbox for this level's entry (gsel20), the effective
     * mark, the file and the condition in its hover help.
     * @param {AspectViewSection} s @param {string} choice
     */
    function choiceHtml(s, choice) {
        var e = hereEntry(s);
        var checked = !!e && e.kind !== 'remove' && e.choices.indexOf(choice) >= 0;
        var effective = !s.removed && (s.chosen || []).indexOf(choice) >= 0;
        var when = s.when && s.when[choice];
        var tip = [s.files && s.files[choice] ? s.files[choice] : '', when !== undefined ? 'when ' + when + ' (' + holdsWord(holdsFor(s, choice), s.kind) + ')' : ''].filter(Boolean).join('\n');
        return '<div class="tom-aspect-option tom-aspect-choice' + (checked ? ' mine' : '') + (effective ? ' effective' : '') + '" role="menuitemcheckbox"'
            + ' aria-checked="' + (checked ? 'true' : 'false') + '" tabindex="-1"'
            + ' data-section="' + esc(s.id) + '" data-choice="' + esc(choice) + '"'
            + (tip ? ' title="' + esc(tip) + '"' : '') + '>'
            + '<span class="tom-aspect-mark codicon ' + (checked ? 'codicon-pass-filled' : 'codicon-circle-large-outline') + '"></span>'
            + '<span class="tom-aspect-option-text">' + esc(choice) + (when !== undefined ? ' <span class="tom-aspect-cond" title="' + esc('when ' + when) + '">?</span>' : '') + '</span>'
            + (effective && !checked ? '<span class="tom-aspect-origin">✓</span>' : '')
            + '</div>';
    }

    /**
     * The replace / add switch of the level shown (gsel20): whether this level's
     * choices of the aspect replace those of the levels below or are added to them.
     * @param {AspectViewSection} s @param {string} mode
     */
    function modeHtml(s, mode) {
        var b = function (/** @type {string} */ m, /** @type {string} */ text, /** @type {string} */ tip) {
            return '<span class="tom-aspect-mode' + (m === mode ? ' active' : '') + '" role="menuitemradio" aria-checked="' + (m === mode ? 'true' : 'false') + '" tabindex="-1"'
                + ' data-section="' + esc(s.id) + '" data-mode="' + m + '" title="' + esc(tip) + '">' + text + '</span>';
        };
        return '<div class="tom-aspect-modes">'
            + b('replace', 'Replace', 'This level\'s choices replace those of the levels below')
            + b('add', 'Add', 'This level\'s choices are added to those of the levels below')
            + '</div>';
    }

    /** The submenu of an aspect: the switch, Don't add, the choices, Remove. @param {AspectViewSection} s @param {string} mode */
    function submenuHtml(s, mode) {
        return modeHtml(s, mode)
            + optionHtml(s, '', 'Don\'t add')
            + s.options.map(function (o) { return choiceHtml(s, o); }).join('')
            + optionHtml(s, REMOVE, 'Remove');
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
     * @param {{ title: string, note?: string, onChoose: (section: string, value: string | string[]) => void, onEditSections?: () => void }} opts
     * @returns {HTMLElement}
     */
    function open(anchor, v, opts) {
        close();
        /** The replace / add switch per aspect while the popup is open. @type {Record<string, string>} */
        var modes = {};
        /** @param {AspectViewSection} s */
        function modeOf(s) {
            var e = hereEntry(s);
            return modes[s.id] || (e && e.kind === 'add' ? 'add' : 'replace');
        }
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
                + submenuHtml(s, modeOf(s))
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
        // Don't add, Remove, a choice's checkbox, the replace / add switch (gsel20).
        popup.addEventListener('click', function (ev) {
            var t = /** @type {HTMLElement | null} */ (ev.target);
            var el = t && t.closest ? /** @type {HTMLElement | null} */ (t.closest('.tom-aspect-option, .tom-aspect-mode')) : null;
            if (!el) { return; }
            ev.stopPropagation();
            var section = el.getAttribute('data-section') || '';
            var s = v.sections.find(function (x) { return x.id === section; });
            if (!s) { return; }
            if (el.classList.contains('tom-aspect-mode')) {
                var mode = el.getAttribute('data-mode') || 'replace';
                modes[section] = mode;
                var cur = hereEntry(s);
                if (cur && cur.kind !== 'remove' && cur.choices.length && cur.kind !== mode) { choose(s, formatValue({ kind: mode, choices: cur.choices })); }
                redraw(s);
                return;
            }
            var choice = el.getAttribute('data-choice');
            if (choice === null) {
                close();
                opts.onChoose(section, el.getAttribute('data-value') || '');
                return;
            }
            var e = hereEntry(s);
            var list = e && e.kind !== 'remove' ? e.choices.slice() : [];
            var at = list.indexOf(choice);
            if (at >= 0) { list.splice(at, 1); } else { list.push(choice); }
            // In the aspect's choice order.
            list = s.options.filter(function (o) { return list.indexOf(o) >= 0; });
            choose(s, list.length ? formatValue({ kind: modeOf(s), choices: list }) : '');
            redraw(s);
        });
        /** The value of this level written, the popup kept open with it. @param {AspectViewSection} s @param {string | string[]} value */
        function choose(s, value) {
            if (value === '') { delete s.here; } else { s.here = value; }
            opts.onChoose(s.id, value);
        }
        /** @param {AspectViewSection} s */
        function redraw(s) {
            var row = popup.querySelector('.tom-aspect-section[data-section="' + (window.CSS && CSS.escape ? CSS.escape(s.id) : s.id) + '"] .tom-aspect-options');
            if (row) { row.innerHTML = submenuHtml(s, modeOf(s)); }
        }
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
        parseValue: parseValue,
        formatValue: formatValue,
        view: view,
        summary: summary,
        hoverText: hoverText,
        buttonHtml: buttonHtml,
        indicatorHtml: indicatorHtml,
        open: open,
        close: close,
    };
})();
