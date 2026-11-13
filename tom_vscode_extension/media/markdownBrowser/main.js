// @ts-nocheck
/* global marked, mermaid, Highlight, mdbSplitForLexing, mdbCriticMark, mdbEditInlineComment, mdbChangeWithComment, mdbQuestionAt, mdbOptionAnswer, mdbCountLabel, mdbIsCommentLine, mdbCommentAt, mdbNextCommentId, mdbInRanges, mdbWriteComment, MDB_ANSWER_MARKER, mdbFindAnswerMarker, mdbSectionRefs, mdbResolveSectionRef, mdbMdPaths, mdbIsMdLink, mdbBlocks, mdbAnswerMarkers, mdbAnswerAt, mdbWriteAnswer, mdbProposedAnswerAt, mdbProposalEdit, mdbFoldHidden, mdbFoldAncestors, mdbIndentDepths, mdbGroups, mdbNavPick, mdbRevealDelta, mdbAttribution, mdbIsAgentAuthor, mdbCommentAuthor, mdbCommentBody, MDB_CHECK_HERE, MDB_LONG_COMMENT, tomMdOverlayShow, MDB_CHANGE_TIME, mdbIndividualAnswers, mdbMostChosen, mdbOpenSummary, mdbConflictAt, mdbConflictEdit, mdbConflictChosenText, mdbMemberColor, MDB_CONFLICT_HEAD, MDB_CHANGE_TIMES, mdbChangeTimeLabel, mdbLatestChangeTime, mdbCommentHeader, mdbReviewTime, mdbChangedQuestions */
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
        var linePosEl = document.getElementById('linePos');
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
        /**
         * With CR/LF on: the file line of every shown line (-1 for a line the
         * conversion made), sent by the host; null when the shown lines are the
         * file's lines. A block is editable when its lines map to consecutive
         * file lines, and its edits are posted with those file lines.
         */
        var lineMap = null;

        /** The file lines `[start, end)` of shown lines `[start, end)`, or null when they are not file lines. */
        function mapRange(start, end) {
            if (!crlfMode || !lineMap) { return { start: start, end: end }; }
            var first = lineMap[start];
            if (first === undefined || first < 0) { return null; }
            for (var k = start; k < end; k++) {
                if (lineMap[k] !== first + (k - start)) { return null; }
            }
            return { start: first, end: first + (end - start) };
        }

        function blockEditable(block) {
            return !!block && !!mapRange(block.startLine, block.endLine);
        }

        /** The file line of shown line `line`, or -1. */
        function fileLine(line) {
            var r = mapRange(line, line + 1);
            return r ? r.start : -1;
        }

        /** `edit` with file line numbers, or null when its lines are not file lines. */
        function toFileEdit(edit) {
            var r = mapRange(edit.startLine, edit.endLine);
            if (!r) { return null; }
            return Object.assign({}, edit, { startLine: r.start, endLine: r.end });
        }

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
        var liveEditors = [];           // the open in-place editors: {area, initial, close} (vscimpb66b)
        var changedOnRender = null;     // the questions a refresh changed, shown once it rendered
        var restoreScrollTop = null;    // where to stay after our own save re-renders
        var afterNextRender = null;     // Save and next, when its save needs a full render first
        var forceRender = false;        // Reload: render the next content in any case
        var busyTimer = null;           // the safety end of a busy state the host never answered
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
            vscode.postMessage({ type: 'editState', openEditors: 0 });
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
            // The next content is rendered whatever it holds: an explicit reload
            // is not skipped for unchanged text, nor held for an open editor.
            forceRender = true;
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
        // A large document is rendered in short tasks so the window never waits:
        // it is lexed in parts (split before headings), parsed part by part and
        // built off-DOM in batches, each task yielding after TASK_BUDGET_MS.
        var LARGE_DOC_CHARS = 200000;
        var LEX_PART_CHARS = 150000;
        var RENDER_BATCH = 600;
        var TASK_BUDGET_MS = 40;
        // Blocks are grouped into sections of SECTION_BLOCKS. In a large
        // document only sections near the view are laid out (content-visibility),
        // which keeps the first frame and every scroll step short.
        var SECTION_BLOCKS = 150;

        // ---- Inline review marks (CriticMarkup, tom_specs annot1 §5) ----
        // A marked inline extension: `{++ ++}`, `{-- --}`, `{~~ ~> ~~}`,
        // `{== ==}{>> <<}` and `{>> <<}` render as marks with an icon each, so
        // added, removed and changed text, highlights and comments stand out.
        // Inline tokens never span blocks, so the block/line mapping is untouched;
        // code spans are lexed before the extension sees their text.
        /**
         * The two buttons of a long comment: show it as markdown in an overlay
         * over the browser (media/shared/mdOverlay.js, HTML from the host's safe
         * renderer), or in the markdown preview editor. The text travels in
         * the buttons' `data-md`; a click is handled once for the whole page.
         */
        function mdViewButtonsHtml(text, title) {
            var attr = function(v) { return String(v).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
            var data = ' data-md="' + attr(text) + '" data-md-title="' + attr(title || 'Comment') + '"';
            return '<span class="mdb-md-view">'
                + '<button class="mdb-md-btn" type="button" data-md-mode="overlay"' + data + ' title="Show the whole comment in an overlay"><span class="codicon codicon-eye"></span></button>'
                + '<button class="mdb-md-btn" type="button" data-md-mode="editor"' + data + ' title="Open the whole comment in the markdown preview editor"><span class="codicon codicon-open-preview"></span></button>'
                + '</span>';
        }
        document.addEventListener('click', function(e) {
            var btn = e.target && e.target.closest ? e.target.closest('.mdb-md-btn') : null;
            if (!btn) { return; }
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({
                type: btn.dataset.mdMode === 'editor' ? 'openMarkdownPreview' : 'renderMarkdown',
                title: btn.dataset.mdTitle || 'Comment',
                markdown: btn.dataset.md || '',
            });
        });

        // ---- Change times (SOM §11.9.10) ----
        // A time written beside an author — a comment header's, an attribution
        // token's, a question header's, an answer marker's — is shown as a small
        // label (relative while recent, mdbChangeTimeLabel) with the full time as
        // its tooltip, never as the notation. The element keeps the time written
        // in `data-changed-at`, so labels can be refreshed and filters compare it.
        /** The label of `changedAt` as HTML; '' when it is not a change time. */
        function changeTimeHtml(changedAt) {
            var shown = mdbChangeTimeLabel(changedAt);
            if (!shown) { return ''; }
            var attr = function(v) { return String(v).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
            return '<span class="mdb-time" data-changed-at="' + attr(changedAt) + '" title="' + attr(shown.title) + '">' + attr(shown.label) + '</span>';
        }
        /** The label of `changedAt` as an element. */
        function changeTimeElement(changedAt) {
            var holder = document.createElement('span');
            holder.innerHTML = changeTimeHtml(changedAt);
            return holder.firstChild;
        }
        /** Each label again, relative to now, when the reader comes back to the page: it keeps saying how long ago. */
        function refreshChangeTimes() {
            if (!docRoot) { return; }
            docRoot.querySelectorAll('.mdb-time[data-changed-at]').forEach(function(el) {
                var shown = mdbChangeTimeLabel(el.dataset.changedAt);
                if (shown && el.textContent !== shown.label) { el.textContent = shown.label; el.title = shown.title; }
            });
        }
        window.addEventListener('focus', refreshChangeTimes);
        document.addEventListener('visibilitychange', function() { if (!document.hidden) { refreshChangeTimes(); } });
        /**
         * An element's text with each time label read as the time it stands for,
         * so `**Answer (<time>):**` is recognised after its time was replaced.
         */
        function textWithTimes(el) {
            if (!el.querySelector || !el.querySelector('.mdb-time')) { return el.textContent || ''; }
            var copy = el.cloneNode(true);
            copy.querySelectorAll('.mdb-time').forEach(function(t) { t.textContent = t.dataset.changedAt || ''; });
            return copy.textContent || '';
        }
        /**
         * Replace each change time written in the review blocks under `root`
         * (comment headers, question headers, answer markers: inside a quote)
         * with its label. Code and labels already drawn are left alone.
         */
        function labelChangeTimes(root) {
            if (!root || typeof document.createTreeWalker !== 'function') { return; }
            var walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
            var found = [];
            for (var node = walker.nextNode(); node; node = walker.nextNode()) {
                MDB_CHANGE_TIMES.lastIndex = 0;
                if (!MDB_CHANGE_TIMES.test(node.nodeValue || '')) { continue; }
                var parent = node.parentNode;
                if (!parent || !parent.closest || !parent.closest('blockquote') || parent.closest('code, pre, textarea, .mdb-time, .mdb-editor')) { continue; }
                found.push(node);
            }
            found.forEach(function(text) {
                var value = text.nodeValue || '';
                var frag = document.createDocumentFragment();
                var last = 0;
                MDB_CHANGE_TIMES.lastIndex = 0;
                for (var m = MDB_CHANGE_TIMES.exec(value); m; m = MDB_CHANGE_TIMES.exec(value)) {
                    var label = changeTimeElement(m[0]);
                    if (!label) { continue; }
                    frag.appendChild(document.createTextNode(value.slice(last, m.index)));
                    frag.appendChild(label);
                    last = m.index + m[0].length;
                }
                if (last === 0) { return; }
                frag.appendChild(document.createTextNode(value.slice(last)));
                text.parentNode.replaceChild(frag, text);
            });
        }

        var reviewMarksRegistered = false;
        function registerReviewMarks() {
            if (reviewMarksRegistered || typeof marked === 'undefined' || typeof marked.use !== 'function') { return; }
            reviewMarksRegistered = true;
            function esc(text) {
                return String(text).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
            }
            function icon(name, title) { return '<span class="codicon codicon-' + name + ' mdb-cm-icon" title="' + title + '"></span>'; }
            /** An attribution token: its authors and votes as written, its change time as a label. */
            function tokenHtml(raw) {
                if (!raw) { return ''; }
                var a = mdbAttribution(raw);
                if (!a || !a.changedAt) { return '<span class="mdb-rm-token">' + esc(raw) + '</span>'; }
                var rest = raw.split(a.changedAt).join('').replace(/\{@\s+/, '{@').replace(/\s+\}$/, '}');
                return (rest === '{@}' ? '' : '<span class="mdb-rm-token">' + esc(rest) + '</span>') + changeTimeHtml(a.changedAt);
            }
            /** `data-changed-at` for the time an attribution token records. */
            function timeAttr(raw) {
                var a = raw ? mdbAttribution(raw) : null;
                return a && a.changedAt ? ' data-changed-at="' + esc(a.changedAt) + '"' : '';
            }
            marked.use({ extensions: [{
                name: 'reviewMark',
                level: 'inline',
                start: function(src) { var i = src.search(/\{(\+\+|--|~~|==|>>)/); return i < 0 ? undefined : i; },
                tokenizer: function(src) {
                    // A change takes its attribution token and its own comment (SOM
                    // §11.9.3) with it: they are drawn as one, each keeping its buttons.
                    var withComment = mdbChangeWithComment(src);
                    var m = withComment ? withComment.mark : mdbCriticMark(src);
                    if (!m) { return undefined; }
                    var raw = withComment ? withComment.raw : m.raw;
                    // The attribution token after it (§11.9.8): the mark's authors, or
                    // the attached comment's when the change carries one.
                    var after = mdbAttribution(src.slice(raw.length));
                    var token = { type: 'reviewMark', raw: raw + (after ? after.raw : ''), markRaw: m.raw, kind: m.kind, comment: m.comment || '', authors: [], votes: [] };
                    token.textTokens = this.lexer.inlineTokens(m.text);
                    if (m.kind === 'substitution') { token.oldTokens = this.lexer.inlineTokens(m.oldText); }
                    if (m.quote) { token.quote = m.quote; }
                    if (withComment && withComment.comment) {
                        token.token = withComment.token;
                        var before = mdbAttribution(withComment.token);
                        token.authors = before ? before.authors : [];
                        token.votes = before ? before.votes : [];
                        token.attached = { raw: withComment.comment.raw, text: withComment.comment.text, authors: after ? after.authors : [], tokenAfter: after ? after.raw : '' };
                    } else if (after) {
                        token.token = after.raw;
                        token.authors = after.authors;
                        token.votes = after.votes;
                    }
                    if (m.kind === 'comment') { token.noteText = m.text; } else if (m.kind === 'highlight') { token.noteText = m.comment || ''; }
                    return token;
                },
                renderer: function(token) {
                    // Every mark is wrapped with its markup and the buttons that decide it
                    // (shown in edit mode): accept / reject (and comment) for a change,
                    // edit / remove for a comment. A change's own comment is a mark of
                    // its own inside the change's wrapper, with its own buttons.
                    var change = token.kind === 'addition' || token.kind === 'deletion' || token.kind === 'substitution';
                    var noteButtons = function(addComment) {
                        return '<button class="mdb-rm-btn mdb-rm-edit codicon codicon-edit" title="' + (addComment ? 'Add a comment' : 'Edit this comment') + '"></button>'
                            + '<button class="mdb-rm-btn mdb-rm-remove codicon codicon-trash" title="Remove this comment (the text stays)"></button>';
                    };
                    var buttons = change
                        ? '<button class="mdb-rm-btn mdb-rm-accept codicon codicon-check" title="Accept this change"></button>'
                            + '<button class="mdb-rm-btn mdb-rm-reject codicon codicon-close" title="Reject this change"></button>'
                            + (token.attached ? '' : '<button class="mdb-rm-btn mdb-rm-comment codicon codicon-comment" title="Comment on this change"></button>')
                        : noteButtons(token.kind === 'highlight' && !token.comment);
                    var attached = token.attached
                        ? tokenHtml(token.token)
                            + '<span class="mdb-rm" data-kind="note" data-raw="' + esc(token.attached.raw) + '"' + authorAttrs(token.attached.authors) + timeAttr(token.attached.tokenAfter) + '>'
                            + '<span class="mdb-cm mdb-cm-comment mdb-cm-change-comment" title="Comment on this change">' + icon('comment', 'Comment on this change')
                            + esc(token.attached.text) + '</span>' + viewButtons(token.attached.text, 'Comment on a change')
                            + '<span class="mdb-rm-actions">' + noteButtons(false) + '</span></span>'
                            + tokenHtml(token.attached.tokenAfter)
                        : '';
                    var ownToken = !token.attached ? tokenHtml(token.token) : '';
                    return '<span class="mdb-rm" data-kind="' + (change ? 'change' : 'note') + '" data-raw="' + esc(token.markRaw || token.raw) + '"' + authorAttrs(token.authors) + voteAttrs(token.votes) + timeAttr(token.token) + '>'
                        + renderMark.call(this, token) + (change ? '' : viewButtons(token.noteText || '', 'Comment'))
                        + '<span class="mdb-rm-actions">' + buttons + '</span>' + attached + ownToken + '</span>';
                },
            }, {
                // `___check here___`: what especially needs the reviewer's eye, as a badge
                // (marked would make it bold italic text); the arrows step through them.
                name: 'checkHere',
                level: 'inline',
                start: function(src) { var i = src.search(/___\s*check here\s*___/i); return i < 0 ? undefined : i; },
                tokenizer: function(src) {
                    var m = MDB_CHECK_HERE.exec(src);
                    return m ? { type: 'checkHere', raw: m[0] } : undefined;
                },
                renderer: function() {
                    return '<span class="mdb-check-here" title="Marked: check here">' + icon('eye', 'Check here') + 'check here</span>';
                },
            }] });
            /** `data-authors` (`|`-separated) and `data-agent` for the authors a mark names. */
            function authorAttrs(authors) {
                if (!authors || authors.length === 0) { return ''; }
                return ' data-authors="' + esc(authors.join('|')) + '"' + (authors.some(mdbIsAgentAuthor) ? ' data-agent="1"' : '');
            }
            /** `data-votes` for a base mark's votes (SOM §11.9.8): `+bob|-carol`. */
            function voteAttrs(votes) {
                if (!votes || votes.length === 0) { return ''; }
                return ' data-votes="' + esc(votes.map(function(v) { return (v.vote === 'reject' ? '-' : '+') + v.member; }).join('|')) + '"';
            }
            /** Overlay and preview-editor buttons for a comment longer than MDB_LONG_COMMENT. */
            function viewButtons(text, title) {
                return String(text || '').length > MDB_LONG_COMMENT ? mdViewButtonsHtml(text, title) : '';
            }
            /** The change a change comment quotes, and its outcome: `30 → 15 (accepted)`. */
            function quoteLabel(quote) {
                var change = quote.kind === 'substitution'
                    ? '<del>' + esc(quote.oldText) + '</del> → <ins>' + esc(quote.newText) + '</ins>'
                    : quote.kind === 'addition' ? '+ <ins>' + esc(quote.newText) + '</ins>' : '− <del>' + esc(quote.oldText) + '</del>';
                return change + (quote.outcome ? ' <span class="mdb-cm-outcome">(' + esc(quote.outcome) + ')</span>' : '') + ': ';
            }
            /** The mark itself: an icon and its text, styled by kind. */
            function renderMark(token) {
                var inner = this.parser.parseInline(token.textTokens);
                var note = token.comment
                    ? '<span class="mdb-cm mdb-cm-comment" title="Comment">' + icon('comment', 'Comment') + esc(token.comment) + '</span>' : '';
                switch (token.kind) {
                    case 'addition':
                        return '<ins class="mdb-cm mdb-cm-add" title="Added">' + icon('diff-added', 'Added') + inner + '</ins>';
                    case 'deletion':
                        return '<del class="mdb-cm mdb-cm-del" title="Removed">' + icon('diff-removed', 'Removed') + inner + '</del>';
                    case 'substitution':
                        return '<span class="mdb-cm mdb-cm-sub" title="Changed">' + icon('diff-modified', 'Changed')
                            + '<del>' + this.parser.parseInline(token.oldTokens) + '</del><ins>' + inner + '</ins></span>';
                    case 'highlight':
                        return '<mark class="mdb-cm mdb-cm-mark"' + (token.comment ? ' title="' + esc(token.comment) + '"' : '') + '>'
                            + icon('note', 'Annotated text') + inner + '</mark>' + note;
                    case 'comment':
                        if (token.quote) {
                            // A change comment standing alone (its change decided): the
                            // change it was about as a label, then the comment.
                            return '<span class="mdb-cm mdb-cm-comment mdb-cm-change-comment" title="Comment on a change">' + icon('comment', 'Comment on a change')
                                + '<span class="mdb-cm-quote">' + quoteLabel(token.quote) + '</span>' + inner + '</span>';
                        }
                        return '<span class="mdb-cm mdb-cm-comment" title="Comment">' + icon('comment', 'Comment') + inner + '</span>';
                    default:
                        return '<span class="mdb-cm mdb-cm-comment" title="Comment">' + icon('comment', 'Comment') + inner + '</span>';
                }
            }
        }

        /** marked's options: its defaults (GFM: tables, strikethrough, ...) plus `breaks` for CR/LF. */
        function markedOptions() {
            registerReviewMarks();
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
        /** Lex `text` (lines from `lineOffset` on) and map its blocks to file lines. */
        function lexPart(text, lineOffset) {
            var tokens = marked.lexer(text || '', markedOptions());
            var byIndex = {};
            mdbBlocks(text || '', tokens).forEach(function(b) {
                b.startLine += lineOffset;
                b.endLine += lineOffset;
                byIndex[b.index] = b;
            });
            return { tokens: tokens, byIndex: byIndex };
        }

        /** The render pieces of a lexed part (see buildPieces). */
        function parsePart(lexed, links) {
            var options = markedOptions();
            var tokens = lexed.tokens;
            var byIndex = lexed.byIndex;
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
                // A reviewer comment block (`> ⬆️ ...`): edited as a comment, not as raw source.
                if (block && range[0] === range[1] && tokens[range[0]].type === 'blockquote'
                    && mdbIsCommentLine(String(tokens[range[0]].raw || '').replace(/^\n+/, '').split('\n')[0])) {
                    block.comment = true;
                }
                pieces.push({ html: html, block: block, hasHtml: group.some(function(tk) { return tk.type === 'html'; }) });
            });
            return pieces;
        }

        /**
         * The render pieces of `text`: one per group of tokens (an html run that
         * opens an element is one group), each with its HTML and its block
         * (null for pieces with no source lines, e.g. whitespace). Line numbers
         * are shifted by `lineOffset` (a region rendered on its own).
         */
        function buildPieces(text, lineOffset) {
            var lexed = lexPart(text, lineOffset);
            var links = Object.assign({}, shownLinks, lexed.tokens.links || {});
            return { pieces: parsePart(lexed, links), links: lexed.tokens.links || {} };
        }

        /** Turn pieces into DOM nodes in a detached holder; returns the holder and the wrappers made. */
        // The edit / insert controls are part of every editable block's markup
        // and shown by the body's `mdb-edit-mode` class, so switching edit mode
        // touches no block; their clicks are handled by one delegated listener.
        var BLOCK_ACTIONS_HTML = '<div class="mdb-block-actions">'
            + '<button class="mdb-inline-btn mdb-edit-btn codicon codicon-edit" title="Edit this paragraph (source, with the blank line before it)"></button>'
            + '<button class="mdb-inline-btn mdb-insert-btn codicon codicon-add" title="Insert text at the end of this paragraph"></button>'
            + '<button class="mdb-inline-btn mdb-comment-btn codicon codicon-comment-discussion" title="Add a review comment after this paragraph"></button>'
            + '</div>';
        /** A comment block is reopened with its own button; another comment may follow it. */
        var COMMENT_ACTIONS_HTML = '<div class="mdb-block-actions">'
            + '<button class="mdb-inline-btn mdb-comment-btn codicon codicon-comment-discussion" title="Add another review comment after this one"></button>'
            + '<button class="mdb-inline-btn mdb-comment-remove-btn codicon codicon-trash" title="Remove this comment"></button>'
            + '</div>';
        /** Rendered HTML that may hold a section reference or a plain-text .md path. */
        var LINKABLE_HTML = /[A-Z0-9][ \t]*&gt;[ \t]*[A-Z]|\.md(?![\w/-])/i;
        /** Rendered HTML that may hold a single section id (an upper-case run of five or more; mdbSectionRefs decides). */
        var SINGLE_ID_HTML = /[A-Z][A-Z0-9-]{4,}/;

        function piecesToNodes(pieces) {
            var holder = document.createElement('div');
            holder.innerHTML = pieces.map(function(p) {
                if (!p.block) { return p.html; }
                // With CR/LF on, a block holding converted line breaks is not the file's text.
                var editable = blockEditable(p.block);
                var buttons = !editable ? '' : p.block.comment ? COMMENT_ACTIONS_HTML : p.block.editable ? BLOCK_ACTIONS_HTML : '';
                return '<div class="mdb-block">' + p.html + buttons + '</div>';
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
                    if (LINKABLE_HTML.test(pieces[k].html) || SINGLE_ID_HTML.test(pieces[k].html)) { linkables.push(el); }
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
         * Run `tasks` in order. Sliced: in tasks of their own, yielding to the
         * event loop whenever TASK_BUDGET_MS has passed; a newer render (another
         * generation) stops them. Not sliced: all at once (small documents).
         */
        function runTasks(tasks, gen, sliced, onError) {
            var i = 0;
            function run() {
                if (gen !== renderGen) { return; }
                var started = Date.now();
                try {
                    while (i < tasks.length) {
                        tasks[i++]();
                        if (sliced && i < tasks.length && Date.now() - started > TASK_BUDGET_MS) {
                            setTimeout(run, 0);
                            return;
                        }
                    }
                } catch (err) {
                    onError(err);
                }
            }
            if (sliced) { setTimeout(run, 0); } else { run(); }
        }

        /**
         * Render `text`: lex it in parts, parse the parts, build the blocks
         * off-DOM in batches and group them into sections, then show the result
         * by swapping one element. A large document does all of it in short
         * tasks (runTasks), so the window stays responsive; `done` runs after
         * the swap (folding, indentation, scroll position).
         */
        function renderDocument(text, done) {
            var gen = ++renderGen;
            shownLinks = {};
            if (typeof marked === 'undefined' || !marked.lexer || !marked.parser) {
                var plain = newDocRoot();
                plain.innerHTML = '<pre>' + escapeHtml(text || '') + '</pre>';
                showDocRoot(plain);
                shownBlocks = [];
                shownWrappers = [];
                done();
                return;
            }
            var big = (text || '').length > LARGE_DOC_CHARS;
            var parts = big ? mdbSplitForLexing(text, LEX_PART_CHARS) : [{ startLine: 0, text: text || '' }];
            var lexed = [];
            var links = {};
            var pieces = [];
            var frag = document.createDocumentFragment();
            var blocks = [];
            var wrappers = [];
            var sections = [];
            var section = null;
            var ctx = { foldSeen: {}, headings: [], linkables: [] };
            var tasks = [];
            var progress = function(label, at, of) {
                if (filePathEl && big) { filePathEl.setAttribute('data-progress', label + ' ' + Math.round(100 * at / of) + '%'); }
            };
            parts.forEach(function(part, i) {
                tasks.push(function() {
                    var l = lexPart(part.text, part.startLine);
                    lexed.push(l);
                    Object.assign(links, l.tokens.links || {});
                    progress('Reading', i + 1, parts.length);
                });
            });
            parts.forEach(function(part, i) {
                tasks.push(function() {
                    Array.prototype.push.apply(pieces, parsePart(lexed[i], links));
                    lexed[i] = null;
                });
            });
            tasks.push(function() {
                shownLinks = links;
                for (var at = 0; at < pieces.length; at += RENDER_BATCH) {
                    tasks.push(buildBatch.bind(null, at));
                }
                tasks.push(finish);
            });
            function buildBatch(at) {
                var nodes = piecesToNodes(pieces.slice(at, at + RENDER_BATCH));
                processNodes(nodes, ctx);
                Array.prototype.push.apply(wrappers, nodes.wrappers);
                Array.prototype.push.apply(blocks, nodes.blocks);
                while (nodes.holder.firstChild) {
                    if (!section || section.childNodes.length >= SECTION_BLOCKS) {
                        section = document.createElement('div');
                        section.className = 'mdb-section';
                        section.__mdbEstimate = 0;
                        sections.push(section);
                        frag.appendChild(section);
                    }
                    var el = nodes.holder.firstChild;
                    var b = el.__mdbBlock;
                    // A rough height until the section is first laid out (`auto` then keeps the real one).
                    section.__mdbEstimate += b ? 22 * (b.endLine - b.startLine) + 16 : 0;
                    section.appendChild(el);
                }
                progress('Rendering', at + RENDER_BATCH, pieces.length);
            }
            function finish() {
                if (filePathEl) { filePathEl.removeAttribute('data-progress'); }
                sections.forEach(function(s) { s.style.containIntrinsicSize = 'auto ' + Math.max(40, s.__mdbEstimate) + 'px'; });
                shownBlocks = blocks;
                shownWrappers = wrappers;
                indexHeadings(ctx.headings);
                linkify(ctx.linkables);
                var fresh = newDocRoot();
                fresh.classList.toggle('mdb-large', big);
                fresh.appendChild(frag);
                showDocRoot(fresh);
                contentArea.removeAttribute('aria-busy');
                hideLinkPopup();
                search.texts = null;
                observeSections(fresh);
                done();
                scheduleLinePos();
            }
            contentArea.setAttribute('aria-busy', 'true');
            runTasks(tasks, gen, big, function(err) {
                contentArea.removeAttribute('aria-busy');
                contentArea.innerHTML = '<div class="empty-state error-state"><div>' + escapeHtml(String(err)) + '</div></div>';
            });
        }

        // ---- Sections near the view stay rendered ----
        // content-visibility:auto drops a section's rendering when it leaves the
        // view, so scrolling back to it waited again. The sections within two
        // screens of the view are kept rendered (`mdb-near`), and so are the last
        // NEAR_KEEP sections that left that range, so the pages around the
        // reader — ahead and behind — are ready before they are scrolled to.
        var NEAR_KEEP = 12;
        var sectionObserver = null;
        var nearLeft = [];

        function observeSections(root) {
            if (sectionObserver) { sectionObserver.disconnect(); sectionObserver = null; }
            nearLeft = [];
            if (!root.classList.contains('mdb-large') || typeof IntersectionObserver === 'undefined') { return; }
            sectionObserver = new IntersectionObserver(function(entries) {
                entries.forEach(function(e) {
                    var s = e.target;
                    s.__mdbInRange = e.isIntersecting;
                    if (e.isIntersecting) {
                        s.classList.add('mdb-near');
                        var i = nearLeft.indexOf(s);
                        if (i >= 0) { nearLeft.splice(i, 1); }
                    } else if (s.classList.contains('mdb-near') && nearLeft.indexOf(s) < 0) {
                        nearLeft.push(s);
                    }
                });
                while (nearLeft.length > NEAR_KEEP) {
                    var old = nearLeft.shift();
                    if (!old.__mdbInRange) { old.classList.remove('mdb-near'); }
                }
                // A section just laid out turns an estimated line into an exact one.
                scheduleLinePos();
            }, { root: contentArea, rootMargin: '200% 0px 200% 0px' });
            Array.prototype.forEach.call(root.children, function(s) { sectionObserver.observe(s); });
        }

        // ---- Where the reader is: line X / N ----
        var linePosQueued = false;

        function scheduleLinePos() {
            if (linePosQueued || !linePosEl) { return; }
            linePosQueued = true;
            requestAnimationFrame(function() {
                linePosQueued = false;
                updateLinePos();
            });
        }

        function updateLinePos() {
            if (!linePosEl) { return; }
            linePosEl.textContent = '';
            if (!shownText || !document.elementFromPoint || contentArea.getAttribute('aria-busy') === 'true') { return; }
            var total = shownLines().length;
            var r = contentArea.getBoundingClientRect();
            var top = topVisibleElement();
            if (top && top.__mdbBlock) {
                linePosEl.textContent = 'Line ' + (top.__mdbBlock.startLine + 1) + ' / ' + total;
                return;
            }
            // A section not laid out yet: interpolate between its first and last line.
            var hit = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
            var section = hit && hit.closest ? hit.closest('.mdb-section') : null;
            var first = section && section.firstElementChild && section.firstElementChild.__mdbBlock;
            var last = section && section.lastElementChild && section.lastElementChild.__mdbBlock;
            if (first && last) {
                var sr = section.getBoundingClientRect();
                var frac = sr.height ? Math.min(1, Math.max(0, (r.top - sr.top) / sr.height)) : 0;
                linePosEl.textContent = '≈ Line ' + (Math.round(first.startLine + frac * (last.endLine - first.startLine)) + 1) + ' / ' + total;
            }
        }

        if (contentArea) { contentArea.addEventListener('scroll', scheduleLinePos, { passive: true }); }

        /** Whether `el` is one of the document's top-level elements (a block, in its section). */
        function isTopElement(el) {
            return !!(el && el.parentNode && el.parentNode.classList && el.parentNode.classList.contains('mdb-section'));
        }

        /** The top-level element `node` is in, or null. */
        function topElementOf(node) {
            while (node && !isTopElement(node)) { node = node.parentNode; }
            return node || null;
        }

        /** The document's top-level elements, in order, across its sections. */
        function topElements() {
            return Array.prototype.slice.call(docRoot.querySelectorAll(':scope > .mdb-section > *'));
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
            // Swap the old wrappers (and anything between them) for the new nodes.
            var oldFirst = shownWrappers[from];
            var oldLast = shownWrappers[last];
            // A region across two sections is rendered again in full.
            if (oldFirst.parentNode !== oldLast.parentNode) { return false; }
            var nodes = piecesToNodes(built.pieces);
            // The new blocks are decorated from the new text: an answer just
            // written must read as answered.
            shownText = lines.join(eol);
            shownLinesCache = null;
            var ctx = { foldSeen: {}, headings: [], linkables: [] };
            processNodes(nodes, ctx);
            linkify(ctx.linkables);
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
            search.texts = null;
            if (search.query) { runSearch(false); }
            // The patched region's chips, and what is left to decide.
            decorateTeamReview();
            markOwnLines();
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
            return topElements().map(function(el) {
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
            var top = topElementOf(target);
            var entries = foldEntries();
            var index = entries.findIndex(function(e) { return e.el === top; });
            if (index < 0) { return; }
            var opened = mdbFoldAncestors(entries, index);
            if (opened.length === 0) { return; }
            opened.forEach(function(i) { foldState[entries[i].key] = false; });
            applyFolding();
        }

        // ---- Busy while a change is saved; locks while a text area is open ----
        var busyOverlay = document.getElementById('busyOverlay');
        var busyText = document.getElementById('busyText');
        /** A change to the document is on its way to the host: show it, and take no input until the answer. */
        function beginBusy(label) {
            document.body.classList.add('mdb-busy');
            if (contentArea) { contentArea.setAttribute('inert', ''); }
            if (busyText) { busyText.textContent = label || 'Saving…'; }
            if (busyOverlay) { busyOverlay.hidden = false; }
            if (busyTimer) { clearTimeout(busyTimer); }
            // Never stuck: an answer that does not come frees the document after a while.
            busyTimer = setTimeout(endBusy, 20000);
        }
        function endBusy() {
            if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
            document.body.classList.remove('mdb-busy');
            if (contentArea) { contentArea.removeAttribute('inert'); }
            if (busyOverlay) { busyOverlay.hidden = true; }
        }
        /**
         * While a text area is open, the text search and the review navigation
         * are off: they scroll and re-render under it.
         */
        function updateEditorLocks() {
            var locked = openEditors > 0;
            // Tell the host whether in-place editors are open (unsaved text):
            // the panel registry reports it to agents before they close a tab.
            vscode.postMessage({ type: 'editState', openEditors: openEditors });
            [searchInput, searchClearBtn, navPrevBtnEl(), navNextBtnEl(), document.getElementById('navKindBtn')].forEach(function(el) {
                if (el) { el.disabled = locked; }
            });
            if (searchPrevBtn) { searchPrevBtn.disabled = locked || search.mEl.length === 0; }
            if (searchNextBtn) { searchNextBtn.disabled = locked || search.mEl.length === 0; }
            var pop = document.getElementById('navKindPop');
            if (locked && pop) { pop.hidden = true; }
        }
        function navPrevBtnEl() { return document.getElementById('navPrevBtn'); }
        function navNextBtnEl() { return document.getElementById('navNextBtn'); }

        // ---- In-place editing ----
        // An editor: a 5-line textarea (resizable) with Save / Discard. The
        // button that opened it is hidden while it is open. With `next` (an
        // answer) a third button saves and goes on: `next(saved)` runs once the
        // save landed, or at once when there was nothing to save.
        function openEditor(trigger, placeAfter, initial, buildEdit, next) {
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
            if (next) {
                var saveNext = document.createElement('button');
                saveNext.className = 'mdb-editor-btn';
                saveNext.title = 'Save, then go to the next unanswered question';
                saveNext.innerHTML = '<span class="codicon codicon-arrow-down"></span> Save and next';
                saveNext.addEventListener('click', function(e) { e.stopPropagation(); submit(next); });
                bar.appendChild(saveNext);
            }
            bar.appendChild(status);
            box.appendChild(area);
            box.appendChild(bar);
            placeAfter.insertAdjacentElement('afterend', box);
            // Line up with the block it edits when the document is indented.
            if (isTopElement(placeAfter)) { box.style.marginLeft = placeAfter.style.marginLeft; }
            trigger.style.display = 'none';
            openEditors++;
            var live = { area: area, initial: initial, close: close };
            liveEditors.push(live);
            updateEditorLocks();
            area.focus();

            function close() {
                if (!box.parentNode) { return; }
                area.blur();
                box.parentNode.removeChild(box);
                trigger.style.display = '';
                openEditors = Math.max(0, openEditors - 1);
                liveEditors = liveEditors.filter(function(e) { return e !== live; });
                updateEditorLocks();
                if (openEditors === 0) { hideChangeBar(); }
                if (openEditors === 0 && pendingContent) {
                    var held = pendingContent;
                    pendingContent = null;
                    handleContent(held);
                }
            }
            discard.addEventListener('click', function(e) { e.stopPropagation(); close(); });
            save.addEventListener('click', function(e) { e.stopPropagation(); submit(null); });
            function submit(after) {
                var edit = buildEdit(area.value);
                if (!edit) {
                    close();
                    if (after) { after(false); }
                    return;
                }
                // Written by the host through the runtime (a review mark), not as a line edit.
                if (edit.run) {
                    close();
                    edit.run();
                    return;
                }
                // The edit asks to be confirmed first: say why, and wait for the next Save.
                if (edit.hold) {
                    status.textContent = edit.hold;
                    status.classList.remove('error');
                    return;
                }
                var fileEdit = toFileEdit(edit);
                if (!fileEdit) {
                    status.textContent = 'These lines hold converted line breaks: turn CR/LF off to edit them.';
                    status.classList.add('error');
                    return;
                }
                var id = nextEditId++;
                pendingSaves[id] = { close: close, status: status, edit: edit, after: after };
                status.textContent = 'Saving…';
                beginBusy('Saving…');
                restoreScrollTop = contentArea.scrollTop;
                vscode.postMessage({
                    type: 'applyEdit', editId: id, filePath: currentFilePath,
                    startLine: fileEdit.startLine, endLine: fileEdit.endLine, expected: fileEdit.expected, replacement: fileEdit.replacement,
                });
            }
            return box;
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
                editModeBtn.title = 'Edit mode: edit or extend paragraphs in place';
            }
            if (!shownText) { return; }
            for (var w = 0; w < wrappers.length; w++) {
                labelChangeTimes(wrappers[w]);
                decorateWrapper(wrappers[w], blocks[w]);
            }
        }

        function decorateWrapper(wrapper, block) {
            if (!block || !blockEditable(block)) { return; }
            markFormField(wrapper, block);
            // A conflict block of a team review (SOM §11.9.8): the choices and Decide.
            if (MDB_CONFLICT_HEAD.test(shownLines()[block.startLine] || '')) { decorateConflict(wrapper, block); }
            if (block.comment) {
                wrapper.classList.add('mdb-comment-block');
                addCommentEditButton(wrapper, block);
                decorateCommentAuthorship(wrapper, block);
            }
            // Answers: the k-th marker of a block is its k-th <strong>Answer:</strong>
            // (or <strong>Answer (<time>):</strong>, SOM §11.9.10).
            var strongs = null;
            var markerIndex = 0;
            var lines = null;
            for (var line = block.startLine; line < block.endLine; line++) {
                lines = lines || shownLines();
                if (lines[line] === undefined || !mdbFindAnswerMarker(lines[line], 0)) { continue; }
                var markers = mdbAnswerMarkers(lines[line]);
                for (var k = 0; k < markers.length; k++) {
                    strongs = strongs || Array.prototype.filter.call(wrapper.querySelectorAll('strong'), function(s) {
                        return /^Answer(?: \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})\))?:$/.test(textWithTimes(s).trim());
                    });
                    var strong = strongs[markerIndex++];
                    if (strong) { addAnswerButton(strong, block, line - block.startLine, markers[k].column); }
                }
            }
            // Proposed answers (Grill me, Explain in detail): Accept / Edit / Discard.
            var proposalStrongs = null;
            var proposalIndex = 0;
            for (var pl = block.startLine; pl < block.endLine; pl++) {
                lines = lines || shownLines();
                if (lines[pl] === undefined || lines[pl].indexOf('**Proposed answer**') < 0 || !mdbProposedAnswerAt(lines, pl)) { continue; }
                proposalStrongs = proposalStrongs || Array.prototype.filter.call(wrapper.querySelectorAll('strong'), function(s) {
                    return (s.textContent || '').trim() === 'Proposed answer';
                });
                var pStrong = proposalStrongs[proposalIndex++];
                if (pStrong) { addProposalButtons(pStrong, block, pl - block.startLine); }
            }
        }

        /**
         * Accept (into the Answer line), Edit (then accept) and Discard after a
         * `**Proposed answer**`; `offset` is its line within the block, read on click.
         */
        function addProposalButtons(strong, block, offset) {
            var accept = iconButton('mdb-proposal-btn mdb-proposal-accept', 'check', 'Accept — write the proposed answer into the Answer line');
            var edit = iconButton('mdb-proposal-btn mdb-proposal-edit', 'edit', 'Edit the proposed answer, then write it into the Answer line');
            var discard = iconButton('mdb-proposal-btn mdb-proposal-discard', 'trash', 'Discard the proposed answer');
            strong.insertAdjacentElement('afterend', discard);
            strong.insertAdjacentElement('afterend', edit);
            strong.insertAdjacentElement('afterend', accept);
            function settle(action, text) {
                var lines = shownLines();
                return mdbProposalEdit(lines, block.startLine + offset, action, text, action === 'accept' ? mdbReviewTime() : undefined);
            }
            accept.addEventListener('click', function(e) {
                e.stopPropagation();
                var change = settle('accept');
                if (change) { postEdit(change); }
            });
            discard.addEventListener('click', function(e) {
                e.stopPropagation();
                var change = settle('discard');
                if (change) { postEdit(change); }
            });
            edit.addEventListener('click', function(e) {
                e.stopPropagation();
                var prop = mdbProposedAnswerAt(shownLines(), block.startLine + offset);
                if (!prop) { return; }
                openEditor(edit, edit, prop.text, function(value) {
                    if (!value.trim()) { return null; }
                    return settle('accept', value);
                });
            });
        }

        /**
         * Grill me and Explain in detail after an open question's answer button:
         * each runs its Assist prompt in the ANTHROPIC panel (the host builds it).
         */
        function addAssistButtons(after, where) {
            var defs = [
                ['grillMe', 'flame', 'Grill me — the agent asks you narrowing questions until this can be answered, then proposes the answer'],
                ['explainInDetail', 'book', 'Explain in detail — the agent explains the question and each option in a note beside this document'],
            ];
            for (var d = defs.length - 1; d >= 0; d--) {
                (function(def) {
                    var b = iconButton('mdb-assist-btn mdb-assist-' + def[0], def[1], def[2]);
                    b.dataset.assist = def[0];
                    b.addEventListener('click', function(e) {
                        e.stopPropagation();
                        var w = where();
                        if (!w.question) { return; }
                        b.classList.add('mdb-assist-started');
                        vscode.postMessage({ type: 'assistQuestion', use: def[0], filePath: currentFilePath, questionId: w.question.id, answerLine: w.line });
                    });
                    after.insertAdjacentElement('afterend', b);
                })(defs[d]);
            }
        }

        /**
         * A comment block's author (`data-authors`, `data-agent` for an agent's)
         * for the navigation's filters, and the overlay / preview buttons when
         * it is long.
         */
        function decorateCommentAuthorship(wrapper, block) {
            var lines = shownLines();
            var header = mdbCommentHeader(lines[block.startLine]);
            var author = header.author;
            // When it was written (SOM §11.9.10), for the navigation's "changed since".
            if (header.changedAt) { wrapper.dataset.changedAt = header.changedAt; } else { delete wrapper.dataset.changedAt; }
            // The user's own comment (their review member id) is marked, also when decorated after the render.
            wrapper.classList.toggle('mdb-own', !!author && author === reviewMemberId);
            if (author) {
                wrapper.dataset.authors = author;
                if (mdbIsAgentAuthor(author)) { wrapper.dataset.agent = '1'; } else { delete wrapper.dataset.agent; }
            } else {
                delete wrapper.dataset.authors;
                delete wrapper.dataset.agent;
            }
            var old = wrapper.querySelector(':scope > .mdb-md-view');
            if (old) { old.remove(); }
            var comment = mdbCommentAt(lines, block.startLine);
            var body = comment ? mdbCommentBody(comment.text) : '';
            if (body.length > MDB_LONG_COMMENT) {
                var holder = document.createElement('span');
                holder.innerHTML = mdViewButtonsHtml(body, 'Comment' + (author ? ' — ' + author : ''));
                wrapper.appendChild(holder.firstChild);
            }
        }

        // ---- Review comments ----
        /** The OS user, written as the author of a comment that names none (sent by the host). */
        var commentAuthor = '';
        /** The user's review member id (Status Page, Team review): their own lines are marked. '' when unset. */
        var reviewMemberId = '';

        /**
         * Mark the user's own lines (class `mdb-own`): comment blocks and marks whose authors name the
         * member id, and individual answer lines `**Answer (<ids>):**` that list it (SOM §11.9.8).
         */
        function markOwnLines() {
            if (!docRoot) { return; }
            docRoot.querySelectorAll('.mdb-own').forEach(function(el) { el.classList.remove('mdb-own'); });
            if (!reviewMemberId) { return; }
            docRoot.querySelectorAll('[data-authors]').forEach(function(el) {
                if (el.dataset.authors.split('|').indexOf(reviewMemberId) >= 0) { el.classList.add('mdb-own'); }
            });
            docRoot.querySelectorAll('strong').forEach(function(el) {
                // Once decorated, the label shows display names; its ids are kept in data-members.
                var m = el.dataset.members ? [null, el.dataset.members.split('|').join(',')] : /^Answer \(([^)]*)\):?$/.exec(textWithTimes(el).trim());
                if (!m) { return; }
                var ids = m[1].split(',').map(function(x) { return x.trim(); });
                if (ids.indexOf(reviewMemberId) >= 0) { (el.closest('p, li') || el).classList.add('mdb-own'); }
            });
        }
        /**
         * For a SOM document, what the host read with the TomSpecs runtime
         * (som-review-comments.ts): the number of the next free comment id, the
         * lines of the forms' fields, where no comment may go (it belongs in the
         * form's preamble), and every question's options and recommended letter. Null for any other document, and until the host
         * has answered for the text shown.
         */
        var somComments = null;

        /** The questions as the runtime read them (id → options, recommended), or null: the browser reads them itself. */
        function runtimeQuestions() {
            return somComments ? somComments.questions : null;
        }

        /** The next comment id: the document's highest + 1, or the runtime's when higher. */
        function nextCommentId() {
            return mdbNextCommentId(shownText, somComments ? somComments.nextCommentNumber : undefined);
        }

        /** A block inside a form's fields offers no comment. */
        function markFormField(wrapper, block) {
            var inFields = !!somComments && !block.comment && mdbInRanges(somComments.formFieldRanges, fileLine(block.startLine));
            wrapper.classList.toggle('mdb-no-comment', inFields);
        }

        function applySomComments() {
            Array.prototype.forEach.call(docRoot.querySelectorAll('.mdb-block'), function(w) {
                if (w.__mdbBlock) { markFormField(w, w.__mdbBlock); }
            });
        }
        // A comment block (`> ⬆️ **C-12** (author): text`, tom_specs annot1) is
        // written after a paragraph and reopened with its own button. The editor
        // shows the text without the `> ` prefixes, starting with the arrow and
        // the id; a missing id is the document's highest `C-<n>` + 1.

        /** Add a comment after `block`: the editor opens with the arrow and the next id. */
        function addComment(trigger, wrapper, block) {
            var head = '\u2B06\uFE0F **' + nextCommentId() + '** ' + (commentAuthor ? '(' + commentAuthor + '): ' : '');
            openEditor(trigger, wrapper, head, function(value) {
                var lines = shownLines();
                var written = mdbWriteComment(value, nextCommentId(), commentAuthor, mdbReviewTime());
                if (!written) { return null; }
                var source = lines.slice(block.startLine, block.endLine).join('\n');
                // A blank line before the comment, and one after it when the next
                // block starts right away — else that block would continue the quote.
                var next = lines[block.endLine];
                var after = next !== undefined && next.trim() !== '' ? '\n' : '';
                return { startLine: block.startLine, endLine: block.endLine, expected: source, replacement: source + '\n\n' + written + after };
            });
        }

        /** The comment block's own button: reopen it; saving it empty removes it, after a second Save. */
        function addCommentEditButton(wrapper, block) {
            var btn = iconButton('mdb-comment-edit-btn', 'comment', 'Edit this comment');
            var quote = wrapper.querySelector('blockquote');
            var firstPara = quote && quote.firstElementChild;
            var id = firstPara && firstPara.querySelector('strong');
            if (id && /^C-\d+$/.test((id.textContent || '').trim())) {
                id.insertAdjacentElement('afterend', btn);
            } else if (firstPara) {
                firstPara.insertBefore(btn, firstPara.firstChild);
            } else {
                wrapper.insertBefore(btn, wrapper.firstChild);
            }
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var lines = shownLines();
                var comment = mdbCommentAt(lines, block.startLine);
                if (!comment) { return; }
                var source = lines.slice(comment.startLine, comment.endLine).join('\n');
                var removeArmed = false;
                openEditor(btn, wrapper, comment.text, function(value) {
                    if (value === comment.text) { return null; }
                    var written = mdbWriteComment(value, nextCommentId(), commentAuthor, mdbReviewTime());
                    if (written) {
                        return { startLine: comment.startLine, endLine: comment.endLine, expected: source, replacement: written };
                    }
                    if (!removeArmed) {
                        removeArmed = true;
                        return { hold: 'The comment is empty — Save again to remove it.' };
                    }
                    // Removed with the blank lines around it, leaving one.
                    var start = comment.startLine > 0 && lines[comment.startLine - 1].trim() === '' ? comment.startLine - 1 : comment.startLine;
                    var end = lines[comment.endLine] !== undefined && lines[comment.endLine].trim() === '' ? comment.endLine + 1 : comment.endLine;
                    return { startLine: start, endLine: end, expected: lines.slice(start, end).join('\n'), replacement: '' };
                });
            });
        }

        /** An edit or insert button was clicked: open its editor on the block's lines as they are now. */
        function onBlockAction(btn) {
            var actions = btn.parentNode;
            var wrapper = actions && actions.parentNode;
            var block = wrapper && wrapper.__mdbBlock;
            if (!block || !blockEditable(block)) { return; }
            if (btn.classList.contains('mdb-comment-btn')) {
                addComment(actions, wrapper, block);
                return;
            }
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
            var startLines = shownLines();
            if (!mdbAnswerAt(startLines, block.startLine + offset, column).text) { btn.dataset.unanswered = '1'; }
            // The question's latest change (SOM §11.9.10): its header, its team answer, its members' answers.
            var asked = mdbQuestionAt(startLines, block.startLine + offset, runtimeQuestions());
            var changedAt = mdbLatestChangeTime(startLines.slice(asked ? asked.line : block.startLine + offset, block.startLine + offset + 1).join('\n'));
            if (changedAt) { btn.dataset.changedAt = changedAt; }
            /** The marker's line now: the block's lines move with edits above it. */
            btn.__mdbLine = function() { return block.startLine + offset; };
            /** The answer's lines and its question, read when used: an edit elsewhere may have moved them. */
            function where() {
                var lines = shownLines();
                var line = block.startLine + offset;
                return { lines: lines, line: line, current: mdbAnswerAt(lines, line, column), question: mdbQuestionAt(lines, line, runtimeQuestions()) };
            }
            function editFor(w, value) {
                return {
                    startLine: w.line, endLine: w.current.endLine,
                    expected: w.lines.slice(w.line, w.current.endLine).join('\n'),
                    replacement: mdbWriteAnswer(w.lines, w.line, column, value, mdbReviewTime()),
                };
            }
            btn.__mdbOpenAnswer = function() {
                hideOptions();
                // The answer already written opens in the editor; an unanswered
                // question opens with its recommended option. Save replaces
                // exactly the answer's lines (as the answer import reads them).
                var w = where();
                // After a team review: the option most members chose (SOM §11.9.8), else the recommended one.
                var most = mdbMostChosen(mdbIndividualAnswers(w.lines, w.line));
                var initial = w.current.text || (most ? mdbOptionAnswer(most) : w.question && w.question.recommended ? mdbOptionAnswer(w.question.recommended) : '');
                return openEditor(btn, btn, initial, function(value) {
                    if (value.trim() === w.current.text.trim()) { return null; }
                    return editFor(w, value);
                }, function(saved) {
                    // Nothing was saved: go on from behind this question all the same.
                    if (!saved) { setNavAnchor({ line: w.line + 1, ord: 0 }); }
                    navigate(1, ['unanswered']);
                });
            };
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                btn.__mdbOpenAnswer();
            });
            // Hovering the button offers the question's options: one click answers.
            btn.addEventListener('mouseenter', function() {
                var w = where();
                if (!w.question || w.question.options.length === 0) { return; }
                showOptions(btn, w.question, function(letter) { postEdit(editFor(w, mdbOptionAnswer(letter))); });
            });
            btn.addEventListener('mouseleave', function() { scheduleHideOptions(); });
            // An open question offers Grill me and Explain in detail.
            if (btn.dataset.unanswered === '1' && mdbQuestionAt(startLines, block.startLine + offset, runtimeQuestions())) {
                addAssistButtons(btn, where);
            }
            // Members answered it one by one: Keep open writes `open:` with a summary of their positions (CC-72).
            var individual = mdbIndividualAnswers(startLines, block.startLine + offset);
            if (individual.length) {
                var keep = iconButton('mdb-keep-open-btn', 'circle-large-outline', 'Keep open: answer `open:` with a summary of the positions');
                btn.insertAdjacentElement('afterend', keep);
                keep.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var w = where();
                    var names = {};
                    Object.keys(teamMembers).forEach(function(id) { names[id] = teamMembers[id].displayName; });
                    var initial = /^open:/i.test(w.current.text) ? w.current.text : mdbOpenSummary(mdbIndividualAnswers(w.lines, w.line), names);
                    openEditor(keep, keep, initial, function(value) {
                        var text = value.trim();
                        if (!/^open:/i.test(text)) { text = 'open: ' + text; }
                        if (text === w.current.text.trim()) { return null; }
                        return editFor(w, text);
                    });
                });
            }
        }

        // ---- The options popup of an answer button ----
        var optionsPop = null;
        var hideOptionsTimer = null;
        function hideOptions() {
            if (hideOptionsTimer) { clearTimeout(hideOptionsTimer); hideOptionsTimer = null; }
            if (optionsPop && optionsPop.parentNode) { optionsPop.parentNode.removeChild(optionsPop); }
            optionsPop = null;
        }
        function scheduleHideOptions() {
            if (hideOptionsTimer) { clearTimeout(hideOptionsTimer); }
            hideOptionsTimer = setTimeout(hideOptions, 400);
        }
        function showOptions(btn, question, pick) {
            hideOptions();
            var pop = document.createElement('div');
            pop.className = 'mdb-options-pop';
            question.options.forEach(function(o) {
                var item = document.createElement('div');
                item.className = 'mdb-option' + (o.letter === question.recommended ? ' mdb-option-recommended' : '');
                item.textContent = mdbOptionAnswer(o.letter) + ' ' + o.text;
                item.title = o.letter === question.recommended ? 'Recommended — answer with this option' : 'Answer with this option';
                item.addEventListener('click', function(e) { e.stopPropagation(); hideOptions(); pick(o.letter); });
                pop.appendChild(item);
            });
            var write = document.createElement('div');
            write.className = 'mdb-option mdb-option-write';
            write.textContent = 'Write an answer…';
            write.addEventListener('click', function(e) { e.stopPropagation(); btn.__mdbOpenAnswer(); });
            pop.appendChild(write);
            pop.addEventListener('mouseenter', function() { if (hideOptionsTimer) { clearTimeout(hideOptionsTimer); hideOptionsTimer = null; } });
            pop.addEventListener('mouseleave', scheduleHideOptions);
            var r = btn.getBoundingClientRect();
            pop.style.left = Math.max(4, r.left) + 'px';
            pop.style.top = (r.bottom + 2) + 'px';
            document.body.appendChild(pop);
            optionsPop = pop;
        }

        // ---- Reviewing marks, comments and the whole document ----
        /** Post an edit that needs no editor (a one-click action); the host reports a failure itself. */
        function postEdit(edit) {
            var fileEdit = toFileEdit(edit);
            if (!fileEdit) { return; }
            var id = nextEditId++;
            pendingSaves[id] = { close: function() {}, status: document.createElement('div'), edit: edit };
            restoreScrollTop = contentArea.scrollTop;
            beginBusy('Saving…');
            vscode.postMessage({
                type: 'applyEdit', editId: id, filePath: currentFilePath, notifyOnError: true,
                startLine: fileEdit.startLine, endLine: fileEdit.endLine, expected: fileEdit.expected, replacement: fileEdit.replacement,
            });
        }

        /** The mark's markup and its occurrence among the identical marks of its block. */
        function markAt(span) {
            var wrapper = span && span.closest('.mdb-block');
            var block = wrapper && wrapper.__mdbBlock;
            if (!block) { return null; }
            var raw = span.dataset.raw;
            var occurrence = 0;
            var all = wrapper.querySelectorAll('.mdb-rm');
            for (var i = 0; i < all.length && all[i] !== span; i++) { if (all[i].dataset.raw === raw) { occurrence++; } }
            return { wrapper: wrapper, block: block, raw: raw, occurrence: occurrence };
        }

        var REVIEW_BUSY = { accept: 'Accepting…', reject: 'Rejecting…', remove: 'Removing…', comment: 'Commenting…', edit: 'Saving the comment…' };

        /**
         * One mark decided — accepted, rejected or (a comment) removed — or a
         * comment written on a change or edited (`text`): the host does it with the
         * TomSpecs runtime (annot4, SOM §11.9.3) on the block's lines.
         */
        function postReviewMark(span, decision, text) {
            var at = markAt(span);
            var range = at && mapRange(at.block.startLine, at.block.endLine);
            if (!range) { return; }
            // The mark goes away: the next one takes its place.
            setNavAnchor(navKey(span));
            restoreScrollTop = contentArea.scrollTop;
            beginBusy(REVIEW_BUSY[decision] || 'Saving…');
            var message = {
                type: 'reviewMark', filePath: currentFilePath,
                startLine: range.start, endLine: range.end,
                expected: shownLines().slice(at.block.startLine, at.block.endLine).join('\n'),
                markup: at.raw, occurrence: at.occurrence, decision: decision,
            };
            if (text !== undefined) { message.text = text; }
            vscode.postMessage(message);
        }

        /** Accept, reject or remove one mark: the host decides it with the TomSpecs runtime (annot4). */
        function decideReviewMark(btn) {
            var decision = btn.classList.contains('mdb-rm-accept') ? 'accept' : btn.classList.contains('mdb-rm-reject') ? 'reject' : 'remove';
            postReviewMark(btn.closest('.mdb-rm'), decision);
        }

        /**
         * Why a comment text cannot be written, or null: the runtime refuses an
         * empty one, a mark delimiter (it would open or close a mark) and a blank
         * line (a mark does not span one). Checked here so the editor keeps the text.
         */
        function inlineCommentError(text) {
            if (!text.trim()) { return 'Write the comment first.'; }
            if (/\{>>|\{==|\{\+\+|\{--|\{~~|<<\}/.test(text)) { return 'A comment cannot contain a mark delimiter ({>> {== {++ {-- {~~ <<}).'; }
            if (/\n[ \t]*\n/.test(text)) { return 'A comment cannot contain a blank line.'; }
            return null;
        }

        /** Comment on a change: the editor opens empty; the runtime writes the change comment, quoting the change. */
        function commentOnChange(btn) {
            var span = btn.closest('.mdb-rm');
            var at = markAt(span);
            if (!at || !blockEditable(at.block)) { return; }
            openEditor(btn, at.wrapper, '', function(value) {
                var error = inlineCommentError(value);
                if (error) { return { hold: error }; }
                return { run: function() { postReviewMark(span, 'comment', value.trim()); } };
            });
        }

        /**
         * Edit the comment of an inline mark — a `{>> comment <<}` alone, a change
         * comment or a highlight's — in an editor under its block. The runtime
         * writes it (`editMarkComment`; a change comment keeps its quote); saved
         * empty, a comment is removed. A highlight's comment emptied, or one added
         * to a bare highlight, is written here (mdbEditInlineComment): the highlight
         * stays, which no runtime operation does.
         */
        function editInlineComment(btn) {
            var span = btn.closest('.mdb-rm');
            var at = markAt(span);
            if (!at || !blockEditable(at.block)) { return; }
            var mark = mdbCriticMark(at.raw);
            if (!mark) { return; }
            var initial = mark.kind === 'comment' ? mark.text : (mark.comment || '');
            var highlight = mark.kind === 'highlight';
            openEditor(btn, at.wrapper, initial, function(value) {
                if (value.trim() === initial) { return null; }
                if (highlight && (!mark.comment || !value.trim())) {
                    var source = shownLines().slice(at.block.startLine, at.block.endLine).join('\n');
                    var edited = mdbEditInlineComment(source, at.raw, at.occurrence, value);
                    if (edited.error) { return { hold: edited.error }; }
                    return { startLine: at.block.startLine, endLine: at.block.endLine, expected: source, replacement: edited.text };
                }
                if (!value.trim()) { return { run: function() { postReviewMark(span, 'remove'); } }; }
                var error = inlineCommentError(value);
                if (error) { return { hold: error }; }
                return { run: function() { postReviewMark(span, 'edit', value.trim()); } };
            });
        }

        /** Remove a comment block, and the blank line around it, with one click. */
        function removeCommentBlock(block) {
            var lines = shownLines();
            var comment = mdbCommentAt(lines, block.startLine);
            if (!comment) { return; }
            var start = comment.startLine > 0 && lines[comment.startLine - 1].trim() === '' ? comment.startLine - 1 : comment.startLine;
            var end = lines[comment.endLine] !== undefined && lines[comment.endLine].trim() === '' ? comment.endLine + 1 : comment.endLine;
            postEdit({ startLine: start, endLine: end, expected: lines.slice(start, end).join('\n'), replacement: '' });
        }

        function reviewAll(decision) {
            if (!currentFilePath) { return; }
            restoreScrollTop = contentArea.scrollTop;
            beginBusy(decision === 'reject' ? 'Rejecting all changes…' : 'Accepting all changes…');
            vscode.postMessage({ type: 'reviewAllChanges', filePath: currentFilePath, decision: decision });
        }
        var acceptAllBtn = document.getElementById('acceptAllBtn');
        var rejectAllBtn = document.getElementById('rejectAllBtn');
        if (acceptAllBtn) { acceptAllBtn.addEventListener('click', function() { reviewAll('accept'); }); }
        if (rejectAllBtn) { rejectAllBtn.addEventListener('click', function() { reviewAll('reject'); }); }

        // ---- Team review (SOM §11.9.8): who wrote what, conflicts, what is left ----
        // The members come from the round (round.yaml beside the file or above
        // merged/, the `reviewTeam` message), the document's own review team and
        // its revision history (the somComments reading). Ids the document
        // names that no source knows are shown by id.
        /** @type {Array<{memberId: string, displayName: string, role: string, guest?: boolean}>} */
        var roundMembers = [];
        /** @type {Array<{memberId: string, displayName: string, role: string, guest?: boolean}>} */
        var docMembers = [];
        /** The document's revision history (CC-89): version, date, author, the round's team and reviewers. */
        var teamRevisions = [];
        /** Member id → `{displayName, role, guest}`, and the ids in team order (the colours follow it). */
        var teamMembers = {};
        var teamOrder = [];
        /** The one member shown ("only Alice's"); '' shows everyone. */
        var teamFilter = '';
        var teamBox = document.getElementById('teamReview');
        var teamBtn = document.getElementById('teamBtn');
        var teamPop = document.getElementById('teamPop');
        var unresolvedCountEl = document.getElementById('unresolvedCount');
        var nextUnresolvedBtn = document.getElementById('nextUnresolvedBtn');

        /** Rebuild the member table from the round, the document and its revisions; the round's names win. */
        function setTeam() {
            teamMembers = {};
            teamOrder = [];
            var add = function(m, guest) {
                if (!m || !m.memberId || teamMembers[m.memberId]) { return; }
                teamMembers[m.memberId] = { displayName: m.displayName || m.memberId, role: m.role || '', guest: !!(guest || m.guest) };
                teamOrder.push(m.memberId);
            };
            roundMembers.forEach(function(m) { add(m, m.guest); });
            docMembers.forEach(function(m) { add(m, false); });
            teamRevisions.forEach(function(r) {
                (r.team || []).forEach(function(m) { add(m, false); });
                (r.reviewers || []).forEach(function(m) { add(m, m.guest); });
            });
            decorateTeamReview();
        }
        function memberName(id) { return teamMembers[id] ? teamMembers[id].displayName : id; }
        /** Every member id the document names: authors, voters, individual answers, conflict alternatives. */
        function namedMembers() {
            var seen = {};
            var ids = [];
            var note = function(id) { if (id && !seen[id] && !mdbIsAgentAuthor(id)) { seen[id] = true; ids.push(id); } };
            teamOrder.forEach(note);
            if (docRoot) {
                docRoot.querySelectorAll('[data-authors]').forEach(function(el) { el.dataset.authors.split('|').forEach(note); });
                docRoot.querySelectorAll('[data-votes]').forEach(function(el) { el.dataset.votes.split('|').forEach(function(v) { note(v.slice(1)); }); });
                docRoot.querySelectorAll('[data-members]').forEach(function(el) { el.dataset.members.split('|').forEach(note); });
            }
            return ids;
        }
        /** A member's chip: the display name in the member's colour, the id and role in its title. */
        function memberChip(id, extraClass, prefix) {
            var chip = document.createElement('span');
            chip.className = 'mdb-chip' + (extraClass ? ' ' + extraClass : '');
            chip.dataset.member = id;
            chip.dataset.prefix = prefix || '';
            paintChip(chip);
            return chip;
        }
        /** A chip's name, colour and title from what is known of its member now. */
        function paintChip(chip) {
            var id = chip.dataset.member;
            var info = teamMembers[id];
            chip.style.setProperty('--mdb-member', mdbMemberColor(id, teamOrder));
            chip.textContent = (chip.dataset.prefix || '') + memberName(id) + (info && info.guest ? ' (guest)' : '');
            chip.title = id + (info && info.role ? ' — ' + info.role : '') + (info && info.guest ? ' — guest, not on the team' : '') + (id === reviewMemberId ? ' (you)' : '');
        }
        function chipRow(className) {
            var row = document.createElement('span');
            row.className = 'mdb-chip-row' + (className ? ' ' + className : '');
            return row;
        }

        /**
         * Chips on the marks (authors, and the votes on a base mark), on comment
         * blocks and on individual answers (`**Answer (alice, bob):**` shown with the
         * display names, CC-71), the filter applied, the counter brought up to date.
         * Runs after every render and patch and when the team becomes known.
         */
        function decorateTeamReview() {
            if (!docRoot) { updateTeamUi(); return; }
            docRoot.querySelectorAll('.mdb-chip-row').forEach(function(el) { el.remove(); });
            docRoot.querySelectorAll('.mdb-rm[data-authors], .mdb-rm[data-votes]').forEach(function(mark) {
                var row = chipRow('mdb-chip-row-mark');
                authorsOf(mark).filter(function(a) { return !mdbIsAgentAuthor(a); }).forEach(function(a) { row.appendChild(memberChip(a)); });
                (mark.dataset.votes ? mark.dataset.votes.split('|') : []).forEach(function(v) {
                    var accept = v.charAt(0) === '+';
                    row.appendChild(memberChip(v.slice(1), accept ? 'mdb-vote mdb-vote-accept' : 'mdb-vote mdb-vote-reject', accept ? '✓ ' : '✗ '));
                });
                if (row.childNodes.length) {
                    var actions = mark.querySelector(':scope > .mdb-rm-actions');
                    mark.insertBefore(row, actions || null);
                }
            });
            docRoot.querySelectorAll('.mdb-comment-block[data-authors]').forEach(function(block) {
                var author = block.dataset.authors;
                if (mdbIsAgentAuthor(author)) { return; }
                block.style.setProperty('--mdb-member', mdbMemberColor(author, teamOrder));
                block.classList.add('mdb-member-block');
                var row = chipRow('mdb-chip-row-comment');
                row.appendChild(memberChip(author));
                block.insertBefore(row, block.firstChild);
            });
            docRoot.querySelectorAll('strong').forEach(function(el) {
                var ids = el.dataset.members ? el.dataset.members.split('|') : null;
                if (!ids) {
                    var m = /^Answer \(([^)]*)\):?$/.exec(textWithTimes(el).trim());
                    if (!m) { return; }
                    var parts = m[1].split(',').map(function(x) { return x.trim(); });
                    ids = parts.filter(function(x) { return x && !MDB_CHANGE_TIME.test(x); });
                    if (ids.length === 0) { return; }
                    el.dataset.members = ids.join('|');
                    var time = parts.filter(function(x) { return MDB_CHANGE_TIME.test(x); })[0];
                    if (time) { el.dataset.changedAt = time; }
                }
                // The members' names, and the time the answer records as its label.
                el.textContent = 'Answer (' + ids.map(memberName).join(', ') + (el.dataset.changedAt ? ', ' : '') + '):';
                if (el.dataset.changedAt) {
                    var label = changeTimeElement(el.dataset.changedAt);
                    if (label) { el.insertBefore(label, el.lastChild.splitText(el.lastChild.length - 2)); }
                }
                el.title = ids.join(', ');
                var line = el.closest('p, li') || el;
                line.dataset.authors = ids.join('|');
                line.classList.add('mdb-individual-answer');
                var row = chipRow('mdb-chip-row-answer');
                ids.forEach(function(id) { row.appendChild(memberChip(id)); });
                el.insertAdjacentElement('afterend', row);
            });
            // Chips drawn before the team was known (a conflict's choices): their names and colours now.
            docRoot.querySelectorAll('.mdb-conflict-bar .mdb-chip').forEach(paintChip);
            applyTeamFilter();
            updateTeamUi();
        }

        /** "Only Alice's": the other members' marks, comments and answers dimmed, and the arrows skip them. */
        function applyTeamFilter() {
            if (!docRoot) { return; }
            docRoot.querySelectorAll('.mdb-team-dim').forEach(function(el) { el.classList.remove('mdb-team-dim'); });
            if (!teamFilter) { return; }
            docRoot.querySelectorAll('[data-authors]').forEach(function(el) {
                if (el.dataset.authors.split('|').indexOf(teamFilter) < 0) { el.classList.add('mdb-team-dim'); }
            });
        }
        function setTeamFilter(id) {
            teamFilter = id;
            navHiddenAuthors = {};
            if (id) {
                namedMembers().forEach(function(a) { if (a !== id) { navHiddenAuthors[a] = true; } });
                docRoot && docRoot.querySelectorAll('[data-authors]').forEach(function(el) {
                    el.dataset.authors.split('|').forEach(function(a) { if (a !== id) { navHiddenAuthors[a] = true; } });
                });
                navHiddenAuthors[NO_AUTHOR] = true;
            }
            applyTeamFilter();
            renderTeamPop();
            showNavCount();
            updateTeamUi();
        }

        /** Conflicts without a decision, team answers not written, change marks not decided. */
        function unresolvedCounts() {
            if (!docRoot) { return { conflicts: 0, questions: 0, changes: 0 }; }
            return {
                conflicts: docRoot.querySelectorAll('.mdb-conflict[data-open="1"]').length,
                questions: docRoot.querySelectorAll('.mdb-answer-btn[data-unanswered="1"]').length,
                changes: docRoot.querySelectorAll('.mdb-rm[data-kind="change"]').length,
            };
        }
        /** The counter and Next unresolved, and the Team button while the document has a team or members' marks. */
        function updateTeamUi() {
            var c = unresolvedCounts();
            var left = c.conflicts + c.questions + c.changes;
            var team = namedMembers().length > 0 || c.conflicts > 0;
            if (unresolvedCountEl) {
                unresolvedCountEl.hidden = !team;
                unresolvedCountEl.textContent = c.conflicts + ' ⚖ · ' + c.questions + ' ? · ' + c.changes + ' ±';
                unresolvedCountEl.title = 'Left to decide: ' + c.conflicts + ' conflict' + (c.conflicts === 1 ? '' : 's') + ', '
                    + c.questions + ' open question' + (c.questions === 1 ? '' : 's') + ', ' + c.changes + ' undecided change' + (c.changes === 1 ? '' : 's');
                unresolvedCountEl.classList.toggle('mdb-all-resolved', left === 0);
            }
            if (nextUnresolvedBtn) {
                nextUnresolvedBtn.hidden = !team;
                nextUnresolvedBtn.disabled = left === 0;
            }
            if (teamBox) { teamBox.hidden = !team; }
            if (teamBtn) { teamBtn.textContent = teamFilter ? 'Only ' + memberName(teamFilter) : 'Team'; }
        }

        /** The Team popup: the legend with the filter and per-author decisions, then the revision history. */
        function renderTeamPop() {
            if (!teamPop) { return; }
            teamPop.innerHTML = '';
            var head = document.createElement('div');
            head.className = 'nav-kind-head';
            head.textContent = 'Members';
            teamPop.appendChild(head);
            var ids = namedMembers();
            var changeAuthors = {};
            if (docRoot) {
                docRoot.querySelectorAll('.mdb-rm[data-kind="change"][data-authors]').forEach(function(el) {
                    authorsOf(el).forEach(function(a) { changeAuthors[a] = (changeAuthors[a] || 0) + 1; });
                });
            }
            var everyone = document.createElement('div');
            everyone.className = 'mdb-team-row';
            var all = document.createElement('button');
            all.className = 'mdb-team-btn' + (teamFilter ? '' : ' mdb-team-active');
            all.dataset.teamOnly = '';
            all.textContent = 'Everyone';
            all.title = 'Show every member\'s marks, comments and answers';
            everyone.appendChild(all);
            teamPop.appendChild(everyone);
            ids.forEach(function(id) {
                var row = document.createElement('div');
                row.className = 'mdb-team-row';
                var only = document.createElement('button');
                only.className = 'mdb-team-btn mdb-team-only' + (teamFilter === id ? ' mdb-team-active' : '');
                only.dataset.teamOnly = id;
                only.title = 'Only ' + memberName(id) + '\'s marks, comments and answers';
                only.appendChild(memberChip(id));
                row.appendChild(only);
                var info = teamMembers[id];
                if (info && info.role) {
                    var role = document.createElement('span');
                    role.className = 'mdb-team-role';
                    role.textContent = info.role;
                    row.appendChild(role);
                }
                if (changeAuthors[id]) {
                    ['accept', 'reject'].forEach(function(decision) {
                        var b = document.createElement('button');
                        b.className = 'mdb-team-btn mdb-team-decide codicon codicon-' + (decision === 'accept' ? 'check-all' : 'discard');
                        b.dataset.teamDecide = decision;
                        b.dataset.teamAuthor = id;
                        b.title = (decision === 'accept' ? 'Accept' : 'Reject') + ' all of ' + memberName(id) + '\'s changes (' + changeAuthors[id] + ')';
                        row.appendChild(b);
                    });
                }
                teamPop.appendChild(row);
            });
            if (teamRevisions.length) {
                var rh = document.createElement('div');
                rh.className = 'nav-kind-head';
                rh.textContent = 'Revision history';
                teamPop.appendChild(rh);
                teamRevisions.forEach(function(r) {
                    var entry = document.createElement('div');
                    entry.className = 'mdb-team-revision';
                    var title = document.createElement('div');
                    title.className = 'mdb-team-revision-title';
                    title.textContent = [r.version ? 'v' + r.version : '', r.date, r.author].filter(Boolean).join(' · ') + (r.summary ? ' — ' + r.summary : '');
                    entry.appendChild(title);
                    var lists = [['Team', r.team || []], ['Reviewers', r.reviewers || []]];
                    lists.forEach(function(pair) {
                        if (!pair[1].length) { return; }
                        var line = document.createElement('div');
                        line.className = 'mdb-team-revision-line';
                        line.appendChild(document.createTextNode(pair[0] + ': '));
                        pair[1].forEach(function(m) {
                            var chip = memberChip(m.memberId, m.guest ? 'mdb-chip-guest' : '');
                            if (m.guest && chip.textContent.indexOf('(guest)') < 0) { chip.textContent += ' (guest)'; }
                            line.appendChild(chip);
                        });
                        entry.appendChild(line);
                    });
                    teamPop.appendChild(entry);
                });
            }
        }
        if (teamBtn && teamPop) {
            teamBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (teamPop.hidden) { renderTeamPop(); }
                teamPop.hidden = !teamPop.hidden;
            });
            teamPop.addEventListener('click', function(e) {
                e.stopPropagation();
                var btn = e.target && e.target.closest ? e.target.closest('button') : null;
                if (!btn) { return; }
                if (btn.dataset.teamOnly !== undefined) { setTeamFilter(btn.dataset.teamOnly); return; }
                if (btn.dataset.teamDecide && currentFilePath) {
                    teamPop.hidden = true;
                    restoreScrollTop = contentArea.scrollTop;
                    beginBusy(btn.dataset.teamDecide === 'reject' ? 'Rejecting…' : 'Accepting…');
                    vscode.postMessage({
                        type: 'reviewAuthorChanges', filePath: currentFilePath, author: btn.dataset.teamAuthor,
                        name: memberName(btn.dataset.teamAuthor), decision: btn.dataset.teamDecide,
                    });
                }
            });
            document.addEventListener('click', function() { teamPop.hidden = true; });
        }
        if (nextUnresolvedBtn) { nextUnresolvedBtn.addEventListener('click', function() { navigate(1, ['unresolved']); }); }

        // ---- Conflict blocks: a choice per alternative, keep base, rewrite, Decide, keep open ----
        /** The edit a choice makes on the conflict that opens on the block's first line, read when used. */
        function conflictEdit(block, choice) {
            var lines = shownLines();
            var c = mdbConflictAt(lines, block.startLine);
            return c ? mdbConflictEdit(lines, c, choice) : null;
        }
        function decorateConflict(wrapper, block) {
            var lines = shownLines();
            var c = mdbConflictAt(lines, block.startLine);
            if (!c) { return; }
            wrapper.classList.add('mdb-conflict');
            var unresolved = !c.decision || /^open:/i.test(c.decision);
            wrapper.dataset.open = unresolved ? '1' : '0';
            wrapper.dataset.members = c.alternatives.reduce(function(all, a) { return all.concat(a.members); }, []).join('|');
            var bar = document.createElement('div');
            bar.className = 'mdb-conflict-bar';
            /** @type {{letter?: string, text?: string} | null} */
            var chosen = null;
            var status = document.createElement('span');
            status.className = 'mdb-editor-status';
            var decide = document.createElement('button');
            decide.className = 'mdb-editor-btn mdb-conflict-decide';
            decide.innerHTML = '<span class="codicon codicon-check"></span> Decide';
            decide.title = 'Write the chosen text into the paragraph and remove the conflict';
            decide.disabled = true;
            var pick = function(btn, choice) {
                chosen = choice;
                bar.querySelectorAll('.mdb-conflict-choice').forEach(function(b) { b.classList.toggle('mdb-team-active', b === btn); });
                decide.disabled = false;
            };
            var option = function(label, title, choice, members) {
                var btn = document.createElement('button');
                btn.className = 'mdb-editor-btn mdb-conflict-choice';
                btn.dataset.choice = choice.letter;
                btn.title = title;
                btn.appendChild(document.createTextNode(label + ' '));
                (members || []).forEach(function(id) { btn.appendChild(memberChip(id)); });
                btn.addEventListener('click', function(e) { e.stopPropagation(); pick(btn, choice); });
                bar.appendChild(btn);
            };
            c.alternatives.forEach(function(a) { option('(' + a.letter + ')', 'Take ' + a.members.map(memberName).join(', ') + '\'s text: ' + a.text, { letter: a.letter }, a.members); });
            option('Keep base', 'Keep the text as it was: ' + c.base, { letter: 'base' }, []);
            var rewrite = document.createElement('button');
            rewrite.className = 'mdb-editor-btn mdb-conflict-rewrite';
            rewrite.innerHTML = '<span class="codicon codicon-edit"></span> Rewrite…';
            rewrite.title = 'Write the text yourself, starting from the chosen one';
            rewrite.addEventListener('click', function(e) {
                e.stopPropagation();
                var initial = mdbConflictChosenText(c, chosen || { letter: 'base' }) || '';
                openEditor(rewrite, wrapper, initial, function(value) {
                    if (!value.trim()) { return { hold: 'Write the text first.' }; }
                    return conflictEdit(block, { text: value.trim() });
                });
            });
            bar.appendChild(rewrite);
            decide.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!chosen) { return; }
                var edit = conflictEdit(block, chosen);
                if (!edit) { status.textContent = 'That alternative is not there any more; reload.'; return; }
                setNavAnchor(navKey(wrapper));
                postEdit(edit);
            });
            bar.appendChild(decide);
            var keepOpen = document.createElement('button');
            keepOpen.className = 'mdb-editor-btn mdb-conflict-open';
            keepOpen.innerHTML = '<span class="codicon codicon-circle-large-outline"></span> Keep open…';
            keepOpen.title = 'Hand it back undecided: `open:` and a summary of the positions';
            keepOpen.addEventListener('click', function(e) {
                e.stopPropagation();
                var initial = /^open:/i.test(c.decision) ? c.decision : 'open: ' + c.alternatives.map(function(a) {
                    return a.members.map(memberName).join(', ') + ' (' + a.letter + ') ' + a.text.replace(/\s*\n\s*/g, ' ');
                }).join('; ');
                openEditor(keepOpen, wrapper, initial, function(value) {
                    var text = value.trim();
                    if (!/^open:/i.test(text)) { text = 'open: ' + text; }
                    return conflictEdit(block, { open: text });
                });
            });
            bar.appendChild(keepOpen);
            bar.appendChild(status);
            if (!unresolved) {
                status.textContent = 'Decided: ' + c.decision + ' — applied when the annotations are removed.';
            }
            wrapper.appendChild(bar);
        }

        // ---- Navigation: from change to change, comment to comment, question to question ----
        var NAV_TARGETS = {
            changes: '.mdb-rm[data-kind="change"]',
            comments: '.mdb-comment-block',
            inline: '.mdb-rm[data-kind="note"]',
            questions: '.mdb-answer-btn',
            unanswered: '.mdb-answer-btn[data-unanswered="1"]',
            marked: '.mdb-check-here',
            agent: '.mdb-comment-block[data-agent="1"], .mdb-rm[data-kind="note"][data-agent="1"]',
            conflicts: '.mdb-conflict',
            // Next unresolved: a conflict without a decision, a question without a team answer, an undecided change.
            unresolved: '.mdb-conflict[data-open="1"], .mdb-answer-btn[data-unanswered="1"], .mdb-rm[data-kind="change"]',
        };
        // ---- Whose: the authors whose comments and changes the arrows find ----
        // Every author the document names (comment blocks' `(author)`, attribution
        // tokens) plus "no author", all ticked at first; an author seen later
        // comes in ticked. Questions and markers are found whoever wrote them.
        var NO_AUTHOR = '';
        var navHiddenAuthors = {};
        var navAuthorsEl = document.getElementById('navAuthors');
        function authorsOf(el) {
            return el.dataset && el.dataset.authors ? el.dataset.authors.split('|') : [];
        }
        /** Whether the author filter lets `el` through. */
        function navAuthorAllows(el) {
            if (!el.classList.contains('mdb-comment-block') && !el.classList.contains('mdb-rm')) { return true; }
            var authors = authorsOf(el);
            if (authors.length === 0) { return !navHiddenAuthors[NO_AUTHOR]; }
            return authors.some(function(a) { return !navHiddenAuthors[a]; });
        }
        // ---- Changed since: what was written or changed at or after a chosen time ----
        // Comment blocks, marks and questions record their change time (SOM
        // §11.9.10, `data-changed-at`); one written without a time is older than
        // any time chosen. Markers and conflicts carry no time and stay found.
        var navSinceEl = document.getElementById('navSince');
        var navSinceAtEl = document.getElementById('navSinceAt');
        /** The chosen time as epoch ms; null for any time (or a chosen time not filled in yet). */
        function navSinceMs() {
            var choice = navSinceEl ? navSinceEl.value : '';
            var now = Date.now();
            if (choice === '1h') { return now - 3600000; }
            if (choice === '24h') { return now - 86400000; }
            if (choice === '7d') { return now - 7 * 86400000; }
            if (choice === 'today') { var d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
            if (choice === 'custom' && navSinceAtEl && navSinceAtEl.value) {
                var ms = Date.parse(navSinceAtEl.value);
                return isNaN(ms) ? null : ms;
            }
            return null;
        }
        /** Whether the "changed since" filter lets `el` through. */
        function navSinceAllows(el) {
            var since = navSinceMs();
            if (since === null) { return true; }
            if (!el.classList.contains('mdb-comment-block') && !el.classList.contains('mdb-rm') && !el.classList.contains('mdb-answer-btn')) { return true; }
            var at = el.dataset.changedAt ? Date.parse(el.dataset.changedAt) : NaN;
            return !isNaN(at) && at >= since;
        }
        if (navSinceEl) {
            navSinceEl.addEventListener('change', function() {
                if (navSinceAtEl) { navSinceAtEl.hidden = navSinceEl.value !== 'custom'; }
            });
        }
        /** Whether the author and the "changed since" filters let `el` through. */
        function navAllows(el) {
            return navAuthorAllows(el) && navSinceAllows(el);
        }
        /** The targets of `selector` in document order that the filters let through. */
        function navTargetsOf(selector) {
            return Array.prototype.slice.call(docRoot.querySelectorAll(selector)).filter(navAllows);
        }
        /** Rebuild the Whose list from the document shown, keeping what was unticked. */
        function renderNavAuthors() {
            if (!navAuthorsEl) { return; }
            var seen = {};
            Array.prototype.forEach.call(docRoot.querySelectorAll('.mdb-comment-block, .mdb-rm'), function(el) {
                var authors = authorsOf(el);
                if (authors.length === 0) { seen[NO_AUTHOR] = true; }
                authors.forEach(function(a) { seen[a] = true; });
            });
            var names = Object.keys(seen).filter(function(a) { return a !== NO_AUTHOR; }).sort(function(a, b) {
                return Number(mdbIsAgentAuthor(a)) - Number(mdbIsAgentAuthor(b)) || a.localeCompare(b);
            });
            if (seen[NO_AUTHOR]) { names.push(NO_AUTHOR); }
            navAuthorsEl.innerHTML = '';
            if (names.length === 0) {
                navAuthorsEl.textContent = 'No comments or changes';
                return;
            }
            names.forEach(function(name) {
                var label = document.createElement('label');
                var box = document.createElement('input');
                box.type = 'checkbox';
                box.dataset.navAuthor = name;
                box.checked = !navHiddenAuthors[name];
                label.appendChild(box);
                label.appendChild(document.createTextNode(' ' + (name === NO_AUTHOR ? '(no author)' : name + (name === reviewMemberId ? ' (you)' : ''))));
                navAuthorsEl.appendChild(label);
            });
        }
        if (navAuthorsEl) {
            navAuthorsEl.addEventListener('change', function(e) {
                var box = e.target;
                if (!box || box.dataset.navAuthor === undefined) { return; }
                if (box.checked) { delete navHiddenAuthors[box.dataset.navAuthor]; } else { navHiddenAuthors[box.dataset.navAuthor] = true; }
            });
        }
        var navKindBtn = document.getElementById('navKindBtn');
        var navKindPop = document.getElementById('navKindPop');
        var navKindBoxes = navKindPop ? Array.prototype.slice.call(navKindPop.querySelectorAll('input[data-nav-kind]')) : [];
        /** The kinds ticked in the popup, in its order. */
        function navKinds() {
            return navKindBoxes.filter(function(b) { return b.checked; }).map(function(b) { return b.dataset.navKind; });
        }
        /** One selector for every target of `kinds`: querySelectorAll gives them in document order. */
        function navSelector(kinds) {
            return kinds.map(function(k) { return NAV_TARGETS[k]; }).filter(Boolean).join(', ');
        }
        function updateNavKindLabel() {
            if (!navKindBtn) { return; }
            var ticked = navKindBoxes.filter(function(b) { return b.checked; });
            var name = function(b) { return b.parentNode.textContent.trim(); };
            navKindBtn.textContent = ticked.length === 0 ? 'Nothing'
                : ticked.length === navKindBoxes.length ? 'All'
                    : name(ticked[0]) + (ticked.length > 1 ? ' + ' + (ticked.length - 1) : '');
            navKindBtn.title = 'What the arrows step through: ' + (ticked.length ? ticked.map(name).join(', ') : 'nothing') + ' — tick one kind or several';
            // A "changed since" filter in force is said on the button too.
            var since = navSinceEl && navSinceEl.value ? navSinceEl.options[navSinceEl.selectedIndex].textContent.replace(/…$/, '') : '';
            if (since) {
                navKindBtn.textContent += ' · since';
                navKindBtn.title += '; only what changed since: ' + since.toLowerCase();
            }
        }
        var navCurrent = null;
        // Where navigation goes on from after a save or a decision replaced
        // the element navigated to last: `{line, ord}` (mdbNavPick), or null.
        var navAnchor = null;
        function setNavAnchor(key) {
            if (!key) { return; }
            if (navCurrent) { navCurrent.classList.remove('mdb-nav-current'); }
            navCurrent = null;
            navAnchor = key;
        }
        /** A target's position: its source line and, for a mark, its index among the block's marks. */
        function navKey(el) {
            if (el.__mdbLine) { return { line: el.__mdbLine(), ord: 0 }; }
            var wrapper = el.closest('.mdb-block');
            var block = wrapper && wrapper.__mdbBlock;
            if (!block) { return null; }
            var ord = 0;
            if (el.classList.contains('mdb-rm')) { ord = Array.prototype.indexOf.call(wrapper.querySelectorAll('.mdb-rm'), el); }
            return { line: block.startLine, ord: ord };
        }
        /** What is shown above a target when going there: its question, the paragraph a comment is on. */
        function navContext(el) {
            if (el.__mdbLine) {
                var q = mdbQuestionAt(shownLines(), el.__mdbLine(), runtimeQuestions());
                if (q) {
                    for (var i = 0; i < shownBlocks.length; i++) {
                        if (shownBlocks[i].startLine <= q.line && q.line < shownBlocks[i].endLine && shownWrappers[i]) { return shownWrappers[i]; }
                    }
                }
            }
            if (el.classList.contains('mdb-comment-block')) {
                var before = el.previousElementSibling;
                return before && before.classList.contains('mdb-block') ? before : el;
            }
            return el.closest('.mdb-block') || el;
        }
        function navigate(delta, forceKinds) {
            if (openEditors > 0) { return; }
            var kinds = forceKinds || navKinds();
            var selector = navSelector(kinds);
            if (!selector) { return; }
            var targets = navTargetsOf(selector);
            if (targets.length === 0) { return; }
            var index = navCurrent && navCurrent.isConnected ? targets.indexOf(navCurrent) : -1;
            if (index >= 0) {
                index = (index + delta + targets.length) % targets.length;
            } else if (navAnchor) {
                index = mdbNavPick(targets.map(navKey), navAnchor, delta);
                if (index < 0) { index = 0; }
            } else if (delta > 0) {
                // From the reading position: the first one at or below the top of the view.
                index = targets.findIndex(function(t) { return offsetInView(t) >= 0; });
                if (index < 0) { index = 0; }
            } else {
                index = -1;
                for (var i = targets.length - 1; i >= 0; i--) { if (offsetInView(targets[i]) < 0) { index = i; break; } }
                if (index < 0) { index = targets.length - 1; }
            }
            if (navCurrent) { navCurrent.classList.remove('mdb-nav-current'); }
            navAnchor = null;
            navCurrent = targets[index];
            navCurrent.classList.add('mdb-nav-current');
            showNavCount();
            // An unanswered question opens ready to answer, the recommended option filled in.
            var editor = kinds.indexOf('unanswered') >= 0 && navCurrent.dataset.unanswered === '1' && navCurrent.__mdbOpenAnswer
                ? navCurrent.__mdbOpenAnswer() : null;
            // The question (or the commented paragraph) at the top, the target — or its editor — in view.
            jumpWithinDocument(navCurrent, navContext(navCurrent), editor || navCurrent);
        }
        /**
         * How many targets the ticked kinds have and which is current (`2/4`,
         * `–/4` before the first step): after each step and change of the
         * kinds at once, after a change of the document (a decision, a save, a
         * render) once it has settled.
         */
        var navCountEl = document.getElementById('navCount');
        function showNavCount() {
            if (!navCountEl) { return; }
            var selector = navSelector(navKinds());
            if (!selector) { navCountEl.textContent = ''; return; }
            var targets = navTargetsOf(selector);
            var index = navCurrent && navCurrent.isConnected ? targets.indexOf(navCurrent) : -1;
            navCountEl.textContent = mdbCountLabel(index, targets.length);
        }
        var navCountTimer = null;
        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(function() {
                if (navCountTimer) { clearTimeout(navCountTimer); }
                navCountTimer = setTimeout(function() { navCountTimer = null; showNavCount(); }, 100);
            }).observe(contentArea, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-unanswered'] }); // docRoot is replaced on a full render
        }
        var navPrevBtn = document.getElementById('navPrevBtn');
        var navNextBtn = document.getElementById('navNextBtn');
        if (navPrevBtn) { navPrevBtn.addEventListener('click', function() { navigate(-1); }); }
        if (navNextBtn) { navNextBtn.addEventListener('click', function() { navigate(1); }); }
        if (navKindPop) {
            navKindPop.addEventListener('change', function() {
                updateNavKindLabel();
                showNavCount();
                // Other kinds go on from the current target: after it while it is
                // still one of them, else from its place.
                if (navCurrent && navCurrent.isConnected) {
                    var selector = navSelector(navKinds());
                    if (!selector || !navCurrent.matches(selector) || !navAllows(navCurrent)) { setNavAnchor(navKey(navCurrent)); }
                } else if (navCurrent) {
                    navCurrent.classList.remove('mdb-nav-current');
                    navCurrent = null;
                }
            });
            navKindPop.addEventListener('click', function(e) { e.stopPropagation(); });
        }
        if (navKindBtn && navKindPop) {
            navKindBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (navKindPop.hidden) { renderNavAuthors(); }
                navKindPop.hidden = !navKindPop.hidden;
            });
            document.addEventListener('click', function() { navKindPop.hidden = true; });
            updateNavKindLabel();
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
                var target = headingForRef(r.ids);
                // A single id inside its own heading is that heading's name, not a reference to it.
                if (target && !(r.ids.length === 1 && target.contains(node))) { found.push({ start: r.start, end: r.end, ref: r.ids.join(' > ') }); }
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
                var hit = topElementOf(document.elementFromPoint(r.left + r.width / 2, y));
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

        /**
         * Go to `target`, remembering where the reader was. With `context`, that
         * is put at the top instead (the question of an answer), as long as
         * `keep` (the target, or its open editor) stays in view.
         */
        function jumpWithinDocument(target, context, keep) {
            docBack.push(capturePosition());
            docForward = [];
            revealElement(target);
            if (keep) {
                var view = contentArea.clientHeight || contentArea.getBoundingClientRect().height;
                var keepBottom = keep.getBoundingClientRect().bottom - contentArea.getBoundingClientRect().top;
                contentArea.scrollTop += mdbRevealDelta(offsetInView(context || target), keepBottom, view, 8);
            } else {
                contentArea.scrollTop += offsetInView(target) - 8;
            }
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
                var review = t.closest('.mdb-rm-btn');
                if (review) {
                    e.stopPropagation();
                    if (review.classList.contains('mdb-rm-edit')) { editInlineComment(review); }
                    else if (review.classList.contains('mdb-rm-comment')) { commentOnChange(review); }
                    else { decideReviewMark(review); }
                    return;
                }
                var removeComment = t.closest('.mdb-comment-remove-btn');
                if (removeComment) {
                    e.stopPropagation();
                    var holder = removeComment.closest('.mdb-block');
                    if (holder && holder.__mdbBlock) { removeCommentBlock(holder.__mdbBlock); }
                    return;
                }
                var action = t.closest('.mdb-edit-btn, .mdb-insert-btn, .mdb-comment-btn');
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
        // Matches are kept as two parallel number arrays (element index, offset)
        // with no cap: a cap left a short query without any match past the
        // first part of a large document, so it could not start where the
        // reader is.
        var search = { query: '', texts: null, els: null, mEl: [], mAt: [], current: -1 };

        function searchIndex() {
            if (!search.texts) {
                search.els = topElements();
                search.texts = search.els.map(function(el) { return (el.textContent || '').toLowerCase(); });
            }
        }

        /**
         * Find the query. With `jump`, go to the first match at or after where
         * the reader is: the current match while it is in view (so typing on
         * stays on it), else the block at the top of the view; past the last
         * match, the first from the top.
         */
        function runSearch(jump) {
            var q = searchInput ? searchInput.value.toLowerCase() : '';
            var from = jump ? searchStart() : null;
            search.query = q;
            search.mEl = [];
            search.mAt = [];
            if (q) {
                searchIndex();
                for (var i = 0; i < search.texts.length; i++) {
                    var text = search.texts[i];
                    for (var at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) {
                        search.mEl.push(i);
                        search.mAt.push(at);
                    }
                }
            }
            if (jump) {
                search.current = matchAtOrAfter(from.el, from.at);
                showSearchMatch(true);
            } else {
                search.current = Math.min(search.current, search.mEl.length - 1);
                showSearchMatch(false);
            }
        }

        /** Where a search starts: the current match while it is in view, else the top of the view. */
        function searchStart() {
            var c = search.current;
            if (c >= 0 && c < search.mEl.length && search.els) {
                var el = search.els[search.mEl[c]];
                var off = el && el.isConnected ? offsetInView(el) : -1;
                if (off >= 0 && off <= contentArea.clientHeight) { return { el: search.mEl[c], at: search.mAt[c] }; }
            }
            searchIndex();
            var top = topVisibleElement();
            var index = top ? search.els.indexOf(top) : -1;
            return { el: Math.max(0, index), at: 0 };
        }

        /** The first match at or after (element, offset), wrapping to the first; -1 when there is none. */
        function matchAtOrAfter(el, at) {
            var n = search.mEl.length;
            if (n === 0) { return -1; }
            var lo = 0;
            var hi = n;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (search.mEl[mid] < el || (search.mEl[mid] === el && search.mAt[mid] < at)) { lo = mid + 1; } else { hi = mid; }
            }
            return lo < n ? lo : 0;
        }

        function firstMatchFromView() {
            var from = searchStart();
            return matchAtOrAfter(from.el, from.at);
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
            var n = search.mEl.length;
            if (searchClearBtn) { searchClearBtn.classList.toggle('visible', !!(searchInput && searchInput.value)); }
            if (searchCount) {
                searchCount.textContent = !search.query ? '' : mdbCountLabel(search.current, n);
                searchCount.title = !search.query ? '' : n === 0 ? 'No results' : 'Current match / matches';
            }
            if (searchPrevBtn) { searchPrevBtn.disabled = n === 0 || openEditors > 0; }
            if (searchNextBtn) { searchNextBtn.disabled = n === 0 || openEditors > 0; }
            if (highlightsSupported) {
                CSS.highlights.delete('mdb-search');
                CSS.highlights.delete('mdb-search-current');
            }
            if (search.current < 0 || n === 0) { return; }
            var matchEl = search.mEl[search.current];
            var el = search.els[matchEl];
            if (scroll) { revealElement(el); }
            var range = textRange(el, search.mAt[search.current], search.query.length);
            if (highlightsSupported) {
                // The other matches near this one, so the neighbourhood is visible too.
                var near = [];
                for (var i = Math.max(0, search.current - 200); i < Math.min(n, search.current + 200); i++) {
                    if (i === search.current || Math.abs(search.mEl[i] - matchEl) > 40) { continue; }
                    var r = textRange(search.els[search.mEl[i]], search.mAt[i], search.query.length);
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
            var n = search.mEl.length;
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

        // ---- The document changed on disk while editors are open (vscimpb66b) ----
        // A refresh no longer waits silently for the last editor to close: editors
        // holding nothing typed go and the new version shows; with typed text the
        // bar asks first. A save of text typed against the old version is refused
        // by the host when its lines changed (`expected`), so it never overwrites
        // the new answer.

        /** Close every open editor without rendering a held refresh (the caller renders). */
        function closeAllEditors() {
            pendingContent = null;
            liveEditors.slice().forEach(function(e) { e.close(); });
            Array.prototype.forEach.call(docRoot.querySelectorAll('.mdb-editor'), function(ed) { ed.parentNode.removeChild(ed); });
            liveEditors = [];
            openEditors = 0;
            updateEditorLocks();
        }

        function hideChangeBar() {
            var bar = document.getElementById('mdbChangeBar');
            if (bar) { bar.hidden = true; }
        }

        /** The ask: the document changed (`ids`) while text is typed in `count` editors. */
        function showChangeBar(ids, count) {
            var bar = document.getElementById('mdbChangeBar');
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'mdbChangeBar';
                bar.className = 'mdb-change-bar';
                bar.setAttribute('role', 'alert');
                document.body.insertBefore(bar, document.body.firstChild);
            }
            bar.textContent = '';
            var text = document.createElement('span');
            text.className = 'mdb-change-text';
            text.textContent = (ids.length ? ids.join(', ') + (ids.length === 1 ? ' was' : ' were') : 'The document was')
                + ' changed on disk while you are typing in ' + (count === 1 ? 'an editor' : count + ' editors') + '.';
            bar.appendChild(text);
            var show = document.createElement('button');
            show.className = 'mdb-change-btn';
            show.dataset.changeAction = 'show';
            show.textContent = 'Show the new version';
            show.title = 'Close the editors (your typed text is dropped) and show what is in the file now';
            show.addEventListener('click', function() {
                var held = pendingContent;
                hideChangeBar();
                closeAllEditors();
                if (held) { handleContent(held); }
            });
            var keep = document.createElement('button');
            keep.className = 'mdb-change-btn';
            keep.dataset.changeAction = 'keep';
            keep.textContent = 'Keep my text';
            keep.title = 'Go on typing; the new version shows when you close the editors. A save over lines that changed is refused, so it never overwrites the new text.';
            keep.addEventListener('click', function() { hideChangeBar(); });
            bar.appendChild(show);
            bar.appendChild(keep);
            bar.hidden = false;
        }

        /** Scroll to the first question a refresh changed and mark the changed ones briefly. */
        function showChangedQuestions(changed) {
            if (!changed || !changed.length || shownCrlf) { return; }
            var wrappers = Array.prototype.slice.call(docRoot.querySelectorAll('.mdb-block'));
            var first = null;
            changed.forEach(function(q) {
                var w = wrappers.find(function(el) {
                    var b = el.__mdbBlock;
                    return b && b.startLine <= q.line && q.line < b.endLine;
                });
                if (!w) { return; }
                if (!first) { first = w; }
                w.classList.add('mdb-changed');
                setTimeout(function() { w.classList.remove('mdb-changed'); }, 2500);
            });
            if (first) {
                revealElement(first);
                if (typeof first.scrollIntoView === 'function') { first.scrollIntoView({ block: 'center' }); }
            }
        }

        function handleContent(msg) {
            var forced = forceRender;
            forceRender = false;
            // The host answered a change with the new content.
            endBusy();
            if (forced) {
                // Reload: open editors go with the old rendering.
                Array.prototype.forEach.call(docRoot.querySelectorAll('.mdb-editor'), function(ed) { ed.parentNode.removeChild(ed); });
                openEditors = 0;
                liveEditors = [];
                pendingContent = null;
                hideChangeBar();
                updateEditorLocks();
                if (msg.filePath === currentFilePath && contentArea) { restoreScrollTop = contentArea.scrollTop; }
            }
            var sameFileText = msg.filePath === currentFilePath && !msg.error;
            // The questions this refresh changes (not after our own save: the reader stays put).
            changedOnRender = sameFileText && restoreScrollTop === null && typeof mdbChangedQuestions === 'function' && shownText && msg.content !== shownText
                ? mdbChangedQuestions(shownText, msg.content || '') : null;
            if (openEditors > 0 && sameFileText) {
                var typed = liveEditors.filter(function(e) { return e.area.value !== e.initial; });
                if (typed.length === 0) {
                    // Nothing typed: the editors go, the new version shows.
                    closeAllEditors();
                } else {
                    // Typed text: hold the refresh and ask.
                    pendingContent = msg;
                    showChangeBar((changedOnRender || []).map(function(q) { return q.id; }), typed.length);
                    return;
                }
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
                lineMap = Array.isArray(msg.lineMap) ? msg.lineMap : null;
                if (typeof msg.crlf === 'boolean') {
                    crlfMode = msg.crlf;
                    if (crlfBtn) crlfBtn.classList.toggle('active', crlfMode);
                }
                filePathEl.textContent = msg.relativePath || msg.fileName || '';
                if (typeof msg.author === 'string') { commentAuthor = msg.author; }
                reviewMemberId = typeof msg.memberId === 'string' ? msg.memberId : '';
                // Also when the text is the same and is not rendered again (the setting changed).
                markOwnLines();
                var text = msg.content || '';
                // What the host read for an earlier text no longer fits this one.
                if (!sameFile || text !== shownText) { somComments = null; }
                if (!sameFile) {
                    roundMembers = [];
                    docMembers = [];
                    teamRevisions = [];
                    teamFilter = '';
                    setTeam();
                }
                // The same text again (the file watcher after our own save, a
                // reload with nothing changed): what is shown is already it.
                if (!forced && sameFile && text === shownText && crlfMode === shownCrlf && docRoot.parentNode === contentArea && docRoot.querySelector('.mdb-block')) {
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
                    var changed = sameFile ? changedOnRender : null;
                    changedOnRender = null;
                    afterRender(sameFile, anchor, position);
                    showChangedQuestions(changed);
                    if (afterNextRender) {
                        var then = afterNextRender;
                        afterNextRender = null;
                        then(true);
                    }
                });
            }
        }

        /** Where the reader is put after a full render. */
        function afterRender(sameFile, anchor, position) {
            decorateTeamReview();
            markOwnLines();
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

            // A long comment rendered by the host for the overlay (mdViewButtonsHtml).
            if (msg.type === 'markdownHtml') {
                if (typeof tomMdOverlayShow === 'function') { tomMdOverlayShow(msg.title || '', msg.html || ''); }
                return;
            }

            if (msg.type === 'mdContent') {
                handleContent(msg);
            } else if (msg.type === 'somComments') {
                // Only for the text shown: the host read exactly that text.
                if (msg.filePath === currentFilePath && msg.contentLength === (shownText || '').length) {
                    somComments = { nextCommentNumber: msg.nextCommentNumber, formFieldRanges: msg.formFieldRanges || [], questions: msg.questions || {} };
                    applySomComments();
                    docMembers = Array.isArray(msg.team) ? msg.team : [];
                    teamRevisions = Array.isArray(msg.revisions) ? msg.revisions : [];
                    setTeam();
                }
            } else if (msg.type === 'reviewTeam') {
                // The round the file belongs to (round.yaml): its team and guests.
                if (msg.filePath === currentFilePath) {
                    roundMembers = Array.isArray(msg.members) ? msg.members : [];
                    setTeam();
                }
            } else if (msg.type === 'actionDone') {
                // A review decision the host answered without new content (nothing to change, or refused).
                endBusy();
            } else if (msg.type === 'editResult') {
                endBusy();
                var saved = pendingSaves[msg.editId];
                delete pendingSaves[msg.editId];
                if (saved) {
                    if (msg.ok) {
                        saved.close();
                        // Navigation goes on from behind what was just saved.
                        setNavAnchor({ line: saved.edit.startLine + saved.edit.replacement.split('\n').length, ord: 0 });
                        // Patch the region the edit touched; the file's own
                        // refresh that follows is then the same text and skipped.
                        var patched = patchAfterSave(saved.edit);
                        if (patched) { restoreScrollTop = null; }
                        // Save and next: on the patched document now, else once the full render is in.
                        if (saved.after) {
                            if (patched) { saved.after(true); } else { afterNextRender = saved.after; }
                        }
                        // The edit moved lines: wait for the host's reading of the new text.
                        somComments = null;
                        applySomComments();
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
