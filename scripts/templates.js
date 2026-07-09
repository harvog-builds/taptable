/**
 * taptable — 235-1 AoE MeasuredTemplate NATIVE tap-to-place (templates.js).
 *
 * Problem: dnd5e's AbilityTemplate placement (dnd5e.mjs:16378 activatePreviewListeners)
 * binds `canvas.stage.on("mousemove")` / `("mouseup")` + `view.onwheel` / `oncontextmenu`
 * — none of which PIXI 7.4.3 emits for TOUCH pointers, and it hides the grid under the
 * thumb while fighting our pan/zoom. So on phones spell/ability AoE templates cannot be
 * placed at all.
 *
 * Design (frozen — spec Feature D, ~/reviews/2026-07-09-taptable-combat-spec.md:143):
 * do NOT rebind dnd5e's private #events closure. Build OUR OWN placement flow:
 *  - Intercept dnd5e AbilityTemplate.prototype.drawPreview (dnd5e.mjs:16353) under
 *    pf-mobile via libWrapper (fallback: a one-client prototype patch, then a manual
 *    entry) and launch our placement instead of dnd5e's mouse flow. `fromActivity`
 *    (dnd5e.mjs:16266) has already built the template document + shape on the intercepted
 *    instance (`this`), so we drive position/direction ourselves from taps + buttons.
 *  - A SINGLE canvas tap sets the template ORIGIN (federated getLocalPosition against
 *    canvas.templates, or canvas.mousePosition). We bind `canvas.stage.on("pointerup")`
 *    (pointer* IS touch-compatible in PIXI 7.4.3, unlike mouse*). We NEVER stopPropagation
 *    a canvas gesture: canvas-touch.js already swallows pan/pinch in the capture phase
 *    before they reach PIXI (canvas-touch.js:23-33), so only genuine taps arrive here and
 *    pan/zoom stays fully UNLOCKED during placement — the overlay buttons are the controls.
 *  - An on-screen DOM overlay (above the canvas) with Rotate -/+ (adjust
 *    template.document.direction + redraw), Scale -/+ (adjust distance where the shape
 *    supports it), Confirm and Cancel — all >=44px, torn down on confirm/cancel.
 *  - Confirm -> canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [doc.toObject()])
 *    (a WORLD WRITE, mirroring dnd5e._onConfirmPlacement dnd5e.mjs:16478). Cancel discards
 *    the preview with no write.
 *
 * Desktop zero-impact: initTemplates() early-returns without body.pf-mobile and is DISABLED
 * off generation 14, so the libWrapper intercept is never even registered on a desktop
 * client — dnd5e's normal mouse flow runs completely unchanged there.
 */

const MODULE_ID = "taptable";

/** Overlay DOM id (also the CSS hook: body.pf-mobile #pf-template-overlay in pf-core.css). */
const OVERLAY_ID = "pf-template-overlay";

/** Degrees per Rotate press. dnd5e uses 15 on square grids (dnd5e.mjs:16465, `delta`). */
const ROTATE_STEP = 15;

/** The single in-flight placement controller, or null when idle. */
let controller = null;

/** How the drawPreview intercept was installed: "libWrapper" | "manual-patch" | null. */
let interceptInstalled = null;

/** pf-mobile flag test — the whole feature is gated on it (desktop zero-impact). */
function isActive() {
  return document.body?.classList.contains("pf-mobile") === true;
}

/* ============================================================= */
/*  Placement controller                                          */
/* ============================================================= */

/**
 * Drives one native tap-to-place session against a MeasuredTemplate-like object
 * (dnd5e AbilityTemplate from the intercept, or a core MeasuredTemplate from the manual
 * entry — both extend foundry.canvas.placeables.MeasuredTemplate so the flow is shared).
 */
class TemplatePlacement {
  /**
   * @param {object} object          A MeasuredTemplate/AbilityTemplate instance (has
   *                                  .document, .draw(), .layer, .refresh()).
   * @param {CanvasLayer} initialLayer  Layer to re-activate when placement ends.
   * @param {Function} resolve        Resolves the drawPreview promise: the created docs
   *                                  on confirm, or null on cancel (dnd5e #placeTemplate
   *                                  does `if (result) templates.push(result)`).
   */
  constructor(object, initialLayer, resolve) {
    this.object = object;
    this.document = object.document;
    this.initialLayer = initialLayer;
    this.resolve = resolve;
    this.overlay = null;
    this._finished = false;
    this._onTap = this.setOriginFromEvent.bind(this);
  }

  /** The templates canvas layer (canvas.templates). */
  get layer() {
    return this.object.layer ?? canvas.templates;
  }

  /** Begin placement: seed a visible preview at the view centre, arm the tap listener,
   *  build the overlay. */
  start() {
    // Seed the origin at the current view centre (canvas.stage.pivot is the world point
    // centred in the viewport) so a preview is visible immediately, before the first tap.
    const pivot = canvas?.stage?.pivot ?? { x: 0, y: 0 };
    const seed = this.layer.getSnappedPoint({ x: pivot.x, y: pivot.y });
    this.document.updateSource({ x: seed.x, y: seed.y });

    // Draw the preview into the templates layer's preview container. Mirrors dnd5e
    // AbilityTemplate#drawPreview (dnd5e.mjs:16355-16357) minus its mouse listeners.
    // draw() is async and NOT awaited (as dnd5e does); its rejection is swallowed so a
    // headless SwiftShader render hang/throw can't break the (still-usable) state machine.
    try {
      Promise.resolve(this.object.draw()).catch((err) =>
        console.warn(`${MODULE_ID} | templates: preview draw failed (headless render?); state machine still active, visual preview PENDING-DEVICE.`, err));
      this.layer.activate();
      this.layer.preview.addChild(this.object);
    } catch (err) {
      console.warn(`${MODULE_ID} | templates: preview attach failed (headless render?); state machine still active.`, err);
    }

    // Single canvas tap sets the origin. pointerup is touch-compatible in PIXI 7.4.3
    // (mouseup is not); pan/pinch never reach here (canvas-touch.js swallows them in the
    // capture phase), so panning stays UNLOCKED throughout.
    canvas?.stage?.on("pointerup", this._onTap);

    this.buildOverlay();
  }

  /** Federated tap -> world origin. Prefer getLocalPosition against canvas.templates;
   *  fall back to canvas.mousePosition (both are federated/world coords). */
  setOriginFromEvent(event) {
    const local = event?.data?.getLocalPosition?.(canvas.templates)
      ?? event?.getLocalPosition?.(canvas.templates)
      ?? canvas?.mousePosition;
    if (local) this.setOrigin(local);
  }

  /** Snap + move the preview origin. */
  setOrigin({ x, y }) {
    const snapped = this.layer.getSnappedPoint({ x, y });
    this.document.updateSource({ x: snapped.x, y: snapped.y });
    this.refresh();
    return this.snapshot();
  }

  /** Rotate the preview by ROTATE_STEP degrees (dir sign). Rect shapes don't rotate
   *  (dnd5e.mjs:16462). Returns the new direction. */
  rotate(dir = 1) {
    if (this.document.t === "rect") return this.document.direction;
    const step = ROTATE_STEP * Math.sign(dir || 1);
    this.document.updateSource({ direction: this.document.direction + step });
    this.refresh();
    return this.document.direction;
  }

  /** Grow/shrink the preview distance by one grid unit (dir sign), clamped >= one unit.
   *  Returns the new distance. */
  scale(dir = 1) {
    const unit = canvas?.dimensions?.distance ?? 5;
    const next = Math.max(unit, (this.document.distance ?? unit) + (unit * Math.sign(dir || 1)));
    this.document.updateSource({ distance: next });
    this.refresh();
    return this.document.distance;
  }

  /** Redraw the PIXI preview. Guarded: a headless render hang/throw must not corrupt the
   *  (already-updated) document state. */
  refresh() {
    try { this.object.refresh(); } catch (err) { /* headless render — state is authoritative */ }
  }

  /** Confirm: snap the final origin, WRITE the template to the scene, resolve with the
   *  created docs. Mirrors dnd5e._onConfirmPlacement (dnd5e.mjs:16478-16483). */
  async confirm() {
    if (this._finished) return null;
    const dest = canvas.templates.getSnappedPoint({ x: this.document.x, y: this.document.y });
    this.document.updateSource(dest);
    const data = this.document.toObject();
    this.teardown();
    // WORLD WRITE — the only write this module makes for AoE placement.
    const created = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [data]);
    this.resolve(created);
    return created;
  }

  /** Cancel: discard the preview with NO write; resolve null so dnd5e skips it. */
  cancel() {
    if (this._finished) return;
    this.teardown();
    this.resolve(null);
  }

  /** Tear down the tap listener, the preview container and the overlay; restore the layer. */
  teardown() {
    if (this._finished) return;
    this._finished = true;
    canvas?.stage?.off("pointerup", this._onTap);
    try { this.layer.clearPreviewContainer(); } catch (err) { /* preview already gone */ }
    try { this.initialLayer?.activate?.(); } catch (err) { /* layer gone */ }
    this.destroyOverlay();
    if (controller === this) controller = null;
  }

  /** Structural snapshot for probes/diagnostics (no PIXI reads). */
  snapshot() {
    return {
      t: this.document.t,
      x: this.document.x,
      y: this.document.y,
      direction: this.document.direction,
      distance: this.document.distance,
      overlay: !!this.overlay && document.body.contains(this.overlay)
    };
  }

  /** Build the on-screen DOM overlay (Rotate -/+, Scale -/+, Cancel, Confirm). */
  buildOverlay() {
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "pf-template-overlay";
    overlay.setAttribute("role", "toolbar");
    overlay.setAttribute("aria-label", "Place template");
    overlay.innerHTML = `
      <div class="pf-tpl-row">
        <button type="button" class="pf-tpl-btn" data-action="rotate-ccw" aria-label="Rotate counter-clockwise">&#8630;</button>
        <button type="button" class="pf-tpl-btn" data-action="rotate-cw" aria-label="Rotate clockwise">&#8631;</button>
        <button type="button" class="pf-tpl-btn" data-action="scale-down" aria-label="Shrink template">&minus;</button>
        <button type="button" class="pf-tpl-btn" data-action="scale-up" aria-label="Grow template">&plus;</button>
      </div>
      <div class="pf-tpl-row">
        <button type="button" class="pf-tpl-btn pf-tpl-cancel" data-action="cancel">Cancel</button>
        <button type="button" class="pf-tpl-btn pf-tpl-confirm" data-action="confirm">Confirm</button>
      </div>`;
    overlay.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("[data-action]");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      switch (btn.dataset.action) {
        case "rotate-ccw": this.rotate(-1); break;
        case "rotate-cw": this.rotate(1); break;
        case "scale-down": this.scale(-1); break;
        case "scale-up": this.scale(1); break;
        case "cancel": this.cancel(); break;
        case "confirm": this.confirm(); break;
      }
    });
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  destroyOverlay() {
    try { this.overlay?.remove(); } catch (err) { /* already detached */ }
    this.overlay = null;
  }
}

/* ============================================================= */
/*  Entry points                                                  */
/* ============================================================= */

/**
 * Launch a placement session. Cancels any prior session first, then resolves the returned
 * promise with the created docs (confirm) or null (cancel).
 * @param {object} object            A MeasuredTemplate/AbilityTemplate instance.
 * @param {CanvasLayer} initialLayer Layer to re-activate on finish.
 * @returns {Promise}
 */
function beginPlacement(object, initialLayer) {
  if (controller) controller.cancel();
  return new Promise((resolve) => {
    controller = new TemplatePlacement(object, initialLayer, resolve);
    controller.start();
  });
}

/**
 * Documented manual fallback entry (spec Feature D:164) AND the probe's structural entry
 * point: build a bare core MeasuredTemplate of the requested shape/size and start placement
 * without needing a dnd5e activity. pf-mobile + gen 14 only.
 * @param {object} [opts]  { t, distance, direction, width, x, y }
 * @returns {Promise|null}
 */
function startManualPlacement(opts = {}) {
  if (!isActive() || game.release?.generation !== 14) return null;
  if (!canvas?.scene) return null;
  const t = opts.t ?? "circle";
  const pivot = canvas?.stage?.pivot ?? { x: 0, y: 0 };
  const data = {
    t,
    user: game.user.id,
    distance: Number(opts.distance ?? 20),
    direction: Number(opts.direction ?? 0),
    x: Number(opts.x ?? pivot.x),
    y: Number(opts.y ?? pivot.y),
    fillColor: game.user.color
  };
  if (t === "cone") data.angle = CONFIG.MeasuredTemplate.defaults.angle;
  if (t === "ray") data.width = Number(opts.width ?? canvas.dimensions.distance);
  const cls = CONFIG.MeasuredTemplate.documentClass;
  const doc = new cls(data, { parent: canvas.scene });
  const object = new CONFIG.MeasuredTemplate.objectClass(doc);
  return beginPlacement(object, canvas.activeLayer);
}

/**
 * Install the drawPreview intercept: under pf-mobile, dnd5e AbilityTemplate placement is
 * replaced by our native tap-to-place. libWrapper preferred; a one-client prototype patch
 * is the fallback if libWrapper is absent/fails. Off-mobile / off-gen-14 the wrapper defers
 * to dnd5e's original (and on desktop this is never even registered).
 */
function registerInterceptor() {
  const AbilityTemplate = globalThis.dnd5e?.canvas?.AbilityTemplate ?? game.dnd5e?.canvas?.AbilityTemplate;
  if (!AbilityTemplate?.prototype) {
    console.warn(`${MODULE_ID} | templates: dnd5e AbilityTemplate not found; native intercept NOT installed. Manual entry available at game.modules.get("${MODULE_ID}").api.templates.startManual().`);
    return;
  }

  if (globalThis.libWrapper?.register) {
    try {
      libWrapper.register(MODULE_ID, "dnd5e.canvas.AbilityTemplate.prototype.drawPreview",
        function (wrapped, ...args) {
          if (!isActive() || game.release?.generation !== 14) return wrapped(...args);
          return beginPlacement(this, canvas.activeLayer);
        }, "MIXED");
      interceptInstalled = "libWrapper";
      return;
    } catch (err) {
      console.warn(`${MODULE_ID} | templates: libWrapper registration failed; falling back to a one-client prototype patch.`, err);
    }
  }

  // Fallback: patch the prototype on THIS client only (this whole module early-returns
  // without pf-mobile, so no desktop client ever reaches here).
  const proto = AbilityTemplate.prototype;
  const original = proto.drawPreview;
  proto.drawPreview = function (...args) {
    if (!isActive() || game.release?.generation !== 14) return original.apply(this, args);
    return beginPlacement(this, canvas.activeLayer);
  };
  interceptInstalled = "manual-patch";
}

/**
 * taptable entry for the AoE tap-to-place feature. Called from main.js during init.
 * Early-returns without pf-mobile (desktop zero-impact) and off generation 14.
 */
export function initTemplates() {
  if (!isActive()) return;

  const gen = game.release?.generation;
  if (gen !== 14) {
    console.warn(`${MODULE_ID} | templates: Foundry generation ${gen} !== 14; native AoE tap-to-place is DISABLED (verify the MeasuredTemplate/AbilityTemplate API before enabling for a new core).`);
    return;
  }

  // Register the intercept after the system is fully set up (dnd5e.canvas.AbilityTemplate
  // is a top-level global by then).
  Hooks.once("setup", registerInterceptor);

  // Public API — probe/diagnostics + the manual fallback entry. Attached only inside the
  // pf-mobile + gen-14 path (mirrors canvas-touch.js's canvasGesture diagnostics), so a
  // desktop client never sees any of it.
  try {
    const mod = game.modules.get(MODULE_ID);
    if (mod?.api) {
      mod.api.templates = {
        active: () => !!controller,
        state: () => (controller ? controller.snapshot() : null),
        intercept: () => interceptInstalled,
        // Documented manual fallback + probe entry (spec Feature D:164).
        startManual: (opts) => startManualPlacement(opts),
        // Probe-only helpers: they mutate ONLY the in-memory preview document (NO world
        // write). Confirm is deliberately NOT exposed — the first live commit is the
        // user's (createEmbeddedDocuments is a world write).
        _test: {
          tap: (x, y) => (controller ? controller.setOrigin({ x, y }) : null),
          rotate: (dir = 1) => (controller ? controller.rotate(dir) : null),
          scale: (dir = 1) => (controller ? controller.scale(dir) : null),
          cancel: () => (controller ? controller.cancel() : null)
        }
      };
    }
  } catch (err) { /* diagnostics are optional */ }
}
