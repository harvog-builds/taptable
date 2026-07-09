/**
 * taptable — dnd5e shadow-root widget touch patches (M1).
 *
 * dnd5e 5.3.3 sheet widgets are custom elements; several use closed shadow roots with
 * adopted stylesheets built lazily from a static `CSS` string (AdoptedStyleSheetMixin,
 * dnd5e.mjs:50636-50668). Document-level CSS cannot reach those internals, so we append
 * touch-target CSS to `customElements.get(tag).CSS` at the top of the init hook —
 * Foundry evaluates all esmodules before `init` fires, and the per-document stylesheet
 * cache (`static _stylesheets`, a WeakMap) only fills on first render, so the append
 * lands before compilation.
 *
 * Race hardening: if a cached CSSStyleSheet already exists for this document, we
 * `replaceSync` it with the patched CSS — mutating an adopted sheet live-updates every
 * root that adopted it, including closed shadow roots.
 *
 * Reality check on 5.3.3 (recorded so future readers aren't surprised): only
 * dnd5e-checkbox (dnd5e.mjs:50712) and proficiency-cycle (dnd5e.mjs:65075) declare
 * their own static CSS. slide-toggle inherits CheckboxElement's CSS but renders in
 * light DOM (useShadowRoot = false, dnd5e.mjs:65309). damage-application and
 * effect-application extend ChatTrayElement -> core AdoptableHTMLElement and have NO
 * static CSS at all — they render in light DOM. Every patch path below is therefore
 * feature-detected: a tag without the adopted-CSS pattern logs a console.warn and
 * no-ops, and the light-DOM equivalents are styled by styles/pf-dnd5e.css instead.
 */

const MODULE_ID = "taptable";
const PATCH_MARKER = "/* taptable touch patch */";

/**
 * Centered hit-area extension for small square widgets: an invisible ::after box
 * grown to 44x44px around the host. Events originating on a pseudo-element target
 * the host, and both patched widgets listen for clicks on the host itself
 * (dnd5e.mjs:65230-65234 proficiency-cycle; checkbox equivalent), so taps in the
 * extended zone activate the control. Guarded by (pointer: coarse) as a second
 * safety layer on top of the pf-mobile JS gate.
 */
const SQUARE_HIT_AREA = `
${PATCH_MARKER}
@media (pointer: coarse) {
  :host { position: relative; }
  :host::after {
    content: "";
    position: absolute;
    inset: calc((100% - 44px) / 2);
  }
}
`;

/**
 * Inert forward-compatibility patch for elements that render light-DOM today: if a
 * future dnd5e gives them shadow roots + static CSS, this still parses safely and
 * exposes a hook variable without guessing at unknown internals.
 */
const TRAY_TOUCH_HINT = `
${PATCH_MARKER}
@media (pointer: coarse) {
  :host { --pf-touch-target: 44px; }
}
`;

/**
 * The five tags named by the plan. Order matters: slide-toggle is patched before
 * dnd5e-checkbox so that each receives its own literal append (slide-toggle inherits
 * CheckboxElement.CSS; patching the parent first would make the child's marker check
 * see the inherited patch and skip).
 */
const TOUCH_PATCHES = {
  "slide-toggle": SQUARE_HIT_AREA,
  "dnd5e-checkbox": SQUARE_HIT_AREA,
  "proficiency-cycle": SQUARE_HIT_AREA,
  "damage-application": TRAY_TOUCH_HINT,
  "effect-application": TRAY_TOUCH_HINT
};

/**
 * Append touch CSS to one custom element class, with the replaceSync fallback.
 * Never throws: every failure path warns and no-ops.
 * @param {string} tag  Custom element tag name.
 * @param {string} css  CSS text to append.
 * @returns {boolean}   True if the class CSS now contains the patch.
 */
function patchElementCSS(tag, css) {
  let K;
  try {
    K = window.customElements?.get?.(tag);
  } catch(err) {
    K = undefined;
  }
  if ( !K ) {
    console.warn(`${MODULE_ID} | sheet5e: <${tag}> is not a defined custom element (renamed or removed in this dnd5e build?); skipping touch patch.`);
    return false;
  }
  if ( typeof K.CSS !== "string" ) {
    console.warn(`${MODULE_ID} | sheet5e: <${tag}> has no static CSS (adopted-stylesheet pattern absent in this dnd5e build); relying on light-DOM rules in pf-dnd5e.css.`);
    return false;
  }
  if ( K.CSS.includes(PATCH_MARKER) ) return true;  // already patched (own or inherited)
  try {
    K.CSS = `${K.CSS}\n${css}`;
    // Fallback: if the per-document sheet was already compiled (i.e. something rendered
    // before init finished), rewrite it in place — live-updates closed shadow roots.
    const cache = K._stylesheets;
    if ( cache instanceof WeakMap ) {
      const sheet = cache.get(document);
      if ( sheet && (typeof sheet.replaceSync === "function") ) sheet.replaceSync(K.CSS);
    }
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | sheet5e: failed to patch <${tag}> CSS; leaving stock styling.`, err);
    return false;
  }
}

/**
 * Entry point, called from main.js at the top of the init hook. Early-returns
 * without the pf-mobile flag and outside the dnd5e system.
 */
export function initSheet5e() {
  if ( !document.body?.classList.contains("pf-mobile") ) return;
  if ( game.system?.id !== "dnd5e" ) {
    console.debug(`${MODULE_ID} | sheet5e: system is not dnd5e; widget patches skipped.`);
    return;
  }
  for ( const [tag, css] of Object.entries(TOUCH_PATCHES) ) patchElementCSS(tag, css);
}
