// @ts-nocheck
/* eslint-disable no-undef */
// Prompt Queue Editor fallback diagnostics — extracted verbatim from the final
// inline <script> of getHtml() in src/handlers/queueEditor-handler.ts (Phase
// B.13 webview restructuring). Self-contained IIFE: it acquires its own
// vscode handle and only activates if main.js never set
// window.__queueEditorBooted === true. Loaded LAST (after main.js) so the boot
// flag is final by the time it runs.
(function() {
  if (window.__queueEditorBooted === true) {
    return;
  }

  const vscode = (() => {
    try {
      if (typeof acquireVsCodeApi === 'function') {
        return acquireVsCodeApi();
      }
    } catch (err) {
      addEvent('acquireVsCodeApi.error', String(err && err.message ? err.message : err));
    }
    return {
      postMessage: function() { return false; },
      setState: function() { /* noop */ },
      getState: function() { return undefined; },
    };
  })();
  const list = document.getElementById('queueList');
  const count = document.getElementById('countLabel');
  const diagnostics = {
    activatedAt: new Date().toISOString(),
    events: [],
    lastStateSummary: '',
    lastStateRaw: '',
  };
  let debugPanel;
  let debugPre;

  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setText(text) {
    if (!list) {
      return;
    }
    list.innerHTML = '<div class="empty">' + esc(text) + '</div>';
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return '[stringify failed] ' + String(err && err.message ? err.message : err);
    }
  }

  function addEvent(kind, detail) {
    const line = '[' + new Date().toISOString() + '] ' + kind + ': ' + detail;
    diagnostics.events.push(line);
    if (diagnostics.events.length > 250) {
      diagnostics.events.shift();
    }
    renderDebug();
  }

  function ensureDebugPanel() {
    if (debugPanel) {
      return;
    }
    debugPanel = document.createElement('div');
    debugPanel.style.marginTop = '12px';
    debugPanel.style.borderTop = '1px solid var(--vscode-panel-border)';
    debugPanel.style.paddingTop = '10px';

    const title = document.createElement('div');
    title.textContent = 'Fallback Diagnostics';
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    debugPanel.appendChild(title);

    debugPre = document.createElement('pre');
    debugPre.style.whiteSpace = 'pre-wrap';
    debugPre.style.wordBreak = 'break-word';
    debugPre.style.maxHeight = '260px';
    debugPre.style.overflow = 'auto';
    debugPre.style.padding = '8px';
    debugPre.style.margin = '0';
    debugPre.style.border = '1px solid var(--vscode-panel-border)';
    debugPre.style.background = 'var(--vscode-editor-background)';
    debugPanel.appendChild(debugPre);

    document.body.appendChild(debugPanel);
  }

  function renderDebug() {
    ensureDebugPanel();
    if (!debugPre) {
      return;
    }
    const info = [
      'panel=queue',
      'fallbackActive=true',
      'mainBootFlag=' + String(!!window.__queueEditorBooted),
      'activatedAt=' + diagnostics.activatedAt,
      'url=' + String(location && location.href ? location.href : ''),
      diagnostics.lastStateSummary ? ('lastState=' + diagnostics.lastStateSummary) : 'lastState=(none)',
      '',
      '--- recent events ---',
    ];
    const events = diagnostics.events.slice(-80);
    const payload = diagnostics.lastStateRaw
      ? ('\n--- last state payload ---\n' + diagnostics.lastStateRaw)
      : '\n--- last state payload ---\n(none)';
    debugPre.textContent = info.concat(events).join('\n') + payload;
  }

  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = function() {
    try { addEvent('console.error', Array.prototype.slice.call(arguments).map(String).join(' | ')); } catch (_) { /* noop */ }
    return originalConsoleError.apply(console, arguments);
  };
  console.warn = function() {
    try { addEvent('console.warn', Array.prototype.slice.call(arguments).map(String).join(' | ')); } catch (_) { /* noop */ }
    return originalConsoleWarn.apply(console, arguments);
  };

  window.addEventListener('error', function(event) {
    const detail = String(event && event.message ? event.message : 'unknown') +
      ' @ ' + String(event && event.filename ? event.filename : 'unknown') +
      ':' + String(event && event.lineno ? event.lineno : 0) +
      ':' + String(event && event.colno ? event.colno : 0);
    addEvent('window.error', detail);
  });

  window.addEventListener('unhandledrejection', function(event) {
    const reason = event && event.reason ? event.reason : 'unknown';
    addEvent('unhandledrejection', typeof reason === 'string' ? reason : safeStringify(reason));
  });

  function renderState(state) {
    const items = Array.isArray(state && state.items) ? state.items : [];
    diagnostics.lastStateSummary = 'items=' + items.length + ', keys=' + Object.keys(state || {}).join(',');
    diagnostics.lastStateRaw = safeStringify(state);
    addEvent('state.received', diagnostics.lastStateSummary);
    if (count) {
      count.textContent = 'Fallback mode (diagnostics)';
    }
    if (!list) {
      return;
    }
    if (items.length === 0) {
      setText('Queue is empty (fallback mode)');
      return;
    }
    list.innerHTML = items.map(function(item, idx) {
      const status = (item && typeof item.status === 'string') ? item.status.toUpperCase() : 'STAGED';
      const text = (item && typeof item.originalText === 'string') ? item.originalText : '';
      return '<div class="queue-item" style="border-left:3px solid var(--vscode-inputValidation-warningBorder,#d7ba7d);">' +
        '<div class="item-meta">#' + (idx + 1) + ' · ' + esc(status) + '</div>' +
        '<div style="white-space:pre-wrap;">' + esc(text) + '</div>' +
      '</div>';
    }).join('');
  }

  window.addEventListener('message', function(e) {
    const msg = e.data;
    const msgType = msg && msg.type ? String(msg.type) : '(unknown)';
    addEvent('message', 'type=' + msgType);
    if (msg && msg.type === 'state') {
      renderState(msg);
    }
  });

  addEvent('fallback.activated', 'Queue editor fallback booted because main script flag was missing');
  renderDebug();
  setText('Fallback mode active. Loading state…');
  addEvent('postMessage', 'requesting state');
  vscode.postMessage({ type: 'getState' });
})();
