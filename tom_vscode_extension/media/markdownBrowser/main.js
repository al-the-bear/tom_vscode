// @ts-nocheck
/* global marked, mermaid, Highlight, MDB_ANSWER_MARKER, mdbSectionRefs, mdbResolveSectionRef, mdbMdPaths, mdbIsMdLink, mdbBlocks, mdbAnswerMarkers, mdbAnswerAt, mdbWriteAnswer, mdbFoldHidden, mdbFoldAncestors, mdbIndentDepths, mdbGroups */
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
        var docBackBtn = document.getElementById('docBackBtn');
        var docForwardBtn = document.getElementById('docForwardBtn');
        var searchInput = document.getElementById('searchInput');
        var searchCount = document.getElementById('searchCount');
        var searchPrevBtn = document.getElementById('searchPrevBtn');
        var searchNextBtn = document.getElementById('searchNextBtn');
        var searchClearBtn = document.getElementById('searchClearBtn');
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
            vscode.postMessage({ type: 'goBack', filePath: currentFilePath, position: readingPosition() });
        });
        forwardBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'goForward', filePath: currentFilePath, position: readingPosition() });
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
        function enhanceHeadings(root, headingsOut) {
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
                        heading.dataset.fullid = fullId;
                        if (headingsOut) { headingsOut.push(heading); }
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
        // The edit / insert controls are part of every editable block's markup
        // and shown by the body's `mdb-edit-mode` class, so switching edit mode
        // touches no block; their clicks are handled by one delegated listener.
        var BLOCK_ACTIONS_HTML = '<div class="mdb-block-actions">'
            + '<button class="mdb-inline-btn mdb-edit-btn codicon codicon-edit" title="Edit this paragraph (source, with the blank line before it)"></button>'
            + '<button class="mdb-inline-btn mdb-insert-btn codicon codicon-add" title="Insert text at the end of this paragraph"></button>'
            + '</div>';
        /** Rendered HTML that may hold a section reference or a plain-text .md path. */
        var LINKABLE_HTML = /[A-Z0-9][ \t]*&gt;[ \t]*[A-Z]|\.md(?![\w/-])/i;

        function piecesToNodes(pieces) {
            var holder = document.createElement('div');
            var actions = crlfMode ? '' : BLOCK_ACTIONS_HTML;
            holder.innerHTML = pieces.map(function(p) {
                if (!p.block) { return p.html; }
                return '<div class="mdb-block">' + p.html + (p.block.editable ? actions : '') + '</div>';
            }).join('');
            var wrappers = [];
            var blocks = [];
            var linkables = [];
            var k = 0;
            Array.prototype.forEach.call(holder.children, function(el) {
                if (el.classList && el.classList.contains('mdb-block')) {
                    while (k < pieces.length && !pieces[k].block) { k++; }
                    el.__mdbBlock = pieces[k].block;
                    wrappers.push(el);
                    blocks.push(pieces[k].block);
                    if (LINKABLE_HTML.test(pieces[k].html)) { linkables.push(el); }
                    k++;
                }
            });
            return { holder: holder, wrappers: wrappers, blocks: blocks, linkables: linkables };
        }

        /** Everything a freshly built set of nodes needs before it is shown. */
        function processNodes(nodes, ctx) {
            enhanceHeadings(nodes.holder, ctx.headings);
            assignFoldKeys(nodes.holder, ctx.foldSeen);
            decorateWrappers(nodes.wrappers, nodes.blocks);
            Array.prototype.push.apply(ctx.linkables, nodes.linkables);
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
            var ctx = { foldSeen: {}, headings: [], linkables: [] };
            var at = 0;
            var big = pieces.length > RENDER_CHUNK;
            contentArea.setAttribute('aria-busy', 'true');
            function step() {
                if (gen !== renderGen) { return; }   // a newer render started
                var slice = pieces.slice(at, at + RENDER_CHUNK);
                at += slice.length;
                var nodes = piecesToNodes(slice);
                processNodes(nodes, ctx);
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
                indexHeadings(ctx.headings);
                linkify(ctx.linkables);
                var fresh = newDocRoot();
                // A large document lays out only the blocks on screen
                // (style.css: content-visibility on .mdb-large blocks).
                fresh.classList.toggle('mdb-large', big);
                fresh.appendChild(frag);
                showDocRoot(fresh);
                contentArea.removeAttribute('aria-busy');
                hideLinkPopup();
                search.texts = null;
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
            var ctx = { foldSeen: {}, headings: [], linkables: [] };
            processNodes(nodes, ctx);
            linkify(ctx.linkables);
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
            search.texts = null;
            if (search.query) { runSearch(false); }
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

        function anyFolded() {
            for (var k in foldState) {
                if (foldState[k] === true) { return true; }
            }
            return false;
        }

        /** After a full render: keep the flags of a re-rendered same file, apply them only if any are set. */
        function finishFolding(sameFile) {
            if (!sameFile || foldFile !== currentFilePath) {
                foldState = {};
                foldFile = currentFilePath;
            }
            if (anyFolded()) { applyFolding(); } else { refreshFoldControls(); }
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
            // Nothing folded, nothing to unfold: skip walking every element.
            if (!anyFolded()) { return; }
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
        }

        /** An edit or insert button was clicked: open its editor on the block's lines as they are now. */
        function onBlockAction(btn) {
            var actions = btn.parentNode;
            var wrapper = actions && actions.parentNode;
            var block = wrapper && wrapper.__mdbBlock;
            if (!block || crlfMode) { return; }
            if (btn.classList.contains('mdb-edit-btn')) {
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
                return;
            }
            openEditor(actions, wrapper, '', function(value) {
                if (!value) { return null; }
                var source = shownLines().slice(block.startLine, block.endLine).join('\n');
                return { startLine: block.startLine, endLine: block.endLine, expected: source, replacement: source + value };
            });
        }

        /** `offset` is the marker's line within its block, read again on click. */
        function addAnswerButton(strong, block, offset, column) {
            var btn = iconButton('mdb-answer-btn', 'comment', 'Write or edit the answer');
            strong.insertAdjacentElement('afterend', btn);
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                // The answer already written opens in the editor; Save replaces
                // exactly its lines (as the answer import reads them).
                var lines = shownLines();
                var line = block.startLine + offset;
                var current = mdbAnswerAt(lines, line, column);
                openEditor(btn, btn, current.text, function(value) {
                    if (value.trim() === current.text.trim()) { return null; }
                    return {
                        startLine: line, endLine: current.endLine,
                        expected: lines.slice(line, current.endLine).join('\n'),
                        replacement: mdbWriteAnswer(lines, line, column, value),
                    };
                });
            });
        }

        function escapeHtml(text) {
            var div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ---- Anchor Scrolling ----
        function scrollToAnchor(anchor, record) {
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

            if (target && record) {
                jumpWithinDocument(target);
                return true;
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

        // ---- Links in plain text ----
        // Headings carry their dotted full id (`SBP.STKG.TOENV`); a section
        // reference `STKG > TOENV` names its last id and, outer first, ids
        // above it. Indexed by last id after each full render.
        var headingsById = {};

        function indexHeadings(headings) {
            headingsById = {};
            headings.forEach(function(h) {
                var full = h.dataset.fullid || '';
                var last = full.slice(full.lastIndexOf('.') + 1);
                (headingsById[last] = headingsById[last] || []).push(h);
            });
        }

        function headingForRef(ids) {
            var candidates = headingsById[ids[ids.length - 1]];
            if (!candidates) { return null; }
            var i = mdbResolveSectionRef(ids, candidates.map(function(h) { return h.dataset.fullid; }));
            return i >= 0 ? candidates[i] : null;
        }

        /** Turn section references and plain-text .md paths in these blocks into links. */
        function linkify(wrappers) {
            wrappers.forEach(function(wrapper) {
                var walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
                var nodes = [];
                for (var n = walker.nextNode(); n; n = walker.nextNode()) {
                    var host = n.parentNode;
                    if (host && host.closest && host.closest('a, pre, button, textarea, .md-heading-fullid, .md-heading-id')) { continue; }
                    nodes.push(n);
                }
                nodes.forEach(linkifyTextNode);
            });
        }

        function linkifyTextNode(node) {
            var text = node.nodeValue || '';
            var found = [];
            mdbSectionRefs(text).forEach(function(r) {
                if (headingForRef(r.ids)) { found.push({ start: r.start, end: r.end, ref: r.ids.join(' > ') }); }
            });
            mdbMdPaths(text).forEach(function(m) { found.push({ start: m.start, end: m.end, path: m.path }); });
            if (found.length === 0) { return; }
            found.sort(function(a, b) { return a.start - b.start; });
            var frag = document.createDocumentFragment();
            var at = 0;
            found.forEach(function(f) {
                if (f.start < at) { return; }   // overlaps the one before
                if (f.start > at) { frag.appendChild(document.createTextNode(text.slice(at, f.start))); }
                var a = document.createElement('a');
                a.textContent = text.slice(f.start, f.end);
                if (f.ref) {
                    a.className = 'mdb-secref';
                    a.href = '#';
                    a.dataset.secref = f.ref;
                    a.title = 'Go to ' + f.ref;
                } else {
                    a.className = 'mdb-autolink';
                    a.setAttribute('href', f.path);
                }
                frag.appendChild(a);
                at = f.end;
            });
            if (at < text.length) { frag.appendChild(document.createTextNode(text.slice(at))); }
            node.parentNode.replaceChild(frag, node);
        }

        // ---- Navigation within the document ----
        // Following a section reference or an anchor records where the reader
        // was; the second pair of arrows walks those positions back and forth.
        var docBack = [];
        var docForward = [];

        /** The top-level element at the top of the view, or null. */
        function topVisibleElement() {
            if (!document.elementFromPoint) { return null; }
            var r = contentArea.getBoundingClientRect();
            for (var y = r.top + 8; y < r.top + 120; y += 16) {
                var hit = document.elementFromPoint(r.left + r.width / 2, y);
                while (hit && hit.parentNode !== docRoot) { hit = hit.parentNode; }
                if (hit) { return hit; }
            }
            return null;
        }

        function offsetInView(el) {
            return el.getBoundingClientRect().top - contentArea.getBoundingClientRect().top;
        }

        function capturePosition() {
            var el = topVisibleElement();
            return { el: el, delta: el ? offsetInView(el) : 0, scrollTop: contentArea.scrollTop };
        }

        function restorePosition(pos) {
            if (pos.el && pos.el.isConnected) {
                revealElement(pos.el);
                contentArea.scrollTop += offsetInView(pos.el) - pos.delta;
            } else {
                contentArea.scrollTop = pos.scrollTop;
            }
        }

        // ---- Reading position across documents ----
        // The panel's history (backend) keeps, per visited document, the source
        // line of the block at the top of the view and its offset: sent with
        // every navigation message and, debounced, after scrolling.

        function readingPosition() {
            var el = topVisibleElement();
            var block = el && el.__mdbBlock;
            return { line: block ? block.startLine : null, delta: el ? offsetInView(el) : 0, scrollTop: contentArea.scrollTop };
        }

        /** The wrapper of the first block starting at or after `line`. */
        function wrapperAtLine(line) {
            var lo = 0;
            var hi = shownBlocks.length;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (shownBlocks[mid].startLine < line) { lo = mid + 1; } else { hi = mid; }
            }
            return shownWrappers[lo] || null;
        }

        function restoreReadingPosition(pos) {
            var el = typeof pos.line === 'number' ? wrapperAtLine(pos.line) : null;
            if (!el) {
                contentArea.scrollTop = pos.scrollTop || 0;
                return;
            }
            revealElement(el);
            var place = function() {
                var off = offsetInView(el) - (pos.delta || 0);
                if (Math.abs(off) > 1) { contentArea.scrollTop += off; }
                return Math.abs(off) <= 1;
            };
            place();
            // Blocks laid out only once on screen get their real height over
            // the next frames: keep placing the block until it holds still,
            // unless the reader starts scrolling.
            var stableFrames = 0;
            var frames = 0;
            var gen = renderGen;
            readerMoved = false;
            requestAnimationFrame(function settle() {
                if (readerMoved || gen !== renderGen || !el.isConnected) { return; }
                stableFrames = place() ? stableFrames + 1 : 0;
                if (stableFrames < 3 && ++frames < 60) { requestAnimationFrame(settle); }
            });
        }

        // The reader scrolling by hand ends the settling above.
        var readerMoved = false;
        ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function(type) {
            if (contentArea) { contentArea.addEventListener(type, function() { readerMoved = true; }, { passive: true }); }
        });

        var positionTimer = null;
        if (contentArea) {
            contentArea.addEventListener('scroll', function() {
                clearTimeout(positionTimer);
                positionTimer = setTimeout(function() {
                    if (!currentFilePath || contentArea.getAttribute('aria-busy') === 'true') { return; }
                    vscode.postMessage({ type: 'readingPosition', filePath: currentFilePath, position: readingPosition() });
                }, 300);
            });
        }

        function flash(el) {
            el.style.transition = 'background-color 0.3s';
            el.style.backgroundColor = 'var(--vscode-editor-findMatchHighlightBackground)';
            setTimeout(function() { el.style.backgroundColor = ''; }, 1500);
        }

        /** Go to `target`, remembering where the reader was. */
        function jumpWithinDocument(target) {
            docBack.push(capturePosition());
            docForward = [];
            revealElement(target);
            contentArea.scrollTop += offsetInView(target) - 8;
            flash(target);
            updateDocNav();
        }

        function updateDocNav() {
            if (docBackBtn) { docBackBtn.disabled = docBack.length === 0; }
            if (docForwardBtn) { docForwardBtn.disabled = docForward.length === 0; }
        }

        function resetDocNav() {
            docBack = [];
            docForward = [];
            updateDocNav();
        }

        if (docBackBtn) {
            docBackBtn.addEventListener('click', function() {
                if (docBack.length === 0) { return; }
                docForward.push(capturePosition());
                restorePosition(docBack.pop());
                updateDocNav();
            });
        }
        if (docForwardBtn) {
            docForwardBtn.addEventListener('click', function() {
                if (docForward.length === 0) { return; }
                docBack.push(capturePosition());
                restorePosition(docForward.pop());
                updateDocNav();
            });
        }

        // ---- Clicks in the content: links, section references, block actions ----
        if (contentArea) {
            contentArea.addEventListener('click', function(e) {
                var t = e.target;
                if (!t || !t.closest) { return; }
                var action = t.closest('.mdb-edit-btn, .mdb-insert-btn');
                if (action) {
                    e.stopPropagation();
                    onBlockAction(action);
                    return;
                }
                var link = t.closest('a');
                if (!link || !docRoot.contains(link)) { return; }
                e.preventDefault();
                if (link.classList.contains('mdb-secref')) {
                    var target = headingForRef(link.dataset.secref.split(' > '));
                    if (target) { jumpWithinDocument(target); }
                    return;
                }
                var href = link.getAttribute('href') || '';
                if (!href || /^(https?:|mailto:)/.test(href)) { return; }
                vscode.postMessage({ type: 'navigateLink', href: href, filePath: currentFilePath, position: readingPosition() });
            });
        }

        // ---- Link popup: open a linked document here or in a new browser ----
        var linkPopup = document.createElement('div');
        linkPopup.className = 'mdb-link-popup';
        linkPopup.innerHTML = '<button class="mdb-link-popup-btn" data-target="same" title="Open in this MD Browser">'
            + '<span class="codicon codicon-arrow-right"></span> Open here</button>'
            + '<button class="mdb-link-popup-btn" data-target="new" title="Open in a new MD Browser editor">'
            + '<span class="codicon codicon-empty-window"></span> Open in new MD Browser</button>';
        document.body.appendChild(linkPopup);
        var popupLink = null;
        var popupShowTimer = null;
        var popupHideTimer = null;

        function hideLinkPopup() {
            clearTimeout(popupShowTimer);
            clearTimeout(popupHideTimer);
            linkPopup.classList.remove('visible');
            popupLink = null;
        }

        function showLinkPopup(link) {
            popupLink = link;
            linkPopup.classList.add('visible');
            var r = link.getBoundingClientRect();
            var w = linkPopup.offsetWidth || 260;
            var h = linkPopup.offsetHeight || 28;
            linkPopup.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
            linkPopup.style.top = (r.bottom + h + 6 > window.innerHeight ? r.top - h - 4 : r.bottom + 4) + 'px';
        }

        function popupLinkAt(target) {
            var a = target && target.closest ? target.closest('a[href]') : null;
            if (!a || !docRoot.contains(a) || a.classList.contains('mdb-secref')) { return null; }
            return mdbIsMdLink(a.getAttribute('href')) ? a : null;
        }

        if (contentArea) {
            contentArea.addEventListener('mouseover', function(e) {
                var a = popupLinkAt(e.target);
                if (!a) { return; }
                clearTimeout(popupHideTimer);
                if (popupLink === a) { return; }
                clearTimeout(popupShowTimer);
                popupShowTimer = setTimeout(function() { showLinkPopup(a); }, 300);
            });
            contentArea.addEventListener('mouseout', function(e) {
                var a = popupLinkAt(e.target);
                if (!a) { return; }
                var to = e.relatedTarget;
                if (to && (a.contains(to) || linkPopup.contains(to))) { return; }
                clearTimeout(popupShowTimer);
                popupHideTimer = setTimeout(hideLinkPopup, 300);
            });
            contentArea.addEventListener('scroll', hideLinkPopup);
        }
        linkPopup.addEventListener('mouseenter', function() { clearTimeout(popupHideTimer); });
        linkPopup.addEventListener('mouseleave', function() { popupHideTimer = setTimeout(hideLinkPopup, 300); });
        linkPopup.addEventListener('click', function(e) {
            var btn = e.target && e.target.closest ? e.target.closest('.mdb-link-popup-btn') : null;
            if (!btn || !popupLink) { return; }
            vscode.postMessage({
                type: 'navigateLink', href: popupLink.getAttribute('href'), newPanel: btn.dataset.target === 'new',
                filePath: currentFilePath, position: readingPosition(),
            });
            hideLinkPopup();
        });

        // ---- Search ----
        // The text of each top-level element, lower-cased, is indexed once per
        // render (or patch); every keystroke searches that index. Matches are
        // painted with the CSS Custom Highlight API, so the DOM is never touched.
        var SEARCH_CAP = 10000;
        var search = { query: '', texts: null, els: null, matches: [], current: -1, truncated: false };

        function searchIndex() {
            if (!search.texts) {
                search.els = Array.prototype.slice.call(docRoot.children);
                search.texts = search.els.map(function(el) { return (el.textContent || '').toLowerCase(); });
            }
        }

        /** Find the query; with `jump`, go to the first match at or below the top of the view. */
        function runSearch(jump) {
            var q = searchInput ? searchInput.value.toLowerCase() : '';
            search.query = q;
            search.matches = [];
            search.truncated = false;
            if (q) {
                searchIndex();
                outer:
                for (var i = 0; i < search.texts.length; i++) {
                    var text = search.texts[i];
                    for (var at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) {
                        if (search.matches.length >= SEARCH_CAP) { search.truncated = true; break outer; }
                        search.matches.push({ el: i, at: at });
                    }
                }
            }
            if (jump) {
                search.current = firstMatchFromView();
                showSearchMatch(true);
            } else {
                search.current = Math.min(search.current, search.matches.length - 1);
                showSearchMatch(false);
            }
        }

        function firstMatchFromView() {
            if (search.matches.length === 0) { return -1; }
            var top = topVisibleElement();
            var from = top ? search.els.indexOf(top) : 0;
            for (var i = 0; i < search.matches.length; i++) {
                if (search.matches[i].el >= from) { return i; }
            }
            return 0;
        }

        /** A Range over `length` characters at `offset` of `el`'s text. */
        function textRange(el, offset, length) {
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            var range = document.createRange();
            var seen = 0;
            var started = false;
            for (var n = walker.nextNode(); n; n = walker.nextNode()) {
                var len = n.nodeValue.length;
                if (!started && offset < seen + len) {
                    range.setStart(n, offset - seen);
                    started = true;
                }
                if (started && offset + length <= seen + len) {
                    range.setEnd(n, offset + length - seen);
                    return range;
                }
                seen += len;
            }
            return null;
        }

        var highlightsSupported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

        function showSearchMatch(scroll) {
            var n = search.matches.length;
            if (searchClearBtn) { searchClearBtn.classList.toggle('visible', !!(searchInput && searchInput.value)); }
            if (searchCount) {
                searchCount.textContent = !search.query ? ''
                    : n === 0 ? 'No results'
                        : (search.current >= 0 ? (search.current + 1) + ' of ' : '') + n + (search.truncated ? '+' : '');
            }
            if (searchPrevBtn) { searchPrevBtn.disabled = n === 0; }
            if (searchNextBtn) { searchNextBtn.disabled = n === 0; }
            if (highlightsSupported) {
                CSS.highlights.delete('mdb-search');
                CSS.highlights.delete('mdb-search-current');
            }
            if (search.current < 0 || n === 0) { return; }
            var match = search.matches[search.current];
            var el = search.els[match.el];
            if (scroll) { revealElement(el); }
            var range = textRange(el, match.at, search.query.length);
            if (highlightsSupported) {
                // The other matches near this one, so the neighbourhood is visible too.
                var near = [];
                for (var i = Math.max(0, search.current - 200); i < Math.min(n, search.current + 200); i++) {
                    var m = search.matches[i];
                    if (i === search.current || Math.abs(m.el - match.el) > 40) { continue; }
                    var r = textRange(search.els[m.el], m.at, search.query.length);
                    if (r) { near.push(r); }
                }
                CSS.highlights.set('mdb-search', new Highlight(...near));
                if (range) { CSS.highlights.set('mdb-search-current', new Highlight(range)); }
            }
            if (!scroll) { return; }
            contentArea.scrollTop += offsetInView(el) - contentArea.clientHeight / 3;
            if (range && range.getBoundingClientRect) {
                var rr = range.getBoundingClientRect();
                var ar = contentArea.getBoundingClientRect();
                if (rr.height && (rr.top < ar.top || rr.bottom > ar.bottom)) {
                    contentArea.scrollTop += rr.top - ar.top - contentArea.clientHeight / 3;
                }
            }
        }

        function stepSearch(delta) {
            var n = search.matches.length;
            if (n === 0) { return; }
            search.current = search.current < 0
                ? (delta > 0 ? firstMatchFromView() : (firstMatchFromView() - 1 + n) % n)
                : (search.current + delta + n) % n;
            showSearchMatch(true);
        }

        if (searchInput) {
            // Keystrokes that queue up while a search runs are searched once, for the latest text.
            var searchQueued = false;
            searchInput.addEventListener('input', function() {
                if (searchQueued) { return; }
                searchQueued = true;
                setTimeout(function() {
                    searchQueued = false;
                    runSearch(true);
                }, 0);
            });
            searchInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    stepSearch(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                    searchInput.value = '';
                    runSearch(false);
                }
            });
        }
        if (searchNextBtn) { searchNextBtn.addEventListener('click', function() { stepSearch(1); }); }
        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', function() {
                searchInput.value = '';
                runSearch(false);
                searchInput.focus();
            });
        }
        if (searchPrevBtn) { searchPrevBtn.addEventListener('click', function() { stepSearch(-1); }); }
        document.addEventListener('keydown', function(e) {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F') && searchInput) {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
            }
        });

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
                var position = msg.position;
                if (!sameFile) {
                    resetDocNav();
                    search.current = -1;
                }
                renderDocument(shownText, function() {
                    if (search.query) { runSearch(false); }
                    initMermaid();
                    indentApplied = false;  // a fresh render carries no indent styles
                    finishFolding(sameFile);
                    applyIndent();
                    afterRender(sameFile, anchor, position);
                });
            }
        }

        /** Where the reader is put after a full render. */
        function afterRender(sameFile, anchor, position) {
            if (sameFile && restoreScrollTop !== null) {
                // Our own save re-rendered the document: stay where the
                // reader was, also once Mermaid has resized the page.
                var keep = restoreScrollTop;
                restoreScrollTop = null;
                contentArea.scrollTop = keep;
                requestAnimationFrame(function() { contentArea.scrollTop = keep; });
                return;
            }
            if (!sameFile && position) {
                // Back / forward to a document read before: where the reader left it.
                restoreReadingPosition(position);
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
                    scrollToAnchor(msg.anchor, true);
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
