// @ts-nocheck
/* global marked, mermaid, mdbBlocks, mdbAnswerMarkers, mdbInsertAnswer, mdbFoldHidden, mdbFoldAncestors, mdbIndentDepths */
// Markdown Browser client — extracted verbatim from the inline <script> of
// buildHtml() in src/handlers/markdownBrowser-handler.ts (Phase B.21 webview
// restructuring). Predates strict checkJs (large verbatim extraction).
//
// The shared document-picker script (getDocumentPickerScript()) used to be
// concatenated into the middle of this script; it is now a separate inline
// <script> after this file. Both reference the global `vscode` handle: this
// file acquires it once and publishes it as window.vscode so the picker IIFE
// (which uses a bare `vscode`) resolves to the same handle. marked + mermaid are
// loaded as external <script>s before this file and used as globals.
(function () {
    var vscode = acquireVsCodeApi();
    window.vscode = vscode; // shared with the document-picker inline <script>
    var __mdBrowserBooted = false;

    try {
        var backBtn = document.getElementById('backBtn');
        var forwardBtn = document.getElementById('forwardBtn');
        var openInEditorBtn = document.getElementById('openInEditorBtn');
        var openExternalBtn = document.getElementById('openExternalBtn');
        var reloadBtn = document.getElementById('reloadBtn');
        var reconnectBtn = document.getElementById('reconnectBtn');
        var fullIdBtn = document.getElementById('fullIdBtn');
        var crlfBtn = document.getElementById('crlfBtn');
        var editModeBtn = document.getElementById('editModeBtn');
        var foldAllBtn = document.getElementById('foldAllBtn');
        var foldLevelSelect = document.getElementById('foldLevelSelect');
        var foldLevelBtn = document.getElementById('foldLevelBtn');
        var indentBtn = document.getElementById('indentBtn');
        var indentSizeSelect = document.getElementById('indentSizeSelect');
        var contentArea = document.getElementById('contentArea');
        var filePathEl = document.getElementById('filePath');

        // Toggle state for the two heading extensions:
        //   fullIdMode: show the dotted full-id sub-line under every heading
        //     (pure CSS via body.show-fullid — no re-render needed).
        //   crlfMode: convert escaped/literal line breaks to real newlines.
        //     The conversion happens server-side, so toggling asks the backend
        //     to re-send the current file (see the 'setCrlf' message).
        var fullIdMode = false;
        var crlfMode = false;

        // In-place editing (answers, edit mode). The text the browser rendered
        // (`shownText`) keeps every line of the file in place unless CR/LF is
        // on, so its line numbers are the file's: blocks.js maps blocks and
        // `**Answer:**` markers to lines, and a save sends the line range, the
        // text that was there and the replacement (backend 'applyEdit').
        var editMode = false;
        var shownText = '';
        var openEditors = 0;
        var pendingContent = null;      // a same-file refresh held back while an editor is open
        var restoreScrollTop = null;    // where to stay after our own save re-renders
        var nextEditId = 1;
        var pendingSaves = {};          // editId -> editor element awaiting the backend's answer

        // Folding. Each heading has its own folded flag, kept by a key (level,
        // text, occurrence) so it survives re-renders of the same file; what
        // is hidden follows from the flags (blocks.js mdbFoldHidden), so
        // folding a section never changes the state of the headings inside it.
        var foldState = {};
        var foldFile = '';

        // Indentation by heading level: a heading at (level - 1) steps, its
        // section's content one step deeper; a step is `indentSize` spaces (ch).
        var indentOn = false;

        var currentFilePath = '';
        // liveMode + follow-tail state.
        //   liveMode: true when the panel was opened via
        //     tomAi.openInMdBrowserLive — enables the auto-scroll-to-
        //     bottom behavior below.
        //   followTail: sticky flag. Starts true (initial render has
        //     no prior scroll state); the user's scroll listener
        //     flips it off when they scroll away from the bottom and
        //     back on when they scroll back. Only when followTail
        //     is on do we auto-scroll after a content update.
        var liveMode = false;
        var followTail = true;
        var BOTTOM_THRESHOLD_PX = 48;

        function isNearBottom() {
            if (!contentArea) return true;
            var distanceFromBottom = contentArea.scrollHeight - contentArea.clientHeight - contentArea.scrollTop;
            return distanceFromBottom <= BOTTOM_THRESHOLD_PX;
        }

        function scrollToBottom() {
            if (!contentArea) return;
            contentArea.scrollTop = contentArea.scrollHeight;
        }

        // ---- Notify backend that webview is ready ----
        // (Backend will send groups and initial file content)
        setTimeout(function() {
            vscode.postMessage({ type: 'webviewReady' });
        }, 10);

        // ---- Navigation Buttons ----
        backBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'goBack' });
        });
        forwardBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'goForward' });
        });
        openInEditorBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openInEditor' });
        });
        openExternalBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openExternal' });
        });
        reloadBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'reload' });
        });
        if (reconnectBtn) {
            reconnectBtn.addEventListener('click', function() {
                // Re-attach the file watch on the backend and re-stick to the
                // tail, so a detached live-trail starts auto-updating again.
                followTail = true;
                vscode.postMessage({ type: 'reconnect' });
            });
        }

        // ---- Heading Toggles ----
        if (fullIdBtn) {
            fullIdBtn.addEventListener('click', function() {
                fullIdMode = !fullIdMode;
                document.body.classList.toggle('show-fullid', fullIdMode);
                fullIdBtn.classList.toggle('active', fullIdMode);
            });
        }
        if (editModeBtn) {
            editModeBtn.addEventListener('click', function() {
                editMode = !editMode;
                editModeBtn.classList.toggle('active', editMode);
                document.body.classList.toggle('mdb-edit-mode', editMode);
                decorateEditing();
            });
        }
        if (indentBtn) {
            indentBtn.addEventListener('click', function() {
                indentOn = !indentOn;
                indentBtn.classList.toggle('active', indentOn);
                applyIndent();
            });
        }
        if (indentSizeSelect) {
            indentSizeSelect.addEventListener('change', applyIndent);
        }
        if (foldAllBtn) {
            foldAllBtn.addEventListener('click', function() {
                var headings = foldEntries().filter(function(e) { return e.level !== null; });
                var fold = headings.some(function(e) { return !e.folded; });
                headings.forEach(function(e) { foldState[e.key] = fold; });
                applyFolding();
            });
        }
        if (foldLevelBtn && foldLevelSelect) {
            foldLevelBtn.addEventListener('click', function() {
                var level = Number(foldLevelSelect.value);
                var headings = foldEntries().filter(function(e) { return e.level === level; });
                var fold = headings.some(function(e) { return !e.folded; });
                headings.forEach(function(e) { foldState[e.key] = fold; });
                applyFolding();
            });
            foldLevelSelect.addEventListener('change', refreshFoldControls);
        }
        if (crlfBtn) {
            crlfBtn.addEventListener('click', function() {
                crlfMode = !crlfMode;
                crlfBtn.classList.toggle('active', crlfMode);
                // The backend owns the conversion; ask it to re-render the file.
                vscode.postMessage({ type: 'setCrlf', value: crlfMode });
            });
        }

        // ---- Heading Enhancement ----
        // The backend rewrote each heading into a capped (<=h6) markdown heading
        // carrying an invisible `.md-heading-meta` marker (data-level, data-fullid)
        // and a `.md-heading-id` badge. Promote the true level to a per-level
        // class (md-h1..md-h10) and build the toggle-able full-id sub-line.
        function enhanceHeadings() {
            if (!contentArea) return;
            var metas = contentArea.querySelectorAll('.md-heading-meta');
            for (var i = 0; i < metas.length; i++) {
                var meta = metas[i];
                var heading = meta.closest('h1, h2, h3, h4, h5, h6');
                var level = parseInt(meta.getAttribute('data-level') || '0', 10);
                var fullId = meta.getAttribute('data-fullid') || '';
                if (heading) {
                    heading.classList.add('md-heading');
                    if (level >= 1 && level <= 10) {
                        heading.classList.add('md-h' + level);
                    }
                    heading.setAttribute('data-level', String(level));
                    if (fullId) {
                        var sub = document.createElement('div');
                        sub.className = 'md-heading-fullid';
                        sub.textContent = fullId;
                        heading.insertAdjacentElement('afterend', sub);
                    }
                }
                if (meta.parentNode) meta.parentNode.removeChild(meta);
            }
        }

        // ---- Render Markdown ----
        // Rendered block by block, each top-level block in a `.mdb-block`
        // wrapper carrying its line range, so the editing controls can find
        // the source lines of what is on screen.
        var shownBlocks = [];
        function renderMarkdown(text) {
            shownBlocks = [];
            if (typeof marked !== 'undefined' && marked.lexer && marked.parser) {
                // With CR/LF on, render single newlines as hard <br> breaks
                // (marked `breaks`). Block structure (lists, headings, tables)
                // is parsed first, so enumerations are not affected.
                var options = { breaks: crlfMode };
                var tokens = marked.lexer(text || '', options);
                var byIndex = {};
                mdbBlocks(text || '', tokens).forEach(function(b) { byIndex[b.index] = b; });
                var html = '';
                for (var i = 0; i < tokens.length; i++) {
                    var one = [tokens[i]];
                    one.links = tokens.links;
                    var rendered = marked.parser(one, options);
                    var block = byIndex[i];
                    if (block) {
                        html += '<div class="mdb-block" data-block="' + shownBlocks.length + '">' + rendered + '</div>';
                        shownBlocks.push(block);
                    } else {
                        html += rendered;
                    }
                }
                return html;
            }
            return '<pre>' + escapeHtml(text || '') + '</pre>';
        }

        function shownLines() {
            return shownText.replace(/\r\n|\r/g, '\n').split('\n');
        }

        // ---- Folding ----
        /** The heading a top-level element of the content is, or null. */
        function headingIn(child) {
            if (!child || !child.children) { return null; }
            if (/^H[1-6]$/.test(child.tagName)) { return child; }
            for (var i = 0; i < child.children.length; i++) {
                if (/^H[1-6]$/.test(child.children[i].tagName)) { return child.children[i]; }
            }
            return null;
        }

        function headingLevel(h) {
            return parseInt(h.getAttribute('data-level') || '', 10) || parseInt(h.tagName.slice(1), 10);
        }

        /** The content as fold entries: every top-level element, headings with their level and flag. */
        function foldEntries() {
            if (!contentArea) { return []; }
            return Array.prototype.map.call(contentArea.children, function(el) {
                var h = headingIn(el);
                if (!h || !h.dataset.foldKey) { return { level: null, folded: false, el: el }; }
                return { level: headingLevel(h), folded: foldState[h.dataset.foldKey] === true, el: el, heading: h, key: h.dataset.foldKey };
            });
        }

        function applyFolding() {
            var entries = foldEntries();
            var hidden = mdbFoldHidden(entries);
            entries.forEach(function(e, i) {
                e.el.classList.toggle('mdb-folded-away', hidden[i]);
                if (e.heading) {
                    var icon = e.heading.querySelector('.mdb-fold-btn .codicon');
                    if (icon) { icon.className = 'codicon codicon-' + (e.folded ? 'chevron-right' : 'chevron-down'); }
                    e.heading.classList.toggle('mdb-heading-folded', e.folded);
                }
            });
            refreshFoldControls();
        }

        /** The level dropdown lists the levels the document has; the buttons say what a click does. */
        function refreshFoldControls() {
            var headings = foldEntries().filter(function(e) { return e.level !== null; });
            if (foldAllBtn) {
                var foldAll = headings.some(function(e) { return !e.folded; });
                foldAllBtn.innerHTML = '<span class="codicon codicon-' + (foldAll ? 'collapse-all' : 'expand-all') + '"></span>';
                foldAllBtn.title = foldAll ? 'Fold all sections' : 'Unfold all sections';
                foldAllBtn.disabled = headings.length === 0;
            }
            if (!foldLevelSelect || !foldLevelBtn) { return; }
            var levels = [];
            headings.forEach(function(e) { if (levels.indexOf(e.level) < 0) { levels.push(e.level); } });
            levels.sort(function(a, b) { return a - b; });
            var current = Number(foldLevelSelect.value);
            if (foldLevelSelect.options.length !== levels.length
                || levels.some(function(l, i) { return Number(foldLevelSelect.options[i].value) !== l; })) {
                foldLevelSelect.innerHTML = levels.map(function(l) { return '<option value="' + l + '">H' + l + '</option>'; }).join('');
                var keep = levels.indexOf(current) >= 0 ? current : (levels.indexOf(2) >= 0 ? 2 : levels[0]);
                if (keep !== undefined) { foldLevelSelect.value = String(keep); }
            }
            var level = Number(foldLevelSelect.value);
            var atLevel = headings.filter(function(e) { return e.level === level; });
            var foldLevel = atLevel.some(function(e) { return !e.folded; });
            foldLevelBtn.innerHTML = '<span class="codicon codicon-' + (foldLevel ? 'fold' : 'unfold') + '"></span>';
            foldLevelBtn.title = (foldLevel ? 'Fold' : 'Unfold') + ' all level ' + (level || '?') + ' headings';
            foldLevelBtn.disabled = atLevel.length === 0;
            foldLevelSelect.disabled = levels.length === 0;
        }

        /** Give every heading its key and triangle, keep the flags of a re-rendered same file. */
        function setupFolding(sameFile) {
            if (!sameFile || foldFile !== currentFilePath) {
                foldState = {};
                foldFile = currentFilePath;
            }
            var seen = {};
            Array.prototype.forEach.call(contentArea ? contentArea.children : [], function(el) {
                var h = headingIn(el);
                if (!h) { return; }
                var base = headingLevel(h) + '|' + (h.textContent || '').trim();
                seen[base] = (seen[base] || 0) + 1;
                var key = base + '#' + seen[base];
                h.dataset.foldKey = key;
                var btn = document.createElement('button');
                btn.className = 'mdb-fold-btn';
                btn.title = 'Fold / unfold this section';
                btn.innerHTML = '<span class="codicon codicon-chevron-down"></span>';
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    foldState[key] = !(foldState[key] === true);
                    applyFolding();
                });
                h.insertBefore(btn, h.firstChild);
            });
            applyFolding();
        }

        function applyIndent() {
            var entries = foldEntries();
            var depths = mdbIndentDepths(entries);
            var size = Number(indentSizeSelect ? indentSizeSelect.value : 2) || 2;
            entries.forEach(function(e, i) {
                e.el.style.marginLeft = indentOn ? (depths[i] * size) + 'ch' : '';
            });
        }

        /** Unfold the sections an element sits in, so it can be seen. */
        function revealElement(target) {
            if (!contentArea || !target) { return; }
            var top = target;
            while (top && top.parentNode !== contentArea) { top = top.parentNode; }
            var entries = foldEntries();
            var index = entries.findIndex(function(e) { return e.el === top; });
            if (index < 0) { return; }
            var opened = mdbFoldAncestors(entries, index);
            if (opened.length === 0) { return; }
            opened.forEach(function(i) { foldState[entries[i].key] = false; });
            applyFolding();
        }

        // ---- In-place editing ----
        // An editor: a 5-line textarea (resizable) with Save / Discard. The
        // button that opened it is hidden while it is open.
        function openEditor(trigger, placeAfter, initial, buildEdit) {
            var box = document.createElement('div');
            box.className = 'mdb-editor';
            var area = document.createElement('textarea');
            area.rows = 5;
            area.value = initial;
            var bar = document.createElement('div');
            bar.className = 'mdb-editor-bar';
            var save = document.createElement('button');
            save.className = 'mdb-editor-btn';
            save.title = 'Save into the document';
            save.innerHTML = '<span class="codicon codicon-check"></span> Save';
            var discard = document.createElement('button');
            discard.className = 'mdb-editor-btn';
            discard.title = 'Discard';
            discard.innerHTML = '<span class="codicon codicon-close"></span> Discard';
            var status = document.createElement('span');
            status.className = 'mdb-editor-status';
            bar.appendChild(save);
            bar.appendChild(discard);
            bar.appendChild(status);
            box.appendChild(area);
            box.appendChild(bar);
            placeAfter.insertAdjacentElement('afterend', box);
            // Line up with the block it edits when the document is indented.
            if (placeAfter.parentNode === contentArea) { box.style.marginLeft = placeAfter.style.marginLeft; }
            trigger.style.display = 'none';
            openEditors++;
            area.focus();

            function close() {
                if (!box.parentNode) { return; }
                box.parentNode.removeChild(box);
                trigger.style.display = '';
                openEditors = Math.max(0, openEditors - 1);
                if (openEditors === 0 && pendingContent) {
                    var held = pendingContent;
                    pendingContent = null;
                    handleContent(held);
                }
            }
            discard.addEventListener('click', function(e) { e.stopPropagation(); close(); });
            save.addEventListener('click', function(e) {
                e.stopPropagation();
                var edit = buildEdit(area.value);
                if (!edit) { close(); return; }
                var id = nextEditId++;
                pendingSaves[id] = { close: close, status: status };
                status.textContent = 'Saving…';
                restoreScrollTop = contentArea.scrollTop;
                vscode.postMessage({
                    type: 'applyEdit', editId: id, filePath: currentFilePath,
                    startLine: edit.startLine, endLine: edit.endLine, expected: edit.expected, replacement: edit.replacement,
                });
            });
        }

        function iconButton(cls, icon, title) {
            var b = document.createElement('button');
            b.className = 'mdb-inline-btn ' + cls;
            b.title = title;
            b.innerHTML = '<span class="codicon codicon-' + icon + '"></span>';
            return b;
        }

        // Answer buttons after every `**Answer:**` marker, and in edit mode an
        // edit + insert button at the end of every editable block. None with
        // CR/LF on: its conversion moves lines, so they no longer match the file.
        function decorateEditing() {
            if (!contentArea) { return; }
            var old = contentArea.querySelectorAll('.mdb-answer-btn, .mdb-block-actions');
            for (var i = 0; i < old.length; i++) { old[i].parentNode.removeChild(old[i]); }
            if (crlfMode || !shownText) {
                if (editModeBtn) { editModeBtn.title = editMode ? 'Edit mode (turn CR/LF off to edit)' : 'Edit mode: edit or extend paragraphs in place'; }
                return;
            }
            if (editModeBtn) { editModeBtn.title = 'Edit mode: edit or extend paragraphs in place'; }
            var lines = shownLines();
            var wrappers = contentArea.querySelectorAll('.mdb-block');

            // Answers: the k-th marker of a block is its k-th <strong>Answer:</strong>.
            var perBlock = {};
            mdbAnswerMarkers(shownText).forEach(function(m) {
                for (var b = 0; b < shownBlocks.length; b++) {
                    if (m.line >= shownBlocks[b].startLine && m.line < shownBlocks[b].endLine) {
                        (perBlock[b] = perBlock[b] || []).push(m);
                        return;
                    }
                }
            });
            Object.keys(perBlock).forEach(function(b) {
                var wrapper = wrappers[Number(b)];
                if (!wrapper) { return; }
                var strongs = Array.prototype.filter.call(wrapper.querySelectorAll('strong'), function(s) {
                    return (s.textContent || '').trim() === 'Answer:';
                });
                perBlock[b].forEach(function(m, k) {
                    var strong = strongs[k];
                    if (!strong) { return; }
                    var btn = iconButton('mdb-answer-btn', 'comment', 'Write the answer here');
                    strong.insertAdjacentElement('afterend', btn);
                    btn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        openEditor(btn, btn, '', function(value) {
                            if (!value.trim()) { return null; }
                            return {
                                startLine: m.line, endLine: m.line + 1, expected: lines[m.line],
                                replacement: mdbInsertAnswer(lines[m.line], m.column, value),
                            };
                        });
                    });
                });
            });

            if (!editMode) { return; }
            for (var w = 0; w < wrappers.length; w++) {
                (function(wrapper, block) {
                    if (!block || !block.editable) { return; }
                    var source = lines.slice(block.startLine, block.endLine).join('\n');
                    var actions = document.createElement('div');
                    actions.className = 'mdb-block-actions';
                    var editBtn = iconButton('mdb-edit-btn', 'edit', 'Edit this paragraph (source)');
                    var insertBtn = iconButton('mdb-insert-btn', 'add', 'Insert text at the end of this paragraph');
                    actions.appendChild(editBtn);
                    actions.appendChild(insertBtn);
                    wrapper.appendChild(actions);
                    editBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        openEditor(actions, wrapper, source, function(value) {
                            if (value === source) { return null; }
                            return { startLine: block.startLine, endLine: block.endLine, expected: source, replacement: value };
                        });
                    });
                    insertBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        openEditor(actions, wrapper, '', function(value) {
                            if (!value) { return null; }
                            return { startLine: block.startLine, endLine: block.endLine, expected: source, replacement: source + value };
                        });
                    });
                })(wrappers[w], shownBlocks[w]);
            }
        }

        function escapeHtml(text) {
            var div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ---- Anchor Scrolling ----
        function scrollToAnchor(anchor) {
            if (!anchor || !contentArea) return false;

            // Try finding element by ID first (standard anchor)
            var target = document.getElementById(anchor);

            // If not found, try common heading ID patterns generated by marked.js
            if (!target) {
                // marked.js generates IDs by lowercasing and replacing spaces/special chars
                var normalizedAnchor = anchor.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
                target = document.getElementById(normalizedAnchor);
            }

            // Try finding by heading text content
            if (!target) {
                var headings = contentArea.querySelectorAll('h1, h2, h3, h4, h5, h6');
                for (var i = 0; i < headings.length; i++) {
                    var h = headings[i];
                    var headingId = h.id || '';
                    var headingText = (h.textContent || '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
                    if (headingId === anchor || headingText === anchor || headingText === anchor.toLowerCase()) {
                        target = h;
                        break;
                    }
                }
            }

            if (target) {
                revealElement(target);
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Add a brief highlight effect
                target.style.transition = 'background-color 0.3s';
                target.style.backgroundColor = 'var(--vscode-editor-findMatchHighlightBackground)';
                setTimeout(function() {
                    target.style.backgroundColor = '';
                }, 1500);
                return true;
            }
            return false;
        }

        function initMermaid() {
            if (typeof mermaid === 'undefined' || !contentArea) return;
            try {
                contentArea.querySelectorAll('pre > code.language-mermaid').forEach(function(codeEl) {
                    var pre = codeEl.parentElement;
                    if (!pre || !pre.parentElement) return;
                    var mermaidDiv = document.createElement('div');
                    mermaidDiv.className = 'mermaid';
                    mermaidDiv.textContent = codeEl.textContent || '';
                    pre.parentElement.replaceChild(mermaidDiv, pre);
                });
                mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
                mermaid.run({ nodes: contentArea.querySelectorAll('.mermaid') });
            } catch (err) {
                console.error('Mermaid render failed', err);
            }
        }

        // ---- Link Click Handling ----
        function interceptLinks() {
            if (!contentArea) return;
            contentArea.querySelectorAll('a[href]').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    var href = link.getAttribute('href') || '';
                    if (!href) return;

                    // Skip external URLs
                    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
                        return;
                    }

                    vscode.postMessage({ type: 'navigateLink', href: href });
                });
            });
        }

        function handleContent(msg) {
            // A refresh of the same file while an editor is open would throw the
            // typed text away: hold it until the last editor closes.
            if (openEditors > 0 && msg.filePath === currentFilePath && !msg.error) {
                pendingContent = msg;
                return;
            }
            if (msg.error) {
                contentArea.innerHTML = '<div class="empty-state error-state">'
                    + '<span class="codicon codicon-error"></span>'
                    + '<div>' + escapeHtml(msg.error) + '</div>'
                    + '</div>';
                filePathEl.textContent = 'Error';
            } else {
                var prevFilePath = currentFilePath;
                var incomingFilePath = msg.filePath || '';
                var sameFile = !!prevFilePath && prevFilePath === incomingFilePath;
                var incomingLiveMode = msg.liveMode === true;

                // Sample follow-tail *before* we replace the DOM,
                // otherwise scrollTop is meaningless. We only trust
                // the sample when it's a re-render of the same
                // file — a navigation to a different file resets
                // followTail to true so the view starts at the
                // bottom (live) or top (normal) rather than
                // wherever the previous file happened to be.
                if (sameFile) {
                    followTail = isNearBottom();
                } else {
                    followTail = true;
                }

                liveMode = incomingLiveMode;
                currentFilePath = incomingFilePath;
                // Persist enough to restore this panel after a window reload
                // (the backend's WebviewPanelSerializer reads filePath +
                // liveMode back from here in deserializeWebviewPanel).
                if (incomingFilePath) {
                    vscode.setState({ filePath: incomingFilePath, liveMode: liveMode });
                }
                // The backend is authoritative for CR/LF state; sync the
                // local flag + button so a reload/restore renders correctly.
                if (typeof msg.crlf === 'boolean') {
                    crlfMode = msg.crlf;
                    if (crlfBtn) crlfBtn.classList.toggle('active', crlfMode);
                }
                filePathEl.textContent = msg.relativePath || msg.fileName || '';
                shownText = msg.content || '';
                contentArea.innerHTML = renderMarkdown(shownText);
                enhanceHeadings();
                initMermaid();
                interceptLinks();
                decorateEditing();
                setupFolding(sameFile);
                applyIndent();
                if (sameFile && restoreScrollTop !== null) {
                    // Our own save re-rendered the document: stay where the
                    // reader was, also once Mermaid has resized the page.
                    var keep = restoreScrollTop;
                    restoreScrollTop = null;
                    contentArea.scrollTop = keep;
                    requestAnimationFrame(function() { contentArea.scrollTop = keep; });
                    return;
                }

                // Handle anchor scrolling after content loads
                if (msg.anchor) {
                    // Small delay to ensure DOM is ready
                    setTimeout(function() {
                        scrollToAnchor(msg.anchor);
                    }, 50);
                } else if (liveMode && followTail) {
                    // Layout may not be final yet (Mermaid blocks
                    // can resize the doc after they render). Wait
                    // a frame so scrollHeight reflects the new
                    // content, then pin to the bottom.
                    requestAnimationFrame(function() {
                        scrollToBottom();
                    });
                } else if (!sameFile) {
                    // Different file and not following: start at
                    // the top, matching the previous behavior.
                    contentArea.scrollTop = 0;
                }
                // Same-file re-render without live follow: leave
                // scrollTop alone so the user's reading position
                // is preserved.
            }
        }

        // ---- Message Handling ----
        window.addEventListener('message', function(e) {
            var msg = e.data;
            if (!msg || !msg.type) return;

            if (msg.type === 'mdContent') {
                handleContent(msg);
            } else if (msg.type === 'editResult') {
                var saved = pendingSaves[msg.editId];
                delete pendingSaves[msg.editId];
                if (saved) {
                    if (msg.ok) {
                        saved.close();
                    } else {
                        restoreScrollTop = null;
                        saved.status.textContent = msg.error || 'Could not save.';
                        saved.status.classList.add('error');
                    }
                }
            } else if (msg.type === 'navState') {
                backBtn.disabled = !msg.canGoBack;
                forwardBtn.disabled = !msg.canGoForward;
            } else if (msg.type === 'scrollToAnchor') {
                // Scroll to anchor within current document
                if (msg.anchor) {
                    scrollToAnchor(msg.anchor);
                }
            } else if (msg.type === 'reconnected') {
                // Backend re-attached the watch and pushed fresh content; pin to
                // the tail and briefly flash the button so the user sees it worked.
                followTail = true;
                if (msg.liveMode) {
                    requestAnimationFrame(function() { scrollToBottom(); });
                }
                if (reconnectBtn) {
                    reconnectBtn.classList.add('reconnect-ok');
                    setTimeout(function() { reconnectBtn.classList.remove('reconnect-ok'); }, 800);
                }
            }
        });

        __mdBrowserBooted = true;
    } catch (err) {
        console.error('[MdBrowser] Boot error:', err);
        document.body.innerHTML = '<div style="padding:20px;color:red;">MD Browser failed to initialize: ' + err + '</div>';
    }
})();
