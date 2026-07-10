/**
 * taptable — dnd5e reference SystemAdapter.
 *
 * This is the ONE place dnd5e-shaped knowledge lives. It self-registers at load
 * (registerSystemAdapter("dnd5e", { ... })), so importing it for its side effect
 * (main.js: `import "../adapters/dnd5e.js"`) is all that is needed to light up dnd5e
 * integration. The system-agnostic core (shell.js, roller.js, compendium.js,
 * templates.js, main.js) never reaches into dnd5e directly — it calls
 * resolveAdapter().<method>() and gets this on dnd5e, or the NullAdapter (safe
 * no-ops / empty results) on every other system.
 *
 * The interface + its degradation contract are defined by NullAdapter in
 * scripts/adapter-registry.js; every method below matches those signatures exactly.
 *
 * dnd5e 5.3.3 facts these methods rely on (dist line numbers from the installed
 * /home/foundry/Data/systems/dnd5e/dnd5e.mjs — recorded so future readers can
 * re-verify against a new dnd5e build):
 *  - Sheet widgets: dnd5e-checkbox (dnd5e.mjs:50712) and proficiency-cycle (:65075)
 *    declare a static `CSS` string compiled lazily into closed shadow roots via
 *    AdoptedStyleSheetMixin (:50636-50668); appending to `customElements.get(tag).CSS`
 *    before first render lands the patch. slide-toggle inherits CheckboxElement.CSS;
 *    damage-/effect-application render light-DOM (styled by adapters/dnd5e.css).
 *  - Rolls: Actor5e#rollAbilityCheck (:37418), #rollSavingThrow (:37440), #rollSkill
 *    (:37194). Advantage travels as config.advantage/disadvantage (folded into
 *    roll.options.advantageMode, :78851-78855); the manual modifier as the dialog's
 *    own @situational mechanism (:19809-19812); dialog.configure=false skips the
 *    usage dialog (:68419) so a single tap executes the roll.
 *  - Displayed modifiers read what dnd5e prepares on actor.system: ability check =
 *    mod + checkBonus + numeric checkProf.flat (:26571-26572); save = save.value
 *    (:26574-26575); skill = skills[k].total (:71828-71829).
 *  - Favorites: actor.system.favorites as {type, id, sort} with actor-relative UUID
 *    ids (:58440-58450); item/activity favorites activate via .use().
 *  - Vitals: actor.system.attributes.hp / .hd / .death.
 *  - Initiative: Actor5e#rollInitiativeDialog (:37842), core fallback
 *    actor.rollInitiative({createCombatants:true}).
 *  - AoE: dnd5e.canvas.AbilityTemplate#drawPreview (:16353) is the placement entry.
 */

import { registerSystemAdapter } from "../scripts/adapter-registry.js";

const MODULE_ID = "taptable";

/** Localize / format a TAPTABLE.* key. Defined at module scope but only ever CALLED
 *  from adapter methods invoked at render / roll time (post-i18nInit) — never at
 *  module scope (this file is imported for its side effect at parse time, long
 *  before i18n exists). */
const t = key => game.i18n.localize(key);
const tf = (key, data) => game.i18n.format(key, data);

/* ============================================================= */
/*  Character sheet — touch patches + detection                  */
/* ============================================================= */

const PATCH_MARKER = "/* taptable touch patch */";

/**
 * Centered hit-area extension for small square widgets: an invisible ::after box
 * grown to 44x44px around the host. Events on a pseudo-element target the host, and
 * both patched widgets listen for clicks on the host itself (dnd5e.mjs:65230-65234
 * proficiency-cycle; checkbox equivalent), so taps in the extended zone activate the
 * control. Guarded by (pointer: coarse) on top of the pf-mobile JS gate.
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
 * dnd5e-checkbox so each receives its own literal append (slide-toggle inherits
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
    console.warn(`${MODULE_ID} | dnd5e adapter: <${tag}> is not a defined custom element (renamed or removed in this dnd5e build?); skipping touch patch.`);
    return false;
  }
  if ( typeof K.CSS !== "string" ) {
    console.warn(`${MODULE_ID} | dnd5e adapter: <${tag}> has no static CSS (adopted-stylesheet pattern absent in this dnd5e build); relying on light-DOM rules in adapters/dnd5e.css.`);
    return false;
  }
  if ( K.CSS.includes(PATCH_MARKER) ) return true;  // already patched (own or inherited)
  try {
    K.CSS = `${K.CSS}\n${css}`;
    // Fallback: if the per-document sheet was already compiled (something rendered
    // before init finished), rewrite it in place — live-updates closed shadow roots.
    const cache = K._stylesheets;
    if ( cache instanceof WeakMap ) {
      const sheet = cache.get(document);
      if ( sheet && (typeof sheet.replaceSync === "function") ) sheet.replaceSync(K.CSS);
    }
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | dnd5e adapter: failed to patch <${tag}> CSS; leaving stock styling.`, err);
    return false;
  }
}

/** The application's root HTMLElement (AppV2 exposes it directly; V1 wraps in jQuery). */
function elementOf(app) {
  return (app?.element instanceof HTMLElement) ? app.element : app?.element?.[0];
}

/* ============================================================= */
/*  Roller — modifier math                                       */
/* ============================================================= */

/**
 * The numeric flat value of a dnd5e Proficiency object, or 0 when absent/non-numeric
 * — mirroring dnd5e's own display logic (Number.isNumeric guard, dnd5e.mjs:26575/
 * :71829; Number.isNumeric is the foundry primitive extension).
 */
function profFlat(prof) {
  try {
    if ( !prof ) return 0;
    const numeric = (typeof Number.isNumeric === "function")
      ? Number.isNumeric(prof.term)
      : Number.isFinite(Number(prof.term));
    return numeric ? (prof.flat ?? 0) : 0;
  } catch(err) {
    return 0;
  }
}

/** Ability CHECK total as dnd5e prepares it: mod + checkBonus + numeric prof. */
function abilityCheckTotal(abl) {
  return (abl?.mod ?? 0) + (abl?.checkBonus ?? 0) + profFlat(abl?.checkProf);
}

/** Saving-throw total: dnd5e prepares abilities[k].save.value. */
function saveTotal(abl) {
  if ( typeof abl?.save?.value === "number" ) return abl.save.value;
  return (abl?.mod ?? 0) + (abl?.saveBonus ?? 0) + profFlat(abl?.saveProf);
}

/** Skill total: dnd5e prepares skills[k].total. */
function skillTotal(sk) {
  if ( typeof sk?.total === "number" ) return sk.total;
  return (sk?.mod ?? 0) + (sk?.bonus ?? 0) + profFlat(sk?.prof);
}

/* ============================================================= */
/*  Compendium taxonomy                                          */
/* ============================================================= */

/**
 * Category selector -> dnd5e Item subtypes. Order is the display order of the
 * category buttons in the Compendium Add picker.
 * TIMING: this module-scope constant is evaluated at parse time, BEFORE i18n exists —
 * so `label` holds the localization KEY; getCompendiumCategories() localizes it when
 * the picker opens (user-tap time, long after i18nInit).
 * @type {Array<{id:string, label:string, types:string[]}>}
 */
const COMPENDIUM_CATEGORIES = [
  { id: "items",      label: "TAPTABLE.CategoryItems",      types: ["weapon", "equipment", "consumable", "tool", "loot", "container"] },
  { id: "spells",     label: "TAPTABLE.CategorySpells",     types: ["spell"] },
  { id: "feats",      label: "TAPTABLE.CategoryFeats",      types: ["feat"] },
  { id: "features",   label: "TAPTABLE.CategoryFeatures",   types: ["feat", "subclass"] },
  { id: "species",    label: "TAPTABLE.CategorySpecies",    types: ["race"] },
  { id: "background", label: "TAPTABLE.CategoryBackground", types: ["background"] },
  { id: "class",      label: "TAPTABLE.CategoryClass",      types: ["class", "subclass"] }
];

/* ============================================================= */
/*  The dnd5e adapter                                             */
/* ============================================================= */

const dnd5eAdapter = {

  /* --- character sheet --- */

  /**
   * Is this a dnd5e AppV2 actor sheet? Feature-detected two ways: instanceof the core
   * v14 ActorSheetV2 base AND the dnd5e2 root class — the shell's sheet-mode nav
   * mirrors dnd5e's vertical tab rail markup (nav.tabs, sidebar-tabs.hbs), so only a
   * genuine dnd5e actor sheet is tracked for it.
   */
  isSystemSheet(app) {
    try {
      const Base = foundry.applications?.sheets?.ActorSheetV2;
      if ( !Base || !(app instanceof Base) ) return false;
      return !!elementOf(app)?.classList.contains("dnd5e2");
    } catch(err) {
      return false;
    }
  },

  /**
   * Append touch-target CSS to dnd5e's custom-element widgets at the top of init,
   * before any sheet render can fill dnd5e's adopted-stylesheet caches. Light
   * pf-mobile guard for direct callers; the system guard is implicit (resolveAdapter
   * only returns this adapter on dnd5e).
   */
  sheetTouchPatches() {
    if ( !document.body?.classList.contains("pf-mobile") ) return;
    for ( const [tag, css] of Object.entries(TOUCH_PATCHES) ) patchElementCSS(tag, css);
  },

  /* --- home pane (vitals / favorites) --- */

  /**
   * Normalized vitals for the Home pane, or null (→ Home hides the vitals block).
   * @param {Actor} actor
   * @returns {{hp:{value:number,max:number,temp:number}, hitDice:(object|null), death:(object|null)}|null}
   */
  getVitals(actor) {
    const hp = foundry.utils.getProperty(actor ?? {}, "system.attributes.hp");
    const hd = foundry.utils.getProperty(actor ?? {}, "system.attributes.hd");
    const death = foundry.utils.getProperty(actor ?? {}, "system.attributes.death");
    const vitals = { hp: null, hitDice: null, death: null };
    if ( (typeof hp?.value === "number") && (typeof hp?.max === "number") ) {
      vitals.hp = { value: hp.value, max: hp.max, temp: hp.temp ?? 0 };
    }
    if ( typeof hd?.value === "number" ) vitals.hitDice = { value: hd.value, max: hd.max ?? null };
    if ( (typeof death?.success === "number") && (typeof death?.failure === "number") ) {
      vitals.death = { success: death.success, failure: death.failure };
    }
    // Compute each block independently so partial data still shows Hit Dice / Death Saves
    // even if HP is unreadable. null → Home hides the whole vitals block (nothing present).
    return (vitals.hp || vitals.hitDice || vitals.death) ? vitals : null;
  },

  /**
   * The actor's item/activity favorites as flat render entries, or [] (→ Home hides
   * favorites). dnd5e stores {type, id, sort} with actor-relative UUID ids; only
   * item/activity favorites are actionable (skills/tools/slots roll from the sheet).
   * @param {Actor} actor
   * @returns {Array<{id:string, name:string, img:string}>}
   */
  getFavorites(actor) {
    const favorites = Array.isArray(actor?.system?.favorites) ? actor.system.favorites : null;
    if ( !favorites ) return [];
    const out = [];
    for ( const fav of [...favorites].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)) ) {
      if ( !["item", "activity"].includes(fav.type) ) continue;
      let doc = null;
      try { doc = fromUuidSync(fav.id, { relative: actor }); } catch(err) { /* unresolvable — skip */ }
      if ( !doc ) continue;
      out.push({ id: fav.id, name: doc.name, img: doc.img ?? null });
    }
    return out;
  },

  /** Activate an item/activity favorite (dnd5e .use()). */
  async useFavorite(doc) {
    if ( typeof doc?.use !== "function" ) {
      ui.notifications?.warn(tf("TAPTABLE.WarnFavoriteNotUsable", { name: doc?.name ?? t("TAPTABLE.ThatFavorite") }));
      console.warn(`${MODULE_ID} | dnd5e adapter: favorite has no use() method.`, doc);
      return;
    }
    await doc.use();
  },

  /**
   * Clamp + write an HP delta through the permission-checked Actor#update path
   * (dnd5e schema: system.attributes.hp.value, clamped to [0, hp.max]).
   */
  async adjustHp(actor, delta) {
    const hp = foundry.utils.getProperty(actor ?? {}, "system.attributes.hp");
    if ( (typeof hp?.value !== "number") || (typeof hp?.max !== "number") ) {
      console.warn(`${MODULE_ID} | dnd5e adapter: HP adjust unavailable (no character or non-dnd5e data).`);
      return;
    }
    const d = Number(delta) || 0;
    const next = Math.min(Math.max(hp.value + d, 0), hp.max);
    if ( next === hp.value ) return;
    await actor.update({ "system.attributes.hp.value": next });
  },

  /* --- roller --- */

  /**
   * Automated quick-roll options, or null (→ roller shows the manual builder only).
   * Three sections (check/save/skill) built from actor.system.abilities/skills and
   * CONFIG.DND5E labels. `label` is the short/abbrev display; `name` is the full
   * label for aria; `mod` is the numeric modifier the roll would apply.
   * @param {Actor} actor
   * @returns {{sections: Array<{title:string, kind:string, entries: Array<{key:string, label:string, mod:number, name:string}>}>}|null}
   */
  getRollables(actor) {
    const abilities = actor?.system?.abilities;
    if ( !abilities || !Object.keys(abilities).length ) return null;
    const sections = [];

    const checks = [];
    const saves = [];
    for ( const [id, abl] of Object.entries(abilities) ) {
      const full = CONFIG.DND5E?.abilities?.[id]?.label ?? id;
      const label = (CONFIG.DND5E?.abilities?.[id]?.abbreviation ?? id).toUpperCase();
      // kind-qualified `name` so the check and save buttons get distinct aria-labels
      // ("Roll Strength check…" vs "Roll Strength saving throw…").
      checks.push({ key: id, label, mod: abilityCheckTotal(abl), name: tf("TAPTABLE.AbilityCheckName", { ability: full }) });
      saves.push({ key: id, label, mod: saveTotal(abl), name: tf("TAPTABLE.SavingThrowName", { ability: full }) });
    }
    sections.push({ title: t("TAPTABLE.AbilityChecks"), kind: "check", entries: checks });
    sections.push({ title: t("TAPTABLE.SavingThrows"), kind: "save", entries: saves });

    const skills = actor?.system?.skills;
    if ( skills && Object.keys(skills).length ) {
      const entries = [];
      for ( const [id, sk] of Object.entries(skills) ) {
        const name = CONFIG.DND5E?.skills?.[id]?.label ?? id;
        entries.push({ key: id, label: name, mod: skillTotal(sk), name });
      }
      sections.push({ title: t("TAPTABLE.Skills"), kind: "skill", entries });
    }
    return { sections };
  },

  /**
   * Execute an automated ability-check / save / skill roll through the standard
   * dnd5e 5.3.3 APIs. Advantage travels as config.advantage/disadvantage, the manual
   * modifier as the dialog's @situational mechanism, and dialog.configure=false skips
   * the usage dialog so a single tap executes the roll. Errors propagate to the
   * caller (roller.js decides whether to snap-to-chat / notify).
   * @param {Actor} actor
   * @param {"check"|"save"|"skill"} kind
   * @param {string} key   Ability id (check/save) or skill id (skill).
   * @param {{advMode?:number, modifier?:number}} [opts]
   */
  async roll(actor, kind, key, { advMode = 0, modifier = 0 } = {}) {
    const config = { advantage: advMode === 1, disadvantage: advMode === -1 };
    if ( modifier ) config.rolls = [{ parts: ["@situational"], data: { situational: modifier } }];
    const dialog = { configure: false };
    if ( kind === "check" ) return actor.rollAbilityCheck({ ability: key, ...config }, dialog);
    if ( kind === "save" ) return actor.rollSavingThrow({ ability: key, ...config }, dialog);
    if ( kind === "skill" ) return actor.rollSkill({ skill: key, ...config }, dialog);
  },

  /* --- combat --- */

  /**
   * Roll initiative for an actor: dnd5e Actor5e#rollInitiativeDialog, with a core
   * Actor#rollInitiative({createCombatants:true}) fallback on dnd5e drift.
   */
  async rollInitiative(actor) {
    if ( typeof actor?.rollInitiativeDialog === "function" ) return actor.rollInitiativeDialog();
    if ( typeof actor?.rollInitiative === "function" ) return actor.rollInitiative({ createCombatants: true });
    ui.notifications?.warn(t("TAPTABLE.WarnInitiativeUnavailable"));
  },

  /* --- compendium --- */

  /** The dnd5e Compendium Add taxonomy (item-subtype buckets). Labels are localized
   *  HERE, at picker-open time — the module-scope constant stores only the keys. */
  getCompendiumCategories() {
    return COMPENDIUM_CATEGORIES.map(c => ({ ...c, label: t(c.label), types: [...c.types] }));
  },

  /* --- AoE templates --- */

  /**
   * Install the dnd5e AbilityTemplate placement intercept: under the module's own
   * conditions (installPreview decides), dnd5e's mouse-driven placement is replaced
   * by the caller's native tap-to-place. libWrapper preferred; a one-client prototype
   * patch is the fallback. installPreview(templateInstance) returns a placement
   * promise when it intends to intercept, or a falsy value to defer to dnd5e's own
   * placement (off-mobile / off-gen). Returns true if an intercept was installed,
   * false when dnd5e's AbilityTemplate is not present.
   * @param {(object) => (Promise|null)} installPreview
   * @returns {boolean}
   */
  interceptTemplatePlacement(installPreview) {
    const AbilityTemplate = globalThis.dnd5e?.canvas?.AbilityTemplate ?? game.dnd5e?.canvas?.AbilityTemplate;
    if ( !AbilityTemplate?.prototype ) {
      console.warn(`${MODULE_ID} | dnd5e adapter: dnd5e AbilityTemplate not found; native AoE intercept NOT installed.`);
      return false;
    }
    if ( globalThis.libWrapper?.register ) {
      try {
        libWrapper.register(MODULE_ID, "dnd5e.canvas.AbilityTemplate.prototype.drawPreview",
          function (wrapped, ...args) {
            const placement = installPreview(this);
            return placement ?? wrapped(...args);
          }, "MIXED");
        return true;
      } catch (err) {
        console.warn(`${MODULE_ID} | dnd5e adapter: libWrapper registration failed; falling back to a one-client prototype patch.`, err);
      }
    }
    // Fallback: patch the prototype on THIS client only (templates.js only reaches
    // here under pf-mobile, so no desktop client ever installs this).
    const proto = AbilityTemplate.prototype;
    const original = proto.drawPreview;
    proto.drawPreview = function (...args) {
      const placement = installPreview(this);
      return placement ?? original.apply(this, args);
    };
    return true;
  }
};

registerSystemAdapter("dnd5e", dnd5eAdapter);
