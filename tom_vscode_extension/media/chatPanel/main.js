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
    { id: 'localLlm', icon: '<span class="codicon codicon-robot"></span>', title: 'Local LLM' },
    { id: 'conversation', icon: '<span class="codicon codicon-comment-discussion"></span>', title: 'AI Conversation' },
    { id: 'copilot', icon: '<span class="codicon codicon-copilot"></span>', title: 'Copilot' },
    { id: 'tomAiChat', icon: '<span class="codicon codicon-comment-discussion-sparkle"></span>', title: 'Tom AI Chat' },
    { id: 'anthropic', icon: '<span class="codicon codicon-sparkle"></span>', title: 'Anthropic' }
];
var state = { expanded: ['localLlm'], pinned: [] };
var profiles = { localLlm: [], conversation: [], copilot: [], tomAiChat: [], anthropic: [] };
var configurations = [];
var setups = [];
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
var pendingAnthropicApprovals = {};
var defaultCopilotTemplate = '';
var reusablePromptModel = { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
var pendingReusableCopySection = '';
var reusablePreferredQuestId = '';
var reusablePreferredProjectId = '';
var reusablePreferredScanId = '';
var reusablePromptState = {};
var copilotHasAnswer = false;
var copilotAnswerSlot = 0;
var slotEnabledSections = ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'];
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

function saveState() { vscode.setState(state); }

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

function getSectionContent(id) {
    var contents = {
        localLlm: getPromptEditorComponent({
            sectionId: 'localLlm',
            selectorKind: 'profile',
            selectorLabel: 'Profile',
            selectorOptions: '<option value="">(None)</option>',
            // Inline edit-profile pencil sits right after the profile
            // dropdown, mirroring the Anthropic panel layout. Routes
            // through the same editProfile action as the existing
            // pencil in manageButtons (_handleEditProfile resolves
            // section=localLlm to the localLlm template category and
            // opens the Global Template Editor on the selected item).
            // (Comments deliberately backtick-free: this whole function
            // is embedded inside the _getScript() template literal.)
            secondarySelectorHtml:
                '<button class="icon-btn" data-action="editProfile" data-id="localLlm" title="Edit Local LLM profile (system prompt)"><span class="codicon codicon-edit"></span></button>' +
                '<label>LLM Config:</label><select id="localLlm-llmConfig" style="width:70%"></select>',
            manageButtons:
                '<button class="icon-btn" data-action="addProfile" data-id="localLlm" title="Add Profile"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editProfile" data-id="localLlm" title="Edit Profile"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteProfile" data-id="localLlm" title="Delete Profile"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button data-action="preview" data-id="localLlm" title="Preview expanded prompt">Preview</button>' +
                '<button class="primary" data-action="send" data-id="localLlm" title="Send prompt to Local LLM">Send to LLM</button>' +
                '<button class="icon-btn" data-action="cancel" data-id="localLlm" title="Stop current Local LLM turn"><span class="codicon codicon-debug-stop"></span></button>' +
                // Mirrors the Anthropic panels Raw Trail + Summary
                // viewer buttons. The Raw viewer (history icon) shows
                // every prompt/payload/tool-request/tool-answer file in
                // the localllm trail bucket; the Summary viewer
                // (list-flat icon) opens the consolidated
                // <quest>-<profile>.prompts.md / .answers.md pair for
                // the profile of the most recent LocalLLM send.
                '<button class="icon-btn" data-action="openTrailRawFiles" data-id="localLlm" title="Open Raw Trail Files Viewer"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openTrailSummaryViewer" data-id="localLlm" title="Open Trail Summary Viewer (last-used Local LLM profile)"><span class="codicon codicon-list-flat"></span></button>' +
                // Mirror of the Anthropic panels live-trail button.
                // Opens the per-quest live-trail-localLLM.md (parallel
                // to Anthropics live-trail.md) in the MD Browser so the
                // user can watch thinking + tool calls + the final
                // answer stream into the file as the LocalLLM turn
                // runs. The MD Browser file-watcher re-renders on every
                // write (debounced 200 ms).
                '<button class="icon-btn" data-action="openLiveTrail" data-id="localLlm" title="Open live trail — continuously-updating MD of the current + last 4 LocalLLM prompts (thinking, tool calls + results, assistant text); opens in the MD Browser which auto-reloads as the turn runs"><span class="codicon codicon-pulse"></span></button>' +
                '<button class="icon-btn" data-action="clearText" data-id="localLlm" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            infoId: 'localLlm-profileInfo',
            placeholder: 'Enter your prompt for the local LLM...',
            helpTitle: '',
            // Live status line below the textarea. Mirrors the
            // anthropic-status span and is updated via the
            // localLlmStatus webview message. Empty by default; shows
            // phase strings like "Sending to <model>...", "Round 3 -
            // tool <name> done", "Done - 4 rounds, 2 tool calls (1.2s)",
            // or "Error: ...". (Comment deliberately backtick-free:
            // this whole function lives inside the _getScript() template
            // literal.)
            afterEditorHtml: '<div class="status-bar"><span id="localLlm-status" class="context-summary"></span>' +
                '<span class="status-bar-actions">' +
                '<button class="icon-btn" data-action="runQuestRefresh" data-id="localLlm" title="Run Quest Refresh now — dispatch the configured Local LLM refresh prompt for this quest, then trim the live-trail back to base and reset the prompt counter."><span class="codicon codicon-sync"></span></button>' +
                '</span></div>',
        }),
        conversation: getPromptEditorComponent({
            sectionId: 'conversation',
            selectorKind: 'profile',
            selectorLabel: 'Profile',
            selectorOptions: '<option value="">(None)</option>',
            secondarySelectorHtml: '<label>AI Setup:</label><select id="conversation-aiSetup" style="width:70%"></select>',
            manageButtons:
                '<button class="icon-btn" data-action="addProfile" data-id="conversation" title="Add Profile"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editProfile" data-id="conversation" title="Edit Profile"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteProfile" data-id="conversation" title="Delete Profile"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button data-action="preview" data-id="conversation" title="Preview expanded prompt">Preview</button>' +
                '<button class="primary" data-action="send" data-id="conversation" title="Start AI Conversation">Start</button>' +
                '<button class="icon-btn" data-action="cancel" data-id="conversation" title="Halt AI conversation"><span class="codicon codicon-debug-stop"></span></button>' +
                '<button class="icon-btn" data-action="clearText" data-id="conversation" title="Clear text"><span class="codicon codicon-clear-all"></span></button>' +
                '<button class="icon-btn" data-action="openConversationTrailViewer" data-id="conversation" title="Open AI conversation trail viewer"><span class="codicon codicon-list-flat"></span></button>' +
                '<button class="icon-btn" data-action="openConversationMarkdown" data-id="conversation" title="Open latest AI conversation markdown"><span class="codicon codicon-file"></span></button>' +
                '<button class="icon-btn" data-action="openConversationCompactTrail" data-id="conversation" title="Open AI conversation compact trail"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openConversationTurnFilesEditor" data-id="conversation" title="Open AI conversation per-turn files"><span class="codicon codicon-files"></span></button>',
            infoId: 'conversation-profileInfo',
            placeholder: 'Enter your goal/description for the conversation...',
            helpTitle: 'Tip: Describe the goal clearly. The bot will orchestrate a multi-turn conversation with Copilot.',
        }),
        copilot: getPromptEditorComponent({
            sectionId: 'copilot',
            selectorKind: 'template',
            selectorLabel: 'Template',
            selectorOptions: '<option value="">(None)</option><option value="__answer_file__">Answer Wrapper</option>',
            selectorClass: 'compact-select',
            selectorTitle: 'Template',
            toolbarClass: 'copilot-compact-toolbar',
            prefixButtons:
                '<button class="icon-btn" data-action="openContextPopup" data-id="copilot" title="Context & Settings"><span class="codicon codicon-tools"></span></button>',
            manageButtons:
                '<button class="icon-btn" data-action="addTemplate" data-id="copilot" title="Add Template"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editTemplate" data-id="copilot" title="Edit Template"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteTemplate" data-id="copilot" title="Delete Template"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button class="icon-btn" data-action="preview" data-id="copilot" title="Preview"><span class="codicon codicon-eye"></span></button>' +
                '<button class="icon-btn primary" id="copilot-send-btn" data-action="send" data-id="copilot" title="Send to Copilot"><span class="codicon codicon-send"></span></button>' +
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
                '<button class="icon-btn" data-action="openQueueEditor" data-id="copilot" title="Open Prompt Queue"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openQueueTemplatesEditor" data-id="copilot" title="Open Queue Templates"><span class="codicon codicon-files"></span></button>' +
                '<button class="icon-btn" data-action="openStatusPage" data-id="copilot" title="Open Extension Status Page"><span class="codicon codicon-dashboard"></span></button>' +
                '</span></div>',
        }),
        tomAiChat: getPromptEditorComponent({
            sectionId: 'tomAiChat',
            selectorKind: 'template',
            selectorLabel: 'Template',
            selectorOptions: '<option value="">(None)</option>',
            manageButtons:
                '<button class="icon-btn" data-action="addTemplate" data-id="tomAiChat" title="Add Template"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editTemplate" data-id="tomAiChat" title="Edit Template"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteTemplate" data-id="tomAiChat" title="Delete Template"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button data-action="openChatFile" data-id="tomAiChat" title="Open or create .chat.md file">Open</button>' +
                '<button data-action="preview" data-id="tomAiChat" title="Preview expanded prompt">Preview</button>' +
                '<button class="icon-btn" data-action="cancel" data-id="tomAiChat" title="Interrupt Tom AI Chat turn"><span class="codicon codicon-debug-stop"></span></button>' +
                '<button class="primary" data-action="insertToChatFile" data-id="tomAiChat" title="Insert into .chat.md file">Insert</button>' +
                '<button class="icon-btn" data-action="clearText" data-id="tomAiChat" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            infoId: 'tomAiChat-templateInfo',
            placeholder: 'Enter your prompt for Tom AI Chat...',
            helpTitle: 'Show Placeholder Help',
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
                // Config dropdown intentionally removed — the profile
                // owns configurationId and the handler resolves via
                // profile.configurationId → isDefault → first. Pick a
                // different configuration by switching profile.
                '<span id="anthropic-apikey-dot" class="api-status-dot" title="API key status" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:6px;"></span>' +
                '<span id="anthropic-claude-dot" class="api-status-dot" title="Claude Code install status (Agent SDK transport)" style="display:none;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:4px;"></span>' +
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
                // Queue buttons — mirror the Copilot section (spec §4.11).
                // Stages the prompt as a queued item with transport='anthropic'
                // and pins the current profile / user-message template.
                '<button class="icon-btn" data-action="addToQueue" data-id="anthropic" title="Save to Queue"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="anthropic" title="Open Queue Editor"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openTrailRawFiles" data-id="anthropic" title="Open Raw Trail Files Viewer"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openTrailSummaryViewer" data-id="anthropic" title="Open Trail Summary Viewer"><span class="codicon codicon-list-flat"></span></button>' +
                '<button class="icon-btn" data-action="openSessionHistory" data-id="anthropic" title="Open session history — the rolling history.md from the quest folder, rendered in the MD Browser"><span class="codicon codicon-file-text"></span></button>' +
                '<button class="icon-btn" data-action="openLiveTrail" data-id="anthropic" title="Open live trail — continuously-updating MD of the current + last 4 prompts (thinking, tool calls + results, assistant text); opens in the MD Browser which auto-reloads as the turn runs"><span class="codicon codicon-pulse"></span></button>' +
                '<button class="icon-btn" data-action="openAnthropicMemory" data-id="anthropic" title="Memory Panel"><span class="codicon codicon-book"></span></button>' +
                '<button class="icon-btn" data-action="clearAnthropicHistory" data-id="anthropic" title="Clear session history"><span class="codicon codicon-clear-all"></span></button>',
            afterToolbarHtml:
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
                '<button class="icon-btn" data-action="openQueueEditor" data-id="anthropic" title="Open Prompt Queue"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openQueueTemplatesEditor" data-id="anthropic" title="Open Queue Templates"><span class="codicon codicon-files"></span></button>' +
                '<button class="icon-btn" data-action="openStatusPage" data-id="anthropic" title="Open Extension Status Page"><span class="codicon codicon-dashboard"></span></button>' +
                '<button class="icon-btn" data-action="recreateHistoryFromTrail" data-id="anthropic" title="Recreate history.json from the prompt/answer trail files. Uses the &quot;Rebuild from last N prompts&quot; window from the Compaction settings and folds rounds in chunks of &quot;Run every N rounds − Raw turn pairs kept&quot;."><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="recreateMemoryFromTrail" data-id="anthropic" title="Recreate quest memory from the prompt/answer trail files. Same windowing as Recreate History; the memory-extraction template is responsible for deduping against existing memory."><span class="codicon codicon-database"></span></button>' +
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

function attachEventListeners() {
    if (!delegatedUiHandlersAttached) {
        document.addEventListener('click', function(event) {
            var target = event.target;
            if (!target || !target.closest) {return;}

            var actionEl = target.closest('[data-action]');
            if (actionEl) {
                event.preventDefault();
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
        case 'send': { var text = document.getElementById(id + '-text'); text = text ? text.value : ''; if (!text.trim()) {return;} var profile = document.getElementById(id + '-profile'); profile = profile ? profile.value : ''; var template = document.getElementById(id + '-template'); template = template ? template.value : ''; var llmConfig = document.getElementById('localLlm-llmConfig'); llmConfig = llmConfig ? llmConfig.value : ''; var aiSetup = document.getElementById('conversation-aiSetup'); aiSetup = aiSetup ? aiSetup.value : ''; var anthropicUserMessage = document.getElementById('anthropic-userMessage'); anthropicUserMessage = anthropicUserMessage ? anthropicUserMessage.value : ''; var slotNo = ensureSlotState(id).activeSlot; if (id === 'anthropic') { anthropicSending = true; updateAnthropicSendButton(); setAnthropicStatus('Sending…'); } vscode.postMessage({ type: 'send' + id.charAt(0).toUpperCase() + id.slice(1), text: text, profile: profile, template: template, llmConfig: llmConfig, aiSetup: aiSetup, model: '', config: '', userMessageTemplate: anthropicUserMessage, slot: slotNo }); break; }
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
        case 'trail': vscode.postMessage({ type: 'showTrail', section: id }); break;
        case 'reload': vscode.postMessage({ type: 'reload', section: id }); break;
        case 'open': vscode.postMessage({ type: 'openInEditor', section: id }); break;
        case 'addNote': vscode.postMessage({ type: 'addNote' }); break;
        case 'addProfile': vscode.postMessage({ type: 'addProfile', section: id }); break;
        case 'editProfile': { var epSel = document.getElementById(id + '-profile'); vscode.postMessage({ type: 'editProfile', section: id, name: epSel ? epSel.value : '' }); break; }
        case 'addTemplate': vscode.postMessage({ type: 'addTemplate', section: id }); break;
        case 'editTemplate': { var etSel = document.getElementById(id + '-template'); var etVal = etSel ? etSel.value : ''; vscode.postMessage({ type: 'editTemplate', section: id, name: etVal }); break; }
        case 'deleteProfile': confirmDelete('profile', id); break;
        case 'deleteTemplate': { var dtSel = document.getElementById(id + '-template'); var dtVal = dtSel ? dtSel.value : ''; if (dtVal === '__answer_file__') { vscode.postMessage({ type: 'showMessage', message: 'The Answer File template is built-in and cannot be deleted.' }); return; } confirmDelete('template', id); break; }
        case 'openChatFile': vscode.postMessage({ type: 'openChatFile' }); break;
        case 'insertToChatFile': { var insertText = document.getElementById(id + '-text'); insertText = insertText ? insertText.value : ''; if (!insertText.trim()) {return;} var insertTemplate = document.getElementById(id + '-template'); insertTemplate = insertTemplate ? insertTemplate.value : ''; vscode.postMessage({ type: 'insertToChatFile', text: insertText, template: insertTemplate }); break; }
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
            if (id === 'anthropic') { addAnthropicToQueue(); }
            else { addCopilotToQueue(); }
            break;
        case 'openQueueEditor': vscode.postMessage({ type: 'openQueueEditor' }); break;
        case 'openTimedRequestsEditor': vscode.postMessage({ type: 'openTimedRequestsEditor' }); break;
        case 'openTrailRawFiles': vscode.postMessage({ type: 'openTrailRawFiles', section: id || '' }); break;
        case 'openTrailSummaryViewer': vscode.postMessage({ type: 'openTrailSummaryViewer', section: id || '' }); break;
        case 'openSessionHistory': vscode.postMessage({ type: 'openSessionHistory', section: id || '' }); break;
        case 'openLiveTrail': vscode.postMessage({ type: 'openLiveTrail', section: id || '' }); break;
        case 'openConversationTrailViewer': vscode.postMessage({ type: 'openConversationTrailViewer' }); break;
        case 'openConversationMarkdown': vscode.postMessage({ type: 'openConversationMarkdown' }); break;
        case 'openConversationCompactTrail': vscode.postMessage({ type: 'openConversationCompactTrail' }); break;
        case 'openConversationTurnFilesEditor': vscode.postMessage({ type: 'openConversationTurnFilesEditor' }); break;
        case 'saveAsTimedRequest': { var trText = document.getElementById('copilot-text'); trText = trText ? trText.value : ''; if (!trText.trim()) {return;} var trTpl = document.getElementById('copilot-template'); trTpl = trTpl ? trTpl.value : ''; vscode.postMessage({ type: 'saveAsTimedRequest', text: trText, template: trTpl }); break; }
        case 'openChatVariablesEditor': vscode.postMessage({ type: 'openChatVariablesEditor' }); break;
        case 'openStatusPage': vscode.postMessage({ type: 'openStatusPage' }); break;
        case 'recreateHistoryFromTrail': vscode.postMessage({ type: 'recreateHistoryFromTrail' }); break;
        case 'recreateMemoryFromTrail': vscode.postMessage({ type: 'recreateMemoryFromTrail' }); break;
        case 'runQuestRefresh': { var qrProfile = document.getElementById(id + '-profile'); qrProfile = qrProfile ? qrProfile.value : ''; var qrLlmConfig = document.getElementById('localLlm-llmConfig'); qrLlmConfig = qrLlmConfig ? qrLlmConfig.value : ''; vscode.postMessage({ type: 'runQuestRefresh', section: id || '', profile: qrProfile, llmConfig: qrLlmConfig }); break; }
        case 'openQuestHistoryInMdBrowser': vscode.postMessage({ type: 'openQuestHistoryInMdBrowser' }); break;
        case 'openQuestMemoryInMdBrowser': vscode.postMessage({ type: 'openQuestMemoryInMdBrowser' }); break;
        case 'openSharedMemoryInMdBrowser': vscode.postMessage({ type: 'openSharedMemoryInMdBrowser' }); break;
        case 'openGlobalTemplateEditor': vscode.postMessage({ type: 'openGlobalTemplateEditor' }); break;
        case 'openReusablePromptEditor': vscode.postMessage({ type: 'openReusablePromptEditor' }); break;
        case 'openContextSettingsEditor': vscode.postMessage({ type: 'openContextSettingsEditor' }); break;
        case 'refreshAnthropicModels': vscode.postMessage({ type: 'refreshAnthropicModels' }); break;
        case 'refreshVsCodeLmModels': vscode.postMessage({ type: 'refreshVsCodeLmModels' }); break;
        case 'clearAnthropicHistory': vscode.postMessage({ type: 'clearAnthropicHistory' }); _anthropicSessionDeny = {}; anthropicSessionTurns = 0; anthropicLastToolCalls = 0; setAnthropicStatus('History cleared'); break;
        case 'openAnthropicMemory': vscode.postMessage({ type: 'openAnthropicMemory' }); break;
        case 'anthropicApprovalApprove': resolveAnthropicApproval(true, false); break;
        case 'anthropicApprovalApproveAll': resolveAnthropicApproval(true, true); break;
        case 'anthropicApprovalDeny': resolveAnthropicApproval(false, false); break;
        case 'anthropicApprovalDenyAll': resolveAnthropicApproval(false, true); break;
    }
}

var _currentAnthropicApprovalId = '';
var _currentAnthropicApprovalTool = '';
var _anthropicSessionDeny = {};
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
    _currentAnthropicApprovalId = toolId;
    _currentAnthropicApprovalTool = toolName;
    var body = document.getElementById('anthropic-approval-body');
    if (body) {
        body.textContent = 'Tool: ' + toolName + '\n\nInput:\n' + (inputSummary || '(no input)');
    }
    var overlay = document.getElementById('anthropic-approval-overlay');
    if (overlay) {overlay.style.display = 'block';}
}

function resolveAnthropicApproval(approved, approveAll) {
    var overlay = document.getElementById('anthropic-approval-overlay');
    if (overlay) {overlay.style.display = 'none';}
    if (!_currentAnthropicApprovalId) {return;}
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
    populateSelect('localLlm-profile', profiles.localLlm);
    populateSelect('conversation-profile', profiles.conversation);
    populateSelect('copilot-template', profiles.copilot);
    populateSelect('tomAiChat-template', profiles.tomAiChat);
    // Use populateEntitySelect for anthropic profiles so the entry marked
    // isDefault is preselected; the label shown is the human-readable name.
    if (anthropicProfileEntries && anthropicProfileEntries.length > 0) {
        populateEntitySelect('anthropic-profile', anthropicProfileEntries, '(Select Profile)');
    } else {
        populateSelect('anthropic-profile', profiles.anthropic);
    }
    populateSelect('anthropic-userMessage', anthropicUserMessageTemplates);
    populateEntitySelect('localLlm-llmConfig', configurations, '(Select LLM Config)');
    populateEntitySelect('conversation-aiSetup', setups, '(Select AI Setup)');
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
    ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'].forEach(function(sectionId) {
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
    btn.disabled = !!anthropicSending;
}

function setAnthropicStatus(text) {
    var el = document.getElementById('anthropic-status');
    if (el) {el.textContent = text || '';}
}

function setLocalLlmStatus(text) {
    var el = document.getElementById('localLlm-status');
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
    if (id === 'copilot-template') {baseOptions += '<option value="__answer_file__">Answer Wrapper</option>';}
    sel.innerHTML = baseOptions + (options || []).map(function(o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
    if (cur && (options && options.includes(cur) || cur === '__answer_file__')) {sel.value = cur;}
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
        profiles = { localLlm: msg.localLlm || [], conversation: msg.conversation || [], copilot: msg.copilot || [], tomAiChat: msg.tomAiChat || [], anthropic: msg.anthropic || [] };
        configurations = msg.configurations || [];
        setups = msg.setups || [];
        anthropicConfigurations = msg.anthropicConfigurations || [];
        anthropicProfileEntries = msg.anthropicProfileEntries || [];
        anthropicUserMessageTemplates = msg.anthropicUserMessageTemplates || [];
        anthropicApiKeyOk = !!msg.anthropicApiKeyOk;
        claudeCliVisible = !!msg.claudeCliVisible;
        claudeCliOk = (msg.claudeCliOk === true || msg.claudeCliOk === false) ? msg.claudeCliOk : null;
        defaultCopilotTemplate = msg.defaultCopilotTemplate || '';
        populateDropdowns();
        updateDefaultTemplateIndicator();
        updateAnthropicApiKeyDot();
        updateClaudeCliDot();
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
    } else if (msg.type === 'anthropicStatus') {
        // Handler-driven status text (e.g. "waiting for history
        // compaction…", "Rebuild history from last N prompts…").
        // Only apply while we're actively sending — after a result
        // we want the result's own status line (tool-call summary /
        // session turn count), not a stale "waiting…" entry.
        if (anthropicSending && typeof msg.text === 'string' && msg.text.length > 0) {
            setAnthropicStatus(msg.text);
        }
    } else if (msg.type === 'localLlmStatus') {
        // Live status line for the Local LLM panel. Mirrors the
        // anthropicStatus channel. Unlike that one we always apply —
        // there is no parallel "result already drew its own line"
        // race because _handleSendLocalLlm only emits this from
        // discrete phase changes (start / tool round / done / error).
        if (typeof msg.text === 'string') {
            setLocalLlmStatus(msg.text);
        }
    } else if (msg.type === 'anthropicResult') {
        anthropicSending = false;
        updateAnthropicSendButton();
        anthropicSessionTurns += 1;
        anthropicLastToolCalls = msg.toolCallCount || 0;
        setAnthropicStatus(buildAnthropicStatusLine(msg.historyMode || ''));
    } else if (msg.type === 'anthropicError') {
        anthropicSending = false;
        updateAnthropicSendButton();
        setAnthropicStatus('Error: ' + (msg.message || 'unknown'));
    } else if (msg.type === 'anthropicToolApproval') {
        showAnthropicApprovalDialog(msg.toolId || '', msg.toolName || '', msg.inputSummary || '');
    } else if (msg.type === 'reusablePrompts') {
        reusablePromptModel = msg.model || { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
        reusablePreferredQuestId = msg.preferredQuestId || '';
        reusablePreferredProjectId = msg.preferredProjectId || '';
        reusablePreferredScanId = msg.preferredScanId || '';
        ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'].forEach(function(sectionId) {
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
        ['localLlm', 'conversation', 'copilot', 'tomAiChat'].forEach(function(s) {
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
            var profileId = s === 'copilot' || s === 'tomAiChat' ? s + '-template' : s + '-profile';
            var sel = document.getElementById(profileId);
            if (sel && d.profile) {sel.value = d.profile;}
            if (s === 'localLlm') {
                var llmSel = document.getElementById('localLlm-llmConfig');
                if (llmSel && d.llmConfig) {
                    llmSel.value = d.llmConfig;
                }
            }
            if (s === 'conversation') {
                var aiSel = document.getElementById('conversation-aiSetup');
                if (aiSel && d.aiSetup) {
                    aiSel.value = d.aiSetup;
                }
            }
            updateSlotButtonsUI(s);
        });
        // Restore Anthropic-specific state
        var da = secs['anthropic'];
        if (da) {
            var anthrSectionState = ensureSlotState('anthropic');
            if (da.slots && typeof da.slots === 'object') { anthrSectionState.slots = da.slots; }
            if (da.activeSlot && da.activeSlot >= 1 && da.activeSlot <= 9) { anthrSectionState.activeSlot = da.activeSlot; }
            var anthrTa = document.getElementById('anthropic-text');
            if (anthrTa) { anthrTa.value = getSlotText('anthropic', anthrSectionState.activeSlot) || da.text || ''; }
            var anthrProfile = document.getElementById('anthropic-profile');
            if (anthrProfile && da.profile) { anthrProfile.value = da.profile; }
            // (Model + Config dropdowns removed — nothing to restore.)
            var anthrUserMsg = document.getElementById('anthropic-userMessage');
            if (anthrUserMsg && da.userMessageTemplate) { anthrUserMsg.value = da.userMessageTemplate; }
            updateSlotButtonsUI('anthropic');
        }
        refreshCopilotAnswerToolbarVisibility();
        _draftsLoaded = true;
    }
});

function updateDefaultTemplateIndicator() {
    var tplInfo = document.getElementById('copilot-templateInfo');
    if (tplInfo && defaultCopilotTemplate) {
        tplInfo.textContent = 'Default template: ' + defaultCopilotTemplate;
        tplInfo.style.display = 'block';
    } else if (tplInfo) {
        tplInfo.style.display = 'none';
    }
}

function sendCopilotPrompt() {
    var text = document.getElementById('copilot-text');
    text = text ? text.value : '';
    if (!text.trim()) {return;}
    var template = document.getElementById('copilot-template');
    template = template ? template.value : '';
    var slot = ensureSlotState('copilot').activeSlot;
    vscode.postMessage({ type: 'sendCopilot', text: text, template: template, slot: slot });
}

function addCopilotToQueue() {
    var text = document.getElementById('copilot-text');
    text = text ? text.value : '';
    if (!text.trim()) {return;}
    var template = document.getElementById('copilot-template');
    template = template ? template.value : '';
    var repeatEl = document.getElementById('copilot-repeat-count');
    var repeatCount = Math.max(1, parseInt(String((repeatEl ? repeatEl.value : '1') || '1'), 10) || 1);
    var waitEl = document.getElementById('copilot-answer-wait');
    var answerWaitMinutes = Math.max(0, parseInt(String(waitEl ? waitEl.value : '0'), 10) || 0);
    var slot = ensureSlotState('copilot').activeSlot;
    vscode.postMessage({ type: 'addToQueue', text: text, template: template, repeatCount: repeatCount, answerWaitMinutes: answerWaitMinutes, slot: slot });
    // Reset the repeat count to 1 so the next simple prompt isn't accidentally
    // queued again with a leftover (high) repeat count.
    if (repeatEl) { repeatEl.value = '1'; }
}

function addAnthropicToQueue() {
    // Spec §4.11 — stage a queue item with transport='anthropic' and
    // pin the active profile + user-message template from this panel's
    // own dropdowns (never inherit from the queue default).
    var text = document.getElementById('anthropic-text');
    text = text ? text.value : '';
    if (!text.trim()) {return;}
    var profileEl = document.getElementById('anthropic-profile');
    var profileId = profileEl ? profileEl.value : '';
    var templateEl = document.getElementById('anthropic-userMessage');
    var templateName = templateEl ? templateEl.value : '';
    var repeatEl = document.getElementById('anthropic-repeat-count');
    var repeatVal = repeatEl ? repeatEl.value : '1';
    var repeatCount = Math.max(1, parseInt(String(repeatVal || '1'), 10) || 1);
    vscode.postMessage({
        type: 'addToQueue',
        text: text,
        template: templateName,
        repeatCount: repeatCount,
        transport: 'anthropic',
        anthropicProfileId: profileId,
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
    ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'].forEach(function(sectionId) {
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
        ['localLlm', 'conversation', 'copilot', 'tomAiChat'].forEach(function(s) {
            var ta = document.getElementById(s + '-text');
            var profileId = s === 'copilot' || s === 'tomAiChat' ? s + '-template' : s + '-profile';
            var sel = document.getElementById(profileId);
            var sectionState = ensureSlotState(s);
            var llmSel = document.getElementById('localLlm-llmConfig');
            var aiSel = document.getElementById('conversation-aiSetup');
            if (ta) {
                setSlotText(s, sectionState.activeSlot, ta.value || '');
            }
            drafts[s] = {
                text: ta ? ta.value : '',
                profile: sel ? sel.value : '',
                llmConfig: s === 'localLlm' && llmSel ? llmSel.value : '',
                aiSetup: s === 'conversation' && aiSel ? aiSel.value : '',
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
        };
        vscode.postMessage({ type: 'saveDrafts', drafts: drafts });
    }, 1000);
}
// Attach save to all textareas and dropdowns
['localLlm-text', 'conversation-text', 'copilot-text', 'tomAiChat-text', 'anthropic-text'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('input', saveDrafts);}
});
['localLlm-profile', 'conversation-profile', 'copilot-template', 'tomAiChat-template', 'anthropic-profile'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('change', saveDrafts);}
});
['localLlm-llmConfig', 'conversation-aiSetup', 'anthropic-userMessage'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {el.addEventListener('change', saveDrafts);}
});
