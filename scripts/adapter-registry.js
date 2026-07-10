/**
 * taptable — per-system adapter registry.
 *
 * Resolves a SystemAdapter for the active game system (by game.system.id). All
 * system-specific integration (character sheet, rolls, compendium taxonomy, AoE
 * template placement) lives in adapters/<systemId>.js, which self-registers by
 * importing this module and calling registerSystemAdapter() at load. Any consumer
 * calls resolveAdapter() and gets either the active system's adapter or the
 * NullAdapter — a complete no-op / empty implementation that IS the graceful-
 * degradation path on unsupported systems.
 *
 * Third parties can add support for a system by shipping (or runtime-registering, via
 * game.modules.get("taptable").api.registerSystemAdapter) an adapter for their
 * system id — no core changes required. A partial adapter is fine: registerSystemAdapter
 * merges it over NullAdapter, so any method it omits degrades to a safe no-op.
 */

const MODULE_ID = "taptable";
const _adapters = new Map();

/**
 * The graceful-degradation adapter. Every method returns empty / no-op so that, on a
 * system with no registered adapter, system-specific panes render empty-states and
 * nothing throws. System-agnostic core fallbacks (e.g. core initiative) live here too.
 */
export const NullAdapter = {
  id: null,

  // --- character sheet ---
  isSystemSheet(_app) { return false; },
  sheetTouchPatches() { /* no-op: no system widgets to patch */ },

  // --- home pane (vitals / favorites) ---
  getVitals(_actor) { return null; },          // null → Home hides the vitals block
  getFavorites(_actor) { return []; },          // [] → Home hides the favorites block
  async useFavorite(_doc) { /* no-op */ },
  async adjustHp(_actor, _delta) { /* no-op */ },

  // --- roller ---
  getRollables(_actor) { return null; },        // null → roller shows the manual builder only
  async roll(_actor, _kind, _key, _opts) { /* no-op */ },

  // --- combat ---
  async rollInitiative(actor) {                  // system-agnostic core fallback
    try { return await actor?.rollInitiative?.({ createCombatants: true }); }
    catch(err) { console.warn(`${MODULE_ID} | NullAdapter.rollInitiative failed`, err); }
  },

  // --- compendium ---
  getCompendiumCategories() { return null; },    // null → compendium shows a single "Items" bucket

  // --- AoE templates ---
  interceptTemplatePlacement(_installPreview) { return false; }  // false → no system AoE intercept
};

/**
 * Register a SystemAdapter for a system id. The adapter is merged over NullAdapter, so
 * partial adapters degrade safely. Last registration wins (a user override module can
 * replace a bundled adapter).
 * @param {string} systemId  e.g. "dnd5e"
 * @param {object} adapter   partial or full SystemAdapter
 */
export function registerSystemAdapter(systemId, adapter) {
  if ( !systemId || !adapter ) return;
  _adapters.set(systemId, { ...NullAdapter, ...adapter, id: systemId });
}

/**
 * Resolve the adapter for the active game system, or the NullAdapter if none registered.
 * @returns {object} a SystemAdapter (never null)
 */
export function resolveAdapter() {
  const id = game?.system?.id;
  return (id && _adapters.get(id)) || NullAdapter;
}
