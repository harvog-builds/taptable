/**
 * taptable — entry point (M2).
 *
 * Responsibilities:
 *  - Register the client-scoped `taptable.mode` setting (auto | phone | off).
 *  - Resolve phone detection at init and add `body.pf-mobile` (+ `pf-ios`) when active.
 *  - Expose the public API at game.modules.get("taptable").api:
 *    { isMobile, vh, registerTab, openCompendiumPicker } (+ active/mode
 *    diagnostics). registerTab is deliberately live on ALL clients (soft contract
 *    for other modules — it only mutates a registry; without pf-mobile the
 *    registry is never rendered). openCompendiumPicker likewise early-returns
 *    without pf-mobile, so exposing it on every client is harmless.
 *  - Dispatch to the sub-modules. Every sub-module ALSO early-returns without the
 *    pf-mobile flag, so no behavior can fire on a desktop client (zero desktop impact
 *    by construction).
 *
 * Detection deliberately does NOT trust screen.width alone: Chrome's "Desktop site"
 * toggle spoofs it (verified on-device, M0 baseline round 2). A phone must look like
 * a phone three ways at once: coarse pointer AND multi-touch AND a small screen.
 */
import { initSheet5e } from "./sheet5e.js";
import { initViewport } from "./viewport.js";
import { initDragDrop } from "./dragdrop.js";
import { initShell, registerTab, currentVh } from "./shell.js";
import { initCanvasTouch } from "./canvas-touch.js";
import { initTemplates } from "./templates.js";
import { openCompendiumPicker } from "./compendium.js";
import { initReconnect } from "./reconnect.js";

const MODULE_ID = "taptable";

/**
 * Phone detection per the approved plan:
 * (pointer: coarse) AND maxTouchPoints > 1 AND min(screen.w, screen.h) < 500.
 * @returns {boolean}
 */
function detectPhone() {
  try {
    return window.matchMedia("(pointer: coarse)").matches
      && navigator.maxTouchPoints > 1
      && Math.min(window.screen.width, window.screen.height) < 500;
  } catch(err) {
    console.warn(`${MODULE_ID} | phone detection failed; treating as non-phone.`, err);
    return false;
  }
}

/**
 * iOS/iPadOS detection (iPadOS 13+ masquerades as MacIntel with multi-touch).
 * @returns {boolean}
 */
function detectIOS() {
  try {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || ((navigator.platform === "MacIntel") && (navigator.maxTouchPoints > 1));
  } catch(err) {
    return false;
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "mode", {
    name: "Pocket Foundry Mode",
    hint: "auto: enable the phone UI only when a phone-sized touch device is detected. "
      + "phone: force the phone UI on for this client. off: never activate on this client.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: "Auto-detect (default)",
      phone: "Force phone UI",
      off: "Off"
    },
    default: "auto",
    requiresReload: true
  });

  let mode = "auto";
  try {
    mode = game.settings.get(MODULE_ID, "mode");
  } catch(err) {
    console.warn(`${MODULE_ID} | could not read mode setting; assuming "auto".`, err);
  }

  const active = (mode === "phone") || ((mode === "auto") && detectPhone());

  // Public API (M2): isMobile/vh/registerTab per the shell contract, plus
  // active/mode diagnostics kept from M1.
  const mod = game.modules.get(MODULE_ID);
  if ( mod ) mod.api = { isMobile: () => active, vh: currentVh, registerTab, openCompendiumPicker, active, mode };

  // mode=off or auto non-match: no body class, and nothing below ever runs.
  if ( !active ) return;

  document.body.classList.add("pf-mobile");
  if ( detectIOS() ) document.body.classList.add("pf-ios");

  // Order matters: the dnd5e widget CSS patch must run at the top of init, before
  // any sheet render can fill dnd5e's adopted-stylesheet caches (dnd5e.mjs:50660).
  initSheet5e();
  initViewport();
  initDragDrop();
  initShell();
  initCanvasTouch();
  initTemplates();
  initReconnect();
});
