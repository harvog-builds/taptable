/**
 * taptable — PocketShell bottom-nav coordinator (M2).
 *
 * The shell is a COORDINATOR, not a container: a frameless ApplicationV2
 * (window.frame:false, positioned:false) whose element is a full-viewport
 * pointer-events:none overlay carrying only (a) a fixed bottom navigation bar and
 * (b) optional lightweight shell-owned panes (Home, Settings). Tabs open REAL
 * applications — the dnd5e character sheet, the chat popout, the combat popout —
 * and the shell marks each app it opened with a `pf-max` class; styles/pf-core.css
 * renders pf-max windows effectively fullscreen above the nav. Windows NOT opened
 * through the shell (e.g. DialogV2 confirms) never receive pf-max.
 *
 * Activation contract (matches M1 exactly): initShell() early-returns without
 * body.pf-mobile, so on desktop clients no hook is registered, no setting is read,
 * and nothing renders. registerTab() is the one deliberate exception: it only
 * mutates a module-local registry so other modules can register tabs from any
 * client (soft contract — no manifest dependency either direction); without
 * pf-mobile the registry is simply never rendered.
 *
 * Feature-detection doctrine: every reach into core/dnd5e internals is guarded and
 * warns + no-ops on drift. Notables recorded for future readers:
 *  - User#updateTokenTargets was removed in core v14 (only the internal
 *    _onUpdateTokenTargets remains, client/documents/user.mjs:257). The canonical
 *    v14 targeting path is canvas.tokens.setTargets(ids, {mode}) (canvas/layers/
 *    tokens.mjs:335). We try the legacy method first, then the v14 layer path.
 *  - The core v14 combat tracker has NO target control (templates/sidebar/tabs/
 *    combat/tracker.hbs carries a literal "TODO: Target Control"), so the shell
 *    augments the combat POPOUT with per-combatant target toggles, an End Turn
 *    strip, and an empty state, re-applied on every renderCombatTracker.
 *  - dnd5e 5.3.3 favorites live at actor.system.favorites as {type, id, sort}
 *    with relative-UUID ids resolved against the actor (dnd5e.mjs:58440-58450);
 *    item/activity favorites activate via their .use() method.
 *  - Board tab (M2.1): body.pf-board hides shell-opened pf-max windows via CSS
 *    (display:none) WITHOUT closing them, so the canvas underneath is visible and
 *    touch-interactive; any other tab exits board mode and its app re-opens with
 *    state intact. Lite mode (core.noCanvas) gets an informative pane instead.
 *  - GM token placement (M2.1) uses the standard v14 path: the prototype token via
 *    Actor#getTokenDocument (client/documents/actor.mjs:342), centered+snapped on
 *    the view center with the same helper core's actor-drop uses
 *    (Token._getDropActorPosition, canvas/placeables/token.mjs:2709; guarded with a
 *    naive-centering fallback), then Scene#createEmbeddedDocuments("Token", ...) —
 *    the permission-checked document CRUD path. View center = canvas.stage.pivot,
 *    which core persists into scene._viewPosition on pan (canvas/board.mjs:1771).
 *  - Pause controls (M2.2): the v14 pause API is Game#togglePause(paused,
 *    {broadcast: true}) — client/game.mjs:1733, exactly what core's space-bar
 *    keybinding calls (client-keybindings.mjs:955); broadcast is GM-gated
 *    (game.mjs:1744). State reads from game.paused (game.mjs:1704). Every change,
 *    local toggle or server socket push (game.mjs:2114), ends in ui.pause.render()
 *    + Hooks.callAll("pauseGame") (game.mjs:1782-1783), which the shell listens to.
 *    Core's own #pause banner is body-appended (applications/api/application.mjs:
 *    936-938) but sits at z-index canvas+1 (public/css/foundry2.css:8227-8241),
 *    UNDER fullscreen pf-max windows — hence the shell's own top strip, which shows
 *    the state to everyone while paused; only GMs are rendered the toggle.
 *    body.pf-paused shifts pf-max windows below the strip so window headers stay
 *    reachable while paused.
 *  - Scene switching (M2.2) is strictly client-local: Scene#view
 *    (client/documents/scene.mjs:258) redraws this client's canvas and writes no
 *    documents. Viewed markers read Scene#isView (scene.mjs:176); the world's
 *    active scene is game.scenes.active (documents/collections/scenes.mjs:29).
 *    Only GMs get the scene browser; players get a single "back to active scene"
 *    affordance when their viewed scene differs from the active one.
 *  - registerTab v2 (M2.2): optional `section` field — "nav" (default) renders a
 *    bottom-nav tab exactly like M2; "modules" renders a >=44px row (icon + label
 *    + optional hint) in the Mods menu pane. Registrations without a section keep
 *    M2 behavior unchanged (backward compatible); late registrations re-render
 *    whichever surface they target via the same shell.render() path.
 *  - Quick Roll (M3.1): the "roller" tab opens a shell-owned pane built by
 *    scripts/roller.js (imported here — shell.js is the only consumer; main.js
 *    stays the single manifest esmodule and its import list is unchanged).
 *    roller.js owns the pane markup and the dnd5e 5.3.3 roll handlers; the
 *    dist-verified API facts live in its header comment.
 */

import { buildRollerPane } from "./roller.js";
// 231-2: the sheet-mode nav's "+ Add" control opens the Compendium Add picker
// (scripts/compendium.js, 231-1). Imported directly, mirroring the roller.js
// import above — shell.js is the sole consumer and main.js stays the single
// manifest esmodule (its import list is unchanged). openCompendiumPicker
// early-returns without body.pf-mobile, so importing it here is desktop-safe.
import { openCompendiumPicker } from "./compendium.js";
// System-specific integration (sheet detection, Home vitals/favorites, HP writes,
// initiative) is resolved through the adapter registry so shell.js stays
// system-agnostic: on dnd5e resolveAdapter() returns the dnd5e adapter, otherwise
// the NullAdapter (safe no-ops / empty results → the relevant blocks self-hide).
import { resolveAdapter } from "./adapter-registry.js";

const MODULE_ID = "taptable";
const CONSENT_SETTING = "perfProfileConsent";

/** Localize a TAPTABLE.* key. Defined at module scope but only ever CALLED at
 *  render time or inside user-tap handlers — both long after the i18nInit hook,
 *  when game.i18n has its translations. Never call at module scope. */
const t = key => game.i18n.localize(key);

/** Format a TAPTABLE.* key with interpolation data (same timing contract as t()). */
const tf = (key, data) => game.i18n.format(key, data);

/** Max actor rows the GM Home pane renders at once (search narrows; keeps the DOM
 *  small and the pane snappy with 100+ world actors). */
const GM_LIST_RENDER_CAP = 30;

/** Valid registerTab surfaces (v2): bottom nav (default) or the Mods menu pane. */
const TAB_SECTIONS = ["nav", "modules"];

/* -------------------------------------------- */
/*  Module-level state                          */
/* -------------------------------------------- */

/** @type {Map<string, {id:string, icon:string, label:string, order:number, section:string, hint?:string, open:Function, visible?:Function}>} */
const tabRegistry = new Map();

/** Application ids the shell has maximized (pf-max re-applied on every render). */
const maxedApps = new Set();

/** Shell-maximized dnd5e actor sheets in maximization order (last = topmost).
 *  Drives the sheet-mode bottom nav (M3): while the topmost open window is one of
 *  these, the nav morphs into that sheet's tab list + Close. */
const sheetStack = [];

/** @type {Map<string, object>} Sheet app id -> live application instance (kept
 *  fresh on every render because AppV2 can rebuild its element). */
const sheetApps = new Map();

/** The singleton shell instance; null on desktop clients and before ready. */
let shell = null;

/** Debounced full page reload used after Lite-mode / free-memory confirmations. */
const pfReload = foundry.utils.debounce(() => window.location.reload(), 250);

/* -------------------------------------------- */
/*  Public API helpers (exported via main.js)   */
/* -------------------------------------------- */

/**
 * Current usable viewport height in px, from the --pf-vh custom property that
 * viewport.js maintains (only px values are trusted — the no-visualViewport
 * fallback pins --pf-vh to a unit string like "100dvh", which parseFloat would
 * misread as 100).
 * @returns {number}
 */
export function currentVh() {
  try {
    const raw = document.documentElement.style.getPropertyValue("--pf-vh").trim();
    if ( raw.endsWith("px") ) {
      const px = parseFloat(raw);
      if ( Number.isFinite(px) ) return px;
    }
  } catch(err) { /* fall through to the live viewport */ }
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * Register (or replace) a shell tab (v2). Safe to call from other modules at any
 * time, including after init: registrations arriving while the shell is rendered
 * re-render whichever surface they target (a full shell render rebuilds both the
 * nav and any open pane, the Mods pane included). visible() predicates are
 * evaluated per user at render time.
 * @param {object} tab
 * @param {string} tab.id          Unique tab id.
 * @param {string} [tab.section]   Surface: "nav" (default — a bottom-nav tab,
 *                                 exactly the M2 behavior) or "modules" (a row in
 *                                 the Mods menu pane). Unknown values warn and
 *                                 fall back to "nav".
 * @param {string} [tab.icon]      Font Awesome icon classes.
 * @param {string} [tab.label]     Short label under the icon. May be a plain string
 *                                 OR an i18n key — it is passed through
 *                                 game.i18n.localize at render time (an unknown
 *                                 string passes through unchanged).
 * @param {string} [tab.hint]      Optional one-line description (rendered under
 *                                 the label on Mods rows; ignored for nav tabs).
 *                                 Localized at render time like label.
 * @param {number} [tab.order]     Sort order (ascending; built-ins use 10-50).
 * @param {Function} tab.open      Called on tap. May return an Application (or a
 *                                 Promise of one) to have the shell maximize it.
 * @param {Function} [tab.visible] Predicate; falsy/throwing hides the tab.
 * @returns {boolean}              True if the registration was accepted.
 */
export function registerTab(tab = {}) {
  if ( (typeof tab.id !== "string") || !tab.id.length || (typeof tab.open !== "function") ) {
    console.warn(`${MODULE_ID} | shell: registerTab requires a string id and an open() function; registration rejected.`, tab);
    return false;
  }
  let section = "nav";
  if ( tab.section !== undefined ) {
    if ( TAB_SECTIONS.includes(tab.section) ) section = tab.section;
    else console.warn(`${MODULE_ID} | shell: registerTab: unknown section "${tab.section}" for tab "${tab.id}"; using "nav".`, tab);
  }
  tabRegistry.set(tab.id, {
    id: tab.id,
    section,
    icon: (typeof tab.icon === "string") && tab.icon.length ? tab.icon : "fa-solid fa-puzzle-piece",
    label: (typeof tab.label === "string") && tab.label.length ? tab.label : tab.id,
    hint: (typeof tab.hint === "string") && tab.hint.length ? tab.hint : undefined,
    order: Number.isFinite(tab.order) ? tab.order : 100,
    open: tab.open,
    visible: (typeof tab.visible === "function") ? tab.visible : undefined
  });
  if ( shell?.rendered ) shell.render();
  return true;
}

/* -------------------------------------------- */
/*  DOM helper                                  */
/* -------------------------------------------- */

/**
 * Tiny element builder. User-supplied strings (actor/combatant/favorite names) are
 * only ever assigned through textContent — no innerHTML on dynamic data.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {Array<Node|string|false|null|undefined>} [children]
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for ( const [k, v] of Object.entries(attrs) ) {
    if ( (v === undefined) || (v === null) || (v === false) ) continue;
    if ( k === "class" ) el.className = v;
    else if ( k === "text" ) el.textContent = v;
    else if ( k === "dataset" ) Object.assign(el.dataset, v);
    else if ( v === true ) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for ( const c of children ) {
    if ( (c === undefined) || (c === null) || (c === false) ) continue;
    el.append(c);
  }
  return el;
}

/* -------------------------------------------- */
/*  pf-max window management                    */
/* -------------------------------------------- */

/**
 * The application's root HTMLElement (AppV2 exposes it directly; V1 wraps in jQuery).
 * @param {object} app
 * @returns {HTMLElement|undefined}
 */
function elementOf(app) {
  return (app?.element instanceof HTMLElement) ? app.element : app?.element?.[0];
}

/**
 * The topmost still-open shell-maximized dnd5e actor sheet, or null. Walks the
 * maximization-order stack from the top, skipping anything closed or no longer
 * maximized (stale entries are dropped defensively by the close hook).
 * @returns {object|null}
 */
function topSheet() {
  for ( let i = sheetStack.length - 1; i >= 0; i-- ) {
    const app = sheetApps.get(sheetStack[i]);
    if ( app?.rendered && maxedApps.has(sheetStack[i]) ) return app;
  }
  return null;
}

/**
 * The actor a "+ Add" control may add compendium items to for this sheet, or null.
 * Non-null only when the sheet's actor is one the user OWNS and the sheet is not in
 * a non-editable (observer / locked) mode — exactly the precondition
 * openCompendiumPicker enforces, checked here so the control (231-2) is rendered
 * only when it would actually work. app.document is the DocumentSheetV2 actor;
 * app.actor is dnd5e's alias — either is accepted. app.isEditable is AppV2's
 * editability getter (feature-detected: only a strict === false hides the control).
 * @param {object} app  A tracked dnd5e actor sheet (topSheet()).
 * @returns {Actor|null}
 */
function addableSheetActor(app) {
  try {
    const actor = app?.document ?? app?.actor;
    if ( !actor?.isOwner ) return null;      // "OWN sheet" requirement
    if ( app?.isEditable === false ) return null;  // observer / locked sheet: no adds
    return actor;
  } catch(err) {
    return null;
  }
}

/**
 * Track a maximized dnd5e actor sheet for sheet-mode nav. Re-pushing an already
 * tracked sheet moves it back to the top (it was re-opened / brought to front).
 * @param {object} app
 * @param {string} id
 */
function trackSheet(app, id) {
  const i = sheetStack.indexOf(id);
  if ( i >= 0 ) sheetStack.splice(i, 1);
  sheetStack.push(id);
  sheetApps.set(id, app);
  if ( shell?.rendered ) shell.render();
}

/** Re-sync the sheet-mode nav when a tracked sheet re-renders: dnd5e sheets
 *  re-render on every data change, and AppV2 may rebuild the element — the nav's
 *  tab list and active marker must follow. Registered on renderActorSheetV2 (the
 *  standard render hook for these sheets — core emits class-chain hook names,
 *  application.mjs #callHooks; the V1 "renderActorSheet" name never fires for
 *  dnd5e 5.x AppV2 sheets). */
function onTrackedSheetRender(app) {
  if ( !app?.id || !sheetApps.has(app.id) ) return;
  sheetApps.set(app.id, app);
  if ( shell?.rendered && (topSheet() === app) ) shell.render();
}

/** Drop a closed sheet from the stack (closeActorSheetV2): the nav falls back to
 *  the next stacked maximized sheet, or to the regular tabs when none remain. */
function onTrackedSheetClose(app) {
  const i = sheetStack.indexOf(app?.id ?? "");
  if ( i < 0 ) return;
  sheetStack.splice(i, 1);
  sheetApps.delete(app.id);
  if ( shell?.rendered ) shell.render();
}

/**
 * Mark an application the shell opened as maximized. The pf-max class is applied
 * now and re-applied on every subsequent render (AppV2 may rebuild the element)
 * by the renderApplicationV2 hook registered in initShell().
 * @param {object} app  An ApplicationV2 (or V1) instance.
 */
function maximizeApp(app) {
  if ( !app ) return;
  const el = (app.element instanceof HTMLElement) ? app.element : app.element?.[0];
  const id = app.id ?? el?.id;
  if ( !id ) {
    console.warn(`${MODULE_ID} | shell: cannot maximize an application without an id.`, app);
    return;
  }
  maxedApps.add(id);
  el?.classList.add("pf-max");
  try { app.bringToFront?.(); } catch(err) { /* stacking is cosmetic; ignore */ }
  // Only a system actor sheet (dnd5e adapter: instanceof ActorSheetV2 + .dnd5e2) is
  // tracked for the sheet-mode nav, whose rail mirrors that system's tab markup.
  if ( resolveAdapter().isSystemSheet(app) ) trackSheet(app, id);
}

/** Re-apply pf-max after any re-render of a shell-opened app. */
function onAnyAppRender(app) {
  if ( !maxedApps.has(app?.id) ) return;
  const el = (app.element instanceof HTMLElement) ? app.element : app.element?.[0];
  el?.classList.add("pf-max");
}

/** Forget closed apps so a later non-shell open starts unmaximized. */
function onAnyAppClose(app) {
  if ( app?.id ) maxedApps.delete(app.id);
}

/* -------------------------------------------- */
/*  Targeting (v14 API drift handled)           */
/* -------------------------------------------- */

/**
 * Is the given token currently targeted by this user?
 * @param {string} tokenId
 * @returns {boolean}
 */
function isTokenTargeted(tokenId) {
  try {
    for ( const t of (game.user?.targets ?? []) ) {
      if ( t.id === tokenId ) return true;
    }
  } catch(err) { /* no canvas / no targets */ }
  return false;
}

/**
 * Replace this user's target set. Tries the plan-named User#updateTokenTargets
 * first (removed in core v14; kept for other builds), then the v14 canonical
 * canvas.tokens.setTargets. Warns + no-ops when neither is available (Lite mode
 * has no canvas, hence no token objects to target).
 * @param {string[]} ids  New target token ids ([] clears).
 */
function setUserTargets(ids) {
  const u = game.user;
  try {
    if ( typeof u?.updateTokenTargets === "function" ) return u.updateTokenTargets(ids);
    if ( canvas?.tokens?.setTargets ) return canvas.tokens.setTargets(ids, { mode: "replace" });
  } catch(err) {
    console.warn(`${MODULE_ID} | shell: targeting failed.`, err);
    return;
  }
  console.warn(`${MODULE_ID} | shell: no targeting API available (Lite mode without a canvas, or core API drift); target toggle is a no-op.`);
}

/**
 * 234-1 — Is the token-layer Target tool currently active? Reads the v14 SceneControls
 * getters (ui.controls.control / ui.controls.tool — each a named object,
 * scene-controls.mjs:169,189). Fail-closed: any drift / missing canvas returns false.
 * @returns {boolean}
 */
function isTargetToolActive() {
  try {
    return (ui.controls?.control?.name === "tokens") && (ui.controls?.tool?.name === "target");
  } catch(err) {
    return false;
  }
}

/* -------------------------------------------- */
/*  GM token placement (v14 standard path)      */
/* -------------------------------------------- */

/** Re-entrancy guard: a second tap while a placement is in flight is ignored. */
let placementInFlight = false;

/**
 * Is there a live canvas to place tokens on? False in Lite mode (core.noCanvas —
 * canvas never initializes) and when no scene is being viewed.
 * @returns {boolean}
 */
function canvasIsLive() {
  try { return !!(canvas?.ready && canvas.scene); } catch(err) { return false; }
}

/**
 * GM-only: create the actor's prototype token at the current view center of the
 * viewed scene. Standard v14 path end to end: Actor#getTokenDocument
 * (client/documents/actor.mjs:342) -> center+snap on canvas.stage.pivot (persisted
 * by core into scene._viewPosition on pan, canvas/board.mjs:1771) via
 * Token._getDropActorPosition (canvas/placeables/token.mjs:2709, the same helper
 * core's actor-drop uses; naive-centering fallback on drift) ->
 * Scene#createEmbeddedDocuments("Token", ...) which enforces document permissions
 * server-side. No permission bypass anywhere.
 * @param {Actor} actor
 */
async function placeActorAtViewCenter(actor) {
  if ( !game.user?.isGM ) return;                          // defense in depth; UI never shows this to non-GM
  if ( !canvasIsLive() ) {
    ui.notifications?.warn(t("TAPTABLE.WarnNoCanvasPlace"));
    return;
  }
  if ( placementInFlight ) return;
  placementInFlight = true;
  try {
    // View center in world coordinates (pivot first, persisted view position as fallback).
    const center = {
      x: canvas.stage?.pivot?.x ?? canvas.scene._viewPosition?.x,
      y: canvas.stage?.pivot?.y ?? canvas.scene._viewPosition?.y
    };
    if ( !Number.isFinite(center.x) || !Number.isFinite(center.y) ) {
      console.warn(`${MODULE_ID} | shell: could not determine the view center (core API drift?).`);
      ui.notifications?.warn(t("TAPTABLE.WarnNoViewCenter"));
      return;
    }
    const token = await actor.getTokenDocument({}, { parent: canvas.scene });

    // Center + snap exactly like core's actor-drop; fall back to naive centering.
    let position;
    try {
      const Cls = CONFIG.Token?.objectClass;
      if ( typeof Cls?._getDropActorPosition === "function" ) {
        position = Cls._getDropActorPosition(token, center, { snap: true });
      }
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: _getDropActorPosition failed (core API drift?); using naive centering.`, err);
    }
    if ( !position ) {
      let pivot = { x: 0, y: 0 };
      try {
        pivot = token.getCenterPoint({ x: 0, y: 0, elevation: 0,
          width: token.width, height: token.height, shape: token.shape });
      } catch(err) { /* keep {0,0}: place by top-left */ }
      position = { x: Math.round(center.x - pivot.x), y: Math.round(center.y - pivot.y) };
    }
    token.updateSource(position);
    const created = await canvas.scene.createEmbeddedDocuments("Token", [token.toObject()]);
    if ( created?.length ) ui.notifications?.info(tf("TAPTABLE.InfoPlacedActor", { name: actor.name }));
  } catch(err) {
    console.warn(`${MODULE_ID} | shell: token placement failed.`, err);
    ui.notifications?.warn(tf("TAPTABLE.WarnPlaceFailed", { name: actor.name }));
  } finally {
    placementInFlight = false;
  }
}

/* -------------------------------------------- */
/*  Combat popout augmentation                  */
/* -------------------------------------------- */

/**
 * Augment the combat POPOUT (only — the docked sidebar is hidden under pf-mobile)
 * with: an empty state when no combat is active, a per-combatant Target toggle,
 * and an End Turn strip enabled only when the viewing user owns the current
 * combatant. Runs on every renderCombatTracker, so core's own re-render on
 * updateCombat/deleteCombat (client/documents/combat.mjs:524,674 ->
 * sidebar-tab.mjs:114-115) re-applies it; guards make it idempotent.
 * @param {object} app  The CombatTracker application being rendered.
 */
function augmentCombatPopout(app) {
  if ( !document.body?.classList.contains("pf-mobile") ) return;
  if ( !app?.isPopout ) return;
  const el = (app.element instanceof HTMLElement) ? app.element : app.element?.[0];
  if ( !el ) return;
  const combat = game.combat ?? null;

  // Empty state when there is no active combat (or it has no combatants yet).
  const tracker = el.querySelector("ol.combat-tracker");
  if ( tracker && !combat?.turns?.length && !tracker.querySelector(".pf-combat-empty") ) {
    tracker.append(h("li", { class: "pf-combat-empty", text: combat
      ? t("TAPTABLE.CombatEmptyNoCombatants")
      : t("TAPTABLE.CombatEmptyNoCombat") }));
  }

  // Per-combatant Target toggle (core v14 tracker has none — tracker.hbs TODO).
  for ( const li of el.querySelectorAll("li.combatant[data-combatant-id]") ) {
    const controls = li.querySelector(".combatant-controls");
    if ( !controls || controls.querySelector(".pf-target") ) continue;
    const combatant = combat?.combatants.get(li.dataset.combatantId);
    const tokenId = combatant?.tokenId;
    if ( !tokenId ) continue;
    const btn = h("button", {
      type: "button",
      class: "inline-control combatant-control icon fa-solid fa-crosshairs pf-target",
      "aria-label": t("TAPTABLE.Target"),
      dataset: { tokenId }
    });
    btn.classList.toggle("active", isTokenTargeted(tokenId));
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      setUserTargets(isTokenTargeted(tokenId) ? [] : [tokenId]);
    });
    controls.prepend(btn);
  }

  // End Turn strip: enabled only when the viewing user owns the current combatant.
  if ( !el.querySelector(".pf-combat-strip") ) {
    const owns = !!combat?.combatant?.isOwner;
    const endBtn = h("button", {
      type: "button",
      class: "pf-end-turn",
      disabled: !owns,
      text: t("TAPTABLE.EndTurn")
    });
    endBtn.addEventListener("click", () => {
      if ( !game.combat?.combatant?.isOwner ) return;
      game.combat.nextTurn().catch(err => console.warn(`${MODULE_ID} | shell: nextTurn failed.`, err));
    });
    const content = el.querySelector(".window-content") ?? el;
    content.append(h("div", { class: "pf-combat-strip" }, [endBtn]));
  }
}

/** Cheap in-place refresh of target toggle states when this user's targets change. */
function refreshTargetToggles(user, token, targeted) {
  if ( user !== game.user ) return;
  const pop = ui.combat?.popout;
  if ( !pop?.rendered ) return;
  const el = (pop.element instanceof HTMLElement) ? pop.element : pop.element?.[0];
  for ( const btn of el?.querySelectorAll("button.pf-target") ?? [] ) {
    if ( btn.dataset.tokenId === token.id ) btn.classList.toggle("active", targeted);
  }
}

/* -------------------------------------------- */
/*  Performance profile & Lite mode             */
/* -------------------------------------------- */

/**
 * Apply the client-scoped battery-saver graphics profile. Registration facts:
 * core.performanceMode (game.mjs:1366), core.maxFPS (:1385), core.mipmap (:1455),
 * core.pixelRatioResolutionScaling (:1347) — all client scope.
 */
async function applyPerfProfile() {
  const LOW = CONST?.CANVAS_PERFORMANCE_MODES?.LOW ?? 0;
  const values = { performanceMode: LOW, maxFPS: 30, mipmap: true, pixelRatioResolutionScaling: false };
  for ( const [key, value] of Object.entries(values) ) {
    try {
      await game.settings.set("core", key, value);
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not set core.${key} (core API drift?).`, err);
    }
  }
}

/**
 * Escape a dynamic string for safe interpolation into DialogV2 HTML content.
 * Scene names are user-controlled, so the Scene Activate confirm (231-2) must not
 * inject them raw. Mirrors compendium.js's helper.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Confirmation dialog helper (DialogV2 windows are NOT shell-opened, so they never
 * receive pf-max — by design).
 * @param {string} title
 * @param {string} html
 * @returns {Promise<boolean>}
 */
async function pfConfirm(title, html) {
  try {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title },
      content: html,
      rejectClose: false,
      modal: true
    });
    return ok === true;
  } catch(err) {
    console.warn(`${MODULE_ID} | shell: confirmation dialog failed; treating as cancelled.`, err);
    return false;
  }
}

/* -------------------------------------------- */
/*  The shell application                       */
/* -------------------------------------------- */

class PocketShell extends foundry.applications.api.ApplicationV2 {

  static DEFAULT_OPTIONS = {
    id: "pf-shell",
    tag: "div",
    classes: ["pf-shell"],
    window: { frame: false, positioned: false },
    actions: {
      pfTab: PocketShell.#onTab,
      pfHpDelta: PocketShell.#onHpDelta,
      pfFavorite: PocketShell.#onFavorite,
      pfGmOpenActor: PocketShell.#onGmOpenActor,
      pfGmPlace: PocketShell.#onGmPlace,
      pfPerfProfile: PocketShell.#onPerfProfile,
      pfFreeMemory: PocketShell.#onFreeMemory,
      pfPauseToggle: PocketShell.#onPauseToggle,
      pfScenes: PocketShell.#onScenes,
      pfSceneView: PocketShell.#onSceneView,
      pfSceneActivate: PocketShell.#onSceneActivate,
      pfBackToActive: PocketShell.#onBackToActive,
      pfSheetTab: PocketShell.#onSheetNavTab,
      pfSheetClose: PocketShell.#onSheetNavClose,
      pfSheetAdd: PocketShell.#onSheetAdd,
      pfOpenSettings: PocketShell.#onOpenSettings,
      pfOpenMenu: PocketShell.#onOpenMenu,
      pfTokenHud: PocketShell.#onTokenHud,
      pfTargetMode: PocketShell.#onTargetMode,
      pfMultiSelect: PocketShell.#onMultiSelect,
      pfCombatantFocus: PocketShell.#onCombatantFocus,
      pfCarouselEndTurn: PocketShell.#onCarouselEndTurn,
      pfCarouselRollInit: PocketShell.#onCarouselRollInit,
      pfMacroExec: PocketShell.#onMacroExec,
      pfMacroPage: PocketShell.#onMacroPage
    }
  };

  /** Currently open shell-owned pane:
   *  null | "home" | "settings" | "board" | "mods" | "scenes" | "roller" | "macros". */
  #pane = null;

  /** 236-2 — Macros drawer: the currently shown hotbar page (1-5). null until the
   *  drawer first renders, when it lazy-inits to the first page that holds macros;
   *  survives shell re-renders (the shell is a singleton). */
  #macroPage = null;

  /** Board mode: pf-max windows CSS-hidden so the canvas shows through. */
  #boardActive = false;

  /** Current GM Home search query (survives shell re-renders). */
  #gmSearch = "";

  /** 234-1 — Multi-Select mode: while on, canvas-touch.js accumulates token selection
   *  (a tap controls with releaseOthers:false) instead of single-selecting. Mirrored
   *  onto body.pf-multiselect (the flag canvas-touch reads and probes assert). Survives
   *  shell re-renders (the shell is a singleton). */
  #multiSelect = false;

  /* ------------------------------------------ */

  /** @override */
  async _renderHTML(_context, _options) {
    const frag = document.createDocumentFragment();
    // Top strip: on the Board surface (board mode, or the board/scenes panes) for
    // everyone, and for ALL users whenever the game is paused — core's own #pause
    // banner sits under fullscreen pf-max windows (z-index canvas+1), so the strip
    // is the phone's always-visible pause state. It must precede the pane in the
    // DOM (the .pf-strip ~ .pf-pane CSS offset relies on sibling order).
    const boardish = this.#boardActive || (this.#pane === "board") || (this.#pane === "scenes");
    let paused = false;
    try { paused = !!game.paused; } catch(err) { /* pre-ready render; treat as unpaused */ }
    if ( boardish || paused ) frag.append(this.#buildStrip(paused));
    if ( this.#pane === "home" ) frag.append(this.#buildHomePane());
    else if ( this.#pane === "settings" ) frag.append(this.#buildSettingsPane());
    else if ( this.#pane === "board" ) frag.append(this.#buildBoardPane());
    else if ( this.#pane === "mods" ) frag.append(this.#buildModsPane());
    else if ( this.#pane === "macros" ) frag.append(this.#buildMacrosPane());
    else if ( this.#pane === "scenes" ) frag.append(this.#buildScenesPane());
    else if ( this.#pane === "roller" ) frag.append(buildRollerPane(this));
    // 236-1: combatant carousel — a Board overlay of the active combat's turn order
    // (turn-highlighted, defeated-dimmed, tap-to-focus, roll-initiative + owner-gated
    // End Turn). Only on the real canvas Board (#boardActive), and only with an active
    // combat; #buildCombatCarousel returns null otherwise, so it is hidden with no combat.
    if ( this.#boardActive ) {
      const carousel = this.#buildCombatCarousel();
      if ( carousel ) frag.append(carousel);
    }
    frag.append(this.#buildNav());
    return frag;
  }

  /** @override */
  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelector('select[data-pf="mode"]')
      ?.addEventListener("change", this.#onModeChange.bind(this));
    this.element.querySelector('input[data-pf="lite"]')
      ?.addEventListener("change", this.#onLiteChange.bind(this));
  }

  /* ------------------------------------------ */

  /** Toggle a shell-owned pane (tapping its tab again closes it). */
  togglePane(id) {
    this.#pane = (this.#pane === id) ? null : id;
    this.render();
  }

  /* ------------------------------------------ */
  /*  Board mode                                */
  /* ------------------------------------------ */

  /**
   * Toggle board mode: hide (not close) every shell-opened pf-max window so the
   * canvas is visible and touch-interactive. Without a live canvas (Lite mode or
   * no viewed scene) an informative pane opens instead of a dead black board.
   */
  toggleBoard() {
    if ( !canvasIsLive() ) {
      this.#setBoardActive(false);
      this.togglePane("board");
      return;
    }
    this.#pane = null;
    this.#setBoardActive(!this.#boardActive);
  }

  /**
   * Enter/exit board mode. The actual hiding is pure CSS: body.pf-board +
   * .application.pf-max -> display:none (pf-core.css), so window state survives
   * and other tabs re-open their apps exactly as before.
   * @param {boolean} active
   */
  #setBoardActive(active) {
    const changed = this.#boardActive !== active;
    this.#boardActive = active;
    try { document.body.classList.toggle("pf-board", active); } catch(err) { /* no body?! nothing to hide */ }
    if ( changed ) this.render();
  }

  /** Informative Board pane for clients without a live canvas. */
  #buildBoardPane() {
    const pane = h("section", { class: "pf-pane", dataset: { pane: "board" } });
    pane.append(h("h2", { class: "pf-pane-title", text: t("TAPTABLE.TabBoard") }));
    let lite = false;
    try { lite = !!game.settings.get("core", "noCanvas"); } catch(err) { /* treat as not Lite */ }
    pane.append(h("p", { class: "pf-empty", text: lite
      ? t("TAPTABLE.BoardLiteMode")
      : t("TAPTABLE.BoardNoScene") }));
    return pane;
  }

  /* ------------------------------------------ */
  /*  234-1 — Multi-Select mode toggle          */
  /* ------------------------------------------ */

  /**
   * Toggle Multi-Select mode and mirror it onto body.pf-multiselect (the flag
   * canvas-touch.js reads and probes assert). Client-local: it changes NO documents —
   * only how the next canvas tap treats selection. Turning it off reverts to single-
   * select (the next normal tap releases others); the current selection is left intact.
   */
  toggleMultiSelect() {
    this.#multiSelect = !this.#multiSelect;
    try { document.body.classList.toggle("pf-multiselect", this.#multiSelect); }
    catch(err) { /* no body?! nothing to mirror */ }
    this.render();
  }

  /* ------------------------------------------ */
  /*  234-1 — Board strip combat controls       */
  /* ------------------------------------------ */

  /**
   * Build the Board-strip combat control group (Features A2 + B): open the selected
   * token's HUD, toggle Target mode, toggle Multi-Select. Rendered for ALL users on the
   * Board surface with a live canvas (the HUD is owner-only in effect; Target mode is
   * the primary player enemy-targeting path). Each button reuses .pf-strip-btn (>=44px);
   * the .active background is the toggle indicator for Target and Multi-Select.
   * @returns {HTMLElement}
   */
  #buildCombatControls() {
    const group = h("div", { class: "pf-strip-combat" });

    // Token HUD (status effects + per-token target) for the controlled token.
    group.append(h("button", {
      type: "button",
      class: "pf-strip-btn pf-hud-btn",
      "data-action": "pfTokenHud",
      "aria-label": t("TAPTABLE.TokenHudLabel")
    }, [h("i", { class: "fa-solid fa-bolt", inert: true })]));

    // Target mode toggle (ON activates the token-layer target tool).
    const targetOn = isTargetToolActive();
    group.append(h("button", {
      type: "button",
      class: `pf-strip-btn pf-target-toggle${targetOn ? " active" : ""}`,
      "data-action": "pfTargetMode",
      "aria-pressed": targetOn ? "true" : "false",
      "aria-label": targetOn ? t("TAPTABLE.TargetModeOn") : t("TAPTABLE.TargetModeOff")
    }, [h("i", { class: "fa-solid fa-crosshairs", inert: true })]));

    // Multi-Select toggle (ON accumulates selection via canvas-touch.js).
    const multiOn = this.#multiSelect;
    group.append(h("button", {
      type: "button",
      class: `pf-strip-btn pf-multi-toggle${multiOn ? " active" : ""}`,
      "data-action": "pfMultiSelect",
      "aria-pressed": multiOn ? "true" : "false",
      "aria-label": multiOn ? t("TAPTABLE.MultiSelectOn") : t("TAPTABLE.MultiSelectOff")
    }, [h("i", { class: "fa-solid fa-object-group", inert: true })]));

    return group;
  }

  /* ------------------------------------------ */
  /*  Top strip: pause state + scene controls   */
  /* ------------------------------------------ */

  /**
   * Build the top strip. Rendered on the Board surface and whenever the game is
   * paused (see _renderHTML). Contents by role:
   *  - GM: pause TOGGLE (game.togglePause(!game.paused, {broadcast:true}) —
   *    game.mjs:1733, the same call as core's space-bar keybinding,
   *    client-keybindings.mjs:955) + a Scenes button opening the scene browser.
   *  - Everyone else: a read-only pause state chip (never a toggle) and, only when
   *    their viewed scene differs from the active one, a single "back to active
   *    scene" button (Scene#view — client-local).
   * @param {boolean} paused  Current game.paused state (read once by the caller).
   */
  #buildStrip(paused) {
    const isGM = !!game.user?.isGM;
    const strip = h("div", { class: "pf-strip" });
    if ( isGM ) {
      strip.append(h("button", {
        type: "button",
        class: `pf-strip-btn pf-pause-toggle${paused ? " paused" : ""}`,
        "data-action": "pfPauseToggle",
        "aria-label": paused ? t("TAPTABLE.ResumeGame") : t("TAPTABLE.PauseGame"),
        "aria-pressed": paused ? "true" : "false"
      }, [
        h("i", { class: paused ? "fa-solid fa-play" : "fa-solid fa-pause", inert: true }),
        h("span", { text: paused ? t("TAPTABLE.PausedTapToResume") : t("TAPTABLE.Pause") })
      ]));
    } else {
      strip.append(h("span", { class: `pf-pause-state${paused ? " paused" : ""}`, role: "status" }, [
        h("i", { class: paused ? "fa-solid fa-pause" : "fa-solid fa-play", inert: true }),
        h("span", { text: paused ? t("TAPTABLE.GamePaused") : t("TAPTABLE.GameRunning") })
      ]));
    }
    // 234-1: canvas combat controls (Board surface, live canvas only) — open the
    // selected token's HUD, toggle Target mode, toggle Multi-Select. Shown for all
    // users (HUD is owner-only in effect; Target mode is the player enemy-targeting path).
    if ( canvasIsLive() ) strip.append(this.#buildCombatControls());
    strip.append(h("span", { class: "pf-strip-spacer" }));
    if ( isGM ) {
      strip.append(h("button", {
        type: "button",
        class: `pf-strip-btn${this.#pane === "scenes" ? " active" : ""}`,
        "data-action": "pfScenes",
        "aria-label": t("TAPTABLE.SwitchSceneView")
      }, [
        h("i", { class: "fa-solid fa-map-location-dot", inert: true }),
        h("span", { text: t("TAPTABLE.Scenes") })
      ]));
    } else {
      // Player affordance: ONLY a way back to the active scene, and only when
      // they are somewhere else. Never a scene browser.
      let offActive = false;
      try {
        offActive = canvasIsLive() && !!game.scenes?.active && (canvas.scene.id !== game.scenes.active.id);
      } catch(err) { /* no canvas/scenes: nothing to offer */ }
      if ( offActive ) {
        strip.append(h("button", {
          type: "button",
          class: "pf-strip-btn",
          "data-action": "pfBackToActive",
          "aria-label": t("TAPTABLE.BackToActiveSceneLabel")
        }, [
          h("i", { class: "fa-solid fa-rotate-left", inert: true }),
          h("span", { text: t("TAPTABLE.BackToActiveScene") })
        ]));
      }
    }
    return strip;
  }

  /** GM-only: toggle + broadcast the pause state via the core v14 API. No manual
   *  re-render here — the pauseGame hook (game.mjs:1783) re-renders the shell. */
  static #onPauseToggle() {
    if ( !game.user?.isGM ) return;   // defense in depth; the toggle is never rendered for non-GMs
    try {
      game.togglePause(!game.paused, { broadcast: true });
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: game.togglePause failed (core API drift?).`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnPauseToggle"));
    }
  }

  /** GM-only: open/close the scene browser pane. */
  static #onScenes() {
    if ( !game.user?.isGM ) return;
    this.togglePane("scenes");
  }

  /** GM-only: view the tapped scene on THIS client (Scene#view is client-local —
   *  scene.mjs:258; it moves no players and writes no documents). */
  static #onSceneView(_event, target) {
    if ( !game.user?.isGM ) return;
    const scene = game.scenes?.get(target.dataset.sceneId);
    if ( !scene ) {
      ui.notifications?.warn(t("TAPTABLE.WarnSceneGone"));
      return;
    }
    this.#pane = null;
    this.render();
    scene.view().catch(err => console.warn(`${MODULE_ID} | shell: Scene#view failed.`, err));
  }

  /** Player affordance: return this client's view to the world's active scene. */
  static #onBackToActive() {
    const active = game.scenes?.active;   // collections/scenes.mjs:29
    if ( !active ) return;
    active.view().catch(err => console.warn(`${MODULE_ID} | shell: Scene#view (back to active) failed.`, err));
  }

  /* ------------------------------------------ */
  /*  234-1 — Board strip combat controls       */
  /* ------------------------------------------ */

  /**
   * Open (or toggle closed) the Token HUD for the currently controlled token — the
   * deterministic, reliable path (Feature A2; no long-press needed). The HUD surfaces
   * BOTH status effects AND a per-token target button (token-hud.hbs). token.control()
   * and canvas.hud.token.bind() are client-local (no world write); toggling an effect
   * or the target INSIDE the HUD is the user's own explicit action. Owner-only in
   * practice — token.control() requires ownership — so a player reaches it for their
   * own tokens (Target mode covers enemy targeting).
   */
  static #onTokenHud() {
    const tok = canvas?.tokens?.controlled?.[0];
    if ( !tok ) {
      ui.notifications?.warn(t("TAPTABLE.WarnSelectTokenFirst"));
      return;
    }
    try {
      const hud = canvas.hud?.token;
      if ( !hud ) {
        ui.notifications?.warn(t("TAPTABLE.WarnHudUnavailable"));
        return;
      }
      if ( hud.rendered && (hud.object === tok) ) hud.close();   // tapping again closes it
      else {
        tok.control({ releaseOthers: true });
        hud.bind(tok);
      }
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: token HUD open failed.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnHudOpenFailed"));
    }
  }

  /**
   * Toggle the token-layer Target tool (Feature B). ON -> a tap targets tokens (core
   * TokenLayer._onClickLeft case "target", tokens.mjs:1014); OFF -> back to select.
   * This is the PRIMARY enemy-targeting workflow for a non-GM player (the HUD's target
   * button only helps for OWNED tokens). ui.controls.activate is client-local; actually
   * targeting a token is a write, but that happens only when the user then taps one —
   * their explicit action, never this toggle. Re-renders to update the active indicator
   * (the tool state is applied synchronously by activate()#preActivate before its
   * awaited render, scene-controls.mjs:231).
   */
  static async #onTargetMode() {
    try {
      const on = isTargetToolActive();
      await ui.controls?.activate({ control: "tokens", tool: on ? "select" : "target" });
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not toggle target mode.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnTargetModeFailed"));
    }
    if ( shell?.rendered ) shell.render();
  }

  /**
   * Toggle Multi-Select mode (Feature B; client-local). The tap-accumulation itself
   * lives in canvas-touch.js, gated on body.pf-multiselect (set by toggleMultiSelect):
   * with it ON, a tap on an owned/controllable token calls token.control({releaseOthers:
   * false}) instead of single-selecting. OFF returns to single-select. No world write.
   */
  static #onMultiSelect() {
    if ( !shell ) return;
    shell.toggleMultiSelect();
  }

  /* ------------------------------------------ */
  /*  236-1 — Combatant carousel (Board overlay) */
  /* ------------------------------------------ */

  /**
   * Build the combatant carousel for the Board surface (236-1): a horizontal,
   * turn-ordered strip of the active combat's combatants with the current turn
   * highlighted and defeated combatants dimmed, flanked by a roll-initiative control
   * and an owner-gated End Turn control. Returns null when there is no active combat
   * (or it has no combatants yet), so _renderHTML simply omits it — the carousel is
   * hidden with no active combat.
   *
   * API facts (Foundry v14, verified against the installed dist):
   *  - game.combats.active -> the active CombatEncounter (client/documents/collections/
   *    combat-encounters.mjs:54).
   *  - combat.turns -> combatants in initiative order; combat.combatant -> the
   *    current-turn combatant (this.turns[this.turn]; client/documents/combat.mjs:70).
   *  - combatant.img / combatant.name are prepared fields (client/documents/
   *    combatant.mjs:166-167; the core tracker itself reads combatant.img ??
   *    DEFAULT_TOKEN, combat-tracker.mjs:153); .initiative is null until rolled;
   *    .isDefeated is a getter (combatant.mjs:124); .isOwner is Document ownership;
   *    .token -> the TokenDocument (combatant.mjs:103).
   * Every reach into a combatant is guarded so core drift dims/omits one row rather
   * than throwing the whole carousel away.
   * @returns {HTMLElement|null}
   */
  #buildCombatCarousel() {
    let combat = null;
    try { combat = game.combats?.active ?? null; } catch(err) { /* no combats collection */ }
    if ( !combat ) return null;
    let turns = [];
    try { turns = Array.isArray(combat.turns) ? combat.turns : []; } catch(err) { /* core drift */ }
    if ( !turns.length ) return null;   // active combat, no combatants yet — nothing to render

    let current = null;
    try { current = combat.combatant ?? null; } catch(err) { /* core drift */ }

    const carousel = h("div", { class: "pf-combat-carousel", "aria-label": t("TAPTABLE.CombatTurnOrder") });

    // Roll-initiative control (GM: Roll All; player: only when they own an unrolled
    // combatant). Rolling initiative is a WORLD write, so this only WIRES the call.
    const roll = this.#carouselRollControl(combat, turns);
    if ( roll ) carousel.append(roll);

    // Turn-ordered combatant rows: avatar + name + initiative; current-turn outlined,
    // defeated dimmed. Each row is a >=44px tap-to-focus target.
    const track = h("div", { class: "pf-carousel-track", role: "list" });
    for ( const combatant of turns ) {
      if ( !combatant ) continue;
      let id = "", name = t("TAPTABLE.UnknownCombatant"), img = "icons/svg/mystery-man.svg", init = null, defeated = false, isCurrent = false;
      try { id = combatant.id ?? ""; } catch(err) { /* keep "" */ }
      try { name = combatant.name || name; } catch(err) { /* keep default */ }
      try { img = combatant.img || combatant.token?.texture?.src || img; } catch(err) { /* keep default */ }
      try { const v = combatant.initiative; init = ((v === null) || (v === undefined)) ? null : v; } catch(err) { /* null */ }
      try { defeated = !!combatant.isDefeated; } catch(err) { /* false */ }
      try { isCurrent = !!current && (current.id === id); } catch(err) { /* false */ }
      track.append(h("button", {
        type: "button",
        class: `pf-combatant${isCurrent ? " current" : ""}${defeated ? " defeated" : ""}`,
        "data-action": "pfCombatantFocus",
        "aria-label": isCurrent ? tf("TAPTABLE.FocusCombatantCurrent", { name }) : tf("TAPTABLE.FocusCombatant", { name }),
        "aria-current": isCurrent ? "true" : null,
        dataset: { combatantId: id }
      }, [
        h("img", { class: "pf-combatant-img", src: img, alt: "", loading: "lazy" }),
        h("span", { class: "pf-combatant-name", text: name }),
        h("span", { class: "pf-combatant-init", text: (init === null) ? "—" : String(init) })
      ]));
    }
    carousel.append(track);

    // End Turn — enabled ONLY for the owner of the current combatant. nextTurn() is a
    // WORLD write, so the disabled state mirrors the ownership gate the handler enforces.
    let owns = false;
    try { owns = !!current?.isOwner; } catch(err) { /* not owner */ }
    carousel.append(h("button", {
      type: "button",
      class: "pf-carousel-end",
      disabled: !owns,
      "data-action": "pfCarouselEndTurn",
      "aria-label": owns ? t("TAPTABLE.EndTurnLabel") : t("TAPTABLE.EndTurnOwnerOnly")
    }, [
      h("i", { class: "fa-solid fa-forward-step", inert: true }),
      h("span", { text: t("TAPTABLE.EndTurn") })
    ]));

    return carousel;
  }

  /**
   * The carousel's roll-initiative control, or null when there is nothing to roll.
   *  - GM: a "Roll All" button -> game.combats.active.rollAll() (combat.mjs:446 rolls
   *    every owned combatant whose initiative is null).
   *  - Player: shown ONLY when they OWN a combatant that still has null initiative; it
   *    targets that combatant's actor via dnd5e Actor5e#rollInitiativeDialog
   *    (dnd5e.mjs:37842 — the same call dnd5e's own tracker uses, dnd5e.mjs:62281).
   * Rolling initiative is a WORLD write; this method only builds the control.
   * @param {Combat} combat
   * @param {Combatant[]} turns
   * @returns {HTMLElement|null}
   */
  #carouselRollControl(combat, turns) {
    let isGM = false;
    try { isGM = !!game.user?.isGM; } catch(err) { /* treat as player */ }
    if ( isGM ) {
      return h("button", {
        type: "button",
        class: "pf-carousel-roll",
        "data-action": "pfCarouselRollInit",
        "aria-label": t("TAPTABLE.RollAllLabel")
      }, [
        h("i", { class: "fa-solid fa-dice-d20", inert: true }),
        h("span", { text: t("TAPTABLE.RollAll") })
      ]);
    }
    let mine = null;
    try {
      mine = turns.find(c => {
        try { return !!c?.isOwner && ((c.initiative === null) || (c.initiative === undefined)) && !!c.actor; }
        catch(err) { return false; }
      }) ?? null;
    } catch(err) { /* none */ }
    if ( !mine ) return null;
    let label = t("TAPTABLE.YourCombatant"), mineId = "";
    try { label = mine.name || label; } catch(err) { /* keep */ }
    try { mineId = mine.id ?? ""; } catch(err) { /* keep */ }
    return h("button", {
      type: "button",
      class: "pf-carousel-roll",
      "data-action": "pfCarouselRollInit",
      "aria-label": tf("TAPTABLE.RollInitiativeFor", { name: label }),
      dataset: { combatantId: mineId }
    }, [
      h("i", { class: "fa-solid fa-dice-d20", inert: true }),
      h("span", { text: t("TAPTABLE.RollInitiative") })
    ]);
  }

  /**
   * 236-1 — Tap a carousel combatant: pan the canvas to its token and, when the user
   * owns it, select it. Both canvas.animatePan (canvas/board.mjs:1801) and
   * token.control are CLIENT-LOCAL — no world write. No-ops with a friendly notice
   * when the map is off (Lite mode / no viewed scene) or the combatant's token is not
   * on the viewed scene (combatant.token?.object is null there).
   */
  static #onCombatantFocus(_event, target) {
    if ( !canvasIsLive() ) {
      ui.notifications?.warn(t("TAPTABLE.WarnNoCanvasFocus"));
      return;
    }
    const combat = game.combats?.active;
    const combatant = combat?.combatants?.get(target?.dataset?.combatantId);
    if ( !combatant ) {
      ui.notifications?.warn(t("TAPTABLE.WarnCombatantGone"));
      return;
    }
    let token = null;
    try { token = combatant.token?.object ?? null; } catch(err) { /* not on this scene */ }
    if ( !token ) {
      ui.notifications?.warn(t("TAPTABLE.WarnCombatantNotOnScene"));
      return;
    }
    try {
      const center = token.center;                                   // world coords (token.mjs:448)
      if ( token.isOwner ) token.control({ releaseOthers: true });   // client-local select; owner only
      if ( Number.isFinite(center?.x) && Number.isFinite(center?.y) ) {
        canvas.animatePan({ x: center.x, y: center.y });             // client-local pan; no world write
      }
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: focusing a combatant failed.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnFocusFailed"));
    }
  }

  /**
   * 236-1 — End Turn: advance the active combat (Combat#nextTurn, combat.mjs:268).
   * A WORLD write, gated exactly like the rendered disabled state — only the owner of
   * the current combatant (combat.combatant.isOwner) may fire it; the button is
   * disabled for everyone else and this handler re-checks (defense in depth).
   */
  static #onCarouselEndTurn() {
    const combat = game.combats?.active;
    let owns = false;
    try { owns = !!combat?.combatant?.isOwner; } catch(err) { /* not owner */ }
    if ( !owns ) return;
    try {
      Promise.resolve(combat.nextTurn()).catch(err => console.warn(`${MODULE_ID} | shell: nextTurn failed.`, err));
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: nextTurn threw.`, err);
    }
  }

  /**
   * 236-1 — Roll initiative (a WORLD write). GM -> Combat#rollAll (combat.mjs:446,
   * every owned combatant with null initiative). Player -> the owned, unrolled
   * combatant's actor via dnd5e Actor5e#rollInitiativeDialog (dnd5e.mjs:37842), with a
   * core Actor#rollInitiative({createCombatants:true}) fallback on dnd5e drift. Both
   * paths re-check ownership (defense in depth); the control is only rendered for a
   * player who owns an unrolled combatant, or as Roll All for a GM.
   */
  static #onCarouselRollInit(_event, target) {
    const combat = game.combats?.active;
    if ( !combat ) return;
    try {
      if ( game.user?.isGM ) {
        if ( typeof combat.rollAll === "function" ) {
          Promise.resolve(combat.rollAll()).catch(err => console.warn(`${MODULE_ID} | shell: rollAll failed.`, err));
        }
        return;
      }
      const combatant = combat.combatants?.get(target?.dataset?.combatantId);
      if ( !combatant?.isOwner ) return;   // defense in depth; the control is player-owned only
      const actor = combatant.actor;
      if ( !actor ) {
        ui.notifications?.warn(t("TAPTABLE.WarnNoActorInitiative"));
        return;
      }
      // The system adapter rolls initiative (dnd5e: rollInitiativeDialog; NullAdapter
      // falls back to core Actor#rollInitiative({createCombatants:true})).
      Promise.resolve(resolveAdapter().rollInitiative(actor))
        .catch(err => console.warn(`${MODULE_ID} | shell: rollInitiative failed.`, err));
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: roll initiative threw.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnRollInitiativeFailed"));
    }
  }

  /**
   * GM-only: set the world's ACTIVE scene (Scene#activate — a world write that
   * pulls every player to the scene, unlike the client-local Scene#view). Gated
   * three ways: the control is rendered only in the GM-only scenes pane, this
   * handler re-checks game.user.isGM, and the write fires only after an explicit
   * DialogV2 confirm ("Activate <scene> for all players?"). Errors are surfaced
   * via ui.notifications, never thrown. The pre-confirm scene name is escaped
   * before interpolation (scene names are user-controlled).
   */
  static async #onSceneActivate(_event, target) {
    if ( !game.user?.isGM ) return;   // defense in depth; never rendered for non-GM
    const scene = game.scenes?.get(target.dataset.sceneId);
    if ( !scene ) {
      ui.notifications?.warn(t("TAPTABLE.WarnSceneGone"));
      return;
    }
    const ok = await pfConfirm(t("TAPTABLE.ActivateSceneTitle"),
      tf("TAPTABLE.ActivateSceneContent", { name: escapeHtml(scene.name) }));
    if ( !ok ) return;
    try {
      await scene.activate();
      ui.notifications?.info(tf("TAPTABLE.InfoSceneActivated", { name: scene.name }));
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: Scene#activate failed.`, err);
      ui.notifications?.warn(tf("TAPTABLE.WarnSceneActivateFailed", { name: scene.name }));
    }
  }

  /* ------------------------------------------ */
  /*  Scenes pane (GM scene browser)            */
  /* ------------------------------------------ */

  /**
   * GM scene browser: every world scene as a >=44px row with Viewed/Active
   * markers; tapping views the scene on this client only. Sort: active scene
   * first, then navigation scenes, then the rest, alphabetical within each group.
   */
  #buildScenesPane() {
    const pane = h("section", { class: "pf-pane", dataset: { pane: "scenes" } });
    pane.append(h("h2", { class: "pf-pane-title", text: t("TAPTABLE.Scenes") }));
    if ( !game.user?.isGM ) {   // defense in depth; the pane is only reachable from the GM strip
      pane.append(h("p", { class: "pf-empty", text: t("TAPTABLE.ScenesGmOnly") }));
      return pane;
    }
    const entries = [];
    try {
      for ( const s of game.scenes ?? [] ) {
        entries.push({ id: s.id, name: s.navName || s.name || t("TAPTABLE.Unnamed"),
          nav: s.navigation ? 1 : 0, active: s.active ? 1 : 0, viewed: !!s.isView });
      }
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not enumerate world scenes.`, err);
    }
    entries.sort((a, b) => (b.active - a.active) || (b.nav - a.nav) || a.name.localeCompare(b.name));
    pane.append(h("p", { class: "pf-hint", text: t("TAPTABLE.ScenesHint") }));
    const isGM = !!game.user?.isGM;   // pane is GM-only already; belt-and-braces for Activate
    const list = h("div", { class: "pf-scenes" });
    for ( const e of entries ) {
      // The existing client-local view button — behavior and markup unchanged.
      const view = h("button", {
        type: "button",
        class: `pf-scene-row${e.viewed ? " viewed" : ""}`,
        "data-action": "pfSceneView",
        "aria-label": tf("TAPTABLE.ViewScene", { name: e.name }),
        dataset: { sceneId: e.id }
      }, [
        h("span", { class: "pf-scene-name", text: e.name }),
        e.viewed ? h("span", { class: "pf-scene-badge pf-viewed", text: t("TAPTABLE.Viewed") }) : null,
        e.active ? h("span", { class: "pf-scene-badge pf-active", text: t("TAPTABLE.Active") }) : null
      ]);
      const row = h("div", { class: "pf-scene-item" }, [view]);
      // 231-2: GM-only Activate control alongside the view row. Scene#activate is a
      // WORLD write (sets the active scene for everyone), unlike Scene#view's
      // client-local redraw — so it fires only behind a DialogV2 confirm
      // (#onSceneActivate). The scenes pane is already GM-only (early return above);
      // this isGM guard makes the control provably never rendered for a non-GM. The
      // already-active scene's control is disabled (re-activating it is a no-op).
      if ( isGM ) {
        row.append(h("button", {
          type: "button",
          class: "pf-scene-activate",
          "data-action": "pfSceneActivate",
          disabled: !!e.active,
          "aria-label": e.active ? tf("TAPTABLE.SceneAlreadyActive", { name: e.name })
            : tf("TAPTABLE.ActivateSceneFor", { name: e.name }),
          dataset: { sceneId: e.id }
        }, [
          h("i", { class: "fa-solid fa-bullhorn", inert: true }),
          h("span", { class: "pf-scene-activate-label", text: t("TAPTABLE.Activate") })
        ]));
      }
      list.append(row);
    }
    if ( !entries.length ) list.append(h("p", { class: "pf-empty", text: t("TAPTABLE.ScenesEmpty") }));
    pane.append(list);
    return pane;
  }

  /* ------------------------------------------ */
  /*  Mods pane (registered module entries)     */
  /* ------------------------------------------ */

  /**
   * Menu pane for registerTab v2 section:"modules" entries: >=44px rows with icon,
   * label and optional hint. visible() predicates are evaluated per user at render
   * time (same semantics as nav tabs). Rows reuse the pfTab action, so open()
   * results are maximized exactly like nav-tab opens.
   */
  #buildModsPane() {
    const pane = h("section", { class: "pf-pane", dataset: { pane: "mods" } });
    pane.append(h("h2", { class: "pf-pane-title", text: t("TAPTABLE.TabMods") }));
    const entries = [...tabRegistry.values()]
      .filter(t => t.section === "modules")
      .sort((a, b) => a.order - b.order);
    const list = h("div", { class: "pf-mods" });
    for ( const entry of entries ) {
      let visible = true;
      if ( entry.visible ) {
        try { visible = !!entry.visible(); }
        catch(err) {
          visible = false;
          console.warn(`${MODULE_ID} | shell: visible() for module entry "${entry.id}" threw; hiding it.`, err);
        }
      }
      if ( !visible ) continue;
      // Registered labels/hints may be localization keys (the built-ins are) or plain
      // strings from third-party modules — game.i18n.localize passes an unknown string
      // through unchanged, so both work.
      const label = t(entry.label);
      list.append(h("button", {
        type: "button",
        class: "pf-mod-row",
        "data-action": "pfTab",
        "aria-label": label,
        dataset: { tab: entry.id }
      }, [
        h("i", { class: entry.icon, inert: true }),
        h("div", { class: "pf-mod-text" }, [
          h("span", { class: "pf-mod-label", text: label }),
          entry.hint ? h("span", { class: "pf-mod-hint", text: t(entry.hint) }) : null
        ])
      ]));
    }
    if ( !list.childElementCount ) {
      list.append(h("p", { class: "pf-empty", text: t("TAPTABLE.ModsEmpty") }));
    }
    pane.append(list);
    return pane;
  }

  /* ------------------------------------------ */
  /*  236-2 — Macro hotbar drawer (Macros pane) */
  /* ------------------------------------------ */

  /**
   * Macro drawer pane (236-2): the user's hotbar macros as >=44px tap-to-run rows
   * (icon + name + slot number), with page navigation across the hotbar pages when
   * more than one page holds macros, and a graceful empty state when the user has no
   * hotbar macros at all.
   *
   * API facts (Foundry v14, verified against the installed dist):
   *  - game.user.getHotbarMacros(page) -> Array<{slot:number, macro:Macro|null}> for
   *    that page's 10 slots (client/documents/user.mjs:235; macro is null for an
   *    empty slot). The hotbar has 5 pages of 10 (Hotbar docstring + changePage's
   *    1..5 bound, client/applications/ui/hotbar.mjs:10,260), so pages 1-5 cover it.
   *  - macro.img / macro.name are the fields core's own hotbar reads for each slot
   *    (hotbar.mjs:148,150); macro.execute() runs it (client/documents/macro.mjs:81)
   *    — a WORLD write in the general case, so tapping a row is the user's own action;
   *    this method only WIRES it (rows carry data-action="pfMacroExec").
   * Every reach into a macro is guarded so core drift drops one row rather than
   * throwing the whole drawer away. The drawer follows hotbar changes automatically:
   * the hotbar lives on the User document, so add/move/remove fires updateUser, which
   * already re-renders the shell (see initShell).
   * @returns {HTMLElement}
   */
  #buildMacrosPane() {
    const PAGE_COUNT = 5;
    const pane = h("section", { class: "pf-pane", dataset: { pane: "macros" } });
    pane.append(h("h2", { class: "pf-pane-title", text: t("TAPTABLE.TabMacros") }));

    // Which hotbar pages hold at least one macro (drives page nav + the empty state).
    const pagesWithMacros = [];
    let total = 0;
    for ( let p = 1; p <= PAGE_COUNT; p++ ) {
      let has = false;
      try {
        const slots = game.user?.getHotbarMacros?.(p) ?? [];
        for ( const s of slots ) if ( s?.macro ) { has = true; total++; }
      } catch(err) { /* treat this page as empty */ }
      if ( has ) pagesWithMacros.push(p);
    }

    // Graceful empty state: no hotbar macros on any page.
    if ( total === 0 ) {
      pane.append(h("p", { class: "pf-empty", text: t("TAPTABLE.MacrosEmpty") }));
      return pane;
    }

    // Land on a page that actually has macros: lazy-init on first open, and re-home
    // if the previously shown page lost all its macros between renders.
    if ( !Number.isInteger(this.#macroPage) ) this.#macroPage = pagesWithMacros[0];
    this.#macroPage = Math.min(Math.max(this.#macroPage, 1), PAGE_COUNT);
    if ( !pagesWithMacros.includes(this.#macroPage) ) this.#macroPage = pagesWithMacros[0];

    // Page navigation — only when more than one page carries macros. Prev/Next step
    // through the pages that HAVE macros (never onto an empty page).
    if ( pagesWithMacros.length > 1 ) pane.append(this.#buildMacroPageNav(pagesWithMacros));

    // Rows for the current page: one >=44px tap-to-run row per non-empty slot.
    let slots = [];
    try { slots = game.user?.getHotbarMacros?.(this.#macroPage) ?? []; } catch(err) { /* empty */ }
    const list = h("div", { class: "pf-macros" });
    for ( const entry of slots ) {
      const macro = entry?.macro;
      if ( !macro ) continue;   // empty slot — nothing to run
      let id = "", name = t("TAPTABLE.UnnamedMacro"), img = "icons/svg/dice-target.svg";
      try { id = macro.id ?? ""; } catch(err) { /* keep "" */ }
      try { name = macro.name || name; } catch(err) { /* keep default */ }
      try { img = macro.img || img; } catch(err) { /* keep default */ }
      let slot = null;
      try { slot = entry.slot ?? null; } catch(err) { /* keep null */ }
      list.append(h("button", {
        type: "button",
        class: "pf-macro-row",
        "data-action": "pfMacroExec",
        "aria-label": tf("TAPTABLE.RunMacro", { name }),
        dataset: { macroId: id, slot: (slot === null) ? "" : String(slot) }
      }, [
        h("img", { class: "pf-macro-img", src: img, alt: "", loading: "lazy" }),
        h("span", { class: "pf-macro-name", text: name }),
        h("span", { class: "pf-macro-slot", text: (slot === null) ? "" : String(slot) })
      ]));
    }
    // Defensive: the same synchronous getHotbarMacros scan said this page has macros,
    // so this should never show; kept so the list is never silently empty on drift.
    if ( !list.childElementCount ) {
      list.append(h("p", { class: "pf-empty", text: t("TAPTABLE.MacrosPageEmpty") }));
    }
    pane.append(list);
    return pane;
  }

  /**
   * The Macros pane's page-navigation row (236-2): Prev / "Page N / 5" / Next. Prev
   * and Next step through only the hotbar pages that hold macros (pagesWithMacros),
   * so navigation never lands on an empty page; each is disabled at its end. Both are
   * >=44px targets. The label reports the real hotbar page number so it maps to the
   * user's desktop hotbar layout.
   * @param {number[]} pagesWithMacros  Ascending hotbar page numbers that hold macros.
   * @returns {HTMLElement}
   */
  #buildMacroPageNav(pagesWithMacros) {
    const idx = pagesWithMacros.indexOf(this.#macroPage);
    const nav = h("div", { class: "pf-macro-pagenav" });
    nav.append(h("button", {
      type: "button",
      class: "pf-macro-page-prev",
      disabled: idx <= 0,
      "data-action": "pfMacroPage",
      dataset: { dir: "-1" },
      "aria-label": t("TAPTABLE.MacrosPrevPage")
    }, [h("i", { class: "fa-solid fa-chevron-left", inert: true })]));
    nav.append(h("span", { class: "pf-macro-page-label", role: "status",
      text: tf("TAPTABLE.MacrosPageLabel", { page: this.#macroPage, total: 5 }) }));
    nav.append(h("button", {
      type: "button",
      class: "pf-macro-page-next",
      disabled: idx >= (pagesWithMacros.length - 1),
      "data-action": "pfMacroPage",
      dataset: { dir: "1" },
      "aria-label": t("TAPTABLE.MacrosNextPage")
    }, [h("i", { class: "fa-solid fa-chevron-right", inert: true })]));
    return nav;
  }

  /**
   * 236-2 — Run a hotbar macro (Macro#execute, macro.mjs:81). A WORLD write in the
   * general case (a script macro can do anything a scripted document write can), so
   * this fires ONLY on the user's explicit tap. The macro is re-resolved live by id
   * (it may have been deleted since render); execute() is guarded for drift and for
   * the void return core gives when the user lacks permission (Promise.resolve wraps
   * both the Promise and void cases).
   */
  static #onMacroExec(_event, target) {
    const id = target?.dataset?.macroId;
    let macro = null;
    try { macro = game.macros?.get(id) ?? null; } catch(err) { /* resolved below */ }
    if ( !macro ) {
      ui.notifications?.warn(t("TAPTABLE.WarnMacroGone"));
      return;
    }
    if ( typeof macro.execute !== "function" ) {
      console.warn(`${MODULE_ID} | shell: macro "${id}" has no execute() (core API drift?).`, macro);
      ui.notifications?.warn(t("TAPTABLE.WarnMacroNotRunnable"));
      return;
    }
    try {
      Promise.resolve(macro.execute()).catch(err => console.warn(`${MODULE_ID} | shell: macro execute failed.`, err));
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: macro execute threw.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnMacroRunFailed"));
    }
  }

  /**
   * 236-2 — Step the Macros drawer to the previous/next hotbar page that holds macros
   * (client-local; no world write). Re-scans pages 1-5 live so it follows hotbar
   * changes, then moves the shown page within the has-macros set and re-renders.
   */
  static #onMacroPage(_event, target) {
    const dir = Number(target?.dataset?.dir) || 0;
    if ( !dir ) return;
    const pages = [];
    for ( let p = 1; p <= 5; p++ ) {
      try {
        const slots = game.user?.getHotbarMacros?.(p) ?? [];
        if ( slots.some(s => s?.macro) ) pages.push(p);
      } catch(err) { /* skip this page */ }
    }
    if ( !pages.length ) return;
    let idx = pages.indexOf(this.#macroPage);
    if ( idx < 0 ) idx = 0;
    idx = Math.min(Math.max(idx + dir, 0), pages.length - 1);
    this.#macroPage = pages[idx];
    this.render();
  }

  /* ------------------------------------------ */
  /*  GM Home pane                              */
  /* ------------------------------------------ */

  /**
   * GM without an assigned character: searchable world-actor list instead of the
   * "no character" dead end. Rows are built from lightweight fields only
   * (id/name/img/type — no document rendering), character-type actors sort first,
   * and at most GM_LIST_RENDER_CAP rows are in the DOM at once (search narrows),
   * so the pane stays snappy with 100+ world actors. Search filters client-side
   * and rebuilds ONLY the list element — never the whole shell — so the input
   * keeps focus while typing.
   */
  #buildGMHomePane() {
    const pane = h("section", { class: "pf-pane", dataset: { pane: "home" } });
    pane.append(h("h2", { class: "pf-pane-title", text: t("TAPTABLE.GameMaster") }));

    // Persistent GM control header: pause toggle + Scenes browser, always present
    // whenever the GM Home pane renders — independent of board mode and pause
    // state. It fixes the reachability gap where the top strip only shows on the
    // Board surface / while paused (see _renderHTML), so an unpaused GM off the
    // Board previously lost the pause + scene controls. Both buttons wire to the
    // SAME shipped actions the strip uses (pfPauseToggle -> Game#togglePause,
    // #onPauseToggle; pfScenes -> the scenes pane, #onScenes) and reuse the strip
    // button markup — NO new pause/scene call sites are introduced. Live
    // game.paused state is reflected because the pauseGame hook re-renders the
    // whole shell (see the pauseGame Hooks.on registration).
    let paused = false;
    try { paused = !!game.paused; } catch(err) { /* pre-ready render; treat as unpaused */ }
    pane.append(h("div", { class: "pf-gm-controls" }, [
      h("button", {
        type: "button",
        class: `pf-strip-btn pf-pause-toggle${paused ? " paused" : ""}`,
        "data-action": "pfPauseToggle",
        "aria-label": paused ? t("TAPTABLE.ResumeGame") : t("TAPTABLE.PauseGame"),
        "aria-pressed": paused ? "true" : "false"
      }, [
        h("i", { class: paused ? "fa-solid fa-play" : "fa-solid fa-pause", inert: true }),
        h("span", { text: paused ? t("TAPTABLE.PausedTapToResume") : t("TAPTABLE.Pause") })
      ]),
      h("span", { class: "pf-strip-spacer" }),
      h("button", {
        type: "button",
        class: `pf-strip-btn${this.#pane === "scenes" ? " active" : ""}`,
        "data-action": "pfScenes",
        "aria-label": t("TAPTABLE.SwitchSceneView")
      }, [
        h("i", { class: "fa-solid fa-map-location-dot", inert: true }),
        h("span", { text: t("TAPTABLE.Scenes") })
      ])
    ]));

    const entries = [];
    try {
      for ( const a of game.actors ?? [] ) {
        entries.push({ id: a.id, name: a.name ?? t("TAPTABLE.Unnamed"), img: a.img ?? "icons/svg/mystery-man.svg", type: a.type ?? "" });
      }
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not enumerate world actors.`, err);
    }
    entries.sort((a, b) => {
      const ca = (a.type === "character") ? 0 : 1;
      const cb = (b.type === "character") ? 0 : 1;
      return (ca - cb) || a.name.localeCompare(b.name);
    });

    const isGM = !!game.user?.isGM;        // pane is GM-only already; belt and braces for the Place control
    const canPlace = canvasIsLive();

    const search = h("input", { type: "search", class: "pf-gm-search", value: this.#gmSearch,
      placeholder: tf("TAPTABLE.SearchActorsPlaceholder", { count: entries.length }),
      "aria-label": t("TAPTABLE.SearchActors"),
      autocomplete: "off", spellcheck: "false" });
    const list = h("div", { class: "pf-gm-actors" });
    const renderRows = () => {
      const q = this.#gmSearch.trim().toLowerCase();
      const matches = q ? entries.filter(e => e.name.toLowerCase().includes(q)) : entries;
      const shown = matches.slice(0, GM_LIST_RENDER_CAP);
      list.replaceChildren();
      for ( const e of shown ) {
        const open = h("button", { type: "button", class: "pf-gm-open", "data-action": "pfGmOpenActor",
          "aria-label": tf("TAPTABLE.OpenActor", { name: e.name }), dataset: { actorId: e.id } }, [
          h("img", { src: e.img, alt: "", loading: "lazy" }),
          h("span", { class: "pf-gm-name", text: e.name })
        ]);
        const row = h("div", { class: "pf-gm-row" }, [open]);
        if ( isGM ) {
          row.append(h("button", { type: "button", class: "pf-gm-place", "data-action": "pfGmPlace",
            disabled: !canPlace, "aria-label": tf("TAPTABLE.PlaceActor", { name: e.name }), dataset: { actorId: e.id } },
          [h("i", { class: "fa-solid fa-location-crosshairs", inert: true })]));
        }
        list.append(row);
      }
      if ( !matches.length ) {
        list.append(h("p", { class: "pf-empty", text: t("TAPTABLE.NoActorsMatch") }));
      } else if ( matches.length > shown.length ) {
        list.append(h("p", { class: "pf-hint", text: tf("TAPTABLE.ShowingOf", { shown: shown.length, total: matches.length }) }));
      }
    };
    renderRows();
    search.addEventListener("input", () => { this.#gmSearch = search.value; renderRows(); });

    pane.append(search);
    if ( !canPlace ) pane.append(h("p", { class: "pf-hint", text: t("TAPTABLE.PlacementDisabled") }));
    pane.append(list);
    return pane;
  }

  /** Open an actor's sheet fullscreen through the standard permission-checked render path. */
  static #onGmOpenActor(_event, target) {
    const actor = game.actors?.get(target.dataset.actorId);
    if ( !actor ) {
      ui.notifications?.warn(t("TAPTABLE.WarnActorGone"));
      return;
    }
    let result;
    try {
      result = actor.sheet?.render(true);
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: actor sheet render failed.`, err);
      return;
    }
    if ( result && (typeof result.then === "function") ) {
      result.then(app => maximizeApp(app))
        .catch(err => console.warn(`${MODULE_ID} | shell: actor sheet failed to open.`, err));
    } else if ( result ) maximizeApp(result);
    // Close the Home pane so the fullscreen sheet is visible (panes stack above windows).
    if ( this.#pane ) { this.#pane = null; this.render(); }
  }

  /** GM-only: place the actor's prototype token at the view center (see placeActorAtViewCenter). */
  static #onGmPlace(_event, target) {
    if ( !game.user?.isGM ) return;
    const actor = game.actors?.get(target.dataset.actorId);
    if ( !actor ) return;
    placeActorAtViewCenter(actor);
  }

  /* ------------------------------------------ */
  /*  Nav                                       */
  /* ------------------------------------------ */

  /**
   * Sheet-mode nav (M3): mirror the topmost maximized dnd5e actor sheet's tab
   * rail — hidden under pf-mobile by pf-dnd5e.css — as bottom-nav buttons plus a
   * Close control. Buttons carry the rail item's data-tab id; taps forward a
   * click to the hidden rail item (#onSheetNavTab — display:none elements still
   * receive programmatic clicks and dnd5e's own data-action="tab" listener runs),
   * so tab state stays fully owned by the sheet. Rail markup: sidebar-tabs.hbs
   * (a.item[data-tab] with an <i> or <dnd5e-icon> and a localized aria-label).
   * @param {object} app  The topmost tracked sheet (topSheet()).
   */
  #buildSheetNav(app) {
    const nav = h("nav", { class: "pf-nav pf-sheet-nav", "aria-label": t("TAPTABLE.SheetNavLabel") });
    const el = elementOf(app);
    const rail = el?.querySelector("nav.tabs.tabs-right, nav.tabs.tabs-left, nav.tabs[data-group='primary']");
    if ( !rail ) {
      console.warn(`${MODULE_ID} | shell: no tab rail found on the maximized sheet (dnd5e markup drift?); sheet nav shows Close only.`);
    }
    for ( const item of rail?.querySelectorAll("[data-tab]") ?? [] ) {
      if ( item.hidden ) continue;
      const tabId = item.dataset.tab;
      const label = item.getAttribute("aria-label") || tabId;
      const icon = item.querySelector("i")?.className;
      const svg = item.querySelector("dnd5e-icon")?.getAttribute("src");
      nav.append(h("button", {
        type: "button",
        class: `pf-tab${item.classList.contains("active") ? " active" : ""}`,
        "data-action": "pfSheetTab",
        "aria-label": label,
        dataset: { tab: tabId }
      }, [
        icon ? h("i", { class: icon, inert: true })
          : svg ? h("dnd5e-icon", { src: svg, inert: true })
            : h("i", { class: "fa-solid fa-bookmark", inert: true }),
        h("span", { class: "pf-tab-label", text: label })
      ]));
    }
    // 231-2: "+ Add" opens the Compendium Add picker for this sheet's actor, but
    // only for a sheet the user OWNS and can edit (addableSheetActor) — no control
    // for an observer/limited sheet. Inherits the .pf-sheet-nav .pf-tab >=44px floor.
    const addActor = addableSheetActor(app);
    if ( addActor ) {
      nav.append(h("button", {
        type: "button",
        class: "pf-tab pf-sheet-add",
        "data-action": "pfSheetAdd",
        "aria-label": tf("TAPTABLE.AddToActor", { name: addActor.name })
      }, [
        h("i", { class: "fa-solid fa-plus", inert: true }),
        h("span", { class: "pf-tab-label", text: t("TAPTABLE.Add") })
      ]));
    }
    nav.append(h("button", {
      type: "button",
      class: "pf-tab pf-sheet-close",
      "data-action": "pfSheetClose",
      "aria-label": t("TAPTABLE.CloseSheet")
    }, [
      h("i", { class: "fa-solid fa-circle-xmark", inert: true }),
      h("span", { class: "pf-tab-label", text: t("TAPTABLE.Close") })
    ]));
    return nav;
  }

  /** Forward a sheet-mode nav tap to the hidden rail item with the same data-tab,
   *  then re-render: changeTab toggles the rail's active classes synchronously
   *  (core application.mjs changeTab), so the rebuilt nav shows the new marker. */
  static #onSheetNavTab(_event, target) {
    const app = topSheet();
    const el = elementOf(app);
    if ( !el ) return;
    const tab = target.dataset.tab ?? "";
    const esc = window.CSS?.escape ? CSS.escape(tab) : tab;
    const item = el.querySelector(`nav.tabs [data-tab="${esc}"]`);
    if ( !item ) {
      console.warn(`${MODULE_ID} | shell: tab "${tab}" no longer exists on the sheet; re-syncing the nav.`);
      this.render();
      return;
    }
    item.click();
    this.render();
  }

  /** Close the topmost maximized sheet. The closeActorSheetV2 hook
   *  (onTrackedSheetClose) restores the previous nav — the next stacked sheet's
   *  tabs, or the regular shell tabs when none remain. */
  static #onSheetNavClose() {
    const app = topSheet();
    if ( !app ) return;
    try {
      const r = app.close();
      if ( typeof r?.catch === "function" ) r.catch(err => console.warn(`${MODULE_ID} | shell: sheet close failed.`, err));
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: sheet close failed.`, err);
    }
  }

  /** Open the Compendium Add picker (231-1) for the topmost tracked sheet's actor.
   *  Rendered only for an OWN, editable sheet (addableSheetActor, the same gate
   *  #buildSheetNav uses to decide whether to show the control); openCompendiumPicker
   *  re-checks ownership and early-returns without pf-mobile, so this is safe even
   *  if the sheet changed since render. */
  static #onSheetAdd() {
    const actor = addableSheetActor(topSheet());
    if ( !actor ) return;
    try {
      Promise.resolve(openCompendiumPicker(actor))
        .catch(err => console.warn(`${MODULE_ID} | shell: opening the compendium picker failed.`, err));
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: opening the compendium picker threw.`, err);
    }
  }

  #buildNav() {
    // Sheet-mode (M3): while a maximized dnd5e actor sheet is the topmost open
    // window — no shell pane stacked above it, not in board mode (pf-max windows
    // are CSS-hidden there) — the nav morphs into that sheet's tabs + Close.
    if ( !this.#pane && !this.#boardActive ) {
      const sheetApp = topSheet();
      if ( sheetApp ) return this.#buildSheetNav(sheetApp);
    }
    const nav = h("nav", { class: "pf-nav", "aria-label": t("TAPTABLE.NavLabel") });
    // v2: only section:"nav" registrations render here (no-section registrations
    // normalized to "nav" in registerTab — M2 behavior preserved); "modules"
    // entries render in the Mods pane instead.
    const tabs = [...tabRegistry.values()]
      .filter(t => t.section === "nav")
      .sort((a, b) => a.order - b.order);
    for ( const tab of tabs ) {
      let visible = true;
      if ( tab.visible ) {
        try { visible = !!tab.visible(); }
        catch(err) {
          visible = false;
          console.warn(`${MODULE_ID} | shell: visible() for tab "${tab.id}" threw; hiding it.`, err);
        }
      }
      if ( !visible ) continue;
      const active = (this.#pane === tab.id) || ((tab.id === "board") && this.#boardActive);
      // Labels are localized HERE, at render time (never when a tab registers at init
      // — i18n is not loaded yet then). Built-in labels are TAPTABLE.* keys; a plain
      // third-party string passes through game.i18n.localize unchanged.
      const label = t(tab.label);
      const btn = h("button", {
        type: "button",
        class: `pf-tab${active ? " active" : ""}`,
        "data-action": "pfTab",
        "aria-label": label,
        dataset: { tab: tab.id }
      }, [h("i", { class: tab.icon, inert: true }), h("span", { class: "pf-tab-label", text: label })]);
      nav.append(btn);
    }
    return nav;
  }

  static #onTab(_event, target) {
    this.#activateTab(target.dataset.tab);
  }

  /**
   * Activate a registered tab by id — the single switch path shared by a nav tap
   * (#onTab) and programmatic switches (switchTab). Runs the tab's open() handler
   * and applies the post-open behavior the nav has always used: app-returning tabs
   * (Chat/Combat/Sheet) are maximized (pf-max) and any open shell pane is closed so
   * the fullscreen window is visible (panes stack above windows — see #onGmOpenActor);
   * pane-toggle tabs (Home/Roller/Mods…) manage their own pane inside open().
   * @param {string} tabId  A registered tab id; unknown ids no-op.
   */
  #activateTab(tabId) {
    const tab = tabRegistry.get(tabId);
    if ( !tab ) return;
    // Any non-Board tab exits board mode first: the CSS-hidden pf-max windows
    // become visible again, then the tab opens/re-opens its app or pane normally.
    if ( (tab.id !== "board") && this.#boardActive ) this.#setBoardActive(false);
    let result;
    try {
      result = tab.open({ shell: this });
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: open() for tab "${tab.id}" threw.`, err);
      return;
    }
    // App-opening tabs: maximize whatever comes back and close any open pane.
    if ( result && (typeof result.then === "function") ) {
      result.then(app => maximizeApp(app))
        .catch(err => console.warn(`${MODULE_ID} | shell: tab "${tab.id}" failed to open its application.`, err));
      if ( this.#pane ) { this.#pane = null; this.render(); }
    } else if ( result instanceof foundry.applications.api.ApplicationV2 ) {
      maximizeApp(result);
      if ( this.#pane ) { this.#pane = null; this.render(); }
    }
  }

  /**
   * Programmatically switch the shell to a registered tab, exactly as tapping its
   * nav button would — reuses #activateTab so the switch logic lives in one place
   * and is never duplicated. Used by the Quick Roll snap-to-chat (M3.1): after a
   * roll is dispatched, roller.js calls shell.switchTab("chat") so the just-posted
   * roll message is brought to the fullscreen Chat surface and the Roller pane
   * (which would otherwise cover it) is closed. No-ops for an unknown tab id.
   * @param {string} tabId  A registered tab id (e.g. "chat").
   */
  switchTab(tabId) {
    this.#activateTab(tabId);
  }

  /* ------------------------------------------ */
  /*  Home pane                                 */
  /* ------------------------------------------ */

  #buildHomePane() {
    // GM without an assigned character: the GM pane replaces the dead-end message.
    // GMs WITH a character (and all players) keep the character quick-strip below.
    if ( game.user?.isGM && !game.user.character ) return this.#buildGMHomePane();

    const pane = h("section", { class: "pf-pane", dataset: { pane: "home" } });
    const actor = game.user?.character;
    if ( !actor ) {
      pane.append(h("p", { class: "pf-empty", text: t("TAPTABLE.HomeNoCharacter") }));
      return pane;
    }
    pane.append(h("h2", { class: "pf-pane-title", text: actor.name }));

    // Vitals: whatever the active system adapter reports (dnd5e: HP / hit dice /
    // death saves), rendered generically. null → the whole vitals block is hidden.
    const vitals = resolveAdapter().getVitals(actor);
    if ( vitals?.hp && (typeof vitals.hp.value === "number") && (typeof vitals.hp.max === "number") ) {
      // HP quick-strip: +/- adjust via resolveAdapter().adjustHp (see #onHpDelta).
      const label = vitals.hp.temp
        ? tf("TAPTABLE.HpValueTemp", { value: vitals.hp.value, max: vitals.hp.max, temp: vitals.hp.temp })
        : tf("TAPTABLE.ValueOfMax", { value: vitals.hp.value, max: vitals.hp.max });
      pane.append(h("div", { class: "pf-row pf-hp" }, [
        h("span", { class: "pf-row-label", text: t("TAPTABLE.HP") }),
        h("button", { type: "button", class: "pf-btn", "data-action": "pfHpDelta",
          "aria-label": t("TAPTABLE.LoseHp"), dataset: { delta: "-1" }, text: "−" }),
        h("span", { class: "pf-hp-value", text: label }),
        h("button", { type: "button", class: "pf-btn", "data-action": "pfHpDelta",
          "aria-label": t("TAPTABLE.GainHp"), dataset: { delta: "1" }, text: "+" })
      ]));
    }
    if ( vitals?.hitDice && (typeof vitals.hitDice.value === "number") ) {
      pane.append(h("div", { class: "pf-row" }, [
        h("span", { class: "pf-row-label", text: t("TAPTABLE.HitDice") }),
        h("span", { text: tf("TAPTABLE.ValueOfMax", { value: vitals.hitDice.value, max: vitals.hitDice.max ?? "?" }) })
      ]));
    }
    if ( vitals?.death && (typeof vitals.death.success === "number") && (typeof vitals.death.failure === "number") ) {
      pane.append(h("div", { class: "pf-row" }, [
        h("span", { class: "pf-row-label", text: t("TAPTABLE.DeathSaves") }),
        h("span", { text: tf("TAPTABLE.DeathSavesValue", { success: vitals.death.success, failure: vitals.death.failure }) })
      ]));
    }

    // Favorites: whatever the adapter reports as actionable entries (dnd5e:
    // item/activity favorites, {id, name, img}). [] → the favorites block is
    // hidden. Activation routes back through resolveAdapter().useFavorite (#onFavorite).
    const favorites = resolveAdapter().getFavorites(actor);
    if ( favorites.length ) {
      pane.append(h("h3", { class: "pf-section-title", text: t("TAPTABLE.Favorites") }));
      const list = h("div", { class: "pf-favorites" });
      for ( const fav of favorites ) {
        list.append(h("button", {
          type: "button",
          class: "pf-favorite",
          "data-action": "pfFavorite",
          "aria-label": tf("TAPTABLE.UseFavorite", { name: fav.name }),
          dataset: { favoriteId: fav.id }
        }, [
          fav.img ? h("img", { src: fav.img, alt: "", loading: "lazy" }) : null,
          h("span", { text: fav.name })
        ]));
      }
      pane.append(list);
    }
    return pane;
  }

  static #onHpDelta(_event, target) {
    const actor = game.user?.character;
    if ( !actor ) return;
    const delta = Number(target.dataset.delta) || 0;
    if ( !delta ) return;
    // The clamp + system-schema write live in the adapter (dnd5e: system.attributes.hp).
    Promise.resolve(resolveAdapter().adjustHp(actor, delta))
      .catch(err => console.warn(`${MODULE_ID} | shell: HP update failed.`, err));
  }

  static #onFavorite(_event, target) {
    const actor = game.user?.character;
    if ( !actor ) return;
    // Resolve the favorite handle (a core-relative UUID) to its document, then let
    // the adapter activate it (dnd5e: doc.use()). fromUuidSync is a core global.
    let doc = null;
    try { doc = fromUuidSync(target.dataset.favoriteId, { relative: actor }); } catch(err) { /* handled below */ }
    if ( !doc ) {
      ui.notifications?.warn(t("TAPTABLE.WarnFavoriteUnresolved"));
      return;
    }
    Promise.resolve(resolveAdapter().useFavorite(doc))
      .catch(err => console.warn(`${MODULE_ID} | shell: favorite activation failed.`, err));
  }

  /* ------------------------------------------ */
  /*  Settings pane                             */
  /* ------------------------------------------ */

  #buildSettingsPane() {
    const pane = h("section", { class: "pf-pane", dataset: { pane: "settings" } });
    pane.append(h("h2", { class: "pf-pane-title", text: t("TAPTABLE.SettingsTitle") }));

    // Mode selector — binds the existing client setting taptable.mode.
    let mode = "auto";
    try { mode = game.settings.get(MODULE_ID, "mode"); } catch(err) { /* keep default */ }
    const select = h("select", { "data-pf": "mode", "aria-label": t("TAPTABLE.ModeSelect") });
    for ( const [value, label] of Object.entries({ auto: t("TAPTABLE.ModeChoiceAuto"),
      phone: t("TAPTABLE.SettingModeChoicePhone"), off: t("TAPTABLE.SettingModeChoiceOff") }) ) {
      select.append(h("option", { value, selected: value === mode, text: label }));
    }
    pane.append(h("div", { class: "pf-row" }, [
      h("span", { class: "pf-row-label", text: t("TAPTABLE.Mode") }), select
    ]));

    // Lite mode — core.noCanvas (client, requiresReload; game.mjs:1209-1216).
    let lite = false;
    try { lite = !!game.settings.get("core", "noCanvas"); } catch(err) { /* keep default */ }
    pane.append(h("div", { class: "pf-row" }, [
      h("span", { class: "pf-row-label", text: t("TAPTABLE.LiteModeLabel") }),
      h("input", { type: "checkbox", "data-pf": "lite", checked: lite, "aria-label": t("TAPTABLE.LiteModeToggle") })
    ]));

    // Battery-saver graphics profile (consented, client-scoped, never silent).
    let consent = false;
    try { consent = !!game.settings.get(MODULE_ID, CONSENT_SETTING); } catch(err) { /* keep default */ }
    pane.append(h("div", { class: "pf-row" }, [
      h("button", { type: "button", class: "pf-btn pf-wide", "data-action": "pfPerfProfile",
        text: t("TAPTABLE.PerfProfileButton") })
    ]));
    pane.append(h("p", { class: "pf-hint", text: consent
      ? t("TAPTABLE.PerfProfileConsented")
      : t("TAPTABLE.PerfProfileAsk") }));

    // Free map memory: enable Lite + confirm + reload.
    pane.append(h("div", { class: "pf-row" }, [
      h("button", { type: "button", class: "pf-btn pf-wide", "data-action": "pfFreeMemory",
        text: t("TAPTABLE.FreeMemoryButton") })
    ]));

    // 233-1: GM-only Configuration section — a mobile route into Foundry/module
    // configuration. Gated on game.user.isGM (true for full AND assistant GMs);
    // a player's Settings pane is built without it, so it is never rendered for a
    // non-GM. Every handler also re-checks isGM (defense in depth).
    if ( game.user?.isGM ) this.#buildConfigSection(pane);
    return pane;
  }

  /* ------------------------------------------ */
  /*  233-1 — GM Configuration section          */
  /* ------------------------------------------ */

  /**
   * Append the GM-only Configuration section to the Settings pane (233-1): a mobile
   * path into Foundry/module configuration so a GM can reach and edit settings,
   * including API-key fields, from a phone.
   *  - "Configure Settings" opens core SettingsConfig (game.settings.sheet — the
   *    cached singleton, client-settings.mjs:55) as a shell-opened pf-max fullscreen
   *    window (#onOpenSettings -> maximizeApp). pf-core.css restacks its
   *    CategoryBrowser two-pane so it fits 412px with no horizontal clip.
   *  - Each registered setting menu the current user MAY open (#openableMenus,
   *    filtered exactly like core SettingsConfig._prepareCategoryData) is a >=44px
   *    row (icon + label) opening `new menu.type().render(true)` fullscreen
   *    (#onOpenMenu); a graceful empty state when none are available.
   * Opening a config app is READ-ONLY here — the shell never types or submits a
   * setting; saving stays an explicit action inside the opened app.
   * @param {HTMLElement} pane  The Settings pane section being built.
   */
  #buildConfigSection(pane) {
    pane.append(h("h3", { class: "pf-section-title", text: t("TAPTABLE.Configuration") }));
    pane.append(h("p", { class: "pf-hint", text: t("TAPTABLE.ConfigHint") }));

    // Configure Settings -> core SettingsConfig, opened fullscreen via the shell.
    pane.append(h("div", { class: "pf-row" }, [
      h("button", { type: "button", class: "pf-btn pf-wide", "data-action": "pfOpenSettings" }, [
        h("i", { class: "fa-solid fa-gears", inert: true }),
        h("span", { text: t("TAPTABLE.ConfigureSettings") })
      ])
    ]));

    // Registered setting menus the user may open, as >=44px icon + label rows.
    const menus = this.#openableMenus();
    const list = h("div", { class: "pf-config-menus" });
    for ( const menu of menus ) {
      list.append(h("button", {
        type: "button",
        class: "pf-config-menu",
        "data-action": "pfOpenMenu",
        "aria-label": menu.label,
        dataset: { menuKey: menu.key }
      }, [
        h("i", { class: menu.icon || "fa-solid fa-sliders", inert: true }),
        h("span", { class: "pf-config-menu-label", text: menu.label })
      ]));
    }
    if ( !list.childElementCount ) {
      list.append(h("p", { class: "pf-empty", text: t("TAPTABLE.ConfigEmpty") }));
    }
    pane.append(list);
  }

  /**
   * The registered setting menus the current user may open, filtered EXACTLY like
   * core SettingsConfig._prepareCategoryData (config.mjs:50-58): a `restricted` menu
   * needs SETTINGS_MODIFY (or an assistant GM plus an allowed-assistant key), and a
   * GAMEMASTER-only key needs the full GAMEMASTER role. Guarded end to end so core
   * API drift hides menus (fail-closed) rather than throwing. Labels are localized
   * (menu.name preferred, then menu.label, then the key).
   * @returns {Array<{key:string, icon:string, label:string}>}
   */
  #openableMenus() {
    const out = [];
    try {
      const menus = game.settings?.menus;
      if ( typeof menus?.values !== "function" ) return out;
      const canConfigure = !!game.user?.can?.("SETTINGS_MODIFY");
      const isGM = !!game.user?.isGM;
      const isFullGM = !!game.user?.hasRole?.("GAMEMASTER");
      const Base = foundry.documents?.BaseSetting;
      const allowedAssistant = Array.isArray(Base?._ALLOWED_ASSISTANT_KEYS) ? Base._ALLOWED_ASSISTANT_KEYS : [];
      const gmOnly = Array.isArray(Base?._GAMEMASTER_ONLY_KEYS) ? Base._GAMEMASTER_ONLY_KEYS : [];
      const loc = s => { try { return s ? (game.i18n?.localize(s) ?? s) : ""; } catch(err) { return s ?? ""; } };
      for ( const menu of menus.values() ) {
        if ( !menu?.type ) continue;                                       // not an openable Application
        if ( menu.restricted && !canConfigure && !(isGM && allowedAssistant.includes(menu.key)) ) continue;
        if ( gmOnly.includes(menu.key) && !isFullGM ) continue;
        const label = loc(menu.name) || loc(menu.label) || menu.key;
        out.push({ key: menu.key, icon: menu.icon, label });
      }
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not enumerate setting menus.`, err);
    }
    return out;
  }

  /** GM-only: open core SettingsConfig fullscreen. Uses game.settings.sheet — the
   *  cached singleton SettingsConfig (client-settings.mjs:55), the same instance
   *  core's own "Configure Settings" control renders — with a `new SettingsConfig()`
   *  fallback on drift. Maximized (pf-max) exactly like #onGmOpenActor: promise-aware
   *  for the AppV2 render, then the pane is closed so the fullscreen window shows.
   *  Read-only: no setting is typed or submitted here. */
  static #onOpenSettings() {
    if ( !game.user?.isGM ) return;   // defense in depth; never rendered for non-GM
    let app = null;
    try { app = game.settings?.sheet ?? null; } catch(err) { /* fall back below */ }
    if ( !app ) {
      const SC = foundry.applications?.settings?.SettingsConfig;
      try { if ( SC ) app = new SC(); } catch(err) { /* handled below */ }
    }
    if ( !app ) {
      console.warn(`${MODULE_ID} | shell: core SettingsConfig is unavailable (core API drift?).`);
      ui.notifications?.warn(t("TAPTABLE.WarnSettingsOpenFailed"));
      return;
    }
    let result;
    try {
      result = app.render(true);
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: SettingsConfig render failed.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnSettingsOpenFailed"));
      return;
    }
    if ( result && (typeof result.then === "function") ) {
      result.then(a => maximizeApp(a ?? app))
        .catch(err => console.warn(`${MODULE_ID} | shell: SettingsConfig failed to open.`, err));
    } else maximizeApp(app);
    if ( this.#pane ) { this.#pane = null; this.render(); }
  }

  /** GM-only: open one registered setting menu fullscreen via `new menu.type()`
   *  .render(true) — the same instantiation core's SettingsConfig submenu button
   *  uses (config.mjs:212-213). Read-only (opening only, never saving); unknown/removed
   *  keys warn and no-op.
   *
   *  A menu type is either an ApplicationV2 or a legacy v1 FormApplication, and the
   *  pf-max lifecycle differs (233-1 rewrite):
   *   - V2: render(true) resolves to the app; maximizeApp on resolve, and the
   *     renderApplicationV2 hook (onAnyAppRender) re-applies pf-max on later re-renders.
   *   - V1: render(true) is SYNCHRONOUS and returns the app before its element is in the
   *     DOM, and v1 apps fire the `renderApplication` hook — NOT renderApplicationV2 — so
   *     a synchronous maximizeApp would miss the (not-yet-existing) element and it would
   *     open desktop-sized (the r1 audit defect). Maximize on that one render signal
   *     instead. The listener is app-specific and self-removing: a bare Hooks.once would
   *     be consumed by whichever v1 app renders first. (V1 windows carry the `.app`
   *     class, not `.application`, so pf-core.css's pf-max rules also match `.app.pf-max`.)
   */
  static #onOpenMenu(_event, target) {
    if ( !game.user?.isGM ) return;   // defense in depth; never rendered for non-GM
    const key = target?.dataset?.menuKey;
    const menu = game.settings?.menus?.get?.(key);
    if ( typeof menu?.type !== "function" ) {
      console.warn(`${MODULE_ID} | shell: setting menu "${key}" is no longer available.`);
      ui.notifications?.warn(t("TAPTABLE.WarnMenuGone"));
      return;
    }
    let app;
    try {
      app = new menu.type();
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: setting menu "${key}" failed to construct.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnMenuOpenFailed"));
      return;
    }
    const isV2 = app instanceof foundry.applications.api.ApplicationV2;
    let hookId = null;
    if ( !isV2 ) {
      hookId = Hooks.on("renderApplication", a => {
        if ( a !== app ) return;          // only this menu's own render
        Hooks.off("renderApplication", hookId);
        maximizeApp(app);                 // element now in the DOM -> pf-max applies
      });
    }
    let result;
    try {
      result = app.render(true);
    } catch(err) {
      if ( hookId !== null ) Hooks.off("renderApplication", hookId);
      console.warn(`${MODULE_ID} | shell: setting menu "${key}" failed to open.`, err);
      ui.notifications?.warn(t("TAPTABLE.WarnMenuOpenFailed"));
      return;
    }
    if ( isV2 ) {
      if ( result && (typeof result.then === "function") ) {
        result.then(a => maximizeApp(a ?? app))
          .catch(err => console.warn(`${MODULE_ID} | shell: setting menu "${key}" failed to open.`, err));
      } else maximizeApp(app);
    }
    if ( this.#pane ) { this.#pane = null; this.render(); }
  }

  async #onModeChange(event) {
    const value = event.currentTarget.value;
    try {
      await game.settings.set(MODULE_ID, "mode", value);
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not save mode.`, err);
      return;
    }
    const SC = foundry.applications?.settings?.SettingsConfig;
    if ( typeof SC?.reloadConfirm === "function" ) SC.reloadConfirm({ world: false });
    else pfReload();
  }

  async #onLiteChange(event) {
    const input = event.currentTarget;
    const want = input.checked;
    const ok = await pfConfirm(t("TAPTABLE.LiteModeTitle"), want
      ? t("TAPTABLE.LiteModeOnContent")
      : t("TAPTABLE.LiteModeOffContent"));
    if ( !ok ) { input.checked = !want; return; }
    try {
      await game.settings.set("core", "noCanvas", want);
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not set core.noCanvas.`, err);
      input.checked = !want;
      return;
    }
    pfReload();
  }

  static async #onPerfProfile() {
    let consent = false;
    try { consent = !!game.settings.get(MODULE_ID, CONSENT_SETTING); } catch(err) { /* treat as not consented */ }
    if ( !consent ) {
      const ok = await pfConfirm(t("TAPTABLE.PerfProfileTitle"), t("TAPTABLE.PerfProfileContent"));
      if ( !ok ) return;
      try {
        await game.settings.set(MODULE_ID, CONSENT_SETTING, true);
      } catch(err) {
        console.warn(`${MODULE_ID} | shell: could not record perf-profile consent; profile NOT applied.`, err);
        return;
      }
    }
    await applyPerfProfile();
    ui.notifications?.info(t("TAPTABLE.InfoPerfApplied"));
    this.render();
  }

  static async #onFreeMemory() {
    const ok = await pfConfirm(t("TAPTABLE.FreeMemoryTitle"), t("TAPTABLE.FreeMemoryContent"));
    if ( !ok ) return;
    try {
      await game.settings.set("core", "noCanvas", true);
    } catch(err) {
      console.warn(`${MODULE_ID} | shell: could not set core.noCanvas.`, err);
      return;
    }
    pfReload();
  }
}

/* -------------------------------------------- */
/*  Built-in tabs                               */
/* -------------------------------------------- */

function registerBuiltinTabs() {
  // TIMING: this runs at init, BEFORE i18n has loaded translations (i18nInit), so the
  // registry stores the localization KEYS. They are resolved to text at render time —
  // #buildNav / #buildModsPane call game.i18n.localize on each label — never here.
  registerTab({ id: "home", icon: "fa-solid fa-house", label: "TAPTABLE.TabHome", order: 10,
    open: ({ shell: s }) => s?.togglePane("home") });
  registerTab({ id: "board", icon: "fa-solid fa-map", label: "TAPTABLE.TabBoard", order: 15,
    open: ({ shell: s }) => s?.toggleBoard() });
  registerTab({ id: "sheet", icon: "fa-solid fa-user", label: "TAPTABLE.TabSheet", order: 20,
    visible: () => !!game.user?.character,
    open: () => game.user.character?.sheet?.render(true) });
  registerTab({ id: "roller", icon: "fa-solid fa-dice", label: "TAPTABLE.TabRoller", order: 25,
    open: ({ shell: s }) => s?.togglePane("roller") });
  registerTab({ id: "chat", icon: "fa-solid fa-comments", label: "TAPTABLE.TabChat", order: 30,
    open: () => ui.chat?.renderPopout() });
  registerTab({ id: "combat", icon: "fa-solid fa-swords", label: "TAPTABLE.TabCombat", order: 40,
    open: () => ui.combat?.renderPopout() });
  // 236-2: macro hotbar drawer — a shell-owned pane listing the user's hotbar macros
  // as tap-to-run rows. Pane-toggle tab exactly like Home/Roller/Mods (open() returns
  // no application, so #activateTab just toggles the pane).
  registerTab({ id: "macros", icon: "fa-solid fa-scroll", label: "TAPTABLE.TabMacros", order: 42,
    open: ({ shell: s }) => s?.togglePane("macros") });
  registerTab({ id: "mods", icon: "fa-solid fa-cubes", label: "TAPTABLE.TabMods", order: 45,
    open: ({ shell: s }) => s?.togglePane("mods") });
  registerTab({ id: "settings", icon: "fa-solid fa-gear", label: "TAPTABLE.TabSettings", order: 50,
    open: ({ shell: s }) => s?.togglePane("settings") });
}

/* -------------------------------------------- */
/*  Entry point                                 */
/* -------------------------------------------- */

/**
 * Called from main.js during init. Early-returns without the pf-mobile flag: on
 * desktop clients no hook below is ever registered and the shell never renders.
 */
export function initShell() {
  if ( !document.body?.classList.contains("pf-mobile") ) return;

  // name is a bare localization key — Foundry localizes it lazily (config:false, so
  // it is only ever seen through introspection, but keep it translatable anyway).
  game.settings.register(MODULE_ID, CONSENT_SETTING, {
    name: "TAPTABLE.SettingConsentName",
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  registerBuiltinTabs();

  // pf-max lifecycle: re-apply on re-render (AppV2 can rebuild its element), forget
  // on close so the nav-driven fullscreen never leaks to non-shell opens.
  Hooks.on("renderApplicationV2", onAnyAppRender);
  Hooks.on("closeApplicationV2", onAnyAppClose);

  // Sheet-mode nav re-sync (M3): dnd5e 5.x actor sheets are AppV2, so their
  // standard render/close hooks carry core's class-chain names — the
  // ActorSheetV2 base yields renderActorSheetV2/closeActorSheetV2
  // (application.mjs:1676 #callHooks iterates inheritanceChain; the V1
  // renderActorSheet/closeActorSheet names never fire for these sheets).
  // dnd5e sheets re-render on every actor data change, so this keeps the
  // sheet-mode nav's tab list and active marker current.
  Hooks.on("renderActorSheetV2", onTrackedSheetRender);
  Hooks.on("closeActorSheetV2", onTrackedSheetClose);

  // Combat popout: augmentation + live target-state refresh + belt-and-braces
  // re-render on combat lifecycle (core already re-renders the tracker on combat
  // CRUD — combat.mjs:524,655,674,744 — the debounce merges with those).
  Hooks.on("renderCombatTracker", augmentCombatPopout);
  Hooks.on("targetToken", refreshTargetToggles);
  // 236-1: the same debounced refresh also re-renders the shell so the Board
  // combatant carousel (#buildCombatCarousel) follows the active combat — turn order
  // and the current-turn marker (combatTurnChange / updateCombat), combatant fields
  // like initiative and defeated (updateCombatant), and appear/disappear as a combat
  // is created/deleted (game.combats.active becomes non-null / null).
  const refreshCombat = foundry.utils.debounce(() => {
    const pop = ui.combat?.popout;
    if ( pop?.rendered ) pop.render();
    if ( shell?.rendered ) shell.render();
  }, 100);
  Hooks.on("updateCombat", refreshCombat);
  Hooks.on("deleteCombat", refreshCombat);
  Hooks.on("createCombat", refreshCombat);
  Hooks.on("combatTurnChange", refreshCombat);
  Hooks.on("updateCombatant", refreshCombat);

  // Keep shell content current: HP strip follows the assigned character; the Sheet
  // tab appears/disappears when the user's character assignment changes.
  Hooks.on("updateActor", actor => {
    if ( (actor === game.user?.character) && shell?.rendered ) shell.render();
  });
  Hooks.on("updateUser", user => {
    if ( (user === game.user) && shell?.rendered ) shell.render();
  });

  // Pause + scene surfaces stay current (M2.2). Core fires pauseGame on EVERY
  // state change — local toggles and server socket pushes both end in
  // Hooks.callAll("pauseGame") (game.mjs:1783, via game.mjs:2114 for pushes).
  // body.pf-paused lets CSS shift pf-max windows below the strip while paused.
  const syncPaused = () => {
    try { document.body.classList.toggle("pf-paused", !!game.paused); } catch(err) { /* no body?! */ }
  };
  Hooks.on("pauseGame", () => {
    syncPaused();
    if ( shell?.rendered ) shell.render();
  });
  // Scene#view redraws end in canvasReady: refresh Viewed markers + the player
  // back-to-active affordance. updateScene with an "active" change refreshes the
  // Active markers (never fires in Lite mode / canvasReady never with no canvas —
  // both no-ops there, matching the strip's canvasIsLive() guards).
  Hooks.on("canvasReady", () => {
    if ( shell?.rendered ) shell.render();
  });
  Hooks.on("updateScene", (_scene, changes) => {
    if ( ("active" in (changes ?? {})) && shell?.rendered ) shell.render();
  });

  Hooks.once("ready", () => {
    syncPaused();
    shell = new PocketShell();
    shell.render({ force: true })
      .catch(err => console.error(`${MODULE_ID} | shell: initial render failed.`, err));
  });
}
