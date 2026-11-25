// @ts-nocheck
/* Chat panel (@CHAT, tomAi.chatPanel) webview client. Externalized verbatim
 * from chatPanel-handler._getScript() — Phase A.3 of the webview restructuring.
 * First-paint data arrives via window.__INIT__; live updates via postMessage.
 *
 * @ts-nocheck: this is a verbatim extraction of legacy webview JS that predates
 * the strict tsconfig.media checkJs gate (loose getElementById(...).value access
 * throughout). It is migrated as-is to preserve behaviour; bringing it up to
 * strict type-safety is deferred to the Phase B cleanup. Newly-authored webview
 * modules must keep // @ts-check and pass `npm run typecheck:media`. */

(function () {
    var __init = window.__INIT__ || {};
    // Inject codicons stylesheet (its URI is resolved by the extension host).
    if (__init.codiconsUri) {
        var __link = document.createElement('link');
        __link.rel = 'stylesheet';
        __link.href = String(__init.codiconsUri);
        document.head.appendChild(__link);
    }
    // Populate the hidden placeholder-help source div (read on demand).
    if (typeof __init.placeholderHelp === 'string') {
        var __src = document.getElementById('placeholder-help-source');
        if (__src) { __src.innerHTML = __init.placeholderHelp; }
    }
})();

var vscode = acquireVsCodeApi();
// Publish the host bridge so shared webview components (media/shared/*.js,
// e.g. completion.js) reuse it — acquireVsCodeApi() may be called only once.
window.__tomVscodeApi = vscode;
var sectionsConfig = [
    { id: 'anthropic', icon: '<span class="codicon codicon-sparkle"></span>', title: 'Anthropic/LLM' },
    { id: 'logs', icon: '<span class="codicon codicon-output"></span>', title: 'Logs' }
];
// The Logs section: one Anthropic session's files (media/questLogs/main.js, loaded after this script).
// The host hands over its HTML and the viewer's config; these globals are what that script reads.
var questLogsInit = (window.__INIT__ && window.__INIT__.questLogs) || {};
var qlogViewers = (questLogsInit.config && questLogsInit.config.viewers) || [];
var state = { expanded: ['anthropic'], pinned: [] };
var profiles = { anthropic: [] };
var anthropicConfigurations = [];
var anthropicProfileEntries = [];
var anthropicUserMessageTemplates = [];
var anthropicModels = [];
var anthropicApiKeyOk = false;
var claudeCliOk = null;      // null = probing, true/false = resolved (spec §18.6)
var claudeCliVisible = false; // true when any config uses transport: 'agentSdk'
var anthropicSending = false;
var anthropicSessionTurns = 0;
var anthropicLastToolCalls = 0;
// The active quest's saved prompts ({id, label}: the file name), as the host lists them.
var reusablePromptFiles = [];
var pendingReusableCopySection = '';
var reusablePromptState = {};
var slotEnabledSections = ['anthropic'];
var sectionSlotState = {};
var delegatedUiHandlersAttached = false;

function ensureSlotState(sectionId) {
    if (!sectionSlotState[sectionId]) {
        sectionSlotState[sectionId] = { activeSlot: 1, slots: {} };
    }
    if (!sectionSlotState[sectionId].slots) {
        sectionSlotState[sectionId].slots = {};
    }
    return sectionSlotState[sectionId];
}

function getSlotText(sectionId, slot) {
    var sectionState = ensureSlotState(sectionId);
    return sectionState.slots[String(slot)] || '';
}

function setSlotText(sectionId, slot, text) {
    var sectionState = ensureSlotState(sectionId);
    sectionState.slots[String(slot)] = text || '';
}

/* Per prompt slot: does its text stay after a send or a queue add (Keep), or is
 * it cleared? A slot without an entry keeps it. Persisted with the drafts
 * (slotKeep), so it survives a window reload. */
function getSlotKeep(sectionId, slot) {
    var sectionState = ensureSlotState(sectionId);
    if (!sectionState.keep) { sectionState.keep = {}; }
    return sectionState.keep[String(slot)] !== false;
}

function setSlotKeep(sectionId, slot, keep) {
    var sectionState = ensureSlotState(sectionId);
    if (!sectionState.keep) { sectionState.keep = {}; }
    sectionState.keep[String(slot)] = !!keep;
}

/* The Keep checkbox shows the active slot's flag. */
function updateSlotKeepUI(sectionId) {
    var cb = document.getElementById(sectionId + '-keep-slot');
    if (cb) { cb.checked = getSlotKeep(sectionId, ensureSlotState(sectionId).activeSlot); }
}

/* After a send or a queue add from `slot`: clear that slot's text unless it keeps it. */
function clearSlotUnlessKept(sectionId, slot) {
    if (getSlotKeep(sectionId, slot)) { return; }
    setSlotText(sectionId, slot, '');
    if (ensureSlotState(sectionId).activeSlot === slot) {
        var ta = document.getElementById(sectionId + '-text');
        if (ta) { ta.value = ''; }
    }
    saveDrafts();
}

function getPanelSlotButtonsHtml(sectionId) {
    if (slotEnabledSections.indexOf(sectionId) < 0) {
        return '';
    }
    var sectionState = ensureSlotState(sectionId);
    var buttons = '';
    for (var i = 1; i <= 9; i++) {
        var activeClass = sectionState.activeSlot === i ? ' active' : '';
        buttons += '<button class="slot-btn' + activeClass + '" data-action="switchSlot" data-id="' + sectionId + '" data-slot="' + i + '" title="Prompt Slot ' + i + '">' + i + '</button>';
    }
    return '<span class="slot-buttons">' + buttons + '</span>';
}

function getReusablePromptControlsHtml(sectionId) {
    // Each select is shown as a field (its label above, its value a link): linkChatSelects.
    return '' +
    '<select id="' + sectionId + '-reusable-file" class="reusable-prompt-file" title="Reusable prompt file"><option value="">(File)</option></select>' +
    '<button class="icon-btn" data-action="previewReusablePrompt" data-id="' + sectionId + '" title="Preview in overlay"><span class="codicon codicon-open-preview"></span></button>' +
        '<button class="icon-btn" data-action="openReusablePromptExternal" data-id="' + sectionId + '" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>' +
        '<button class="icon-btn" data-action="sendReusablePrompt" data-id="' + sectionId + '" title="Send reusable prompt to this section"><span class="codicon codicon-send"></span></button>' +
        '<button class="icon-btn" data-action="copyReusablePrompt" data-id="' + sectionId + '" title="Copy reusable prompt into this tab"><span class="codicon codicon-copy"></span></button>' +
        '<button class="icon-btn" data-action="openReusablePrompt" data-id="' + sectionId + '" title="Open reusable prompt file in editor"><span class="codicon codicon-edit"></span></button>' +
        '<button class="icon-btn" data-action="saveReusablePrompt" data-id="' + sectionId + '" title="Save current tab as reusable prompt"><span class="codicon codicon-save"></span></button>';
}

function switchPanelSlot(sectionId, slot) {
    var sectionState = ensureSlotState(sectionId);
    var textarea = document.getElementById(sectionId + '-text');
    if (textarea) {
        setSlotText(sectionId, sectionState.activeSlot, textarea.value || '');
    }
    sectionState.activeSlot = slot;
    if (textarea) {
        textarea.value = getSlotText(sectionId, slot);
    }
    updateSlotButtonsUI(sectionId);
    updateSlotKeepUI(sectionId);
    saveDrafts();
}

function updateSlotButtonsUI(sectionId) {
    var sectionState = ensureSlotState(sectionId);
    document.querySelectorAll('.slot-btn[data-id="' + sectionId + '"]').forEach(function(btn) {
        var slotNo = parseInt(btn.dataset.slot || '0', 10);
        btn.classList.toggle('active', slotNo === sectionState.activeSlot);
    });
}

function getPlaceholderPopupHtml() {
    var source = document.getElementById('placeholder-help-source');
    var html = source ? source.innerHTML : '<p>Placeholder help not available.</p>';
    return '<button class="close-popup" onclick="closePlaceholderPopup()">\u2715 Close</button>' + html;
}

function showPlaceholderPopup() {
    var popup = document.getElementById('placeholderPopup');
    var overlay = document.getElementById('placeholderOverlay');
    if (popup && overlay) {
        popup.innerHTML = getPlaceholderPopupHtml();
        popup.style.display = 'block';
        overlay.style.display = 'block';
    }
}

function closePlaceholderPopup() {
    var popup = document.getElementById('placeholderPopup');
    var overlay = document.getElementById('placeholderOverlay');
    if (popup) {popup.style.display = 'none';}
    if (overlay) {overlay.style.display = 'none';}
}

var PLACEHOLDER_TOOLTIP = 'Click for placeholder help';

/*
 * Icon toggle buttons (Keep, Fresh, Wrap, the queue mode): a button with
 * aria-pressed, reached by Tab and switched by Enter / Space like any button.
 * initToggleButtons gives each a `checked` property and fires `change` on a
 * click, so they are read and set as the checkboxes they replace were.
 */
function toggleButtonHtml(id, icon, label, title, pressed) {
    return '<button type="button" class="icon-btn toggle-btn' + (pressed ? ' pressed' : '') + '" id="' + id + '" aria-pressed="' + (pressed ? 'true' : 'false') + '"'
        + ' aria-label="' + label + '" title="' + title + '"><span class="codicon ' + icon + '"></span></button>';
}

/*
 * The queue mode of a subpanel: pressed (the default), Save to Queue adds the
 * prompt pending — the queue sends it when it gets there; not pressed, staged —
 * it waits until it is sent from the queue editor.
 */
var QUEUE_MODE_TITLES = {
    staged: 'Save to Queue adds the prompt staged: it waits in the queue until you send it. Click to add pending.',
    pending: 'Save to Queue adds the prompt pending: the queue sends it when it gets there. Click to add staged.',
};
function queueModeToggleHtml(sectionId) {
    return toggleButtonHtml(sectionId + '-queue-pending', 'codicon-play', 'Queue pending', QUEUE_MODE_TITLES.pending, true);
}
function updateQueueModeLook(btn) {
    var pending = btn.getAttribute('aria-pressed') === 'true';
    btn.title = pending ? QUEUE_MODE_TITLES.pending : QUEUE_MODE_TITLES.staged;
    var icon = btn.querySelector('.codicon');
    if (icon) { icon.className = 'codicon ' + (pending ? 'codicon-play' : 'codicon-debug-pause'); }
}
/* The status Save to Queue adds a subpanel's prompt with. */
function queueInitialStatus(sectionId) {
    var btn = document.getElementById(sectionId + '-queue-pending');
    return btn && btn.checked ? 'pending' : 'staged';
}

function initToggleButtons() {
    var buttons = document.querySelectorAll('.toggle-btn');
    for (var i = 0; i < buttons.length; i++) {
        (function(btn) {
            if (btn._toggleReady) { return; }
            btn._toggleReady = true;
            var isQueueMode = /-queue-pending$/.test(btn.id);
            Object.defineProperty(btn, 'checked', {
                configurable: true,
                get: function() { return btn.getAttribute('aria-pressed') === 'true'; },
                set: function(v) {
                    btn.setAttribute('aria-pressed', v ? 'true' : 'false');
                    btn.classList.toggle('pressed', !!v);
                    if (isQueueMode) { updateQueueModeLook(btn); }
                },
            });
            btn.addEventListener('click', function(ev) {
                ev.preventDefault();
                ev.stopPropagation();
                btn.checked = !btn.checked;
                btn.dispatchEvent(new Event('change', { bubbles: true }));
            });
        })(buttons[i]);
    }
    // The queue mode: from the webview state, then saved there and with the drafts on every change.
    ['anthropic'].forEach(function(sectionId) {
        var btn = document.getElementById(sectionId + '-queue-pending');
        if (!btn) { return; }
        btn.checked = !(state.queuePending && state.queuePending[sectionId] === false);
        btn.addEventListener('change', function() {
            state.queuePending = state.queuePending || {};
            state.queuePending[sectionId] = btn.checked;
            saveState();
            saveDrafts();
        });
    });
}

function loadState() {
    try {
        var s = vscode.getState();
        if (s && s.expanded && Array.isArray(s.expanded)) {state.expanded = s.expanded;}
        if (s && s.pinned && Array.isArray(s.pinned)) {state.pinned = s.pinned;}
        if (s && s.queuePending && typeof s.queuePending === 'object') {state.queuePending = s.queuePending;}
    } catch(e) {}
}

// The webview state is shared with the Logs viewer (its `qlog_*` keys): merge, never replace.
function saveState() {
    var all = vscode.getState() || {};
    all.expanded = state.expanded;
    all.pinned = state.pinned;
    all.queuePending = state.queuePending || {};
    vscode.setState(all);
}

function isExpanded(id) { return state.expanded && state.expanded.includes(id); }
function isPinned(id) { return state.pinned && state.pinned.includes(id); }

function toggleSection(id) {
    if (isExpanded(id)) {
        state.expanded = state.expanded.filter(function(s) { return s !== id; });
    } else {
        state.expanded.push(id);
        sectionsConfig.forEach(function(sec) {
            if (sec.id !== id && !isPinned(sec.id)) {
                state.expanded = state.expanded.filter(function(s) { return s !== sec.id; });
            }
        });
    }
    if (state.expanded.length === 0) {state.expanded = [id];}
    saveState();
    render();
}

function togglePin(id, e) {
    e.stopPropagation();
    var idx = state.pinned.indexOf(id);
    if (idx >= 0) { state.pinned.splice(idx, 1); }
    else { state.pinned.push(id); if (!isExpanded(id)) {state.expanded.push(id);} }
    saveState();
    render();
}

function getPromptEditorComponent(options) {
    var selectorId = options.sectionId + '-' + options.selectorKind;
    var selectorClass = options.selectorClass ? ' class="' + options.selectorClass + '"' : '';
    var selectorTitle = options.selectorTitle ? ' title="' + options.selectorTitle + '"' : '';
    // No label when the options give none (the ANTHROPIC/LLM dropdowns, gsel6: the tooltip names it).
    var selectorHtml =
        (options.selectorLabel ? '<label>' + options.selectorLabel + ':</label>' : '') +
        '<select id="' + selectorId + '"' + selectorClass + selectorTitle + '>' +
        (options.selectorOptions || '<option value="">(None)</option>') +
        '</select>';

    return '<div class="toolbar' + (options.toolbarClass ? ' ' + options.toolbarClass : '') + '">' +
        (options.prefixButtons || '') +
        selectorHtml +
        (options.secondarySelectorHtml || '') +
        (options.manageButtons || '') +
        (options.actionButtons || '') +
        getReusablePromptControlsHtml(options.sectionId) +
        '<span class="toolbar-spacer"></span>' +
        getPanelSlotButtonsHtml(options.sectionId) +
        '<button class="icon-btn placeholder-help-btn" title="' + (options.helpTitle || '') + '"><span class="codicon codicon-question"></span></button>' +
        '</div>' +
        (options.afterToolbarHtml || '') +
        '<div id="' + options.infoId + '" class="profile-info" style="display:none;"></div>' +
        '<textarea id="' + options.sectionId + '-text" placeholder="' + options.placeholder + '" data-input="' + options.sectionId + '" data-completion="on"></textarea>' +
        (options.afterEditorHtml || '');
}

/*
 * The run pickers (vscimpb48): each subpanel's select lists the quest's runs
 * (`default` first, the PROCESS view's marked) and shows the run it is on;
 * a change asks the host to switch it. A run deleted elsewhere comes back as
 * `default` from the host.
 */
var chatRunsState = { options: [{ run: 'default', label: 'default' }], selected: {}, windowRun: 'default' };
function applyChatRuns(msg) {
    chatRunsState = {
        options: Array.isArray(msg.options) && msg.options.length ? msg.options : [{ run: 'default', label: 'default' }],
        selected: msg.selected || {},
        windowRun: msg.windowRun || 'default',
        runDefaults: msg.runDefaults || {},
    };
    renderChatRunSelects();
    updateRunDefaultOptions();
}

/*
 * "Run default" in the profile and template selects: the value RUN_DEFAULT_CHOICE
 * sets nothing of the panel's own — Send looks the panel's run's default up when
 * it sends, and a queued item takes its run's default when it is sent. The label
 * names what it stands for now (chatRuns' runDefaults, per subpanel).
 */
var RUN_DEFAULT_CHOICE = '__run_default__';
function runDefaultOptionText(section, field) {
    var d = (chatRunsState.runDefaults || {})[section] || {};
    var v = d[field] || '';
    if (field === 'profile' && v) {
        var entry = (anthropicProfileEntries || []).find(function(e) { return e && e.id === v; });
        if (entry && entry.name) { v = entry.name; }
    }
    return 'Run default (' + (v || (field === 'template' ? 'no template' : 'none')) + ')';
}
function runDefaultOptionHtml(section, field) {
    return '<option value="' + RUN_DEFAULT_CHOICE + '" title="The ' + field + ' of the panel\'s run, looked up when it is sent">' + escapeAttr(runDefaultOptionText(section, field)) + '</option>';
}
/** The value a select had or was restored to before its options came (drafts may arrive first). */
function wantedSelectValue(sel) {
    return sel.value || sel.getAttribute('data-want') || '';
}
/** Keep the "Run default" labels current (the run or its defaults changed). */
function updateRunDefaultOptions() {
    [['anthropic-profile', 'anthropic', 'profile'], ['anthropic-userMessage', 'anthropic', 'template']].forEach(function(t) {
        var sel = document.getElementById(t[0]);
        var opt = sel ? sel.querySelector('option[value="' + RUN_DEFAULT_CHOICE + '"]') : null;
        if (opt) { opt.textContent = runDefaultOptionText(t[1], t[2]); }
    });
}
/** The Run links: the run's name (marked when it is not the PROCESS view's run), its full label in the tooltip. */
function renderChatRunSelects() {
    ['anthropic'].forEach(function(section) {
        var link = document.getElementById(section + '-run');
        if (!link) { return; }
        var current = chatRunsState.selected[section] || 'default';
        link.textContent = current;
        link.classList.toggle('run-other', current !== chatRunsState.windowRun);
        var shown = chatRunsState.options.find(function(o) { return o.run === current; });
        link.title = 'Run: ' + (shown ? shown.label : current) + ' — the process run this subpanel works on: its session, chat variables and process position, the run of what it queues with the panel\'s target. Click to pick another; switching selects the run\'s default session.';
    });
}

/*
 * The role dropdown and the guideline buttons (gsel6; design
 * role_and_guideline_selector.vscode_extension.md R-3, L-7, P-5, AS-3).
 *
 * - The role dropdown (ANTHROPIC/LLM): the role of the panel's sends, their
 *   item role. *Run default* leaves the role to the step, the run's default
 *   and the chat variable. A change goes to the host at once (setChatRole).
 * - The guideline buttons (both subpanels): the item level of the panel's
 *   sends, kept by the host per quest until changed (aspectChoose, level
 *   `chat`). A dot when the panel chose something, the effective selection
 *   in the hover help, no list beside it. The levels shown: the quest
 *   default, the window, the panel's run, the panel role's type and role.
 * - The host posts `chatAspects` on load, after every change, and when a
 *   level changes elsewhere (handlers/aspectViewsRefresh.ts).
 */
var chatAspectsState = { roles: [], role: '', aspects: null, panels: {} };
function chatAspectPicker() { return window.TomAspectPicker || null; }
function applyChatAspects(msg) {
    chatAspectsState = {
        roles: Array.isArray(msg.roles) ? msg.roles : [],
        role: typeof msg.role === 'string' ? msg.role : '',
        aspects: msg.aspects && Array.isArray(msg.aspects.sections) ? msg.aspects : null,
        panels: msg.panels || {},
    };
    renderChatRoleSelect();
    renderChatAspectButtons();
}
/** The levels of a subpanel's send: quest default, window, its run, its role's type and role, its own (the item). */
function chatAspectLevels(section) {
    var a = chatAspectsState.aspects || {};
    var p = chatAspectsState.panels[section] || {};
    var levels = { workspace: a.workspace, questDefault: a.questDefault, window: a.window, run: p.run, item: p.item };
    var role = section === 'anthropic' ? chatAspectsState.role : '';
    var r = (role && a.roles && a.roles[role]) || {};
    levels.roleType = r.roleType;
    levels.role = r.role;
    return levels;
}
function chatAspectView(section) {
    var p = chatAspectPicker();
    return p && chatAspectsState.aspects ? p.view(chatAspectsState.aspects, chatAspectLevels(section), 'item') : null;
}
function renderChatRoleSelect() {
    var sel = document.getElementById('anthropic-role');
    if (!sel) { return; }
    var current = chatAspectsState.role;
    var roles = chatAspectsState.roles.slice();
    if (current && roles.indexOf(current) < 0) { roles.push(current); }
    sel.innerHTML = '<option value="">Run default</option>' + roles.map(function(r) {
        return '<option value="' + escapeAttr(r) + '"' + (r === current ? ' selected' : '') + '>' + escapeAttr(r) + '</option>';
    }).join('');
    sel.value = current;
    sel.title = 'Role of this panel\'s sends: ' + (current || 'Run default (the step\'s, the run\'s default or the chat variable)') + '. The run\'s chat variable role is not changed.';
    sel.onchange = function() {
        chatAspectsState.role = sel.value;
        vscode.postMessage({ type: 'setChatRole', role: sel.value });
    };
}
function renderChatAspectButtons() {
    var p = chatAspectPicker();
    ['anthropic'].forEach(function(section) {
        var slot = document.getElementById(section + '-aspects-slot');
        if (!slot) { return; }
        var v = chatAspectView(section);
        if (!p || !v) { slot.innerHTML = ''; return; }
        // A dot and the hover help only: no list beside it.
        slot.innerHTML = p.buttonHtml(v, {
            title: 'Guidelines of this panel\'s sends',
            id: section + '-aspects-btn',
            attrs: { 'data-action': 'openChatAspects', 'data-id': section },
        });
    });
}
function openChatAspectPicker(section) {
    var p = chatAspectPicker();
    var v = chatAspectView(section);
    var anchor = document.getElementById(section + '-aspects-btn');
    if (!p || !v || !anchor) { return; }
    var note = section === 'anthropic' && !chatAspectsState.role
        ? 'Run default role: the role levels of the role the send runs as apply when it is sent.'
        : '';
    p.open(anchor, v, {
        title: 'Guidelines \u2014 this panel\'s sends',
        note: note,
        onChoose: function(sec, value) { vscode.postMessage({ type: 'aspectChoose', level: 'chat', panel: section, section: sec, value: value }); },
        onEditSections: function() { vscode.postMessage({ type: 'aspectEditSections' }); },
    });
}

function getSectionContent(id) {
    var contents = {
        anthropic: getPromptEditorComponent({
            sectionId: 'anthropic',
            selectorKind: 'profile',
            // Unlabelled and at 60% of its width (gsel6); the tooltip names it.
            selectorLabel: '',
            selectorClass: 'chat-compact-select',
            selectorTitle: 'Anthropic profile',
            selectorOptions: '<option value="">(None)</option>',
            prefixButtons:
                '<button class="icon-btn" data-action="openExtensionTools" data-id="anthropic" title="Extension Tools"><span class="codicon codicon-tools"></span></button>',
            secondarySelectorHtml:
                // Edit-profile icon sits immediately after the Profile
                // dropdown — opens the Global Template Editor on the
                // 'anthropicProfiles' category for the selected profile.
                '<button class="icon-btn" data-action="editAnthropicProfile" data-id="anthropic" title="Edit Anthropic profile (system prompt)"><span class="codicon codicon-edit"></span></button>' +
                // Config dropdown intentionally removed — the profile
                // owns configurationId and the handler resolves via
                // profile.configurationId → isDefault → first. Pick a
                // different configuration by switching profile.
                '<span id="anthropic-apikey-dot" class="api-status-dot" title="API key status" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:6px;"></span>' +
                '<span id="anthropic-claude-dot" class="api-status-dot" title="Agent SDK transport: the Anthropic provider&#39;s Agent SDK and Claude CLI installed (Provider SDKs page)" style="display:none;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:4px;"></span>' +
                // User-message template dropdown + inline edit icon (§7.3)
                '<select id="anthropic-userMessage" class="chat-compact-select chat-compact-template" title="User prompt template (the Anthropic user-message template)"><option value="">No template</option></select>' +
                '<button class="icon-btn" data-action="editAnthropicUserMessage" data-id="anthropic" title="Edit Anthropic user-message template"><span class="codicon codicon-edit"></span></button>',
            // Intentionally empty: add/delete for profiles and user-message
            // templates is done inside the Global Template Editor, not here.
            manageButtons: '',
            // The action row (vscimpb151): the buttons that queue in the default run (default@default, the queue's
            // settings) come before the session and run; the buttons that use them come after.
            actionButtons:
                '<button class="icon-btn" data-action="preview" data-id="anthropic" title="Preview expanded prompt"><span class="codicon codicon-eye"></span></button>' +
                // Queue-only repeat count — applied when staging via "Save to Queue";
                // ignored by the inline send button.
                '<label class="checkbox-label compact-keep" title="Queue repeats (used when adding to queue)"><span style="opacity:0.8;">R</span><input type="text" id="anthropic-repeat-count" value="1" style="width:24px"></label>' +
                // Per prompt slot: keep the text after Send / a queue add, or clear it (kept over a reload).
                toggleButtonHtml('anthropic-keep-slot', 'codicon-pin', 'Keep', 'Keep this prompt slot&#39;s text after Send or adding to the queue (not pressed: the slot is cleared). Set per slot 1–9.', true) +
                // Fresh: Send runs the prompt in a new one-prompt session based on the panel's session,
                // discarded when the answer is in — no follow-up reaches it (kept over a reload).
                toggleButtonHtml('anthropic-fresh-session', 'codicon-sparkle', 'Fresh', 'Send in a fresh session: a new one-prompt session based on this panel&#39;s session (it starts from that conversation and changes nothing in it), deleted when the answer is in. No follow-up prompt reaches it: the next Send starts another fresh one.', false) +
                // Staged / pending: how both Save to Queue buttons add the prompt.
                queueModeToggleHtml('anthropic') +
                // Default run, default session: the queue's profile, session (default@default) and default template.
                '<button class="icon-btn" data-action="addToQueue" data-id="anthropic" title="Save to Queue — in the default run (default@default), with the prompt queue&#39;s profile, session and default template"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
                // Queue next: pending at the front of the default run's queue, sent next — between two iterations when
                // the item sending is a loop.
                '<button class="icon-btn" data-action="addToQueueNext" data-id="anthropic" title="Queue next — in the default run (default@default), sent next, with the prompt queue&#39;s profile, session and default template; when a repeating item is sending, between its iterations"><span class="codicon codicon-add"></span><span class="codicon codicon-arrow-circle-up"></span></button>' +
                // Agent SDK session: the button names the session the panel sends in; a click opens VS Code's picker
                // (pick / new / based on). A run switch selects the run's default session (vscimpb151).
                // Session and run in one field: the session the panel sends in, `<session>@<run>`, its label above, the
                // link below; a click goes through the run, then the session in that run (or a new one): pickChatRunSession.
                // The run this subpanel is on (vscimpb48): its session in that run, its chat variables, its queued items.
                '<span class="chat-field"><span class="chat-field-label">Session</span>' +
                    '<a href="#" id="anthropic-session-link" class="chat-link session-link" data-action="pickChatRunSession" data-id="anthropic" title="Agent SDK session and its run — click to pick the run, then the session in it (or a new one)"><span id="anthropic-session-name" class="session-name">chat</span></a></span>' +
                // The role of this subpanel's sends (gsel6): their item role; the run's chat variable is untouched.
                '<select id="anthropic-role" class="chat-compact-select chat-role-select" title="Role of this panel&#39;s sends"><option value="">Run default</option></select>' +
                // The guideline button (gsel6): the item level of this subpanel's sends, sticky until changed.
                '<span id="anthropic-aspects-slot" class="chat-aspects-slot"></span>' +
                // What uses the panel's session and run: Send, Stop, and the two queue buttons with the panel's target.
                '<button class="icon-btn primary" id="anthropic-send-btn" data-action="send" data-id="anthropic" title="Send to Anthropic"><span class="codicon codicon-send"></span></button>' +
                '<button class="icon-btn" data-action="cancel" data-id="anthropic" title="Stop current Anthropic turn"><span class="codicon codicon-debug-stop"></span></button>' +
                '<button class="icon-btn" data-action="addToQueuePanelTarget" data-id="anthropic" title="Save to Queue with this panel&#39;s session, run, profile and template"><span class="codicon codicon-account"></span><span class="codicon codicon-list-ordered"></span></button>' +
                '<button class="icon-btn" data-action="addToQueueNextPanelTarget" data-id="anthropic" title="Queue next with this panel&#39;s session and run — sent next in the panel&#39;s run, with its profile and template; when a repeating item of that run is sending, between its iterations"><span class="codicon codicon-account"></span><span class="codicon codicon-arrow-circle-up"></span></button>' +
                // The trail, history and memory buttons are in the @CHAT Logs panel, behind its session switch;
                // the Prompt Queue button is in the status bar below the input.
                '',

            afterToolbarHtml:
                // Plan mode (CC-3, CC-27): the badge while it is on, with the
                // button that leaves it; a plan proposed with tomAi_exitPlanMode
                // shown for the user to accept or keep planning.
                '<div id="anthropic-plan-badge" class="plan-mode-badge" style="display:none;" title="Write tools are refused until you leave plan mode">' +
                '<span class="codicon codicon-checklist"></span><span class="plan-mode-label">Plan mode: read and plan only</span>' +
                '<button data-action="leavePlanMode" title="Leave plan mode: write tools run again">Leave plan mode</button>' +
                '</div>' +
                '<div id="anthropic-plan-overlay" class="modal-overlay" style="display:none;">' +
                '<div class="modal-popup plan-popup">' +
                '<div class="modal-popup-header"><span>The agent proposes a plan</span></div>' +
                '<div class="modal-popup-body">' +
                '<div id="anthropic-plan-body" class="plan-body markdown-body"></div>' +
                '<textarea id="anthropic-plan-feedback" class="plan-feedback" rows="2" placeholder="Optional: what to change (sent with Keep planning)"></textarea>' +
                '</div>' +
                '<div class="modal-popup-footer">' +
                '<button class="primary" data-action="planAccept">Accept and leave plan mode</button>' +
                '<button data-action="planKeep">Keep planning</button>' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div id="anthropic-approval-overlay" class="modal-overlay" style="display:none;">' +
                '<div id="anthropic-approval-popup" class="modal-popup">' +
                '<div class="modal-popup-header"><span>Tool Approval Required</span></div>' +
                '<div class="modal-popup-body">' +
                '<div id="anthropic-approval-body" style="padding:8px;font-family:var(--vscode-editor-font-family);white-space:pre-wrap;max-height:40vh;overflow:auto;"></div>' +
                '</div>' +
                '<div class="modal-popup-footer">' +
                '<button class="primary" data-action="anthropicApprovalApprove">Approve</button>' +
                '<button data-action="anthropicApprovalApproveAll">Allow All (session)</button>' +
                '<button data-action="anthropicApprovalDeny">Deny</button>' +
                '<button data-action="anthropicApprovalDenyAll">Deny All (session)</button>' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div id="anthropic-models-overlay" class="modal-overlay" style="display:none;">' +
                '<div class="modal-popup models-popup">' +
                '<div class="modal-popup-header"><span>Available models</span></div>' +
                '<div class="modal-popup-body" id="anthropic-models-body"></div>' +
                '<div class="modal-popup-footer">' +
                '<button data-action="refreshAnthropicModels" data-id="anthropic" title="Ask the Anthropic API again">Refresh API models</button>' +
                '<button class="primary" data-action="closeAvailableModels" data-id="anthropic">Close</button>' +
                '</div>' +
                '</div>' +
                '</div>',
            infoId: 'anthropic-profileInfo',
            placeholder: 'Enter your prompt for Anthropic...',
            helpTitle: '',
            afterEditorHtml:
                // The Available models button here is informational only — configurations
                // are the source of truth. It lets the user eyeball which models
                // the API currently returns so they can add configurations when
                // new models ship.
                '<div class="status-bar"><span id="anthropic-status" class="context-summary"></span>' +
                '<span class="status-bar-actions">' +
                // The quest folder first, then the Prompt Queue and the Status Page; the others as before.
                '<button class="icon-btn" data-action="revealQuestFolder" data-id="anthropic" title="Show the quest folder (_ai/quests/&lt;quest&gt;) in the Explorer side bar"><span class="codicon codicon-folder-opened"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="anthropic" title="Open Prompt Queue"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openStatusPage" data-id="anthropic" title="Open Extension Status Page"><span class="codicon codicon-dashboard"></span></button>' +
                '<button class="icon-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span></button>' +
                '<button class="icon-btn" data-action="openProcessEditor" title="Process Editor — the processes a quest can follow (_ai/processes)"><span class="codicon codicon-type-hierarchy"></span></button>' +
                // The role editor (gsel6), the panel's role selected.
                '<button class="icon-btn" data-action="openRoleEditor" id="anthropic-role-editor-btn" title="Role Editor — the roles a prompt can run as (_ai/roles)"><span class="codicon codicon-person"></span></button>' +
                '<button class="icon-btn" data-action="openQueueTemplatesEditor" data-id="anthropic" title="Open Queue Templates"><span class="codicon codicon-files"></span></button>' +
                '<button class="icon-btn" data-action="rebuildHistoryAndMemory" data-id="anthropic" title="Rebuild history and memory: fold what the quest history does not cover yet — the new turns of every host\'s trail and the newly archived todos — into the quest\'s compacted history (_ai/quests/QUEST/history/), and extract memory candidates from the new turns into this host\'s candidates file of the quest memory folder. One run, in chunks of &quot;Run every N rounds&quot;."><span class="codicon codicon-history"></span></button>' +
                // Promote memory: shown only with the setting tomAi.memory.promoteMemoryButton (see applyPromoteMemoryButton).
                '<button class="icon-btn" data-action="promoteMemory" data-id="anthropic" id="anthropic-promote-memory-btn" style="display:none" title="Promote memory: queue a prompt (in this panel\'s run and session, staged or pending as the queue mode says) that presents the memory candidates of every host and promotes the ones you choose into the curated memory files"><span class="codicon codicon-arrow-up"></span></button>' +
                '<button class="icon-btn" data-action="runQuestRefresh" data-id="anthropic" title="Run Quest Refresh now — dispatch the configured refresh prompt for this quest, then trim the live-trail back to base and reset the prompt counter."><span class="codicon codicon-sync"></span></button>' +
                '<button class="icon-btn" data-action="openQuestHistoryInMdBrowser" data-id="anthropic" title="Open quest history (history.md) in the MD Browser"><span class="codicon codicon-book"></span></button>' +
                '<button class="icon-btn" data-action="openQuestMemoryInMdBrowser" data-id="anthropic" title="Open the quest memory in the MD Browser: facts.md of _ai/quests/QUEST/memory/, or the candidates file of this host while there is no facts.md"><span class="codicon codicon-notebook"></span></button>' +
                // The models the Anthropic API offers (informational: the profile's configuration drives sends),
                // in an overlay behind one button, with the reason when the list is unavailable (a missing key).
                '<button class="icon-btn" data-action="showAvailableModels" data-id="anthropic" id="anthropic-models-btn" title="Available models: what the Anthropic API offers (informational — the profile\'s configuration decides the model)"><span class="codicon codicon-hubot"></span></button>' +
                '</span></div>',
        })
    };
    if (id === 'logs') { return questLogsInit.html || '<div class="qlog-empty">No logs viewer.</div>'; }
    return contents[id] || '<div>Unknown section</div>';
}

var _rendered = false;

/*
 * The action bar's choices as fields (the Prompt Queue editor's style): each select stays the
 * value holder its code fills and listens to, hidden; a field shows its label above and the
 * selected option as a link below. A click asks the host for VS Code's picker over the
 * select's options (pickFromSelect); the answer sets the select and fires its change event.
 */
var LINKED_SELECT_LABELS = {
    'anthropic-profile': 'Model',
    'anthropic-userMessage': 'Template',
    'anthropic-role': 'Role',
};
var pendingSelectPicks = {};
var selectPickSeq = 0;
function linkChatSelects() {
    Object.keys(LINKED_SELECT_LABELS).forEach(function(id) { linkSelect(document.getElementById(id), LINKED_SELECT_LABELS[id]); });
    ['anthropic'].forEach(function(section) {
        linkSelect(document.getElementById(section + '-reusable-file'), 'Prompt file');
    });
}
function linkSelect(sel, labelFor, labelSource) {
    if (!sel || sel.getAttribute('data-linked')) { return; }
    sel.setAttribute('data-linked', '1');
    var field = document.createElement('span');
    field.className = 'chat-field';
    field.id = sel.id + '-field';
    var label = document.createElement('span');
    label.className = 'chat-field-label';
    var link = document.createElement('a');
    link.href = '#';
    link.className = 'chat-link chat-field-value';
    field.appendChild(label);
    field.appendChild(link);
    sel.parentNode.insertBefore(field, sel);
    sel.classList.add('linked-select');
    var baseTitle = sel.title || '';
    function sync() {
        label.textContent = typeof labelFor === 'function' ? labelFor() : labelFor;
        var opt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
        link.textContent = opt ? opt.textContent : '(none)';
        link.title = (baseTitle ? baseTitle + ': ' : '') + link.textContent + (sel.disabled ? '' : ' — click to choose');
        link.classList.toggle('disabled', !!sel.disabled);
        field.style.display = sel.style.display === 'none' ? 'none' : '';
    }
    // A value set in code fires no event: the select's own value and selectedIndex keep the field in step.
    ['value', 'selectedIndex'].forEach(function(prop) {
        var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
        if (!d || !d.set) { return; }
        Object.defineProperty(sel, prop, { configurable: true, get: function() { return d.get.call(this); }, set: function(v) { d.set.call(this, v); sync(); } });
    });
    var observer = new MutationObserver(sync);
    observer.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'disabled', 'selected', 'title'] });
    if (labelSource) { observer.observe(labelSource, { childList: true, characterData: true, subtree: true }); }
    sel.addEventListener('change', sync);
    link.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (sel.disabled) { return; }
        var requestId = ++selectPickSeq;
        pendingSelectPicks[requestId] = sel;
        // A list may have changed since the panel was filled (a template or a prompt file added):
        // the host sends the lists again first, then the picker opens over the fresh options.
        if (FRESH_CHOICE_SELECTS[sel.id]) {
            vscode.postMessage({ type: 'refreshChoices', requestId: requestId });
            return;
        }
        postSelectPick(requestId);
    });
    sync();
}
/** The selects whose options are asked for again before their picker opens: the templates and the quest's prompt files. */
var FRESH_CHOICE_SELECTS = { 'anthropic-userMessage': true, 'anthropic-reusable-file': true };
/** VS Code's picker over the select of request `requestId`, its options as they are now. */
function postSelectPick(requestId) {
    var sel = pendingSelectPicks[requestId];
    if (!sel) { return; }
    var field = document.getElementById(sel.id + '-field');
    var labelEl = field ? field.querySelector('.chat-field-label') : null;
    vscode.postMessage({
        type: 'pickFromSelect', requestId: requestId, title: labelEl ? labelEl.textContent : '', current: sel.value,
        items: Array.prototype.filter.call(sel.options, function(o) { return !o.disabled; }).map(function(o) {
            return { label: o.textContent, value: o.value, description: o.title || '' };
        }),
    });
}
/** The host's answer to pickFromSelect: the picked value set on its select, as a change. */
function applySelectPick(msg) {
    var sel = pendingSelectPicks[msg.requestId];
    delete pendingSelectPicks[msg.requestId];
    if (!sel || typeof msg.value !== 'string' || sel.value === msg.value) { return; }
    sel.value = msg.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function render() {
    var container = document.getElementById('container');
    if (!_rendered) {
        // --- Initial render: build full DOM ---
        var html = '';
        sectionsConfig.forEach(function(sec, idx) {
            var exp = isExpanded(sec.id);
            var pin = isPinned(sec.id);
            html += '<div class="accordion-section ' + (exp ? 'expanded' : 'collapsed') + '" data-section="' + sec.id + '">';
            html += '<div class="header-expanded" data-toggle="' + sec.id + '"><span class="arrow"><span class="codicon codicon-chevron-right"></span></span><span class="icon">' + sec.icon + '</span><span class="title">' + sec.title + '</span><button class="pin-btn ' + (pin ? 'pinned' : '') + '" data-pin="' + sec.id + '" title="' + (pin ? 'Unpin' : 'Pin') + '"><span class="codicon ' + (pin ? 'codicon-pinned' : 'codicon-pin') + '"></span></button></div>';
            html += '<div class="header-collapsed" data-toggle="' + sec.id + '"><span class="arrow"><span class="codicon codicon-chevron-down"></span></span><span class="icon">' + sec.icon + '</span><span class="title">' + sec.title + '</span></div>';
            html += '<div class="section-content">' + getSectionContent(sec.id) + '</div></div>';
        });
        // The Extension Tools overlay, shared by both subpanels' tools button:
        // rendered at container level so collapsing a section never hides it.
        html += extensionToolsOverlayHtml();
        container.innerHTML = html;
        _rendered = true;
        applyPromoteMemoryButton(!!(window.__INIT__ && window.__INIT__.promoteMemoryButton));
        attachEventListeners();
        linkChatSelects();
        updateResizeHandles();
        populateDropdowns();
    } else {
        // --- Subsequent renders: preserve DOM, toggle classes only ---
        sectionsConfig.forEach(function(sec) {
            var el = container.querySelector('[data-section="' + sec.id + '"]');
            if (!el) {return;}
            var exp = isExpanded(sec.id);
            var pin = isPinned(sec.id);
            if (exp) { el.classList.remove('collapsed'); el.classList.add('expanded'); el.style.flex = ''; }
            else { el.classList.remove('expanded'); el.classList.add('collapsed'); el.style.flex = ''; }
            var pinBtn = el.querySelector('[data-pin="' + sec.id + '"]');
            if (pinBtn) {
                if (pin) { pinBtn.classList.add('pinned'); pinBtn.title = 'Unpin'; }
                else { pinBtn.classList.remove('pinned'); pinBtn.title = 'Pin'; }
                var pinIcon = pinBtn.querySelector('.codicon');
                if (pinIcon) {
                    pinIcon.classList.remove('codicon-pin', 'codicon-pinned');
                    pinIcon.classList.add(pin ? 'codicon-pinned' : 'codicon-pin');
                }
            }
        });
        updateResizeHandles();
    }
}

function updateResizeHandles() {
    var container = document.getElementById('container');
    container.querySelectorAll('.resize-handle').forEach(function(h) { h.remove(); });
    var expandedIds = [];
    sectionsConfig.forEach(function(sec) { if (isExpanded(sec.id)) {expandedIds.push(sec.id);} });
    for (var i = 1; i < expandedIds.length; i++) {
        var rightEl = container.querySelector('[data-section="' + expandedIds[i] + '"]');
        if (rightEl) {
            var handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.dataset.resizeLeft = expandedIds[i - 1];
            handle.dataset.resizeRight = expandedIds[i];
            container.insertBefore(handle, rightEl);
            handle.addEventListener('mousedown', function(e) { startResize(e, this); });
        }
    }
}

// /skill + @file completion is provided by the shared component
// media/shared/completion.js (opt-in via data-completion="on" on each
// textarea). It posts requestCompletion / applies insertCompletion itself and
// fires an `input` event after insertion, so the per-section input listener
// below persists the slot draft. Nothing panel-specific is needed here.

/**
 * The double-click guard: the Send and queue buttons are paused (disabled) for
 * SUBMIT_PAUSE_MS after a click; the host also ignores an identical queue add
 * or send within 3 s (src/utils/duplicateSubmitGuard.ts).
 */
var SUBMIT_ACTIONS = ['send', 'addToQueue', 'addToQueuePanelTarget', 'addToQueueNext', 'addToQueueNextPanelTarget'];
var SUBMIT_PAUSE_MS = 2000;

function isSubmitButtonPaused(btn) {
    return !!btn && Number(btn.getAttribute('data-paused-until') || 0) > Date.now();
}

function pauseSubmitButton(btn) {
    btn.setAttribute('data-paused-until', String(Date.now() + SUBMIT_PAUSE_MS));
    btn.disabled = true;
    setTimeout(function() {
        btn.removeAttribute('data-paused-until');
        btn.disabled = false;
        if (btn.id === 'anthropic-send-btn') { updateAnthropicSendButton(); }
    }, SUBMIT_PAUSE_MS);
}

function attachEventListeners() {
    if (!delegatedUiHandlersAttached) {
        document.addEventListener('click', function(event) {
            var target = event.target;
            if (!target || !target.closest) {return;}

            var actionEl = target.closest('[data-action]');
            if (actionEl) {
                event.preventDefault();
                if (actionEl.disabled) {return;}
                if (SUBMIT_ACTIONS.indexOf(actionEl.dataset.action) >= 0) { pauseSubmitButton(actionEl); }
                handleAction(actionEl.dataset.action, actionEl.dataset.id, actionEl.dataset.slot);
                return;
            }

            var pinEl = target.closest('[data-pin]');
            if (pinEl) {
                togglePin(pinEl.dataset.pin, event);
                return;
            }

            var toggleEl = target.closest('[data-toggle]');
            if (toggleEl) {
                toggleSection(toggleEl.dataset.toggle);
            }
        });
        delegatedUiHandlersAttached = true;
    }

    slotEnabledSections.forEach(function(sectionId) {
        var ta = document.getElementById(sectionId + '-text');
        if (!ta) {return;}
        ta.addEventListener('input', function() {
            var sectionState = ensureSlotState(sectionId);
            setSlotText(sectionId, sectionState.activeSlot, ta.value || '');
        });
        // Ctrl+Shift+Space completion (/skill, @file) is handled by the shared
        // media/shared/completion.js component via the data-completion="on"
        // attribute; it fires `input` after insertion so the listener above
        // persists the slot draft.
    });
    // Set placeholder help buttons to open popup on click
    document.querySelectorAll('.placeholder-help-btn').forEach(function(el) { el.addEventListener('click', function() { showPlaceholderPopup(); }); });
}

var resizing = null;
var DRAG_THRESHOLD = 5;
function startResize(e, handle) {
    e.preventDefault();
    var leftId = handle.dataset.resizeLeft;
    var rightId = handle.dataset.resizeRight;
    var leftEl = document.querySelector('[data-section="' + leftId + '"]');
    var rightEl = document.querySelector('[data-section="' + rightId + '"]');
    if (!leftEl || !rightEl) {return;}
    var startX = e.clientX;
    var leftWidth = leftEl.offsetWidth;
    var rightWidth = rightEl.offsetWidth;
    var dragStarted = false;
    function onMove(ev) {
        var dx = ev.clientX - startX;
        if (!dragStarted) { if (Math.abs(dx) < DRAG_THRESHOLD) {return;} dragStarted = true; handle.classList.add('dragging'); }
        leftEl.style.flex = '0 0 ' + Math.max(120, leftWidth + dx) + 'px';
        rightEl.style.flex = '0 0 ' + Math.max(120, rightWidth - dx) + 'px';
    }
    function onUp() { if (dragStarted) {handle.classList.remove('dragging');} document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}
function doResize() { /* legacy */ }
function stopResize() { /* legacy */ }

function handleAction(action, id, slot) {
    switch(action) {
        case 'send': { var text = document.getElementById(id + '-text'); text = text ? text.value : ''; if (!text.trim()) {return;} var profile = document.getElementById(id + '-profile'); profile = profile ? profile.value : ''; var template = document.getElementById(id + '-template'); template = template ? template.value : ''; var anthropicUserMessage = document.getElementById('anthropic-userMessage'); anthropicUserMessage = anthropicUserMessage ? anthropicUserMessage.value : ''; var slotNo = ensureSlotState(id).activeSlot; if (id === 'anthropic' && !anthropicSending) { anthropicSending = true; updateAnthropicSendButton(); setAnthropicStatus('Sending…'); } var freshCb = id === 'anthropic' ? document.getElementById('anthropic-fresh-session') : null; vscode.postMessage({ type: 'send' + id.charAt(0).toUpperCase() + id.slice(1), text: text, profile: profile, template: template, model: '', config: '', userMessageTemplate: anthropicUserMessage, slot: slotNo, fresh: !!(freshCb && freshCb.checked) }); break; }
        case 'preview': { var prvText = document.getElementById(id + '-text'); prvText = prvText ? prvText.value : ''; var prvTpl = document.getElementById(id + '-template'); prvTpl = prvTpl ? prvTpl.value : ''; vscode.postMessage({ type: 'preview', section: id, text: prvText, template: prvTpl }); break; }
        case 'clearText': {
            if (!id) {break;}
            var clearTextArea = document.getElementById(id + '-text');
            if (!clearTextArea) {break;}
            clearTextArea.value = '';
            if (slotEnabledSections.indexOf(id) >= 0) {
                setSlotText(id, ensureSlotState(id).activeSlot, '');
                updateSlotButtonsUI(id);
            }
            saveDrafts();
            break;
        }
        case 'switchSlot': { var slotNo = parseInt(slot || '1', 10); if (slotNo >= 1 && slotNo <= 9) {switchPanelSlot(id, slotNo);} break; }
        case 'reload': vscode.postMessage({ type: 'reload', section: id }); break;
        case 'open': vscode.postMessage({ type: 'openInEditor', section: id }); break;
        case 'addNote': vscode.postMessage({ type: 'addNote' }); break;
        case 'addProfile': vscode.postMessage({ type: 'addProfile', section: id }); break;
        case 'editProfile': { var epSel = document.getElementById(id + '-profile'); vscode.postMessage({ type: 'editProfile', section: id, name: epSel ? epSel.value : '' }); break; }
        case 'deleteProfile': confirmDelete('profile', id); break;
        case 'editAnthropicProfile': {
            var epaSel = document.getElementById('anthropic-profile');
            vscode.postMessage({ type: 'editAnthropicProfile', name: epaSel ? epaSel.value : '' });
            break;
        }
        case 'editAnthropicUserMessage': {
            var eumSel = document.getElementById('anthropic-userMessage');
            vscode.postMessage({ type: 'editAnthropicUserMessage', name: eumSel ? eumSel.value : '' });
            break;
        }
        case 'sendReusablePrompt': {
            var reusableToSend = getSelectedReusablePromptId(id);
            if (!reusableToSend) {return;}
            var rpMsg = { type: 'sendReusablePrompt', reusableId: reusableToSend, section: id };
            if (id === 'anthropic') {
                // Pass current panel state so the reusable prompt is
                // sent just like a manual "Send to Anthropic" — same
                // profile and user-message template. Configuration is
                // always resolved from the profile (no per-send config
                // override in the chat panel).
                var rpProfile = document.getElementById('anthropic-profile');
                var rpUserMsg = document.getElementById('anthropic-userMessage');
                rpMsg.profile = rpProfile ? rpProfile.value : '';
                rpMsg.model = '';
                rpMsg.config = '';
                rpMsg.userMessageTemplate = rpUserMsg ? rpUserMsg.value : '';
                anthropicSending = true;
                updateAnthropicSendButton();
                setAnthropicStatus('Sending reusable prompt…');
            }
            vscode.postMessage(rpMsg);
            break;
        }
        case 'copyReusablePrompt': {
            var reusableToCopy = getSelectedReusablePromptId(id);
            if (!reusableToCopy) {return;}
            pendingReusableCopySection = id || '';
            vscode.postMessage({ type: 'loadReusablePromptContent', reusableId: reusableToCopy });
            break;
        }
        case 'openReusablePrompt': {
            var reusableToOpen = getSelectedReusablePromptId(id);
            if (!reusableToOpen) {return;}
            vscode.postMessage({ type: 'openReusablePromptInEditor', section: id || '', reusableId: reusableToOpen });
            break;
        }
        case 'saveReusablePrompt': {
            var currentText = document.getElementById((id || '') + '-text');
            vscode.postMessage({ type: 'saveReusablePrompt', section: id || '', text: currentText ? currentText.value : '' });
            break;
        }
        case 'previewReusablePrompt': {
            var reusableToPreview = getSelectedReusablePromptId(id);
            if (!reusableToPreview) {return;}
            vscode.postMessage({ type: 'openReusablePromptInOverlay', reusableId: reusableToPreview });
            break;
        }
        case 'openReusablePromptExternal': {
            var reusableToExternal = getSelectedReusablePromptId(id);
            if (!reusableToExternal) {return;}
            vscode.postMessage({ type: 'openReusablePromptInExternalApp', reusableId: reusableToExternal });
            break;
        }
        case 'openExtensionTools': openExtensionTools(); break;
        case 'closeExtensionTools': closeExtensionTools(); break;
        case 'openExtensionTool':
            vscode.postMessage({ type: 'openExtensionTool', toolId: id || '' });
            closeExtensionTools();
            break;
        case 'cancel': vscode.postMessage({ type: 'cancel', section: id || '' }); break;
        case 'addToQueue': addAnthropicToQueue(false); break;
        case 'addToQueuePanelTarget': addAnthropicToQueue(true); break;
        case 'addToQueueNext': addAnthropicToQueue(false, true); break;
        case 'addToQueueNextPanelTarget': addAnthropicToQueue(true, true); break;
        case 'openQueueEditor': vscode.postMessage({ type: 'openQueueEditor' }); break;
        case 'pickAnthropicSession': vscode.postMessage({ type: 'pickAnthropicSession' }); break;
        case 'pickChatRunSession': vscode.postMessage({ type: 'pickChatRunSession' }); break;
        case 'pickChatRun': vscode.postMessage({ type: 'pickChatRun', section: id }); break;
        case 'openChatVariablesEditor': vscode.postMessage({ type: 'openChatVariablesEditor' }); break;
        case 'openProcessEditor': vscode.postMessage({ type: 'openProcessEditor' }); break;
        case 'openRoleEditor': vscode.postMessage({ type: 'openRoleEditor' }); break;
        case 'openChatAspects': openChatAspectPicker(id); break;
        case 'openStatusPage': vscode.postMessage({ type: 'openStatusPage' }); break;
        case 'rebuildHistoryAndMemory': historyRebuildRunning = true; vscode.postMessage({ type: 'rebuildHistoryAndMemory' }); break;
        case 'promoteMemory': {
            var pmProfile = document.getElementById('anthropic-profile');
            vscode.postMessage({ type: 'promoteMemory', anthropicProfileId: pmProfile ? pmProfile.value : '', initialStatus: queueInitialStatus('anthropic') });
            break;
        }
        case 'runQuestRefresh': { var qrProfile = document.getElementById(id + '-profile'); qrProfile = qrProfile ? qrProfile.value : ''; vscode.postMessage({ type: 'runQuestRefresh', section: id || '', profile: qrProfile }); break; }
        case 'openQuestHistoryInMdBrowser': vscode.postMessage({ type: 'openQuestHistoryInMdBrowser' }); break;
        case 'openQuestMemoryInMdBrowser': vscode.postMessage({ type: 'openQuestMemoryInMdBrowser' }); break;
        case 'refreshAnthropicModels': vscode.postMessage({ type: 'refreshAnthropicModels' }); break;
        case 'showAvailableModels': { renderAvailableModels(); var mo = document.getElementById('anthropic-models-overlay'); if (mo) { mo.style.display = 'flex'; } break; }
        case 'closeAvailableModels': { var mc = document.getElementById('anthropic-models-overlay'); if (mc) { mc.style.display = 'none'; } break; }
        case 'revealQuestFolder': vscode.postMessage({ type: 'revealQuestFolder' }); break;
        // The host asks which sessions to clear and answers with anthropicHistoryCleared.
        case 'leavePlanMode': vscode.postMessage({ type: 'leavePlanMode' }); break;
        case 'planAccept': decidePlan(true); break;
        case 'planKeep': decidePlan(false); break;
        case 'anthropicApprovalApprove': resolveAnthropicApproval(true, false); break;
        case 'anthropicApprovalApproveAll': resolveAnthropicApproval(true, true); break;
        case 'anthropicApprovalDeny': resolveAnthropicApproval(false, false); break;
        case 'anthropicApprovalDenyAll': resolveAnthropicApproval(false, true); break;
    }
}

var _currentAnthropicApprovalId = '';
var _currentAnthropicApprovalTool = '';
var _anthropicSessionDeny = {};
// Requests waiting for the dialog, oldest first: the Agent SDK can ask for
// several tools at once, and each must get its own answer.
var _anthropicApprovalQueue = [];

// The Anthropic subpanel holds the dialog: expand it (keeping pinned
// sections) so the request is seen whatever the panel showed before.
function revealAnthropicSection() {
    if (isExpanded('anthropic')) { return; }
    toggleSection('anthropic');
}

// ---- Plan mode (CC-3, CC-27) ----
// Proposed plans wait in order; the host renders each plan's markdown (safe HTML).
var _planProposals = [];
var _currentPlanId = '';

function setPlanModeBadge(active) {
    var badge = document.getElementById('anthropic-plan-badge');
    if (badge) { badge.style.display = active ? 'flex' : 'none'; }
}

function showPlanProposal(id, html) {
    if (id === _currentPlanId) { return; }
    for (var i = 0; i < _planProposals.length; i++) { if (_planProposals[i].id === id) { return; } }
    _planProposals.push({ id: id, html: html });
    if (!_currentPlanId) { showNextPlanProposal(); }
}

function showNextPlanProposal() {
    var overlay = document.getElementById('anthropic-plan-overlay');
    var next = _planProposals.shift();
    if (!next) {
        _currentPlanId = '';
        if (overlay) { overlay.style.display = 'none'; }
        return;
    }
    _currentPlanId = next.id;
    revealAnthropicSection();
    var body = document.getElementById('anthropic-plan-body');
    if (body) { body.innerHTML = next.html || '<p>(empty plan)</p>'; }
    var feedback = document.getElementById('anthropic-plan-feedback');
    if (feedback) { feedback.value = ''; }
    if (overlay) { overlay.style.display = 'block'; }
}

function decidePlan(accepted) {
    if (!_currentPlanId) { return; }
    var feedback = document.getElementById('anthropic-plan-feedback');
    vscode.postMessage({ type: 'planDecision', id: _currentPlanId, accepted: accepted, feedback: feedback ? feedback.value : '' });
    showNextPlanProposal();
}

function settlePlanProposal(id) {
    _planProposals = _planProposals.filter(function(p) { return p.id !== id; });
    if (id === _currentPlanId) { showNextPlanProposal(); }
}

function showAnthropicApprovalDialog(toolId, toolName, inputSummary) {
    // Session-level auto-deny — suppresses the dialog entirely.
    if (_anthropicSessionDeny[toolName]) {
        vscode.postMessage({
            type: 'anthropicToolApprovalResponse',
            toolId: toolId,
            approved: false,
            approveAll: false,
        });
        return;
    }
    // The host re-sends open requests when the webview (re)starts: once each.
    if (toolId === _currentAnthropicApprovalId) { return; }
    for (var i = 0; i < _anthropicApprovalQueue.length; i++) {
        if (_anthropicApprovalQueue[i].toolId === toolId) { return; }
    }
    _anthropicApprovalQueue.push({ toolId: toolId, toolName: toolName, inputSummary: inputSummary });
    if (!_currentAnthropicApprovalId) { showNextAnthropicApproval(); } else { renderAnthropicApprovalBody(); }
}

var _currentAnthropicApprovalInput = '';
function renderAnthropicApprovalBody() {
    var body = document.getElementById('anthropic-approval-body');
    if (!body) { return; }
    var waiting = _anthropicApprovalQueue.length > 0 ? '\n\n(' + _anthropicApprovalQueue.length + ' more waiting)' : '';
    body.textContent = 'Tool: ' + _currentAnthropicApprovalTool + '\n\nInput:\n' + (_currentAnthropicApprovalInput || '(no input)') + waiting;
}

function showNextAnthropicApproval() {
    var overlay = document.getElementById('anthropic-approval-overlay');
    var next = _anthropicApprovalQueue.shift();
    while (next && _anthropicSessionDeny[next.toolName]) {
        vscode.postMessage({ type: 'anthropicToolApprovalResponse', toolId: next.toolId, approved: false, approveAll: false });
        next = _anthropicApprovalQueue.shift();
    }
    if (!next) {
        _currentAnthropicApprovalId = '';
        _currentAnthropicApprovalTool = '';
        if (overlay) {overlay.style.display = 'none';}
        return;
    }
    _currentAnthropicApprovalId = next.toolId;
    _currentAnthropicApprovalTool = next.toolName;
    _currentAnthropicApprovalInput = next.inputSummary || '';
    revealAnthropicSection();
    renderAnthropicApprovalBody();
    overlay = document.getElementById('anthropic-approval-overlay');
    if (overlay) {overlay.style.display = 'block';}
}

// The request was answered or aborted elsewhere (Stop, a queue cancel).
function dropAnthropicApproval(toolId) {
    _anthropicApprovalQueue = _anthropicApprovalQueue.filter(function(r) { return r.toolId !== toolId; });
    if (toolId === _currentAnthropicApprovalId) {
        _currentAnthropicApprovalId = '';
        _currentAnthropicApprovalTool = '';
        showNextAnthropicApproval();
    }
}

function resolveAnthropicApproval(approved, approveAll) {
    if (!_currentAnthropicApprovalId) {
        var overlay = document.getElementById('anthropic-approval-overlay');
        if (overlay) {overlay.style.display = 'none';}
        return;
    }
    // Deny with approveAll (labelled "Deny All session") — remember locally
    // so the rest of the session short-circuits without round-tripping.
    if (!approved && approveAll && _currentAnthropicApprovalTool) {
        _anthropicSessionDeny[_currentAnthropicApprovalTool] = true;
    }
    vscode.postMessage({
        type: 'anthropicToolApprovalResponse',
        toolId: _currentAnthropicApprovalId,
        approved: approved,
        approveAll: !!approveAll,
    });
    _currentAnthropicApprovalId = '';
    _currentAnthropicApprovalTool = '';
    showNextAnthropicApproval();
}

function confirmDelete(itemType, sectionId) {
    var selectId = sectionId + '-' + itemType;
    var sel = document.getElementById(selectId);
    var selectedValue = sel ? sel.value : '';
    if (!selectedValue) { vscode.postMessage({ type: 'showMessage', message: 'Please select a ' + itemType + ' to delete.' }); return; }
    // Send directly to extension - VS Code will show its own confirmation dialog
    vscode.postMessage({ type: 'delete' + itemType.charAt(0).toUpperCase() + itemType.slice(1), section: sectionId, name: selectedValue });
}

function populateDropdowns() {
    // The run pickers are part of the sections: fill them again after a render.
    renderChatRunSelects();
    // So are the role dropdown and the guideline buttons (gsel6).
    renderChatRoleSelect();
    renderChatAspectButtons();
    // Use populateEntitySelect for anthropic profiles so the entry marked
    // isDefault is preselected; the label shown is the human-readable name.
    if (anthropicProfileEntries && anthropicProfileEntries.length > 0) {
        populateEntitySelect('anthropic-profile', anthropicProfileEntries, '(Select Profile)');
    } else {
        populateSelect('anthropic-profile', profiles.anthropic);
    }
    populateSelect('anthropic-userMessage', anthropicUserMessageTemplates);
    populateAnthropicModels();
    updateAnthropicApiKeyDot();
    // Profile dropdown: configuration is resolved from the profile on
    // every send, so the status line (model / history mode) must follow
    // the profile selection.
    var anthropicProfileSel = document.getElementById('anthropic-profile');
    if (anthropicProfileSel && !anthropicProfileSel._anthropicStatusBound) {
        anthropicProfileSel._anthropicStatusBound = true;
        anthropicProfileSel.addEventListener('change', function() {
            setAnthropicStatus(buildAnthropicStatusLine());
            // Mirror the active profile to the extension so the scripting-API
            // bridge (tools.getJsonVce) can resolve the same profile's tool set
            // without a webview round-trip.
            vscode.postMessage({ type: 'anthropicProfileSelected', profileId: this.value });
        });
    }
    // Mirror the initial selection too, so the bridge has a value before the
    // user ever touches the dropdown.
    if (anthropicProfileSel && anthropicProfileSel.value) {
        vscode.postMessage({ type: 'anthropicProfileSelected', profileId: anthropicProfileSel.value });
    }
    ['anthropic'].forEach(function(sectionId) {
        populateReusablePromptSelectors(sectionId);
    });
}

function populateAnthropicModels() {
    // Informational: list the models the API currently returns so the user
    // can add configurations when new models ship. The value is never read
    // when sending — configurations drive model selection.
    renderAvailableModels();
    updateAnthropicSendButton();
}

// The Available models overlay: the Anthropic API's list with its count, or why it is empty.
var anthropicModelsError = '';
function modelListHtml(title, models, empty) {
    var head = '<div class="models-head">' + escapeAttr(title) + (models && models.length ? ' <span class="models-count">(' + models.length + ')</span>' : '') + '</div>';
    if (!models || models.length === 0) { return head + '<div class="models-empty">' + escapeAttr(empty) + '</div>'; }
    return head + '<ul class="models-list">' + models.map(function(m) {
        return '<li><span class="models-name">' + escapeAttr(m.label) + '</span>' + (m.id && m.id !== m.label ? ' <code>' + escapeAttr(m.id) + '</code>' : '') + '</li>';
    }).join('') + '</ul>';
}
function renderAvailableModels() {
    var body = document.getElementById('anthropic-models-body');
    if (!body) { return; }
    var api = (anthropicModels || []).map(function(m) { return { id: m.id, label: m.display_name || m.id }; });
    var apiEmpty = anthropicModelsError ? 'Unavailable: ' + anthropicModelsError : (anthropicApiKeyOk ? 'No models returned.' : 'No models: the Anthropic API key is missing or invalid.');
    body.innerHTML = modelListHtml('Anthropic API', api, apiEmpty)
        + '<div class="models-note">Informational: the profile\'s configuration decides the model a send uses.</div>';
    var btn = document.getElementById('anthropic-models-btn');
    if (btn) { btn.classList.toggle('models-problem', api.length === 0); }
}

function updateAnthropicApiKeyDot() {
    var dot = document.getElementById('anthropic-apikey-dot');
    if (!dot) {return;}
    dot.style.background = anthropicApiKeyOk
        ? 'var(--vscode-testing-iconPassed, #3fb950)'
        : 'var(--vscode-errorForeground, #f85149)';
    dot.title = anthropicApiKeyOk ? 'Anthropic API key OK' : 'Anthropic API key missing or invalid';
}

function updateClaudeCliDot() {
    var dot = document.getElementById('anthropic-claude-dot');
    if (!dot) {return;}
    if (!claudeCliVisible) {
        dot.style.display = 'none';
        return;
    }
    dot.style.display = 'inline-block';
    if (claudeCliOk === null) {
        dot.style.background = 'var(--vscode-editorWarning-foreground, #cca700)';
        dot.title = 'Claude CLI: probing...';
    } else if (claudeCliOk) {
        dot.style.background = 'var(--vscode-testing-iconPassed, #3fb950)';
        dot.title = 'Claude CLI detected — Agent SDK transport available';
    } else {
        dot.style.background = 'var(--vscode-errorForeground, #f85149)';
        dot.title = "Claude CLI not found. Install Claude Code and run 'claude login' to use Agent SDK configurations.";
    }
}

function updateAnthropicSendButton() {
    var btn = document.getElementById('anthropic-send-btn');
    if (!btn) {return;}
    // Disable only while a request is in flight. The API-key dot still
    // shows env-var status, but we don't gate the button on it: the
    // ANTHROPIC_API_KEY env var is only relevant for transport='direct'.
    // Agent SDK / VS Code LM / Local LLM transports don't read it at
    // all, and the env var is often invisible to GUI-launched VS Code
    // on macOS even when the underlying SDK works fine. If a 'direct'
    // send actually needs the key and it's missing, getClient() throws
    // 'Anthropic client not available — set the configured API key env
    // var', which the catch in _handleSendAnthropic forwards as an
    // anthropicError message and the webview shows in the status line.
    // Not disabled while a send runs: a second Send asks whether to send it as
    // an update to the running prompt, or queue it (the host decides). Only the
    // double-click pause after a click (pauseSubmitButton) disables it.
    btn.disabled = isSubmitButtonPaused(btn);
    btn.title = anthropicSending
        ? 'A prompt is running: Send offers to send this as an update to it, or to queue it'
        : 'Send to Anthropic';
}

function setAnthropicStatus(text) {
    var el = document.getElementById('anthropic-status');
    if (el) {el.textContent = text || '';}
}

function buildAnthropicStatusLine(historyMode) {
    // Resolve the effective configuration the same way _handleSendAnthropic
    // does: profile.configurationId → isDefault → first. Configuration
    // is owned by the profile; there's no per-send override in the
    // chat panel anymore.
    var profileSel = document.getElementById('anthropic-profile');
    var profileId = profileSel ? profileSel.value : '';
    // "Run default": the profile of the panel's run.
    if (profileId === RUN_DEFAULT_CHOICE) { profileId = ((chatRunsState.runDefaults || {}).anthropic || {}).profile || ''; }
    var profile = (anthropicProfileEntries || []).find(function(p) { return p.id === profileId; });
    var configs = anthropicConfigurations || [];
    var cfg = (profile && profile.configurationId ? configs.find(function(c) { return c.id === profile.configurationId; }) : undefined)
        || configs.find(function(c) { return c.isDefault; })
        || configs[0];
    var modelName = cfg && cfg.model ? cfg.model : '';
    if (!historyMode) {
        historyMode = cfg && cfg.historyMode ? cfg.historyMode : '';
    }
    var parts = [];
    if (modelName) {parts.push(modelName);}
    if (historyMode) {parts.push(historyMode);}
    parts.push('last ' + anthropicLastToolCalls + ' tool calls');
    parts.push(anthropicSessionTurns + ' session turns');
    return parts.join(' · ');
}

function ensureReusablePromptState(sectionId) {
    if (!reusablePromptState[sectionId]) {
        reusablePromptState[sectionId] = { file: '' };
    }
    return reusablePromptState[sectionId];
}

/** The file dropdown of a section, filled from the host's list; the selection is kept while the file is there. */
function populateReusablePromptSelectors(sectionId) {
    var fileSel = document.getElementById(sectionId + '-reusable-file');
    if (!fileSel) {return;}

    var state = ensureReusablePromptState(sectionId);
    var files = reusablePromptFiles;
    var hasFile = files.some(function(f) { return (f.id || '') === state.file; });
    if (!hasFile) {
        state.file = files.length > 0 ? (files[0].id || '') : '';
    }

    fileSel.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '(File)';
    fileSel.appendChild(placeholder);
    files.forEach(function(file) {
        var option = document.createElement('option');
        option.value = file.id || '';
        option.textContent = file.label || option.value;
        option.selected = option.value === state.file;
        fileSel.appendChild(option);
    });
    fileSel.disabled = files.length === 0;
}

/** The selected prompt's id for the host: its file name. */
function getSelectedReusablePromptId(sectionId) {
    return ensureReusablePromptState(sectionId).file || '';
}

function populateSelect(id, options) {
    var sel = document.getElementById(id);
    if (!sel) {return;}
    var cur = wantedSelectValue(sel);
    // The user-prompt template dropdown: "Run default" and "No template" (gsel6).
    var baseOptions = runDefaultOptionHtml('anthropic', id === 'anthropic-profile' ? 'profile' : 'template') + '<option value="">No template</option>';
    sel.innerHTML = baseOptions + (options || []).map(function(o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
    sel.value = (cur === RUN_DEFAULT_CHOICE || (cur && options && options.includes(cur))) ? cur : '';
}

function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function populateEntitySelect(id, options, defaultLabel) {
    var sel = document.getElementById(id);
    if (!sel) {return;}
    var cur = wantedSelectValue(sel);
    sel.innerHTML = (id === 'anthropic-profile' ? runDefaultOptionHtml('anthropic', 'profile') : '') + (options || []).map(function(o) {
        var value = (o && typeof o.id === 'string') ? o.id : '';
        var label = (o && typeof o.name === 'string' && o.name) ? o.name : value;
        return '<option value="' + value + '">' + label + '</option>';
    }).join('');
    // Restore previous selection if still available
    if ((cur === RUN_DEFAULT_CHOICE && id === 'anthropic-profile') || (cur && (options || []).some(function(o) { return o && o.id === cur; }))) {
        sel.value = cur;
    } else {
        // Preselect the default entry, or fall back to the first entry
        var defaultOption = (options || []).find(function(o) { return o && o.isDefault; });
        sel.value = defaultOption ? defaultOption.id : ((options && options.length > 0) ? options[0].id : '');
    }
}

window.addEventListener('message', function(e) {
    var msg = e.data;
    // `insertCompletion` is handled by the shared media/shared/completion.js
    // component (its own message listener), not here.
    if (msg.type === 'profiles') {
        profiles = { anthropic: msg.anthropic || [] };
        anthropicConfigurations = msg.anthropicConfigurations || [];
        anthropicProfileEntries = msg.anthropicProfileEntries || [];
        anthropicUserMessageTemplates = msg.anthropicUserMessageTemplates || [];
        anthropicApiKeyOk = !!msg.anthropicApiKeyOk;
        claudeCliVisible = !!msg.claudeCliVisible;
        claudeCliOk = (msg.claudeCliOk === true || msg.claudeCliOk === false) ? msg.claudeCliOk : null;
        populateDropdowns();
        updateAnthropicApiKeyDot();
        updateClaudeCliDot();
    } else if (msg.type === 'pickFromSelectResult') {
        applySelectPick(msg);
    } else if (msg.type === 'choicesRefreshed') {
        // The lists came again (a `profiles` message just before this one): now the picker.
        postSelectPick(msg.requestId);
    } else if (msg.type === 'chatRuns') {
        applyChatRuns(msg);
    } else if (msg.type === 'chatAspects') {
        applyChatAspects(msg);
    } else if (msg.type === 'anthropicSession') {
        // The session as the queue's context bar shows it: name, base, lifetime, model.
        var sessionLabel = document.getElementById('anthropic-session-name');
        if (sessionLabel) { sessionLabel.textContent = msg.label || msg.name || 'chat'; }
        var sessionBtn = sessionLabel ? sessionLabel.closest('.session-link') : null;
        if (sessionBtn && msg.tooltip) { sessionBtn.title = msg.tooltip + ' — click to pick the run, then the session in it (or a new one)'; }
        // A session just picked that names a profile: preselect it (the panel's choice still wins).
        if (msg.profileId) {
            var sessionProfileSel = document.getElementById('anthropic-profile');
            if (sessionProfileSel && Array.prototype.some.call(sessionProfileSel.options, function(o) { return o.value === msg.profileId; })) {
                sessionProfileSel.value = msg.profileId;
                sessionProfileSel.dispatchEvent(new Event('change'));
            }
        }
    } else if (msg.type === 'anthropicClaudeCliStatus') {
        claudeCliOk = !!msg.ok;
        claudeCliVisible = msg.visible !== false;
        updateClaudeCliDot();
    } else if (msg.type === 'anthropicModels') {
        anthropicModels = msg.models || [];
        anthropicModelsError = msg.error ? String(msg.error) : '';
        if (msg.error) {
            setAnthropicStatus('Models unavailable: ' + msg.error);
        } else {
            setAnthropicStatus('');
        }
        populateAnthropicModels();
    } else if (msg.type === 'anthropicApiKeyStatus') {
        anthropicApiKeyOk = !!msg.ok;
        updateAnthropicApiKeyDot();
        updateAnthropicSendButton();
    } else if (msg.type === 'anthropicHistoryCleared') {
        // Sessions cleared after the session selection; the counters belong to the panel's session.
        if (msg.panelSession) { _anthropicSessionDeny = {}; anthropicSessionTurns = 0; anthropicLastToolCalls = 0; }
        setAnthropicStatus('History cleared: ' + (Array.isArray(msg.sessions) ? msg.sessions.join(', ') : ''));
    } else if (msg.type === 'anthropicStatus') {
        // Handler-driven status text (e.g. "waiting for history
        // compaction…", "Rebuild history: folding chunk 2/5…").
        // Only apply while we're actively sending or a Rebuild history and
        // memory runs — after a result we want the result's own status line
        // (tool-call summary / session turn count), not a stale "waiting…" entry.
        if ((anthropicSending || historyRebuildRunning) && typeof msg.text === 'string' && msg.text.length > 0) {
            setAnthropicStatus(msg.text);
        }
    } else if (msg.type === 'anthropicResult') {
        anthropicSending = false;
        updateAnthropicSendButton();
        anthropicSessionTurns += 1;
        anthropicLastToolCalls = msg.toolCallCount || 0;
        var anthropicStatus = buildAnthropicStatusLine(msg.historyMode || '');
        // The send's tokens, cache reads and writes included (usageSummaryLine on the host).
        if (msg.usageLine) {anthropicStatus += ' · ' + msg.usageLine;}
        // A Fresh send: answered in a one-prompt session, already discarded.
        if (msg.freshBase) {anthropicStatus = 'Fresh session (based on ' + msg.freshBase + ', discarded) · ' + anthropicStatus;}
        setAnthropicStatus(anthropicStatus);
    } else if (msg.type === 'anthropicSendStarted') {
        // The send started (its session was free, or a free one was chosen): the slot is cleared unless it keeps its text.
        var startedSlot = parseInt(String(msg.slot || ensureSlotState('anthropic').activeSlot), 10);
        if (startedSlot >= 1 && startedSlot <= 9) { clearSlotUnlessKept('anthropic', startedSlot); }
    } else if (msg.type === 'anthropicNotSent') {
        // Its session was busy: queued or sent as an update instead (the slot is cleared unless it
        // keeps its text), or not sent. With panelBusy a send of this panel still runs: it stays "sending".
        if (!msg.panelBusy) { anthropicSending = false; }
        updateAnthropicSendButton();
        setAnthropicStatus(msg.message || 'Not sent.');
        if (msg.queued) {
            var queuedFrom = parseInt(String(msg.slot || ensureSlotState('anthropic').activeSlot), 10);
            if (queuedFrom >= 1 && queuedFrom <= 9) { clearSlotUnlessKept('anthropic', queuedFrom); }
        }
    } else if (msg.type === 'anthropicError') {
        anthropicSending = false;
        updateAnthropicSendButton();
        setAnthropicStatus('Error: ' + (msg.message || 'unknown'));
    } else if (msg.type === 'planMode') {
        setPlanModeBadge(!!msg.active);
    } else if (msg.type === 'planProposal') {
        showPlanProposal(String(msg.id || ''), String(msg.html || ''));
    } else if (msg.type === 'planProposalSettled') {
        settlePlanProposal(String(msg.id || ''));
    } else if (msg.type === 'anthropicToolApproval') {
        showAnthropicApprovalDialog(msg.toolId || '', msg.toolName || '', msg.inputSummary || '');
    } else if (msg.type === 'anthropicToolApprovalSettled') {
        dropAnthropicApproval(msg.toolId || '');
    } else if (msg.type === 'reusablePrompts') {
        reusablePromptFiles = Array.isArray(msg.files) ? msg.files : [];
        ['anthropic'].forEach(function(sectionId) {
            populateReusablePromptSelectors(sectionId);
        });
    } else if (msg.type === 'reusablePromptContent') {
        var targetSection = pendingReusableCopySection;
        pendingReusableCopySection = '';
        if (targetSection && msg.content) {
            var targetTextArea = document.getElementById(targetSection + '-text');
            if (targetTextArea) {
                var existing = targetTextArea.value || '';
                targetTextArea.value = msg.content + (existing ? '\n\n' + existing : '');
                if (slotEnabledSections.indexOf(targetSection) >= 0) {
                    setSlotText(targetSection, ensureSlotState(targetSection).activeSlot, targetTextArea.value || '');
                }
                saveDrafts();
            }
        }
    } else if (msg.type === 'historyRebuildDone') {
        historyRebuildRunning = false;
    } else if (msg.type === 'promoteMemoryButton') {
        applyPromoteMemoryButton(msg.visible === true);
    } else if (msg.type === 'queueAdded' && msg.section === 'anthropic') {
        // The ANTHROPIC slot the prompt was queued from: cleared unless it keeps its text.
        var queuedSlot = parseInt(String(msg.slot || ensureSlotState('anthropic').activeSlot), 10);
        if (queuedSlot >= 1 && queuedSlot <= 9) { clearSlotUnlessKept('anthropic', queuedSlot); }
    } else if (msg.type === 'draftsLoaded') {
        var secs = msg.sections || {};
        // Restore Anthropic-specific state
        var da = secs['anthropic'];
        if (da) {
            var anthrSectionState = ensureSlotState('anthropic');
            if (da.slots && typeof da.slots === 'object') { anthrSectionState.slots = da.slots; }
            if (da.activeSlot && da.activeSlot >= 1 && da.activeSlot <= 9) { anthrSectionState.activeSlot = da.activeSlot; }
            if (da.slotKeep && typeof da.slotKeep === 'object') { anthrSectionState.keep = da.slotKeep; }
            var freshRestore = document.getElementById('anthropic-fresh-session');
            if (freshRestore) { freshRestore.checked = da.fresh === true; }
            restoreQueueMode('anthropic', da);
            var anthrTa = document.getElementById('anthropic-text');
            if (anthrTa) { anthrTa.value = getSlotText('anthropic', anthrSectionState.activeSlot) || da.text || ''; }
            var anthrProfile = document.getElementById('anthropic-profile');
            if (anthrProfile && da.profile) { anthrProfile.value = da.profile; anthrProfile.setAttribute('data-want', da.profile); }
            // (Model + Config dropdowns removed — nothing to restore.)
            var anthrUserMsg = document.getElementById('anthropic-userMessage');
            if (anthrUserMsg && da.userMessageTemplate) { anthrUserMsg.value = da.userMessageTemplate; anthrUserMsg.setAttribute('data-want', da.userMessageTemplate); }
            updateSlotButtonsUI('anthropic');
            updateSlotKeepUI('anthropic');
        }
        _draftsLoaded = true;
    }
});

/* The queue mode saved with the drafts (the panel's stored settings); the webview state follows. */
function restoreQueueMode(sectionId, draft) {
    if (!draft || typeof draft.queuePending !== 'boolean') { return; }
    var btn = document.getElementById(sectionId + '-queue-pending');
    if (!btn) { return; }
    btn.checked = draft.queuePending;
    state.queuePending = state.queuePending || {};
    state.queuePending[sectionId] = draft.queuePending;
    saveState();
}

// Normalize a repeat-count input value for the queue. Purely-numeric input
// becomes an integer (min 1); any other non-empty string (a chat-variable
// name, or a `prefix*` pattern like `tod*`) is preserved verbatim so it
// resolves at processing time in the queue. Empty input falls back to 1.
// Coercing with parseInt here previously turned `tod*` into 1 before it ever
// left the webview.
function normalizeRepeatField(raw) {
    var v = String(raw === null || raw === undefined ? '' : raw).trim();
    if (v === '') { return 1; }
    if (/^[0-9]+$/.test(v)) { return Math.max(1, parseInt(v, 10)); }
    return v;
}

/* Whether a Rebuild history and memory runs: its progress shows on the status line until the host says it is done. */
var historyRebuildRunning = false;

/* The Promote memory button shows only with the setting tomAi.memory.promoteMemoryButton
 * (__INIT__.promoteMemoryButton at first paint, `promoteMemoryButton` messages after). */
function applyPromoteMemoryButton(visible) {
    var btn = document.getElementById('anthropic-promote-memory-btn');
    if (btn) { btn.style.display = visible ? '' : 'none'; }
}

function addAnthropicToQueue(usePanelTarget, next) {
    // Add a queue item with transport='anthropic'. Without usePanelTarget: the default run, the prompt queue's
    // profile, session (default@default) and default template (vscimpb151). With it: this panel's session,
    // run, profile and user-message template. `next` queues it pending at the front of that run's queue
    // instead (sent next; between the iterations of a repeating item that is sending).
    var text = document.getElementById('anthropic-text');
    text = text ? text.value : '';
    if (!text.trim()) {return;}
    var profileEl = document.getElementById('anthropic-profile');
    var profileId = profileEl ? profileEl.value : '';
    var templateEl = document.getElementById('anthropic-userMessage');
    var templateName = templateEl ? templateEl.value : '';
    var repeatEl = document.getElementById('anthropic-repeat-count');
    var repeatCount = normalizeRepeatField(repeatEl ? repeatEl.value : '1');
    vscode.postMessage({
        type: 'addToQueue',
        text: text,
        template: templateName,
        repeatCount: repeatCount,
        transport: 'anthropic',
        section: 'anthropic',
        slot: ensureSlotState('anthropic').activeSlot,
        ...(usePanelTarget ? { anthropicProfileId: profileId, usePanelTarget: true } : {}),
        // Queue next is always pending; Save to Queue follows the subpanel's queue mode.
        ...(next ? { next: true } : { initialStatus: queueInitialStatus('anthropic') }),
    });
    // Reset the repeat count to 1 so the next simple prompt isn't accidentally
    // queued again with a leftover (high) repeat count.
    if (repeatEl) { repeatEl.value = '1'; }
}

/* The Extension Tools overlay: every editor and page of the extension, in the
 * catalogue's groups (src/utils/extensionToolsCatalog.ts, passed in
 * __INIT__.extensionTools without commands). A button posts
 * `openExtensionTool` with the entry's id; the host runs its command. */
function extensionToolsEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extensionToolsOverlayHtml() {
    var catalogue = (window.__INIT__ && window.__INIT__.extensionTools) || { groups: [], tools: [] };
    var groups = (catalogue.groups || []).map(function(g) {
        var buttons = (catalogue.tools || []).filter(function(t) { return t.group === g.id; }).map(function(t) {
            var title = t.purpose + (t.whenAvailable ? ' (' + t.whenAvailable + ')' : '') + (t.statusPageSection ? ' — opens the Status Page at this section' : '');
            return '<button class="extension-tool-btn" data-action="openExtensionTool" data-id="' + extensionToolsEsc(t.id) + '" title="' + extensionToolsEsc(title) + '">' +
                '<span class="codicon codicon-' + extensionToolsEsc(t.icon) + '"></span><span class="extension-tool-label">' + extensionToolsEsc(t.label) + '</span></button>';
        }).join('');
        return '<section class="extension-tools-group" data-group="' + extensionToolsEsc(g.id) + '">' +
            '<div class="extension-tools-group-title">' + extensionToolsEsc(g.icon) + ' ' + extensionToolsEsc(g.label) + '</div>' + buttons + '</section>';
    }).join('');
    return '<div id="extension-tools-overlay" class="modal-overlay extension-tools-overlay" style="display:none;">' +
        '<div id="extension-tools-popup" class="modal-popup extension-tools-popup" role="dialog" aria-label="Extension Tools">' +
        '<div class="modal-popup-header"><span>Extension Tools</span><button class="icon-btn" data-action="closeExtensionTools" title="Close"><span class="codicon codicon-close"></span></button></div>' +
        '<div class="modal-popup-body extension-tools-grid">' + groups + '</div>' +
        '</div></div>';
}

function openExtensionTools() {
    var overlay = document.getElementById('extension-tools-overlay');
    if (overlay) { overlay.style.display = 'flex'; }
}

function closeExtensionTools() {
    var overlay = document.getElementById('extension-tools-overlay');
    if (overlay) { overlay.style.display = 'none'; }
}

// A click beside the popup or Escape closes the overlay.
document.addEventListener('click', function(event) {
    if (event.target && event.target.id === 'extension-tools-overlay') { closeExtensionTools(); }
});
document.addEventListener('keydown', function(event) {
    var overlay = document.getElementById('extension-tools-overlay');
    if (event.key === 'Escape' && overlay && overlay.style.display !== 'none') { closeExtensionTools(); }
});

function initReusablePromptSelectors() {
    ['anthropic'].forEach(function(sectionId) {
        var fileSel = document.getElementById(sectionId + '-reusable-file');
        if (fileSel) {
            fileSel.addEventListener('change', function() {
                var state = ensureReusablePromptState(sectionId);
                state.file = fileSel.value || '';
            });
        }
    });
}

loadState();
render();
initToggleButtons();
initReusablePromptSelectors();
vscode.postMessage({ type: 'getProfiles' });
// The role dropdown and the guideline buttons (gsel6).
vscode.postMessage({ type: 'getChatAspects' });
vscode.postMessage({ type: 'getReusablePrompts' });
// Last: the host may now show tool-approval requests (it re-sends the open ones).
vscode.postMessage({ type: 'approvalUiReady' });
vscode.postMessage({ type: 'loadDrafts' });

// Guard: do not persist drafts until the initial load has completed.
var _draftsLoaded = false;

// Draft auto-save (debounced, every 1s of inactivity)
var _draftSaveTimer = null;
function saveDrafts() {
    if (!_draftsLoaded) {return;}
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(function() {
        var drafts = {};
        // Anthropic section — save Anthropic-specific dropdowns in addition to the standard fields
        var anthrTa = document.getElementById('anthropic-text');
        var anthrSectionState = ensureSlotState('anthropic');
        if (anthrTa) { setSlotText('anthropic', anthrSectionState.activeSlot, anthrTa.value || ''); }
        var anthrProfile = document.getElementById('anthropic-profile');
        var anthrUserMsg = document.getElementById('anthropic-userMessage');
        drafts['anthropic'] = {
            text: anthrTa ? anthrTa.value : '',
            profile: anthrProfile ? anthrProfile.value : '',
            userMessageTemplate: anthrUserMsg ? anthrUserMsg.value : '',
            activeSlot: anthrSectionState.activeSlot,
            slots: anthrSectionState.slots,
            slotKeep: anthrSectionState.keep || {},
            fresh: !!((document.getElementById('anthropic-fresh-session') || {}).checked),
            queuePending: queueInitialStatus('anthropic') === 'pending',
        };
        vscode.postMessage({ type: 'saveDrafts', drafts: drafts });
    }, 1000);
}
// Attach save to all textareas and dropdowns
['anthropic-text'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('input', saveDrafts);}
});
['anthropic-profile'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('change', saveDrafts);}
});
['anthropic-userMessage'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('change', saveDrafts);}
});
// A pick replaces the value restored from the drafts (wantedSelectValue).
['anthropic-profile', 'anthropic-userMessage'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener('change', function() { el.removeAttribute('data-want'); }); }
});
// The Fresh checkbox is one for the panel (not per slot), saved with the drafts.
(function() {
    var freshCb = document.getElementById('anthropic-fresh-session');
    if (freshCb) { freshCb.addEventListener('change', saveDrafts); }
})();
// The Keep checkbox sets the active slot's flag.
(function() {
    var keepCb = document.getElementById('anthropic-keep-slot');
    if (keepCb) {
        keepCb.addEventListener('change', function() {
            setSlotKeep('anthropic', ensureSlotState('anthropic').activeSlot, keepCb.checked);
            saveDrafts();
        });
    }
})();
