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

/**
 * Copy a video URL for a given id to the clipboard, show a toast,
 * and optionally trigger a confirmation animation on the invoking button.
 *
 * @param {Event} [e] - Optional click event from the triggering button.
 * @param {string} id - Invite code to embed in the URL path.
 * @returns {void}
 */
function copyVideoURL(e, id) {
    /** @type {HTMLElement|undefined} */
    const btn = /** @type {any} */ (e?.currentTarget);
    const url = `https://youtu.be/${id}`;

    navigator.clipboard.writeText(url.toString())
        .then(() => {
            showToast("Video URL copied to clipboard","success");
            if (btn) {
                triggerCheckmarkAnim(btn);
            }
        })
        .catch(err => {
            showToast("Video URL failed to copy","error");
            console.error("Clipboard copy failed:", err);
        });
}

/* ============================================================================
 * Micro Animations
 * ==========================================================================*/

// Track per-element listeners/timers; auto-GC when elements go away
const animCtx = new WeakMap();

/**
 * Retrigger a CSS keyframe animation by toggling the class `animate-check`.
 *
 * @param {HTMLElement|null|undefined} btn - The element to animate.
 * @param {{hardCapMs?: number, idleNoStartMs?: number}} [opts]
 * @returns {void}
 */
function triggerCheckmarkAnim(btn, opts = {}) {
    if (!btn) {
        return;
    }

    const hardCapMs = opts.hardCapMs ?? 4000; // safety: never get stuck
    const idleNoStartMs = opts.idleNoStartMs ?? 50;

    // Cancel previous cycle for this element
    const prev = animCtx.get(btn);
    if (prev) {
        prev.abort.abort();
        clearTimeout(prev.hardCap);
        clearTimeout(prev.noStart);
    }

    btn.classList.remove('animate-check');
    // force reflow to reset animation state
    // eslint-disable-next-line no-unused-expressions
    btn.offsetWidth;
    // re-trigger the CSS animation reliably
    btn.classList.add('animate-check');

    // New context
    const abort = new AbortController();
    const ctx = { abort, hardCap: 0, noStart: 0 };
    animCtx.set(btn, ctx);

    let pending = 0;
    let sawStart = false;

    const remove = () => {
        btn.classList.remove('animate-check');
        abort.abort();
        clearTimeout(ctx.hardCap);
        clearTimeout(ctx.noStart);
        animCtx.delete(btn);
    };

    const isOurs = (t) => t === btn || btn.contains(t);

    // Count starts/ends; ignore infinite animations (they never "end")
    const consider = (e, isStart) => {
        if (!isOurs(e.target)) return;

        const iters = getComputedStyle(e.target).animationIterationCount || "";
        const infinite = iters.split(",").some(v => v.trim() === "infinite");
        if (infinite) return;

        if (isStart) {
            sawStart = true;
            pending++;
        } else {
            if (pending > 0) pending--;
            if (sawStart && pending === 0) {
                // Allow same-frame starts to queue, then remove
                queueMicrotask(remove);
            }
        }
    };

    btn.addEventListener("animationstart", (e) => consider(e, true),  { signal: abort.signal, capture: true });
    btn.addEventListener("animationend",   (e) => consider(e, false), { signal: abort.signal, capture: true });
    btn.addEventListener("animationcancel",(e) => consider(e, false), { signal: abort.signal, capture: true });

    // If nothing actually starts, clear quickly so it can be retriggered
    ctx.noStart = setTimeout(() => { if (!sawStart) remove(); }, idleNoStartMs);

    // Hard cap safety (handles buggy CSS or canceled events)
    ctx.hardCap = setTimeout(remove, hardCapMs);
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
 * Timestamp Rendering
 * ===========================================================================*/

(function() {
    const SELECTOR = 'time[data-rel]';
    const ctxByEl = new WeakMap(); // el -> { ts, nextDue, countdown, suffix }
    const visible = new Set();
    let timer = 0;

    const io = 'IntersectionObserver' in window
        ? new IntersectionObserver(entries => {
            for (const e of entries) {
                if (e.isIntersecting) { visible.add(e.target); scheduleFor(e.target); }
                else visible.delete(e.target);
            }
            reschedule();
        }, { threshold: 0 })
        : null;

    function parse(el) {
        let ctx = ctxByEl.get(el);
        if (ctx) return ctx;
        const iso = el.getAttribute('datetime') || el.dateTime || el.textContent.trim();
        const ts = Date.parse(iso);
        const countdown = el.hasAttribute('data-countdown');
        const rawSuffix = (el.getAttribute('data-suffix') || 'long').toLowerCase();
        const suffix = rawSuffix === 'none' ? 'none' : 'long';
        ctx = { ts, nextDue: 0, countdown, suffix };
        ctxByEl.set(el, ctx);
        if (io) io.observe(el);
        return ctx;
    }

    function plural(n, unit) { return n === 1 ? `${n} ${unit}` : `${n} ${unit}s`; }

    function withSuffix(text, future, mode) {
        return mode === 'none' ? text : `${text} ${future ? 'from now' : 'ago'}`;
    }

    function formatRelative(ts, now, countdown, suffix) {
        const ms = ts - now;
        const future = ms > 0;
        const absS = Math.floor(Math.abs(ms) / 1000);

        if (future && countdown) {
            const total = Math.max(0, Math.ceil(ms / 1000));
            const m = Math.floor(total / 60);
            const s = total % 60;
            const body = m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
            return withSuffix(body, true, suffix);
        }

        if (absS < 60) {
            return withSuffix('less than a minute', future, suffix);
        }

        const mins = Math.floor(absS / 60);
        return withSuffix(plural(mins, 'minute'), future, suffix);
    }

    function computeNextDue(ts, now, countdown) {
        const future = ts > now;
        const abs = Math.abs(ts - now);

        if (future && countdown) {
            const nextSecond = now - (now % 1000) + 1000 + 5;
            return Math.min(nextSecond, ts);
        }
        if (abs < 60_000) {
            return future ? ts : ts + 60_000;
        }
        if (future) {
            const rem = (ts - now) % 60_000;
            return now + (rem === 0 ? 60_000 : rem);
        }
        const remPast = (now - ts) % 60_000;
        return now + (60_000 - remPast);
    }

    function renderAndSchedule(el, now) {
        const { ts, countdown, suffix } = parse(el);
        if (Number.isNaN(ts)) return Infinity;

        const newText = formatRelative(ts, now, countdown, suffix);
        if (el.textContent !== newText) el.textContent = newText;

        if (!el.title) {
            try {
                el.title = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' })
                    .format(new Date(ts));
            } catch {}
        }

        const due = computeNextDue(ts, now, countdown);
        ctxByEl.get(el).nextDue = due;
        return due;
    }

    function scheduleFor(el) { return renderAndSchedule(el, Date.now()); }

    function reschedule() {
        clearTimeout(timer);
        const now = Date.now();
        let earliest = Infinity;
        const pool = io ? visible : new Set(document.querySelectorAll(SELECTOR));
        for (const el of pool) {
            const ctx = ctxByEl.get(el) || parse(el);
            if (!ctx) continue;
            if (!ctx.nextDue) ctx.nextDue = computeNextDue(ctx.ts, now, ctx.countdown);
            if (ctx.nextDue < earliest) earliest = ctx.nextDue;
        }
        if (earliest !== Infinity) {
            timer = setTimeout(tick, Math.max(0, earliest - Date.now()));
        }
    }

    function tick() {
        const now = Date.now();
        const pool = io ? [...visible] : [...document.querySelectorAll(SELECTOR)];
        let earliest = Infinity;
        for (const el of pool) {
            const ctx = ctxByEl.get(el);
            if (!ctx) continue;
            if (ctx.nextDue - 2 <= now) {
                const due = renderAndSchedule(el, now);
                if (due < earliest) earliest = due;
            } else if (ctx.nextDue < earliest) {
                earliest = ctx.nextDue;
            }
        }
        if (earliest !== Infinity) {
            timer = setTimeout(tick, Math.max(0, earliest - Date.now()));
        }
    }

    function init() {
        const nodes = document.querySelectorAll(SELECTOR);
        const now = Date.now();
        for (const el of nodes) {
            const ctx = parse(el);
            el.textContent = formatRelative(ctx.ts, now, ctx.countdown, ctx.suffix);
            if (io) visible.add(el);
        }
        reschedule();
    }

    const mo = new MutationObserver(() => {
        for (const el of document.querySelectorAll(SELECTOR)) parse(el);
        reschedule();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('DOMContentLoaded', init);
})();

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
