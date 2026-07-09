/**
 * taptable — Compendium Add picker (queue 231-1).
 *
 * A standalone, tap-driven picker that searches the player's VISIBLE Item
 * compendiums and adds a chosen entry to a character the user OWNS. Exposed as
 * openCompendiumPicker(actor); main.js imports it (keeping scripts/main.js the
 * single manifest esmodule) and re-exports it on the module API. The shell wiring
 * that surfaces a "+ Add" control lives in a later subtask (231-2) — this module
 * only owns the picker itself.
 *
 * Unlike the shell's own panes, the picker is NOT part of the PocketShell render
 * loop: openCompendiumPicker() appends a self-contained #pf-compendium overlay to
 * <body> and manages its own DOM/listeners, tearing itself down on Close, on a
 * successful add, or when re-opened (singleton). It early-returns without
 * body.pf-mobile, so nothing here can render on a desktop client (zero desktop
 * impact by construction, matching every other taptable sub-module).
 *
 * Foundry / dnd5e API facts this module relies on (all feature-detected + guarded):
 *  - game.packs enumerates CompendiumCollections. p.visible reflects the current
 *    user's permission to see the pack (compendium ownership), and
 *    p.metadata.type is the contained document type — so
 *    (p.visible && p.metadata.type === "Item") is exactly "Item packs this player
 *    may browse". This mirrors the read-only pf-compendium-probe's own filter.
 *  - pack.getIndex({ fields }) returns the pack's lightweight index Collection
 *    (async, cached after the first call). name/img are always indexed; `type`
 *    is requested explicitly so the category filter can key on the dnd5e Item
 *    subtype. Each index entry exposes a compendium `uuid`; a canonical
 *    Compendium.<packId>.Item.<id> string is constructed as a fallback.
 *  - fromUuid(uuid) resolves the full compendium document; doc.toObject() yields a
 *    clean source object to seed the new embedded item.
 *  - actor.createEmbeddedDocuments("Item", [data]) is the permission-checked
 *    embedded-CRUD path (the same path the sheet's drag-drop create uses). It is
 *    only ever called after an explicit confirm AND behind an actor.isOwner guard,
 *    and every failure is surfaced through ui.notifications rather than thrown.
 */

const MODULE_ID = "taptable";

/** Overlay element id (singleton — a second open replaces the first). */
const OVERLAY_ID = "pf-compendium";

/** Max result rows in the DOM at once; search narrows below this (keeps the list
 *  snappy across large SRD packs, mirroring the shell's GM-list render cap). */
const RESULT_RENDER_CAP = 40;

/**
 * Category selector -> dnd5e Item subtypes, per the approved criteria. Order is
 * the display order of the category buttons.
 * @type {Array<{id:string, label:string, types:string[]}>}
 */
const CATEGORIES = [
  { id: "items",      label: "Items",      types: ["weapon", "equipment", "consumable", "tool", "loot", "container"] },
  { id: "spells",     label: "Spells",     types: ["spell"] },
  { id: "feats",      label: "Feats",      types: ["feat"] },
  { id: "features",   label: "Features",   types: ["feat", "subclass"] },
  { id: "species",    label: "Species",    types: ["race"] },
  { id: "background", label: "Background", types: ["background"] },
  { id: "class",      label: "Class",      types: ["class", "subclass"] }
];

/* -------------------------------------------- */
/*  DOM helper (local copy of shell.js h())     */
/* -------------------------------------------- */

/**
 * Tiny element builder — a deliberate local copy of shell.js/roller.js's
 * module-private h() (rather than a cross-module import). User-supplied strings
 * (item / pack / actor names) are only ever assigned through textContent — no
 * innerHTML on dynamic data.
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

/** Escape a dynamic string for safe interpolation into DialogV2 HTML content. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* -------------------------------------------- */
/*  Index gathering                             */
/* -------------------------------------------- */

/**
 * Build the compendium UUID for an index entry. Prefers the entry's own uuid
 * (present on modern index entries); otherwise constructs the canonical
 * Compendium.<packId>.Item.<id> form.
 * @param {object} pack   CompendiumCollection.
 * @param {object} entry  Index entry.
 * @returns {string|null}
 */
function entryUuid(pack, entry) {
  if ( typeof entry?.uuid === "string" && entry.uuid.length ) return entry.uuid;
  const packId = pack?.metadata?.id ?? pack?.collection;
  if ( packId && entry?._id ) return `Compendium.${packId}.Item.${entry._id}`;
  return null;
}

/**
 * Collect every index entry of the requested dnd5e Item subtypes across ALL
 * Item compendiums the current user can see. Read-only: getIndex() never writes.
 * @param {string[]} types  dnd5e Item subtypes for the active category.
 * @returns {Promise<Array<{uuid:string, name:string, img:string, pack:string, type:string}>>}
 */
async function collectEntries(types) {
  const wanted = new Set(types);
  const out = [];
  let packs = [];
  try { packs = [...(game.packs ?? [])]; } catch(err) {
    console.warn(`${MODULE_ID} | compendium: could not enumerate game.packs.`, err);
    return out;
  }
  for ( const pack of packs ) {
    // Only Item packs this player is permitted to see (compendium visibility).
    if ( !pack?.visible ) continue;
    if ( pack.metadata?.type !== "Item" ) continue;
    let index;
    try {
      index = await pack.getIndex({ fields: ["type", "img", "name"] });
    } catch(err) {
      console.warn(`${MODULE_ID} | compendium: getIndex failed for "${pack.metadata?.id}"; skipping.`, err);
      continue;
    }
    const label = pack.metadata?.label ?? pack.metadata?.id ?? "";
    for ( const entry of index ?? [] ) {
      if ( !wanted.has(entry?.type) ) continue;
      const uuid = entryUuid(pack, entry);
      if ( !uuid ) continue;
      out.push({
        uuid,
        name: entry.name ?? "(unnamed)",
        img: entry.img || "icons/svg/item-bag.svg",
        pack: label,
        type: entry.type
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* -------------------------------------------- */
/*  Confirm + add                               */
/* -------------------------------------------- */

/**
 * Confirmation dialog (DialogV2 windows are NOT shell-opened, so they never get
 * pf-max). Returns true only on an explicit Yes.
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
    console.warn(`${MODULE_ID} | compendium: confirmation dialog failed; treating as cancelled.`, err);
    return false;
  }
}

/**
 * Confirm, then add the chosen entry to the actor. The write is the permission-
 * checked actor.createEmbeddedDocuments("Item", ...) path, reached ONLY after an
 * explicit Yes and ONLY when the user owns the actor (guarded twice: at open and
 * here). Every failure is surfaced through ui.notifications, never thrown.
 * @param {Actor} actor
 * @param {{uuid:string, name:string}} entry
 * @param {Function} onAdded  Called after a successful add (closes the picker).
 */
async function confirmAndAdd(actor, entry, onAdded) {
  if ( !actor?.isOwner ) {   // defense in depth; open already gated on ownership
    ui.notifications?.warn("Pocket Foundry: you can only add items to a character you own.");
    return;
  }
  const ok = await pfConfirm("Add to character",
    `<p>Add <strong>${escapeHtml(entry.name)}</strong> to <strong>${escapeHtml(actor.name)}</strong>?</p>`);
  if ( !ok ) return;

  let doc = null;
  try {
    doc = await fromUuid(entry.uuid);
  } catch(err) {
    console.warn(`${MODULE_ID} | compendium: fromUuid("${entry.uuid}") failed.`, err);
  }
  if ( !doc || (typeof doc.toObject !== "function") ) {
    ui.notifications?.warn(`Pocket Foundry: "${entry.name}" could not be resolved from its compendium.`);
    return;
  }
  try {
    const created = await actor.createEmbeddedDocuments("Item", [doc.toObject()]);
    if ( created?.length ) {
      ui.notifications?.info(`Pocket Foundry: added ${entry.name} to ${actor.name}.`);
      onAdded?.();
    }
  } catch(err) {
    console.warn(`${MODULE_ID} | compendium: createEmbeddedDocuments failed.`, err);
    ui.notifications?.warn(`Pocket Foundry: could not add ${entry.name} (see console).`);
  }
}

/* -------------------------------------------- */
/*  Opener                                      */
/* -------------------------------------------- */

/**
 * Open the Compendium Add picker for an actor the user owns. A no-op on desktop
 * (early-returns without body.pf-mobile) and for actors the user does not own.
 * @param {Actor} actor  The character the picked entry is added to.
 * @returns {Promise<void>}
 */
export async function openCompendiumPicker(actor) {
  // Activation contract: nothing renders without the phone flag.
  if ( !document.body?.classList.contains("pf-mobile") ) return;

  if ( !actor ) {
    ui.notifications?.warn("Pocket Foundry: no character to add items to.");
    return;
  }
  if ( !actor.isOwner ) {
    ui.notifications?.warn("Pocket Foundry: you can only add items to a character you own.");
    return;
  }

  // Singleton: replace any picker already open.
  try { document.getElementById(OVERLAY_ID)?.remove(); } catch(err) { /* nothing to remove */ }

  const session = { category: CATEGORIES[0].id, search: "", entries: [], loading: true, gen: 0 };

  const overlay = h("div", { id: OVERLAY_ID, role: "dialog", "aria-label": "Add from compendium" });
  const panel = h("div", { class: "pf-compendium-panel" });

  const close = () => { try { overlay.remove(); } catch(err) { /* already gone */ } };

  // Head: title + Close.
  const closeBtn = h("button", { type: "button", class: "pf-compendium-close", "aria-label": "Close the picker" }, [
    h("i", { class: "fa-solid fa-xmark", inert: true }),
    h("span", { text: "Close" })
  ]);
  closeBtn.addEventListener("click", close);
  panel.append(h("div", { class: "pf-compendium-head" }, [
    h("h2", { class: "pf-pane-title", text: `Add to ${actor.name}` }),
    closeBtn
  ]));

  // Category selector.
  const cats = h("div", { class: "pf-compendium-cats", role: "group", "aria-label": "Category" });
  for ( const cat of CATEGORIES ) {
    const btn = h("button", {
      type: "button",
      class: `pf-compendium-cat${cat.id === session.category ? " active" : ""}`,
      "aria-pressed": cat.id === session.category ? "true" : "false",
      dataset: { cat: cat.id },
      text: cat.label
    });
    cats.append(btn);
  }
  panel.append(cats);

  // Search input.
  const search = h("input", {
    type: "search", class: "pf-compendium-search", placeholder: "Search…",
    "aria-label": "Search compendium entries", autocomplete: "off", spellcheck: "false"
  });
  panel.append(search);

  // Results list.
  const results = h("div", { class: "pf-compendium-results" });
  panel.append(results);

  overlay.append(panel);
  // Backdrop tap (outside the panel) closes the picker.
  overlay.addEventListener("click", ev => { if ( ev.target === overlay ) close(); });

  /** Rebuild ONLY the results list (search/category never rebuild the whole
   *  overlay, so the search input keeps focus while typing — the GM-Home
   *  focus-preserving pattern). */
  const renderResults = () => {
    const q = session.search.trim().toLowerCase();
    const matches = q ? session.entries.filter(e => e.name.toLowerCase().includes(q)) : session.entries;
    const shown = matches.slice(0, RESULT_RENDER_CAP);
    results.replaceChildren();
    for ( const e of shown ) {
      const row = h("button", {
        type: "button",
        class: "pf-compendium-row",
        "aria-label": `Add ${e.name} (${e.pack})`,
        dataset: { uuid: e.uuid }
      }, [
        h("img", { class: "pf-compendium-img", src: e.img, alt: "", loading: "lazy" }),
        h("span", { class: "pf-compendium-name", text: e.name }),
        h("span", { class: "pf-compendium-pack", text: e.pack })
      ]);
      row.addEventListener("click", () => confirmAndAdd(actor, e, close));
      results.append(row);
    }
    if ( session.loading ) {
      results.append(h("p", { class: "pf-compendium-empty", text: "Loading compendium entries…" }));
    } else if ( !session.entries.length ) {
      results.append(h("p", { class: "pf-compendium-empty",
        text: "No visible compendiums have entries in this category." }));
    } else if ( !matches.length ) {
      results.append(h("p", { class: "pf-compendium-empty", text: "No entries match that search." }));
    } else if ( matches.length > shown.length ) {
      results.append(h("p", { class: "pf-compendium-hint",
        text: `Showing ${shown.length} of ${matches.length} — type to narrow.` }));
    }
  };

  /** (Re)load the active category's entries, then re-render the list. A
   *  generation token drops results from a category switch the user has already
   *  moved on from. */
  const loadCategory = async () => {
    const gen = ++session.gen;
    session.loading = true;
    session.entries = [];
    renderResults();
    const cat = CATEGORIES.find(c => c.id === session.category) ?? CATEGORIES[0];
    let collected = [];
    try {
      collected = await collectEntries(cat.types);
    } catch(err) {
      console.warn(`${MODULE_ID} | compendium: collecting "${session.category}" failed.`, err);
    }
    if ( gen !== session.gen ) return;   // superseded by a newer category switch
    session.entries = collected;
    session.loading = false;
    renderResults();
  };

  // Wire category taps (toggle active state, reload) and search (list-only rebuild).
  for ( const btn of cats.querySelectorAll(".pf-compendium-cat") ) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.cat;
      if ( session.category === id ) return;
      session.category = id;
      for ( const b of cats.querySelectorAll(".pf-compendium-cat") ) {
        const on = b.dataset.cat === id;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
      loadCategory();
    });
  }
  search.addEventListener("input", () => { session.search = search.value; renderResults(); });

  document.body.append(overlay);
  await loadCategory();
}
