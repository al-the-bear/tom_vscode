// @ts-nocheck
/*
 * Prompt Trail Viewer client script — extracted verbatim from the inline
 * <script> in getWebviewHtml() of src/handlers/trailViewer-handler.ts
 * (Phase B.17 webview restructuring).
 *
 * Initial state (folderOptions, selectedFolder, subsystems, selectedSubsystem,
 * selectedQuest, rootFolder) was previously interpolated into the inline
 * script; it now arrives via window.__INIT__ from the loader. The only other
 * init value is codiconsUri, injected as a <link> at runtime (no placeholder
 * exists for the node_modules codicons asset). All exchange data flows in via
 * postMessage after the initial loadExchanges request.
 */
(function() {
    const vscode = acquireVsCodeApi();
    const __INIT = window.__INIT__ || {};

    // ── Codicons stylesheet (injected from init; cspSource-served, no placeholder) ──
    if (__INIT.codiconsUri) {
        const __codiconsLink = document.createElement('link');
        __codiconsLink.rel = 'stylesheet';
        __codiconsLink.href = __INIT.codiconsUri;
        document.head.appendChild(__codiconsLink);
    }

    let exchanges = [];
    let selectedExchange = null;
    let exchangeContent = {};
    let exchangeTodoRef = '';
    let exchangeResponseValues = null;
    let currentTab = 'prompt';
    let folderOptions = __INIT.folderOptions;
    let selectedFolder = __INIT.currentFolder;
    let subsystems = __INIT.subsystems;
    let selectedSubsystem = __INIT.selectedSubsystem;
    let selectedQuest = __INIT.selectedQuest;
    const rootFolder = __INIT.rootFolder;

    // Elements
    const exchangeList = document.getElementById('sessionList');
    const subsystemSelect = document.getElementById('subsystemSelect');
    const questSelect = document.getElementById('questSelect');
    const exchangeTitle = document.getElementById('exchangeTitle');
    const tabs = document.getElementById('tabs');
    const contentPane = document.getElementById('contentPane');
    const extractBtn = document.getElementById('extractBtn');
    const gotoTodoBtn = document.getElementById('gotoTodoBtn');
    const openInEditorBtn = document.getElementById('openInEditorBtn');
    const openExternallyBtn = document.getElementById('openExternallyBtn');
    const refreshBtn = document.getElementById('refreshBtn');

    function populateSubsystems() {
        subsystemSelect.innerHTML = '';
        for (const sub of subsystems) {
            const element = document.createElement('option');
            element.value = sub.name;
            element.textContent = sub.name;
            if (sub.name === selectedSubsystem) {
                element.selected = true;
            }
            subsystemSelect.appendChild(element);
        }
        // Also populate quests for the selected subsystem
        populateQuests();
    }

    function populateQuests() {
        questSelect.innerHTML = '';
        const sub = subsystems.find(s => s.name === selectedSubsystem);
        if (!sub) {
            questSelect.style.display = 'none';
            return;
        }

        const quests = sub.quests || [];
        if (quests.length === 0) {
            // No quest folders, hide the dropdown
            questSelect.style.display = 'none';
            // If subsystem has root files, use subsystem folder
            if (sub.hasRootFiles) {
                selectedQuest = '';
                selectedFolder = rootFolder + '/' + selectedSubsystem;
            }
            return;
        }

        questSelect.style.display = '';
        for (const quest of quests) {
            const element = document.createElement('option');
            element.value = quest;
            element.textContent = quest;
            if (quest === selectedQuest) {
                element.selected = true;
            }
            questSelect.appendChild(element);
        }

        // Ensure selectedQuest is valid
        if (!quests.includes(selectedQuest)) {
            selectedQuest = quests[0] || '';
            if (questSelect.options.length > 0) {
                questSelect.options[0].selected = true;
            }
        }

        // Update selectedFolder
        if (selectedQuest) {
            selectedFolder = rootFolder + '/' + selectedSubsystem + '/' + selectedQuest;
        } else {
            selectedFolder = rootFolder + '/' + selectedSubsystem;
        }
    }

    populateSubsystems();

    subsystemSelect.addEventListener('change', () => {
        selectedSubsystem = subsystemSelect.value;
        populateQuests();
        selectedExchange = null;
        exchangeContent = {};
        exchangeTodoRef = '';
        exchangeResponseValues = null;
        vscode.postMessage({ type: 'switchSubsystem', folder: selectedFolder });
    });

    questSelect.addEventListener('change', () => {
        selectedQuest = questSelect.value;
        if (selectedQuest) {
            selectedFolder = rootFolder + '/' + selectedSubsystem + '/' + selectedQuest;
        } else {
            selectedFolder = rootFolder + '/' + selectedSubsystem;
        }
        selectedExchange = null;
        exchangeContent = {};
        exchangeTodoRef = '';
        exchangeResponseValues = null;
        vscode.postMessage({ type: 'switchSubsystem', folder: selectedFolder });
    });

    // Render exchange list
    function renderExchanges() {
        if (exchanges.length === 0) {
            exchangeList.innerHTML = '<div class="empty-state"><span class="codicon codicon-info"></span><div>No trail exchanges found in this folder.</div></div>';
            return;
        }

        exchangeList.innerHTML = exchanges.map(s => {
            const fileTypes = s.files.map(f => f.type).join(', ');
            let todoHtml = '';
            if (s.todoRefs && s.todoRefs.length > 0) {
                const links = s.todoRefs.map(ref => {
                    const parts = ref.split('/');
                    const todoId = parts.length >= 2 ? parts[parts.length - 1] : ref;
                    const todoFile = parts.length >= 2 ? parts[parts.length - 2] : '';
                    const display = todoFile ? todoId + '@' + todoFile : todoId;
                    const encoded = encodeURIComponent(ref);
                    return '<a class="session-todo-link" data-todoref="' + encoded + '" title="Open TODO in @WS QUEST TODOS">' + escapeHtml(display) + '</a>';
                }).join('');
                todoHtml = '<div class="session-todo-links">' + links + '</div>';
            }
            return `
                <div class="session-item${s.id === selectedExchange?.id ? ' selected' : ''}" data-id="${s.id}">
                    <div class="session-time">${s.displayTime}</div>
                    <div class="session-name">${s.session}</div>
                    <div class="session-files">${fileTypes}</div>
                    ${todoHtml}
                </div>`;
        }).join('');

        // Add click handlers
        exchangeList.querySelectorAll('.session-item').forEach(el => {
            el.addEventListener('click', () => selectExchange(el.dataset.id));
        });
        // Add TODO link click handlers (stop propagation)
        exchangeList.querySelectorAll('.session-todo-link').forEach(link => {
            link.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                const todoRef = decodeURIComponent(link.getAttribute('data-todoref') || '');
                if (todoRef) {
                    vscode.postMessage({ type: 'gotoTodo', todoRef });
                }
            });
        });
    }

    // Select an exchange
    function selectExchange(id) {
        selectedExchange = exchanges.find(s => s.id === id);
        if (!selectedExchange) return;

        renderExchanges();
        exchangeTitle.textContent = selectedExchange.displayTime + ' - ' + selectedExchange.session;
        tabs.style.display = 'flex';
        extractBtn.style.display = 'flex';
        openInEditorBtn.style.display = 'flex';
        openExternallyBtn.style.display = 'flex';
        gotoTodoBtn.style.display = 'none';

        // Request content
        vscode.postMessage({ type: 'loadExchange', exchangeId: id });
    }

    // Render content pane
    function renderContent() {
        const content = exchangeContent[currentTab] || '';
        if (!content) {
            contentPane.innerHTML = '<div class="empty-state"><span class="codicon codicon-file"></span><div>No ' + currentTab + ' content</div></div>';
        } else {
            const metadataHtml = currentTab === 'answer' ? renderAnswerMetadata() : '';
            contentPane.innerHTML = metadataHtml + '<pre>' + escapeHtml(content) + '</pre>';
        }
    }

    function renderAnswerMetadata() {
        if (!exchangeResponseValues || typeof exchangeResponseValues !== 'object') {
            return '';
        }
        const entries = Object.entries(exchangeResponseValues);
        if (!entries.length) {
            return '';
        }
        const rows = entries.map(([key, value]) => {
            const keyText = 'responseValues.' + key;
            const encodedTodoRef = encodeURIComponent(value);
            const hasTodoKey = key.includes('TODO');
            const renderedValue = hasTodoKey
                ? '<a href="#" class="todo-value-link" title="Open TODO in @WS QUEST TODOS" data-todoref="' + encodedTodoRef + '">' + escapeHtml(String(value)) + '</a><span class="todo-value-icon codicon codicon-tasklist" aria-hidden="true"></span>'
                : escapeHtml(String(value));
            return '<div class="answer-metadata-row">'
                + '<div class="answer-metadata-key">' + escapeHtml(keyText) + '</div>'
                + '<div class="answer-metadata-value">' + renderedValue + '</div>'
                + '</div>';
        }).join('');
        return '<div class="answer-metadata">'
            + '<div class="answer-metadata-title">ANSWER Metadata</div>'
            + rows
            + '</div>';
    }

    // Escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Tab switching
    tabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;

        currentTab = tab.dataset.tab;
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderContent();
    });

    contentPane.addEventListener('click', (e) => {
        const todoLink = e.target.closest('.todo-value-link');
        if (!todoLink) return;
        e.preventDefault();
        const encodedRef = todoLink.getAttribute('data-todoref') || '';
        const todoRef = decodeURIComponent(encodedRef);
        if (!todoRef) return;
        vscode.postMessage({
            type: 'gotoTodo',
            todoRef,
        });
    });

    // Extract button
    extractBtn.addEventListener('click', () => {
        if (!selectedExchange) return;
        vscode.postMessage({
            type: 'extractToMarkdown',
            exchangeId: selectedExchange.id,
            content: {
                userprompt: exchangeContent.prompt,
                answer: exchangeContent.answer,
            },
        });
    });

    gotoTodoBtn.addEventListener('click', () => {
        if (!exchangeTodoRef) return;
        vscode.postMessage({
            type: 'gotoTodo',
            todoRef: exchangeTodoRef,
        });
    });

    // Open in Editor button
    openInEditorBtn.addEventListener('click', () => {
        if (!selectedExchange) return;
        vscode.postMessage({
            type: 'openInEditor',
            exchangeId: selectedExchange.id,
            content: {
                userprompt: exchangeContent.prompt,
                answer: exchangeContent.answer,
            },
        });
    });

    // Open Externally button
    openExternallyBtn.addEventListener('click', () => {
        if (!selectedExchange) return;
        vscode.postMessage({
            type: 'openExternally',
            exchangeId: selectedExchange.id,
            content: {
                userprompt: exchangeContent.prompt,
                answer: exchangeContent.answer,
            },
        });
    });

    // Refresh button
    refreshBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'loadExchanges' });
    });

    // Handle messages from extension
    window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
            case 'exchanges':
                if (message.selectedFolder) {
                    selectedFolder = message.selectedFolder;
                    populateSubsystems();
                }
                exchanges = message.exchanges;
                renderExchanges();
                break;

            case 'exchangeContent':
                exchangeContent = {
                    prompt: message.content.userprompt || '',
                    answer: message.content.answer || '',
                };
                exchangeResponseValues = message.responseValues || null;
                exchangeTodoRef = message.todoRef || '';
                gotoTodoBtn.style.display = exchangeTodoRef ? 'flex' : 'none';
                renderContent();
                break;

            case 'refresh':
                if (Array.isArray(message.folderOptions)) {
                    folderOptions = message.folderOptions;
                }
                if (Array.isArray(message.subsystems)) {
                    subsystems = message.subsystems;
                }
                if (message.selectedSubsystem !== undefined) {
                    selectedSubsystem = message.selectedSubsystem;
                }
                if (message.selectedQuest !== undefined) {
                    selectedQuest = message.selectedQuest;
                }
                if (message.folder) {
                    selectedFolder = message.folder;
                }
                populateSubsystems();
                vscode.postMessage({ type: 'loadExchanges' });
                break;
        }
    });

    // Initial load
    vscode.postMessage({ type: 'loadExchanges' });

    // ── Splitter logic ──
    (function() {
        const sidebar = document.querySelector('.sidebar');
        const vSplitter = document.getElementById('vSplitter');
        let vDragging = false;
        vSplitter.addEventListener('mousedown', function(e) {
            vDragging = true;
            vSplitter.classList.add('dragging');
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (vDragging) {
                const newWidth = Math.max(180, Math.min(e.clientX, window.innerWidth - 300));
                sidebar.style.width = newWidth + 'px';
            }
        });
        document.addEventListener('mouseup', function() {
            if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
        });
    })();
})();
