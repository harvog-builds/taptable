/**
 * taptable — M5 canvas gesture layer (canvas-touch.js).
 *
 * Adds the two touch gestures core v14 lacks — two-finger pan + pinch-zoom and a
 * one-finger pan on EMPTY canvas — WITHOUT touching any PIXI internals: it listens
 * to raw DOM PointerEvents in the CAPTURE phase on #board's parent and drives the
 * camera through `canvas.pan({x, y, scale})` ONLY (which runs core's _constrainView
 * clamp against min/max zoom and the scene rect — board.mjs:1758). The only reads of
 * PIXI are read-only: `canvas.stage.{position,scale,pivot}` for the camera math and
 * the PIXI event-boundary hit-test to decide whether a finger landed on a placeable.
 * Nothing PIXI is ever mutated.
 *
 * Why capture phase on the PARENT (not on #board): PIXI's EventSystem listens on the
 * #board canvas element itself (the DOM target). A capture-phase listener on an
 * ANCESTOR runs BEFORE the event can descend to #board, so a single stopPropagation()
 * there reliably hides a claimed pointer from PIXI/MouseInteractionManager regardless
 * of listener registration order (a same-element capture listener would NOT, per the
 * DOM target-phase ordering rules). #board's parent is <body> (game.hbs:31 places
 * `<template id="board">` directly under <body>); #board itself is replaced once at
 * canvas init (board.mjs:739 `replaceWith`) but its parent is stable, so we bind the
 * parent once on canvasReady.
 *
 * Coexistence contract (the whole point — never regress core's proven paths):
 *  - A finger that lands ON an interactive placeable is left ENTIRELY to core: we do
 *    NOT stopPropagation, so core's tap-select, token drag and 500ms long-press HUD
 *    all run untouched.
 *  - A finger on EMPTY canvas is only claimed AFTER it travels PAN_START_PX, which is
 *    kept BELOW core's 10px DEFAULT_DRAG_RESISTANCE_PX (mouse-handler.mjs:181): a tap
 *    is never eaten and core never gets far enough to start a selection band.
 *  - The second finger down = two-finger pan+pinch, claimed in the capture phase; any
 *    in-flight core interaction on the first finger is aborted cleanly by dispatching
 *    a synthetic pointercancel to #board (core snaps a half-dragged token back to its
 *    origin — no document write).
 *
 * Gating: only while `game.release.generation === 14` (loud no-op otherwise), only
 * while the Board is the active shell surface (`body.pf-board` — the class shell.js
 * #setBoardActive toggles, shell.js:669; opening any non-Board tab clears it,
 * shell.js:1119, and pf-max windows are CSS-hidden in that mode), and only for
 * pointers whose DOM target is the #board canvas. The shell overlay (#pf-shell, its
 * nav/strip/panes) and every .application window are separate DOM subtrees under
 * <body>, so their event targets are never #board — .pf-* shell UI is excluded by
 * construction, no per-class allowlist needed.
 *
 * Selection band tradeoff: because one-finger empty-canvas drag now pans, core's
 * marquee band-select is unavailable on phones. Accepted (players own one token;
 * band-select is a desktop/GM affordance) — documented in README.md.
 */

const MODULE_ID = "taptable";

/* ============================================================= */
/*  Tuning constants (device-feel knobs — user feedback maps here) */
/* ============================================================= */

/** One-finger empty-canvas travel (CSS px) before a pan claims. MUST stay BELOW
 *  core's DEFAULT_DRAG_RESISTANCE_PX (10, mouse-handler.mjs:181) so a tap is never
 *  eaten and core never starts a selection band before we claim. Lower = the map
 *  starts panning sooner (twitchier); higher = more finger slop before it moves. */
const PAN_START_PX = 8;

/** Minimum initial finger separation (px) used to seed a pinch. Guards the scale
 *  ratio (dist / dist0) against a near-zero starting distance when two fingers land
 *  almost on top of each other. */
const PINCH_MIN_START_DIST = 24;

/** TextureLoader.CACHE_TTL under pf-mobile (ms). Core default is 15 min
 *  (loader.mjs:12); ~2 min makes scene TRANSITIONS purge leftover textures sooner on
 *  memory-tight phones. We NEVER call expireCache() (that unloads in-use textures
 *  mid-scene → black map); only this passive TTL is shortened. */
const MOBILE_CACHE_TTL_MS = 1000 * 60 * 2;

/** 234-1 — long-press-to-open-HUD (Feature A). A DOM long-press timer armed when a
 *  single finger rests on an OWNED token; on fire it opens that token's HUD. Kept just
 *  above core's own longPress (mouse-handler.mjs:548, which only pings) so the feel is
 *  familiar. Cancelled on >LONG_PRESS_MOVE_PX travel / a 2nd finger / finger-up. */
const LONG_PRESS_MS = 500;

/** Finger travel (CSS px) that cancels a pending long-press (a drag, not a hold). */
const LONG_PRESS_MOVE_PX = 8;

/** 234-1 — Multi-Select (Feature B): max tap travel (CSS px) that still counts as a
 *  "tap" for accumulating a token into the selection (a bigger move is not a tap). */
const MULTI_TAP_MOVE_PX = 12;

/* ============================================================= */
/*  Module state                                                 */
/* ============================================================= */

/** Whether the capture-phase listeners are installed. */
let installed = false;

/** The element the capture listeners are bound to (#board's parent). */
let boundParent = null;

/** Gesture mode. */
const MODE = { NONE: "none", PENDING: "pending", PAN: "pan", PINCH: "pinch" };
let mode = MODE.NONE;

/** Live pointers that started on the board: id -> {x, y, sx, sy, onPlaceable}
 *  (x/y = current client coords, sx/sy = start client coords). */
const pointers = new Map();

/** One-finger pan anchor: the world point that must stay under the finger + the
 *  scale in effect at claim time (pan never changes scale). */
let panAnchorWorld = null;
let panScale = 1;

/** Pinch anchors seeded when the 2nd finger lands:
 *  { idA, idB, dist0, scale0, midWorld0 }. */
let pinch = null;

/** 234-1 — Long-press-to-open-HUD state for a single-finger press on an OWNED token:
 *  { pointerId, token, sx, sy, timer } while armed, else null. */
let longPress = null;

/** 234-1 — Pointer ids whose long-press timer already FIRED (HUD opened). Their
 *  up/cancel is swallowed so core's clickLeft — which calls layer.hud.close()
 *  (placeable-object.mjs:1203) — cannot immediately shut the HUD we just opened. */
const longPressFired = new Set();

/** 234-1 — Multi-Select tap state (only while body.pf-multiselect is set by shell.js):
 *  { pointerId, token } for a claimed single-finger tap on an owned token. */
let multiTap = null;

/* ============================================================= */
/*  DOM / coordinate helpers                                     */
/* ============================================================= */

/** The #board canvas element (stable after canvas init). */
function boardEl() {
  try { return document.getElementById("board"); } catch (err) { return null; }
}

/** Is the Board the active shell surface? Reuses shell.js's own board-mode state as
 *  reflected on <body> (shell.js:669 toggles body.pf-board); no duplicated flag. */
function boardActive() {
  try { return document.body?.classList.contains("pf-board") === true; }
  catch (err) { return false; }
}

/** 234-1 — Is Multi-Select mode on? Reads shell.js's own toggle state as reflected on
 *  <body> (body.pf-multiselect, set by PocketShell#toggleMultiSelect); no duplicated
 *  flag, and the same class probes assert. */
function multiSelectActive() {
  try { return document.body?.classList.contains("pf-multiselect") === true; }
  catch (err) { return false; }
}

/**
 * 234-1 — Maintain the --pf-canvas-scale CSS custom property = canvas.stage.scale.x so
 * pf-core.css can counter-scale the canvas-anchored Token HUD tap targets to a constant
 * PHYSICAL size (the HUD lives in #hud, which core scales to the zoom —
 * container.mjs:98 transform:scale(canvas.stage.scale.x)). Cosmetic-only; failures are
 * swallowed. pf-mobile + generation-14 gated by its callers (initCanvasTouch).
 * @param {number} [scale]  The new canvas scale; falls back to a safe 1.
 */
function setCanvasScaleVar(scale) {
  try {
    const s = Number(scale);
    document.documentElement.style.setProperty(
      "--pf-canvas-scale", String((Number.isFinite(s) && (s > 0)) ? s : 1));
  } catch (err) { /* non-fatal: only affects HUD tap-target sizing */ }
}

/**
 * Map client (CSS) coordinates to PIXI global/screen coordinates, replicating
 * PIXI's EventSystem.mapPositionToPoint (EventSystem.mjs:196) exactly so our
 * hit-tests and camera math live in the same space PIXI's own pointer events do.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{x:number, y:number}}
 */
function eventGlobal(clientX, clientY) {
  const el = boardEl();
  const rect = el.getBoundingClientRect();
  const res = canvas.app?.renderer?.events?.resolution
    ?? canvas.app?.renderer?.resolution ?? 1;
  return {
    x: (clientX - rect.left) * (el.width / rect.width) / res,
    y: (clientY - rect.top) * (el.height / rect.height) / res
  };
}

/**
 * Invert the PIXI root-stage transform (screen = (world - pivot) * scale + position)
 * to recover the world point under a global/screen point. Read-only reads of
 * canvas.stage.{position,scale,pivot}; no PIXI method calls, no mutation.
 * @param {{x:number, y:number}} g  A PIXI global point.
 * @returns {{x:number, y:number}}  The world point.
 */
function globalToWorld(g) {
  const s = canvas.stage;
  const scale = s.scale.x || 1;
  return {
    x: (g.x - s.position.x) / scale + s.pivot.x,
    y: (g.y - s.position.y) / scale + s.pivot.y
  };
}

/** Global point for a tracked pointer. */
function pointerGlobal(id) {
  const p = pointers.get(id);
  return eventGlobal(p.x, p.y);
}

/* ============================================================= */
/*  Placeable hit-testing (leave placeables to core)            */
/* ============================================================= */

/**
 * Does a finger at these client coords land on an interactive placeable? PRIMARY:
 * the PIXI 7.4.3 event-boundary hit-test. Accessor verified against the installed
 * build — board.mjs:1364 sets
 *   canvas.app.renderer.events.rootBoundary = new PIXI.EventBoundary(this.stage)
 * and EventBoundary#hitTest(x, y) exists (@pixi/events 7.4.3, EventBoundary.mjs:63),
 * returning the topmost interactive DisplayObject at a global point (or null).
 * FALLBACK (also OR'd in): a world-space bounds scan over tokens. OR-ing biases the
 * decision toward LEAVING an interaction to core — we never want to steal a token
 * gesture — at the acceptable cost of not panning when a finger is exactly over a
 * token (rare on empty map viewing).
 * @param {number} clientX
 * @param {number} clientY
 * @returns {boolean}
 */
function pointOnPlaceable(clientX, clientY) {
  const g = eventGlobal(clientX, clientY);
  try {
    const boundary = canvas.app?.renderer?.events?.rootBoundary;
    if (boundary && (typeof boundary.hitTest === "function")) {
      if (resolvesToPlaceable(boundary.hitTest(g.x, g.y))) return true;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | canvas-touch: PIXI hitTest failed; using the bounds-scan fallback.`, err);
  }
  return tokenBoundsHit(globalToWorld(g));
}

/**
 * Walk a hit DisplayObject's ancestor chain: a PlaceableObject carries BOTH a
 * `.document` and a `.can(user, action)` permission method (placeable-object.mjs:966)
 * that layers and plain PIXI containers do not. Reaching canvas.stage first (or a
 * null hit) means the finger is on empty canvas.
 * @param {object|null} hit
 * @returns {boolean}
 */
function resolvesToPlaceable(hit) {
  let node = hit;
  const root = canvas.stage;
  let depth = 0;
  while (node && (node !== root) && (depth++ < 50)) {
    if (node.document && (typeof node.can === "function")) return true;
    node = node.parent;
  }
  return false;
}

/**
 * World-space bounds scan over tokens (token.bounds is a world-coord PIXI.Rectangle,
 * token.mjs:419). Used as the documented fallback when the PIXI hit-test is
 * unavailable, and OR'd with it for safety. A scan failure defaults to "not on a
 * placeable" so panning still works.
 * @param {{x:number, y:number}} world
 * @returns {boolean}
 */
function tokenBoundsHit(world) {
  try {
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t?.visible === false) continue;
      const b = t.bounds;
      if (b && (world.x >= b.x) && (world.x <= (b.x + b.width))
        && (world.y >= b.y) && (world.y <= (b.y + b.height))) return true;
    }
  } catch (err) { /* scan failure → treat as empty canvas (allow pan) */ }
  return false;
}

/* ============================================================= */
/*  234-1 — token-under-finger resolution (owned tokens only)    */
/* ============================================================= */

/**
 * Walk a hit DisplayObject's ancestor chain to the Token PlaceableObject that owns it
 * (its `.document.documentName === "Token"` and it exposes `.control`). Returns null on
 * empty canvas or a non-Token placeable.
 * @param {object|null} hit
 * @returns {object|null}  The Token placeable, or null.
 */
function tokenFromHit(hit) {
  let node = hit;
  const root = canvas.stage;
  let depth = 0;
  while (node && (node !== root) && (depth++ < 50)) {
    if ((node.document?.documentName === "Token") && (typeof node.control === "function")) return node;
    node = node.parent;
  }
  return null;
}

/**
 * The Token under these client coords that this user OWNS/controls (Token#isOwner —
 * true for a player's own tokens and for a GM on every token), or null. PRIMARY: the
 * PIXI event-boundary hit-test (same accessor as pointOnPlaceable). FALLBACK: a
 * world-space token bounds scan. Ownership is what gates BOTH the long-press HUD
 * (token.control requires ownership) and Multi-Select (owned/controllable only), so a
 * non-owned token yields null and neither behavior fires on it.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {object|null}
 */
function ownedTokenUnderPoint(clientX, clientY) {
  const g = eventGlobal(clientX, clientY);
  try {
    const boundary = canvas.app?.renderer?.events?.rootBoundary;
    if (boundary && (typeof boundary.hitTest === "function")) {
      const tok = tokenFromHit(boundary.hitTest(g.x, g.y));
      if (tok) return (tok.isOwner === true) ? tok : null;
    }
  } catch (err) { /* fall through to the world-space bounds scan */ }
  const world = globalToWorld(g);
  try {
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t?.visible === false) continue;
      const b = t.bounds;
      if (b && (world.x >= b.x) && (world.x <= (b.x + b.width))
        && (world.y >= b.y) && (world.y <= (b.y + b.height))) {
        return (t.isOwner === true) ? t : null;
      }
    }
  } catch (err) { /* none found */ }
  return null;
}

/* ============================================================= */
/*  234-1 — long-press → open Token HUD                          */
/* ============================================================= */

/**
 * Arm a ~500ms long-press timer for an owned token under a resting finger. On fire it
 * controls the token and binds its HUD (both client-local — no world write), then
 * aborts core's in-flight click on that pointer so core's own pointerup clickLeft —
 * which calls layer.hud.close() (placeable-object.mjs:1203) — cannot close the HUD.
 * Does NOT claim the pointerdown, so core's tap-select / drag stay untouched unless the
 * hold actually fires.
 * @param {number} pointerId
 * @param {object} token
 * @param {number} sx  Start client X (for the move-cancel check).
 * @param {number} sy  Start client Y.
 */
function armLongPress(pointerId, token, sx, sy) {
  cancelLongPress();
  const timer = setTimeout(() => {
    const lp = longPress;
    longPress = null;
    if (!lp) return;
    try {
      lp.token.control({ releaseOthers: true });
      canvas.hud?.token?.bind(lp.token);
      cancelCorePointer(lp.pointerId);
      longPressFired.add(lp.pointerId);
    } catch (err) {
      console.warn(`${MODULE_ID} | canvas-touch: long-press HUD open failed.`, err);
    }
  }, LONG_PRESS_MS);
  longPress = { pointerId, token, sx, sy, timer };
}

/** Cancel a pending (not-yet-fired) long-press timer. */
function cancelLongPress() {
  if (!longPress) return;
  try { clearTimeout(longPress.timer); } catch (err) { /* ignore */ }
  longPress = null;
}

/* ============================================================= */
/*  Camera driver (canvas.pan ONLY — core clamps)               */
/* ============================================================= */

/**
 * Pan (and optionally zoom) so that `anchorWorld` sits under the global point `g` at
 * the given `scale`. Derived from the inverse root-stage transform: to place world
 * point W under screen point G at scale s with stage.position fixed at screen-centre
 * (canvas.pan keeps it there, board.mjs pan), the pivot must be
 *   pivot = W - (G - position) / s.
 * canvas.pan then clamps pivot + scale via _constrainView (board.mjs:1758).
 * @param {{x:number, y:number}} anchorWorld
 * @param {{x:number, y:number}} g
 * @param {number} scale
 */
function panTo(anchorWorld, g, scale) {
  try {
    const pos = canvas.stage.position;
    canvas.pan({
      x: anchorWorld.x - (g.x - pos.x) / scale,
      y: anchorWorld.y - (g.y - pos.y) / scale,
      scale
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | canvas-touch: canvas.pan failed; ending the gesture.`, err);
    resetGesture();
  }
}

/* ============================================================= */
/*  Claim helpers                                                */
/* ============================================================= */

/** Hide an event from PIXI (capture-phase) and suppress its browser default. */
function claim(ev) {
  ev.stopPropagation();
  if (ev.cancelable) ev.preventDefault();
}

/**
 * Abort a core interaction on `pointerId` by dispatching a synthetic pointercancel to
 * #board so PIXI/MouseInteractionManager tears it down (a half-started token drag
 * snaps back to its origin — no drop, no document write). Synthetic events report
 * isTrusted === false, so our own capture handlers ignore them (they early-return)
 * and let them reach PIXI.
 * @param {number} pointerId
 */
function cancelCorePointer(pointerId) {
  const el = boardEl();
  if (!el) return;
  try {
    el.dispatchEvent(new PointerEvent("pointercancel", {
      pointerId, bubbles: true, cancelable: true, pointerType: "touch"
    }));
  } catch (err) {
    console.warn(`${MODULE_ID} | canvas-touch: could not synthesize a pointercancel to abort the core interaction.`, err);
  }
}

/* ============================================================= */
/*  Pinch seeding + update                                       */
/* ============================================================= */

/** Seed the pinch anchors from the two lowest-id live pointers. */
function seedPinch() {
  const ids = [...pointers.keys()].slice(0, 2);
  const gA = pointerGlobal(ids[0]);
  const gB = pointerGlobal(ids[1]);
  const dist0 = Math.hypot(gB.x - gA.x, gB.y - gA.y);
  const mid0 = { x: (gA.x + gB.x) / 2, y: (gA.y + gB.y) / 2 };
  pinch = {
    idA: ids[0],
    idB: ids[1],
    dist0: Math.max(dist0, PINCH_MIN_START_DIST),
    scale0: canvas.stage.scale.x || 1,
    midWorld0: globalToWorld(mid0)
  };
}

/** Apply the current two-finger transform: scale about, and pan to keep, the world
 *  point that was under the starting midpoint. */
function updatePinch() {
  if (!pinch) return;
  const pa = pointers.get(pinch.idA);
  const pb = pointers.get(pinch.idB);
  if (!pa || !pb) return;
  const gA = eventGlobal(pa.x, pa.y);
  const gB = eventGlobal(pb.x, pb.y);
  const dist1 = Math.hypot(gB.x - gA.x, gB.y - gA.y);
  const mid1 = { x: (gA.x + gB.x) / 2, y: (gA.y + gB.y) / 2 };
  const scale = pinch.scale0 * (dist1 / pinch.dist0);
  panTo(pinch.midWorld0, mid1, scale);
}

/** Apply the current one-finger pan for the given pointer. */
function updatePan(id) {
  const p = pointers.get(id);
  if (!p || !panAnchorWorld) return;
  panTo(panAnchorWorld, eventGlobal(p.x, p.y), panScale);
}

/* ============================================================= */
/*  Pointer event handlers (capture phase on #board's parent)   */
/* ============================================================= */

function onPointerDown(ev) {
  if (!ev.isTrusted) return;               // let our own synthetic cancels reach PIXI
  if (!boardActive()) return;              // gestures only on the Board surface
  const el = boardEl();
  if (!el || (ev.target !== el)) return;   // only #board-targeted pointers (excludes .pf-* shell UI + windows)

  pointers.set(ev.pointerId, {
    x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY,
    onPlaceable: pointOnPlaceable(ev.clientX, ev.clientY)
  });

  // Second (or later) finger → two-finger pan+pinch. Always wins.
  if (pointers.size >= 2) {
    cancelLongPress();                     // a 2nd finger cancels a pending long-press
    multiTap = null;                       // …and any in-flight multi-select tap
    claim(ev);                             // capture-phase: PIXI never sees this pointer
    for (const [id, p] of pointers) {      // abort any in-flight core drag on the first finger
      if ((id !== ev.pointerId) && p.onPlaceable) cancelCorePointer(id);
    }
    seedPinch();
    mode = MODE.PINCH;
    return;
  }

  // Single finger.
  if (pointers.get(ev.pointerId).onPlaceable) {
    // On a placeable: core still owns tap-select / drag (we never stopPropagation here).
    // Two additive, pf-mobile + generation-14-gated behaviors apply only to a token the
    // user OWNS (ownedTokenUnderPoint); a non-owned placeable is left ENTIRELY to core.
    const tok = ownedTokenUnderPoint(ev.clientX, ev.clientY);
    if (tok && multiSelectActive()) {
      // 234-1 Multi-Select: claim the tap so core does NOT single-select (release the
      // pool); we accumulate the selection on pointerup (client-local, no world write).
      claim(ev);
      multiTap = { pointerId: ev.pointerId, token: tok };
    } else if (tok) {
      // 234-1 long-press: arm the HUD timer WITHOUT claiming — core's tap-select / drag
      // run untouched; the timer fires only on a still ~500ms hold.
      armLongPress(ev.pointerId, tok, ev.clientX, ev.clientY);
    }
    mode = MODE.NONE;
    return;
  }
  // On empty canvas: wait for PAN_START_PX travel before claiming, so a tap still
  // reaches core (tap on empty canvas deselects) and no selection band starts.
  mode = MODE.PENDING;
}

function onPointerMove(ev) {
  if (!ev.isTrusted) return;
  const rec = pointers.get(ev.pointerId);
  if (!rec) return;
  rec.x = ev.clientX;
  rec.y = ev.clientY;

  // 234-1: a pending long-press cancels as soon as the finger travels beyond the slop.
  if (longPress && (longPress.pointerId === ev.pointerId)
    && (Math.hypot(ev.clientX - longPress.sx, ev.clientY - longPress.sy) > LONG_PRESS_MOVE_PX)) {
    cancelLongPress();
  }

  // 234-1: keep a claimed Multi-Select tap pointer fully hidden from PIXI (no core drag).
  if (multiTap && (multiTap.pointerId === ev.pointerId)) {
    claim(ev);
    return;
  }

  // If board mode was exited mid-gesture, drop everything cleanly.
  if (((mode === MODE.PAN) || (mode === MODE.PINCH)) && !boardActive()) {
    resetGesture();
    return;
  }

  if (mode === MODE.PINCH) {
    claim(ev);
    updatePinch();
    return;
  }
  if (mode === MODE.PAN) {
    claim(ev);
    updatePan(ev.pointerId);
    return;
  }
  if (mode === MODE.PENDING) {
    const moved = Math.hypot(ev.clientX - rec.sx, ev.clientY - rec.sy);
    if (moved >= PAN_START_PX) {
      // Claim the one-finger empty-canvas pan. Cancel any nascent core interaction on
      // this pointer (no selection band), anchor the world point under the finger, pan.
      claim(ev);
      cancelCorePointer(ev.pointerId);
      const g = eventGlobal(ev.clientX, ev.clientY);
      panScale = canvas.stage.scale.x || 1;
      panAnchorWorld = globalToWorld(g);
      mode = MODE.PAN;
      updatePan(ev.pointerId);
    }
    // Below threshold: leave the move to core (still a tap candidate).
  }
}

function endPointer(ev) {
  if (!ev.isTrusted) return;

  // 234-1: a long-press that already opened the HUD — swallow its up/cancel so core's
  // clickLeft (layer.hud.close(), placeable-object.mjs:1203) never fires to close it.
  if (longPressFired.has(ev.pointerId)) {
    claim(ev);
    longPressFired.delete(ev.pointerId);
  }
  // A pending (not-yet-fired) long-press is cancelled when the finger lifts.
  if (longPress && (longPress.pointerId === ev.pointerId)) cancelLongPress();

  // 234-1 Multi-Select tap completion: control the token WITHOUT releasing the pool
  // (client-local; no world write). A pointercancel or an over-slop drag is not a tap.
  if (multiTap && (multiTap.pointerId === ev.pointerId)) {
    claim(ev);
    const mrec = pointers.get(ev.pointerId);
    const moved = mrec ? Math.hypot(ev.clientX - mrec.sx, ev.clientY - mrec.sy) : Infinity;
    const tok = multiTap.token;
    multiTap = null;
    pointers.delete(ev.pointerId);
    if ((ev.type !== "pointercancel") && (moved <= MULTI_TAP_MOVE_PX)) {
      try { tok.control({ releaseOthers: false }); }
      catch (err) { console.warn(`${MODULE_ID} | canvas-touch: multi-select control failed.`, err); }
    }
    reconcileMode();
    return;
  }

  if (!pointers.has(ev.pointerId)) return;
  // Swallow the up/cancel of a pointer we claimed so core gets no stray terminator.
  if ((mode === MODE.PAN) || (mode === MODE.PINCH)) claim(ev);
  pointers.delete(ev.pointerId);
  reconcileMode();
}

/** Re-derive the gesture mode after a pointer lifts, handing off between pinch and
 *  pan without a visible jump. */
function reconcileMode() {
  if (pointers.size === 0) { resetGesture(); return; }

  if (mode === MODE.PINCH) {
    if (pointers.size >= 2) {
      seedPinch();                         // re-seed onto the two remaining pointers
    } else {
      // Down to one finger: continue as a 1:1 pan, re-anchored under it (no jump).
      const id = [...pointers.keys()][0];
      panScale = canvas.stage.scale.x || 1;
      panAnchorWorld = globalToWorld(pointerGlobal(id));
      pinch = null;
      mode = MODE.PAN;
    }
    return;
  }

  if (mode === MODE.PAN) {
    // A finger lifted while another is still tracked: re-anchor pan to it (no jump).
    const id = [...pointers.keys()][0];
    panAnchorWorld = globalToWorld(pointerGlobal(id));
    return;
  }
  // NONE / PENDING with pointers left: nothing was claimed; leave them to core.
}

/** Reset all gesture state. Called on last-finger-up, board-mode exit mid-gesture,
 *  visibilitychange and pan failure — never leaves a stuck pan. */
function resetGesture() {
  mode = MODE.NONE;
  pointers.clear();
  pinch = null;
  panAnchorWorld = null;
  panScale = 1;
  cancelLongPress();          // 234-1: never leave a long-press timer running
  longPressFired.clear();
  multiTap = null;
}

/** Reset on any tab visibility change (background/foreground) so a gesture can never
 *  survive across a hidden tab as a stuck pan. */
function onVisibility() {
  resetGesture();
}

/* ============================================================= */
/*  Texture-cache hygiene (public static; NEVER expireCache)     */
/* ============================================================= */

function applyMobileCacheTTL() {
  try {
    const TL = globalThis.foundry?.canvas?.TextureLoader ?? globalThis.TextureLoader;
    if (TL && (typeof TL.CACHE_TTL === "number")) {
      TL.CACHE_TTL = MOBILE_CACHE_TTL_MS;
    } else {
      console.warn(`${MODULE_ID} | canvas-touch: TextureLoader.CACHE_TTL not found (core API drift?); mobile cache TTL not applied.`);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | canvas-touch: could not set TextureLoader.CACHE_TTL.`, err);
  }
}

/* ============================================================= */
/*  Install / init                                               */
/* ============================================================= */

function install() {
  if (installed) return;
  const el = boardEl();
  const parent = el?.parentElement;
  if (!parent) {
    console.warn(`${MODULE_ID} | canvas-touch: #board has no parent element yet; gesture layer not installed.`);
    return;
  }
  boundParent = parent;
  const opts = { capture: true, passive: false };   // passive:false so preventDefault works
  parent.addEventListener("pointerdown", onPointerDown, opts);
  parent.addEventListener("pointermove", onPointerMove, opts);
  parent.addEventListener("pointerup", endPointer, opts);
  parent.addEventListener("pointercancel", endPointer, opts);
  document.addEventListener("visibilitychange", onVisibility);
  installed = true;
  console.log(`${MODULE_ID} | canvas-touch: gesture layer active (two-finger pan+pinch, one-finger empty-canvas pan).`);
}

/**
 * Entry point (called from main.js during init, under pf-mobile only). Loud no-op on
 * a non-v14 generation; shortens the mobile texture-cache TTL; exposes a read-only
 * diagnostic surface for probes; binds the capture-phase listeners on canvasReady.
 */
export function initCanvasTouch() {
  if (!document.body?.classList.contains("pf-mobile")) return;

  const gen = game.release?.generation;
  if (gen !== 14) {
    console.warn(`${MODULE_ID} | canvas-touch: Foundry generation ${gen} !== 14; the touch gesture layer is DISABLED (verify the DOM-pointer + canvas.pan contract before enabling for a new core).`);
    return;
  }

  applyMobileCacheTTL();

  // 234-1: maintain --pf-canvas-scale = canvas.stage.scale.x so pf-core.css can hold the
  // canvas-anchored Token HUD tap targets at a constant physical size across zoom
  // (they live in #hud, which core scales to the zoom — container.mjs:98). canvasPan
  // fires with {x,y,scale} on every pan/zoom (board.mjs:1774); also set on canvasReady
  // and once now (init runs before the first canvasReady; stage may be absent → falls
  // back to 1). pf-mobile + generation-14 only (this whole function early-returned
  // otherwise), so zero desktop impact.
  setCanvasScaleVar(canvas?.stage?.scale?.x);
  Hooks.on("canvasPan", (_c, view) => setCanvasScaleVar(view?.scale ?? canvas?.stage?.scale?.x));
  Hooks.on("canvasReady", () => setCanvasScaleVar(canvas?.stage?.scale?.x));

  // Read-only diagnostics for probes (no writable state exposed).
  try {
    const mod = game.modules.get(MODULE_ID);
    if (mod?.api) {
      mod.api.canvasGesture = {
        installed: () => installed,
        mode: () => mode,
        // 234-1 read-only diagnostics for probes (no writable state exposed).
        multiSelect: () => multiSelectActive(),
        longPressArmed: () => !!longPress,
        multiTapArmed: () => !!multiTap,
        canvasScale: () => document.documentElement.style.getPropertyValue("--pf-canvas-scale"),
        PAN_START_PX,
        PINCH_MIN_START_DIST,
        LONG_PRESS_MS,
        LONG_PRESS_MOVE_PX,
        MULTI_TAP_MOVE_PX,
        MOBILE_CACHE_TTL_MS
      };
    }
  } catch (err) { /* diagnostics are optional */ }

  if (canvas?.ready) install();
  else Hooks.once("canvasReady", install);
}
