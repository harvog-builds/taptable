/**
 * taptable — touch drag-and-drop (M1).
 *
 * Core bug: touch input never produces HTML5 drag events (foundryvtt#11541), so phone
 * players cannot drag items/spells/effects within sheets or from compendiums. We fix
 * this with the MIT `mobile-drag-drop` polyfill, vendored at
 * scripts/vendor/mobile-drag-drop.js.
 *
 * The vendored build is UMD; its wrapper passes top-level `this` as the global, which
 * is `undefined` inside an ES module — so it must be loaded as a CLASSIC script (it
 * then attaches `window.MobileDragDrop`). We inject that script tag at runtime, ONLY
 * under body.pf-mobile: on desktop clients the polyfill file is never even fetched.
 *
 * Scoping: `tryFindDraggableTarget` only ever returns draggable elements inside
 * application windows (`.application` for AppV2, `.app` for legacy AppV1) and
 * hard-excludes #board/canvas, so the polyfill can never fight core's
 * MouseInteractionManager touch handling on the game canvas.
 */

const MODULE_ID = "taptable";
const VENDOR_PATH = "modules/taptable/scripts/vendor/mobile-drag-drop.js";

/**
 * Load the vendored polyfill as a classic script.
 * @returns {Promise<object>}  Resolves with the window.MobileDragDrop namespace.
 */
function loadVendorScript() {
  return new Promise((resolve, reject) => {
    if ( window.MobileDragDrop?.polyfill ) {
      resolve(window.MobileDragDrop);
      return;
    }
    const script = document.createElement("script");
    script.src = VENDOR_PATH;
    script.onload = () => resolve(window.MobileDragDrop);
    script.onerror = () => reject(new Error(`failed to load ${VENDOR_PATH}`));
    document.head.append(script);
  });
}

/**
 * Restrict the polyfill to draggable elements inside application windows.
 * Returning undefined tells the polyfill to ignore the touch entirely.
 * @param {TouchEvent} event
 * @returns {HTMLElement|undefined}
 */
function tryFindDraggableTarget(event) {
  const target = event?.target;
  if ( !(target instanceof Element) ) return undefined;
  if ( target.closest("#board, canvas") ) return undefined;  // never touch the game canvas
  const el = target.closest('.application [draggable="true"], .app [draggable="true"]');
  if ( !el ) return undefined;
  if ( el.closest("#board, canvas") ) return undefined;      // paranoia: canvas wins ties
  return el;
}

/**
 * Called from main.js during init. Early-returns without the pf-mobile flag.
 */
export function initDragDrop() {
  if ( !document.body?.classList.contains("pf-mobile") ) return;
  loadVendorScript().then(mdd => {
    if ( typeof mdd?.polyfill !== "function" ) {
      console.warn(`${MODULE_ID} | dragdrop: mobile-drag-drop loaded but exposes no polyfill(); skipping.`);
      return;
    }
    let applied = false;
    try {
      applied = mdd.polyfill({
        tryFindDraggableTarget,
        // Hold-to-drag keeps quick flicks scrolling item lists instead of dragging.
        holdToDrag: 300
      }) === true;
    } catch(err) {
      console.warn(`${MODULE_ID} | dragdrop: polyfill initialization failed.`, err);
      return;
    }
    if ( !applied ) {
      console.debug(`${MODULE_ID} | dragdrop: polyfill declined to apply (native drag-and-drop deemed available).`);
      return;
    }
    // Documented iOS workaround (mobile-drag-drop README): a non-passive window
    // touchmove listener so the polyfill's preventDefault can stop scrolling.
    try {
      window.addEventListener("touchmove", () => {}, { passive: false });
    } catch(err) { /* older engines without options support default to non-passive */ }
    console.debug(`${MODULE_ID} | dragdrop: mobile-drag-drop active (application windows only; canvas excluded).`);
  }).catch(err => console.warn(`${MODULE_ID} | dragdrop: ${err.message}`));
}
