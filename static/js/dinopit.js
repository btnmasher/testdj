/* ========================================================================== *
   *  DINO PIT — Visual Layer & Crowd Physics
   * ========================================================================== *
   *  - Renders and animates a crowd of dinos with DJ booth.
   *  - Includes mouse grab/fling, and light autonomous movement.
   *  - Fixed-timestep physics (Planck.js), sprite-sheet animation
   *  - Public API is exposed at window.DinoPit
   * ========================================================================== */

(function () {
    "use strict";

    const isMobile =
        // Chromium UA-CH boolean when available
        navigator.userAgentData?.mobile ??
        // Fallback regex for other browsers
        /Mobi|Android|iPhone|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) { return; }

    /* ===================== Presentation & Scaling ===================== */
    const DESK_SCALE    = 3;                 // Visual + collider scale for DJ desk
    const DJ_DINO_SCALE = 2;                 // Scale factor for selected DJ dino
    const BOB_FREQ      = 2.0;               // DJ bobbing cycles per second (Hz)

    /* ===================== Modes & States ===================== */
    const MODE_NORMAL  = "normal";           // Regular crowd behavior
    const MODE_SEEK_DJ = "seek_dj";          // En route to the DJ desk
    const MODE_DJ      = "dj";               // Stationed behind the DJ desk

    const STATE_IDLE   = "idle";             // AI idle state
    const STATE_RUN    = "run";              // AI moving state

    /* ===================== Animation Keys ===================== */
    const ANIM_IDLE   = "idle";              // Loop while standing
    const ANIM_WALK   = "walk";              // Moderate locomotion
    const ANIM_RUN    = "run";               // Fast locomotion
    const ANIM_AIR    = "air";               // Single frame while airborne/grabbed
    const ANIM_IMPACT = "impact";            // One-shot on hard contact

    /* ===================== Spritesheet Geometry (cropped) ===================== */
    const TILE_W     = 120;                     // Source tile width (px)
    const TILE_H     = 120;                     // Source tile height (px)
    const TILE_PAD_Y = 15;                      // Transparent padding on top/bottom (px)
    const TILE_PAD_X = 0;                       // Transparent padding on left/right (px)
    const INNER_W    = TILE_W - 2 * TILE_PAD_X; // Cropped content width (px)
    const INNER_H    = TILE_H - 2 * TILE_PAD_Y; // Cropped content height (px)

    /* ===================== World Scale & Step ===================== */
    const MPP        = 1 / 30;               // Meters per pixel (physics scale)
    const FOOT_CLEAR = 1;                    // Floor inset from bottom (px)
    const FIXED_DT   = 1 / 120;              // Fixed physics step (s)

    /* ===================== DJ Desk Sizing (derived) ===================== */
    const DESK_W_VISUAL_BASE   = 64;         // Base visual width before scale (px)
    const DESK_W_COLLIDER_BASE = 32;         // Base collider width before scale (px)
    const DESK_H_BASE          = 16;         // Base height before scale (px)
    const DESK_W_VISUAL   = DESK_W_VISUAL_BASE * DESK_SCALE;   // Scaled visual width (px)
    const DESK_W_COLLIDER = DESK_W_COLLIDER_BASE * DESK_SCALE; // Scaled collider width (px)
    const DESK_H          = DESK_H_BASE * DESK_SCALE;          // Scaled height (px)

    /* ===================== DJ Behavior & Labeling ===================== */
    const DJ_FACE_FLIP_CH = 0.2;            // Chance per second to flip facing while DJ
    const DESK_IDLE_MAX   = 3.0;             // Max idle dwell on desk top (s)
    const LABEL_LIFT_FRAC = 0.85;            // Label lift proportional to sprite height

    /* ===================== Locomotion Timings (AI) ===================== */
    const WALK_ACCEL = 2800;                 // Horizontal accel (px/s^2)
    const WALK_MIN = 360;                    // Target walk speed min (px/s)
    const WALK_MAX = 620;                    // Target walk speed max (px/s)
    const IDLE_MIN = 3.0;                    // Idle duration min (s)
    const IDLE_MAX = 10.0;                   // Idle duration max (s)
    const RUN_MIN  = 2.0;                    // Run duration min (s)
    const RUN_MAX  = 5.0;                    // Run duration max (s)

    /* ===================== Jumping & Crowd Navigation ===================== */
    const JUMP_CH  = 0.030;                  // Per-frame (60Hz) jump chance while running
    const JUMP_MIN = 480;                    // Min jump up-speed (px/s, negative applied)
    const JUMP_MAX = 700;                    // Max jump up-speed (px/s, negative applied)
    const CROWD_HOP_IMMEDIATE = true;        // Hop ASAP when blocked by another dino
    const CROWD_HOP_COOLDOWN  = 0.10;        // Min time pressing before hop (s)
    const CROWD_HOP_VX        = 110;         // Extra lateral speed injected on hop (px/s)
    const AIR_UP_CAP          = 740;         // Cap absolute upward speed (px/s)

    /* ===================== Mouse Fling Behavior ===================== */
    const THROW_MULT_X   = 2.6;              // Mouse-fit vx multiplier on release
    const THROW_MULT_Y   = 1.25;             // Mouse-fit vy multiplier on release
    const THROW_CARRY_T  = 1.25;             // AI pause after fling (s)
    const THROW_DAMP     = 0.0;              // Linear damping while thrown
    const THROW_FRICTION = 0.02;             // Temporary ground friction while thrown
    const THROW_VX_CAP   = 3200;             // Max |vx| from fling (px/s)
    const THROW_VY_CAP   = 2200;             // Max |vy| from fling (px/s)
    const AI_POST_MIN    = 2.0;              // Min AI sleep after fling (s)
    const AI_POST_MAX    = 3.0;              // Max AI sleep after fling (s)
    const AI_REST_SPEED  = 80;               // Speed below which AI can wake (px/s)

    /* ===================== Wall Sensing & Loop-Breaks ===================== */
    const WALL_PROBE_IN       = 18;          // Forward ray depth when free (px)
    const WALL_PROBE_OUT      = 12;          // Forward ray depth when blocked (px)
    const TURN_COOLDOWN       = 0.70;        // Min time between voluntary turns (s)
    const STUCK_TURN_T        = 0.12;        // Pressing time before forced turn (s)
    const STUCK_JUMP_T        = 0.28;        // Pressing time before forced jump (s)
    const WALL_TURN_LOCK      = 0.45;        // Lockout window after reaction (s)
    const LOOP_BREAK_INTERVAL = 1.2;         // Time window to detect repeated reactions (s)
    const LOOP_BREAK_IDLE_MIN = 0.8;         // Idle inserted to break loop (min s)
    const LOOP_BREAK_IDLE_MAX = 1.6;         // Idle inserted to break loop (max s)

    /* ===================== Resize Chaos & Boundaries ===================== */
    const RESIZE_FLOOR_FRICTION = 0.02;      // Low friction while resizing
    const NORMAL_FLOOR_FRICTION = 0.90;      // Normal floor friction
    const RESIZE_DEBOUNCE_MS    = 140;       // Debounce after resize (ms)
    const SIDE_REST_BASE        = 0.52;      // Wall restitution (normal)
    const SIDE_REST_BOUNCY      = 0.88;      // Wall restitution (while resizing)

    /* ===================== Impacts & Animation Rates ===================== */
    const IMPACT_TRIG_SPEED = 1100;          // Relative speed to trigger impact (px/s)
    const IMPACT_COOLDOWN   = 0.25;          // Cooldown between impacts (s)
    const FPS_IDLE          = 6;             // Idle fps
    const FPS_WALK          = 10;            // Walk fps
    const FPS_RUN           = 14;            // Run fps
    const FPS_IMPACT        = 18;            // Impact fps
    const FPS_DJ            = 8;             // DJ booth animation fps
    const SPEED_WALK_THRESH = 60;            // >= walk threshold (px/s)
    const SPEED_RUN_THRESH  = 220;           // >= run threshold (px/s)

    /* ===================== Colliders ===================== */
    const HITBOX_TARGET_DIAM_PX = 60;        // Crowd dino circle hitbox diameter (px)

    /* ===================== Spritesheet Rows & Frame Counts ===================== */
    const ROW_IDLE_BASE   = 0;               // Idle variants start row (10 rows)
    const ROW_DJ          = 10;              // DJ booth row
    const ROW_WALK_BASE   = 11;              // Walk variants start row (10 rows)
    const ROW_IMPACT_BASE = 22;              // Impact variants start row (10 rows)
    const ROW_AIR_BASE    = 33;              // Air (single frame) variants start row (10 rows)
    const ROW_RUN_BASE    = 44;              // Run variants start row (10 rows)
    const FRAMES_IDLE     = 4;               // Idle frames per variant row
    const FRAMES_DJ       = 4;               // DJ booth frames
    const FRAMES_WALK     = 6;               // Walk frames per variant row
    const FRAMES_IMPACT   = 4;               // Impact frames per variant row
    const FRAMES_AIR      = 1;               // Air single frame per variant row
    const FRAMES_RUN      = 6;               // Run frames per variant row

    const PALETTES = [
        { name: "lizard-green-default-light", hue: "76deg",  sat: 1.04, bright: 1.09 },
        { name: "cookie-yellow-light",        hue: "39deg",  sat: 1.05, bright: 1.20 },
        { name: "sprout-green-light",         hue: "107deg", sat: 1.20, bright: 1.14 },
        { name: "canyon-brown-light",         hue: "40deg",  sat: 1.20, bright: 1.12 },
        { name: "grapeasaur-purple-light",    hue: "256deg", sat: 1.08, bright: 1.20 },
        { name: "midnight-grey-light",        hue: "0deg",   sat: 0.80, bright: 0.98 },
        { name: "ice-age-white-light",        hue: "0deg",   sat: 0.80, bright: 1.13 },
        { name: "pterodactyl-purple-light",   hue: "256deg", sat: 0.97, bright: 1.20 },
        { name: "meteor-red-light",           hue: "359deg", sat: 1.04, bright: 1.09 },
        { name: "berry-blue-light",           hue: "221deg", sat: 1.20, bright: 1.20 },
        { name: "bubblegum-pink-light",       hue: "299deg", sat: 0.98, bright: 1.18 },
        { name: "splashasaur-blue-light",     hue: "203deg", sat: 1.04, bright: 1.09 }
    ];

    /* ====================================================================== *
     *  DOM & CORE UTILITIES
     * ====================================================================== */

    /** @type {HTMLElement} */
    const stage = document.getElementById("dino-stage");
    /** @type {HTMLElement} */
    const obstacleEl = document.getElementById("dino-obstacle");
    /** @type {HTMLImageElement} */
    const djImg = document.getElementById("dj-sprite");

    stage.addEventListener("selectstart", handlePreventSelect, { passive: false });
    stage.addEventListener("dragstart", handlePreventDrag, { passive: false });

    /** Global Planck.js reference. */
    const pl = window.planck;

    /** @param {number} px */
    function toM(px) {
        return px * MPP;
    }

    /** @param {number} m */
    function toPx(m) {
        return m / MPP;
    }

    /** @param {number} v */
    function Vpx_toMs(v) {
        return v * MPP;
    }

    /** @param {number} v */
    function Vms_toPx(v) {
        return v / MPP;
    }

    /**
     * Clamp a value into a range.
     * @param {number} v
     * @param {number} lo
     * @param {number} hi
     */
    function clamp(v, lo, hi) {
        if (v < lo) {
            return lo;
        }
        if (v > hi) {
            return hi;
        }
        return v;
    }

    /**
     * Uniform random in [a, b).
     * @param {number} a
     * @param {number} b
     */
    function rand(a, b) {
        return Math.random() * (b - a) + a;
    }

    /** @returns {number} Seconds since navigation start. */
    function nowSec() {
        return performance.now() / 1000;
    }

    /** @returns {DOMRect} Stage bounding rect (live). */
    function rect() {
        return stage.getBoundingClientRect();
    }

    /**
     * Returns a palette object.
     * If `num` is not a finite integer within [0, length-1], a random palette is used.
     * @param {number} [num]
     * @returns {any}
     */
    function pickPalette(num) {
        const n = PALETTES.length;
        if (n === 0) return undefined; // or throw new Error('No palettes');

        const isValidIndex = Number.isInteger(num) && num >= 0 && num < n;
        const idx = isValidIndex ? num : ((Math.random() * n) | 0);

        return PALETTES[idx];
    }

    /** @param {Event} e */
    function handlePreventSelect(e) {
        e.preventDefault();
    }

    /** @param {Event} e */
    function handlePreventDrag(e) {
        e.preventDefault();
    }

    /* ====================================================================== *
     *  SPRITESHEET LOADING & BAKING
     * ====================================================================== */

    /**
     * Load an image element, respecting CORS for http/https/data URLs.
     * @param {string} url
     * @returns {Promise<HTMLImageElement>}
     */
    function loadImageEl(url) {
        /** @type {HTMLImageElement} */
        const img = new Image();
        const isHttp = /^https?:/i.test(url);
        const isData = typeof url === "string" && url.startsWith("data:");
        if (isHttp || isData) {
            img.crossOrigin = "anonymous";
        }
        img.decoding = "async";
        img.src = url;
        return img.decode().then(returnImage);

        function returnImage() {
            return img;
        }
    }

    /**
     * Return first n frames (padding with last if shorter).
     * @param {string[]} arr
     * @param {number} n
     * @returns {string[]}
     */
    function takeFrames(arr, n) {
        /** @type {string[]} */
        const base = (arr || []).slice(0, n);
        while (base.length > 0 && base.length < n) {
            base.push(base[base.length - 1]);
        }
        return base;
    }

    /**
     * Slice a sheet into row arrays of data URLs (cropped by TILE_PAD).
     * @param {string} url
     * @returns {Promise<{ url:string, w:number, h:number, rowH:number, rows:string[][] }|null>}
     */
    function sliceRows(url) {
        return loadImageEl(url).then(processImage);

        function processImage(img) {
            const w = img.naturalWidth;
            const h = img.naturalHeight;

            /** @type {HTMLCanvasElement} */
            const cvs = document.createElement("canvas");
            cvs.width = w;
            cvs.height = h;

            /** @type {CanvasRenderingContext2D} */
            const ctx = cvs.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);

            try {
                // Will throw if tainted.
                ctx.getImageData(0, 0, 1, 1);
            } catch (_e) {
                console.warn("Canvas tainted — crossOrigin blocked.");
                return null;
            }

            const cols = Math.floor(w / TILE_W);
            const rows = Math.floor(h / TILE_H);
            /** @type {string[][]} */
            const out = [];

            /** Loop rows */
            let r = 0;
            while (r < rows) {
                /** @type {string[]} */
                const row = [];
                let c = 0;
                while (c < cols) {
                    const sx = c * TILE_W + TILE_PAD_X;
                    const sy = r * TILE_H + TILE_PAD_Y;
                    /** @type {HTMLCanvasElement} */
                    const fr = document.createElement("canvas");
                    fr.width = INNER_W;
                    fr.height = INNER_H;
                    fr.getContext("2d").drawImage(img, sx, sy, INNER_W, INNER_H, 0, 0, INNER_W, INNER_H);
                    row.push(fr.toDataURL());
                    c += 1;
                }
                out.push(row);
                r += 1;
            }

            return { url, w, h, rowH: INNER_H, rows: out };
        }
    }

    /**
     * Build animation packs for 10 variants + DJ row.
     * @param {{rows:string[][]}} sheet
     */
    function bakeVariants(sheet) {
        const rows = sheet.rows;
        /** @type {Array<{variant:number, idle:string[], walk:string[], run:string[], air:string[], impact:string[]}>} */
        const packs = [];
        let v = 0;
        while (v < 10) {
            packs.push({
                variant: v,
                idle:   takeFrames(rows[ROW_IDLE_BASE   + v], FRAMES_IDLE),
                walk:   takeFrames(rows[ROW_WALK_BASE   + v], FRAMES_WALK),
                run:    takeFrames(rows[ROW_RUN_BASE    + v], FRAMES_RUN),
                air:    takeFrames(rows[ROW_AIR_BASE    + v], FRAMES_AIR),
                impact: takeFrames(rows[ROW_IMPACT_BASE + v], FRAMES_IMPACT)
            });
            v += 1;
        }
        const djFrames = takeFrames(rows[ROW_DJ], FRAMES_DJ);
        return { packs, djFrames };
    }

    /* ====================================================================== *
     *  WORLD SETUP & STATIC GEOMETRY
     * ====================================================================== */

    /** Planck world with mild gravity. */
    const world = new pl.World({ gravity: pl.Vec2(0, +60) });
    if (typeof world.setAllowSleeping === "function") {
        world.setAllowSleeping(false);
    }

    /** Collision categories. */
    const CAT_CROWD = 0x0001;
    const CAT_DJ    = 0x0002;
    const CAT_WORLD = 0x0004;
    const CAT_DESK  = 0x0008;

    /** Stage dimensions (updated on resize). */
    const b0 = rect();
    let W = b0.width;
    let H = b0.height;

    /** Resize state flag. */
    let RESIZING_ACTIVE = false;

    /** Desk obstacle bounds (visual + derived). */
    const obs = { left: 0, right: 0, top: 0, bottom: 0, w: DESK_W_COLLIDER, h: DESK_H, cx: 0 };

    /** Static bodies/fixtures. */
    let floorBody = null, ceilBody = null, leftBody = null, rightBody = null, deskBody = null;
    let floorFx = null,   ceilFx = null,   leftFx = null,   rightFx = null,   deskFx = null;

    /**
     * Position and size the desk overlay element and derived bounds.
     */
    function layoutObstacle() {
        obstacleEl.style.width  = String(DESK_W_COLLIDER) + "px";
        obstacleEl.style.height = String(DESK_H) + "px";

        obs.w = DESK_W_COLLIDER;
        obs.h = DESK_H;
        obs.left   = Math.round((W - DESK_W_COLLIDER) / 2);
        obs.right  = obs.left + DESK_W_COLLIDER;
        obs.bottom = H - FOOT_CLEAR;
        obs.top    = obs.bottom - DESK_H;
        obs.cx     = (obs.left + obs.right) / 2;

        djImg.style.setProperty("--dj-width", String(DESK_W_VISUAL) + "px");
        djImg.style.setProperty("--dj-shift", "0px");

        updateDeskVisual();
    }

    /**
     * Destroy existing static bodies/fixtures if present.
     */
    function destroyStatics() {
        const bodies = [floorBody, ceilBody, leftBody, rightBody, deskBody];
        let i = 0;
        while (i < bodies.length) {
            if (bodies[i]) {
                world.destroyBody(bodies[i]);
            }
            i += 1;
        }
        floorBody = null; ceilBody = null; leftBody = null; rightBody = null; deskBody = null;
        floorFx   = null; ceilFx   = null; leftFx   = null; rightFx   = null; deskFx   = null;
    }

    /**
     * Rebuild static boundaries and desk collider using current stage size.
     */
    function buildStatics() {
        destroyStatics();

        /** Side wall restitution varies during resize to be bouncy. */
        const sideRest = RESIZING_ACTIVE ? SIDE_REST_BOUNCY : SIDE_REST_BASE;

        floorBody = world.createBody();
        floorFx = floorBody.createFixture(
            pl.Box(toM(W / 2), toM(2), pl.Vec2(toM(W / 2), toM(H - FOOT_CLEAR)), 0),
            {
                friction: RESIZING_ACTIVE ? RESIZE_FLOOR_FRICTION : NORMAL_FLOOR_FRICTION,
                restitution: 0.24,
                filterCategoryBits: CAT_WORLD,
                filterMaskBits: CAT_CROWD | CAT_DJ
            }
        );
        floorFx.setUserData("world");

        ceilBody = world.createBody();
        ceilFx = ceilBody.createFixture(
            pl.Box(toM(W / 2), toM(2), pl.Vec2(toM(W / 2), toM(0)), 0),
            {
                friction: 0,
                restitution: 0.20,
                filterCategoryBits: CAT_WORLD,
                filterMaskBits: CAT_CROWD | CAT_DJ
            }
        );
        ceilFx.setUserData("world");

        leftBody = world.createBody();
        leftFx = leftBody.createFixture(
            pl.Box(toM(2), toM(H / 2), pl.Vec2(toM(0), toM(H / 2)), 0),
            {
                friction: 0.10,
                restitution: sideRest,
                filterCategoryBits: CAT_WORLD,
                filterMaskBits: CAT_CROWD | CAT_DJ
            }
        );
        leftFx.setUserData("world");

        rightBody = world.createBody();
        rightFx = rightBody.createFixture(
            pl.Box(toM(2), toM(H / 2), pl.Vec2(toM(W), toM(H / 2)), 0),
            {
                friction: 0.10,
                restitution: sideRest,
                filterCategoryBits: CAT_WORLD,
                filterMaskBits: CAT_CROWD | CAT_DJ
            }
        );
        rightFx.setUserData("world");

        deskBody = world.createBody();
        deskFx = deskBody.createFixture(
            pl.Box(toM(DESK_W_COLLIDER / 2), toM(DESK_H / 2), pl.Vec2(toM(W / 2), toM(H - FOOT_CLEAR - DESK_H / 2)), 0),
            {
                friction: 0.88,
                restitution: 0.20,
                filterCategoryBits: CAT_DESK,
                filterMaskBits: CAT_CROWD
            }
        );
        deskFx.setUserData("desk");
    }

    /* ====================================================================== *
     *  DINO CLASS (ENTITY)
     * ====================================================================== */

    class Dino {
        /**
         * @param {typeof DinoPit} manager
         * @param {string|number} id
         * @param {{
         *   id?:string, name?:string, color:?number, variant?:number
         *   x?:number, y?:number, scale?:number, hitboxDiameterPx?:number,
         *   palette?:any
         * }} [opts]
         */
        constructor(manager, id, opts) {
            /** Manager ref + id */
            this.mgr = manager;
            this.id = String(id);

            /** Options and derived sprite scale */
            const options = opts || {};
            const scaleCSS = parseFloat(getComputedStyle(stage).getPropertyValue("--dino-scale")) || 1;
            this.scale = (options.scale != null) ? options.scale : scaleCSS;

            /** Sprite geometry */
            this.spritePx = 64 * this.scale;
            this.spriteR = this.spritePx / 2;

            /** Hitbox radius selection */
            const desiredDiam = (options.hitboxDiameterPx != null) ? options.hitboxDiameterPx : HITBOX_TARGET_DIAM_PX;
            this.r = Math.min(desiredDiam / 2, this.spriteR * 0.98);

            /** Spawn position */
            const spawnX = (options.x != null) ? options.x : (Math.random() * (W - 2 * this.r) + this.r);
            const spawnY = (options.y != null) ? options.y : (Math.random() * Math.max(10, H - 3 * this.r) + this.r);

            /** Body + fixture */
            this.body = world.createBody({ type: "dynamic", position: pl.Vec2(toM(spawnX), toM(spawnY)), fixedRotation: true });
            this.body.setBullet(true);
            this.fixture = this.body.createFixture(
                pl.Circle(toM(this.r)),
                {
                    density: 1.0,
                    friction: 0.25,
                    restitution: 0.18,
                    filterCategoryBits: CAT_CROWD,
                    filterMaskBits: CAT_WORLD | CAT_DESK | CAT_CROWD,
                    filterGroupIndex: +1
                }
            );
            this.fixture.setUserData("dino");
            this.body.setLinearDamping(0.02);
            this.body.setAwake(true);
            this.body._dinoRef = this;

            /** Label text falls back to id if not set*/
            const name = (typeof options.name === "string" && options.name) ? options.name : this.id;

            /** DOM structure */
            const dom = Dino.createDOM(this.id, name);
            this.el       = dom.el;
            this.zoomWrap = dom.zoom;
            this.bobWrap  = dom.bob;
            this.flipWrap = dom.flip;
            this.sprite   = dom.img;
            this.label    = dom.label;
            this.labeltext = dom.labeltext;

            this.name = name;

            /** Cosmetic palette */
            const palette = options.palette || pickPalette(options.color);
            this.setPalette(palette);

            /** Variant + pack selection */
            this.variant = (typeof options.variant === "number") ? clamp(options.variant | 0, 0, 9) : ((Math.random() * 10) | 0);
            this.pack = (this.mgr.variantPacks && this.mgr.variantPacks[this.variant]) ? this.mgr.variantPacks[this.variant] : Dino.fallbackPack();

            /** Animation state */
            this.anim = { name: ANIM_IDLE, frames: this.pack.idle, once: false, t: 0, idx: 0, fps: FPS_IDLE };
            this.sprite.src = this.anim.frames[0];

            /** Facing + visual pose */
            this._face = (Math.random() < 0.5 ? -1 : 1);
            this.el.style.setProperty("--face", this._face);

            this.setZoomAndLabel(1);
            this.setBob(0);

            this.spriteH = this.spritePx;
            this.footGapPx = 0;

            /** AI movement state */
            this.state = (Math.random() < 0.5 ? STATE_RUN : STATE_IDLE);
            this.t = (this.state === STATE_RUN) ? rand(RUN_MIN, RUN_MAX) : rand(IDLE_MIN, IDLE_MAX);
            this.dir = (Math.random() < 0.5 ? -1 : 1);
            this.target = 0;
            this.dirLock = 0;
            this.lastTurnT = 0;
            this.wallT = 0;
            this.wallBlocked = false;
            this.wallDir = 0;
            this.lastReactionT = 0;
            this.reactionCount = 0;
            this.blockT = 0;

            /** Mouse grab/throw state */
            this.grabbed = false;
            this.grabSamples = [];
            this.mouseJoint = null;

            /** Post-throw rest */
            this.throwCarry = 0;
            this.aiSleep = false;
            this.aiSleepT = 0;

            /** Impact bookkeeping */
            this.wasGrounded = false;
            this.prevVy = 0;
            this.prevVx = 0;
            this.lastImpact = 0;

            /** Behavioral mode & rendering layer */
            this._mode = MODE_NORMAL;
            this.layer = "crowd";

            this.refreshInteractivity();
            this.wakeKick();
        }

        /**
         * Create the DOM subtree for a dino.
         * @param {string} id
         * @param {string} name
         */
        static createDOM(id, name) {
            const el   = document.createElement("div");
            const zoom = document.createElement("div");
            const bob  = document.createElement("div");
            const flip = document.createElement("div");
            const img  = document.createElement("img");
            const label = document.createElement("div");
            const labeltext = document.createElement("span");

            el.className = "dino";
            el.dataset.id = id;

            zoom.className = "sprite-zoom";
            bob.className  = "sprite-bob";
            flip.className = "sprite-flip";

            img.className = "sprite";
            img.alt = "";
            img.draggable = false;

            label.className = "dino-label";
            labeltext.className = "dino-label-text";
            labeltext.textContent = name;

            flip.appendChild(img);
            bob.appendChild(flip);
            zoom.appendChild(bob);
            label.appendChild(labeltext);
            el.append(zoom, label);
            stage.append(el);

            return { el, zoom, bob, flip, img, label, labeltext };
        }

        /**
         * Minimal pack used before the sheet loads.
         * @returns {{idle:string[],walk:string[],run:string[],air:string[],impact:string[]}}
         */
        static fallbackPack() {
            const f1 = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="6" y="7" width="6" height="5" fill="#6ab04c"/></svg>');
            return { idle: [f1, f1, f1, f1], walk: [f1, f1], run: [f1, f1], air: [f1], impact: [f1, f1, f1, f1] };
        }

        /** Mode accessors keep bookkeeping centralized. */
        get mode() { return this._mode; }
        set mode(next) { this.setMode(next); }

        get face() { return this._face; }
        set face(val) { this.setFace(val); }

        /**
         * Update the label text and reflect in DOM.
         * @param {string} text
         */
        setName(text) {
            this.name = String(text || "");
            this.label.textContent = this.name || this.id;
        }

        /**
         * Apply palette CSS variables for hue/sat/brightness.
         * @param {{name?:string,hue?:string,sat?:number,bright?:number}|any} p
         */
        setPalette(p) {
            const pal = (typeof p === "object") ? p : pickPalette();
            this.el.dataset.palette = pal.name || "custom";
            this.el.style.setProperty("--dino-hue", pal.hue || "0deg");
            this.el.style.setProperty("--dino-sat", (pal.sat != null ? pal.sat : 1));
            this.el.style.setProperty("--dino-bright", (pal.bright != null ? pal.bright : 1));
        }

        /**
         * Set zoom and label lift/scale derived from sprite height.
         * @param {number} zoom
         */
        setZoomAndLabel(zoom) {
            this.el.style.setProperty("--zoom", String(zoom));
            if (zoom === 1) {
                this.el.style.setProperty("--dino-label-lift", "0px");
                this.el.style.setProperty("--dino-label-scale", "1");
            } else {
                const lift = (zoom - 1) * this.spriteH * LABEL_LIFT_FRAC;
                this.el.style.setProperty("--dino-label-lift", lift.toFixed(2) + "px");
                this.el.style.setProperty("--dino-label-scale", String(zoom));
            }
        }

        /**
         * Flip facing (-1 left, +1 right).
         * @param {number} dir
         */
        setFace(dir) {
            const f = (dir < 0) ? -1 : 1;
            if (f !== this._face) {
                this._face = f;
                this.el.style.setProperty("--face", this._face);
            }
        }

        /**
         * Vertical bob in CSS pixels.
         * @param {number} px
         */
        setBob(px) {
            const value = (px || 0).toFixed(2) + "px";
            this.el.style.setProperty("--bob", value);
        }

        /**
         * Replace sprite variant (0..9) and reset animation.
         * @param {number} v
         * @returns {boolean}
         */
        setVariant(v) {
            const idx = clamp(v | 0, 0, 9);
            if (!this.mgr.variantPacks) {
                return false;
            }
            this.variant = idx;
            this.pack = this.mgr.variantPacks[idx];
            this.setAnim(ANIM_IDLE);
            return true;
        }

        /**
         * Set current animation; optionally one-shot and/or custom fps.
         * @param {string} name
         * @param {{once?:boolean,fps?:number}} [options]
         */
        setAnim(name, options) {
            const opts = options || {};
            const once = !!opts.once;
            const fpsOpt = (opts.fps != null) ? opts.fps : null;

            if (this.anim && this.anim.name === name && !this.anim.once && !once && (fpsOpt == null || fpsOpt === this.anim.fps)) {
                return;
            }

            /** Select frames */
            let frames = null;
            let use = name;
            if (name === ANIM_IDLE) { frames = this.pack.idle; }
            else if (name === ANIM_WALK) { frames = this.pack.walk; }
            else if (name === ANIM_RUN) { frames = this.pack.run; }
            else if (name === ANIM_AIR) { frames = this.pack.air; }
            else if (name === ANIM_IMPACT) { frames = this.pack.impact; }
            else {
                frames = this.pack.idle;
                use = ANIM_IDLE;
            }

            /** Default fps per anim */
            let fps = FPS_IDLE;
            if (use === ANIM_WALK) { fps = FPS_WALK; }
            else if (use === ANIM_RUN) { fps = FPS_RUN; }
            else if (use === ANIM_IMPACT) { fps = FPS_IMPACT; }
            else if (use === ANIM_AIR) { fps = FPS_IDLE; }
            else if (use === ANIM_IDLE) { fps = FPS_IDLE; }

            if (fpsOpt != null) {
                fps = fpsOpt;
            }

            /** Reset anim state */
            this.anim = { name: use, frames: frames, once: once, t: 0, idx: 0, fps: fps };
            if (frames && frames[0]) {
                this.sprite.src = frames[0];
            }
        }

        /**
         * Advance current animation based on dt and fps.
         * @param {number} dt
         */
        advanceAnim(dt) {
            const a = this.anim;
            if (!a || !a.frames || a.frames.length === 0) {
                return;
            }
            a.t += dt * (a.fps || 8);
            while (a.t >= 1) {
                a.t -= 1;
                if (a.once) {
                    if (a.idx < a.frames.length - 1) {
                        a.idx += 1;
                        this.sprite.src = a.frames[a.idx];
                    } else {
                        a.once = false;
                    }
                } else {
                    a.idx = (a.idx + 1) % a.frames.length;
                    this.sprite.src = a.frames[a.idx];
                }
            }
        }

        /** Apply CSS transform to align sprite with body. */
        applyTransform() {
            const p = this.body.getPosition();
            const px = toPx(p.x), py = toPx(p.y);
            const x = Math.round(px - this.spriteR);
            const y = Math.round((py + this.r) - this.spriteH + this.footGapPx);
            this.el.style.transform = "translate3d(" + x + "px," + y + "px,0)";
        }

        /** Toggle cursor + grab affordance based on mode/layer. */
        refreshInteractivity() {
            const canGrab = (this._mode === MODE_NORMAL) && (this.layer === "crowd");
            this.el.classList.toggle("grabbable", canGrab);
        }

        /** Kick a tiny initial velocity to prevent sleepers. */
        wakeKick() {
            const vx = Vpx_toMs(rand(-40, 40));
            const vy = Vpx_toMs(-rand(20, 120));
            this.body.setAwake(true);
            this.body.setLinearVelocity(pl.Vec2(vx, vy));
        }

        /**
         * Switch behavior mode and reconfigure physics + visuals.
         * @param {string} mode
         */
        setMode(mode) {
            if (mode === MODE_DJ) {
                this._mode = MODE_DJ;
                this.layer = "dj";
                this.el.classList.add("is-dj");
                this.setZoomAndLabel(DJ_DINO_SCALE);
                this.fixture.setFilterData({ categoryBits: CAT_DJ, maskBits: 0, groupIndex: 0 });
                this.body.setGravityScale(0);
                this.body.setLinearVelocity(pl.Vec2(0, 0));
                this.body.setPosition(pl.Vec2(toM(obs.cx), toM(obs.bottom - this.r)));
                this.body.setAwake(false);
                this.setBob(0);
                return;
            }

            if (mode === MODE_SEEK_DJ) {
                this._mode = MODE_SEEK_DJ;
                this.layer = "dj";
                this.el.classList.add("is-dj");
                this.setZoomAndLabel(DJ_DINO_SCALE);
                this.fixture.setFilterData({ categoryBits: CAT_DJ, maskBits: CAT_WORLD, groupIndex: 0 });
                this.body.setGravityScale(1);
                this.body.setAwake(true);
                return;
            }

            this._mode = MODE_NORMAL;
            this.layer = "crowd";
            this.el.classList.remove("is-dj");
            this.setZoomAndLabel(1);
            this.fixture.setFilterData({ categoryBits: CAT_CROWD, maskBits: CAT_WORLD | CAT_DESK | CAT_CROWD, groupIndex: +1 });
            this.body.setGravityScale(1);
            this.body.setAwake(true);
            this.refreshInteractivity();
        }

        /** Ground contact sense (short ray beneath). */
        groundInfo() {
            const p = this.body.getPosition();
            const start = pl.Vec2(p.x, p.y + toM(this.r - 1));
            const end   = pl.Vec2(p.x, p.y + toM(this.r + 3));
            let tag = null;

            world.rayCast(start, end, rayGather);

            const any = !!tag;
            const worldDesk = (tag === "world" || tag === "desk");
            return { any, worldDesk, tag };

            function rayGather(f) {
                const t = (typeof f.getUserData === "function") ? f.getUserData() : undefined;
                if (t === "world" || t === "desk" || t === "dino") {
                    tag = t;
                    return 0;
                }
                return 1;
            }
        }

        /**
         * Short raycast ahead to find world/desk/dino blockers.
         * @param {number} dir +1 or -1
         * @param {number} probePx
         */
        forwardSense(dir, probePx) {
            const p = this.body.getPosition();
            const y0 = p.y;

            const offsets = [-0.35, 0, +0.35];
            /** @type {number[]} */
            const offsM = [];
            let i = 0;
            while (i < offsets.length) {
                offsM.push(toM(offsets[i] * this.r));
                i += 1;
            }

            let hit = null;
            i = 0;
            while (i < offsM.length) {
                const start = pl.Vec2(p.x, y0 + offsM[i]);
                const end = pl.Vec2(p.x + toM(dir * (this.r + probePx)), y0 + offsM[i]);
                world.rayCast(start, end, rayHit);
                if (hit) {
                    break;
                }
                i += 1;
            }
            return hit;

            function rayHit(f) {
                const t = (typeof f.getUserData === "function") ? f.getUserData() : undefined;
                if (t === "world" || t === "desk" || t === "dino") {
                    hit = t;
                    return 0;
                }
                return 1;
            }
        }

        /** True when standing atop the visual desk strip. */
        onDeskTop() {
            const p = this.mgr.getPosPx(this);
            const onX = (p.x > obs.left && p.x < obs.right);
            const onY = Math.abs((p.y + this.r) - obs.top) < 1.5;
            return onX && onY;
        }

        /**
         * Ease vx toward a target using a simple accel bound.
         * @param {number} target
         * @param {number} accel
         * @param {number} dt
         */
        setVxToward(target, accel, dt) {
            const v = this.body.getLinearVelocity();
            const cur = Vms_toPx(v.x);
            let next = cur;
            if (cur < target) {
                next = Math.min(target, cur + accel * dt);
            } else {
                next = Math.max(target, cur - accel * dt);
            }
            this.body.setLinearVelocity(pl.Vec2(Vpx_toMs(next), v.y));
            this.body.setAwake(true);
        }

        /**
         * Clamp |vx| to a max.
         * @param {number} max
         */
        clampVx(max) {
            const v = this.body.getLinearVelocity();
            const vx = Vms_toPx(v.x);
            if (Math.abs(vx) > max) {
                const nvx = Math.sign(vx) * max;
                this.body.setLinearVelocity(pl.Vec2(Vpx_toMs(nvx), v.y));
                this.body.setAwake(true);
            }
        }

        /**
         * High-level AI tick: toggles idle/run windows and quick loop-breaking.
         * @param {number} dt
         */
        aiTick(dt) {
            if (this.throwCarry > 0) {
                return;
            }
            if (this.grabbed || this.mouseJoint || this._mode !== MODE_NORMAL || this.aiSleep) {
                return;
            }

            this.t -= dt;
            const tnow = nowSec();

            if (this.state === STATE_IDLE) {
                if (this.t <= 0) {
                    this.state = STATE_RUN;
                    this.t = rand(RUN_MIN, RUN_MAX);
                    this.dir = (Math.random() < 0.5 ? -1 : 1);
                    this.target = rand(WALK_MIN, WALK_MAX) * this.dir;
                    this.dirLock = 0.25;
                    this.lastTurnT = tnow;
                }
                return;
            }

            /** STATE_RUN */
            if (this.dirLock > 0) {
                this.dirLock -= dt;
            }

            const turnReady = (this.dirLock <= 0) && ((tnow - this.lastTurnT) > TURN_COOLDOWN);
            const tryRandom = (Math.random() < dt * 0.10) && (Math.random() < 0.02);

            if (turnReady && tryRandom) {
                this.dir = -this.dir;
                this.target = rand(WALK_MIN, WALK_MAX) * this.dir;
                this.lastTurnT = tnow;
                this.dirLock = 0.25;
            }

            if (this.t <= 0) {
                this.state = STATE_IDLE;
                this.t = rand(IDLE_MIN, IDLE_MAX);
                this.target = 0;
            }

            if (this.onDeskTop() && this.state === STATE_IDLE && this.t > DESK_IDLE_MAX) {
                this.t = DESK_IDLE_MAX;
            }
        }

        /**
         * Low-level walk controller: wall sensing, hop, jump roll, vx easing.
         * @param {number} dt
         */
        walkController(dt) {
            if (this.state !== STATE_RUN) {
                return;
            }
            if (this.aiSleep) {
                return;
            }
            if (this.dirLock > 0) {
                this.dirLock -= dt;
            }

            const feet = this.groundInfo();
            const groundedAny = feet.any;
            const groundedFloor = feet.worldDesk;

            const p = this.mgr.getPosPx(this);
            const nearLeft  = (p.x - this.r) < 1.2;
            const nearRight = (W - (p.x + this.r)) < 1.2;
            const pushingSide = (nearLeft && this.dir < 0) || (nearRight && this.dir > 0);

            const ahead = this.forwardSense(this.dir, this.wallBlocked ? WALL_PROBE_OUT : WALL_PROBE_IN);
            const hittingWall = (ahead === "world" || ahead === "desk") || pushingSide;
            const blockedDino = (ahead === "dino");

            if (blockedDino && groundedAny) {
                this.blockT = (this.blockT || 0) + dt;
                const canHop = CROWD_HOP_IMMEDIATE || (this.blockT >= CROWD_HOP_COOLDOWN);
                if (canHop) {
                    const cur = this.body.getLinearVelocity();
                    const vx = Vpx_toMs(Vms_toPx(cur.x) + CROWD_HOP_VX * this.dir);
                    let vyPx = Math.min(Vms_toPx(cur.y), -rand(JUMP_MIN, JUMP_MAX));
                    if (vyPx < -AIR_UP_CAP) {
                        vyPx = -AIR_UP_CAP;
                    }
                    this.body.setLinearVelocity(pl.Vec2(vx, Vpx_toMs(vyPx)));
                    this.body.setAwake(true);
                    this.dirLock = WALL_TURN_LOCK;
                    this.blockT = 0;
                    return;
                }
            } else {
                this.blockT = 0;
            }

            if (hittingWall && groundedFloor) {
                this.wallT += dt;
                this.wallBlocked = true;
                this.wallDir = this.dir;

                const tnow = nowSec();
                if (this.wallT > STUCK_JUMP_T && this.dirLock <= 0) {
                    const vx = 220 * this.dir;
                    const vy = -Math.max(JUMP_MIN, 420);
                    this.body.setLinearVelocity(pl.Vec2(Vpx_toMs(vx), Vpx_toMs(vy)));
                    this.wallT = 0;
                    this.lastTurnT = tnow;
                    this.dirLock = WALL_TURN_LOCK;
                    if (this._reactedOnce(tnow)) {
                        return;
                    }
                } else if (this.wallT > STUCK_TURN_T && this.dirLock <= 0 && (tnow - this.lastTurnT) > TURN_COOLDOWN) {
                    this.dir = -this.dir;
                    this.target = rand(WALK_MIN, WALK_MAX) * this.dir;
                    this.lastTurnT = tnow;
                    this.dirLock = WALL_TURN_LOCK;
                    if (this._reactedOnce(tnow)) {
                        return;
                    }
                }
            } else if (!blockedDino) {
                this.wallBlocked = false;
                this.wallT = 0;
            }

            if (!hittingWall && groundedFloor) {
                const jumpRoll = Math.random();
                if (jumpRoll < (JUMP_CH * dt * 60)) {
                    const cur = this.body.getLinearVelocity();
                    let vyPx = Math.min(Vms_toPx(cur.y), -rand(JUMP_MIN, JUMP_MAX));
                    if (vyPx < -AIR_UP_CAP) {
                        vyPx = -AIR_UP_CAP;
                    }
                    this.body.setLinearVelocity(pl.Vec2(cur.x, Vpx_toMs(vyPx)));
                    this.body.setAwake(true);
                }
            }

            const accel = groundedFloor ? WALK_ACCEL : (WALK_ACCEL * 0.25);
            this.setVxToward(this.target, accel, dt);
            this.clampVx(WALK_MAX);
        }

        /**
         * Track reaction cadence to insert a small idle and break loops.
         * @param {number} tnow
         * @returns {boolean} True when an idle was injected.
         * @private
         */
        _reactedOnce(tnow) {
            const within = (tnow - this.lastReactionT) <= LOOP_BREAK_INTERVAL;
            if (within) {
                this.reactionCount += 1;
                if (this.reactionCount >= 2) {
                    this.state = STATE_IDLE;
                    this.t = rand(LOOP_BREAK_IDLE_MIN, LOOP_BREAK_IDLE_MAX);
                    this.target = 0;
                    this.dirLock = WALL_TURN_LOCK;
                    this.reactionCount = 0;
                    this.lastReactionT = tnow;
                    return true;
                }
            } else {
                this.reactionCount = 1;
            }
            this.lastReactionT = tnow;
            return false;
        }

        /**
         * Post-throw sleep logic; wakes once calm or timed-out.
         * @param {number} dt
         */
        updateAISleep(dt) {
            if (!this.aiSleep) {
                return;
            }
            this.aiSleepT += dt;
            const v = this.mgr.getVelPx(this);
            const speed = Math.hypot(v.vx, v.vy);
            const onGround = this.groundInfo().any;
            const canWake = (this.aiSleepT >= AI_POST_MIN) && (speed < AI_REST_SPEED) && onGround;
            const timeout = (this.aiSleepT >= AI_POST_MAX);
            if (canWake || timeout) {
                this.aiSleep = false;
            }
        }
    }

    /* ====================================================================== *
     *  PUBLIC MANAGER (DinoPit)
     * ====================================================================== */

    /**
     * Public API for spawning, animating and managing dinos + DJ desk.
     * @type {{
     *   loadSheet:(url:string)=>Promise<{ok:boolean,variants:number,djFrames:number}>,
     *   spawn:(countOrNameOrOpts:number|string|object, opts?:object)=>string|string[],
     *   setName:(id:string,text:string)=>boolean,
     *   remove:(id:string)=>boolean,
     *   clear:()=>void,
     *   list:()=>string[],
     *   setColor:(id:string,palette:any)=>boolean,
     *   anim:(id:string,animConst:string)=>boolean,
     *   setVariant:(id:string,variant:number)=>boolean,
     *   setPitHeight:(css:string)=>void,
     *   makeDJ:(id?:string)=>boolean,
     *   releaseDJ:()=>boolean,
     *   getPosPx:(d:Dino)=>{x:number,y:number},
     *   getVelPx:(d:Dino)=>{vx:number,vy:number},
     *   variantPacks:any,
     *   djFrames:string[],
     *   djActive:boolean,
     *   dinosById:Map<string,Dino>,
     *   currentDJ:string|null
     * }}
     */
    const DinoPit = {
        sheet: null,
        variantPacks: null,
        djFrames: [],
        djIdx: 0,
        djT: 0,
        djActive: false,

        dinosById: new Map(),
        currentDJ: null,

        getPosPx: function getPosPx(d) {
            const p = d.body.getPosition();
            return { x: toPx(p.x), y: toPx(p.y) };
        },

        getVelPx: function getVelPx(d) {
            const v = d.body.getLinearVelocity();
            return { vx: Vms_toPx(v.x), vy: Vms_toPx(v.y) };
        },

        /**
         * Load a sprite sheet and bake variants/DJ frames.
         * Also refreshes the desk visual overlay.
         * @param {string} url
         */
        loadSheet: function loadSheet(url) {
            return sliceRows(url).then(onAtlasLoaded);

            function onAtlasLoaded(atlas) {
                if (!atlas) {
                    DinoPit.sheet = null;
                    DinoPit.variantPacks = null;
                    DinoPit.djFrames = [];
                    updateDeskVisual();
                    return { ok: false, variants: 0, djFrames: 0 };
                }
                const baked = bakeVariants(atlas);
                DinoPit.sheet = atlas;
                DinoPit.variantPacks = baked.packs;
                DinoPit.djFrames = baked.djFrames;
                DinoPit.djIdx = 0;
                DinoPit.djT = 0;
                updateDeskVisual();
                return { ok: true, variants: baked.packs.length, djFrames: DinoPit.djFrames.length };
            }
        },

        /**
         * Spawn dino(s).
         * @param {{
         *   id?: string, name?:string, count?:number, palette?:any, variant?:number,
         *   x?:number, y?:number, scale?:number, hitboxDiameterPx?:number
         * }} opts
         * @returns {string|string[]}
         */
        spawn: function spawn(opts) {
            if (typeof opts !== "object") {
                throw new Error('spawn expects the parameter to be an object defining the spawn options');
            }
            if (!!opts.count && typeof opts.count !== "number") {
                throw new Error("spawn expects count option to be a number or undefined for 1")
            }
            if (!!opts.id && typeof opts.id !== "string") {
                throw new Error("spawn expects id option to be a string or undefined for auto-assign")
            }
            if ((!!opts.name && typeof opts.name !== "string") || opts.name === "") {
                opts.name = opts.id;
            }

            if (!opts.count) {
                return [DinoPit._spawnOne(opts)];
            } else {
                /** @type {string[]} */
                const ids = [];
                let i = 0;
                while (i < opts.count) {
                    ids.push(DinoPit._spawnOne(opts));
                    i += 1;
                }
                return ids;
            }
        },

        /**
         * Update a dino's label text.
         * @param {string} id
         * @param {string} text
         */
        setName: function setName(id, text) {
            const d = DinoPit.dinosById.get(String(id));
            if (!d) {
                return false;
            }
            d.setName(text);
            return true;
        },

        /**
         * Remove a dino by id and destroy its body/DOM.
         * @param {string} id
         */
        remove: function remove(id) {
            const d = DinoPit.dinosById.get(String(id));
            if (!d) {
                return false;
            }
            if (DinoPit.currentDJ === d.id) {
                DinoPit.currentDJ = null;
            }
            if (stage.contains(d.el)) {
                d.el.remove();
            }
            if (world && d.body) {
                world.destroyBody(d.body);
            }
            DinoPit.dinosById.delete(d.id);
            return true;
        },

        /** Remove all dinos and release current DJ. */
        clear: function clear() {
            const it = DinoPit.dinosById.values();
            let stepIt = it.next();
            while (!stepIt.done) {
                const d = stepIt.value;
                if (stage.contains(d.el)) {
                    d.el.remove();
                }
                if (d.body) {
                    world.destroyBody(d.body);
                }
                stepIt = it.next();
            }
            DinoPit.dinosById.clear();
            DinoPit.releaseDJ();
        },

        /** @returns {string[]} All ids currently alive. */
        list: function list() {
            return Array.from(DinoPit.dinosById.keys());
        },

        /**
         * Assign a palette to a dino.
         * @param {string} id
         * @param {any} palette
         */
        setColor: function setColor(id, palette) {
            const d = DinoPit.dinosById.get(String(id));
            if (!d) {
                return false;
            }
            d.setPalette(palette);
            return true;
        },

        /**
         * Force an animation by key constant.
         * @param {string} id
         * @param {string} animConst
         */
        anim: function anim(id, animConst) {
            const d = DinoPit.dinosById.get(String(id));
            if (!d) {
                return false;
            }
            d.setAnim(animConst);
            return true;
        },

        /**
         * Swap sprite variant (0..9).
         * @param {string} id
         * @param {number} variant
         */
        setVariant: function setVariant(id, variant) {
            const d = DinoPit.dinosById.get(String(id));
            if (!d) {
                return false;
            }
            return d.setVariant(variant);
        },

        /**
         * Adjust the CSS height of the pit, rebuilding statics and gently
         * re-seating dinos with a small "resize fling".
         * @param {string} css
         */
        setPitHeight: function setPitHeight(css) {
            const pit = document.getElementById("dino-pit");
            const prevW = W;
            const prevH = H;
            RESIZING_ACTIVE = true;
            buildStatics();
            pit.style.height = css;
            recalcAndFling(prevW, prevH);
            if (resizeEndTimer) {
                clearTimeout(resizeEndTimer);
            }
            resizeEndTimer = setTimeout(endResizeBounce, RESIZE_DEBOUNCE_MS);
        },

        /**
         * Select a dino to walk to the desk and become the DJ.
         * Call with null/undefined to release any DJ.
         * @param {string} [id]
         */
        makeDJ: function makeDJ(id) {
            if (id == null) {
                return DinoPit.releaseDJ();
            }
            const d = DinoPit.dinosById.get(String(id));
            if (!d) {
                throw new Error('No dino "' + id + '"');
            }
            if (DinoPit.currentDJ && DinoPit.currentDJ !== d.id) {
                DinoPit.releaseDJ();
            }
            DinoPit.currentDJ = d.id;
            d.grabbed = false;
            d.grabSamples.length = 0;
            d.el.classList.add("is-dj"); // z-index drops via CSS
            d.labeltext.classList.add("text-rainbow", "text-rainbow-size-200", "rainbow-speed-1000");
            d.label.classList.add("shadow-rainbow", "rainbow-speed-1000")
            d.setZoomAndLabel(DJ_DINO_SCALE);
            setDJActive(true);
            d.mode = MODE_SEEK_DJ;
            return true;
        },

        /**
         * Release the current DJ back to the crowd with a small hop.
         */
        releaseDJ: function releaseDJ() {
            if (!DinoPit.currentDJ) {
                return false;
            }
            const d = DinoPit.dinosById.get(DinoPit.currentDJ);
            if (d) {
                d.mode = MODE_NORMAL;
                const p = DinoPit.getPosPx(d);
                d.body.setPosition(pl.Vec2(toM(p.x), toM(obs.top - d.r - 2)));
                d.body.setLinearVelocity(pl.Vec2(Vpx_toMs(rand(-60, 60)), Vpx_toMs(-rand(120, 260))));
                d.labeltext.classList.remove("text-rainbow", "text-rainbow-size-200",  "rainbow-speed-1000");
                d.label.classList.remove("shadow-rainbow", "rainbow-speed-1000")
                d.setBob(0);
                setTimeout(removeDjClass, 1600);
            }
            DinoPit.currentDJ = null;
            setDJActive(false);
            return true;

            function removeDjClass() {
                if (d && d.el) {
                    d.el.classList.remove("is-dj");
                }
            }
        },

        /** Internal: single spawn with auto id. */
        _spawnOne: function _spawnOne(opts) {
            let dinoId = !!opts.id ? opts.id : DinoPit._nextId();
            !!opts.name ? opts.name : dinoId;
            const d = new Dino(DinoPit, dinoId, opts);
            DinoPit.dinosById.set(d.id, d);
            return d.id;
        },

        /** Internal id counter + formatter. */
        _idCounter: 1,
        _nextId: function _nextId() {
            const s = String(DinoPit._idCounter++).padStart(3, "0");
            return "id-" + s;
        }
    };
    window.DinoPit = DinoPit;

    /* ====================================================================== *
     *  CONTACT HANDLERS (friction/rest + impact flash)
     * ====================================================================== */

    world.on("pre-solve", handlePreSolve);
    world.on("begin-contact", handleBeginContact);

    /**
     * Lower friction on dino-dino to keep flow moving.
     * @param {any} contact
     */
    function handlePreSolve(contact) {
        const a = contact.getFixtureA();
        const b = contact.getFixtureB();
        const ta = (typeof a.getUserData === "function") ? a.getUserData() : undefined;
        const tb = (typeof b.getUserData === "function") ? b.getUserData() : undefined;

        if (ta === "dino" && tb === "dino") {
            contact.setFriction(0.06);
            contact.setRestitution(0.12);
        }
    }

    /**
     * Trigger one-shot "impact" animation on sufficiently hard hits.
     * @param {any} contact
     */
    function handleBeginContact(contact) {
        const fa = contact.getFixtureA();
        const fb = contact.getFixtureB();
        const ta = (typeof fa.getUserData === "function") ? fa.getUserData() : undefined;
        const tb = (typeof fb.getUserData === "function") ? fb.getUserData() : undefined;

        /** @type {Dino|null} */
        let d = null;
        /** @type {string|undefined} */
        let other = undefined;

        if (ta === "dino") {
            d = fa.getBody()._dinoRef;
            other = tb;
        } else if (tb === "dino") {
            d = fb.getBody()._dinoRef;
            other = ta;
        }

        if (!d) {
            return;
        }
        if (d.mode === MODE_DJ) {
            return;
        }
        if (other !== "world" && other !== "desk" && other !== "dino") {
            return;
        }

        const vA = fa.getBody().getLinearVelocity();
        const vB = fb.getBody().getLinearVelocity();
        const rel = Math.hypot(Vms_toPx(vA.x - vB.x), Vms_toPx(vA.y - vB.y));
        const tnow = nowSec();

        if (rel >= IMPACT_TRIG_SPEED && (tnow - d.lastImpact) > IMPACT_COOLDOWN) {
            d.setAnim(ANIM_IMPACT, { once: true });
            d.lastImpact = tnow;
        }
    }

    /* ====================================================================== *
     *  RESIZE RE-SEATING ("CHAOS") HELPERS
     * ====================================================================== */

    /**
     * Recompute stage W/H, rebuild statics, and reseat dinos with gentle impulses.
     * @param {number} prevW
     * @param {number} prevH
     */
    function recalcAndFling(prevW, prevH) {
        /** Snapshot */
        /** @type {{d:Dino,p:{x:number,y:number},v:{vx:number,vy:number}}[]} */
        const snaps = [];
        const it = DinoPit.dinosById.values();
        let stepIt = it.next();
        while (!stepIt.done) {
            const d = stepIt.value;
            snaps.push({ d: d, p: DinoPit.getPosPx(d), v: DinoPit.getVelPx(d) });
            stepIt = it.next();
        }

        /** Recalc */
        const b = rect();
        W = b.width;
        H = b.height;
        layoutObstacle();
        buildStatics();

        const dW = W - prevW;
        const dH = H - prevH;
        const midX = W / 2;

        /** Re-seat */
        let i = 0;
        while (i < snaps.length) {
            const s = snaps[i];
            const d = s.d;

            if (d.mode === MODE_DJ) {
                d.body.setPosition(pl.Vec2(toM(obs.cx), toM(obs.bottom - d.r)));
                d.body.setLinearVelocity(pl.Vec2(0, 0));
                d.body.setAwake(false);
                d.applyTransform();
                i += 1;
                continue;
            }

            const nx = clamp(s.p.x, d.r, W - d.r);
            const ny = clamp(s.p.y, d.r, H - FOOT_CLEAR - d.r);
            d.body.setPosition(pl.Vec2(toM(nx), toM(ny)));

            let vx = s.v.vx;
            let vy = s.v.vy;

            if (dH !== 0) {
                const up = (dH < 0);
                const base = Math.abs(dH) * (up ? 5.2 : 1.8);
                const jitter = 1 + Math.random() * 0.6;
                vy += (up ? -1 : +0.5) * base * jitter + rand(-90, 90);
                vx += rand(-130, 130);
            }

            if (dW < 0) {
                const leftDist  = nx - d.r;
                const rightDist = W - (nx + d.r);
                const nearDist = Math.min(leftDist, rightDist);
                const closeness = Math.max(0, 1 - nearDist / Math.max(1, W * 0.30));
                const towardCenter = (nx < midX) ? +1 : -1;
                const push = Math.abs(dW) * 5.6 * (1 + 1.8 * closeness) * (1 + Math.random() * 0.6);
                vx += towardCenter * push;
            }

            d.body.setLinearVelocity(pl.Vec2(Vpx_toMs(vx), Vpx_toMs(vy)));
            d.body.setAwake(true);
            d.applyTransform();

            i += 1;
        }
    }

    /** Resize end: restore normal friction + rebuild statics. */
    function endResizeBounce() {
        RESIZING_ACTIVE = false;
        buildStatics();
    }

    /* ====================================================================== *
     *  INPUT: POINTER GRAB + FLING
     * ====================================================================== */

    /** Ground body for MouseJoint targets. */
    const ground = world.createBody();
    /** Active pointer map: id -> { id:string, d:Dino } */
    const activeGrabs = new Map();

    window.addEventListener("pointerdown", onPointerDown, { passive: false });
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUpOrCancel, { passive: false });
    window.addEventListener("pointercancel", onPointerUpOrCancel, { passive: false });

    /**
     * Stage-relative pointer position sample.
     * @param {PointerEvent} e
     */
    function stagePos(e) {
        const b = rect();
        return { x: e.clientX - b.left, y: e.clientY - b.top, t: performance.now() };
    }

    /**
     * Linear fit velocity from recent samples.
     * @param {{x:number,y:number,t:number}[]} samples
     */
    function fitVelocity(samples) {
        const t0 = samples[0].t;
        /** @type {{x:number,y:number,t:number}[]} */
        const pts = [];
        let k = 0;
        while (k < samples.length) {
            const s = samples[k];
            pts.push({ x: s.x, y: s.y, t: (s.t - t0) / 1000 });
            k += 1;
        }

        const n = pts.length;
        let St = 0, St2 = 0, Sx = 0, Stx = 0, Sy = 0, Sty = 0;
        k = 0;
        while (k < n) {
            const p = pts[k];
            St += p.t; St2 += p.t * p.t; Sx += p.x; Stx += p.t * p.x; Sy += p.y; Sty += p.t * p.y;
            k += 1;
        }

        const denom = (n * St2 - St * St) || 1e-6;
        const vx = (n * Stx - St * Sx) / denom;
        const vy = (n * Sty - St * Sy) / denom;
        return { vx, vy };
    }

    /** @param {PointerEvent} e */
    function onPointerDown(e) {
        if (e.button != null && e.button !== 0) {
            return;
        }
        /** @type {HTMLElement|null} */
        const wrap = e.target && e.target.closest ? e.target.closest(".dino") : null;
        if (!wrap) {
            return;
        }

        const d = DinoPit.dinosById.get(wrap.dataset.id);
        if (!d) {
            return;
        }
        if (d.mode !== MODE_NORMAL || d.layer !== "crowd") {
            return;
        }

        const pos = stagePos(e);
        e.preventDefault();

        if (typeof wrap.setPointerCapture === "function") {
            try { wrap.setPointerCapture(e.pointerId); } catch (_err) { /* no-op */ }
        }

        d.el.classList.add("grabbing");
        d.grabbed = true;
        d.grabSamples.length = 0;
        d.grabSamples.push(pos);

        const target = pl.Vec2(toM(clamp(pos.x, d.r, W - d.r)), toM(clamp(pos.y, d.r, H - FOOT_CLEAR - d.r)));
        d.mouseJoint = world.createJoint(pl.MouseJoint({ maxForce: 2200 * d.body.getMass(), frequencyHz: 7, dampingRatio: 0.7 }, ground, d.body, target));
        d.body.setAwake(true);
        activeGrabs.set(e.pointerId, { id: d.id, d: d });
    }

    /** @param {PointerEvent} e */
    function onPointerMove(e) {
        const info = activeGrabs.get(e.pointerId);
        if (!info) {
            return;
        }
        e.preventDefault();

        const pos = stagePos(e);
        const d = info.d;

        d.grabSamples.push(pos);

        const cutoff = pos.t - 150;
        while (d.grabSamples.length > 2 && d.grabSamples[0].t < cutoff) {
            d.grabSamples.shift();
        }

        if (d.mouseJoint) {
            const tx = clamp(pos.x, d.r, W - d.r);
            const ty = clamp(pos.y, d.r, H - FOOT_CLEAR - d.r);
            d.mouseJoint.setTarget(pl.Vec2(toM(tx), toM(ty)));
        }
    }

    /** @param {PointerEvent} e */
    function onPointerUpOrCancel(e) {
        const info = activeGrabs.get(e.pointerId);
        if (!info) {
            return;
        }
        const d = info.d;

        d.el.classList.remove("grabbing");
        const samples = d.grabbed ? d.grabSamples : null;
        d.grabbed = false;
        d.grabSamples.length = 0;

        if (d.mouseJoint) {
            world.destroyJoint(d.mouseJoint);
            d.mouseJoint = null;
        }

        if (samples && samples.length >= 2) {
            const fit = fitVelocity(samples);
            const cur = d.body.getLinearVelocity();
            const outVx = Vpx_toMs(clamp(Vms_toPx(cur.x) + fit.vx * THROW_MULT_X, -THROW_VX_CAP, THROW_VX_CAP));
            const outVy = Vpx_toMs(clamp(Vms_toPx(cur.y) + fit.vy * THROW_MULT_Y, -THROW_VY_CAP, THROW_VY_CAP));
            d.body.setLinearVelocity(pl.Vec2(outVx, outVy));
            d.throwCarry = THROW_CARRY_T;
            d.fixture.setFriction(Math.max(THROW_FRICTION, 0.25 * 0.25));
            d.body.setLinearDamping(THROW_DAMP);
            d.body.setBullet(true);
            d.body.setAwake(true);

            const vpx = Vms_toPx(outVx);
            if (Math.abs(vpx) > 2) {
                d.face = (vpx < 0) ? -1 : 1;
            }
        }

        d.aiSleep = true;
        d.aiSleepT = 0;
        activeGrabs.delete(e.pointerId);
    }

    /* ====================================================================== *
     *  MAIN TICK & RENDER
     * ====================================================================== */

    /** RAF timing + accumulator for fixed step. */
    let last = performance.now();
    let acc = 0;
    /** Resize debounce handle. */
    let resizeEndTimer = 0;

    /**
     * Toggle DJ overlay sprite visibility/state.
     * @param {boolean} active
     */
    function setDJActive(active) {
        DinoPit.djActive = !!active;
        updateDeskVisual();
    }

    /** Refresh the desk overlay visibility based on loaded frames. */
    function updateDeskVisual() {
        if (DinoPit.djFrames && DinoPit.djFrames.length > 0) {
            djImg.style.display = "block";
            obstacleEl.classList.add("has-sprite");
            if (!djImg.src) {
                djImg.src = DinoPit.djFrames[0];
            }
            return;
        }
        djImg.style.display = "none";
        obstacleEl.classList.remove("has-sprite");
    }

    /**
     * Guidance toward desk center while in SEEK_DJ.
     * @param {Dino} d
     * @param {number} dt
     */
    function steerToDJ(d, dt) {
        const p = DinoPit.getPosPx(d);
        const dx = obs.cx - p.x;
        const dir = (Math.sign(dx) || 1);
        d.state = STATE_RUN;
        d.dir = dir;
        d.target = dir * WALK_MAX;
        d.setVxToward(d.target, WALK_ACCEL, dt);
        d.clampVx(WALK_MAX);

        const closeEnough = Math.abs(dx) <= Math.max(6, d.r * 0.5);
        if (closeEnough) {
            d.mode = MODE_DJ;
        }
    }

    /**
     * Fixed-step update: AI, physics step, animation & desk overlay.
     * @param {number} dt
     */
    function step(dt) {
        /** Pre-physics: per-dino behavior */
        const it0 = DinoPit.dinosById.values();
        let stepIt0 = it0.next();
        while (!stepIt0.done) {
            const d = stepIt0.value;

            if (d.mode === MODE_DJ) {
                d.bobT = (d.bobT || 0) + dt * BOB_FREQ;
                const bob = Math.sin(d.bobT * 2 * Math.PI) * (2.0 * (d.scale / 4));
                d.setBob(bob);
                d.setAnim(ANIM_IDLE);
                if (Math.random() < dt * DJ_FACE_FLIP_CH) {
                    d.face = (d.face === 1) ? -1 : 1;
                }
            } else if (d.mode === MODE_SEEK_DJ) {
                d.setBob(0);
                d.updateAISleep(dt);
                steerToDJ(d, dt);
            } else {
                d.setBob(0);
                d.updateAISleep(dt);
                if (!d.aiSleep) {
                    d.aiTick(dt);
                    if (!d.grabbed && !d.mouseJoint) {
                        d.walkController(dt);
                        const v = d.body.getLinearVelocity();
                        const vyPx = Vms_toPx(v.y);
                        if (vyPx < -AIR_UP_CAP) {
                            d.body.setLinearVelocity(pl.Vec2(v.x, Vpx_toMs(-AIR_UP_CAP)));
                        }
                    }
                }
            }

            stepIt0 = it0.next();
        }

        /** Physics step */
        world.step(dt, 8, 3);

        /** Post-physics: animation selection and transforms */
        const it1 = DinoPit.dinosById.values();
        let stepIt1 = it1.next();
        while (!stepIt1.done) {
            const d = stepIt1.value;

            const v = DinoPit.getVelPx(d);
            const grounded = d.groundInfo().any;
            const inImpact = d.anim.once && d.anim.name === ANIM_IMPACT && d.anim.idx < (d.anim.frames.length - 1);

            if (!inImpact) {
                if (d.mode === MODE_DJ) {
                    d.setAnim(ANIM_IDLE);
                } else {
                    const airborne = (!grounded || d.grabbed || d.mouseJoint);
                    if (airborne) {
                        d.setAnim(ANIM_AIR);
                    } else {
                        const speed = Math.abs(v.vx);
                        if (d.state === STATE_IDLE && speed < SPEED_WALK_THRESH) {
                            d.setAnim(ANIM_IDLE);
                        } else if (speed > SPEED_RUN_THRESH) {
                            d.setAnim(ANIM_RUN);
                        } else if (speed > SPEED_WALK_THRESH) {
                            d.setAnim(ANIM_WALK);
                        } else {
                            d.setAnim(ANIM_IDLE);
                        }
                    }
                }
            }

            if (Math.abs(v.vx) > 2) {
                d.face = (v.vx < 0) ? -1 : 1;
            }

            d.advanceAnim(dt);
            d.wasGrounded = grounded;
            d.prevVy = Math.abs(v.vy);
            d.prevVx = v.vx;
            d.applyTransform();

            stepIt1 = it1.next();
        }

        /** Desk overlay frame advance */
        if (DinoPit.djActive && DinoPit.djFrames.length > 0) {
            DinoPit.djT += dt * FPS_DJ;
            if (DinoPit.djT >= 1) {
                DinoPit.djT = 0;
                DinoPit.djIdx = (DinoPit.djIdx + 1) % DinoPit.djFrames.length;
                djImg.src = DinoPit.djFrames[DinoPit.djIdx];
            }
        }
    }

    /**
     * requestAnimationFrame loop with fixed-step accumulator.
     * @param {number} t
     */
    function loop(t) {
        let dt = (t - last) / 1000;
        if (dt > 0.05) {
            dt = 0.05;
        }
        last = t;
        acc += dt;
        while (acc >= FIXED_DT) {
            step(FIXED_DT);
            acc -= FIXED_DT;
        }
        requestAnimationFrame(loop);
    }

    /* ====================================================================== *
     *  BOOTSTRAP & RESIZE
     * ====================================================================== */

    /**
     * Spawn an initial crowd and sync variants once sheet (if any) is ready.
     * @param {boolean} ok
     */
    function initialSpawn(ok) {
        let i = 0;
        while (i < 12) {
            DinoPit.spawn({count: 1});
            i += 1;
        }
        if (ok && DinoPit.variantPacks) {
            const it = DinoPit.dinosById.values();
            let stepIt = it.next();
            while (!stepIt.done) {
                const d = stepIt.value;
                if (typeof d.variant !== "number") {
                    d.variant = ((Math.random() * 10) | 0);
                }
                d.pack = DinoPit.variantPacks[d.variant] || d.pack;
                d.setAnim(d.anim ? d.anim.name : ANIM_IDLE);
                stepIt = it.next();
            }
        }
    }

    /** Resize handler (debounced friction restore + reseat fling). */
    function handleResize() {
        RESIZING_ACTIVE = true;
        buildStatics();
        if (resizeEndTimer) {
            clearTimeout(resizeEndTimer);
        }
        resizeEndTimer = setTimeout(endResizeBounce, RESIZE_DEBOUNCE_MS);

        const prevW = W;
        const prevH = H;
        requestAnimationFrame(runRecalc);

        function runRecalc() {
            recalcAndFling(prevW, prevH);
        }
    }

    /** Initialize geometry, start loop, and load sheet (if provided). */
    function start() {
        layoutObstacle();
        buildStatics();
        requestAnimationFrame(loop);

        const sheetUrl = (stage.dataset.sheet && stage.dataset.sheet.trim()) || "";
        if (sheetUrl) {
            DinoPit.loadSheet(sheetUrl).then(onLoaded).catch(onLoadFail);
        } else {
            updateDeskVisual();
            //initialSpawn(false);
        }

        window.addEventListener("resize", handleResize);

        function onLoaded(res) {
            const ok = !!(res && res.ok);
            updateDeskVisual();
            //initialSpawn(ok);
        }

        function onLoadFail() {
            updateDeskVisual();
            //initialSpawn(false);
        }

        window.dispatchEvent(new Event('DinoPit:ready'));
    }

    /* Kick everything off */
    start();

}());