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
    { id: 'copilot', icon: '<span class="codicon codicon-copilot"></span>', title: 'Copilot' },
    { id: 'anthropic', icon: '<span class="codicon codicon-sparkle"></span>', title: 'Anthropic/LLM' },
    { id: 'logs', icon: '<span class="codicon codicon-output"></span>', title: 'Logs' }
];
// The Logs section: one Anthropic session's files (media/questLogs/main.js, loaded after this script).
// The host hands over its HTML and the viewer's config; these globals are what that script reads.
var questLogsInit = (window.__INIT__ && window.__INIT__.questLogs) || {};
var qlogViewers = (questLogsInit.config && questLogsInit.config.viewers) || [];
var qlogVariantTabs = (questLogsInit.config && questLogsInit.config.variantTabs) || [];
var qlogVariantIds = (questLogsInit.config && questLogsInit.config.variantIds) || [];
var qlogDefaultVariant = (questLogsInit.config && questLogsInit.config.defaultVariant) || '';
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
var copilotTemplateEntries = [];
var reusablePromptModel = { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
var pendingReusableCopySection = '';
var reusablePreferredQuestId = '';
var reusablePreferredProjectId = '';
var reusablePreferredScanId = '';
var reusablePromptState = {};
var copilotHasAnswer = false;
var copilotAnswerSlot = 0;
var slotEnabledSections = ['copilot', 'anthropic'];
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
    return '<label>Type:</label>' +
    '<select id="' + sectionId + '-reusable-type" class="reusable-prompt-type" title="Reusable prompt type"><option value="global">global</option><option value="project">project</option><option value="quest">quest</option><option value="scan">scan</option></select>' +
    '<label id="' + sectionId + '-reusable-scope-label" style="display:none;">Project:</label>' +
    '<select id="' + sectionId + '-reusable-scope" class="reusable-prompt-scope" title="Reusable prompt scope" style="display:none;"><option value="">(Select)</option></select>' +
    '<label>Files:</label>' +
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
    if (sectionId === 'copilot') {
        refreshCopilotAnswerToolbarVisibility();
    }
    saveDrafts();
}

function updateSlotButtonsUI(sectionId) {
    var sectionState = ensureSlotState(sectionId);
    document.querySelectorAll('.slot-btn[data-id="' + sectionId + '"]').forEach(function(btn) {
        var slotNo = parseInt(btn.dataset.slot || '0', 10);
        btn.classList.toggle('active', slotNo === sectionState.activeSlot);
        if (sectionId === 'copilot') {
            btn.classList.toggle('answer-ready', copilotHasAnswer && slotNo === copilotAnswerSlot);
        }
    });
}

function refreshCopilotAnswerToolbarVisibility() {
    var toolbar = document.getElementById('copilot-answers-toolbar');
    if (!toolbar) {return;}
    var activeSlot = ensureSlotState('copilot').activeSlot;
    toolbar.style.display = (copilotHasAnswer && activeSlot === copilotAnswerSlot) ? 'flex' : 'none';
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

function loadState() {
    try {
        var s = vscode.getState();
        if (s && s.expanded && Array.isArray(s.expanded)) {state.expanded = s.expanded;}
        if (s && s.pinned && Array.isArray(s.pinned)) {state.pinned = s.pinned;}
    } catch(e) {}
}

// The webview state is shared with the Logs viewer (its `qlog_*` keys): merge, never replace.
function saveState() {
    var all = vscode.getState() || {};
    all.expanded = state.expanded;
    all.pinned = state.pinned;
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
    var selectorHtml =
        '<label>' + options.selectorLabel + ':</label>' +
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
/* The queue items waiting for their background work (the host's queueBackgroundWaits) and which ? lists are open. */
var queueBackgroundWaits = [];
var queueBackgroundOpen = {};

function bgEscape(text) {
    return String(text).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

/** The @CHAT line of each waiting queue item: what, how long, the limit; ?; Wait without limit / Keep waiting / Stop waiting. */
function renderQueueBackgroundWaits() {
    var box = document.getElementById('anthropic-bg-waits');
    if (!box) { return; }
    if (!queueBackgroundWaits.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    box.innerHTML = queueBackgroundWaits.map(function(w) {
        var v = w.view || {};
        var id = bgEscape(w.id);
        var open = queueBackgroundOpen[w.id] === true;
        var list = !open ? '' : '<div class="bg-wait-list">' + (v.items || []).map(function(t) {
            return '<div class="bg-wait-task"><span class="bg-wait-task-name">' + bgEscape(t.description || t.command || t.id) + '</span>'
                + ' <span class="bg-wait-task-id">[' + bgEscape(t.kind === 'command' ? 'handle ' + t.id : t.id) + ']</span>'
                + (t.command && t.command !== t.description ? '<div class="bg-wait-task-cmd"><code>' + bgEscape(t.command) + '</code></div>' : '')
                + (t.outputFile ? '<div class="bg-wait-task-out">output: <code>' + bgEscape(t.outputFile) + '</code></div>' : '')
                + '</div>';
        }).join('') + '</div>';
        return '<div class="bg-wait" data-qid="' + id + '">'
            + '<span class="bg-wait-badge" title="' + bgEscape('Queue item: ' + (w.label || w.id)) + '">\u23f3 Queue: waiting for background work \u2014 ' + bgEscape(v.line || '') + '</span>'
            + ' <button type="button" class="bg-wait-help" data-bg-id="' + id + '" data-bg-action="toggle" title="The running tasks with their commands">?</button>'
            + ' <button type="button" class="bg-wait-btn" data-bg-id="' + id + '" data-bg-action="waitWithoutLimit"' + (v.unlimited ? ' disabled' : '') + ' title="Wait until the work ends, however long">Wait without limit</button>'
            + ' <button type="button" class="bg-wait-btn" data-bg-id="' + id + '" data-bg-action="keepWaiting" title="Start the limit again from now">Keep waiting up to ' + bgEscape(v.limit || '') + '</button>'
            + ' <button type="button" class="bg-wait-btn stop" data-bg-id="' + id + '" data-bg-action="stopWaiting" title="End the turn now (its answer names what still runs); the queue goes on">Stop waiting</button>'
            + list
            + '</div>';
    }).join('');
}

/* The buttons of the waiting line: one delegated listener (no inline handlers under the panel's CSP). */
document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('#anthropic-bg-waits [data-bg-action]') : null;
    if (!btn || btn.disabled) { return; }
    var id = btn.getAttribute('data-bg-id');
    var action = btn.getAttribute('data-bg-action');
    if (action === 'toggle') {
        queueBackgroundOpen[id] = !queueBackgroundOpen[id];
        renderQueueBackgroundWaits();
        return;
    }
    vscode.postMessage({ type: 'queueBackgroundWaitAction', id: id, action: action });
});

function applyChatRuns(msg) {
    chatRunsState = {
        options: Array.isArray(msg.options) && msg.options.length ? msg.options : [{ run: 'default', label: 'default' }],
        selected: msg.selected || {},
        windowRun: msg.windowRun || 'default',
    };
    renderChatRunSelects();
}
function renderChatRunSelects() {
    ['anthropic', 'copilot'].forEach(function(section) {
        var sel = document.getElementById(section + '-run');
        if (!sel) { return; }
        var current = chatRunsState.selected[section] || 'default';
        sel.innerHTML = chatRunsState.options.map(function(o) {
            return '<option value="' + escapeAttr(o.run) + '"' + (o.run === current ? ' selected' : '') + '>Run: ' + escapeAttr(o.label) + '</option>';
        }).join('');
        sel.value = current;
        sel.classList.toggle('run-other', current !== chatRunsState.windowRun);
        sel.onchange = function() {
            chatRunsState.selected[section] = sel.value;
            sel.classList.toggle('run-other', sel.value !== chatRunsState.windowRun);
            vscode.postMessage({ type: 'setChatRun', section: section, run: sel.value });
        };
    });
}

function getSectionContent(id) {
    var contents = {
        copilot: getPromptEditorComponent({
            sectionId: 'copilot',
            selectorKind: 'template',
            selectorLabel: 'Template',
            selectorOptions: '<option value="">(None)</option>',
            selectorClass: 'compact-select',
            selectorTitle: 'Template',
            toolbarClass: 'copilot-compact-toolbar',
            // The run this subpanel is on (vscimpb48): its sends resolve as that run, its queued items carry it.
            secondarySelectorHtml:
                '<select id="copilot-run" class="run-select" data-run-section="copilot" title="The process run this subpanel works on: its session (&lt;session&gt;@&lt;run&gt;), its chat variables and process position, the run of what it queues"><option value="default">default</option></select>',
            prefixButtons:
                '<button class="icon-btn" data-action="openContextPopup" data-id="copilot" title="Context & Settings"><span class="codicon codicon-tools"></span></button>',
            manageButtons:
                '<button class="icon-btn" data-action="addTemplate" data-id="copilot" title="Add Template"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editTemplate" data-id="copilot" title="Edit Template"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteTemplate" data-id="copilot" title="Delete Template"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button class="icon-btn" data-action="preview" data-id="copilot" title="Preview"><span class="codicon codicon-eye"></span></button>' +
                '<button class="icon-btn primary" id="copilot-send-btn" data-action="send" data-id="copilot" title="Send to Copilot"><span class="codicon codicon-send"></span></button>' +
                '<label class="checkbox-label compact-keep" title="Wrap the send in the Copilot Queue Wrapper, so Copilot writes an answer file"><input type="checkbox" id="copilot-wrap"> Wrap</label>' +
                '<label class="checkbox-label compact-keep" title="Queue repeats"><span style="opacity:0.8;">R</span><input type="text" id="copilot-repeat-count" value="1" style="width:24px"></label>' +
                '<label class="checkbox-label compact-keep" title="Answer wait minutes (0 = wait for answer file)"><span style="opacity:0.8;">W</span><input type="text" id="copilot-answer-wait" value="0" style="width:24px"></label>' +
                '<button class="icon-btn" data-action="addToQueue" data-id="copilot" title="Save to Queue"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="copilot" title="Open Queue Editor"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="saveAsTimedRequest" data-id="copilot" title="Save as Timed Request"><span class="codicon codicon-save"></span></button>' +
                '<button class="icon-btn" data-action="openTimedRequestsEditor" data-id="copilot" title="Timed Requests"><span class="codicon codicon-watch"></span></button>' +
                '<button class="icon-btn" data-action="openTrailRawFiles" data-id="copilot" title="Open Raw Trail Files Viewer"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openTrailSummaryViewer" data-id="copilot" title="Open Trail Summary Viewer"><span class="codicon codicon-list-flat"></span></button>' +
                '<label class="checkbox-label compact-keep"><input type="checkbox" id="copilot-keep-content"> Keep</label>' +
                '<button class="icon-btn" data-action="clearText" data-id="copilot" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            afterToolbarHtml:
                '<div class="toolbar answers-toolbar" id="copilot-answers-toolbar" style="display:none;">' +
                '<span id="copilot-answer-indicator" class="answer-indicator">Answer Ready</span>' +
                '<button class="icon-btn" data-action="showAnswerViewer" data-id="copilot" title="View Answer"><span class="codicon codicon-eye"></span></button>' +
                '<button class="icon-btn" data-action="extractAnswer" data-id="copilot" title="Extract to Markdown"><span class="codicon codicon-file-symlink-file"></span></button>' +
                '</div>',
            // Context + Settings overlay no longer lives in this section;
            // it is rendered once at container level by render() so that
            // collapsing the Copilot section does not hide the popup when
            // another section invokes it.
            infoId: 'copilot-templateInfo',
            placeholder: 'Enter your prompt...',
            helpTitle: '',
            afterEditorHtml:
                '<div class="status-bar"><span id="copilot-context-summary" class="context-summary"></span>' +
                '<span class="status-bar-actions">' +
                '<button class="icon-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span></button>' +
                '<button class="icon-btn" data-action="openProcessEditor" title="Process Editor — the processes a quest can follow (_ai/processes)"><span class="codicon codicon-type-hierarchy"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="copilot" title="Open Prompt Queue"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openQueueTemplatesEditor" data-id="copilot" title="Open Queue Templates"><span class="codicon codicon-files"></span></button>' +
                '<button class="icon-btn" data-action="openStatusPage" data-id="copilot" title="Open Extension Status Page"><span class="codicon codicon-dashboard"></span></button>' +
                '</span></div>',
        }),
        anthropic: getPromptEditorComponent({
            sectionId: 'anthropic',
            selectorKind: 'profile',
            selectorLabel: 'Profile',
            selectorOptions: '<option value="">(None)</option>',
            prefixButtons:
                '<button class="icon-btn" data-action="openContextPopup" data-id="anthropic" title="Context & Settings"><span class="codicon codicon-tools"></span></button>',
            secondarySelectorHtml:
                // Edit-profile icon sits immediately after the Profile
                // dropdown — opens the Global Template Editor on the
                // 'anthropicProfiles' category for the selected profile.
                '<button class="icon-btn" data-action="editAnthropicProfile" data-id="anthropic" title="Edit Anthropic profile (system prompt)"><span class="codicon codicon-edit"></span></button>' +
                // Agent SDK session: the button names the session the panel
                // sends in; a click opens VS Code's picker (pick / new / based on).
                '<button class="icon-btn session-btn" data-action="pickAnthropicSession" data-id="anthropic" title="Agent SDK session — click to pick another or create one"><span class="codicon codicon-comment-discussion"></span><span id="anthropic-session-name" class="session-name">chat</span></button>' +
                // The run this subpanel is on (vscimpb48): its session in that run, its chat variables, its queued items.
                '<select id="anthropic-run" class="run-select" data-run-section="anthropic" title="The process run this subpanel works on: its session (&lt;session&gt;@&lt;run&gt;), its chat variables and process position, the run of what it queues"><option value="default">default</option></select>' +
                // Config dropdown intentionally removed — the profile
                // owns configurationId and the handler resolves via
                // profile.configurationId → isDefault → first. Pick a
                // different configuration by switching profile.
                '<span id="anthropic-apikey-dot" class="api-status-dot" title="API key status" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:6px;"></span>' +
                '<span id="anthropic-claude-dot" class="api-status-dot" title="Agent SDK transport: the Anthropic provider&#39;s Agent SDK and Claude CLI installed (Provider SDKs page)" style="display:none;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:4px;"></span>' +
                // User-message template dropdown + inline edit icon (§7.3)
                '<label>User Prompt:</label><select id="anthropic-userMessage" style="width:40%" title="Anthropic user-message template"><option value="">(None)</option></select>' +
                '<button class="icon-btn" data-action="editAnthropicUserMessage" data-id="anthropic" title="Edit Anthropic user-message template"><span class="codicon codicon-edit"></span></button>',
            // Intentionally empty: add/delete for profiles and user-message
            // templates is done inside the Global Template Editor, not here.
            manageButtons: '',
            actionButtons:
                '<button data-action="preview" data-id="anthropic" title="Preview expanded prompt">Preview</button>' +
                '<button class="icon-btn primary" id="anthropic-send-btn" data-action="send" data-id="anthropic" title="Send to Anthropic"><span class="codicon codicon-send"></span></button>' +
                '<button class="icon-btn" data-action="cancel" data-id="anthropic" title="Stop current Anthropic turn"><span class="codicon codicon-debug-stop"></span></button>' +
                // Queue-only repeat count — applied when staging via "Save to Queue";
                // ignored by the inline send button.
                '<label class="checkbox-label compact-keep" title="Queue repeats (used when adding to queue)"><span style="opacity:0.8;">R</span><input type="text" id="anthropic-repeat-count" value="1" style="width:24px"></label>' +
                // Per prompt slot: keep the text after Send / a queue add, or clear it (kept over a reload).
                '<label class="checkbox-label compact-keep" title="Keep this prompt slot&#39;s text after Send or adding to the queue (unchecked: the slot is cleared). Set per slot 1–9."><input type="checkbox" id="anthropic-keep-slot" checked> Keep</label>' +
                // Fresh: Send runs the prompt in a new one-prompt session based on the panel's session,
                // discarded when the answer is in — no follow-up reaches it (kept over a reload).
                '<label class="checkbox-label compact-keep" title="Send in a fresh session: a new one-prompt session based on this panel&#39;s session (it starts from that conversation and changes nothing in it), deleted when the answer is in. No follow-up prompt reaches it: the next Send starts another fresh one."><input type="checkbox" id="anthropic-fresh-session"> Fresh</label>' +
                // Queue buttons. Save to Queue stages the prompt on the prompt queue's own
                // profile and session; the second pins this panel's profile and session.
                // Both keep the panel's user-message template and repeat count.
                '<button class="icon-btn" data-action="addToQueue" data-id="anthropic" title="Save to Queue — runs with the prompt queue&#39;s profile and session"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
                '<button class="icon-btn" data-action="addToQueuePanelTarget" data-id="anthropic" title="Save to Queue with this panel&#39;s profile and session"><span class="codicon codicon-add"></span><span class="codicon codicon-account"></span></button>' +
                // Queue next: pending at the front of the queue, sent next — between two
                // iterations when the item sending is a loop. The queue's profile and session.
                '<button class="icon-btn" data-action="addToQueueNext" data-id="anthropic" title="Queue next — sent next, with the prompt queue&#39;s profile and session; when a repeating item is sending, between its iterations"><span class="codicon codicon-add"></span><span class="codicon codicon-debug-step-into"></span></button>' +
                // The trail, history and memory buttons are in the @CHAT Logs panel, behind its session switch.
                '<button class="icon-btn" data-action="openQueueEditor" data-id="anthropic" title="Open Queue Editor"><span class="codicon codicon-inbox"></span></button>',

            afterToolbarHtml:
                // A queue item waiting for its background work: the line, the ? list and the
                // three choices, as in the queue editor (queueBackgroundWaits).
                '<div id="anthropic-bg-waits" class="bg-waits" style="display:none;"></div>' +
                // Plan mode (CC-3, CC-27): the badge while it is on, with the
                // button that leaves it; a plan proposed with tomAi_exitPlanMode
                // shown for the user to accept or keep planning.
                '<div id="anthropic-plan-badge" class="plan-mode-badge" style="display:none;" title="Write tools are refused until you leave plan mode">' +
                '<span class="codicon codicon-checklist"></span><span class="plan-mode-label">Plan mode: read and plan only</span>' +
                '<button data-action="leavePlanMode" title="Leave plan mode: write tools run again">Leave plan mode</button>' +
                '</div>' +
                '<div id="anthropic-plan-overlay" class="context-overlay" style="display:none;">' +
                '<div class="context-popup plan-popup">' +
                '<div class="context-popup-header"><span>The agent proposes a plan</span></div>' +
                '<div class="context-popup-body">' +
                '<div id="anthropic-plan-body" class="plan-body markdown-body"></div>' +
                '<textarea id="anthropic-plan-feedback" class="plan-feedback" rows="2" placeholder="Optional: what to change (sent with Keep planning)"></textarea>' +
                '</div>' +
                '<div class="context-popup-footer">' +
                '<button class="primary" data-action="planAccept">Accept and leave plan mode</button>' +
                '<button data-action="planKeep">Keep planning</button>' +
                '</div>' +
                '</div>' +
                '</div>' +
                '<div id="anthropic-approval-overlay" class="context-overlay" style="display:none;">' +
                '<div id="anthropic-approval-popup" class="context-popup">' +
                '<div class="context-popup-header"><span>Tool Approval Required</span></div>' +
                '<div class="context-popup-body">' +
                '<div id="anthropic-approval-body" style="padding:8px;font-family:var(--vscode-editor-font-family);white-space:pre-wrap;max-height:40vh;overflow:auto;"></div>' +
                '</div>' +
                '<div class="context-popup-footer">' +
                '<button class="primary" data-action="anthropicApprovalApprove">Approve</button>' +
                '<button data-action="anthropicApprovalApproveAll">Allow All (session)</button>' +
                '<button data-action="anthropicApprovalDeny">Deny</button>' +
                '<button data-action="anthropicApprovalDenyAll">Deny All (session)</button>' +
                '</div>' +
                '</div>' +
                '</div>',
            infoId: 'anthropic-profileInfo',
            placeholder: 'Enter your prompt for Anthropic...',
            helpTitle: '',
            afterEditorHtml:
                // The Model dropdown here is informational only — configurations
                // are the source of truth. It lets the user eyeball which models
                // the API currently returns so they can add configurations when
                // new models ship. The value is never read when sending.
                '<div class="status-bar"><span id="anthropic-status" class="context-summary"></span>' +
                '<span class="status-bar-actions">' +
                '<button class="icon-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span></button>' +
                '<button class="icon-btn" data-action="openProcessEditor" title="Process Editor — the processes a quest can follow (_ai/processes)"><span class="codicon codicon-type-hierarchy"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="anthropic" title="Open Prompt Queue"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openQueueTemplatesEditor" data-id="anthropic" title="Open Queue Templates"><span class="codicon codicon-files"></span></button>' +
                '<button class="icon-btn" data-action="openStatusPage" data-id="anthropic" title="Open Extension Status Page"><span class="codicon codicon-dashboard"></span></button>' +
                '<button class="icon-btn" data-action="recreateHistoryFromTrail" data-id="anthropic" title="Recreate the history of the chosen sessions, each from its own prompt/answer trail. Uses the &quot;Rebuild from last N prompts&quot; window from the Compaction settings and folds rounds in chunks of &quot;Run every N rounds − Raw turn pairs kept&quot;."><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="recreateMemoryFromTrail" data-id="anthropic" title="Recreate the quest memory of the chosen sessions, each from its own prompt/answer trail. Same windowing as Recreate History; the memory-extraction template is responsible for deduping against existing memory."><span class="codicon codicon-database"></span></button>' +
                '<button class="icon-btn" data-action="runQuestRefresh" data-id="anthropic" title="Run Quest Refresh now — dispatch the configured refresh prompt for this quest, then trim the live-trail back to base and reset the prompt counter."><span class="codicon codicon-sync"></span></button>' +
                '<button class="icon-btn" data-action="openQuestHistoryInMdBrowser" data-id="anthropic" title="Open quest history (history.md) in the MD Browser"><span class="codicon codicon-book"></span></button>' +
                '<button class="icon-btn" data-action="openQuestMemoryInMdBrowser" data-id="anthropic" title="Open quest memory (facts.md for the active quest) in the MD Browser"><span class="codicon codicon-notebook"></span></button>' +
                '<button class="icon-btn" data-action="openSharedMemoryInMdBrowser" data-id="anthropic" title="Open shared memory (facts.md in the workspace-wide _ai/memory/shared/) in the MD Browser"><span class="codicon codicon-library"></span></button>' +
                '<label style="margin-left:6px;">Available Models:</label>' +
                '<select id="anthropic-model" style="max-width:240px;" title="Read-only list of models returned by the Anthropic API. The selected configuration controls which model is actually used."><option value="">(loading...)</option></select>' +
                '<button class="icon-btn" data-action="refreshAnthropicModels" data-id="anthropic" title="Refresh models from API"><span class="codicon codicon-refresh"></span></button>' +
                // VS Code LM model dropdown (informational — spec §4.12).
                // Always visible on the Anthropic bottom bar regardless of
                // the active configuration's transport; the user wants
                // ambient visibility of which LM-API models Copilot has
                // on this machine. Auto-populated on panel ready;
                // refresh re-queries vscode.lm.selectChatModels().
                // Selection does NOT retarget sends — the stored modelId
                // of the active configuration drives sends.
                '<span id="anthropic-vscodelm-row">' +
                  '<label style="margin-left:6px;">VS Code LM Models:</label>' +
                  '<select id="anthropic-vscodelm-models" style="max-width:240px;" title="Read-only list of models available via vscode.lm.selectChatModels(). Informational — the stored modelId of the active configuration drives sends. Click Refresh to re-query."><option value="">(loading...)</option></select>' +
                  '<button class="icon-btn" data-action="refreshVsCodeLmModels" data-id="anthropic" title="Refresh VS Code LM model list"><span class="codicon codicon-refresh"></span></button>' +
                '</span>' +
                '</span></div>',
        })
    };
    if (id === 'logs') { return questLogsInit.html || '<div class="qlog-empty">No logs viewer.</div>'; }
    return contents[id] || '<div>Unknown section</div>';
}

var _rendered = false;

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
        // Shared Context & Settings overlay — rendered at container level
        // (not inside any accordion section) so collapsing or switching
        // sections never hides the popup. Same id as before so existing
        // openContextPopup()/closeContextPopup() wiring still works.
        html += '<div id="copilot-context-overlay" class="context-overlay" style="display:none;">' +
            '<div id="copilot-context-popup" class="context-popup">' +
            '<div class="context-popup-header"><span>Context & Settings</span><button class="icon-btn" data-action="closeContextPopup" title="Close"><span class="codicon codicon-close"></span></button></div>' +
            '<div class="context-popup-body">' +
            '<fieldset class="context-group"><legend>Context</legend>' +
            '<div class="context-row"><label>Quest:</label><select id="ctx-quest"></select></div>' +
            '<div class="context-row"><label>Role:</label><select id="ctx-role"></select></div>' +
            '<div class="context-row"><label>Projects:</label><select id="ctx-projects" multiple size="3"></select></div>' +
            '<div class="context-row"><label>Todo File:</label><select id="ctx-todoFile"></select></div>' +
            '<div class="context-row"><label>Todo:</label><select id="ctx-todo"></select></div>' +
            '</fieldset>' +
            '<fieldset class="context-group"><legend>Auto-Hide</legend>' +
            '<div class="context-row"><label>Auto-hide:</label><select id="copilot-autohide"><option value="0">Keep open</option><option value="1000">1s</option><option value="5000">5s</option><option value="10000">10s</option></select></div>' +
            '</fieldset>' +
            '<fieldset class="context-group"><legend>Quick Links</legend>' +
            '<div class="context-links">' +
            '<button class="link-btn" data-action="openStatusPage" title="Extension Status"><span class="codicon codicon-dashboard"></span> Status Page</button>' +
            '<button class="link-btn" data-action="openGlobalTemplateEditor" title="Prompt Template Editor"><span class="codicon codicon-file-code"></span> Template Editor</button>' +
            '<button class="link-btn" data-action="openReusablePromptEditor" title="Reusable Prompt Editor"><span class="codicon codicon-note"></span> Reusable Prompts</button>' +
            '<button class="link-btn" data-action="openContextSettingsEditor" title="Context & Settings Editor"><span class="codicon codicon-settings-gear"></span> Context Editor</button>' +
            '<button class="link-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span> Chat Variables</button>' +
            '<button class="link-btn" data-action="openProcessEditor" title="Process Editor"><span class="codicon codicon-type-hierarchy"></span> Process Editor</button>' +
            '<button class="link-btn" data-action="openTrailRawFiles" data-id="copilot" title="Raw Trail Files Viewer"><span class="codicon codicon-history"></span> Raw Trail Files Viewer</button>' +
            '<button class="link-btn" data-action="openTrailSummaryViewer" data-id="copilot" title="Trail Summary Viewer"><span class="codicon codicon-list-flat"></span> Trail Summary Viewer</button>' +
            '</div>' +
            '</fieldset>' +
            '</div>' +
            '<div class="context-popup-footer"><button class="primary" data-action="applyContext">Apply</button><button data-action="closeContextPopup">Cancel</button></div>' +
            '</div>' +
            '</div>';
        container.innerHTML = html;
        _rendered = true;
        attachEventListeners();
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
var SUBMIT_ACTIONS = ['send', 'addToQueue', 'addToQueuePanelTarget', 'addToQueueNext'];
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
        case 'preview': { var prvText = document.getElementById(id + '-text'); prvText = prvText ? prvText.value : ''; var prvTpl = document.getElementById(id + '-template'); prvTpl = prvTpl ? prvTpl.value : ''; vscode.postMessage({ type: 'preview', section: id, text: prvText, template: prvTpl, wrap: id === 'copilot' && !!(document.getElementById('copilot-wrap') || {}).checked }); break; }
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
        case 'addTemplate': vscode.postMessage({ type: 'addTemplate', section: id }); break;
        case 'editTemplate': { var etSel = document.getElementById(id + '-template'); var etVal = etSel ? etSel.value : ''; vscode.postMessage({ type: 'editTemplate', section: id, name: etVal }); break; }
        case 'deleteProfile': confirmDelete('profile', id); break;
        case 'deleteTemplate': { var dtSel = document.getElementById(id + '-template'); var dtVal = dtSel ? dtSel.value : ''; if (!dtVal) { vscode.postMessage({ type: 'showMessage', message: 'Please select a template to delete.' }); return; } confirmDelete('template', id); break; }
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
            var selState = ensureReusablePromptState(id || '');
            vscode.postMessage({ type: 'saveReusablePrompt', section: id || '', text: currentText ? currentText.value : '', selection: { type: selState.type || '', scopeId: selState.scope || '' } });
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
        case 'showAnswerViewer': vscode.postMessage({ type: 'showAnswerViewer' }); break;
        case 'extractAnswer': vscode.postMessage({ type: 'extractAnswer' }); break;
        case 'openPromptsFile': vscode.postMessage({ type: 'openPromptsFile' }); break;
        case 'openAnswersFile': vscode.postMessage({ type: 'openAnswersFile' }); break;
        case 'openContextPopup': openContextPopup(); break;
        case 'closeContextPopup': closeContextPopup(); break;
        case 'applyContext': applyContextPopup(); break;
        case 'cancel': vscode.postMessage({ type: 'cancel', section: id || '' }); break;
        case 'addToQueue':
            if (id === 'anthropic') { addAnthropicToQueue(false); }
            else { addCopilotToQueue(); }
            break;
        case 'addToQueuePanelTarget': addAnthropicToQueue(true); break;
        case 'addToQueueNext': addAnthropicToQueue(false, true); break;
        case 'openQueueEditor': vscode.postMessage({ type: 'openQueueEditor' }); break;
        case 'openTimedRequestsEditor': vscode.postMessage({ type: 'openTimedRequestsEditor' }); break;
        case 'openTrailRawFiles': vscode.postMessage({ type: 'openTrailRawFiles', section: id || '' }); break;
        case 'openTrailSummaryViewer': vscode.postMessage({ type: 'openTrailSummaryViewer', section: id || '' }); break;
        case 'pickAnthropicSession': vscode.postMessage({ type: 'pickAnthropicSession' }); break;
        case 'saveAsTimedRequest': { var trText = document.getElementById('copilot-text'); trText = trText ? trText.value : ''; if (!trText.trim()) {return;} var trTpl = document.getElementById('copilot-template'); trTpl = trTpl ? trTpl.value : ''; vscode.postMessage({ type: 'saveAsTimedRequest', text: trText, template: trTpl }); break; }
        case 'openChatVariablesEditor': vscode.postMessage({ type: 'openChatVariablesEditor' }); break;
        case 'openProcessEditor': vscode.postMessage({ type: 'openProcessEditor' }); break;
        case 'openStatusPage': vscode.postMessage({ type: 'openStatusPage' }); break;
        case 'recreateHistoryFromTrail': vscode.postMessage({ type: 'recreateHistoryFromTrail' }); break;
        case 'recreateMemoryFromTrail': vscode.postMessage({ type: 'recreateMemoryFromTrail' }); break;
        case 'runQuestRefresh': { var qrProfile = document.getElementById(id + '-profile'); qrProfile = qrProfile ? qrProfile.value : ''; vscode.postMessage({ type: 'runQuestRefresh', section: id || '', profile: qrProfile }); break; }
        case 'openQuestHistoryInMdBrowser': vscode.postMessage({ type: 'openQuestHistoryInMdBrowser' }); break;
        case 'openQuestMemoryInMdBrowser': vscode.postMessage({ type: 'openQuestMemoryInMdBrowser' }); break;
        case 'openSharedMemoryInMdBrowser': vscode.postMessage({ type: 'openSharedMemoryInMdBrowser' }); break;
        case 'openGlobalTemplateEditor': vscode.postMessage({ type: 'openGlobalTemplateEditor' }); break;
        case 'openReusablePromptEditor': vscode.postMessage({ type: 'openReusablePromptEditor' }); break;
        case 'openContextSettingsEditor': vscode.postMessage({ type: 'openContextSettingsEditor' }); break;
        case 'refreshAnthropicModels': vscode.postMessage({ type: 'refreshAnthropicModels' }); break;
        case 'refreshVsCodeLmModels': vscode.postMessage({ type: 'refreshVsCodeLmModels' }); break;
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
    populateCopilotTemplates();
    // The run pickers are part of the sections: fill them again after a render.
    renderChatRunSelects();
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
    // Kick off the initial vscode.lm model fetch once per panel lifetime
    // so the dropdown shows content without requiring a manual refresh.
    // The flag lives on window so repeated populate calls (e.g. config
    // reloads) don't re-request.
    if (!window._anthropicVsCodeLmBooted) {
        window._anthropicVsCodeLmBooted = true;
        vscode.postMessage({ type: 'refreshVsCodeLmModels' });
    }
    ['copilot', 'anthropic'].forEach(function(sectionId) {
        populateReusablePromptSelectors(sectionId);
    });
}

function populateAnthropicModels() {
    // Informational: list the models the API currently returns so the user
    // can add configurations when new models ship. The value is never read
    // when sending — configurations drive model selection.
    var sel = document.getElementById('anthropic-model');
    if (!sel) {return;}
    var opts = '';
    if (!anthropicModels || anthropicModels.length === 0) {
        opts = '<option value="">(no models — check API key)</option>';
    } else {
        opts = '<option value="">(' + anthropicModels.length + ' models available)</option>' + anthropicModels.map(function(m) {
            var label = m.display_name ? (m.display_name + ' (' + m.id + ')') : m.id;
            return '<option value="' + m.id + '">' + label + '</option>';
        }).join('');
    }
    sel.innerHTML = opts;
    updateAnthropicSendButton();
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
        reusablePromptState[sectionId] = { type: 'global', scope: '', file: '' };
    }
    return reusablePromptState[sectionId];
}

function reusableScopeLabel(type) {
    if (type === 'project') {return 'Project:';}
    if (type === 'quest') {return 'Quest:';}
    if (type === 'scan') {return 'Folder:';}
    return '';
}

function scopesForType(type) {
    if (type === 'project') {return reusablePromptModel.scopes.project || [];}
    if (type === 'quest') {return reusablePromptModel.scopes.quest || [];}
    if (type === 'scan') {return reusablePromptModel.scopes.scan || [];}
    return [];
}

function filesForSelection(type, scopeId) {
    if (type === 'global') {
        return reusablePromptModel.files.global || [];
    }
    if (type === 'project') {
        return (reusablePromptModel.files.project && reusablePromptModel.files.project[scopeId || '']) || [];
    }
    if (type === 'quest') {
        return (reusablePromptModel.files.quest && reusablePromptModel.files.quest[scopeId || '']) || [];
    }
    if (type === 'scan') {
        return (reusablePromptModel.files.scan && reusablePromptModel.files.scan[scopeId || '']) || [];
    }
    return [];
}

function populateReusablePromptSelectors(sectionId) {
    var typeSel = document.getElementById(sectionId + '-reusable-type');
    var scopeLabel = document.getElementById(sectionId + '-reusable-scope-label');
    var scopeSel = document.getElementById(sectionId + '-reusable-scope');
    var fileSel = document.getElementById(sectionId + '-reusable-file');
    if (!typeSel || !scopeSel || !fileSel || !scopeLabel) {return;}

    var state = ensureReusablePromptState(sectionId);

    if (!state.type) {
        state.type = 'global';
        state.scope = '';
        state.file = '';
    }

    typeSel.value = state.type;

    var needsScope = state.type === 'project' || state.type === 'quest' || state.type === 'scan';
    scopeLabel.style.display = needsScope ? '' : 'none';
    scopeSel.style.display = needsScope ? '' : 'none';
    scopeLabel.textContent = reusableScopeLabel(state.type);

    var scopes = scopesForType(state.type);
    var hasScope = scopes.some(function(s) { return s.id === state.scope; });
    if (!hasScope) {
        if (state.type === 'quest' && reusablePreferredQuestId) {
            var preferredQuest = scopes.find(function(s) { return s.id === reusablePreferredQuestId; });
            state.scope = preferredQuest ? preferredQuest.id : '';
        }
        if (!state.scope && state.type === 'project' && reusablePreferredProjectId) {
            var preferredProject = scopes.find(function(s) { return s.id === reusablePreferredProjectId; });
            state.scope = preferredProject ? preferredProject.id : '';
        }
        if (!state.scope && state.type === 'scan' && reusablePreferredScanId) {
            var preferredScan = scopes.find(function(s) { return s.id === reusablePreferredScanId; });
            state.scope = preferredScan ? preferredScan.id : '';
        }
        if (!state.scope) {
            state.scope = scopes.length > 0 ? scopes[0].id : '';
        }
        state.file = '';
    }
    scopeSel.innerHTML = '<option value="">(Select)</option>' + scopes.map(function(scope) {
        return '<option value="' + scope.id + '"' + (scope.id === state.scope ? ' selected' : '') + '>' + scope.label + '</option>';
    }).join('');

    var files = filesForSelection(state.type, state.scope);
    var hasFile = files.some(function(f) { return (f.id || '') === state.file; });
    if (!hasFile) {
        state.file = files.length > 0 ? (files[0].id || '') : '';
    }

    fileSel.innerHTML = '<option value="">(File)</option>' + files.map(function(file) {
        var value = file.id || '';
        var label = file.label || value;
        return '<option value="' + value + '"' + (value === state.file ? ' selected' : '') + '>' + label + '</option>';
    }).join('');

    typeSel.disabled = false;
    scopeSel.disabled = !needsScope || scopes.length === 0;
    fileSel.disabled = files.length === 0;
}

function getSelectedReusablePromptId(sectionId) {
    var state = ensureReusablePromptState(sectionId);
    if (!state.file) {
        return '';
    }
    if (state.type === 'global') {
        return 'global::' + state.file;
    }
    if (state.type === 'project') {
        return 'project::' + (state.scope || '') + '::' + state.file;
    }
    if (state.type === 'quest') {
        return 'quest::' + (state.scope || '') + '::' + state.file;
    }
    if (state.type === 'scan') {
        return 'scan::' + (state.scope || '') + '::' + state.file;
    }
    return '';
}

function populateSelect(id, options) {
    var sel = document.getElementById(id);
    if (!sel) {return;}
    var cur = sel.value;
    var baseOptions = '<option value="">(None)</option>';
    sel.innerHTML = baseOptions + (options || []).map(function(o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
    if (cur && options && options.includes(cur)) {sel.value = cur;}
}

function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The Copilot template dropdown: (None) and the user-message templates, the
// one template store. A saved selection that is gone falls back to (None).
function populateCopilotTemplates() {
    var sel = document.getElementById('copilot-template');
    if (!sel) {return;}
    var cur = sel.value;
    sel.innerHTML = '<option value="">(None)</option>' + copilotTemplateEntries.map(function(t) {
        return '<option value="' + escapeAttr(t.id) + '">' + escapeAttr(t.name || t.id) + '</option>';
    }).join('');
    sel.value = copilotTemplateEntries.some(function(t) { return t.id === cur; }) ? cur : '';
}

function populateEntitySelect(id, options, defaultLabel) {
    var sel = document.getElementById(id);
    if (!sel) {return;}
    var cur = sel.value;
    sel.innerHTML = (options || []).map(function(o) {
        var value = (o && typeof o.id === 'string') ? o.id : '';
        var label = (o && typeof o.name === 'string' && o.name) ? o.name : value;
        return '<option value="' + value + '">' + label + '</option>';
    }).join('');
    // Restore previous selection if still available
    if (cur && (options || []).some(function(o) { return o && o.id === cur; })) {
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
        copilotTemplateEntries = Array.isArray(msg.copilotTemplates) ? msg.copilotTemplates : [];
        anthropicConfigurations = msg.anthropicConfigurations || [];
        anthropicProfileEntries = msg.anthropicProfileEntries || [];
        anthropicUserMessageTemplates = msg.anthropicUserMessageTemplates || [];
        anthropicApiKeyOk = !!msg.anthropicApiKeyOk;
        claudeCliVisible = !!msg.claudeCliVisible;
        claudeCliOk = (msg.claudeCliOk === true || msg.claudeCliOk === false) ? msg.claudeCliOk : null;
        populateDropdowns();
        updateAnthropicApiKeyDot();
        updateClaudeCliDot();
    } else if (msg.type === 'chatRuns') {
        applyChatRuns(msg);
    } else if (msg.type === 'queueBackgroundWaits') {
        queueBackgroundWaits = Array.isArray(msg.waits) ? msg.waits : [];
        renderQueueBackgroundWaits();
    } else if (msg.type === 'anthropicSession') {
        // The session as the queue's context bar shows it: name, base, lifetime, model.
        var sessionLabel = document.getElementById('anthropic-session-name');
        if (sessionLabel) { sessionLabel.textContent = msg.label || msg.name || 'chat'; }
        var sessionBtn = sessionLabel ? sessionLabel.closest('.session-btn') : null;
        if (sessionBtn && msg.tooltip) { sessionBtn.title = msg.tooltip + ' — click to pick another or create one'; }
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
        if (msg.error) {
            setAnthropicStatus('Models unavailable: ' + msg.error);
        } else {
            setAnthropicStatus('');
        }
        populateAnthropicModels();
    } else if (msg.type === 'vscodeLmModels') {
        // Informational — populate the VS Code LM dropdown (spec §4.12).
        // Does NOT retarget sends; the configuration's stored modelId
        // drives sends.
        var vlmSelect = document.getElementById('anthropic-vscodelm-models');
        if (vlmSelect) {
            var vlmList = msg.models || [];
            if (vlmList.length === 0) {
                var emptyMsg = msg.error
                    ? ('(error: ' + msg.error + ')')
                    : ('(' + (msg.hint || 'no models') + ')');
                vlmSelect.innerHTML = '<option value="">' + emptyMsg + '</option>';
                // One-shot retry — Copilot often takes a few seconds to
                // finish activating after VS Code startup. The first
                // query can legitimately return 0 models; try again
                // after a short delay instead of leaving the user with
                // an empty dropdown that requires a manual refresh.
                if (!msg.error && !window._anthropicVsCodeLmRetried) {
                    window._anthropicVsCodeLmRetried = true;
                    setTimeout(function() {
                        vscode.postMessage({ type: 'refreshVsCodeLmModels' });
                    }, 3000);
                }
            } else {
                vlmSelect.innerHTML = '<option value="">(' + vlmList.length + ' models available)</option>' +
                    vlmList.map(function(m) {
                        return '<option value="' + m.id + '">' + m.label + '</option>';
                    }).join('');
            }
        }
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
        // compaction…", "Rebuild history from last N prompts…").
        // Only apply while we're actively sending — after a result
        // we want the result's own status line (tool-call summary /
        // session turn count), not a stale "waiting…" entry.
        if (anthropicSending && typeof msg.text === 'string' && msg.text.length > 0) {
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
        reusablePromptModel = msg.model || { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
        reusablePreferredQuestId = msg.preferredQuestId || '';
        reusablePreferredProjectId = msg.preferredProjectId || '';
        reusablePreferredScanId = msg.preferredScanId || '';
        ['copilot', 'anthropic'].forEach(function(sectionId) {
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
    } else if (msg.type === 'answerFileStatus') {
        copilotHasAnswer = !!msg.hasAnswer;
        copilotAnswerSlot = msg.answerSlot || 0;
        updateSlotButtonsUI('copilot');
        refreshCopilotAnswerToolbarVisibility();
        var indicator = document.getElementById('copilot-answer-indicator');
        if (indicator && msg.hasAnswer) {
            var slotNo = msg.answerSlot || 1;
            indicator.innerHTML = 'Answer Ready <span class="answer-slot-badge">' + slotNo + '</span>';
        }
    } else if (msg.type === 'autoHideDelay') {
        var select = document.getElementById('copilot-autohide');
        if (select) {select.value = String(msg.value || 0);}
    } else if (msg.type === 'keepContent') {
        var cb = document.getElementById('copilot-keep-content');
        if (cb) {cb.checked = msg.value;}
    } else if (msg.type === 'clearCopilotText') {
        var ta = document.getElementById('copilot-text');
        if (ta) {
            ta.value = '';
            setSlotText('copilot', ensureSlotState('copilot').activeSlot, '');
            saveDrafts();
        }
    } else if (msg.type === 'contextData') {
        populateContextPopup(msg);
    } else if (msg.type === 'contextTodoFiles') {
        // Update todoFile and todo dropdowns when quest changes in popup
        var todoFileSel = document.getElementById('ctx-todoFile');
        if (todoFileSel) {
            todoFileSel.innerHTML = '<option value="">(None)</option>' + (msg.todoFiles || []).map(function(f) {
                return '<option value="' + f + '">' + f + '</option>';
            }).join('');
        }
        var todoSel = document.getElementById('ctx-todo');
        if (todoSel) {todoSel.innerHTML = '<option value="">(None)</option>';}
    } else if (msg.type === 'contextTodosUpdate') {
        // Partial update: only refresh the todo dropdown, leave everything else untouched
        var todoSelPartial = document.getElementById('ctx-todo');
        if (todoSelPartial) {
            todoSelPartial.innerHTML = '<option value="">(None)</option>' + (msg.todos || []).map(function(t) {
                var icon = t.status === 'completed' ? '\u2705' : t.status === 'in-progress' ? '\uD83D\uDD04' : t.status === 'blocked' ? '\u26D4' : '\u2B1C';
                return '<option value="' + t.id + '">' + icon + ' ' + t.id + ': ' + (t.title || t.description || '').substring(0, 40) + '</option>';
            }).join('');
        }
    } else if (msg.type === 'contextSummary') {
        var summaryEl = document.getElementById('copilot-context-summary');
        if (summaryEl) {summaryEl.textContent = msg.text || '';}
    } else if (msg.type === 'queueAdded' && msg.section === 'anthropic') {
        // The ANTHROPIC slot the prompt was queued from: cleared unless it keeps its text.
        var queuedSlot = parseInt(String(msg.slot || ensureSlotState('anthropic').activeSlot), 10);
        if (queuedSlot >= 1 && queuedSlot <= 9) { clearSlotUnlessKept('anthropic', queuedSlot); }
    } else if (msg.type === 'queueAdded') {
        // Clear textarea after successful queue add (respecting keep checkbox)
        var keepCb = document.getElementById('copilot-keep-content');
        if (!keepCb || !keepCb.checked) {
            var ta = document.getElementById('copilot-text');
            if (ta) {
                ta.value = '';
                setSlotText('copilot', ensureSlotState('copilot').activeSlot, '');
            }
        }
        // Flash the send button green briefly
        var sendBtn = document.getElementById('copilot-send-btn');
        if (sendBtn) {
            sendBtn.style.background = 'var(--vscode-charts-green, #388a34)';
            setTimeout(function() { sendBtn.style.background = ''; }, 600);
        }
    } else if (msg.type === 'draftsLoaded') {
        var secs = msg.sections || {};
        ['copilot'].forEach(function(s) {
            var d = secs[s];
            if (!d) {return;}
            var sectionState = ensureSlotState(s);
            if (d.slots && typeof d.slots === 'object') {
                sectionState.slots = d.slots;
            }
            if (d.activeSlot && d.activeSlot >= 1 && d.activeSlot <= 9) {
                sectionState.activeSlot = d.activeSlot;
            }
            var ta = document.getElementById(s + '-text');
            if (ta) {
                var slotText = getSlotText(s, sectionState.activeSlot);
                ta.value = slotText || d.text || '';
            }
            var profileId = s === 'copilot' ? s + '-template' : s + '-profile';
            var sel = document.getElementById(profileId);
            if (sel && d.profile) {sel.value = d.profile;}
            updateSlotButtonsUI(s);
        });
        // Restore Anthropic-specific state
        var da = secs['anthropic'];
        if (da) {
            var anthrSectionState = ensureSlotState('anthropic');
            if (da.slots && typeof da.slots === 'object') { anthrSectionState.slots = da.slots; }
            if (da.activeSlot && da.activeSlot >= 1 && da.activeSlot <= 9) { anthrSectionState.activeSlot = da.activeSlot; }
            if (da.slotKeep && typeof da.slotKeep === 'object') { anthrSectionState.keep = da.slotKeep; }
            var freshRestore = document.getElementById('anthropic-fresh-session');
            if (freshRestore) { freshRestore.checked = da.fresh === true; }
            var anthrTa = document.getElementById('anthropic-text');
            if (anthrTa) { anthrTa.value = getSlotText('anthropic', anthrSectionState.activeSlot) || da.text || ''; }
            var anthrProfile = document.getElementById('anthropic-profile');
            if (anthrProfile && da.profile) { anthrProfile.value = da.profile; }
            // (Model + Config dropdowns removed — nothing to restore.)
            var anthrUserMsg = document.getElementById('anthropic-userMessage');
            if (anthrUserMsg && da.userMessageTemplate) { anthrUserMsg.value = da.userMessageTemplate; }
            updateSlotButtonsUI('anthropic');
            updateSlotKeepUI('anthropic');
        }
        refreshCopilotAnswerToolbarVisibility();
        _draftsLoaded = true;
    }
});

function sendCopilotPrompt() {
    var text = document.getElementById('copilot-text');
    text = text ? text.value : '';
    if (!text.trim()) {return;}
    var template = document.getElementById('copilot-template');
    template = template ? template.value : '';
    var wrapEl = document.getElementById('copilot-wrap');
    var slot = ensureSlotState('copilot').activeSlot;
    vscode.postMessage({ type: 'sendCopilot', text: text, template: template, slot: slot, wrap: !!(wrapEl && wrapEl.checked) });
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

function addCopilotToQueue() {
    var text = document.getElementById('copilot-text');
    text = text ? text.value : '';
    if (!text.trim()) {return;}
    var template = document.getElementById('copilot-template');
    template = template ? template.value : '';
    var repeatEl = document.getElementById('copilot-repeat-count');
    var repeatCount = normalizeRepeatField(repeatEl ? repeatEl.value : '1');
    var waitEl = document.getElementById('copilot-answer-wait');
    var answerWaitMinutes = Math.max(0, parseInt(String(waitEl ? waitEl.value : '0'), 10) || 0);
    var slot = ensureSlotState('copilot').activeSlot;
    vscode.postMessage({ type: 'addToQueue', text: text, template: template, repeatCount: repeatCount, answerWaitMinutes: answerWaitMinutes, slot: slot });
    // Reset the repeat count to 1 so the next simple prompt isn't accidentally
    // queued again with a leftover (high) repeat count.
    if (repeatEl) { repeatEl.value = '1'; }
}

function addAnthropicToQueue(usePanelTarget, next) {
    // Stage a queue item with transport='anthropic' and the panel's
    // user-message template. Profile and session: the prompt queue's own,
    // unless usePanelTarget pins this panel's profile and session. `next`
    // queues it pending at the front instead (sent next; between the
    // iterations of a repeating item that is sending).
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
        ...(next ? { next: true } : {}),
    });
    // Reset the repeat count to 1 so the next simple prompt isn't accidentally
    // queued again with a leftover (high) repeat count.
    if (repeatEl) { repeatEl.value = '1'; }
}

function openContextPopup() {
    var overlay = document.getElementById('copilot-context-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        vscode.postMessage({ type: 'getContextData' });
    }
}

function closeContextPopup() {
    var overlay = document.getElementById('copilot-context-overlay');
    if (overlay) {overlay.style.display = 'none';}
}

function populateContextPopup(data) {
    // Quest picker
    var questSel = document.getElementById('ctx-quest');
    if (questSel) {
        questSel.innerHTML = '<option value="">(None)</option>' + (data.quests || []).map(function(q) {
            return '<option value="' + q + '"' + (q === data.currentQuest ? ' selected' : '') + '>' + q + '</option>';
        }).join('');
    }
    // Role selector
    var roleSel = document.getElementById('ctx-role');
    if (roleSel) {
        roleSel.innerHTML = '<option value="">(None)</option>' + (data.roles || []).map(function(r) {
            return '<option value="' + r + '"' + (r === data.currentRole ? ' selected' : '') + '>' + r + '</option>';
        }).join('');
    }
    // Project multi-select
    var projSel = document.getElementById('ctx-projects');
    if (projSel) {
        var activeProjects = data.activeProjects || [];
        projSel.innerHTML = (data.projects || []).map(function(p) {
            return '<option value="' + p + '"' + (activeProjects.includes(p) ? ' selected' : '') + '>' + p + '</option>';
        }).join('');
    }
    // Todo file picker
    var todoFileSel = document.getElementById('ctx-todoFile');
    if (todoFileSel) {
        todoFileSel.innerHTML = '<option value="">(None)</option>' + (data.todoFiles || []).map(function(f) {
            return '<option value="' + f + '"' + (f === data.currentTodoFile ? ' selected' : '') + '>' + f + '</option>';
        }).join('');
    }
    // Todo selector
    var todoSel = document.getElementById('ctx-todo');
    if (todoSel) {
        todoSel.innerHTML = '<option value="">(None)</option>' + (data.todos || []).map(function(t) {
            var icon = t.status === 'completed' ? '\u2705' : t.status === 'in-progress' ? '\uD83D\uDD04' : t.status === 'blocked' ? '\u26D4' : '\u2B1C';
            return '<option value="' + t.id + '"' + (t.id === data.currentTodo ? ' selected' : '') + '>' + icon + ' ' + t.id + ': ' + (t.title || t.description || '').substring(0, 40) + '</option>';
        }).join('');
    }
}

function applyContextPopup() {
    var questSel = document.getElementById('ctx-quest');
    var roleSel = document.getElementById('ctx-role');
    var projSel = document.getElementById('ctx-projects');
    var todoFileSel = document.getElementById('ctx-todoFile');
    var todoSel = document.getElementById('ctx-todo');

    var selectedProjects = [];
    if (projSel) {
        for (var i = 0; i < projSel.options.length; i++) {
            if (projSel.options[i].selected) {selectedProjects.push(projSel.options[i].value);}
        }
    }

    vscode.postMessage({
        type: 'applyContext',
        quest: questSel ? questSel.value : '',
        role: roleSel ? roleSel.value : '',
        activeProjects: selectedProjects,
        todoFile: todoFileSel ? todoFileSel.value : '',
        todo: todoSel ? todoSel.value : ''
    });
    closeContextPopup();
}

function initCopilotSection() {
    var autohideSelect = document.getElementById('copilot-autohide');
    if (autohideSelect) {
        autohideSelect.addEventListener('change', function() {
            vscode.postMessage({ type: 'setAutoHideDelay', value: parseInt(this.value, 10) });
        });
    }
    var keepContentCb = document.getElementById('copilot-keep-content');
    if (keepContentCb) {
        keepContentCb.addEventListener('change', function() {
            vscode.postMessage({ type: 'setKeepContent', value: this.checked });
        });
    }
    // When popup todo file changes, request todos for that file
    var todoFileSel = document.getElementById('ctx-todoFile');
    if (todoFileSel) {
        todoFileSel.addEventListener('change', function() {
            vscode.postMessage({ type: 'getTodosForFile', file: this.value });
        });
    }
    // When popup quest changes, re-fetch todoFiles and todos for new quest
    var questSel = document.getElementById('ctx-quest');
    if (questSel) {
        questSel.addEventListener('change', function() {
            vscode.postMessage({ type: 'getContextDataForQuest', quest: this.value });
        });
    }
}

function initReusablePromptSelectors() {
    ['copilot', 'anthropic'].forEach(function(sectionId) {
        var typeSel = document.getElementById(sectionId + '-reusable-type');
        if (typeSel) {
            typeSel.addEventListener('change', function() {
                var state = ensureReusablePromptState(sectionId);
                state.type = typeSel.value || '';
                state.scope = '';
                state.file = '';
                // Re-fetch from disk so newly added files appear
                vscode.postMessage({ type: 'getReusablePrompts' });
            });
        }

        var scopeSel = document.getElementById(sectionId + '-reusable-scope');
        if (scopeSel) {
            scopeSel.addEventListener('change', function() {
                var state = ensureReusablePromptState(sectionId);
                state.scope = scopeSel.value || '';
                state.file = '';
                // Re-fetch from disk so newly added files appear
                vscode.postMessage({ type: 'getReusablePrompts' });
            });
        }

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
initCopilotSection();
initReusablePromptSelectors();
vscode.postMessage({ type: 'getProfiles' });
vscode.postMessage({ type: 'getReusablePrompts' });
vscode.postMessage({ type: 'getAutoHideDelay' });
vscode.postMessage({ type: 'getKeepContent' });
vscode.postMessage({ type: 'checkAnswerFile' });
vscode.postMessage({ type: 'getContextSummary' });
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
        ['copilot'].forEach(function(s) {
            var ta = document.getElementById(s + '-text');
            var profileId = s === 'copilot' ? s + '-template' : s + '-profile';
            var sel = document.getElementById(profileId);
            var sectionState = ensureSlotState(s);
            if (ta) {
                setSlotText(s, sectionState.activeSlot, ta.value || '');
            }
            drafts[s] = {
                text: ta ? ta.value : '',
                profile: sel ? sel.value : '',
                activeSlot: sectionState.activeSlot,
                slots: sectionState.slots,
            };
        });
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
        };
        vscode.postMessage({ type: 'saveDrafts', drafts: drafts });
    }, 1000);
}
// Attach save to all textareas and dropdowns
['copilot-text', 'anthropic-text'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('input', saveDrafts);}
});
['copilot-template', 'anthropic-profile'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('change', saveDrafts);}
});
['anthropic-userMessage'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('change', saveDrafts);}
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
