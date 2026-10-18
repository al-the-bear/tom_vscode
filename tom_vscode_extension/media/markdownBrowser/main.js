// @ts-nocheck
/* global marked, mermaid, MDB_ANSWER_MARKER, mdbBlocks, mdbAnswerMarkers, mdbInsertAnswer, mdbFoldHidden, mdbFoldAncestors, mdbIndentDepths, mdbGroups */
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
        // The rendered document lives in one element inside the scroll area.
        // A full render swaps that element for a new one in a single step:
        // removing a large rendered tree node by node can stall Chrome for
        // minutes once anything in it has had focus (measured on a 6 MB file).
        var docRoot = document.createElement('div');
        docRoot.className = 'mdb-doc';
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
        var shownCrlf = false;          // the CR/LF mode shownText was rendered with
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
                redecorateAll();
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
        function enhanceHeadings(root) {
            root = root || docRoot;
            if (!root) return;
            var metas = root.querySelectorAll('.md-heading-meta');
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
        // Each top-level block is wrapped in a `.mdb-block` element; the block
        // (its line range) and its wrapper are kept side by side in
        // shownBlocks / shownWrappers, so the editing controls can find the
        // source lines of what is on screen and a save can patch one region.
        var shownBlocks = [];
        var shownWrappers = [];
        var shownLinks = {};
        var shownLinesCache = null;
        var renderGen = 0;
        /** Blocks per batch of a chunked render: each batch is built off-DOM, then the event loop gets a turn. */
        var RENDER_CHUNK = 1500;

        /** marked's options: its defaults (GFM: tables, strikethrough, ...) plus `breaks` for CR/LF. */
        function markedOptions() {
            var base = (typeof marked !== 'undefined' && marked.defaults) ? marked.defaults : {};
            return Object.assign({}, base, { breaks: crlfMode });
        }

        function shownLines() {
            if (!shownLinesCache) { shownLinesCache = shownText.replace(/\r\n|\r/g, '\n').split('\n'); }
            return shownLinesCache;
        }

        /**
         * The render pieces of `text`: one per group of tokens (an html run that
         * opens an element is one group), each with its HTML and its block
         * (null for pieces with no source lines, e.g. whitespace). Line numbers
         * are shifted by `lineOffset` (a region rendered on its own).
         */
        function buildPieces(text, lineOffset) {
            var options = markedOptions();
            var tokens = marked.lexer(text || '', options);
            var byIndex = {};
            mdbBlocks(text || '', tokens).forEach(function(b) {
                b.startLine += lineOffset;
                b.endLine += lineOffset;
                byIndex[b.index] = b;
            });
            var links = Object.assign({}, shownLinks, tokens.links || {});
            var pieces = [];
            mdbGroups(tokens).forEach(function(range) {
                var group = tokens.slice(range[0], range[1] + 1);
                group.links = links;
                var html = marked.parser(group, options);
                var first = null;
                var last = null;
                for (var i = range[0]; i <= range[1]; i++) {
                    if (byIndex[i]) { first = first || byIndex[i]; last = byIndex[i]; }
                }
                var block = !first ? null : (range[0] === range[1] ? first : {
                    index: first.index, type: 'group', startLine: first.startLine, endLine: last.endLine, editable: false,
                });
                pieces.push({ html: html, block: block, hasHtml: group.some(function(tk) { return tk.type === 'html'; }) });
            });
            return { pieces: pieces, links: tokens.links || {} };
        }

        /** Turn pieces into DOM nodes in a detached holder; returns the holder and the wrappers made. */
        function piecesToNodes(pieces) {
            var holder = document.createElement('div');
            holder.innerHTML = pieces.map(function(p) {
                return p.block ? '<div class="mdb-block">' + p.html + '</div>' : p.html;
            }).join('');
            var wrappers = [];
            var blocks = [];
            var k = 0;
            Array.prototype.forEach.call(holder.children, function(el) {
                if (el.classList && el.classList.contains('mdb-block')) {
                    while (k < pieces.length && !pieces[k].block) { k++; }
                    wrappers.push(el);
                    blocks.push(pieces[k].block);
                    k++;
                }
            });
            return { holder: holder, wrappers: wrappers, blocks: blocks };
        }

        /** Everything a freshly built set of nodes needs before it is shown. */
        function processNodes(holder, wrappers, blocks, foldSeen) {
            enhanceHeadings(holder);
            interceptLinks(holder);
            assignFoldKeys(holder, foldSeen);
            decorateWrappers(wrappers, blocks);
        }

        function newDocRoot() {
            var el = document.createElement('div');
            el.className = 'mdb-doc';
            return el;
        }

        /** Put `fresh` in place of the shown document (or of an error / empty state). */
        function showDocRoot(fresh) {
            if (docRoot.parentNode === contentArea) {
                contentArea.replaceChild(fresh, docRoot);
            } else {
                contentArea.textContent = '';
                contentArea.appendChild(fresh);
            }
            docRoot = fresh;
        }

        /**
         * Render `text` in batches: each batch is built and processed off-DOM,
         * then the event loop gets a turn, so a large document never blocks the
         * window. The finished content replaces the old in one step; `done`
         * runs after that (folding, indentation, scroll position).
         */
        function renderDocument(text, done) {
            var gen = ++renderGen;
            shownLinks = {};
            var built;
            try {
                if (typeof marked === 'undefined' || !marked.lexer || !marked.parser) {
                    var plain = newDocRoot();
                    plain.innerHTML = '<pre>' + escapeHtml(text || '') + '</pre>';
                    showDocRoot(plain);
                    shownBlocks = [];
                    shownWrappers = [];
                    done();
                    return;
                }
                built = buildPieces(text, 0);
            } catch (err) {
                contentArea.innerHTML = '<div class="empty-state error-state"><div>' + escapeHtml(String(err)) + '</div></div>';
                return;
            }
            shownLinks = built.links;
            var pieces = built.pieces;
            var frag = document.createDocumentFragment();
            var blocks = [];
            var wrappers = [];
            var foldSeen = {};
            var at = 0;
            var big = pieces.length > RENDER_CHUNK;
            var renderedEditMode = editMode;
            contentArea.setAttribute('aria-busy', 'true');
            function step() {
                if (gen !== renderGen) { return; }   // a newer render started
                var slice = pieces.slice(at, at + RENDER_CHUNK);
                at += slice.length;
                var nodes = piecesToNodes(slice);
                processNodes(nodes.holder, nodes.wrappers, nodes.blocks, foldSeen);
                Array.prototype.push.apply(wrappers, nodes.wrappers);
                Array.prototype.push.apply(blocks, nodes.blocks);
                while (nodes.holder.firstChild) { frag.appendChild(nodes.holder.firstChild); }
                if (at < pieces.length) {
                    if (filePathEl && big) { filePathEl.setAttribute('data-progress', Math.round(100 * at / pieces.length) + '%'); }
                    setTimeout(step, 0);
                    return;
                }
                if (filePathEl) { filePathEl.removeAttribute('data-progress'); }
                shownBlocks = blocks;
                shownWrappers = wrappers;
                var fresh = newDocRoot();
                // A large document lays out only the blocks on screen
                // (style.css: content-visibility on .mdb-large blocks).
                fresh.classList.toggle('mdb-large', big);
                fresh.appendChild(frag);
                showDocRoot(fresh);
                contentArea.removeAttribute('aria-busy');
                // Edit mode switched while the batches ran: some have the old controls.
                if (editMode !== renderedEditMode) { redecorateAll(); }
                done();
            }
            // A large document's lexing was this task's work; the batches start in the next one.
            if (big) { setTimeout(step, 0); } else { step(); }
        }

        /**
         * After our own save: apply the edit to the shown text and re-render only
         * the region it touched (the edited block and the one before it, which
         * an edit may merge into), instead of the whole document. Returns false
         * when the edit cannot be patched in place (it adds a heading, a fence
         * or html, or CR/LF is on) — the full render that follows then applies.
         */
        function patchAfterSave(edit) {
            if (crlfMode || typeof marked === 'undefined') { return false; }
            if (/^ {0,3}(#|`{3}|~{3})|<[a-zA-Z/!]/m.test(edit.replacement)) { return false; }
            var lines = shownLines().slice();
            var eol = shownText.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
            var newPart = edit.replacement.replace(/\r\n|\r/g, '\n').split('\n');
            var delta = newPart.length - (edit.endLine - edit.startLine);
            // The blocks the edit touches, and the one before them.
            var first = -1;
            var last = -1;
            for (var i = 0; i < shownBlocks.length; i++) {
                var b = shownBlocks[i];
                if (b.endLine > edit.startLine && b.startLine < Math.max(edit.endLine, edit.startLine + 1)) {
                    if (first < 0) { first = i; }
                    last = i;
                }
            }
            if (first < 0) { return false; }
            if (shownBlocks.slice(first, last + 1).some(function(bl) { return bl.type === 'group' || bl.type === 'heading'; })) { return false; }
            var from = first > 0 && shownBlocks[first - 1].type !== 'group' && shownBlocks[first - 1].type !== 'heading' ? first - 1 : first;
            var regionStart = Math.min(shownBlocks[from].startLine, edit.startLine);
            var regionEnd = Math.max(shownBlocks[last].endLine, edit.endLine) + delta;
            Array.prototype.splice.apply(lines, [edit.startLine, edit.endLine - edit.startLine].concat(newPart));
            // The region must stand on its own: blank lines (or the document's
            // ends) on both sides, so lexing it alone reads it as in context.
            // An ATX heading is one line and ends whatever is before it, so it
            // bounds a region as well as a blank line does.
            var bounds = function(l) { return l === undefined || l.trim() === '' || /^ {0,3}#{1,6}(\s|$)/.test(l); };
            if (!bounds(lines[regionStart - 1]) || !bounds(lines[regionEnd])) { return false; }
            var region = lines.slice(regionStart, regionEnd).join('\n');
            var built = buildPieces(region, regionStart);
            if (built.pieces.some(function(p) { return p.hasHtml || (p.block && (p.block.type === 'heading' || p.block.type === 'group')); })) { return false; }
            var nodes = piecesToNodes(built.pieces);
            processNodes(nodes.holder, nodes.wrappers, nodes.blocks, {});
            // Swap the old wrappers (and anything between them) for the new nodes.
            var oldFirst = shownWrappers[from];
            var oldLast = shownWrappers[last];
            var anchor = oldLast.nextSibling;
            var parent = oldFirst.parentNode;
            for (var n = oldFirst; n && n !== anchor;) {
                var next = n.nextSibling;
                parent.removeChild(n);
                n = next;
            }
            var marginLeft = oldFirst.style.marginLeft;
            var hidden = oldFirst.classList.contains('mdb-folded-away');
            while (nodes.holder.firstChild) {
                var node = nodes.holder.firstChild;
                if (node.nodeType === 1) {
                    if (marginLeft) { node.style.marginLeft = marginLeft; }
                    if (hidden) { node.classList.add('mdb-folded-away'); }
                }
                parent.insertBefore(node, anchor);
            }
            // The blocks after the region move by `delta` lines.
            for (var j = last + 1; j < shownBlocks.length; j++) {
                shownBlocks[j].startLine += delta;
                shownBlocks[j].endLine += delta;
            }
            Array.prototype.splice.apply(shownBlocks, [from, last - from + 1].concat(nodes.blocks));
            Array.prototype.splice.apply(shownWrappers, [from, last - from + 1].concat(nodes.wrappers));
            shownText = lines.join(eol);
            shownLinesCache = null;
            return true;
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
            return Array.prototype.map.call(docRoot.children, function(el) {
                var h = headingIn(el);
                if (!h || !h.dataset.foldKey) { return { level: null, folded: false, el: el }; }
                return { level: headingLevel(h), folded: foldState[h.dataset.foldKey] === true, el: el, heading: h, key: h.dataset.foldKey };
            });
        }

        function applyFolding() {
            var entries = foldEntries();
            var hidden = mdbFoldHidden(entries);
            // Only elements whose state changes are touched: on a fresh render
            // with nothing folded, that is none of them.
            entries.forEach(function(e, i) {
                if (e.el.classList.contains('mdb-folded-away') !== hidden[i]) {
                    e.el.classList.toggle('mdb-folded-away', hidden[i]);
                }
                if (e.heading && e.heading.classList.contains('mdb-heading-folded') !== e.folded) {
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

        var foldButtonTemplate = document.createElement('button');
        foldButtonTemplate.className = 'mdb-fold-btn';
        foldButtonTemplate.title = 'Fold / unfold this section';
        foldButtonTemplate.innerHTML = '<span class="codicon codicon-chevron-down"></span>';
        if (contentArea) {
            contentArea.addEventListener('click', function(e) {
                var btn = e.target && e.target.closest ? e.target.closest('.mdb-fold-btn') : null;
                if (!btn || !btn.parentElement) { return; }
                var key = btn.parentElement.dataset.foldKey;
                if (!key) { return; }
                e.stopPropagation();
                e.preventDefault();
                foldState[key] = !(foldState[key] === true);
                applyFolding();
            });
        }

        /** Give every heading among `root`'s top-level elements its key and triangle; `seen` counts repeats across batches. */
        function assignFoldKeys(root, seen) {
            Array.prototype.slice.call(root.children).forEach(function(el) {
                var h = headingIn(el);
                if (!h || h.dataset.foldKey) { return; }
                var base = headingLevel(h) + '|' + (h.textContent || '').trim();
                seen[base] = (seen[base] || 0) + 1;
                h.dataset.foldKey = base + '#' + seen[base];
                // One template cloned per heading; clicks are handled by one
                // delegated listener on the content area.
                h.insertBefore(foldButtonTemplate.cloneNode(true), h.firstChild);
            });
        }

        /** After a full render: keep the flags of a re-rendered same file, apply them only if any are set. */
        function finishFolding(sameFile) {
            if (!sameFile || foldFile !== currentFilePath) {
                foldState = {};
                foldFile = currentFilePath;
            }
            var anyFolded = Object.keys(foldState).some(function(k) { return foldState[k] === true; });
            if (anyFolded) { applyFolding(); } else { refreshFoldControls(); }
        }

        var indentApplied = false;      // whether the current render carries indent styles
        function applyIndent() {
            if (!indentOn && !indentApplied) { return; }
            indentApplied = indentOn;
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
            while (top && top.parentNode !== docRoot) { top = top.parentNode; }
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
            if (placeAfter.parentNode === docRoot) { box.style.marginLeft = placeAfter.style.marginLeft; }
            trigger.style.display = 'none';
            openEditors++;
            area.focus();

            function close() {
                if (!box.parentNode) { return; }
                area.blur();
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
                pendingSaves[id] = { close: close, status: status, edit: edit };
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
        // The source a button works on is read when it is clicked, so a block
        // keeps working after an edit elsewhere moved its lines.
        function decorateWrappers(wrappers, blocks) {
            if (editModeBtn) {
                editModeBtn.title = crlfMode && editMode ? 'Edit mode (turn CR/LF off to edit)' : 'Edit mode: edit or extend paragraphs in place';
            }
            if (crlfMode || !shownText) { return; }
            for (var w = 0; w < wrappers.length; w++) {
                decorateWrapper(wrappers[w], blocks[w]);
            }
        }

        function redecorateAll() {
            var old = contentArea.querySelectorAll('.mdb-answer-btn, .mdb-block-actions');
            for (var i = 0; i < old.length; i++) { old[i].parentNode.removeChild(old[i]); }
            decorateWrappers(shownWrappers, shownBlocks);
        }

        function decorateWrapper(wrapper, block) {
            if (!block) { return; }
            // Answers: the k-th marker of a block is its k-th <strong>Answer:</strong>.
            var strongs = null;
            var markerIndex = 0;
            var lines = null;
            for (var line = block.startLine; line < block.endLine; line++) {
                lines = lines || shownLines();
                if (lines[line] === undefined || lines[line].indexOf(MDB_ANSWER_MARKER) < 0) { continue; }
                var markers = mdbAnswerMarkers(lines[line]);
                for (var k = 0; k < markers.length; k++) {
                    strongs = strongs || Array.prototype.filter.call(wrapper.querySelectorAll('strong'), function(s) {
                        return (s.textContent || '').trim() === 'Answer:';
                    });
                    var strong = strongs[markerIndex++];
                    if (strong) { addAnswerButton(strong, block, line - block.startLine, markers[k].column); }
                }
            }
            if (!editMode || !block.editable) { return; }
            var actions = document.createElement('div');
            actions.className = 'mdb-block-actions';
            var editBtn = iconButton('mdb-edit-btn', 'edit', 'Edit this paragraph (source, with the blank line before it)');
            var insertBtn = iconButton('mdb-insert-btn', 'add', 'Insert text at the end of this paragraph');
            actions.appendChild(editBtn);
            actions.appendChild(insertBtn);
            wrapper.appendChild(actions);
            editBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                var lines = shownLines();
                // The blank lines before the block belong to the edit, so
                // removing the leading newline merges it with the block before.
                var index = shownBlocks.indexOf(block);
                var floor = index > 0 ? shownBlocks[index - 1].endLine : 0;
                var start = block.startLine;
                while (start > floor && lines[start - 1].trim() === '') { start--; }
                var source = lines.slice(start, block.endLine).join('\n');
                openEditor(actions, wrapper, source, function(value) {
                    if (value === source) { return null; }
                    return { startLine: start, endLine: block.endLine, expected: source, replacement: value };
                });
            });
            insertBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                openEditor(actions, wrapper, '', function(value) {
                    if (!value) { return null; }
                    var source = shownLines().slice(block.startLine, block.endLine).join('\n');
                    return { startLine: block.startLine, endLine: block.endLine, expected: source, replacement: source + value };
                });
            });
        }

        /** `offset` is the marker's line within its block, read again on click. */
        function addAnswerButton(strong, block, offset, column) {
            var btn = iconButton('mdb-answer-btn', 'comment', 'Write the answer here');
            strong.insertAdjacentElement('afterend', btn);
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                openEditor(btn, btn, '', function(value) {
                    if (!value.trim()) { return null; }
                    var line = block.startLine + offset;
                    var text = shownLines()[line];
                    return { startLine: line, endLine: line + 1, expected: text, replacement: mdbInsertAnswer(text, column, value) };
                });
            });
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
        function interceptLinks(root) {
            root = root || docRoot;
            if (!root) return;
            root.querySelectorAll('a[href]').forEach(function(link) {
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
                var text = msg.content || '';
                // The same text again (the file watcher after our own save, a
                // reload with nothing changed): what is shown is already it.
                if (sameFile && text === shownText && crlfMode === shownCrlf && docRoot.parentNode === contentArea && docRoot.querySelector('.mdb-block')) {
                    restoreScrollTop = null;
                    return;
                }
                shownText = text;
                shownCrlf = crlfMode;
                shownLinesCache = null;
                var anchor = msg.anchor;
                renderDocument(shownText, function() {
                    initMermaid();
                    indentApplied = false;  // a fresh render carries no indent styles
                    finishFolding(sameFile);
                    applyIndent();
                    afterRender(sameFile, anchor);
                });
            }
        }

        /** Where the reader is put after a full render. */
        function afterRender(sameFile, anchor) {
            if (sameFile && restoreScrollTop !== null) {
                // Our own save re-rendered the document: stay where the
                // reader was, also once Mermaid has resized the page.
                var keep = restoreScrollTop;
                restoreScrollTop = null;
                contentArea.scrollTop = keep;
                requestAnimationFrame(function() { contentArea.scrollTop = keep; });
                return;
            }
            if (anchor) {
                setTimeout(function() { scrollToAnchor(anchor); }, 50);
            } else if (liveMode && followTail) {
                // Layout may not be final yet (Mermaid blocks can resize the
                // doc after they render): wait a frame, then pin to the bottom.
                requestAnimationFrame(function() { scrollToBottom(); });
            } else if (!sameFile) {
                contentArea.scrollTop = 0;
            }
            // Same-file re-render without live follow: the reading position stays.
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
                        // Patch the region the edit touched; the file's own
                        // refresh that follows is then the same text and skipped.
                        if (patchAfterSave(saved.edit)) { restoreScrollTop = null; }
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
