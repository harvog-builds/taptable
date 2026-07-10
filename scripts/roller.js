/**
 * taptable — Quick Roll engine (M3.1 / queue 228-2).
 *
 * A shell-owned "Roller" pane: a manual dice builder (die picker, count stepper,
 * Advantage/Normal/Disadvantage selector, manual modifier stepper) plus automated
 * roll buttons. This module is SYSTEM-AGNOSTIC: the manual builder is pure core
 * dice, and the automated half is delegated to the active system adapter —
 * resolveAdapter().getRollables(actor) supplies the sections/entries to render and
 * resolveAdapter().roll(actor, kind, key, opts) executes a tapped roll. On a system
 * with no adapter (NullAdapter) getRollables returns null and the pane shows the
 * manual builder plus a system-neutral empty state; the dnd5e-shaped modifier math,
 * CONFIG.DND5E reads and dnd5e roll APIs live in adapters/dnd5e.js.
 *
 * Wiring: shell.js imports buildRollerPane() and registers the "roller" tab in
 * registerBuiltinTabs(); this module renders the pane and owns the (generic) roll
 * dispatch + snap-to-chat. Nothing here runs on desktop clients: the pane is only
 * ever built by the PocketShell, whose initShell() early-returns without
 * body.pf-mobile (and buildRollerPane() carries its own belt-and-braces guard).
 *
 * Roll mode: the manual path passes no messageMode, so posting falls through to the
 * user's active roll-mode setting (core Roll#toMessage, client/dice/roll.mjs:926-932);
 * the adapter's automated rolls likewise leave messageMode to the system default.
 */

import { resolveAdapter } from "./adapter-registry.js";

const MODULE_ID = "taptable";

/** Localize / format a TAPTABLE.* key. Defined at module scope but only ever CALLED
 *  at render time or inside tap handlers (post-i18nInit) — never at module scope. */
const t = key => game.i18n.localize(key);
const tf = (key, data) => game.i18n.format(key, data);

/** Dice offered by the manual builder (dice notation — not localized). */
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
/*  Display formatting                          */
/* -------------------------------------------- */

/** Signed display for a modifier: 3 -> "+3", -1 -> "-1", 0 -> "+0". */
function signed(n) {
  const v = Number.isFinite(n) ? n : 0;
  return `${v >= 0 ? "+" : ""}${v}`;
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
 * Automated roll: resolve the roll actor, delegate the kind/key roll to the active
 * system adapter (resolveAdapter().roll — the dnd5e adapter maps check/save/skill to
 * the dnd5e actor APIs; NullAdapter is a no-op), then snap the shell to its Chat
 * surface so the result is visible. The current builder Advantage mode and manual
 * modifier travel to the adapter as { advMode, modifier }. Only ever invoked from a
 * rendered roll button, which exists only when the adapter offered a matching entry.
 * @param {string} kind   Section kind from getRollables (e.g. "check"|"save"|"skill").
 * @param {string} key    The entry key (ability/skill id).
 * @param {object} shell  The live PocketShell (for the post-roll snap-to-chat).
 */
async function executeActorRoll(kind, key, shell) {
  const actor = rollActor();
  if ( !actor ) {
    ui.notifications?.warn(t("TAPTABLE.WarnNoRollActor"));
    return;
  }
  try {
    await resolveAdapter().roll(actor, kind, key, { advMode: state.advMode, modifier: state.modifier });
    snapToChat(shell);
  } catch(err) {
    console.warn(`${MODULE_ID} | roller: ${kind} roll for "${key}" failed (system adapter API drift?).`, err);
    ui.notifications?.warn(t("TAPTABLE.WarnRollFailed"));
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
  const dice = `${state.count}${state.die}`;
  let flavor = tf("TAPTABLE.QuickRollFlavor", { formula: dice });
  if ( (state.die === "d20") && (state.advMode === 1) ) flavor = tf("TAPTABLE.QuickRollFlavorAdv", { formula: dice });
  else if ( (state.die === "d20") && (state.advMode === -1) ) flavor = tf("TAPTABLE.QuickRollFlavorDis", { formula: dice });
  try {
    const actor = rollActor();
    const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
    const roll = new Roll(formula);
    await roll.toMessage({ speaker, flavor });
    snapToChat(shell);
  } catch(err) {
    console.warn(`${MODULE_ID} | roller: manual roll "${formula}" failed.`, err);
    ui.notifications?.warn(t("TAPTABLE.WarnRollFailed"));
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
  pane.append(h("h2", { class: "pf-pane-title", text: t("TAPTABLE.QuickRoll") }));
  buildBuilder(pane, shell);
  if ( game.user?.isGM ) buildGMSection(pane, shell);
  else buildPlayerSection(pane, shell);
  return pane;
}

/** The manual builder: die picker, count stepper, roll mode, modifier stepper, Roll. */
function buildBuilder(pane, shell) {
  // Die picker.
  const dice = h("div", { class: "pf-dice", role: "group", "aria-label": t("TAPTABLE.DiePicker") });
  for ( const die of DICE ) {
    const btn = h("button", {
      type: "button",
      class: `pf-die${state.die === die ? " active" : ""}`,
      "aria-label": tf("TAPTABLE.UseDie", { die }),
      "aria-pressed": state.die === die ? "true" : "false",
      text: die
    });
    btn.addEventListener("click", () => { state.die = die; shell.render(); });
    dice.append(btn);
  }
  pane.append(dice);

  // Count stepper (default 1).
  pane.append(stepperRow(shell, {
    label: t("TAPTABLE.Count"),
    get: () => state.count,
    set: v => { state.count = v; },
    min: COUNT_MIN, max: COUNT_MAX,
    fmt: String
  }));

  // Roll mode: Advantage / Normal / Disadvantage.
  const advGroup = h("div", { class: "pf-adv-group", role: "group", "aria-label": t("TAPTABLE.RollMode") });
  for ( const [label, mode] of [[t("TAPTABLE.Advantage"), 1], [t("TAPTABLE.Normal"), 0], [t("TAPTABLE.Disadvantage"), -1]] ) {
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
    label: t("TAPTABLE.Modifier"),
    get: () => state.modifier,
    set: v => { state.modifier = v; },
    min: MOD_MIN, max: MOD_MAX,
    fmt: signed
  }));

  // Manual roll — the only builder control that actually rolls.
  const rollLabel = tf("TAPTABLE.RollFormula", { formula: manualFormula() });
  const rollBtn = h("button", {
    type: "button",
    class: "pf-btn pf-wide pf-roll-manual",
    "aria-label": rollLabel,
    text: rollLabel
  });
  rollBtn.addEventListener("click", () => executeManualRoll(shell));
  pane.append(h("div", { class: "pf-row" }, [rollBtn]));
}

/** A labeled −/value/+ stepper row (≥44px targets via the shared .pf-btn/.pf-row CSS). */
function stepperRow(shell, { label, get, set, min, max, fmt }) {
  const minus = h("button", { type: "button", class: "pf-btn",
    "aria-label": tf("TAPTABLE.DecreaseLabel", { label: label.toLowerCase() }), text: "−" });
  const plus = h("button", { type: "button", class: "pf-btn",
    "aria-label": tf("TAPTABLE.IncreaseLabel", { label: label.toLowerCase() }), text: "+" });
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
    pane.append(h("p", { class: "pf-empty pf-roller-nochar", text: t("TAPTABLE.RollerNoCharacter") }));
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
  pane.append(h("h3", { class: "pf-section-title", text: t("TAPTABLE.RollAs") }));

  const entries = [];
  try {
    for ( const a of game.actors ?? [] ) {
      entries.push({ id: a.id, name: a.name ?? t("TAPTABLE.Unnamed"),
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
    value: state.gmSearch, placeholder: tf("TAPTABLE.SearchActorsPlaceholder", { count: entries.length }),
    "aria-label": t("TAPTABLE.SearchActorsRollAs"), autocomplete: "off", spellcheck: "false" });
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
        "aria-label": tf("TAPTABLE.RollAsActor", { name: e.name }),
        dataset: { actorId: e.id }
      }, [
        h("img", { src: e.img, alt: "", loading: "lazy" }),
        h("span", { class: "pf-gm-name", text: e.name })
      ]);
      row.addEventListener("click", () => { state.gmActorId = e.id; shell.render(); });
      list.append(row);
    }
    if ( !matches.length ) {
      list.append(h("p", { class: "pf-empty", text: t("TAPTABLE.NoActorsMatch") }));
    } else if ( matches.length > shown.length ) {
      list.append(h("p", { class: "pf-hint", text: tf("TAPTABLE.ShowingOf", { shown: shown.length, total: matches.length }) }));
    }
  };
  renderRows();
  search.addEventListener("input", () => { state.gmSearch = search.value; renderRows(); });
  pane.append(search, list);

  const actor = rollActor();
  if ( actor ) buildActorRollSection(pane, shell, actor);
  else pane.append(h("p", { class: "pf-empty", text: t("TAPTABLE.RollerSelectActor") }));
}

/**
 * Identity row (avatar + name) and the automated roll sections. The sections are
 * whatever the active system adapter offers (resolveAdapter().getRollables) —
 * rendered generically as one titled grid of tap-to-roll buttons per section. On a
 * system with no adapter (getRollables → null / no sections) a system-neutral empty
 * state is shown and only the manual builder above remains usable.
 */
function buildActorRollSection(pane, shell, actor) {
  pane.append(h("div", { class: "pf-roller-identity" }, [
    h("img", { src: actor.img || "icons/svg/mystery-man.svg", alt: "", loading: "lazy" }),
    h("span", { class: "pf-roller-name", text: actor.name })
  ]));

  const rollables = resolveAdapter().getRollables(actor);
  const sections = Array.isArray(rollables?.sections) ? rollables.sections : [];
  if ( !sections.length ) {
    pane.append(h("p", { class: "pf-empty", text: tf("TAPTABLE.RollerNoRollables", { name: actor.name }) }));
    return;
  }

  for ( const section of sections ) {
    const entries = Array.isArray(section?.entries) ? section.entries : [];
    if ( !entries.length ) continue;
    pane.append(h("h3", { class: "pf-section-title", text: section.title ?? "" }));
    // Preserve the skills 2-up grid CSS hook (taptable-core.css .pf-roller-skills);
    // other kinds use the default 3-up grid.
    const grid = h("div", { class: `pf-roller-grid${section.kind === "skill" ? " pf-roller-skills" : ""}` });
    for ( const entry of entries ) {
      grid.append(rollButton({
        label: entry.label,
        mod: entry.mod,
        aria: tf("TAPTABLE.RollForActor", { roll: entry.name ?? entry.label, name: actor.name }),
        kind: section.kind, key: entry.key, shell
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
