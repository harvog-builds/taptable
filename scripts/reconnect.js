/**
 * taptable — reconnect resilience (subtask 232-1).
 *
 * Problem (verified in core client/game.mjs, this install):
 *  - Game.connect() builds the socket with reconnectionAttempts:10 /
 *    reconnectionDelay:500 / reconnectionDelayMax:500 (game.mjs:481-484) — a ~5s total
 *    reconnect budget.
 *  - On budget exhaustion the socket.io Manager emits `reconnect_failed` and core does
 *    `window.location.href = getRoute("no")` (game.mjs:524-527): the critical-failure
 *    page, which strands the player at a re-login dead-end.
 *  - On mobile, switching apps suspends the tab. The websocket drops and the ~5s budget
 *    is consumed (or its attempt timers stall) while the tab is backgrounded, so the
 *    player returns to the critical screen instead of their game.
 *
 * This layer is active under body.pf-mobile ONLY (desktop early-returns; no listeners
 * are installed — zero desktop impact by construction):
 *
 *  (a) It raises the socket.io RUNTIME reconnection budget. game.socket.io is the
 *      bundled socket.io-client 4.8.3 Manager; reconnectionAttempts(n) /
 *      reconnectionDelay(ms) / reconnectionDelayMax(ms) are its runtime getter/setters
 *      (node_modules/socket.io-client/build/cjs/manager.js:81-110). The reconnect loop
 *      reads `_reconnectionAttempts` live on every cycle (manager.js:365) and
 *      reconnectionDelayMax(v) calls backoff.setMax (manager.js:107), so raising these
 *      after the socket exists takes effect for the current session — the Manager keeps
 *      retrying long past core's ~5s and never reaches getRoute("no") in the drop window.
 *
 *  (b) It installs a visibilitychange (+ online) handler: when the tab becomes visible
 *      again (or the browser fires `online`) with game.socket disconnected, it forces
 *      game.socket.connect(); if the socket is still down after a short grace window it
 *      performs ONE session-preserving location.reload() (NOT getRoute("no")). The
 *      reload re-runs Game.connect(), which re-establishes the socket against the still
 *      valid session cookie and lands the player back in /game. The reload is guarded
 *      against loops by a sessionStorage timestamp (at most one self-reload per
 *      RELOAD_WINDOW_MS); if sessionStorage is unavailable it fails closed (no reload).
 *
 * This module NEVER navigates to getRoute("no") itself. Its worst case is a single
 * clean reload; its best case is a silent socket reconnect with no user-visible break.
 */

const MODULE_ID = "taptable";

/* -------------------------------------------- */
/*  Tuning constants                            */
/* -------------------------------------------- */

/** Raised reconnect attempt count (core: 10). Bounded (NOT Infinity) so a genuinely
 *  dead server eventually still yields core's reconnect_failed, but large enough that a
 *  backgrounded-tab drop is never given up on within the app-switch window. */
const RECONNECT_ATTEMPTS = 100;

/** Base delay before the first reconnect attempt, ms (matches core's 500). */
const RECONNECT_DELAY_MS = 500;

/** Max delay between reconnect attempts, ms (core: 500). Longer = gentler backoff over
 *  a long outage while still promptly catching a quick blip. */
const RECONNECT_DELAY_MAX_MS = 5000;

/** After a foreground reconnect nudge, wait this long before falling back to a reload
 *  (gives socket.connect() time to complete a handshake), ms. */
const RECONNECT_GRACE_MS = 4000;

/** sessionStorage key holding the epoch-ms of our last self-reload (reload-loop guard). */
const RELOAD_GUARD_KEY = "pf-reconnect-last-reload";

/** At most one self-reload per this window, ms. */
const RELOAD_WINDOW_MS = 30000;

/* -------------------------------------------- */
/*  Module state                                */
/* -------------------------------------------- */

/** Whether listeners are installed (idempotency guard). */
let installed = false;

/** Pending grace-window timer id, or null. */
let graceTimer = null;

/* -------------------------------------------- */
/*  Reconnect budget                            */
/* -------------------------------------------- */

/**
 * Raise the socket.io Manager's runtime reconnection budget past core's 10/500ms.
 * @returns {boolean} true if the budget was raised.
 */
function raiseReconnectBudget() {
  const mgr = game.socket?.io;
  if ( !mgr || (typeof mgr.reconnectionAttempts !== "function") ) {
    console.warn(`${MODULE_ID} | reconnect: socket.io Manager unavailable; reconnect budget unchanged.`);
    return false;
  }
  try {
    mgr.reconnectionAttempts(RECONNECT_ATTEMPTS);
    mgr.reconnectionDelay(RECONNECT_DELAY_MS);
    mgr.reconnectionDelayMax(RECONNECT_DELAY_MAX_MS);
    console.log(`${MODULE_ID} | reconnect: raised socket.io budget to ${RECONNECT_ATTEMPTS} attempts / `
      + `delayMax ${RECONNECT_DELAY_MAX_MS}ms (core: 10 / 500ms).`);
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | reconnect: failed to raise reconnect budget.`, err);
    return false;
  }
}

/* -------------------------------------------- */
/*  Reload-loop guard                           */
/* -------------------------------------------- */

/**
 * Whether a self-reload is permitted right now. Records the reload time on success.
 * Fails closed (returns false) if sessionStorage is unavailable — better to sit than
 * to risk a reload loop.
 * @returns {boolean}
 */
function reloadGuardOk() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
    const now = Date.now();
    if ( (now - last) < RELOAD_WINDOW_MS ) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | reconnect: sessionStorage unavailable; suppressing reload fallback.`, err);
    return false;
  }
}

/* -------------------------------------------- */
/*  Recovery                                    */
/* -------------------------------------------- */

/**
 * Schedule the one-shot reload fallback if, after the grace window, the socket is still
 * down AND the tab is visible AND the loop guard allows it. Only one grace timer runs.
 */
function scheduleReloadFallback() {
  if ( graceTimer !== null ) return;
  graceTimer = window.setTimeout(() => {
    graceTimer = null;
    if ( game.socket?.connected ) return;                      // reconnected in the grace window
    if ( document.visibilityState !== "visible" ) return;      // never reload a backgrounded tab
    if ( !reloadGuardOk() ) {
      console.warn(`${MODULE_ID} | reconnect: reload suppressed by loop guard (<${RELOAD_WINDOW_MS}ms since last).`);
      return;
    }
    console.warn(`${MODULE_ID} | reconnect: socket still down after ${RECONNECT_GRACE_MS}ms grace — `
      + `one session-preserving reload.`);
    location.reload();
  }, RECONNECT_GRACE_MS);
}

/**
 * Try to recover a dropped socket: force a connect() and arm the reload fallback.
 * No-op if the socket is absent or already connected.
 * @param {string} reason  Human-readable trigger, for the log.
 */
function attemptRecovery(reason) {
  const socket = game.socket;
  if ( !socket ) return;
  if ( socket.connected ) return;
  console.log(`${MODULE_ID} | reconnect: ${reason} with socket down — forcing connect().`);
  try {
    socket.connect();
  } catch(err) {
    console.warn(`${MODULE_ID} | reconnect: socket.connect() threw.`, err);
  }
  scheduleReloadFallback();
}

/* -------------------------------------------- */
/*  Listeners                                   */
/* -------------------------------------------- */

function onVisibilityChange() {
  if ( document.visibilityState === "visible" ) attemptRecovery("tab became visible");
}

function onOnline() {
  attemptRecovery("browser went online");
}

/* -------------------------------------------- */
/*  Entry point                                 */
/* -------------------------------------------- */

/**
 * Entry point (called from main.js during init, under pf-mobile only). Loud no-op on
 * any client without body.pf-mobile: desktop installs NO listeners and does not touch
 * the reconnect budget.
 */
export function initReconnect() {
  if ( !document.body?.classList.contains("pf-mobile") ) return;
  if ( installed ) return;
  installed = true;

  raiseReconnectBudget();
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onOnline);

  console.log(`${MODULE_ID} | reconnect: resilience layer active (pf-mobile).`);
}
