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

// Initialize or restart a countdown on the element with the given id
function initCountdown(id) {
    const el = document.getElementById(id);
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
        setTimeout(() => toast.remove(), 500)
    }, 5000);
}

function copyInviteURL(e, code) {
    const btn   = e?.currentTarget;
    const url   = new URL(window.location.href);
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

function triggerCheckmarkAnim(btn) {
    if (!btn) {
        return;
    }

    btn.classList.remove('animate-check');
    // force reflow to reset animation state
    btn.offsetWidth;
    // re-trigger the CSS animation reliably
    btn.classList.add('animate-check');
}

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

(function() {
    const isMobile =
        navigator.userAgentData?.mobile ??
        /Mobi|Android|iPhone|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent);

    document.documentElement.style.setProperty('--mobile-display', isMobile ? 'block' : 'none');
})();

document.body.addEventListener("htmx:afterOnLoad", (e) => {
    console.debug("Received HTMX load event:", e.detail);
    try {
        const data = e.detail.xhr.getResponseHeader("HX-Trigger");
        if (!data) {
            console.debug("HX-Trigger header not present");
            return;
        }
        console.debug("HX-Trigger raw data:", data);
        const parsed = JSON.parse(data);
        if (parsed?.toast) {
            showToast(parsed.toast.message, parsed.toast.type);
        } else {
            console.debug("Parsed HX-Trigger data:", parsed);
        }
    } catch (err) {
        console.error("Failed to handle HX-Trigger:", err, "event detail: ", e.detail);
    }
});

document.getElementById('sse-drain')?.addEventListener("htmx:sseMessage", (e) => {
    try {
        console.debug("Received SSE event:", e.detail);
        if (e.detail.type === "redirect") {
            console.debug("Received SSE redirect");
            setTimeout(() => {
                window.location.replace(e.detail.data);
            }, 5000);
            return
        }
        console.debug("SSE raw data:", e.detail.data);
        const parsed = JSON.parse(e.detail.data);
        if (parsed?.toast) {
            showToast(parsed.toast.message, parsed.toast.type);
        } else {
            console.debug("Parsed SSE data:", parsed);
        }
    } catch (err) {
        console.error("Failed to handle SSE event:", err);
    }
});


document.getElementById('landingForm')?.addEventListener('keydown', (e) => {
        // Route Enter to the correct button based on where focus is
        const createBtn = document.getElementById('createButton');
        const joinBtn = document.getElementById('joinButton');
        if (e.key !== 'Enter') return;

        console.debug(e);

        // Join panel fields -> /join
        if (e.target.name === "code") {
            e.preventDefault();
            this.requestSubmit ? this.requestSubmit(joinBtn) : joinBtn.click();
            return;
        }

        // Create panel fields -> /create
        if (e.target.name === "limit" || e.target.name === "mode" || e.target.name === 'name') {
            e.preventDefault();
            this.requestSubmit ? this.requestSubmit(createBtn) : createBtn.click();
        }
});
