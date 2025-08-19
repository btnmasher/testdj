if(!DEBUG){
    if(!window.console) window.console = {};
    var methods = ["debug"];
    for(var i=0;i<methods.length;i++){
        console[methods[i]] = function(){};
    }
}

/* ============================================================================
 * Typedefs
 * ==========================================================================*/

/**
 * Tailwind-styled toast payload.
 * @typedef {Object} ToastPayload
 * @property {string} message - Text to display in the toast.
 * @property {"success"|"error"} [type="info"] - Visual sentiment.
 */

/**
 * Element that may carry an interval timer handle for countdowns.
 * @typedef {HTMLElement & {_timer?: number}} TimerElement
 */

/**
 * Detail payload for `htmx:afterOnLoad`.
 * Matches HTMX's documented event detail fields we rely on here.
 * @typedef {Object} HtmxAfterOnLoadDetail
 * @property {XMLHttpRequest} xhr
 * @property {{ triggeringEvent?: { submitter?: HTMLButtonElement } }} [requestConfig]
 */

/**
 * Detail payload for `htmx:sseMessage`.
 * @typedef {Object} HtmxSseMessageDetail
 * @property {string} type - Application-defined message type e.g. "redirect".
 * @property {string} data - JSON-encoded payload string.
 */

/* ============================================================================
 * Time & Countdown Utilities
 * ==========================================================================*/

/**
 * Convert a number of seconds into a compact human-readable string.
 * Examples: `65 -> "1m5s"`, `3661 -> "1h1m1s"`, `45 -> "45s"`.
 *
 * @param {number} totalSec - Total seconds (will be clamped to a non-negative integer).
 * @returns {string} Humanized time string.
 */
function humanizeSeconds(totalSec) {
    // ensure a non-negative integer
    const secs = Math.max(0, Math.floor(totalSec));

    const hours   = Math.floor(secs / 3600);
    const rem     = secs % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;

    let out = "";
    if (hours > 0) {
        out += hours + "h";
    }
    // show minutes if non-zero, or if we have hours and some seconds
    if (minutes > 0 || (hours > 0 && seconds > 0)) {
        out += minutes + "m";
    }
    // always show seconds
    out += seconds + "s";

    return out;
}

/**
 * Initialize or restart a countdown on the element with the given id.
 * The target element must have a `data-ends` (seconds since epoch) attribute.
 * The element's text content is updated once per second with a compact string.
 *
 * @param {string} id - Element id that will display the countdown.
 * @returns {void}
 */
function initCountdown(id) {
    /** @type {TimerElement|null} */
    const el = /** @type {any} */ (document.getElementById(id));
    if (!el) {
        return;
    }

    // clear any existing timer
    if (el._timer) {
        clearInterval(el._timer);
    }

    function update() {
        const ends = parseInt(el.dataset.ends, 10) * 1000;
        const now  = Date.now();
        const diff = Math.max(0, Math.ceil((ends - now)/1000));
        el.textContent = humanizeSeconds(diff);
        if (diff <= 0) clearInterval(el._timer);
    }

    // run immediately, then every second
    update();
    el._timer = setInterval(update, 1000);
}

/* ============================================================================
 * Toasts & Notifications
 * ==========================================================================*/

/**
 * Render a transient toast message into the `#toast-container` element.
 *
 * @param {string} message - The message to display.
 * @param {"info"|"success"|"error"} [type="info"] - The toast's visual style.
 * @returns {void}
 */
function showToast(message, type = "info") {
    const toast = document.createElement("div");
    const color = {
        info: "bg-blue-100 text-blue-800 border-blue-300",
        success: "bg-green-100 text-green-800 border-green-300",
        error: "bg-red-100 text-red-800 border-red-300"
    }[type];
    toast.className = `toast-visible border rounded px-4 py-2 font-bold shadow-md transition-opacity duration-500 ${color}`;
    toast.textContent = message;
    document.getElementById("toast-container").appendChild(toast);
    console.debug("Showing toast:", message, "Type:", type);

    setTimeout(() => {
        toast.classList.add("opacity-0");
        setTimeout(() => toast.remove(), 500);
    }, 5000);
}

/* ============================================================================
 * Clipboard & Invites
 * ==========================================================================*/

/**
 * Copy an invite URL for a given code to the clipboard, show a toast,
 * and optionally trigger a confirmation animation on the invoking button.
 *
 * @param {Event} [e] - Optional click event from the triggering button.
 * @param {string} code - Invite code to embed in the URL path.
 * @returns {void}
 */
function copyInviteURL(e, code) {
    /** @type {HTMLElement|undefined} */
    const btn = /** @type {any} */ (e?.currentTarget);
    const url = new URL(window.location.href);
    url.pathname = `/invite/${code}`;

    navigator.clipboard.writeText(url.toString())
        .then(() => {
            showToast("Invite link copied to clipboard","success");
            if (btn) {
                triggerCheckmarkAnim(btn);
            }
        })
        .catch(err => {
            showToast("Invite link failed to copy","error");
            console.error("Clipboard copy failed:", err);
        });
}

/* ============================================================================
 * Micro Animations
 * ==========================================================================*/

/**
 * Retrigger a CSS keyframe animation by toggling the class `animate-check`.
 *
 * @param {HTMLElement|null|undefined} btn - The element to animate.
 * @returns {void}
 */
function triggerCheckmarkAnim(btn) {
    if (!btn) {
        return;
    }

    btn.classList.remove('animate-check');
    // force reflow to reset animation state
    // eslint-disable-next-line no-unused-expressions
    btn.offsetWidth;
    // re-trigger the CSS animation reliably
    btn.classList.add('animate-check');
}

/**
 * Convenience hook for HTMX success (2xx) responses: triggers the checkmark
 * animation on the submit button and resets the submitting form.
 *
 * @param {HTMLFormElement} sender - The form element that initiated the request.
 * @param {CustomEvent<HtmxAfterOnLoadDetail>} e - HTMX event with XHR and request metadata.
 * @returns {void}
 */
function triggerSuccessAnim(sender, e) {
    const d = e.detail || {};
    const xhr = d.xhr;
    if (xhr && (xhr.status === 200 || xhr.status === 201)) {
        const btn = d?.requestConfig?.triggeringEvent?.submitter
            ?? sender.querySelector('button[type=submit]');
        triggerCheckmarkAnim(btn);
        sender.reset();
    }
}

/* ============================================================================
 * Environment Detection
 * ==========================================================================*/

(function() {
    /**
     * Detects whether the current UA appears to be on a mobile device and
     * exposes it to CSS via the `--mobile-display` custom property.
     */
    const isMobile =
        // Chromium UA-CH boolean when available
        navigator.userAgentData?.mobile ??
        // Fallback regex for other browsers
        /Mobi|Android|iPhone|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent);

    document.documentElement.style.setProperty('--mobile-display', isMobile ? 'block' : 'none');
})();

/* ============================================================================
 * HTMX Event Handlers (HX-Trigger header + SSE)
 * ==========================================================================*/

/**
 * Handle `htmx:afterOnLoad` events to surface server-sent HX-Trigger headers
 * as user-facing toasts.
 */
document.body.addEventListener("htmx:afterOnLoad", (/** @type {CustomEvent<HtmxAfterOnLoadDetail>} */ e) => {
    console.debug("Received HTMX load event:", e.detail);
    try {
        const data = e.detail.xhr.getResponseHeader("HX-Trigger");
        if (!data) {
            if (e.detail.xhr.responseURL.includes("heartbeat")) {
                return;
            }
            console.debug("HX-Trigger header not present");
            return;
        }
        console.debug("HX-Trigger raw data:", data);
        /** @type {{ toast?: ToastPayload }} */
        const parsed = JSON.parse(data);
        if (parsed?.toast) {
            showToast(parsed.toast.message, parsed.toast.type);
        } else {
            console.debug("Parsed HX-Trigger data (no toast):", parsed);
        }
    } catch (err) {
        console.error("Failed to handle HX-Trigger:", err, "event detail: ", e.detail);
    }
});

/**
 * Handle HTMX SSE messages coming through an element with id `sse-drain`.
 * Supports a special `redirect` type and a generic JSON payload with `{ toast }`.
 */
document.getElementById('sse-drain')?.addEventListener("htmx:sseMessage", (/** @type {CustomEvent<HtmxSseMessageDetail>} */ e) => {
    try {
        console.debug("Received SSE event:", e.detail);
        if (e.detail.type === "redirect") {
            console.debug("Received SSE redirect");
            setTimeout(() => {
                window.location.replace(e.detail.data);
            }, 5000);
            return;
        }
        console.debug("SSE raw data:", e.detail.data);
        /** @type {{ toast?: ToastPayload }} */
        const parsed = JSON.parse(e.detail.data);
        if (!!parsed?.toast) {
            showToast(parsed.toast.message, parsed.toast.type);
            return;
        }
        console.debug("Parsed SSE data:", parsed);

        if (!!parsed?.video) {
            const id = parsed?.video?.submitter;
            if (!!id && typeof id === "string" && id !== "") {
                window.DinoPit?.makeDJ(id);
            } else {
                window.DinoPit?.releaseDJ();
            }
            return;
        }

        if (!!parsed?.users) {
            const users = parsed?.users;
            const dinos = window.DinoPit?.list();
            if (users && users.length > 0) {
                for (const user of users) {
                    if (dinos && !dinos.includes(user.id)) {
                        spawnDino(user.id, user.name, user.color, user.variant);
                    }
                }

                const userIds = users.map((user) => user.id);
                for (const dino of dinos) {
                    if (userIds && !userIds.includes(dino)) {
                        removeDino(dino);
                    }
                }
            } else {
                clearDinos();
            }
            return;
        }

        console.debug("Parsed SSE data unhandled:", parsed);
    } catch (err) {
        console.error("Failed to handle SSE event:", err);
    }
});

/* ============================================================================
 * Form Keyboard Routing (Landing Form)
 * ==========================================================================*/

/**
 * Keydown handler for the landing form to route Enter presses to the correct
 * submit button depending on the focused field.
 * - `name`, `mode`, or `limit` -> create button
 * - `code` -> join button
 */
document.getElementById('landingForm')?.addEventListener('keydown', /** @this {HTMLFormElement} */ function (e) {
    // Route Enter to the correct button based on where focus is
    const createBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('createButton'));
    const joinBtn   = /** @type {HTMLButtonElement|null} */ (document.getElementById('joinButton'));
    if (e.key !== 'Enter') return;

    console.debug(e);

    // Join panel fields -> /join
    if ((/** @type {HTMLInputElement} */(e.target)).name === "code") {
        e.preventDefault();
        this.requestSubmit ? this.requestSubmit(joinBtn) : joinBtn?.click();
        return;
    }

    // Create panel fields -> /create
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.name === "limit" || t.name === "mode" || t.name === 'name') {
        e.preventDefault();
        this.requestSubmit ? this.requestSubmit(createBtn) : createBtn?.click();
    }
});

/* ============================================================================
 * DinoPit helpers
 * ==========================================================================*/

function spawnDino(id, name, color, variant) {
    const args = { id, name, color, variant };
    setTimeout(() => window.DinoPit?.spawn(args), 1000);
}

function setDJ(id) {
    setTimeout(() => {window.DinoPit?.makeDJ(id)}, 1000);
}

function removeDino(id) {
    setTimeout(() => window.DinoPit?.remove(id), 1000);
}

function clearDinos() {
    setTimeout(() => window.DinoPit?.clear(), 1000);
}
