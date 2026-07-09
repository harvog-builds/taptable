/**
 * taptable — viewport & keyboard manager (M1).
 *
 * Owns everything visual-viewport related on phones:
 *  - Maintains the `--pf-vh` custom property (px) from visualViewport.height, with a
 *    fallback chain visualViewport -> 100dvh -> 100vh. The property is set on the
 *    root element as an inline style; stylesheets consume it as
 *    `var(--pf-vh, 100dvh)`. This addresses core's open iOS 100vh/URL-bar issue and
 *    the "chat input below the visible viewport" failure measured in M0.
 *  - Toggles `body.pf-keyboard` when the visual viewport shrinks by more than
 *    KEYBOARD_THRESHOLD_PX (on-screen keyboard heuristic) and scrolls the focused
 *    editable element into view.
 *  - Rewrites the viewport meta to add `interactive-widget=resizes-content` so
 *    Android Chrome resizes layout (and thus visualViewport) when the keyboard opens.
 *  - Suppresses core's permanent "requires usable window dimensions of 1024px by
 *    768px" error notification (client-issues.mjs:185-191, i18n ERROR.RESOLUTION.*),
 *    which would otherwise greet every phone player at boot. Suppression exists ONLY
 *    under body.pf-mobile: this module never touches desktop behavior.
 */

const MODULE_ID = "taptable";
const KEYBOARD_THRESHOLD_PX = 150;

/* -------------------------------------------- */
/*  --pf-vh maintenance                         */
/* -------------------------------------------- */

/**
 * Set the --pf-vh custom property on the document root.
 * @param {string} value  A CSS length ("812px", "100dvh", "100vh").
 */
function setVh(value) {
  try {
    document.documentElement.style.setProperty("--pf-vh", value);
  } catch(err) {
    console.warn(`${MODULE_ID} | viewport: failed to set --pf-vh.`, err);
  }
}

/**
 * Scroll the currently focused editable element into view (keyboard just opened).
 */
function scrollFocusedIntoView() {
  const el = document.activeElement;
  if ( !el || (el === document.body) ) return;
  const editable = el.isContentEditable
    || el.matches?.("input, textarea, select, [contenteditable], [contenteditable] *");
  if ( !editable ) return;
  window.setTimeout(() => {
    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch(err) {
      try { el.scrollIntoView(); } catch(err2) { /* element vanished; nothing to do */ }
    }
  }, 50);
}

/**
 * Start tracking the visual viewport. Baseline = tallest height seen since load or
 * last orientation change; a drop of more than KEYBOARD_THRESHOLD_PX from baseline
 * is treated as the on-screen keyboard.
 */
function startVhTracking() {
  const vv = window.visualViewport;
  if ( !vv ) {
    let unit = "100vh";
    try {
      if ( window.CSS?.supports?.("height", "100dvh") ) unit = "100dvh";
    } catch(err) { /* keep 100vh */ }
    setVh(unit);
    console.warn(`${MODULE_ID} | viewport: visualViewport API unavailable; --pf-vh pinned to ${unit} (no keyboard detection).`);
    return;
  }

  let baseline = vv.height;

  const update = () => {
    const h = vv.height;
    baseline = Math.max(baseline, h);
    setVh(`${Math.round(h)}px`);
    const keyboardOpen = (baseline - h) > KEYBOARD_THRESHOLD_PX;
    const wasOpen = document.body.classList.contains("pf-keyboard");
    document.body.classList.toggle("pf-keyboard", keyboardOpen);
    if ( keyboardOpen && !wasOpen ) scrollFocusedIntoView();
  };

  // Rotation invalidates the baseline (portrait height would flag a phantom keyboard
  // in landscape). Re-seed shortly after the rotation settles.
  const resetBaseline = () => {
    window.setTimeout(() => {
      baseline = vv.height;
      update();
    }, 350);
  };

  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  try {
    window.screen?.orientation?.addEventListener?.("change", resetBaseline);
  } catch(err) { /* screen.orientation missing on some engines */ }
  window.addEventListener("orientationchange", resetBaseline);
  update();
}

/* -------------------------------------------- */
/*  Viewport meta rewrite                       */
/* -------------------------------------------- */

/**
 * Append interactive-widget=resizes-content to the core viewport meta
 * (templates/views/layouts/main.hbs ships without it). Existing directives —
 * including user-scalable=no, which M5's gesture layer depends on — are preserved.
 */
function rewriteViewportMeta() {
  try {
    const meta = document.querySelector('meta[name="viewport"]');
    if ( !meta ) {
      console.warn(`${MODULE_ID} | viewport: no <meta name="viewport"> found; skipping rewrite.`);
      return;
    }
    const content = meta.getAttribute("content") ?? "";
    if ( /interactive-widget/.test(content) ) return;
    meta.setAttribute("content", content ? `${content}, interactive-widget=resizes-content` : "interactive-widget=resizes-content");
  } catch(err) {
    console.warn(`${MODULE_ID} | viewport: viewport meta rewrite failed.`, err);
  }
}

/* -------------------------------------------- */
/*  Small-window notification suppression       */
/* -------------------------------------------- */

/**
 * Build match patterns for core's resolution error. Uses the localized
 * ERROR.RESOLUTION.Window/Scale templates (placeholders wildcarded) so suppression
 * survives non-English locales, with a literal English fallback.
 * @returns {RegExp[]}
 */
function buildSuppressPatterns() {
  const patterns = [/usable window dimensions/i];
  for ( const key of ["ERROR.RESOLUTION.Window", "ERROR.RESOLUTION.Scale"] ) {
    try {
      const tpl = game.i18n?.localize?.(key);
      if ( tpl && (tpl !== key) ) {
        const source = tpl
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\\\{.*?\\\}/g, ".*");
        patterns.push(new RegExp(source.slice(0, 500)));
      }
    } catch(err) { /* English fallback already present */ }
  }
  return patterns;
}

/**
 * Remove the core small-window error notification, now and whenever it re-fires
 * (client-issues.mjs re-validates on every window resize — which on phones includes
 * keyboard open/close). Removal goes through ui.notifications.remove(id) via the
 * notification li's data-id (notifications.mjs:391) so core's internal state stays
 * consistent; direct element removal is the last-resort fallback.
 */
function suppressSmallWindowNotice() {
  if ( !document.body?.classList.contains("pf-mobile") ) return;
  const list = document.getElementById("notifications");
  if ( !list ) {
    console.warn(`${MODULE_ID} | viewport: #notifications element not found; cannot suppress the small-window notice.`);
    return;
  }
  const patterns = buildSuppressPatterns();
  const kill = () => {
    for ( const li of list.querySelectorAll("li.notification") ) {
      const text = li.textContent ?? "";
      if ( !patterns.some(rx => rx.test(text)) ) continue;
      const id = Number(li.dataset?.id);
      try {
        if ( (id > 0) && ui?.notifications?.remove ) ui.notifications.remove(id);
        else li.remove();
      } catch(err) {
        try { li.remove(); } catch(err2) { /* already gone */ }
      }
    }
  };
  kill();
  try {
    new MutationObserver(kill).observe(list, { childList: true });
  } catch(err) {
    console.warn(`${MODULE_ID} | viewport: could not observe #notifications; suppression is one-shot.`, err);
  }
}

/* -------------------------------------------- */
/*  Entry point                                 */
/* -------------------------------------------- */

/**
 * Called from main.js during init. Early-returns without the pf-mobile flag.
 */
export function initViewport() {
  if ( !document.body?.classList.contains("pf-mobile") ) return;
  rewriteViewportMeta();
  startVhTracking();
  // ui.notifications exists from init, but the boot-time validation fires around
  // ready; hook there and keep the MutationObserver for later re-fires.
  Hooks.once("ready", suppressSmallWindowNotice);
}
