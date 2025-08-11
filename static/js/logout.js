
(function () {
    // Where to post (same-origin; includes cookies automatically)
    const ENDPOINT = '/logout'; // or `/lobby/<id>/leave`
    let sent = false;
    let navigating = false;

    // Mark in-tab navigations from clicks on normal links
    document.addEventListener('click', function (e) {
        const a = e.target?.closest && e.target.closest('a[href]');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

        // Same-tab only (new tab/window shouldn't fire unload of this tab)
        if (a.target && a.target !== '_self') return;

        // Primary button, no modifiers, not prevented
        if (e.button === 0 && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            navigating = true;
        }
    }, true);

    // Mark form submits (same-tab)
    document.addEventListener('submit', function (e) {
        const form = e.target;
        if (!form) return;
        const tgt = (form.getAttribute('target') || '_self').toLowerCase();
        if (tgt === '' || tgt === '_self') navigating = true;
    }, true);

    // Common keyboard navigations / refresh
    document.addEventListener('keydown', function (e) {
        const k = (e.key || '').toLowerCase();
        if (k === 'f5' || e.keyCode === 116) navigating = true;             // F5
        if ((e.ctrlKey || e.metaKey) && k === 'r') navigating = true;        // Ctrl/Cmd+R
        if ((e.altKey && k === 'arrowleft') || (e.metaKey && k === '[')) {   // Back
            navigating = true;
        }
    }, true);

    function send(dataObj) {
        if (sent || navigating) return; // only on likely "close"
        sent = true;

        console.debug("detected close")

        const body = new URLSearchParams(dataObj || { reason: 'tab_close' });

        if (navigator.sendBeacon) {
            navigator.sendBeacon(ENDPOINT, body);
            return;
        }
        try {
            fetch(ENDPOINT, {
                method: 'POST',
                credentials: 'include',
                keepalive: true,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            }).catch(() => {});
        } catch (_) {
            // last-resort: GET ping (rarely needed)
            const img = new Image(1,1);
            img.src = ENDPOINT + '?ping=1&ts=' + Date.now();
        }
    }

    window.addEventListener('beforeunload', function () {
        send({ reason: 'tab_close' });
    }, { capture: true });
})();