/**
 * taptable — Quick Roll engine (M3.1 / queue 228-2).
 *
 * A shell-owned "Roller" pane: a manual dice builder (die picker, count stepper,
 * Advantage/Normal/Disadvantage selector, manual modifier stepper) plus automated
 * ability-check / saving-throw / skill buttons that roll through the standard
 * dnd5e 5.3.3 actor APIs. Wiring: shell.js imports buildRollerPane() and registers
 * the "roller" tab in registerBuiltinTabs(); this module renders the pane and owns
 * the roll handlers. Nothing here runs on desktop clients: the pane is only ever
 * built by the PocketShell, whose initShell() early-returns without body.pf-mobile
 * (and buildRollerPane() carries its own belt-and-braces guard).
 *
 * dnd5e 5.3.3 facts this module relies on (dist line numbers from
 * /home/foundry/Data/systems/dnd5e/dnd5e.mjs):
 *  - Actor5e#rollAbilityCheck(config, dialog, message) — dnd5e.mjs:37418;
 *    #rollSavingThrow — :37440; #rollSkill — :37194. The legacy rollAbilityTest/
 *    rollAbilitySave do NOT exist in this dist.
 *  - Advantage mode: top-level `config.advantage` / `config.disadvantage` booleans
 *    are folded into roll.options.advantageMode by D20Roll.applyKeybindings
 *    (dnd5e.mjs:78851-78855) during BasicRoll.buildConfigure (:68415).
 *  - Usage dialog: `dialog.configure = false` skips the configuration dialog and
 *    builds the rolls straight from the config (dnd5e.mjs:68419-68426); both
 *    applyKeybindings implementations respect the explicit false via `??=`
 *    (:68504, :78844). This is what makes "tapping a modifier executes the roll"
 *    a single-tap flow.
 *  - Situational modifier: `config.rolls = [{ parts: ["@situational"], data:
 *    { situational: N } }]` — the exact mechanism the dnd5e roll dialog itself
 *    uses (dnd5e.mjs:19809-19812). The entry is merged into the constructed roll
 *    by D20Roll.mergeConfigs (parts unshifted, data assigned — :68762-68771) at
 *    #rollD20Test :37489-37491 and #rollSkillTool :37279-37284 (skill buildConfig
 *    preserves caller parts/data at :37373-37374).
 *  - Roll mode: no rollMode/messageMode is ever passed, so posting falls through
 *    to the user's active setting — dnd5e message path reads
 *    game.settings.get("core", "messageMode") on v14 (dnd5e.mjs:68750); the manual
 *    path uses core Roll#toMessage, same default (client/dice/roll.mjs:926-932).
 *  - Displayed modifiers read what dnd5e itself prepares on actor.system:
 *    ability check = mod + checkBonus (+ numeric checkProf.flat) — the same fields
 *    the roll consumes (prep :26571-26572, roll parts :37471-37477); saving throw
 *    = abilities[k].save.value (:26574-26575); skill = skills[k].total
 *    (:71828-71829).
 */

const MODULE_ID = "taptable";

/** Dice offered by the manual builder. */
const DICE = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];

/** Stepper bounds — keep phone-built formulas sane. */
const COUNT_MIN = 1;
const COUNT_MAX = 20;
const MOD_MIN = -20;
const MOD_MAX = 20;

/** Max actor rows the GM roller list renders at once (mirrors the GM Home cap). */
const GM_LIST_RENDER_CAP = 30;

/**
 * Builder state. Module-level so it survives shell re-renders (the same pattern
 * as the shell's #gmSearch); advMode uses the CONFIG.Dice.D20Roll.ADV_MODE value
 * space (1 advantage / 0 normal / -1 disadvantage — dnd5e.mjs:78788-78792).
 */
const state = {
  die: "d20",
  count: 1,
  advMode: 0,
  modifier: 0,
  gmSearch: "",
  gmActorId: null
};

/* -------------------------------------------- */
/*  DOM helper (local copy of shell.js h())     */
/* -------------------------------------------- */

/**
 * Tiny element builder — deliberately a local copy of shell.js's module-private
 * h() rather than a circular shell<->roller import. User-supplied strings (actor
 * names) are only ever assigned through textContent — no innerHTML on dynamic data.
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
/*  Modifier computation (pure actor.system)    */
/* -------------------------------------------- */

/** Signed display for a modifier: 3 -> "+3", -1 -> "-1", 0 -> "+0". */
function signed(n) {
  const v = Number.isFinite(n) ? n : 0;
  return `${v >= 0 ? "+" : ""}${v}`;
}

/**
 * The numeric flat value of a dnd5e Proficiency object, or 0 when it is absent
 * or non-numeric — mirroring dnd5e's own display logic (`Number.isNumeric(term)`
 * guard, dnd5e.mjs:26575/:71829; Number.isNumeric is the foundry primitive
 * extension, common/primitives/number.mjs:111).
 * @param {object} prof
 * @returns {number}
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

/** Ability CHECK total as dnd5e prepares it: mod + checkBonus + numeric prof
 *  (prep dnd5e.mjs:26571-26572; the same fields the roll consumes, :37471-37477). */
function abilityCheckTotal(abl) {
  return (abl?.mod ?? 0) + (abl?.checkBonus ?? 0) + profFlat(abl?.checkProf);
}

/** Saving-throw total: dnd5e prepares abilities[k].save.value (dnd5e.mjs:26574-26575). */
function saveTotal(abl) {
  if ( typeof abl?.save?.value === "number" ) return abl.save.value;
  return (abl?.mod ?? 0) + (abl?.saveBonus ?? 0) + profFlat(abl?.saveProf);
}

/** Skill total: dnd5e prepares skills[k].total (dnd5e.mjs:71828-71829). */
function skillTotal(sk) {
  if ( typeof sk?.total === "number" ) return sk.total;
  return (sk?.mod ?? 0) + (sk?.bonus ?? 0) + profFlat(sk?.prof);
}

/* -------------------------------------------- */
/*  Roll target resolution (player gating)      */
/* -------------------------------------------- */

/**
 * The actor rolls execute against. Players are ALWAYS pinned to their assigned
 * character — state.gmActorId is deliberately ignored for non-GMs, so even a
 * polluted state can never let a player roll as a world actor (defense in depth
 * on top of buildGMSection never rendering for them). GMs get their selected
 * world actor, falling back to their own character when nothing is selected.
 * @returns {Actor|null}
 */
function rollActor() {
  const user = game.user;
  if ( user?.isGM ) {
    const picked = state.gmActorId ? game.actors?.get(state.gmActorId) : null;
    return picked ?? user.character ?? null;
  }
  return user?.character ?? null;
}

/* -------------------------------------------- */
/*  Roll execution                              */
/* -------------------------------------------- */

/**
 * Automated ability-check / save / skill roll through the standard dnd5e 5.3.3
 * APIs. Advantage mode travels as config.advantage/disadvantage (folded into
 * roll.options.advantageMode — dnd5e.mjs:78851-78855), the manual modifier as
 * the dialog's own @situational mechanism (dnd5e.mjs:19809-19812), and
 * dialog.configure=false skips the usage dialog (dnd5e.mjs:68419) so a single
 * tap executes the roll. Message creation, speaker, and the active roll mode
 * are all left to dnd5e's defaults. Once the roll is dispatched the shell snaps
 * to its Chat surface (snapToChat) so the result is visible.
 * @param {"check"|"save"|"skill"} kind
 * @param {string} key    Ability id (check/save) or skill id (skill).
 * @param {object} shell  The live PocketShell (for the post-roll snap-to-chat).
 */
async function executeActorRoll(kind, key, shell) {
  const actor = rollActor();
  if ( !actor ) {
    ui.notifications?.warn("Pocket Foundry: no actor to roll for.");
    return;
  }
  const config = {
    advantage: state.advMode === 1,
    disadvantage: state.advMode === -1
  };
  if ( state.modifier ) {
    config.rolls = [{ parts: ["@situational"], data: { situational: state.modifier } }];
  }
  const dialog = { configure: false };
  try {
    if ( kind === "check" ) await actor.rollAbilityCheck({ ability: key, ...config }, dialog);
    else if ( kind === "save" ) await actor.rollSavingThrow({ ability: key, ...config }, dialog);
    else if ( kind === "skill" ) await actor.rollSkill({ skill: key, ...config }, dialog);
    snapToChat(shell);
  } catch(err) {
    console.warn(`${MODULE_ID} | roller: ${kind} roll for "${key}" failed (dnd5e API drift?).`, err);
    ui.notifications?.warn("Pocket Foundry: the roll failed (see console).");
  }
}

/**
 * The manual builder's formula. Advantage/disadvantage exists for d20 tests only
 * (5e RAW), so kh/kl is applied per d20 (count=1 — the default — gives the
 * standard 2d20kh/2d20kl); other dice ignore the mode. The manual modifier is
 * appended as a plain term.
 * @returns {string}
 */
function manualFormula() {
  let dice;
  if ( (state.die === "d20") && (state.advMode !== 0) ) {
    dice = Array(state.count).fill(state.advMode === 1 ? "2d20kh" : "2d20kl").join(" + ");
  } else {
    dice = `${state.count}${state.die}`;
  }
  if ( !state.modifier ) return dice;
  return `${dice} ${state.modifier > 0 ? "+" : "-"} ${Math.abs(state.modifier)}`;
}

/**
 * Manual roll: standard core path — new Roll(formula) -> Roll#toMessage with no
 * messageMode, which defaults to the user's active roll mode setting
 * (client/dice/roll.mjs:926-932). Speaker follows the roll actor when one exists.
 * Once the message is dispatched the shell snaps to Chat (snapToChat).
 * @param {object} shell  The live PocketShell (for the post-roll snap-to-chat).
 */
async function executeManualRoll(shell) {
  const formula = manualFormula();
  let flavor = `Quick Roll: ${state.count}${state.die}`;
  if ( (state.die === "d20") && (state.advMode === 1) ) flavor += " (Advantage)";
  else if ( (state.die === "d20") && (state.advMode === -1) ) flavor += " (Disadvantage)";
  try {
    const actor = rollActor();
    const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
    const roll = new Roll(formula);
    await roll.toMessage({ speaker, flavor });
    snapToChat(shell);
  } catch(err) {
    console.warn(`${MODULE_ID} | roller: manual roll "${formula}" failed.`, err);
    ui.notifications?.warn("Pocket Foundry: the roll failed (see console).");
  }
}

/**
 * Snap-to-chat: after a Quick Roll is dispatched, switch the shell to its Chat
 * surface so the just-posted roll is visible. Delegates to the shell's public
 * PocketShell#switchTab (shell.js) — the exact path a Chat nav-tap takes
 * (ui.chat.renderPopout() + pf-max + closing the open pane) — rather than
 * reimplementing chat opening here. Under pf-mobile only: belt-and-braces, since
 * the whole Roller pane is already gated (buildRollerPane early-returns without
 * body.pf-mobile). A missing/renamed switchTab or any failure is swallowed with a
 * console warning so a snap hiccup never masks the roll that already went out.
 * @param {object} shell  The live PocketShell passed down from buildRollerPane.
 */
function snapToChat(shell) {
  if ( !document.body?.classList.contains("pf-mobile") ) return;
  try {
    shell?.switchTab?.("chat");
  } catch(err) {
    console.warn(`${MODULE_ID} | roller: snap-to-chat failed.`, err);
  }
}

/* -------------------------------------------- */
/*  Pane building                               */
/* -------------------------------------------- */

/**
 * Build the Quick Roll pane. Called by PocketShell._renderHTML when the roller
 * tab's pane is open; `shell` is the live PocketShell so taps re-render through
 * the shell's own path.
 * @param {object} shell  The PocketShell application instance.
 * @returns {HTMLElement}
 */
export function buildRollerPane(shell) {
  const pane = h("section", { class: "pf-pane", dataset: { pane: "roller" } });
  // Belt and braces: the shell never renders on desktop (initShell early-return),
  // but keep the module's activation contract locally visible too.
  if ( !document.body?.classList.contains("pf-mobile") ) return pane;
  pane.append(h("h2", { class: "pf-pane-title", text: "Quick Roll" }));
  buildBuilder(pane, shell);
  if ( game.user?.isGM ) buildGMSection(pane, shell);
  else buildPlayerSection(pane, shell);
  return pane;
}

/** The manual builder: die picker, count stepper, roll mode, modifier stepper, Roll. */
function buildBuilder(pane, shell) {
  // Die picker.
  const dice = h("div", { class: "pf-dice", role: "group", "aria-label": "Die picker" });
  for ( const die of DICE ) {
    const btn = h("button", {
      type: "button",
      class: `pf-die${state.die === die ? " active" : ""}`,
      "aria-label": `Use ${die}`,
      "aria-pressed": state.die === die ? "true" : "false",
      text: die
    });
    btn.addEventListener("click", () => { state.die = die; shell.render(); });
    dice.append(btn);
  }
  pane.append(dice);

  // Count stepper (default 1).
  pane.append(stepperRow(shell, {
    label: "Count",
    get: () => state.count,
    set: v => { state.count = v; },
    min: COUNT_MIN, max: COUNT_MAX,
    fmt: String
  }));

  // Roll mode: Advantage / Normal / Disadvantage.
  const advGroup = h("div", { class: "pf-adv-group", role: "group", "aria-label": "Roll mode" });
  for ( const [label, mode] of [["Advantage", 1], ["Normal", 0], ["Disadvantage", -1]] ) {
    const btn = h("button", {
      type: "button",
      class: `pf-adv${state.advMode === mode ? " active" : ""}`,
      "aria-pressed": state.advMode === mode ? "true" : "false",
      dataset: { advMode: String(mode) },
      text: label
    });
    btn.addEventListener("click", () => { state.advMode = mode; shell.render(); });
    advGroup.append(btn);
  }
  pane.append(advGroup);

  // Manual modifier stepper (+/- N).
  pane.append(stepperRow(shell, {
    label: "Modifier",
    get: () => state.modifier,
    set: v => { state.modifier = v; },
    min: MOD_MIN, max: MOD_MAX,
    fmt: signed
  }));

  // Manual roll — the only builder control that actually rolls.
  const rollBtn = h("button", {
    type: "button",
    class: "pf-btn pf-wide pf-roll-manual",
    "aria-label": `Roll ${manualFormula()}`,
    text: `Roll ${manualFormula()}`
  });
  rollBtn.addEventListener("click", () => executeManualRoll(shell));
  pane.append(h("div", { class: "pf-row" }, [rollBtn]));
}

/** A labeled −/value/+ stepper row (≥44px targets via the shared .pf-btn/.pf-row CSS). */
function stepperRow(shell, { label, get, set, min, max, fmt }) {
  const minus = h("button", { type: "button", class: "pf-btn",
    "aria-label": `Decrease ${label.toLowerCase()}`, text: "−" });
  const plus = h("button", { type: "button", class: "pf-btn",
    "aria-label": `Increase ${label.toLowerCase()}`, text: "+" });
  const value = h("span", { class: "pf-roller-value", dataset: { value: String(get()) }, text: fmt(get()) });
  minus.addEventListener("click", () => { set(Math.max(min, get() - 1)); shell.render(); });
  plus.addEventListener("click", () => { set(Math.min(max, get() + 1)); shell.render(); });
  return h("div", { class: "pf-row" }, [
    h("span", { class: "pf-row-label", text: label }), minus, value, plus
  ]);
}

/** Player branch: assigned character -> automated sections; none -> manual-only hint. */
function buildPlayerSection(pane, shell) {
  const actor = game.user?.character;
  if ( !actor ) {
    pane.append(h("p", { class: "pf-empty pf-roller-nochar",
      text: "No character is assigned to this user, so ability, save and skill quick"
        + " rolls are unavailable — the manual dice builder above still works."
        + " Ask the GM to assign a character to your player, then reload." }));
    return;
  }
  buildActorRollSection(pane, shell, actor);
}

/**
 * GM branch: searchable world-actor list (the GM Home pane search pattern —
 * lightweight fields only, capped rows, client-side filter that rebuilds ONLY
 * the list so the input keeps focus), then the selected actor's roll sections.
 * Never rendered for players (buildRollerPane gates on isGM; this function
 * additionally guards, and rollActor() ignores the selection for non-GMs).
 */
function buildGMSection(pane, shell) {
  if ( !game.user?.isGM ) return;   // defense in depth — the caller already gates
  pane.append(h("h3", { class: "pf-section-title", text: "Roll as…" }));

  const entries = [];
  try {
    for ( const a of game.actors ?? [] ) {
      entries.push({ id: a.id, name: a.name ?? "(unnamed)",
        img: a.img ?? "icons/svg/mystery-man.svg", type: a.type ?? "" });
    }
  } catch(err) {
    console.warn(`${MODULE_ID} | roller: could not enumerate world actors.`, err);
  }
  entries.sort((a, b) => {
    const ca = (a.type === "character") ? 0 : 1;
    const cb = (b.type === "character") ? 0 : 1;
    return (ca - cb) || a.name.localeCompare(b.name);
  });

  const search = h("input", { type: "search", class: "pf-gm-search pf-roller-search",
    value: state.gmSearch, placeholder: `Search ${entries.length} actors…`,
    "aria-label": "Search actors to roll as", autocomplete: "off", spellcheck: "false" });
  const list = h("div", { class: "pf-gm-actors pf-roller-actors" });
  const currentId = rollActor()?.id ?? null;
  const renderRows = () => {
    const q = state.gmSearch.trim().toLowerCase();
    const matches = q ? entries.filter(e => e.name.toLowerCase().includes(q)) : entries;
    const shown = matches.slice(0, GM_LIST_RENDER_CAP);
    list.replaceChildren();
    for ( const e of shown ) {
      const row = h("button", {
        type: "button",
        class: `pf-roller-pick${e.id === currentId ? " selected" : ""}`,
        "aria-label": `Roll as ${e.name}`,
        dataset: { actorId: e.id }
      }, [
        h("img", { src: e.img, alt: "", loading: "lazy" }),
        h("span", { class: "pf-gm-name", text: e.name })
      ]);
      row.addEventListener("click", () => { state.gmActorId = e.id; shell.render(); });
      list.append(row);
    }
    if ( !matches.length ) {
      list.append(h("p", { class: "pf-empty", text: "No actors match that search." }));
    } else if ( matches.length > shown.length ) {
      list.append(h("p", { class: "pf-hint", text: `Showing ${shown.length} of ${matches.length} — type to narrow.` }));
    }
  };
  renderRows();
  search.addEventListener("input", () => { state.gmSearch = search.value; renderRows(); });
  pane.append(search, list);

  const actor = rollActor();
  if ( actor ) buildActorRollSection(pane, shell, actor);
  else pane.append(h("p", { class: "pf-empty",
    text: "Select an actor above to roll with their modifiers — the manual dice builder works without one." }));
}

/**
 * Identity row (avatar + name) and the automated roll sections, all values read
 * directly from actor.system (see the modifier helpers above). Tapping any
 * modifier button executes the roll immediately.
 */
function buildActorRollSection(pane, shell, actor) {
  pane.append(h("div", { class: "pf-roller-identity" }, [
    h("img", { src: actor.img || "icons/svg/mystery-man.svg", alt: "", loading: "lazy" }),
    h("span", { class: "pf-roller-name", text: actor.name })
  ]));

  const abilities = actor.system?.abilities;
  if ( !abilities || !Object.keys(abilities).length ) {
    pane.append(h("p", { class: "pf-empty",
      text: `${actor.name} has no dnd5e ability data — manual rolls only.` }));
    return;
  }

  // Ability checks.
  pane.append(h("h3", { class: "pf-section-title", text: "Ability Checks" }));
  const checks = h("div", { class: "pf-roller-grid pf-roller-abilities" });
  for ( const [id, abl] of Object.entries(abilities) ) {
    const label = CONFIG.DND5E?.abilities?.[id]?.label ?? id;
    checks.append(rollButton({
      label: (CONFIG.DND5E?.abilities?.[id]?.abbreviation ?? id).toUpperCase(),
      mod: abilityCheckTotal(abl),
      aria: `Roll ${label} check for ${actor.name}`,
      kind: "check", key: id, shell
    }));
  }
  pane.append(checks);

  // Saving throws.
  pane.append(h("h3", { class: "pf-section-title", text: "Saving Throws" }));
  const saves = h("div", { class: "pf-roller-grid pf-roller-saves" });
  for ( const [id, abl] of Object.entries(abilities) ) {
    const label = CONFIG.DND5E?.abilities?.[id]?.label ?? id;
    saves.append(rollButton({
      label: (CONFIG.DND5E?.abilities?.[id]?.abbreviation ?? id).toUpperCase(),
      mod: saveTotal(abl),
      aria: `Roll ${label} saving throw for ${actor.name}`,
      kind: "save", key: id, shell
    }));
  }
  pane.append(saves);

  // Skills (actor types without skills — e.g. vehicles — simply skip the section).
  const skills = actor.system?.skills;
  if ( skills && Object.keys(skills).length ) {
    pane.append(h("h3", { class: "pf-section-title", text: "Skills" }));
    const grid = h("div", { class: "pf-roller-grid pf-roller-skills" });
    for ( const [id, sk] of Object.entries(skills) ) {
      const label = CONFIG.DND5E?.skills?.[id]?.label ?? id;
      grid.append(rollButton({
        label,
        mod: skillTotal(sk),
        aria: `Roll ${label} for ${actor.name}`,
        kind: "skill", key: id, shell
      }));
    }
    pane.append(grid);
  }
}

/** One automated roll button: label + signed modifier; tapping rolls immediately
 *  then snaps the shell to Chat (executeActorRoll -> snapToChat(shell)). */
function rollButton({ label, mod, aria, kind, key, shell }) {
  const btn = h("button", {
    type: "button",
    class: "pf-roller-roll",
    "aria-label": aria,
    dataset: { kind, key, mod: String(mod) }
  }, [
    h("span", { class: "pf-roller-label", text: label }),
    h("span", { class: "pf-roller-mod", text: signed(mod) })
  ]);
  btn.addEventListener("click", () => executeActorRoll(kind, key, shell));
  return btn;
}
