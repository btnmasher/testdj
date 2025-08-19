// @ts-check

/* ============================================================================
 * Close Beacon on True Tab Close (not normal in-tab navigation)
 * Posts a final "logout/leave" ping when the user genuinely closes the tab or
 * navigates away in a way that unloads the page, while suppressing the ping
 * for same-tab navigations (links, submits, refresh/back, etc.).
 * ==========================================================================*/

(function () {
    /* ------------------------------------------------------------------------
     * Configuration
     * --------------------------------------------------------------------- */

    /**
     * Where to post (same-origin; cookies included automatically).
     * @type {string}
     */
    const ENDPOINT = '/logout';

    /* ------------------------------------------------------------------------
     * Internal State
     * --------------------------------------------------------------------- */

    /** Whether a beacon/post has already been sent. */
    let sent = false;

    /** Whether the current action looks like an in-tab navigation. */
    let navigating = false;

    /* ------------------------------------------------------------------------
     * Navigation Detection (suppress close ping for same-tab nav)
     * --------------------------------------------------------------------- */

    /**
     * Mark in-tab navigations from clicks on normal links (same-tab).
     */
    document.addEventListener('click', function (e) {
        /** @type {HTMLAnchorElement|null} */
        const a = (/** @type {Element} */(e.target))?.closest && (/** @type {Element} */(e.target)).closest('a[href]');
        if (!a) { return; }

        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) { return; }

        // Same-tab only (new tab/window shouldn't fire unload of this tab)
        if (a.target && a.target !== '_self') { return; }

        // Primary button, no modifiers, not prevented
        if (e.button === 0 && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            navigating = true;
        }
    }, true);

    /**
     * Mark form submits (same-tab only).
     */
    document.addEventListener('submit', function (e) {
        /** @type {HTMLFormElement|null} */
        const form = /** @type {any} */ (e.target);
        if (!form) { return; }

        const tgt = (form.getAttribute('target') || '_self').toLowerCase();
        if (tgt === '' || tgt === '_self') {
            navigating = true;
        }
    }, true);

    /**
     * Common keyboard navigations / refresh that keep this tab active.
     */
    document.addEventListener('keydown', function (e) {
        const k = (e.key || '').toLowerCase();
        if (k === 'f5' || e.keyCode === 116) { // F5
            navigating = true;
        }
        if ((e.ctrlKey || e.metaKey) && k === 'r') { // Ctrl/Cmd+R
            navigating = true;
        }
        if ((e.altKey && k === 'arrowleft') || (e.metaKey && k === '[')) { // Back
            navigating = true;
        }
    }, true);

    /* ------------------------------------------------------------------------
     * Close Beacon Sender
     * --------------------------------------------------------------------- */

    /**
     * Send a final beacon/post to the endpoint if this looks like a real tab
     * close/unload (and not a same-tab navigation). Uses `sendBeacon` when
     * available; falls back to `fetch(..., keepalive: true)` and finally a
     * tiny GET image ping as last resort.
     *
     * @param {Record<string, string> | URLSearchParams} [dataObj] - Key/value payload.
     * @returns {void}
     */
    function send(dataObj) {
        if (sent || navigating) return; // only on likely "close"
        sent = true;

        console.debug("detected close");

        const body = dataObj instanceof URLSearchParams
            ? dataObj
            : new URLSearchParams(dataObj || { reason: 'tab_close' });


        // Prefer background beacon when supported
        if ('sendBeacon' in navigator) {
            // Note: URLSearchParams is acceptable; UA sets an appropriate Content-Type.
            navigator.sendBeacon(ENDPOINT, body);
            return;
        }

        // Fallback: keepalive fetch
        try {
            // @ts-ignore: keepalive widely supported on modern browsers
            fetch(ENDPOINT, {
                method: 'POST',
                credentials: 'include',
                keepalive: true,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            }).catch(() => {});
        } catch (_) {
            // Last-resort: GET ping (rare)
            const img = new Image(1, 1);
            img.src = ENDPOINT + '?ping=1&ts=' + Date.now();
        }
    }

    /* ------------------------------------------------------------------------
     * Lifecycle Hooks
     * --------------------------------------------------------------------- */

    // Prevent large-screen scroll bleed while the lobby page is active.
    document.body.classList.add('lg:overflow-hidden');

    /**
     * On impending unload: clean up body class and send close beacon (if appropriate).
     */
    window.addEventListener('beforeunload', function () {
        document.body.classList.remove('lg:overflow-hidden');
        send({ reason: 'tab_close' });
    }, { capture: true });
})();
