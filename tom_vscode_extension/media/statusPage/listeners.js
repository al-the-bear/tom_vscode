// @ts-nocheck
// Status Panel shared listeners — verbatim extraction of the JS string formerly
// returned by getStatusPanelListenersScript() in src/handlers/statusPage-handler.ts
// (Phase B.11 webview restructuring). Defines attachStatusPanelListeners() and the
// per-section sub-editors (schedule / executables / commandlines / favorites /
// llmConfigs / aiSetups). Consumed by BOTH the standalone status page
// (media/statusPage/index.html) and the @WS accordion panel (wsPanel-handler.ts via
// getStatusPanelListenersScript() -> readMediaText). Depends on an ambient global
// 'vscode' provided by the host, and on window.__statusAvailableLlmTools (set by the
// host before this script runs). @ts-nocheck: legacy verbatim extraction.
/* global vscode */
function attachStatusPanelListeners(skipEditorInit) {
    var panel = document.getElementById('settings-status-panel') || document.querySelector('.sp-panel');
    if (!panel) return;
    
    panel.querySelectorAll('.sp-collapsible').forEach(function(el) {
        if (el.dataset.spCollapseBound === '1') return;
        el.dataset.spCollapseBound = '1';
        el.addEventListener('click', function() {
            var sectionId = el.getAttribute('data-collapse');
            var content = document.getElementById('sp-' + sectionId + '-content');
            var icon = el.querySelector('.sp-collapse-icon');
            if (content) {
                content.classList.toggle('sp-collapsed');
                if (icon) icon.textContent = content.classList.contains('sp-collapsed') ? '▶' : '▼';
            }
        });
    });
    
    panel.querySelectorAll('[data-status-action]').forEach(function(el) {
        if (el.dataset.spActionBound === '1') return;
        el.dataset.spActionBound = '1';
        el.addEventListener('click', function() {
            var action = el.getAttribute('data-status-action');
            var msgData = { type: 'statusAction', action: action };
            
            if (action === 'updateTrailSettings') {
                msgData.maxRawFiles = parseInt((document.getElementById('sp-trailMaxRawFiles') || {}).value || '1000');
                msgData.maxEntries = parseInt((document.getElementById('sp-trailMaxEntries') || {}).value || '1000');
            } else if (action === 'saveReloadPromptAfterReload') {
                msgData.enabled = !!((document.getElementById('sp-reloadPromptEnabled') || {}).checked);
                msgData.prompt = ((document.getElementById('sp-reloadPromptText') || {}).value || '').toString();
            } else if (action === 'updateLocalLlm') {
                msgData.settings = {
                    ollamaUrl: (document.getElementById('sp-llm-ollamaUrl') || {}).value || '',
                    model: (document.getElementById('sp-llm-model') || {}).value || '',
                    temperature: parseFloat((document.getElementById('sp-llm-temperature') || {}).value || '0.4'),
                    stripThinkingTags: (document.getElementById('sp-llm-stripThinkingTags') || {}).value === 'true',
                    expansionProfile: (document.getElementById('sp-llm-expansionProfile') || {}).value || '',
                    toolsEnabled: (document.getElementById('sp-llm-toolsEnabled') || {}).value === 'true',
                    trailMaximumTokens: parseInt((document.getElementById('sp-llm-trailMaximumTokens') || {}).value || '8000'),
                    trailSummarizationTemperature: parseFloat((document.getElementById('sp-llm-trailSummarizationTemperature') || {}).value || '0.3'),
                    removePromptTemplateFromTrail: (document.getElementById('sp-llm-removePromptTemplateFromTrail') || {}).value === 'true'
                };
            } else if (action === 'updateAiConversation') {
                msgData.settings = {
                    maxTurns: parseInt((document.getElementById('sp-conv-maxTurns') || {}).value || '10'),
                    temperature: parseFloat((document.getElementById('sp-conv-temperature') || {}).value || '0.5'),
                    historyMode: (document.getElementById('sp-conv-historyMode') || {}).value || 'trim_and_summary',
                    conversationMode: (document.getElementById('sp-conv-conversationMode') || {}).value || 'ollama-copilot',
                    trailMaximumTokens: parseInt((document.getElementById('sp-conv-trailMaximumTokens') || {}).value || '8000'),
                    trailSummarizationTemperature: parseFloat((document.getElementById('sp-conv-trailSummarizationTemperature') || {}).value || '0.3'),
                    removePromptTemplateFromTrail: (document.getElementById('sp-conv-removePromptTemplateFromTrail') || {}).value === 'true'
                };
            } else if (action === 'updateTelegram') {
                msgData.settings = {
                    enabled: (document.getElementById('sp-tg-enabled') || {}).value === 'true',
                    botTokenEnv: (document.getElementById('sp-tg-botTokenEnv') || {}).value || '',
                    defaultChatId: parseInt((document.getElementById('sp-tg-defaultChatId') || {}).value || '0'),
                    pollIntervalMs: parseInt((document.getElementById('sp-tg-pollIntervalMs') || {}).value || '3000'),
                    notifyOnStart: (document.getElementById('sp-tg-notifyOnStart') || {}).value === 'true',
                    notifyOnTurn: (document.getElementById('sp-tg-notifyOnTurn') || {}).value === 'true',
                    notifyOnEnd: (document.getElementById('sp-tg-notifyOnEnd') || {}).value === 'true'
                };
            } else if (action === 'updateAskCopilot') {
                msgData.settings = {
                    enabled: (document.getElementById('sp-ac-enabled') || {}).value === 'true',
                    answerFileTimeout: parseInt((document.getElementById('sp-ac-answerFileTimeout') || {}).value || '120000'),
                    pollInterval: parseInt((document.getElementById('sp-ac-pollInterval') || {}).value || '2000'),
                    answerFolder: (document.getElementById('sp-ac-answerFolder') || {}).value || '',
                    copilotAnswerFolder: (document.getElementById('sp-ac-copilotAnswerFolder') || {}).value || '',
                    promptTemplate: (document.getElementById('sp-ac-promptTemplate') || {}).value || ''
                };
            } else if (action === 'updateAskBigBrother') {
                msgData.settings = {
                    enabled: (document.getElementById('sp-abb-enabled') || {}).value === 'true',
                    defaultModel: (document.getElementById('sp-abb-defaultModel') || {}).value || 'GPT-5.2',
                    temperature: parseFloat((document.getElementById('sp-abb-temperature') || {}).value || '0.7'),
                    maxIterations: parseInt((document.getElementById('sp-abb-maxIterations') || {}).value || '5'),
                    enableToolsByDefault: (document.getElementById('sp-abb-enableToolsByDefault') || {}).value === 'true',
                    summarizationEnabled: (document.getElementById('sp-abb-summarizationEnabled') || {}).value === 'true',
                    summarizationModel: (document.getElementById('sp-abb-summarizationModel') || {}).value || 'gpt-4o',
                    maxResponseChars: parseInt((document.getElementById('sp-abb-maxResponseChars') || {}).value || '20000'),
                    promptTemplate: (document.getElementById('sp-abb-promptTemplate') || {}).value || ''
                };
            } else if (action === 'saveSchedule') {
                msgData.schedule = collectAllScheduleData();
            } else if (action === 'saveExecutables') {
                msgData.executables = collectExecutablesData();
                msgData.binaryPath = collectBinaryPathData();
            } else if (action === 'saveCommandlines') {
                msgData.commandlines = collectCommandlinesData();
            } else if (action === 'saveFavorites') {
                msgData.favorites = collectFavoritesData();
            } else if (action === 'saveLlmProfiles') {
                msgData.profiles = collectLlmProfilesData();
            } else if (action === 'saveConvProfiles') {
                msgData.profiles = collectConvProfilesData();
            } else if (action === 'editModelConfig' || action === 'deleteModelConfig') {
                msgData.modelKey = el.getAttribute('data-model-key');
            } else if (action === 'deleteLlmConfiguration') {
                msgData.configId = el.getAttribute('data-config-id');
            } else if (action === 'editAnthropicConfiguration' || action === 'deleteAnthropicConfiguration') {
                msgData.configId = el.getAttribute('data-config-id');
            } else if (action === 'updateAnthropicApiKeyEnvVar') {
                msgData.value = (document.getElementById('sp-anthropic-apiKeyEnvVar') || {}).value || 'ANTHROPIC_API_KEY';
            } else if (action === 'deleteAiConversationSetup') {
                msgData.setupId = el.getAttribute('data-setup-id');
            } else if (action === 'updateCompactionSettings' || action === 'runCompactionDryRun') {
                msgData.settings = {
                    disabled: (document.getElementById('sp-comp-disabled') || {}).checked === true,
                    llmProvider: (document.getElementById('sp-comp-llmProvider') || {}).value || 'localLlm',
                    llmConfigId: (document.getElementById('sp-comp-llmConfigId') || {}).value || '',
                    compactionTemplateId: (document.getElementById('sp-comp-compactionTemplateId') || {}).value || '',
                    memoryExtractionTemplateId: (document.getElementById('sp-comp-memoryExtractionTemplateId') || {}).value || '',
                    compactionMaxRounds: parseInt((document.getElementById('sp-comp-maxRounds') || {}).value || '4'),
                    maxHistoryTokens: parseInt((document.getElementById('sp-comp-maxHistoryTokens') || {}).value || '8000'),
                    historyMaxChars: parseInt((document.getElementById('sp-comp-historyMaxChars') || {}).value || '24000'),
                    memoryMaxChars: parseInt((document.getElementById('sp-comp-memoryMaxChars') || {}).value || '8000'),
                    fullTrailMaxTurns: parseInt((document.getElementById('sp-comp-fullTrailMaxTurns') || {}).value || '200'),
                    runMemoryExtractionOnCompaction: (document.getElementById('sp-comp-runMemoryExtractionOnCompaction') || {}).value !== 'false',
                    rebuildFromLastNPrompts: parseInt((document.getElementById('sp-comp-rebuildFromLastNPrompts') || {}).value || '200'),
                    archiveHistoryEveryTurn: (document.getElementById('sp-comp-archiveHistoryEveryTurn') || {}).value === 'true',
                    memoryToolsEnabled: (document.getElementById('sp-mem-memoryToolsEnabled') || {}).value === 'true',
                    memoryMaxInjectedTokens: parseInt((document.getElementById('sp-mem-maxInjectedTokens') || {}).value || '3000'),
                    memoryAutoExtractMode: (document.getElementById('sp-mem-autoExtractMode') || {}).value || '',
                    toolTrailMaxResultChars: parseInt((document.getElementById('sp-comp-toolTrailMaxResultChars') || {}).value || '1000'),
                    toolTrailKeepRounds: parseInt((document.getElementById('sp-comp-toolTrailKeepRounds') || {}).value || '2'),
                    rawTurnsKept: parseInt((document.getElementById('sp-comp-rawTurnsKept') || {}).value || '4'),
                    runEveryNRounds: parseInt((document.getElementById('sp-comp-runEveryNRounds') || {}).value || '15'),
                    trailMaxRawFiles: parseInt((document.getElementById('sp-comp-trailMaxRawFiles') || {}).value || '1000'),
                    backgroundExtractionEnabled: (document.getElementById('sp-comp-backgroundExtractionEnabled') || {}).value === 'true'
                };
            } else if (action === 'editCompactionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-compactionTemplateId') || {}).value || '';
            } else if (action === 'deleteCompactionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-compactionTemplateId') || {}).value || '';
            } else if (action === 'editMemoryExtractionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-memoryExtractionTemplateId') || {}).value || '';
            } else if (action === 'deleteMemoryExtractionTemplate') {
                msgData.itemId = (document.getElementById('sp-comp-memoryExtractionTemplateId') || {}).value || '';
            } else if (action === 'updateTransportRetrySettings') {
                msgData.settings = {
                    maxAttempts: parseInt((document.getElementById('sp-retry-maxAttempts') || {}).value || '3'),
                    templateId: (document.getElementById('sp-retry-templateId') || {}).value || ''
                };
            } else if (action === 'editTransportRetryTemplate' || action === 'deleteTransportRetryTemplate') {
                msgData.itemId = (document.getElementById('sp-retry-templateId') || {}).value || '';
            } else if (action === 'saveMcpServer') {
                // Explicit per-field gather for the standalone MCP server card
                // (per the localLlm lesson — read each named control, never a
                // generic dump). Raw values are sent; the server-side gather map
                // (buildMcpServerConfigFromMessage) does the coercion/defaults.
                var mcpCard = panel.querySelector('[data-mcp-card]');
                var mcpField = function(name) {
                    return mcpCard ? mcpCard.querySelector('[data-mcp-field="' + name + '"]') : null;
                };
                var mcpValue = function(name) { var el = mcpField(name); return el ? el.value : ''; };
                var mcpChecked = function(name) { var el = mcpField(name); return !!(el && el.checked); };
                // Tri-state mode: 'all' | 'readonly' | 'custom'. 'all' exposes
                // every tool; 'readonly' is the read-only floor (collected from
                // the data-readonly flags so it is robust even if the preset
                // change-handler never ran); 'custom' is the checked subset.
                var mcpMode = mcpValue('toolsEnabled') || 'all';
                var mcpEnabledTools = [];
                if (mcpCard) {
                    var mcpToolSel = mcpMode === 'readonly'
                        ? '[data-mcp-tool][data-readonly="true"]'
                        : '[data-mcp-tool]:checked';
                    mcpCard.querySelectorAll(mcpToolSel).forEach(function(cb) {
                        mcpEnabledTools.push(cb.getAttribute('data-mcp-tool'));
                    });
                }
                msgData.enabled = mcpChecked('enabled');
                msgData.autoStart = mcpChecked('autoStart');
                msgData.host = mcpValue('host');
                msgData.basePort = mcpValue('basePort');
                msgData.apiKeyEnv = mcpValue('apiKeyEnv');
                msgData.allowWriteWithoutAuth = mcpChecked('allowWriteWithoutAuth');
                msgData.toolsEnabled = mcpMode === 'all';
                msgData.enabledTools = mcpEnabledTools;
            } else if (action === 'updateQuestRefresh') {
                // Per-panel global interval + prompt text. The per-quest "active"
                // checkbox posts its own setQuestRefreshActive on change, so it is
                // not gathered here.
                var qrPanel = function(panel) {
                    return {
                        promptInterval: parseInt((document.getElementById('sp-qr-' + panel + '-interval') || {}).value || '0'),
                        refreshPrompt: ((document.getElementById('sp-qr-' + panel + '-prompt') || {}).value || '').toString()
                    };
                };
                msgData.settings = {
                    anthropic: qrPanel('anthropic'),
                    localLlm: qrPanel('localLlm'),
                    copilot: qrPanel('copilot')
                };
            }

            vscode.postMessage(msgData);
        });
    });
    
    panel.querySelectorAll('[data-status-select]').forEach(function(el) {
        if (el.dataset.spSelectBound === '1') return;
        el.dataset.spSelectBound = '1';
        el.addEventListener('change', function() {
            var action = el.getAttribute('data-status-select');
            vscode.postMessage({ type: 'statusAction', action: action, value: el.value });
        });
    });

    // MCP Server card — grouped tool picker interactivity (mirrors the Anthropic
    // profile editor): per-group all/none buttons, global Select All/None/Read-Only
    // bulk buttons, and the "All Tools" dropdown driving the checkboxes. Delegated
    // off the card so it survives re-renders; bound once via a data flag.
    var mcpCardEl = panel.querySelector('[data-mcp-card]');
    if (mcpCardEl && mcpCardEl.dataset.spMcpToolsBound !== '1') {
        mcpCardEl.dataset.spMcpToolsBound = '1';
        var mcpToolBoxes = function() { return mcpCardEl.querySelectorAll('[data-mcp-tool]'); };
        var mcpGroupBoxes = function(group) {
            var wrap = mcpCardEl.querySelector('[data-mcp-group="' + (window.CSS && CSS.escape ? CSS.escape(group) : group) + '"]');
            return wrap ? wrap.querySelectorAll('[data-mcp-tool]') : [];
        };
        var mcpSetAll = function(on) { mcpToolBoxes().forEach(function(cb) { cb.checked = !!on; }); };
        var mcpSetReadOnly = function() {
            mcpToolBoxes().forEach(function(cb) { cb.checked = cb.getAttribute('data-readonly') === 'true'; });
        };
        mcpCardEl.addEventListener('click', function(ev) {
            var t = ev.target;
            if (!t || !t.getAttribute) return;
            if (t.hasAttribute('data-mcp-group-all')) {
                mcpGroupBoxes(t.getAttribute('data-mcp-group-all')).forEach(function(cb) { cb.checked = true; });
            } else if (t.hasAttribute('data-mcp-group-none')) {
                mcpGroupBoxes(t.getAttribute('data-mcp-group-none')).forEach(function(cb) { cb.checked = false; });
            } else if (t.hasAttribute('data-mcp-tools-all')) {
                mcpSetAll(true);
            } else if (t.hasAttribute('data-mcp-tools-none')) {
                mcpSetAll(false);
            } else if (t.hasAttribute('data-mcp-tools-readonly')) {
                mcpSetReadOnly();
            }
        });
        var mcpModeSel = mcpCardEl.querySelector('[data-mcp-field="toolsEnabled"]');
        if (mcpModeSel) {
            mcpModeSel.addEventListener('change', function() {
                // The dropdown is a preset: reflect the chosen mode in the
                // checkboxes so the user sees what will be saved.
                if (mcpModeSel.value === 'all') { mcpSetAll(true); }
                else if (mcpModeSel.value === 'readonly') { mcpSetReadOnly(); }
                // 'custom' leaves the current selection untouched.
            });
        }
    }

    var compProviderSel = document.getElementById('sp-comp-llmProvider');
    var compConfigSel = document.getElementById('sp-comp-llmConfigId');
    if (compProviderSel && compConfigSel && !compProviderSel.dataset.spProviderBound) {
        compProviderSel.dataset.spProviderBound = '1';
        var filterCompConfig = function() {
            var p = compProviderSel.value || 'localLlm';
            var firstVisibleValue = '';
            Array.prototype.forEach.call(compConfigSel.options, function(opt) {
                var dp = opt.getAttribute('data-provider') || '';
                var visible = (dp === '' || dp === p);
                opt.hidden = !visible;
                opt.disabled = !visible;
                if (visible && !firstVisibleValue && opt.value) firstVisibleValue = opt.value;
            });
            var current = compConfigSel.selectedOptions[0];
            if (!current || current.disabled) {
                compConfigSel.value = firstVisibleValue;
            }
            var toolSetBtn = document.querySelector('[data-status-action="editCompactionToolSet"]');
            if (toolSetBtn) {
                if (p === 'anthropic') {
                    toolSetBtn.setAttribute('disabled', 'disabled');
                    toolSetBtn.title = "Anthropic uses the active profile's enabledTools";
                } else {
                    toolSetBtn.removeAttribute('disabled');
                    toolSetBtn.title = '';
                }
            }
        };
        compProviderSel.addEventListener('change', filterCompConfig);
        filterCompConfig();
    }

    if (skipEditorInit) {
        return;
    }

    // Initialize schedule and executables editors
    initScheduleEditor();
    initExecutablesEditor();
    initBinaryPathEditor();
    initCommandlinesEditor();
    initFavoritesEditor();
    initLlmConfigsEditor();
    initAiSetupsEditor();
}

// =========== Schedule Editor JS ===========
var __scheduleSlots = [];
var __weekdayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
var __monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var __newSlotOpen = false;

function initScheduleEditor() {
    var el = document.getElementById('sp-schedule-init');
    if (!el) return;
    try { __scheduleSlots = JSON.parse(el.value || '[]'); } catch(e) { __scheduleSlots = []; }
    renderScheduleSlots();
}

function slotSummary(slot) {
    var parts = [];
    if (slot.dayType === 'weekday') {
        var days = (slot.weekdays||[]).map(function(i){return __weekdayNames[i];}).join(',');
        parts.push(days || 'No days');
    } else if (slot.dayType === 'first-weekday') {
        parts.push('1st ' + __weekdayNames[slot.monthWeekday||0]);
    } else if (slot.dayType === 'last-weekday') {
        parts.push('Last ' + __weekdayNames[slot.monthWeekday||0]);
    } else if (slot.dayType === 'day-of-month') {
        parts.push('Day ' + (slot.dayOfMonth||1));
    }
    if (slot.timeFrom || slot.timeTo) parts.push((slot.timeFrom||'??') + '—' + (slot.timeTo||'??'));
    return parts.join(' ') || '(empty)';
}

function renderScheduleSlots() {
    var c = document.getElementById('sp-schedule-slots');
    if (!c) return;
    c.innerHTML = '';
    __scheduleSlots.forEach(function(slot, idx) {
        var div = document.createElement('div');
        div.className = 'sp-schedule-slot';
        div.setAttribute('data-idx', idx);
        div.innerHTML =
            '<div class="sp-slot-header" onclick="toggleSlotBody(' + idx + ')">' +
            '<span style="font-size:11px;font-weight:600"><span class="sp-slot-icon" id="sp-slot-icon-' + idx + '">▶</span> ' + slotSummary(slot) + '</span>' +
            '<button class="sp-btn" onclick="event.stopPropagation();removeScheduleSlot(' + idx + ')" title="Remove">✕</button></div>' +
            '<div class="sp-slot-body sp-slot-collapsed" id="sp-slot-body-' + idx + '">' + buildSlotHtml(slot, idx) +
            '<div class="sp-settings-row"><button class="sp-btn primary" onclick="saveScheduleSlot(' + idx + ')">Save</button></div>' +
            '</div>';
        c.appendChild(div);
    });
}

function toggleSlotBody(idx) {
    var body = document.getElementById('sp-slot-body-' + idx);
    var icon = document.getElementById('sp-slot-icon-' + idx);
    if (!body) return;
    body.classList.toggle('sp-slot-collapsed');
    if (icon) icon.textContent = body.classList.contains('sp-slot-collapsed') ? '▶' : '▼';
}

function buildSlotHtml(slot, idx) {
    var html = '<div class="sp-settings-row">' +
        '<label>Type:</label><select class="sp-sched-daytype" onchange="onSchedDayTypeChange(' + idx + ',this.value)">' +
        '<option value="weekday"' + (slot.dayType==='weekday'?' selected':'') + '>Weekdays</option>' +
        '<option value="first-weekday"' + (slot.dayType==='first-weekday'?' selected':'') + '>First weekday/month</option>' +
        '<option value="last-weekday"' + (slot.dayType==='last-weekday'?' selected':'') + '>Last weekday/month</option>' +
        '<option value="day-of-month"' + (slot.dayType==='day-of-month'?' selected':'') + '>Day of month</option>' +
        '</select></div>';

    if (slot.dayType === 'weekday') {
        html += '<div class="sp-sched-inline-row sp-sched-weekdays">';
        __weekdayNames.forEach(function(n,i) {
            var ck = (slot.weekdays||[]).indexOf(i) >= 0 ? ' checked' : '';
            html += '<label class="sp-sched-cb"><input type="checkbox" value="' + i + '"' + ck + '>' + n + '</label>';
        });
        html += '</div>';
    } else if (slot.dayType === 'first-weekday' || slot.dayType === 'last-weekday') {
        html += '<div class="sp-settings-row"><label>Weekday:</label><select class="sp-sched-monthwd">';
        __weekdayNames.forEach(function(n,i) {
            html += '<option value="' + i + '"' + (slot.monthWeekday===i?' selected':'') + '>' + n + '</option>';
        });
        html += '</select></div><div class="sp-sched-inline-row"><label style="color:var(--vscode-descriptionForeground)">Months:</label>';
        for (var m=1;m<=12;m++) {
            var ck = (slot.months||[]).indexOf(m) >= 0 ? ' checked' : '';
            html += '<label class="sp-sched-cb"><input type="checkbox" class="sp-sched-month" value="' + m + '"' + ck + '>' + __monthNames[m-1] + '</label>';
        }
        html += '</div>';
    } else if (slot.dayType === 'day-of-month') {
        html += '<div class="sp-settings-row"><label>Day:</label><input type="number" class="sp-sched-dom" min="1" max="31" value="' + (slot.dayOfMonth||1) + '"></div>';
        html += '<div class="sp-sched-inline-row"><label style="color:var(--vscode-descriptionForeground)">Months:</label>';
        for (var m=1;m<=12;m++) {
            var ck = (slot.months||[]).indexOf(m) >= 0 ? ' checked' : '';
            html += '<label class="sp-sched-cb"><input type="checkbox" class="sp-sched-month" value="' + m + '"' + ck + '>' + __monthNames[m-1] + '</label>';
        }
        html += '</div>';
    }

    html += '<div class="sp-settings-row"><label>Time:</label>' +
        '<input type="text" class="sp-sched-from" placeholder="HH:MM" value="' + (slot.timeFrom||'') + '" style="width:55px">' +
        '<span>—</span>' +
        '<input type="text" class="sp-sched-to" placeholder="HH:MM" value="' + (slot.timeTo||'') + '" style="width:55px"></div>';
    return html;
}

function addScheduleSlot() {
    __scheduleSlots.push({ id: Date.now().toString(), dayType: 'weekday', weekdays: [0,1,2,3,4,5,6] });
    renderScheduleSlots();
    // Auto-open the newly added slot
    var lastIdx = __scheduleSlots.length - 1;
    toggleSlotBody(lastIdx);
}

function removeScheduleSlot(idx) {
    collectScheduleSlotData(idx);
    __scheduleSlots.splice(idx, 1);
    // Auto-save after removal
    vscode.postMessage({ type: 'statusAction', action: 'saveSchedule', schedule: __scheduleSlots });
    renderScheduleSlots();
}

function parseTimeStr(t) {
    if (!t || typeof t !== 'string') return null;
    var parts = t.split(':');
    if (parts.length !== 2) return null;
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    if (h < 0) h = 0; if (h > 24) h = 24;
    if (m < 0) m = 0; if (m > 59) m = 59;
    if (h === 24) m = 0;
    return { h: h, m: m };
}

function formatTime(t) {
    return (t.h < 10 ? '0' : '') + t.h + ':' + (t.m < 10 ? '0' : '') + t.m;
}

function timeToMinutes(t) { return t.h * 60 + t.m; }

function saveScheduleSlot(idx) {
    collectScheduleSlotData(idx);
    // Validate and normalise time fields
    var slot = __scheduleSlots[idx];
    var fromParsed = parseTimeStr(slot.timeFrom);
    var toParsed = parseTimeStr(slot.timeTo);
    if (fromParsed) slot.timeFrom = formatTime(fromParsed);
    if (toParsed) slot.timeTo = formatTime(toParsed);
    // Swap if end < start
    if (fromParsed && toParsed && timeToMinutes(toParsed) < timeToMinutes(fromParsed)) {
        var tmp = slot.timeFrom; slot.timeFrom = slot.timeTo; slot.timeTo = tmp;
    }
    // Save the entire schedule
    vscode.postMessage({ type: 'statusAction', action: 'saveSchedule', schedule: __scheduleSlots });
    // Collapse only this slot (not the whole section), then re-render
    renderScheduleSlots();
    // Ensure the Timer Schedule section stays open after re-render
    var tsContent = document.getElementById('sp-timerSchedule-content');
    var tsIcon = tsContent ? (tsContent.previousElementSibling ? tsContent.previousElementSibling.querySelector('.sp-collapse-icon') : null) : null;
    if (tsContent) { tsContent.classList.remove('sp-collapsed'); if (tsIcon) tsIcon.textContent = '▼'; }
}

function onSchedDayTypeChange(idx, newType) {
    collectScheduleSlotData(idx);
    __scheduleSlots[idx].dayType = newType;
    delete __scheduleSlots[idx].weekdays;
    delete __scheduleSlots[idx].monthWeekday;
    delete __scheduleSlots[idx].months;
    delete __scheduleSlots[idx].dayOfMonth;
    if (newType === 'weekday') __scheduleSlots[idx].weekdays = [0,1,2,3,4,5,6];
    if (newType === 'first-weekday' || newType === 'last-weekday' || newType === 'day-of-month') __scheduleSlots[idx].months = [1,2,3,4,5,6,7,8,9,10,11,12];
    renderScheduleSlots();
    // Keep the changed slot open after re-render
    toggleSlotBody(idx);
}

function collectScheduleSlotData(idx) {
    var c = document.getElementById('sp-schedule-slots');
    if (!c) return;
    var slotDiv = c.querySelectorAll('.sp-schedule-slot')[idx];
    if (!slotDiv) return;
    var slot = __scheduleSlots[idx];
    slot.dayType = slotDiv.querySelector('.sp-sched-daytype').value;
    if (slot.dayType === 'weekday') {
        slot.weekdays = [];
        slotDiv.querySelectorAll('.sp-sched-weekdays input:checked').forEach(function(cb) { slot.weekdays.push(parseInt(cb.value)); });
    } else if (slot.dayType === 'first-weekday' || slot.dayType === 'last-weekday') {
        var sel = slotDiv.querySelector('.sp-sched-monthwd');
        if (sel) slot.monthWeekday = parseInt(sel.value);
        slot.months = [];
        slotDiv.querySelectorAll('.sp-sched-month:checked').forEach(function(cb) { slot.months.push(parseInt(cb.value)); });
    } else if (slot.dayType === 'day-of-month') {
        var dom = slotDiv.querySelector('.sp-sched-dom');
        if (dom) slot.dayOfMonth = parseInt(dom.value);
        slot.months = [];
        slotDiv.querySelectorAll('.sp-sched-month:checked').forEach(function(cb) { slot.months.push(parseInt(cb.value)); });
    }
    slot.timeFrom = (slotDiv.querySelector('.sp-sched-from')||{}).value || '';
    slot.timeTo = (slotDiv.querySelector('.sp-sched-to')||{}).value || '';
}

function collectAllScheduleData() {
    var c = document.getElementById('sp-schedule-slots');
    if (!c) return __scheduleSlots;
    c.querySelectorAll('.sp-schedule-slot').forEach(function(_, idx) { collectScheduleSlotData(idx); });
    return __scheduleSlots;
}

// =========== Executables Editor JS ===========
var __executables = {};
var __defaultPlatforms = ['darwin-arm64','darwin-x64','linux-x64','linux-arm64','windows-x64','darwin-*','linux-*','windows-*','*'];

function initExecutablesEditor() {
    var el = document.getElementById('sp-executables-init');
    if (!el) return;
    try { __executables = JSON.parse(el.value || '{}'); } catch(e) { __executables = {}; }
    renderExecutables();
}

function renderExecutables() {
    var c = document.getElementById('sp-executables-list');
    if (!c) return;
    c.innerHTML = '';
    var names = Object.keys(__executables);
    if (names.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>No executables configured</em></div>';
        return;
    }
    names.forEach(function(name) {
        var cfg = __executables[name];
        var div = document.createElement('div');
        div.className = 'sp-exec-entry';
        var html = '<div class="sp-settings-row"><strong>' + name + '</strong>' +
            '<button class="sp-btn" onclick="removeExecutable(\'' + name + '\')" title="Remove executable">✕</button></div>';
        Object.keys(cfg).forEach(function(plat) {
            html += '<div class="sp-settings-row"><label style="min-width:90px">' + plat + ':</label>' +
                '<input type="text" class="sp-exec-path" data-name="' + name + '" data-platform="' + plat + '" value="' + (cfg[plat]||'') + '" style="flex:1;min-width:120px;max-width:none">' +
                '<button class="sp-btn" onclick="removeExecPlatform(\'' + name + '\',\'' + plat + '\')" title="Remove">✕</button></div>';
        });
        html += '<div class="sp-settings-row"><select class="sp-exec-plat-sel" id="sp-plat-' + name + '">';
        __defaultPlatforms.forEach(function(p) {
            if (!cfg[p]) html += '<option value="' + p + '">' + p + '</option>';
        });
        html += '<option value="__custom__">Custom...</option>';
        html += '</select><button class="sp-btn" onclick="addExecPlatform(\'' + name + '\')">+ Platform</button></div>';
        div.innerHTML = html;
        c.appendChild(div);
    });
}

function syncExecInputs() {
    // Read current input values back into __executables before any re-render
    document.querySelectorAll('.sp-exec-path').forEach(function(input) {
        var name = input.getAttribute('data-name');
        var plat = input.getAttribute('data-platform');
        if (name && plat && __executables[name]) {
            __executables[name][plat] = input.value;
        }
    });
}

function createNewExecutable() {
    var input = document.getElementById('sp-new-exec-name');
    if (!input) return;
    var name = input.value.trim();
    if (!name) return;
    if (__executables[name]) return;
    syncExecInputs();
    __executables[name] = {};
    input.value = '';
    renderExecutables();
}

function removeExecutable(name) {
    syncExecInputs();
    delete __executables[name];
    renderExecutables();
}

function addExecPlatform(name) {
    var sel = document.getElementById('sp-plat-' + name);
    if (!sel) return;
    var plat = sel.value;
    if (plat === '__custom__') {
        plat = window.prompt ? window.prompt('Platform key (e.g. freebsd-x64):') : '';
        if (!plat || !plat.trim()) return;
        plat = plat.trim();
    }
    if (!__executables[name]) __executables[name] = {};
    syncExecInputs();
    __executables[name][plat] = '';
    renderExecutables();
}

function removeExecPlatform(name, plat) {
    if (__executables[name]) {
        syncExecInputs();
        delete __executables[name][plat];
        renderExecutables();
    }
}

function collectExecutablesData() {
    var result = {};
    Object.keys(__executables).forEach(function(name) { result[name] = {}; });
    document.querySelectorAll('.sp-exec-path').forEach(function(input) {
        var name = input.getAttribute('data-name');
        var plat = input.getAttribute('data-platform');
        if (name && plat) {
            if (!result[name]) result[name] = {};
            result[name][plat] = input.value;
        }
    });
    return result;
}

// =========== Binary Path Editor JS ===========
var __binaryPath = {};

function initBinaryPathEditor() {
    var el = document.getElementById('sp-binarypath-init');
    if (!el) return;
    try { __binaryPath = JSON.parse(el.value || '{}'); } catch(e) { __binaryPath = {}; }
    renderBinaryPath();
}

function renderBinaryPath() {
    var c = document.getElementById('sp-binarypath-list');
    if (!c) return;
    c.innerHTML = '';
    var platforms = Object.keys(__binaryPath);
    if (platforms.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>Using fallback: ~/.tom/bin/&lt;platform&gt;/</em></div>';
        return;
    }
    platforms.forEach(function(plat) {
        var html = '<div class="sp-settings-row"><label style="min-width:90px">' + plat + ':</label>' +
            '<input type="text" class="sp-bp-path" data-platform="' + plat + '" value="' + (__binaryPath[plat]||'') + '" style="flex:1;min-width:120px;max-width:none">' +
            '<button class="sp-btn" onclick="removeBinaryPathPlatform(\'' + plat + '\')" title="Remove">\u2715</button></div>';
        c.insertAdjacentHTML('beforeend', html);
    });
}

function addBinaryPathPlatform() {
    var sel = document.getElementById('sp-binarypath-plat-sel');
    if (!sel) return;
    var plat = sel.value;
    if (plat === '__custom__') {
        plat = window.prompt ? window.prompt('Platform key (e.g. freebsd-x64):') : '';
        if (!plat || !plat.trim()) return;
        plat = plat.trim();
    }
    if (__binaryPath[plat] !== undefined) return; // already exists
    __binaryPath[plat] = '';
    renderBinaryPath();
}

function removeBinaryPathPlatform(plat) {
    delete __binaryPath[plat];
    renderBinaryPath();
}

function collectBinaryPathData() {
    var result = {};
    document.querySelectorAll('.sp-bp-path').forEach(function(input) {
        var plat = input.getAttribute('data-platform');
        if (plat) result[plat] = input.value;
    });
    return result;
}

// Helper for inline handlers (e.g. checkbox onchange)
function sendStatusAction(action, extra) {
    var msg = { type: 'statusAction', action: action };
    if (extra) { Object.keys(extra).forEach(function(k) { msg[k] = extra[k]; }); }
    vscode.postMessage(msg);
}

// =========== Commandlines Editor JS ===========
var __commandlines = [];
var __cmdDragIdx = -1;
var __cwdModes = [
    { value: 'none',       label: 'No cwd' },
    { value: 'workspace',  label: 'Workspace Root' },
    { value: 'extension',  label: 'Extension Root' },
    { value: 'project',    label: 'Project Root' },
    { value: 'repository', label: 'Repository Root' },
    { value: 'document',   label: 'Document Root' },
    { value: 'custom',     label: 'Custom Path' },
];

function initCommandlinesEditor() {
    var el = document.getElementById('sp-commandlines-init');
    if (!el) return;
    try { __commandlines = JSON.parse(el.value || '[]'); } catch(e) { __commandlines = []; }
    renderCommandlines();
}

function renderCommandlines() {
    var c = document.getElementById('sp-commandlines-list');
    if (!c) return;
    c.innerHTML = '';
    if (__commandlines.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>No commandlines defined</em></div>';
        return;
    }
    __commandlines.forEach(function(entry, idx) {
        var div = document.createElement('div');
        div.className = 'sp-exec-entry';
        div.setAttribute('draggable', 'true');
        div.setAttribute('data-cmd-idx', idx);
        div.addEventListener('dragstart', function(e) { __cmdDragIdx = idx; e.dataTransfer.effectAllowed = 'move'; });
        div.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; div.style.borderTop = '2px solid var(--vscode-focusBorder)'; });
        div.addEventListener('dragleave', function() { div.style.borderTop = ''; });
        div.addEventListener('drop', function(e) {
            e.preventDefault(); div.style.borderTop = '';
            if (__cmdDragIdx >= 0 && __cmdDragIdx !== idx) { reorderCommandline(__cmdDragIdx, idx); }
            __cmdDragIdx = -1;
        });

        var cwdSel = __cwdModes.map(function(m) {
            return '<option value="' + m.value + '"' + ((entry.cwdMode||'custom')===m.value?' selected':'') + '>' + m.label + '</option>';
        }).join('');

        var autoKey = idx < 9 ? String(idx+1) : (idx < 35 ? String.fromCharCode(97 + idx - 9) : '');
        var keyLabel = autoKey ? ' [' + autoKey + ']' : '';

        var postActionsStr = (entry.postActions || []).join(', ');
        var closeAfterRunChecked = entry.closeTerminalAfterRun === true ? ' checked' : '';

        div.innerHTML =
            '<div class="sp-settings-row"><strong style="cursor:grab">☰ ' + (entry.description || entry.command || '(unnamed)') + keyLabel + '</strong>' +
            '<span style="font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto">' + (idx > 0 ? '<button class="sp-btn" onclick="reorderCommandline(' + idx + ',' + (idx-1) + ')" title="Move up" style="padding:1px 4px;font-size:10px">▲</button>' : '') +
            (idx < __commandlines.length - 1 ? '<button class="sp-btn" onclick="reorderCommandline(' + idx + ',' + (idx+1) + ')" title="Move down" style="padding:1px 4px;font-size:10px">▼</button>' : '') + '</span>' +
            '<button class="sp-btn" onclick="removeCommandline(' + idx + ')" title="Remove">✕</button></div>' +
            '<div class="sp-settings-row"><label>Command:</label>' +
            '<input type="text" class="sp-cmd-command" data-idx="' + idx + '" value="' + escapeAttr(entry.command||'') + '" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Description:</label>' +
            '<input type="text" class="sp-cmd-desc" data-idx="' + idx + '" value="' + escapeAttr(entry.description||'') + '" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>CWD Mode:</label>' +
            '<select class="sp-cmd-cwdmode" data-idx="' + idx + '">' + cwdSel + '</select>' +
            (entry.cwdMode === 'custom' || (!entry.cwdMode && entry.cwd) ? '<input type="text" class="sp-cmd-cwd" data-idx="' + idx + '" value="' + escapeAttr(entry.cwd||'') + '" placeholder="Custom path" style="flex:1;min-width:80px">' : '') +
            '</div>' +
            '<div class="sp-settings-row"><label>Post-Actions:</label>' +
            '<input type="text" class="sp-cmd-postactions" data-idx="' + idx + '" value="' + escapeAttr(postActionsStr) + '" placeholder="VS Code command IDs, comma-separated" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Close terminal after run:</label>' +
            '<input type="checkbox" class="sp-cmd-close-terminal" data-idx="' + idx + '"' + closeAfterRunChecked + '></div>';
        c.appendChild(div);
    });
}

function escapeAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function addCommandlineEntry() {
    __commandlines.push({ command: '', description: '', cwdMode: 'workspace' });
    renderCommandlines();
}

function removeCommandline(idx) {
    __commandlines.splice(idx, 1);
    renderCommandlines();
}

function reorderCommandline(fromIdx, toIdx) {
    var item = __commandlines.splice(fromIdx, 1)[0];
    __commandlines.splice(toIdx, 0, item);
    renderCommandlines();
}

function collectCommandlinesData() {
    var result = [];
    document.querySelectorAll('.sp-cmd-command').forEach(function(input) {
        var idx = parseInt(input.getAttribute('data-idx'));
        if (isNaN(idx)) return;
        var entry = __commandlines[idx] || {};
        var descEl = document.querySelector('.sp-cmd-desc[data-idx="' + idx + '"]');
        var cwdModeEl = document.querySelector('.sp-cmd-cwdmode[data-idx="' + idx + '"]');
        var cwdEl = document.querySelector('.sp-cmd-cwd[data-idx="' + idx + '"]');
        var postActionsEl = document.querySelector('.sp-cmd-postactions[data-idx="' + idx + '"]');
        var closeTerminalEl = document.querySelector('.sp-cmd-close-terminal[data-idx="' + idx + '"]');
        var postActions = [];
        if (postActionsEl && postActionsEl.value.trim()) {
            postActions = postActionsEl.value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
        }
        result.push({
            command: input.value,
            description: descEl ? descEl.value : (entry.description || ''),
            cwdMode: cwdModeEl ? cwdModeEl.value : (entry.cwdMode || 'workspace'),
            cwd: cwdEl ? cwdEl.value : (entry.cwd || ''),
            postActions: postActions,
            closeTerminalAfterRun: closeTerminalEl ? closeTerminalEl.checked : entry.closeTerminalAfterRun === true
        });
    });
    return result;
}

// =========== Favorites Editor JS ===========
var __favorites = [];
var __favDragIdx = -1;

function initFavoritesEditor() {
    var el = document.getElementById('sp-favorites-init');
    if (!el) return;
    try { __favorites = JSON.parse(el.value || '[]'); } catch(e) { __favorites = []; }
    renderFavorites();
}

function renderFavorites() {
    var c = document.getElementById('sp-favorites-list');
    if (!c) return;
    c.innerHTML = '';
    if (__favorites.length === 0) {
        c.innerHTML = '<div class="sp-settings-row" style="color:var(--vscode-descriptionForeground)"><em>No favorites configured</em></div>';
        return;
    }
    __favorites.forEach(function(entry, idx) {
        var div = document.createElement('div');
        div.className = 'sp-exec-entry';
        div.setAttribute('draggable', 'true');
        div.setAttribute('data-fav-idx', idx);
        div.addEventListener('dragstart', function(e) { __favDragIdx = idx; e.dataTransfer.effectAllowed = 'move'; });
        div.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; div.style.borderTop = '2px solid var(--vscode-focusBorder)'; });
        div.addEventListener('dragleave', function() { div.style.borderTop = ''; });
        div.addEventListener('drop', function(e) {
            e.preventDefault(); div.style.borderTop = '';
            if (__favDragIdx >= 0 && __favDragIdx !== idx) { reorderFavorite(__favDragIdx, idx); }
            __favDragIdx = -1;
        });

        // Support commandIds (array), commandId (string), and command (alias)
        var cmdValue = '';
        if (Array.isArray(entry.commandIds) && entry.commandIds.length > 0) {
            cmdValue = entry.commandIds.join(', ');
        } else {
            cmdValue = entry.commandId || entry.command || '';
        }

        div.innerHTML =
            '<div class="sp-settings-row"><strong style="cursor:grab">☰ ' + escapeAttr(entry.label || cmdValue || '(unnamed)') + '</strong>' +
            '<span style="font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto">' + (idx > 0 ? '<button class="sp-btn" onclick="reorderFavorite(' + idx + ',' + (idx-1) + ')" title="Move up" style="padding:1px 4px;font-size:10px">▲</button>' : '') +
            (idx < __favorites.length - 1 ? '<button class="sp-btn" onclick="reorderFavorite(' + idx + ',' + (idx+1) + ')" title="Move down" style="padding:1px 4px;font-size:10px">▼</button>' : '') + '</span>' +
            '<button class="sp-btn" onclick="removeFavorite(' + idx + ')" title="Remove">✕</button></div>' +
            '<div class="sp-settings-row"><label>Key:</label>' +
            '<input type="text" class="sp-fav-key" data-idx="' + idx + '" value="' + escapeAttr(entry.key||'') + '" maxlength="1" style="width:30px;text-align:center">' +
            '<label>Label:</label>' +
            '<input type="text" class="sp-fav-label" data-idx="' + idx + '" value="' + escapeAttr(entry.label||'') + '" style="flex:1;min-width:100px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Command:</label>' +
            '<input type="text" class="sp-fav-command" data-idx="' + idx + '" value="' + escapeAttr(cmdValue) + '" placeholder="command.id or cmd1, cmd2, cmd3" style="flex:1;min-width:150px;max-width:none"></div>' +
            '<div class="sp-settings-row"><label>Description:</label>' +
            '<input type="text" class="sp-fav-desc" data-idx="' + idx + '" value="' + escapeAttr(entry.description||'') + '" style="flex:1;min-width:150px;max-width:none"></div>';
        c.appendChild(div);
    });
}

function addFavoriteEntry() {
    __favorites.push({ key: '', label: '', commandId: '', description: '' });
    renderFavorites();
}

function removeFavorite(idx) {
    __favorites.splice(idx, 1);
    renderFavorites();
}

function reorderFavorite(fromIdx, toIdx) {
    var item = __favorites.splice(fromIdx, 1)[0];
    __favorites.splice(toIdx, 0, item);
    renderFavorites();
}

function collectFavoritesData() {
    var result = [];
    document.querySelectorAll('.sp-fav-key').forEach(function(input) {
        var idx = parseInt(input.getAttribute('data-idx'));
        if (isNaN(idx)) return;
        var labelEl = document.querySelector('.sp-fav-label[data-idx="' + idx + '"]');
        var cmdEl = document.querySelector('.sp-fav-command[data-idx="' + idx + '"]');
        var descEl = document.querySelector('.sp-fav-desc[data-idx="' + idx + '"]');
        var rawCmd = cmdEl ? cmdEl.value.trim() : '';
        var entry = {
            key: input.value,
            label: labelEl ? labelEl.value : '',
            description: descEl ? descEl.value : ''
        };
        // If comma-separated, store as commandIds array; otherwise single commandId
        if (rawCmd.indexOf(',') >= 0) {
            var ids = rawCmd.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
            if (ids.length > 1) {
                entry.commandIds = ids;
                entry.commandId = ids[0];
            } else {
                entry.commandId = ids[0] || '';
            }
        } else {
            entry.commandId = rawCmd;
        }
        result.push(entry);
    });
    return result;
}

function collectLlmProfilesData() {
    var result = {};
    document.querySelectorAll('.sp-llm-profile-model').forEach(function(select) {
        var profile = select.getAttribute('data-profile');
        if (!profile) return;
        var toolsEl = document.querySelector('.sp-llm-profile-tools[data-profile="' + profile + '"]');
        result[profile] = {
            modelConfig: select.value || null,
            toolsEnabled: toolsEl ? toolsEl.value === 'true' : true
        };
    });
    return result;
}

function collectConvProfilesData() {
    var result = {};
    document.querySelectorAll('.sp-conv-profile-model').forEach(function(select) {
        var profile = select.getAttribute('data-profile');
        if (!profile) return;
        result[profile] = {
            modelConfig: select.value || null
        };
    });
    return result;
}

// =========== LLM Configurations Editor JS ===========
var __llmConfigs = [];

var __availableLlmTools = (window.__statusAvailableLlmTools || []);

function initLlmConfigsEditor() {
    var el = document.getElementById('sp-llmconfigs-init');
    if (!el) return;
    try { __llmConfigs = JSON.parse(el.value || '[]'); } catch(e) { __llmConfigs = []; }
    renderLlmConfigurations();
}

function renderLlmConfigurations() {
    var list = document.getElementById('sp-llmconfigs-list');
    if (!list) return;
    if (__llmConfigs.length === 0) {
        list.innerHTML = '<div class="sp-info">No LLM configurations defined</div>';
        return;
    }

    list.innerHTML = __llmConfigs.map(function(cfg) {
        var id = String(cfg.id || '').replace(/"/g, '&quot;');
        var name = String(cfg.name || id).replace(/"/g, '&quot;');
        var summaryPrompt = String(cfg.trailSummarizationPrompt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        var enabledTools = Array.isArray(cfg.enabledTools) ? cfg.enabledTools : [];
        var toolsHtml = __availableLlmTools.map(function(tool) {
            var checked = enabledTools.indexOf(tool) >= 0 ? 'checked' : '';
            return '<label class="sp-tool-checkbox" title="' + tool + '">' +
                '<input type="checkbox" data-tool="' + tool + '" data-config="' + id + '" ' + checked + '>' +
                tool.replace('tom_', '').replace('tomAi_', '') +
            '</label>';
        }).join('');

        return '<div class="sp-llmconfig-card" data-config-id="' + id + '">' +
            '<div class="sp-llmconfig-header">' +
                '<input type="text" class="sp-config-name" value="' + name + '" data-field="name" placeholder="Name">' +
                '<input type="text" class="sp-config-id" value="' + id + '" data-field="id" placeholder="ID" readonly>' +
                '<button class="sp-btn small danger" data-status-action="deleteLlmConfiguration" data-config-id="' + id + '">🗑️</button>' +
            '</div>' +
            '<div class="sp-settings-row"><label>URL:</label><input type="text" data-field="ollamaUrl" value="' + (cfg.ollamaUrl || 'http://localhost:11434') + '" style="flex:2"><label>API:</label><select data-field="apiStyle" title="Ollama: /api/chat. OpenAI: /v1/chat/completions (vLLM, LM Studio, llama.cpp)"><option value="ollama" ' + ((cfg.apiStyle || 'ollama') === 'ollama' ? 'selected' : '') + '>Ollama</option><option value="openai" ' + (cfg.apiStyle === 'openai' ? 'selected' : '') + '>OpenAI/vLLM</option></select><label>Model:</label><input type="text" data-field="model" value="' + (cfg.model || 'qwen3:8b') + '" style="flex:1"></div>' +
            '<div class="sp-settings-row"><label>Temp:</label><input type="number" data-field="temperature" value="' + (cfg.temperature ?? 0.4) + '" step="0.1" min="0" max="2"><label>Trail Tokens:</label><input type="number" data-field="trailMaximumTokens" value="' + (cfg.trailMaximumTokens ?? 8000) + '" step="1000" min="1000"><label title="Maximum response tokens (maxTokens on the synthesised AnthropicConfiguration).">Max Tokens:</label><input type="number" data-field="maxTokens" value="' + (cfg.maxTokens ?? 8192) + '" step="1024" min="256"></div>' +
            '<div class="sp-settings-row"><label title="Maximum tool-call rounds before the model is forced to produce a text answer. Set to >= 2 for any tool use.">Max Rounds:</label><input type="number" data-field="maxRounds" value="' + (cfg.maxRounds ?? 10) + '" step="1" min="1"><label title="When OFF, no tools array is sent. Required for vLLM / llama.cpp servers launched without --enable-auto-tool-choice + --tool-call-parser.">Tools:</label><select data-field="toolsEnabled"><option value="true" ' + (cfg.toolsEnabled !== false ? 'selected' : '') + '>Enabled</option><option value="false" ' + (cfg.toolsEnabled === false ? 'selected' : '') + '>Disabled</option></select></div>' +
            '<div class="sp-settings-row"><label>Sum Temp:</label><input type="number" data-field="trailSummarizationTemperature" value="' + (cfg.trailSummarizationTemperature ?? 0.3) + '" step="0.1" min="0" max="2"><label>Keep Alive:</label><input type="text" data-field="keepAlive" value="' + (cfg.keepAlive || '5m') + '"><label>History:</label><select data-field="historyMode"><option value="none" ' + (cfg.historyMode === 'none' ? 'selected' : '') + '>None (no history)</option><option value="last" ' + (cfg.historyMode === 'last' ? 'selected' : '') + '>Last (most recent pair)</option><option value="full" ' + (cfg.historyMode === 'full' ? 'selected' : '') + '>Full (capped)</option><option value="summary" ' + (cfg.historyMode === 'summary' ? 'selected' : '') + '>Summary (batch)</option><option value="trim_and_summary" ' + ((!cfg.historyMode || cfg.historyMode === 'trim_and_summary') ? 'selected' : '') + '>Trim+Summary (incremental)</option><option value="llm_extract" ' + (cfg.historyMode === 'llm_extract' ? 'selected' : '') + '>LLM Extract</option></select></div>' +
            '<div class="sp-settings-row"><label title="Per-configuration override for compaction.rawTurnsKept. Empty = inherit.">Raw turn pairs:</label><input type="number" data-field="rawTurnsKept" value="' + (cfg.rawTurnsKept ?? '') + '" placeholder="(inherit)" min="0" max="500" style="width:80px"><label title="Per-configuration override for compaction.maxHistoryTokens. Empty = inherit.">Max history tokens:</label><input type="number" data-field="maxHistoryTokens" value="' + (cfg.maxHistoryTokens ?? '') + '" placeholder="(inherit)" min="0" step="500" style="width:90px"></div>' +
            '<div class="sp-settings-row"><label title="Per-configuration override for compaction.historyMaxChars. Empty = inherit.">History max chars:</label><input type="number" data-field="historyMaxChars" value="' + (cfg.historyMaxChars ?? '') + '" placeholder="(inherit)" min="0" step="1000" style="width:90px"><label title="Per-configuration override for compaction.memoryMaxChars. Empty = inherit.">Memory max chars:</label><input type="number" data-field="memoryMaxChars" value="' + (cfg.memoryMaxChars ?? '') + '" placeholder="(inherit)" min="0" step="1000" style="width:90px"></div>' +
            '<div class="sp-settings-row"><label title="Per-configuration override for compaction.toolTrailMaxResultChars. Empty = inherit.">Tool result max chars:</label><input type="number" data-field="toolTrailMaxResultChars" value="' + (cfg.toolTrailMaxResultChars ?? '') + '" placeholder="(inherit)" min="0" step="100" style="width:90px"><label title="Per-configuration override for compaction.toolTrailKeepRounds. Empty = inherit.">Tool keep rounds:</label><input type="number" data-field="toolTrailKeepRounds" value="' + (cfg.toolTrailKeepRounds ?? '') + '" placeholder="(inherit)" min="0" max="50" style="width:80px"><label title="When checked, this configuration is the default LLM configuration.">Default:</label><input type="checkbox" data-field="isDefault" ' + (cfg.isDefault ? 'checked' : '') + '></div>' +
            '<div class="sp-settings-row"><label title="Name of the environment variable holding the API key (bearer token). Only needed for OpenAI-compatible hosts that require authentication. Empty = unauthenticated.">API Key Env:</label><input type="text" data-field="apiKeyEnv" value="' + (cfg.apiKeyEnv || '') + '" placeholder="(none, e.g. OPENAI_API_KEY)" style="flex:1"></div>' +
            '<div class="sp-settings-row"><label>Answer Folder:</label><input type="text" data-field="answerFolder" value="' + (cfg.answerFolder || '') + '" style="flex:2"><label>Log Folder:</label><input type="text" data-field="logFolder" value="' + (cfg.logFolder || '') + '" style="flex:2"></div>' +
            '<div class="sp-settings-row"><label>Summary Prompt:</label><textarea data-field="trailSummarizationPrompt" rows="3" style="flex:1">' + summaryPrompt + '</textarea></div>' +
            '<div class="sp-settings-row"><label>Strip Think:</label><select data-field="stripThinkingTags"><option value="true" ' + (cfg.stripThinkingTags ? 'selected' : '') + '>Yes</option><option value="false" ' + (!cfg.stripThinkingTags ? 'selected' : '') + '>No</option></select><label>Rm Template:</label><select data-field="removePromptTemplateFromTrail"><option value="true" ' + (cfg.removePromptTemplateFromTrail ? 'selected' : '') + '>Yes</option><option value="false" ' + (!cfg.removePromptTemplateFromTrail ? 'selected' : '') + '>No</option></select></div>' +
            '<div class="sp-tools-section"><label style="font-weight:bold;margin-bottom:4px;display:block">Enabled Tools:</label><div class="sp-tools-grid">' + toolsHtml + '</div></div>' +
        '</div>';
    }).join('');

    attachStatusPanelListeners(true);
    // Enforce exclusive isDefault on the client side too — ticking one
    // card unchecks the others immediately so the visual state matches
    // what the server will persist on save.
    document.querySelectorAll('.sp-llmconfig-card [data-field="isDefault"]').forEach(function(cb) {
        cb.addEventListener('change', function(ev) {
            if (ev.target.checked) {
                document.querySelectorAll('.sp-llmconfig-card [data-field="isDefault"]').forEach(function(other) {
                    if (other !== ev.target) { other.checked = false; }
                });
            }
        });
    });
}

function addLlmConfiguration() {
    var id = 'config_' + Date.now();
    var cfg = {
        id: id,
        name: 'New Configuration',
        ollamaUrl: 'http://localhost:11434',
        apiStyle: 'ollama',
        model: 'qwen3:8b',
        temperature: 0.4,
        stripThinkingTags: true,
        trailMaximumTokens: 8000,
        removePromptTemplateFromTrail: true,
        trailSummarizationTemperature: 0.3,
        trailSummarizationPrompt: '',
        answerFolder: '',
        logFolder: '',
        historyMode: 'trim_and_summary',
        keepAlive: '5m',
        maxRounds: 10,
        maxTokens: 8192,
        toolsEnabled: true,
        enabledTools: ['tomAi_readFile', 'tomAi_listDirectory', 'tomAi_findFiles', 'tomAi_findTextInFiles', 'tomAi_fetchWebpage', 'tomAi_webSearch', 'tomAi_getErrors', 'tomAi_readGlobalGuideline', 'tomAi_listGlobalGuidelines', 'tomAi_askBigBrother', 'tomAi_askCopilot']
    };
    __llmConfigs.push(cfg);
    renderLlmConfigurations();
}

function saveLlmConfigurations() {
    var configurations = collectLlmConfigurationsData();
    vscode.postMessage({ type: 'statusAction', action: 'saveLlmConfigurations', configurations: configurations });
}

// Parse an optional integer from a form input value. Returns undefined for
// empty strings / NaN so the saved config inherits the compaction-level
// fallback instead of pinning the field to 0.
function _parseOptionalInt(s) {
    if (s === undefined || s === null) return undefined;
    var trimmed = String(s).trim();
    if (trimmed === '') return undefined;
    var n = parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : undefined;
}

function collectLlmConfigurationsData() {
    var result = [];
    document.querySelectorAll('.sp-llmconfig-card').forEach(function(card) {
        var configId = card.getAttribute('data-config-id');
        if (!configId) return;
        var cfg = {
            id: configId,
            name: card.querySelector('[data-field="name"]')?.value || '',
            ollamaUrl: card.querySelector('[data-field="ollamaUrl"]')?.value || '',
            apiStyle: card.querySelector('[data-field="apiStyle"]')?.value || 'ollama',
            model: card.querySelector('[data-field="model"]')?.value || '',
            temperature: parseFloat(card.querySelector('[data-field="temperature"]')?.value || 'NaN'),
            stripThinkingTags: card.querySelector('[data-field="stripThinkingTags"]')?.value === 'true',
            trailMaximumTokens: parseInt(card.querySelector('[data-field="trailMaximumTokens"]')?.value || 'NaN'),
            removePromptTemplateFromTrail: card.querySelector('[data-field="removePromptTemplateFromTrail"]')?.value === 'true',
            trailSummarizationTemperature: parseFloat(card.querySelector('[data-field="trailSummarizationTemperature"]')?.value || 'NaN'),
            trailSummarizationPrompt: card.querySelector('[data-field="trailSummarizationPrompt"]')?.value || '',
            answerFolder: card.querySelector('[data-field="answerFolder"]')?.value || '',
            logFolder: card.querySelector('[data-field="logFolder"]')?.value || '',
            historyMode: card.querySelector('[data-field="historyMode"]')?.value || '',
            keepAlive: card.querySelector('[data-field="keepAlive"]')?.value || '',
            apiKeyEnv: card.querySelector('[data-field="apiKeyEnv"]')?.value || '',
            maxRounds: parseInt(card.querySelector('[data-field="maxRounds"]')?.value || 'NaN'),
            maxTokens: parseInt(card.querySelector('[data-field="maxTokens"]')?.value || 'NaN'),
            toolsEnabled: card.querySelector('[data-field="toolsEnabled"]')?.value === 'true',
            isDefault: card.querySelector('[data-field="isDefault"]')?.checked === true,
            // Per-configuration compaction overrides. Empty string → undefined (inherit).
            rawTurnsKept: _parseOptionalInt(card.querySelector('[data-field="rawTurnsKept"]')?.value),
            maxHistoryTokens: _parseOptionalInt(card.querySelector('[data-field="maxHistoryTokens"]')?.value),
            historyMaxChars: _parseOptionalInt(card.querySelector('[data-field="historyMaxChars"]')?.value),
            memoryMaxChars: _parseOptionalInt(card.querySelector('[data-field="memoryMaxChars"]')?.value),
            toolTrailMaxResultChars: _parseOptionalInt(card.querySelector('[data-field="toolTrailMaxResultChars"]')?.value),
            toolTrailKeepRounds: _parseOptionalInt(card.querySelector('[data-field="toolTrailKeepRounds"]')?.value),
            enabledTools: []
        };
        // Collect enabled tools
        card.querySelectorAll('.sp-tools-grid input[type="checkbox"]:checked').forEach(function(cb) {
            cfg.enabledTools.push(cb.getAttribute('data-tool'));
        });
        result.push(cfg);
    });
    return result;
}

// =========== AI Conversation Setups Editor JS ===========
var __aiSetups = [];

function initAiSetupsEditor() {
    var el = document.getElementById('sp-aisetups-init');
    if (!el) return;
    try { __aiSetups = JSON.parse(el.value || '[]'); } catch(e) { __aiSetups = []; }
    renderAiSetups();
}

function _getLlmConfigOptions(selected, includeCopilot) {
    var opts = [];
    if (includeCopilot) {
        opts.push('<option value="copilot" ' + (selected === 'copilot' ? 'selected' : '') + '>Copilot</option>');
    } else {
        opts.push('<option value="">(None)</option>');
    }
    __llmConfigs.forEach(function(cfg) {
        var id = cfg.id || '';
        var name = cfg.name || id;
        if (id) {
            opts.push('<option value="' + String(id).replace(/"/g, '&quot;') + '" ' + (id === selected ? 'selected' : '') + '>' + String(name).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</option>');
        }
    });
    return opts.join('');
}

function renderAiSetups() {
    var list = document.getElementById('sp-aisetups-list');
    if (!list) return;
    if (__aiSetups.length === 0) {
        list.innerHTML = '<div class="sp-info">No AI Conversation setups defined</div>';
        return;
    }
    list.innerHTML = __aiSetups.map(function(setup) {
        var id = String(setup.id || '').replace(/"/g, '&quot;');
        var name = String(setup.name || id).replace(/"/g, '&quot;');
        return '<div class="sp-aisetup-card" data-setup-id="' + id + '">' +
            '<div class="sp-aisetup-header">' +
                '<input type="text" class="sp-setup-name" value="' + name + '" data-field="name" placeholder="Name">' +
                '<input type="text" class="sp-setup-id" value="' + id + '" data-field="id" placeholder="ID" readonly>' +
                '<button class="sp-btn small danger" data-status-action="deleteAiConversationSetup" data-setup-id="' + id + '">🗑️</button>' +
            '</div>' +
            '<div class="sp-settings-row"><label>LLM Config A:</label><select data-field="llmConfigA">' + _getLlmConfigOptions(setup.llmConfigA || '', false) + '</select><label>LLM Config B:</label><select data-field="llmConfigB">' + _getLlmConfigOptions(setup.llmConfigB || '', true) + '</select></div>' +
            '<div class="sp-settings-row"><label>Max Turns:</label><input type="number" data-field="maxTurns" value="' + (setup.maxTurns ?? 10) + '" min="1" max="50"><label>Pause Between:</label><select data-field="pauseBetweenTurns"><option value="true" ' + (setup.pauseBetweenTurns ? 'selected' : '') + '>Yes</option><option value="false" ' + (!setup.pauseBetweenTurns ? 'selected' : '') + '>No</option></select><label>History:</label><select data-field="historyMode"><option value="full" ' + (setup.historyMode === 'full' ? 'selected' : '') + '>Full</option><option value="last" ' + (setup.historyMode === 'last' ? 'selected' : '') + '>Last</option><option value="summary" ' + (setup.historyMode === 'summary' ? 'selected' : '') + '>Summary</option><option value="trim_and_summary" ' + ((!setup.historyMode || setup.historyMode === 'trim_and_summary') ? 'selected' : '') + '>Trim+Summary</option></select><label>Sum LLM:</label><select data-field="trailSummarizationLlmConfig">' + _getLlmConfigOptions(setup.trailSummarizationLlmConfig || '', false) + '</select></div>' +
        '</div>';
    }).join('');
    attachStatusPanelListeners(true);
}

function addAiConversationSetup() {
    var id = 'setup_' + Date.now();
    var setup = {
        id: id,
        name: 'New Setup',
        llmConfigA: '',
        llmConfigB: 'copilot',
        maxTurns: 10,
        pauseBetweenTurns: false,
        historyMode: 'trim_and_summary',
        trailSummarizationLlmConfig: ''
    };
    __aiSetups.push(setup);
    renderAiSetups();
}

function saveAiConversationSetups() {
    var setups = collectAiSetupsData();
    vscode.postMessage({ type: 'statusAction', action: 'saveAiConversationSetups', setups: setups });
}

function collectAiSetupsData() {
    var result = [];
    document.querySelectorAll('.sp-aisetup-card').forEach(function(card) {
        var setupId = card.getAttribute('data-setup-id');
        if (!setupId) return;
        result.push({
            id: setupId,
            name: card.querySelector('[data-field="name"]')?.value || '',
            llmConfigA: card.querySelector('[data-field="llmConfigA"]')?.value || '',
            llmConfigB: card.querySelector('[data-field="llmConfigB"]')?.value || '',
            maxTurns: parseInt(card.querySelector('[data-field="maxTurns"]')?.value || 'NaN'),
            pauseBetweenTurns: card.querySelector('[data-field="pauseBetweenTurns"]')?.value === 'true',
            historyMode: card.querySelector('[data-field="historyMode"]')?.value || '',
            trailSummarizationLlmConfig: card.querySelector('[data-field="trailSummarizationLlmConfig"]')?.value || ''
        });
    });
    return result;
}
