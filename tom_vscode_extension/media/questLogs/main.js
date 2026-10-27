// @ts-nocheck
/* global vscode, isExpanded, qlogViewers, qlogVariantTabs, qlogVariantIds, qlogDefaultVariant */
// Quest Logs client script — two read-only viewers of the @WS accordion panel:
// the Logs section (one Anthropic session's files, with a session switch) and
// the quest-document sub-tabs of the Documentation section.
// Static body of getQuestLogsScript() in src/handlers/questLogs-handler.ts; the
// config lines (`qlogViewers`, `qlogVariantTabs`, `qlogVariantIds`,
// `qlogDefaultVariant`) are prepended by that function. Uses the ambient
// `vscode` handle and `isExpanded` from the accordion base script, so it does
// NOT call acquireVsCodeApi() itself.
//
// The client keeps no copy of a file: it asks the host for HTML and swaps it
// in. The host answers `qlogUnchanged` when the file has not moved, which is
// what makes a 2.5 s poll of a half-megabyte trail cheap.
//
// Every message carries the viewer, the tab, the variant (Current Prompt has
// six files behind one tab) and, on a Logs tab, the session — and every reply
// is matched on all of them, so a switch mid-poll never paints the previous
// selection's text under the new label.
//
// The session switch is drawn from the host's plan (src/utils/sessionSwitch.ts):
// the sessions most recently used first, one button each for at most four, a
// dropdown with every session before them when there are more. The choice is
// remembered per tab.

/** Poll interval. The requirement is "at least every 3 seconds". */
var QLOG_POLL_MS = 2500;
/** How close to a file's newest end still counts as "following it", in pixels. */
var QLOG_STICKY_SLACK = 40;

function qlogEscape(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function qlogFormatBytes(bytes) {
    if (!bytes) { return '0 B'; }
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1024 * 1024) { return Math.round(bytes / 1024) + ' KB'; }
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * One viewer. `cfg`: `id` (sent with every message), `prefix` (of its element
 * ids), `section` (the accordion section whose visibility gates polling),
 * `tabIds`, `defaultTab`, `paneTabs` (tabs that show a pane of their own
 * instead of a file — the Documentation section's Documents editor) and
 * `sessions` (whether its tabs show one session's files).
 */
function qlogCreateViewer(cfg) {
    var v = {
        tab: cfg.defaultTab,
        variant: qlogDefaultVariant,
        /** The chosen session per tab ('' = the host's default). */
        sessionByTab: {},
        /** The plan the host sent last, per tab. */
        plans: {},
        loadedView: '',
    };
    var paneTabs = cfg.paneTabs || {};
    var stateKey = 'qlog_' + cfg.id;

    function el(name) { return document.getElementById(cfg.prefix + '-' + name); }
    function isKnownTab(id) { return typeof id === 'string' && cfg.tabIds.indexOf(id) >= 0; }
    function isKnownVariant(id) { return typeof id === 'string' && qlogVariantIds.indexOf(id) >= 0; }
    function isPaneTab() { return Object.prototype.hasOwnProperty.call(paneTabs, v.tab); }
    function hasVariants() { return qlogVariantTabs.indexOf(v.tab) >= 0; }
    function session() { return cfg.sessions ? (v.sessionByTab[v.tab] || '') : ''; }

    /** What is on screen — the identity the host keys its change-detection cache by. */
    function viewKey() {
        return v.tab + (hasVariants() ? ':' + v.variant : '') + (cfg.sessions ? '@' + session() : '');
    }

    // State is merged into the shared object: `vscode.setState` replaces the
    // whole of it, and the accordion and the other viewer keep theirs there.
    function loadState() {
        try {
            var all = vscode.getState() || {};
            // The Logs viewer reads the keys the single-viewer build wrote.
            var s = all[stateKey] || (cfg.id === 'logs' ? { tab: all.qlogTab, variant: all.qlogVariant } : null);
            if (!s) { return; }
            if (isKnownTab(s.tab)) { v.tab = s.tab; }
            if (isKnownVariant(s.variant)) { v.variant = s.variant; }
            if (s.sessions && typeof s.sessions === 'object') { v.sessionByTab = s.sessions; }
        } catch (e) { /* first run — keep the defaults */ }
    }

    function saveState() {
        try {
            var all = vscode.getState() || {};
            all[stateKey] = { tab: v.tab, variant: v.variant, sessions: v.sessionByTab };
            vscode.setState(all);
        } catch (e) { /* state is a convenience, never a correctness requirement */ }
    }

    function sectionVisible() {
        return typeof isExpanded === 'function' ? isExpanded(cfg.section) : true;
    }

    function setStatus(text) {
        var bar = el('status');
        if (bar) { bar.textContent = text; }
    }

    function renderTabStrip() {
        var strip = el('tabs');
        if (!strip) { return; }
        var buttons = strip.querySelectorAll('[data-qlog-tab]');
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            if (btn.getAttribute('data-qlog-tab') === v.tab) { btn.classList.add('active'); }
            else { btn.classList.remove('active'); }
        }
    }

    /** Show the variant dropdown only for a tab that has variants. */
    function renderVariantPicker() {
        var picker = el('variant');
        if (!picker) { return; }
        picker.hidden = !hasVariants();
        if (picker.value !== v.variant) { picker.value = v.variant; }
    }

    /** A pane tab shows its pane; every other tab the file viewer. */
    function renderPanes() {
        var pane = isPaneTab();
        for (var tab in paneTabs) {
            if (!Object.prototype.hasOwnProperty.call(paneTabs, tab)) { continue; }
            var node = document.getElementById(paneTabs[tab]);
            if (node) { node.hidden = tab !== v.tab; }
        }
        ['body', 'status', 'refresh', 'open'].forEach(function (name) {
            var node = el(name);
            if (node) { node.hidden = pane; }
        });
    }

    /** The session switch of the active tab, from the host's plan. */
    function renderSessions() {
        var box = el('sessions');
        if (!box || !cfg.sessions) { return; }
        var plan = v.plans[v.tab];
        if (!plan) { box.innerHTML = ''; return; }
        var html = '';
        if (plan.showDropdown) {
            html += '<select class="qlog-session-select" data-qlog-session-select title="Every session, most recently used first">';
            for (var i = 0; i < plan.sessions.length; i++) {
                var name = plan.sessions[i];
                html += '<option value="' + qlogEscape(name) + '"' + (name === plan.selected ? ' selected' : '') + '>' + qlogEscape(name) + '</option>';
            }
            html += '</select>';
        }
        for (var j = 0; j < plan.buttons.length; j++) {
            var b = plan.buttons[j];
            html += '<button class="qlog-session-btn' + (b === plan.selected ? ' active' : '') + '" data-qlog-session="' + qlogEscape(b) + '" title="Session ' + qlogEscape(b) + '">' + qlogEscape(b) + '</button>';
        }
        box.innerHTML = html;
    }

    /** Clear the viewer and fetch, shared by every switch. */
    function showSelection() {
        v.loadedView = '';
        saveState();
        renderTabStrip();
        renderVariantPicker();
        renderPanes();
        renderSessions();
        if (isPaneTab()) { return; }
        var body = el('body');
        if (body) { body.innerHTML = '<div class="qlog-empty">Loading…</div>'; }
        request(true);
    }

    function selectTab(id) {
        if (!isKnownTab(id) || id === v.tab) { return; }
        v.tab = id;
        showSelection();
    }

    function selectVariant(id) {
        if (!isKnownVariant(id) || id === v.variant) { return; }
        v.variant = id;
        showSelection();
    }

    function selectSession(name) {
        if (!cfg.sessions || typeof name !== 'string' || !name || name === session()) { return; }
        v.sessionByTab[v.tab] = name;
        var plan = v.plans[v.tab];
        if (plan) { plan.selected = name; }
        showSelection();
    }

    /**
     * Ask the host for the active view's content. `force` is set whenever this
     * pane is not already showing that view: the host's "unchanged" memory
     * outlives this webview, so a plain poll after a reload would never load.
     */
    function request(force) {
        if (isPaneTab() || !sectionVisible()) { return; }
        var stale = v.loadedView !== viewKey();
        vscode.postMessage({
            type: 'qlogRequest',
            viewer: cfg.id,
            tab: v.tab,
            variant: v.variant,
            session: session(),
            force: !!force || stale,
        });
    }

    /**
     * Swap in freshly rendered content, keeping the reader where they were: the
     * view opens at the end the file grows at (`newestAt`), and a reader still
     * there is kept there while one who scrolled away keeps their position.
     */
    function applyContent(msg) {
        var body = el('body');
        if (!body) { return; }
        if (!msg.exists) {
            body.innerHTML = '<div class="qlog-empty"></div>';
            body.firstChild.textContent = msg.error
                ? (msg.fileName + ' — ' + msg.error)
                : cfg.sessions
                    ? ('Session "' + msg.session + '" has no ' + msg.fileName.split('/').pop() + ' yet')
                    : (msg.fileName + ' — not found in quest "' + msg.questId + '"');
            setStatus(msg.fileName + ' — not available');
            v.loadedView = viewKey();
            return;
        }
        var atStart = msg.newestAt === 'start';
        var wasFollowing = atStart
            ? body.scrollTop <= QLOG_STICKY_SLACK
            : body.scrollHeight - body.scrollTop - body.clientHeight <= QLOG_STICKY_SLACK;
        var firstLoad = v.loadedView !== viewKey();
        body.innerHTML = msg.html || '<div class="qlog-empty">(empty)</div>';
        if (firstLoad || wasFollowing) { body.scrollTop = atStart ? 0 : body.scrollHeight; }
        v.loadedView = viewKey();
        var stamp = new Date().toLocaleTimeString();
        setStatus(
            msg.fileName + ' · ' + qlogFormatBytes(msg.bytes)
            + (msg.truncated ? (atStart ? ' (head)' : ' (tail)') : '') + ' · ' + stamp,
        );
    }

    /** A reply for this viewer's current selection, else nothing (a stale reply). */
    function onMessage(msg) {
        if (!msg || msg.viewer !== cfg.id || msg.tab !== v.tab) { return; }
        if (msg.type === 'qlogSessions') {
            v.plans[msg.tab] = msg.plan;
            // The host settles an unknown or deleted choice (the list follows
            // sessions created and deleted while the tab is open).
            if (msg.plan && msg.plan.selected && msg.plan.selected !== session()) {
                v.sessionByTab[msg.tab] = msg.plan.selected;
                saveState();
            }
            renderSessions();
            return;
        }
        if (msg.type !== 'qlogContent') { return; }
        if (hasVariants() && msg.variant !== v.variant) { return; }
        if (cfg.sessions && msg.session !== session()) { return; }
        applyContent(msg);
    }

    function start() {
        renderTabStrip();
        renderVariantPicker();
        renderPanes();
        var strip = el('tabs');
        if (strip) {
            strip.addEventListener('click', function (ev) {
                var btn = ev.target && ev.target.closest ? ev.target.closest('[data-qlog-tab]') : null;
                if (btn) { selectTab(btn.getAttribute('data-qlog-tab')); }
            });
        }
        var picker = el('variant');
        if (picker) { picker.addEventListener('change', function () { selectVariant(picker.value); }); }
        var box = el('sessions');
        if (box) {
            box.addEventListener('click', function (ev) {
                var btn = ev.target && ev.target.closest ? ev.target.closest('[data-qlog-session]') : null;
                if (btn) { selectSession(btn.getAttribute('data-qlog-session')); }
            });
            box.addEventListener('change', function (ev) {
                var sel = ev.target;
                if (sel && sel.hasAttribute && sel.hasAttribute('data-qlog-session-select')) { selectSession(sel.value); }
            });
        }
        var refreshBtn = el('refresh');
        if (refreshBtn) { refreshBtn.addEventListener('click', function () { request(true); }); }
        var openBtn = el('open');
        if (openBtn) {
            openBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'qlogOpenInEditor', viewer: cfg.id, tab: v.tab, variant: v.variant, session: session() });
            });
        }
        request(true);
        setInterval(function () { request(false); }, QLOG_POLL_MS);
    }

    loadState();
    return { start: start, onMessage: onMessage, state: v, select: { tab: selectTab, variant: selectVariant, session: selectSession } };
}

var qlogViewerList = (qlogViewers || []).map(qlogCreateViewer);

window.addEventListener('message', function (e) {
    for (var i = 0; i < qlogViewerList.length; i++) { qlogViewerList[i].onMessage(e.data); }
});

setTimeout(function () {
    for (var i = 0; i < qlogViewerList.length; i++) { qlogViewerList[i].start(); }
}, 0);
