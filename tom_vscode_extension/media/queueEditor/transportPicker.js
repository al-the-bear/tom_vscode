// @ts-nocheck
/* eslint-disable no-undef */
// Transport picker wiring — extracted verbatim from transportPickerScript() in
// src/utils/transportPicker.ts (Phase B.13 webview restructuring). Host-scope
// fragment: it references the page-global `vscode` (declared in main.js) inside
// emit(), so no-undef is disabled. Loaded AFTER main.js so the .transport-picker
// markup that main.js injects from init is already in the DOM when this runs.
// transportPicker.ts's transportPickerScript() now returns this file verbatim
// (readMediaText), keeping a single source of truth for any other consumer.
document.querySelectorAll('.transport-picker').forEach(function(root) {
    var prefix = root.getAttribute('data-tp-prefix') || '';
    var eventType = root.getAttribute('data-tp-event') || '';
    var tSel = document.getElementById(prefix + '-transport-t');
    var pSel = document.getElementById(prefix + '-transport-profile');
    var tplA = document.getElementById(prefix + '-transport-tpl-anthropic');
    var tplC = document.getElementById(prefix + '-transport-tpl-copilot');
    var pWrap = document.getElementById(prefix + '-transport-profile-wrap');
    var targets = document.getElementById(prefix + '-transport-targets');
    var warn = document.getElementById(prefix + '-transport-warn');
    function emit() {
        var t = tSel ? tSel.value : '';
        var tpl = '';
        if (t === 'anthropic' && tplA) { tpl = tplA.value; }
        else if (t === 'copilot' && tplC) { tpl = tplC.value; }
        vscode.postMessage({
            type: eventType,
            idPrefix: prefix,
            transport: t,
            anthropicProfileId: pSel ? pSel.value : '',
            messageTemplateId: tpl,
        });
        var isAnthropic = t === 'anthropic';
        var isCopilot = t === 'copilot';
        if (targets) { targets.style.display = (isAnthropic || isCopilot) ? '' : 'none'; }
        if (pWrap) { pWrap.style.display = isAnthropic ? '' : 'none'; }
        if (tplA) { tplA.style.display = isAnthropic ? '' : 'none'; }
        if (tplC) { tplC.style.display = isCopilot ? '' : 'none'; }
        if (warn) { warn.style.display = isAnthropic ? '' : 'none'; }
    }
    if (tSel) { tSel.addEventListener('change', emit); }
    if (pSel) { pSel.addEventListener('change', emit); }
    if (tplA) { tplA.addEventListener('change', emit); }
    if (tplC) { tplC.addEventListener('change', emit); }
});
