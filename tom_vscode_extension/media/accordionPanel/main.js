// @ts-nocheck
/* global vscode, sectionsConfig, sectionContents, state, _rendered: writable, onRenderComplete */
/*
 * Accordion panel behaviour — the static body of getAccordionScript() in
 * src/handlers/accordionPanel.ts (Phase B.24 webview restructuring). The handler
 * prepends a small generated data-prefix that declares `vscode`,
 * `sectionsConfig`, `sectionContents`, `state` and `_rendered`, then appends the
 * consumer's `additionalScript`. Because these all compose into ONE inline
 * <script> (single acquireVsCodeApi() call; onRenderComplete hoisting across the
 * base + additionalScript), this file is read via readMediaText and inlined
 * rather than loaded as a separate <script src>.
 */

function loadState() {
    try {
        var s = vscode.getState();
        if (s && s.expanded && Array.isArray(s.expanded)) state.expanded = s.expanded;
        if (s && s.pinned && Array.isArray(s.pinned)) state.pinned = s.pinned;
    } catch(e) {}
}

function saveState() { vscode.setState(state); }
function isExpanded(id) { return state.expanded && state.expanded.includes(id); }
function isPinned(id) { return state.pinned && state.pinned.includes(id); }

function toggleSection(id) {
    if (isExpanded(id)) {
        if (isPinned(id)) return;
        var idx = state.expanded.indexOf(id);
        if (idx >= 0) state.expanded.splice(idx, 1);
        if (state.expanded.length === 0) {
            var next = sectionsConfig.find(function(s) { return s.id !== id; });
            if (next) state.expanded.push(next.id);
        }
    } else {
        state.expanded = state.expanded.filter(function(eid) { return isPinned(eid); });
        state.expanded.push(id);
    }
    saveState();
    render();
}

function togglePin(id, e) {
    e.stopPropagation();
    var idx = state.pinned.indexOf(id);
    if (idx >= 0) { state.pinned.splice(idx, 1); }
    else { state.pinned.push(id); if (!isExpanded(id)) state.expanded.push(id); }
    saveState();
    render();
}

function getSectionContent(id) {
    return sectionContents[id] || '<div class="sample-content">Unknown section</div>';
}

/**
 * Render the accordion.
 * First call: builds full DOM via innerHTML (sections + content).
 * Subsequent calls: only toggles expanded/collapsed classes, updates pin
 * buttons and resize handles — section content DOM is preserved.
 */
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
        container.innerHTML = html;
        _rendered = true;
        attachEventListeners();
        updateResizeHandles();
        if (typeof onRenderComplete === 'function') onRenderComplete();
    } else {
        // --- Subsequent renders: preserve DOM, toggle classes only ---
        sectionsConfig.forEach(function(sec) {
            var el = container.querySelector('[data-section="' + sec.id + '"]');
            if (!el) return;
            var exp = isExpanded(sec.id);
            var pin = isPinned(sec.id);
            // Toggle expanded/collapsed
            if (exp) { el.classList.remove('collapsed'); el.classList.add('expanded'); el.style.flex = ''; }
            else { el.classList.remove('expanded'); el.classList.add('collapsed'); el.style.flex = ''; }
            // Update pin button
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
        if (typeof onRenderComplete === 'function') onRenderComplete();
    }
}

/**
 * Manage resize handles between expanded sections.
 * Removes old handles and inserts new ones at the correct positions.
 */
function updateResizeHandles() {
    var container = document.getElementById('container');
    // Remove existing resize handles
    container.querySelectorAll('.resize-handle').forEach(function(h) { h.remove(); });
    // Insert resize handles between adjacent expanded sections
    var expandedIds = [];
    sectionsConfig.forEach(function(sec) { if (isExpanded(sec.id)) expandedIds.push(sec.id); });
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

function attachEventListeners() {
    document.querySelectorAll('[data-toggle]').forEach(function(el) { el.addEventListener('click', function() { toggleSection(el.dataset.toggle); }); });
    document.querySelectorAll('[data-pin]').forEach(function(el) { el.addEventListener('click', function(e) { togglePin(el.dataset.pin, e); }); });
    document.querySelectorAll('[data-action]').forEach(function(el) { el.addEventListener('click', function() { handleAction(el.dataset.action, el.dataset.id); }); });
}

var resizing = null;
var DRAG_THRESHOLD = 5;
function startResize(e, handle) {
    e.preventDefault();
    var leftId = handle.dataset.resizeLeft;
    var rightId = handle.dataset.resizeRight;
    var leftEl = document.querySelector('[data-section="' + leftId + '"]');
    var rightEl = document.querySelector('[data-section="' + rightId + '"]');
    if (!leftEl || !rightEl) return;
    var startX = e.clientX;
    var leftWidth = leftEl.offsetWidth;
    var rightWidth = rightEl.offsetWidth;
    var dragStarted = false;
    function onMove(ev) {
        var dx = ev.clientX - startX;
        if (!dragStarted) { if (Math.abs(dx) < DRAG_THRESHOLD) return; dragStarted = true; handle.classList.add('dragging'); }
        leftEl.style.flex = '0 0 ' + Math.max(120, leftWidth + dx) + 'px';
        rightEl.style.flex = '0 0 ' + Math.max(120, rightWidth - dx) + 'px';
    }
    function onUp() { if (dragStarted) handle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}
function doResize(e) { /* legacy — unused, kept for compat */ }
function stopResize() { /* legacy — unused, kept for compat */ }

function handleAction(action, id) {
    vscode.postMessage({ type: 'action', action: action, sectionId: id });
}

loadState();
render();
