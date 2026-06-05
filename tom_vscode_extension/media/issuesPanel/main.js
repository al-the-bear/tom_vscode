// @ts-nocheck
/* global vscode, _issuesPrefix, _issuesMode */
// Issues/Tests panel webview client — extracted verbatim from getIssuesScript()
// in src/handlers/issuesPanel-handler.ts (Phase B.19 webview restructuring).
// Predates strict checkJs (large verbatim extraction).
//
// The two config values (_p/_mode) previously interpolated into the IIFE now
// come from _issuesPrefix/_issuesMode, which getIssuesScript() prepends before
// this body. Each IIFE runs immediately, so the two instances (issues + tests)
// concatenated into one WS-panel <script> each capture their own value before
// the next prepend reassigns the globals. Uses the global `vscode` handle
// defined by the accordion host shell (does not call acquireVsCodeApi).
(function() {
    var _p = _issuesPrefix;
    var _mode = _issuesMode;
    function $e(id) { return document.getElementById(_p + '-' + id); }

    // State
    var repos = [];
    var configStatuses = ['open', 'in_triage', 'assigned', 'closed'];
    var statusColors = { open: 'green', in_triage: 'yellow', assigned: 'red', closed: 'grey' };
    var configLabels = [];
    var currentRepo = null;
    var allIssues = [];
    var issues = [];
    var selectedIssue = null;
    var currentComments = [];
    var isNewIssueMode = false;
    var attachments = [];
    var activeFilters = [];
    var activeLabelFilters = {};
    var labelSections = {};
    var sortFields = [];
    // Column system
    var columnDefs = [];
    var visibleColumns = [];
    var manualWidths = {};
    var allReposOption = true;
    var configErrorMsg = null;
    var configSectionName = '';
    var configFilePathStr = '';
    var _isDragging = false;
    var GROWTH_PRIORITY = [];
    var COLUMN_LABELS = {};
    var SORTABLE_FIELDS = [
        { key: 'number', label: 'Number' },
        { key: 'title', label: 'Title' },
        { key: 'state', label: 'Status' },
        { key: 'createdAt', label: 'Created' },
        { key: 'updatedAt', label: 'Updated' },
        { key: 'commentCount', label: 'Comments' },
        { key: 'author', label: 'Author' }
    ];

    // DOM refs
    var repoSelect = $e('repoSelect');
    var filterBtn = $e('filterBtn');
    var sortBtn = $e('sortBtn');
    var refreshBtn = $e('refreshBtn');
    var issueListEl = $e('issueList');
    var addBtn = $e('addBtn');
    var statusSelect = $e('statusSelect');
    var openBrowserBtn = $e('openBrowserBtn');
    var labelsBtn = $e('labelsBtn');
    var sendBtn = $e('sendBtn');
    var attachBtn = $e('attachBtn');
    var titleInput = $e('titleInput');
    var inputText = $e('inputText');
    var commentHistory = $e('commentHistory');
    var attachmentArea = $e('attachmentArea');
    var attachmentListEl = $e('attachmentList');
    var labelsPicker = $e('labelsPicker');
    var issueTitleBar = $e('issueTitle');
    var splitHandle = $e('splitHandle');
    var vSplitHandle = $e('vSplitHandle');
    var browserEl = $e('browser');
    var editorEl = $e('editor');
    var filterPicker = $e('filterPicker');
    var sortPicker = $e('sortPicker');
    var inputArea = $e('inputArea');

    // Init
    vscode.postMessage({ type: 'issuesReady', panelMode: _mode });

    // ---- Message listener (filtered by panelMode) ----
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.panelMode && msg.panelMode !== _mode) return;
        switch (msg.type) {
            case 'issuesInit':
                repos = msg.repos || [];
                configStatuses = msg.statuses || ['open', 'in_triage', 'assigned', 'closed'];
                statusColors = msg.statusColors || {};
                configLabels = msg.labels || [];
                columnDefs = msg.columnDefs || [];
                allReposOption = msg.allReposOption !== false;
                configErrorMsg = msg.configError || null;
                configSectionName = msg.configSection || '';
                configFilePathStr = msg.configFilePath || '';
                COLUMN_LABELS = msg.columnLabels || {};
                GROWTH_PRIORITY = msg.growthPriority || [];
                // Initialize visibleColumns from required + defaultColumns
                var defCols = msg.defaultColumns || [];
                visibleColumns = [];
                for (var ci = 0; ci < columnDefs.length; ci++) {
                    if (columnDefs[ci].required || defCols.indexOf(columnDefs[ci].key) >= 0) {
                        visibleColumns.push(columnDefs[ci].key);
                    }
                }
                labelSections = {};
                for (var li = 0; li < configLabels.length; li++) {
                    var eqi = configLabels[li].indexOf('=');
                    if (eqi > 0) {
                        var lkey = configLabels[li].substring(0, eqi);
                        var lval = configLabels[li].substring(eqi + 1);
                        if (!labelSections[lkey]) labelSections[lkey] = [];
                        labelSections[lkey].push(lval);
                    }
                }
                manualWidths = {};
                if (configErrorMsg) { showConfigError(); }
                else { renderRepoDropdown(); }
                break;

            case 'issues':
                if (currentRepo && currentRepo.id === '__all__') {
                    var tagged = (msg.issues || []).map(function(iss) { iss._repoId = msg.repoId; return iss; });
                    allIssues = allIssues.concat(tagged);
                } else {
                    allIssues = (msg.issues || []).map(function(iss) { iss._repoId = msg.repoId; return iss; });
                }
                applyFilterAndSort();
                renderIssueList();
                break;

            case 'comments':
                currentComments = msg.comments || [];
                renderComments();
                break;

            case 'issueCreated':
                isNewIssueMode = false;
                selectedIssue = msg.issue;
                loadIssues();
                loadComments();
                renderEditorState();
                break;

            case 'commentAdded':
                currentComments.push(msg.comment);
                renderComments();
                inputText.value = '';
                break;

            case 'issueUpdated':
                if (selectedIssue && selectedIssue.number === msg.issue.number) {
                    selectedIssue = msg.issue;
                    renderEditorState();
                }
                loadIssues();
                break;

            case 'attachmentsPicked':
                if (selectedIssue && !isNewIssueMode) {
                    // Upload to provider/server
                    uploadPickedAttachments(msg.attachments);
                } else {
                    // New issue mode: just add to local list
                    for (var i = 0; i < msg.attachments.length; i++) { attachments.push(msg.attachments[i]); }
                    renderAttachments();
                }
                break;

            case 'attachmentUploaded':
                _attachmentUploading = false;
                attachments.push(msg.attachment);
                renderAttachments();
                break;

            case 'attachmentsList':
                attachments = msg.attachments || [];
                renderAttachments();
                break;

            case 'attachmentDeleted':
                attachments = attachments.filter(function(a) { return a.id !== msg.attachmentId; });
                renderAttachments();
                break;

            case 'issuesError':
                _attachmentUploading = false;
                showError(msg.message);
                break;
        }
    });

    // ---- Effective status ----
    function getEffectiveStatus(issue) {
        if (issue.state === 'closed') return 'closed';
        var labels = issue.labels || [];
        var labelStatuses = configStatuses.filter(function(s) { return s !== 'open' && s !== 'closed'; });
        for (var i = 0; i < labelStatuses.length; i++) {
            if (labels.indexOf(labelStatuses[i]) >= 0) return labelStatuses[i];
        }
        return 'open';
    }

    // ---- Filter & Sort ----
    function applyFilterAndSort() {
        issues = allIssues.filter(function(iss) {
            // Status section: empty = any
            if (activeFilters.length > 0) {
                if (activeFilters.indexOf(getEffectiveStatus(iss)) < 0) return false;
            }
            // Label sections: each section with selections must match
            var lkeys = Object.keys(activeLabelFilters);
            for (var lk = 0; lk < lkeys.length; lk++) {
                var vals = activeLabelFilters[lkeys[lk]];
                if (!vals || vals.length === 0) continue;
                var matched = false;
                var issLabels = iss.labels || [];
                for (var lv = 0; lv < vals.length; lv++) {
                    if (issLabels.indexOf(lkeys[lk] + '=' + vals[lv]) >= 0) { matched = true; break; }
                }
                if (!matched) return false;
            }
            return true;
        });
        if (sortFields.length > 0) {
            issues.sort(function(a, b) {
                for (var i = 0; i < sortFields.length; i++) {
                    var va = getSortValue(a, sortFields[i]);
                    var vb = getSortValue(b, sortFields[i]);
                    if (va < vb) return -1;
                    if (va > vb) return 1;
                }
                return 0;
            });
        }
    }
    function getSortValue(issue, field) {
        switch (field) {
            case 'number': return issue.number || 0;
            case 'title': return (issue.title || '').toLowerCase();
            case 'state': return getEffectiveStatus(issue);
            case 'createdAt': return issue.createdAt || '';
            case 'updatedAt': return issue.updatedAt || '';
            case 'commentCount': return issue.commentCount || 0;
            case 'author': return (issue.author && issue.author.name || '').toLowerCase();
            default: return '';
        }
    }

    // ---- Repo dropdown ----
    function renderRepoDropdown() {
        var html = '<option value="">-- Select Repo --</option>';
        if (allReposOption) { html += '<option value="__all__">All Repos</option>'; }
        for (var i = 0; i < repos.length; i++) {
            html += '<option value="' + escapeHtml(repos[i].id) + '">' + escapeHtml(repos[i].displayName) + '</option>';
        }
        repoSelect.innerHTML = html;
        // Preselect: first additional repo (has ': ' in name), else All Repos if available, else first repo
        var preselected = '';
        for (var j = 0; j < repos.length; j++) {
            if (repos[j].displayName.indexOf(': ') >= 0) { preselected = repos[j].id; break; }
        }
        if (!preselected && repos.length > 0) {
            preselected = allReposOption ? '__all__' : repos[0].id;
        }
        if (preselected) {
            repoSelect.value = preselected;
            repoSelect.dispatchEvent(new Event('change'));
        }
    }
    repoSelect.addEventListener('change', function() {
        var val = repoSelect.value;
        if (val === '' || val === '__all__') {
            currentRepo = val === '__all__' ? { id: '__all__', displayName: 'All Repos' } : null;
            if (val === '__all__') { loadAllIssues(); }
            else { allIssues = []; issues = []; renderIssueList(); }
        } else {
            currentRepo = null;
            for (var i = 0; i < repos.length; i++) { if (repos[i].id === val) { currentRepo = repos[i]; break; } }
            loadIssues();
        }
        selectedIssue = null;
        currentComments = [];
        renderEditorState();
    });
    refreshBtn.addEventListener('click', function() {
        if (currentRepo && currentRepo.id === '__all__') { loadAllIssues(); }
        else if (currentRepo) { loadIssues(); }
    });

    function loadIssues() {
        if (!currentRepo || currentRepo.id === '__all__') return;
        allIssues = [];
        issueListEl.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
        vscode.postMessage({ type: 'loadIssues', repoId: currentRepo.id, state: 'all', panelMode: _mode });
    }
    function loadAllIssues() {
        allIssues = [];
        issueListEl.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
        if (repos.length === 0) { issues = []; renderIssueList(); return; }
        for (var i = 0; i < repos.length; i++) {
            vscode.postMessage({ type: 'loadIssues', repoId: repos[i].id, state: 'all', panelMode: _mode });
        }
    }
    function loadComments() {
        if (!selectedIssue || !currentRepo) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({ type: 'loadComments', repoId: repoId, issueNumber: selectedIssue.number, panelMode: _mode });
    }

    // ---- Filter picker ----
    filterBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (filterPicker.style.display !== 'none') { filterPicker.style.display = 'none'; return; }
        sortPicker.style.display = 'none';
        renderFilterPicker();
        filterPicker.style.display = '';
    });
    function renderFilterPicker() {
        var presentStatuses = {};
        for (var i = 0; i < allIssues.length; i++) { presentStatuses[getEffectiveStatus(allIssues[i])] = true; }
        var html = '<div class="picker-section-header">Status</div>';
        for (var j = 0; j < configStatuses.length; j++) {
            var st = configStatuses[j];
            var checked = activeFilters.indexOf(st) >= 0;
            var present = presentStatuses[st];
            html += '<div class="picker-option' + (present ? '' : ' dimmed') + '" data-section="status" data-value="' + escapeHtml(st) + '">';
            html += '<span class="check-box">' + (checked ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
            html += '<span>' + escapeHtml(formatStatusLabel(st)) + '</span></div>';
        }
        var sectionKeys = Object.keys(labelSections);
        for (var sk = 0; sk < sectionKeys.length; sk++) {
            var secKey = sectionKeys[sk];
            var secVals = labelSections[secKey];
            html += '<div class="picker-section-header">' + escapeHtml(formatStatusLabel(secKey)) + '</div>';
            var secFilters = activeLabelFilters[secKey] || [];
            for (var sv = 0; sv < secVals.length; sv++) {
                var lChecked = secFilters.indexOf(secVals[sv]) >= 0;
                html += '<div class="picker-option" data-section="' + escapeHtml(secKey) + '" data-value="' + escapeHtml(secVals[sv]) + '">';
                html += '<span class="check-box">' + (lChecked ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
                html += '<span>' + escapeHtml(secVals[sv]) + '</span></div>';
            }
        }
        filterPicker.innerHTML = html;
        filterPicker.querySelectorAll('.picker-option').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var section = el.dataset.section;
                var value = el.dataset.value;
                if (section === 'status') {
                    var idx = activeFilters.indexOf(value);
                    if (idx >= 0) { activeFilters.splice(idx, 1); } else { activeFilters.push(value); }
                } else {
                    if (!activeLabelFilters[section]) activeLabelFilters[section] = [];
                    var lidx = activeLabelFilters[section].indexOf(value);
                    if (lidx >= 0) { activeLabelFilters[section].splice(lidx, 1); } else { activeLabelFilters[section].push(value); }
                }
                applyFilterAndSort();
                renderIssueList();
                renderFilterPicker();
                updateFilterBtnState();
            });
        });
    }
    function updateFilterBtnState() {
        var isDefault = (activeFilters.length === 0);
        if (isDefault) {
            var lkeys = Object.keys(activeLabelFilters);
            for (var i = 0; i < lkeys.length; i++) {
                if (activeLabelFilters[lkeys[i]] && activeLabelFilters[lkeys[i]].length > 0) { isDefault = false; break; }
            }
        }
        if (isDefault) { filterBtn.classList.remove('active-indicator'); }
        else { filterBtn.classList.add('active-indicator'); }
    }
    function updateSortBtnState() {
        var isDefault = (sortFields.length === 0);
        if (isDefault) { sortBtn.classList.remove('active-indicator'); }
        else { sortBtn.classList.add('active-indicator'); }
    }

    // ---- Sort picker ----
    var pendingSortFields = [];
    sortBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (sortPicker.style.display !== 'none') { sortPicker.style.display = 'none'; return; }
        filterPicker.style.display = 'none';
        pendingSortFields = sortFields.slice();
        renderSortPicker();
        sortPicker.style.display = '';
    });
    function renderSortPicker() {
        var html = '';
        for (var i = 0; i < SORTABLE_FIELDS.length; i++) {
            var f = SORTABLE_FIELDS[i];
            var order = pendingSortFields.indexOf(f.key);
            var hasOrder = order >= 0;
            html += '<div class="picker-option" data-field="' + f.key + '">';
            html += '<span class="sort-number ' + (hasOrder ? '' : 'empty') + '">' + (hasOrder ? (order + 1) : '') + '</span>';
            html += '<span>' + escapeHtml(f.label) + '</span></div>';
        }
        html += '<div class="picker-footer">';
        html += '<button class="secondary" id="' + _p + '-sortReset">Reset</button>';
        html += '<button class="primary" id="' + _p + '-sortOk">OK</button>';
        html += '</div>';
        sortPicker.innerHTML = html;
        sortPicker.querySelectorAll('.picker-option').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var field = el.dataset.field;
                var idx = pendingSortFields.indexOf(field);
                if (idx >= 0) { pendingSortFields.splice(idx, 1); } else { pendingSortFields.push(field); }
                renderSortPicker();
            });
        });
        $e('sortReset').addEventListener('click', function(e) { e.stopPropagation(); pendingSortFields = []; renderSortPicker(); });
        $e('sortOk').addEventListener('click', function(e) {
            e.stopPropagation(); sortFields = pendingSortFields.slice();
            sortPicker.style.display = 'none'; applyFilterAndSort(); renderIssueList();
            updateSortBtnState();
        });
    }

    // ---- Issue list - Column system ----
    function getStatusColor(status) {
        return statusColors[status] || 'grey';
    }
    function getColumnValue(issue, colKey) {
        var effStatus = getEffectiveStatus(issue);
        switch (colKey) {
            case 'statusDot': return { type: 'dot', color: getStatusColor(effStatus) };
            case 'id': return '#' + issue.number;
            case 'title': return issue.title || '';
            case 'repository': {
                var rid = issue._repoId || '';
                var slash = rid.lastIndexOf('/');
                return slash >= 0 ? rid.substring(slash + 1) : rid;
            }
            case 'repositoryOwner': {
                var rid2 = issue._repoId || '';
                var slash2 = rid2.indexOf('/');
                return slash2 >= 0 ? rid2.substring(0, slash2) : '';
            }
            case 'status': return formatStatusLabel(effStatus);
            case 'author': return issue.author ? issue.author.name : '';
            case 'commentCount': return (issue.commentCount || 0) + '';
            case 'creationTimestamp': return formatDateYYMMDD(issue.createdAt);
            case 'updateTimestamp': return formatDateYYMMDD(issue.updatedAt);
            case 'labels': {
                var lbls = (issue.labels || []).map(function(l) {
                    var eq = l.indexOf('=');
                    return eq > 0 ? l.substring(eq + 1) : l;
                });
                return lbls.join(', ');
            }
            default: return '';
        }
    }
    function getVisibleColumnDefs() {
        return columnDefs.filter(function(cd) { return visibleColumns.indexOf(cd.key) >= 0; });
    }
    function calculateColumnWidths(containerWidth) {
        var visCols = getVisibleColumnDefs();
        var totalBorders = Math.max(0, visCols.length - 1);
        var available = containerWidth - totalBorders;
        var widths = {};
        var remaining = available;
        for (var i = 0; i < visCols.length; i++) {
            var w = manualWidths[visCols[i].key] || visCols[i].minWidth;
            widths[visCols[i].key] = w;
            remaining -= w;
        }
        if (remaining > 0) {
            for (var gi = 0; gi < GROWTH_PRIORITY.length && remaining > 0; gi++) {
                var gk = GROWTH_PRIORITY[gi];
                var col = null;
                for (var ci = 0; ci < visCols.length; ci++) {
                    if (visCols[ci].key === gk) { col = visCols[ci]; break; }
                }
                if (!col || manualWidths[gk]) continue;
                var canGrow = col.maxWidth - widths[gk];
                if (canGrow <= 0) continue;
                var give = Math.min(canGrow, remaining);
                widths[gk] += give;
                remaining -= give;
            }
        }
        return widths;
    }
    function renderIssueList() {
        if (configErrorMsg) { showConfigError(); return; }
        if (issues.length === 0) { issueListEl.innerHTML = '<div class="empty-state">No issues found</div>'; return; }
        var cw = issueListEl.clientWidth || 280;
        var widths = calculateColumnWidths(cw);
        var visCols = getVisibleColumnDefs();
        var html = '';
        for (var i = 0; i < issues.length; i++) {
            var issue = issues[i];
            var sel = selectedIssue && selectedIssue.id === issue.id ? ' selected' : '';
            html += '<div class="issue-row' + sel + '" data-idx="' + i + '">';
            for (var ci = 0; ci < visCols.length; ci++) {
                var cd = visCols[ci];
                var w = widths[cd.key] || cd.minWidth;
                var val = getColumnValue(issue, cd.key);
                if (cd.key === 'statusDot') {
                    html += '<span class="issue-cell cell-style-' + (cd.style || 'dot') + '" style="width:' + w + 'px"><span class="issue-state-dot" style="background:' + escapeHtml(val.color) + ';"></span></span>';
                } else {
                    var text = typeof val === 'string' ? val : '';
                    var label = COLUMN_LABELS[cd.key] || cd.key;
                    html += '<span class="issue-cell cell-style-' + (cd.style || 'grey') + '" style="width:' + w + 'px" title="' + escapeHtml(label + ': ' + text) + '">' + escapeHtml(text) + '</span>';
                }
            }
            html += '</div>';
        }
        html += '<div class="col-resize-handles">';
        var cumX = 0;
        for (var ri = 0; ri < visCols.length - 1; ri++) {
            cumX += (widths[visCols[ri].key] || visCols[ri].minWidth) + 1;
            html += '<div class="col-resize-handle" data-col-idx="' + ri + '" style="left:' + (cumX - 3) + 'px"></div>';
        }
        html += '</div>';
        issueListEl.innerHTML = html;
        issueListEl.querySelectorAll('.issue-row').forEach(function(el) {
            el.addEventListener('click', function() { selectIssue(issues[parseInt(el.dataset.idx)]); });
            el.addEventListener('contextmenu', function(e) { e.preventDefault(); showColumnPicker(e.clientX, e.clientY); });
        });
        setupResizeHandles();
    }
    function setupResizeHandles() {
        issueListEl.querySelectorAll('.col-resize-handle').forEach(function(handle) {
            handle.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                var colIdx = parseInt(handle.dataset.colIdx);
                var visCols = getVisibleColumnDefs();
                if (colIdx >= visCols.length) return;
                var colKey = visCols[colIdx].key;
                var startX = e.clientX;
                var startW = visCols[colIdx].minWidth;
                var firstRow = issueListEl.querySelector('.issue-row');
                if (firstRow) {
                    var cells = firstRow.querySelectorAll('.issue-cell');
                    if (cells[colIdx]) startW = cells[colIdx].offsetWidth;
                }
                _isDragging = true;
                function onMove(ev) {
                    var dx = ev.clientX - startX;
                    manualWidths[colKey] = Math.max(visCols[colIdx].minWidth, startW + dx);
                    renderIssueList();
                }
                function onUp() {
                    _isDragging = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }
    // Reset manual widths on container resize (skip during drag)
    var _resizeTimer = null;
    var _lastListWidth = 0;
    (new ResizeObserver(function(entries) {
        if (_isDragging) return;
        var w = entries[0].contentRect.width;
        if (Math.abs(w - _lastListWidth) > 2) {
            _lastListWidth = w;
            manualWidths = {};
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(function() { renderIssueList(); }, 50);
        }
    })).observe(issueListEl);
    function showColumnPicker(x, y) {
        var picker = $e('columnPicker');
        if (!picker) return;
        var optionalCols = columnDefs.filter(function(cd) { return !cd.required; });
        var html = '<div class="picker-section-header">Columns</div>';
        for (var i = 0; i < optionalCols.length; i++) {
            var col = optionalCols[i];
            var checked = visibleColumns.indexOf(col.key) >= 0;
            var label = COLUMN_LABELS[col.key] || col.key;
            html += '<div class="picker-option" data-col="' + col.key + '">';
            html += '<span class="check-box">' + (checked ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
            html += '<span>' + escapeHtml(label) + '</span></div>';
        }
        picker.innerHTML = html;
        picker.style.display = '';
        picker.style.left = x + 'px';
        picker.style.top = y + 'px';
        requestAnimationFrame(function() {
            var rect = picker.getBoundingClientRect();
            if (rect.right > window.innerWidth) picker.style.left = Math.max(0, x - rect.width) + 'px';
            if (rect.bottom > window.innerHeight) picker.style.top = Math.max(0, y - rect.height) + 'px';
        });
        picker.querySelectorAll('.picker-option').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var colKey = el.dataset.col;
                var idx = visibleColumns.indexOf(colKey);
                if (idx >= 0) { visibleColumns.splice(idx, 1); } else { visibleColumns.push(colKey); }
                manualWidths = {};
                showColumnPicker(x, y);
                renderIssueList();
            });
        });
    }
    function showConfigError() {
        var html = '<div class="config-error">';
        html += '<h3>Configuration Error</h3>';
        html += '<p>' + escapeHtml(configErrorMsg) + '</p>';
        html += '<p>Fix the configuration in section <code>' + escapeHtml(configSectionName) + '</code></p>';
        if (configFilePathStr) {
            html += '<p>Config file: <a class="config-file-link" href="#">' + escapeHtml(configFilePathStr) + '</a></p>';
        }
        html += '<p style="margin-top:8px;font-size:11px;color:var(--vscode-descriptionForeground)">Column format: <code>columnName{style}[minWidth,maxWidth]</code> or <code>columnName{style}[minWidth,maxWidth]*</code> for required columns.</p>';
        html += '</div>';
        issueListEl.innerHTML = html;
        var link = issueListEl.querySelector('.config-file-link');
        if (link) {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                vscode.postMessage({ type: 'openConfigFile', panelMode: _mode });
            });
        }
    }
    // Close column picker on outside click
    document.addEventListener('click', function() {
        var picker = $e('columnPicker');
        if (picker) picker.style.display = 'none';
    });
    function selectIssue(issue) {
        selectedIssue = issue;
        isNewIssueMode = false;
        currentComments = [];
        attachments = [];
        renderEditorState();
        renderIssueList();
        loadComments();
        loadAttachments();
    }

    // ---- Editor state ----
    function renderEditorState() {
        if (isNewIssueMode) {
            issueTitleBar.textContent = 'New Issue';
            commentHistory.classList.add('hidden');
            vSplitHandle.classList.add('hidden');
            commentHistory.style.flex = '';
            inputArea.classList.add('expanded');
            inputArea.style.flex = '';
            titleInput.style.display = '';
            titleInput.value = '';
            inputText.placeholder = 'Issue body (optional)…';
            statusSelect.style.display = 'none';
            openBrowserBtn.style.display = 'none';
            labelsBtn.style.display = 'none';
        } else {
            commentHistory.classList.remove('hidden');
            vSplitHandle.classList.remove('hidden');
            commentHistory.style.flex = '';
            inputArea.classList.remove('expanded');
            inputArea.style.flex = '';
            titleInput.style.display = 'none';
            if (selectedIssue) {
                issueTitleBar.textContent = '#' + selectedIssue.number + ' ' + selectedIssue.title;
                inputText.placeholder = 'Write a comment…';
                var effStatus = getEffectiveStatus(selectedIssue);
                var optHtml = '';
                for (var i = 0; i < configStatuses.length; i++) {
                    var st = configStatuses[i];
                    optHtml += '<option value="' + escapeHtml(st) + '"' + (effStatus === st ? ' selected' : '') + '>' + escapeHtml(formatStatusLabel(st)) + '</option>';
                }
                statusSelect.innerHTML = optHtml;
                statusSelect.style.display = '';
                openBrowserBtn.style.display = '';
                labelsBtn.style.display = '';
                renderComments();
            } else {
                issueTitleBar.textContent = 'No issue selected';
                commentHistory.innerHTML = '<div class="empty-state">Select an issue from the list</div>';
                inputText.placeholder = 'Write a comment…';
                statusSelect.style.display = 'none';
                openBrowserBtn.style.display = 'none';
                labelsBtn.style.display = 'none';
            }
        }
    }

    // ---- Comments ----
    function renderComments() {
        if (!selectedIssue) return;
        var html = '';
        html += '<div class="comment-card issue-body-card"><div class="comment-header">';
        html += '<img class="comment-avatar" src="' + escapeHtml(selectedIssue.author.avatarUrl) + '" />';
        html += '<span class="comment-author">' + escapeHtml(selectedIssue.author.name) + '</span>';
        html += '<span>' + formatDate(selectedIssue.createdAt) + '</span></div>';
        html += '<div class="comment-body">' + escapeHtml(selectedIssue.body || '(No description)') + '</div></div>';
        for (var i = 0; i < currentComments.length; i++) {
            var c = currentComments[i];
            html += '<div class="comment-card"><div class="comment-header">';
            html += '<img class="comment-avatar" src="' + escapeHtml(c.author.avatarUrl) + '" />';
            html += '<span class="comment-author">' + escapeHtml(c.author.name) + '</span>';
            html += '<span>' + formatDate(c.createdAt) + '</span></div>';
            html += '<div class="comment-body">' + escapeHtml(c.body) + '</div></div>';
        }
        commentHistory.innerHTML = html;
        commentHistory.scrollTop = commentHistory.scrollHeight;
    }

    // ---- New issue ----
    addBtn.addEventListener('click', function() {
        isNewIssueMode = true; attachments = []; titleInput.value = ''; inputText.value = '';
        renderAttachments(); renderEditorState();
    });

    // ---- Status dropdown ----
    statusSelect.addEventListener('change', function() {
        if (!selectedIssue || !currentRepo) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({ type: 'changeStatus', repoId: repoId, issueNumber: selectedIssue.number, status: statusSelect.value, panelMode: _mode });
    });

    // ---- Open in browser ----
    openBrowserBtn.addEventListener('click', function() {
        if (selectedIssue && selectedIssue.url) { vscode.postMessage({ type: 'openExternal', url: selectedIssue.url, panelMode: _mode }); }
    });

    // ---- Labels picker ----
    labelsBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (labelsPicker.style.display !== 'none') { labelsPicker.style.display = 'none'; return; }
        showLabelsPicker();
    });
    function showLabelsPicker() {
        if (!selectedIssue) return;
        var currentLabels = selectedIssue.labels || [];
        var html = '';
        for (var i = 0; i < configLabels.length; i++) {
            var label = configLabels[i];
            var eqIdx = label.indexOf('=');
            var displayName = eqIdx > 0 ? label.substring(eqIdx + 1) : label;
            var hasLabel = currentLabels.indexOf(label) >= 0;
            html += '<div class="label-option" data-label="' + escapeHtml(label) + '">';
            html += '<span class="check-box">' + (hasLabel ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
            html += '<span>' + escapeHtml(displayName) + '</span></div>';
        }
        labelsPicker.innerHTML = html;
        labelsPicker.style.display = '';
        labelsPicker.querySelectorAll('.label-option').forEach(function(el) {
            el.addEventListener('click', function() {
                if (!selectedIssue || !currentRepo) return;
                var repoId = selectedIssue._repoId || currentRepo.id;
                vscode.postMessage({ type: 'toggleLabel', repoId: repoId, issueNumber: selectedIssue.number, label: el.dataset.label, panelMode: _mode });
                labelsPicker.style.display = 'none';
            });
        });
    }

    // Close pickers on outside click (scoped to this panel's pickers)
    document.addEventListener('click', function() {
        filterPicker.style.display = 'none';
        sortPicker.style.display = 'none';
        labelsPicker.style.display = 'none';
    });

    // ---- Send ----
    sendBtn.addEventListener('click', function() {
        if (isNewIssueMode) {
            var title = titleInput.value.trim();
            if (!title) { showError('Please enter a title'); return; }
            if (!currentRepo || currentRepo.id === '__all__') { showError('Please select a specific repo to create an issue'); return; }
            var body = inputText.value.trim();
            if (attachments.length > 0) {
                body += '\n\n---\nAttachments:\n';
                for (var i = 0; i < attachments.length; i++) { body += '- ' + attachments[i].name + '\n'; }
            }
            vscode.postMessage({ type: 'createIssue', repoId: currentRepo.id, title: title, body: body, panelMode: _mode });
        } else if (selectedIssue) {
            var text = inputText.value.trim();
            if (!text) return;
            var repoId = selectedIssue._repoId || currentRepo.id;
            var commentBody = text;
            if (attachments.length > 0) {
                commentBody += '\n\n---\nAttachments:\n';
                for (var j = 0; j < attachments.length; j++) { commentBody += '- ' + attachments[j].name + '\n'; }
            }
            vscode.postMessage({ type: 'addComment', repoId: repoId, issueNumber: selectedIssue.number, body: commentBody, panelMode: _mode });
            attachments = [];
            renderAttachments();
        }
    });

    // ---- Attachments ----
    var _attachmentUploading = false;

    attachBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'pickAttachment', panelMode: _mode });
    });

    function loadAttachments() {
        if (!selectedIssue || !currentRepo) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({ type: 'listAttachments', repoId: repoId, issueNumber: selectedIssue.number, panelMode: _mode });
    }

    function uploadPickedAttachments(picked) {
        if (!selectedIssue || !currentRepo || picked.length === 0) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        _attachmentUploading = true;
        renderAttachments();
        var remaining = picked.length;
        for (var i = 0; i < picked.length; i++) {
            vscode.postMessage({
                type: 'uploadAttachment', repoId: repoId,
                issueNumber: selectedIssue.number,
                filePath: picked[i].path, fileName: picked[i].name,
                panelMode: _mode
            });
        }
    }

    function deleteAttachment(idx) {
        if (!selectedIssue || !currentRepo) return;
        var att = attachments[idx];
        if (!att) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({
            type: 'deleteAttachment', repoId: repoId,
            issueNumber: selectedIssue.number,
            attachmentId: att.id,
            panelMode: _mode
        });
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderAttachments() {
        if (attachments.length === 0 && !_attachmentUploading) {
            attachmentArea.style.display = 'none'; return;
        }
        attachmentArea.style.display = '';
        var html = '';
        if (_attachmentUploading) {
            html += '<span class="attachment-chip"><span class="codicon codicon-loading codicon-modifier-spin"></span> Uploading...</span>';
        }
        for (var i = 0; i < attachments.length; i++) {
            var a = attachments[i];
            html += '<span class="attachment-chip" data-idx="' + i + '" title="' + escapeHtml(a.name) + ' (' + formatSize(a.size || 0) + ')">';
            html += '<span class="codicon codicon-file"></span>';
            html += escapeHtml(a.name);
            if (a.size) html += ' <small>(' + formatSize(a.size) + ')</small>';
            html += '<button class="remove-btn" data-aidx="' + i + '" title="Remove">&times;</button></span>';
        }
        attachmentListEl.innerHTML = html;
        // Chip click = open/preview
        attachmentListEl.querySelectorAll('.attachment-chip').forEach(function(chip) {
            chip.addEventListener('click', function(e) {
                if (e.target.classList.contains('remove-btn')) return;
                var idx = parseInt(chip.dataset.idx);
                if (attachments[idx] && attachments[idx].url) {
                    vscode.postMessage({ type: 'openExternal', url: attachments[idx].url, panelMode: _mode });
                }
            });
        });
        // Remove button
        attachmentListEl.querySelectorAll('.remove-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var idx = parseInt(btn.dataset.aidx);
                if (selectedIssue && !isNewIssueMode) {
                    deleteAttachment(idx);
                } else {
                    attachments.splice(idx, 1);
                    renderAttachments();
                }
            });
        });
    }

    // ---- Drag & drop support for attachments ----
    attachmentArea.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        attachmentArea.style.display = '';
        attachmentArea.classList.add('drag-over');
    });
    attachmentArea.addEventListener('dragleave', function(e) {
        attachmentArea.classList.remove('drag-over');
    });
    attachmentArea.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        attachmentArea.classList.remove('drag-over');
        // Webview doesn't give real file paths from drag events, so trigger file picker instead
        vscode.postMessage({ type: 'pickAttachment', panelMode: _mode });
    });

    // ---- Horizontal split resize ----
    (function() {
        var dragging = false, startX, startWidth;
        splitHandle.addEventListener('mousedown', function(e) {
            e.preventDefault(); dragging = true; startX = e.clientX; startWidth = browserEl.offsetWidth;
            splitHandle.classList.add('dragging');
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
        });
        function onMove(e) { if (!dragging) return; var dx = e.clientX - startX; browserEl.style.flex = '0 0 ' + Math.max(120, Math.min(startWidth + dx, window.innerWidth - 200)) + 'px'; }
        function onUp() { dragging = false; splitHandle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    })();

    // ---- Vertical split resize ----
    (function() {
        var dragging = false, startY, startCommentH, startInputH;
        vSplitHandle.addEventListener('mousedown', function(e) {
            e.preventDefault(); dragging = true; startY = e.clientY;
            startCommentH = commentHistory.offsetHeight; startInputH = inputArea.offsetHeight;
            vSplitHandle.classList.add('dragging');
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
        });
        function onMove(e) { if (!dragging) return; var dy = e.clientY - startY; commentHistory.style.flex = '0 0 ' + Math.max(40, startCommentH + dy) + 'px'; inputArea.style.flex = '0 0 ' + Math.max(40, startInputH - dy) + 'px'; }
        function onUp() { dragging = false; vSplitHandle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    })();

    // ---- Utility ----
    function escapeHtml(str) { if (!str) return ''; return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function formatDate(iso) { try { var d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch(e) { return iso; } }
    function formatDateYYMMDD(iso) {
        if (!iso) return '';
        try {
            var d = new Date(iso);
            var yy = String(d.getFullYear()).substring(2);
            var mm = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            var result = yy + mm + dd;
            var hh = d.getHours(); var min = d.getMinutes();
            if (hh !== 0 || min !== 0 || d.getSeconds() !== 0) {
                result += ' ' + String(hh).padStart(2, '0') + ':' + String(min).padStart(2, '0');
            }
            return result;
        } catch(e) { return iso; }
    }
    function formatStatusLabel(st) { return st.replace(/_/g, ' ').replace(/\b[a-z]/g, function(c) { return c.toUpperCase(); }); }
    function showError(msg) {
        var div = document.createElement('div'); div.className = 'empty-state'; div.style.color = 'var(--vscode-errorForeground)'; div.textContent = msg;
        commentHistory.appendChild(div); setTimeout(function() { if (div.parentNode) div.parentNode.removeChild(div); }, 5000);
    }
})();
