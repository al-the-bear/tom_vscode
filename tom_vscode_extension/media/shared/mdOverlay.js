/* Markdown overlay: a text rendered as markdown, shown over the whole panel
 * (the todo panel's list and detail, the queue editor's list), as the chat
 * panel's ? popup does. Shared by the Quest TODO panel (composed into its
 * inline script) and the Prompt Queue editor (loaded as a file).
 *
 * The HTML comes from the extension host (renderQuestLogMarkdown: raw HTML in
 * the source escaped, unsafe URLs dropped), so it is safe for innerHTML.
 * The overlay builds its own elements on first use, so no host has to carry
 * markup for it. Close: the close button, Escape, or a click on the backdrop.
 */

/* eslint-disable no-unused-vars -- the two functions are called from the panels' scripts */

/** The overlay element, built on first use. @returns {HTMLElement} */
function tomMdOverlayElement() {
    /** @type {HTMLElement | null} */
    var existing = document.querySelector('.tom-md-overlay');
    if (existing) { return existing; }
    var overlay = document.createElement('div');
    overlay.className = 'tom-md-overlay';
    overlay.innerHTML =
        '<div class="tom-md-popup" role="dialog" aria-modal="true">' +
            '<div class="tom-md-head">' +
                '<h4 class="tom-md-title"></h4>' +
                '<button class="icon-btn tom-md-close" type="button" title="Close (Escape)"><span class="codicon codicon-close"></span></button>' +
            '</div>' +
            '<div class="tom-md-body"></div>' +
        '</div>';
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) { tomMdOverlayClose(); }
    });
    var close = overlay.querySelector('.tom-md-close');
    if (close) { close.addEventListener('click', tomMdOverlayClose); }
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && overlay.classList.contains('visible')) { tomMdOverlayClose(); }
    });
    document.body.appendChild(overlay);
    return overlay;
}

/**
 * Show `html` (from the host's safe renderer) under `title`.
 * @param {string} title
 * @param {string} html
 */
function tomMdOverlayShow(title, html) {
    var overlay = tomMdOverlayElement();
    var heading = overlay.querySelector('.tom-md-title');
    if (heading) { heading.textContent = title || ''; }
    var body = overlay.querySelector('.tom-md-body');
    if (body) {
        body.innerHTML = html || '<p class="tom-md-empty">(empty)</p>';
        body.scrollTop = 0;
    }
    overlay.classList.add('visible');
}

function tomMdOverlayClose() {
    var overlay = document.querySelector('.tom-md-overlay');
    if (!overlay) { return; }
    overlay.classList.remove('visible');
    var body = overlay.querySelector('.tom-md-body');
    if (body) { body.innerHTML = ''; }
}
