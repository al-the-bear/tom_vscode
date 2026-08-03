// @ts-nocheck
/* global vscode, isExpanded, qlogTabIds, qlogDefaultTab, qlogVariantTabs, qlogVariantIds, qlogDefaultVariant */
// Quest Logs client script — the Logs section of the @WS accordion panel.
// Static body of getQuestLogsScript() in src/handlers/questLogs-handler.ts; the
// config lines (`qlogTabIds`, `qlogDefaultTab`, `qlogVariantTabs`,
// `qlogVariantIds`, `qlogDefaultVariant`) are prepended by that function. Uses
// the ambient `vscode` handle and `isExpanded` from the accordion base script,
// so it does NOT call acquireVsCodeApi() itself.
//
// The client keeps no copy of the file: it asks the host for HTML and swaps it
// in. The host answers `qlogUnchanged` when the file has not moved, which is
// what makes a 2.5 s poll of a half-megabyte trail cheap.
//
// Most tabs are one file. Current Prompt is six, picked from a dropdown, so
// every message carries a `variant` alongside the tab and every reply is
// matched on both — switching the dropdown mid-poll must not paint the previous
// selection's text under the new label.

/** Poll interval. The requirement is "at least every 3 seconds". */
var QLOG_POLL_MS = 2500;
/** How close to a file's newest end still counts as "following it", in pixels. */
var QLOG_STICKY_SLACK = 40;

var qlogActiveTab = qlogDefaultTab;
var qlogActiveVariant = qlogDefaultVariant;
var qlogPollTimer = null;
/** Identity of the view that has content, so switches can show a spinner. */
var qlogLoadedView = '';

function qlogIsKnownTab(id) {
    return typeof id === 'string' && qlogTabIds.indexOf(id) >= 0;
}

function qlogIsKnownVariant(id) {
    return typeof id === 'string' && qlogVariantIds.indexOf(id) >= 0;
}

/** Whether the active tab picks its file from the dropdown. */
function qlogTabHasVariants() {
    return qlogVariantTabs.indexOf(qlogActiveTab) >= 0;
}

/**
 * What is on screen — the same identity the host keys its change-detection
 * cache by. For a one-file tab that is just the tab id.
 */
function qlogViewKey() {
    return qlogTabHasVariants() ? qlogActiveTab + ':' + qlogActiveVariant : qlogActiveTab;
}

/**
 * Restore the tab and dropdown selection from before the last window reload.
 * State is merged rather than replaced — `vscode.setState` overwrites the whole
 * object and the accordion stores its expanded/pinned sections in the same
 * place.
 */
function qlogLoadState() {
    try {
        var s = vscode.getState();
        if (s && qlogIsKnownTab(s.qlogTab)) { qlogActiveTab = s.qlogTab; }
        if (s && qlogIsKnownVariant(s.qlogVariant)) { qlogActiveVariant = s.qlogVariant; }
    } catch (e) { /* first run — keep the defaults */ }
}

function qlogSaveState() {
    try {
        var s = vscode.getState() || {};
        s.qlogTab = qlogActiveTab;
        s.qlogVariant = qlogActiveVariant;
        vscode.setState(s);
    } catch (e) { /* state is a convenience, never a correctness requirement */ }
}

function qlogSectionVisible() {
    return typeof isExpanded === 'function' ? isExpanded('logs') : true;
}

function qlogSetStatus(text) {
    var bar = document.getElementById('qlog-status');
    if (bar) { bar.textContent = text; }
}

function qlogRenderTabStrip() {
    var strip = document.getElementById('qlog-tabs');
    if (!strip) { return; }
    var buttons = strip.querySelectorAll('[data-qlog-tab]');
    for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        if (btn.getAttribute('data-qlog-tab') === qlogActiveTab) { btn.classList.add('active'); }
        else { btn.classList.remove('active'); }
    }
}

/** Show the dropdown only for a tab that actually has variants. */
function qlogRenderVariantPicker() {
    var picker = document.getElementById('qlog-variant');
    if (!picker) { return; }
    picker.hidden = !qlogTabHasVariants();
    if (picker.value !== qlogActiveVariant) { picker.value = qlogActiveVariant; }
}

/** Clear the viewer and fetch, shared by tab and dropdown switches. */
function qlogShowSelection() {
    qlogLoadedView = '';
    qlogSaveState();
    qlogRenderTabStrip();
    qlogRenderVariantPicker();
    var body = document.getElementById('qlog-body');
    if (body) { body.innerHTML = '<div class="qlog-empty">Loading…</div>'; }
    qlogRequest(true);
}

function qlogSelectTab(id) {
    if (!qlogIsKnownTab(id) || id === qlogActiveTab) { return; }
    qlogActiveTab = id;
    qlogShowSelection();
}

function qlogSelectVariant(id) {
    if (!qlogIsKnownVariant(id) || id === qlogActiveVariant) { return; }
    qlogActiveVariant = id;
    qlogShowSelection();
}

/**
 * Ask the host for the active view's content.
 *
 * `force` is set whenever this pane is not already showing that view, not just
 * when the user pressed refresh. The host answers `qlogUnchanged` by comparing
 * against what it last *sent*, and its memory outlives this webview — after the
 * panel is recreated a plain poll would be answered "nothing changed" against
 * content that this pane never received, leaving it stuck on "Loading…".
 */
function qlogRequest(force) {
    if (!qlogSectionVisible()) { return; }
    var stale = qlogLoadedView !== qlogViewKey();
    vscode.postMessage({
        type: 'qlogRequest',
        tab: qlogActiveTab,
        variant: qlogActiveVariant,
        force: !!force || stale,
    });
}

function qlogFormatBytes(bytes) {
    if (!bytes) { return '0 B'; }
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1024 * 1024) { return Math.round(bytes / 1024) + ' KB'; }
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Swap in freshly rendered content, keeping the reader where they were.
 *
 * The point of the view is to watch a file grow, and `newestAt` says at which
 * end it grows: the trail is appended to, the quest documents are prepended to
 * or rewritten wholesale. So the view opens at that end and a reader still
 * sitting there is kept there — while a reader who scrolled away to study
 * something keeps their position.
 */
function qlogApplyContent(msg) {
    var body = document.getElementById('qlog-body');
    if (!body) { return; }

    if (!msg.exists) {
        body.innerHTML = '<div class="qlog-empty"></div>';
        body.firstChild.textContent = msg.error
            ? (msg.fileName + ' — ' + msg.error)
            : (msg.fileName + ' — not found in quest "' + msg.questId + '"');
        qlogSetStatus(msg.fileName + ' — not available');
        qlogLoadedView = qlogViewKey();
        return;
    }

    var atStart = msg.newestAt === 'start';
    var wasFollowing = atStart
        ? body.scrollTop <= QLOG_STICKY_SLACK
        : body.scrollHeight - body.scrollTop - body.clientHeight <= QLOG_STICKY_SLACK;
    var firstLoad = qlogLoadedView !== qlogViewKey();
    body.innerHTML = msg.html || '<div class="qlog-empty">(empty)</div>';
    if (firstLoad || wasFollowing) { body.scrollTop = atStart ? 0 : body.scrollHeight; }
    qlogLoadedView = qlogViewKey();

    var stamp = new Date().toLocaleTimeString();
    qlogSetStatus(
        msg.fileName + ' · ' + qlogFormatBytes(msg.bytes)
        + (msg.truncated ? (atStart ? ' (head)' : ' (tail)') : '') + ' · ' + stamp,
    );
}

window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'qlogContent') { return; }
    // A reply in flight when the selection changed describes the old file.
    if (msg.tab !== qlogActiveTab) { return; }
    if (qlogTabHasVariants() && msg.variant !== qlogActiveVariant) { return; }
    qlogApplyContent(msg);
});

qlogLoadState();

setTimeout(function () {
    qlogRenderTabStrip();
    qlogRenderVariantPicker();

    var strip = document.getElementById('qlog-tabs');
    if (strip) {
        strip.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('[data-qlog-tab]') : null;
            if (btn) { qlogSelectTab(btn.getAttribute('data-qlog-tab')); }
        });
    }

    var picker = document.getElementById('qlog-variant');
    if (picker) {
        picker.addEventListener('change', function () { qlogSelectVariant(picker.value); });
    }

    var refreshBtn = document.getElementById('qlog-refresh');
    if (refreshBtn) { refreshBtn.addEventListener('click', function () { qlogRequest(true); }); }

    var openBtn = document.getElementById('qlog-open');
    if (openBtn) {
        openBtn.addEventListener('click', function () {
            vscode.postMessage({
                type: 'qlogOpenInEditor',
                tab: qlogActiveTab,
                variant: qlogActiveVariant,
            });
        });
    }

    qlogRequest(true);
    if (qlogPollTimer) { clearInterval(qlogPollTimer); }
    qlogPollTimer = setInterval(function () { qlogRequest(false); }, QLOG_POLL_MS);
}, 0);
