// @ts-nocheck
/* global vscode, isExpanded, qlogTabIds, qlogDefaultTab */
// Quest Logs client script — the Logs section of the @WS accordion panel.
// Static body of getQuestLogsScript() in src/handlers/questLogs-handler.ts; the
// two config lines (`qlogTabIds`, `qlogDefaultTab`) are prepended by that
// function. Uses the ambient `vscode` handle and `isExpanded` from the
// accordion base script, so it does NOT call acquireVsCodeApi() itself.
//
// The client keeps no copy of the file: it asks the host for HTML and swaps it
// in. The host answers `qlogUnchanged` when the file has not moved, which is
// what makes a 2.5 s poll of a half-megabyte trail cheap.

/** Poll interval. The requirement is "at least every 3 seconds". */
var QLOG_POLL_MS = 2500;
/** How close to the bottom still counts as "following the tail", in pixels. */
var QLOG_STICKY_SLACK = 40;

var qlogActiveTab = qlogDefaultTab;
var qlogPollTimer = null;
/** Set once the current tab has content, so tab switches can show a spinner. */
var qlogLoadedTab = '';

function qlogIsKnownTab(id) {
    return typeof id === 'string' && qlogTabIds.indexOf(id) >= 0;
}

/**
 * Restore the tab selected before the last window reload. State is merged
 * rather than replaced — `vscode.setState` overwrites the whole object and the
 * accordion stores its expanded/pinned sections in the same place.
 */
function qlogLoadState() {
    try {
        var s = vscode.getState();
        if (s && qlogIsKnownTab(s.qlogTab)) { qlogActiveTab = s.qlogTab; }
    } catch (e) { /* first run — keep the default */ }
}

function qlogSaveState() {
    try {
        var s = vscode.getState() || {};
        s.qlogTab = qlogActiveTab;
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

function qlogSelectTab(id) {
    if (!qlogIsKnownTab(id) || id === qlogActiveTab) { return; }
    qlogActiveTab = id;
    qlogLoadedTab = '';
    qlogSaveState();
    qlogRenderTabStrip();
    var body = document.getElementById('qlog-body');
    if (body) { body.innerHTML = '<div class="qlog-empty">Loading…</div>'; }
    qlogRequest(true);
}

/**
 * Ask the host for the active tab's content.
 *
 * `force` is set whenever this pane is not already showing the tab, not just
 * when the user pressed refresh. The host answers `qlogUnchanged` by comparing
 * against what it last *sent*, and its memory outlives this webview — after the
 * panel is recreated a plain poll would be answered "nothing changed" against
 * content that this pane never received, leaving it stuck on "Loading…".
 */
function qlogRequest(force) {
    if (!qlogSectionVisible()) { return; }
    var stale = qlogLoadedTab !== qlogActiveTab;
    vscode.postMessage({ type: 'qlogRequest', tab: qlogActiveTab, force: !!force || stale });
}

function qlogFormatBytes(bytes) {
    if (!bytes) { return '0 B'; }
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1024 * 1024) { return Math.round(bytes / 1024) + ' KB'; }
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Swap in freshly rendered content. The trail is append-only and the point of
 * the view is to watch it grow, so a reader sitting at the bottom is kept
 * there; a reader who scrolled up to study something keeps their position.
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
        qlogLoadedTab = msg.tab;
        return;
    }

    var wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= QLOG_STICKY_SLACK;
    var firstLoad = qlogLoadedTab !== msg.tab;
    body.innerHTML = msg.html || '<div class="qlog-empty">(empty)</div>';
    if (firstLoad || wasAtBottom) { body.scrollTop = body.scrollHeight; }
    qlogLoadedTab = msg.tab;

    var stamp = new Date().toLocaleTimeString();
    qlogSetStatus(
        msg.fileName + ' · ' + qlogFormatBytes(msg.bytes)
        + (msg.truncated ? ' (tail)' : '') + ' · ' + stamp,
    );
}

window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'qlogContent') { return; }
    if (msg.tab !== qlogActiveTab) { return; }
    qlogApplyContent(msg);
});

qlogLoadState();

setTimeout(function () {
    qlogRenderTabStrip();

    var strip = document.getElementById('qlog-tabs');
    if (strip) {
        strip.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('[data-qlog-tab]') : null;
            if (btn) { qlogSelectTab(btn.getAttribute('data-qlog-tab')); }
        });
    }

    var refreshBtn = document.getElementById('qlog-refresh');
    if (refreshBtn) { refreshBtn.addEventListener('click', function () { qlogRequest(true); }); }

    var openBtn = document.getElementById('qlog-open');
    if (openBtn) {
        openBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'qlogOpenInEditor', tab: qlogActiveTab });
        });
    }

    qlogRequest(true);
    if (qlogPollTimer) { clearInterval(qlogPollTimer); }
    qlogPollTimer = setInterval(function () { qlogRequest(false); }, QLOG_POLL_MS);
}, 0);
