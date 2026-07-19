# Building a System Adapter for TapTable

TapTable's core is system-agnostic: all system-specific integration lives behind an adapter
registry (`scripts/adapter-registry.js`). At runtime, TapTable resolves a `SystemAdapter` for the
active game system. If no adapter is registered, it falls back to the `NullAdapter` — a safe
empty-state implementation (plus a core initiative fallback) — so system-specific panes render
friendly empty states and nothing throws.

The bundled dnd5e adapter (`adapters/dnd5e.js`) is the reference implementation: sheet touch
patches, vitals/HP, favorites, checks/saves/skills, initiative, compendium taxonomy, and AoE
template handling.

## Registering an adapter

No core changes required. Ship a module (or a world script) that registers an adapter for your
system id — partial adapters are fine, because `registerSystemAdapter` merges your adapter over
`NullAdapter`, so any method you omit degrades to a safe no-op. Last registration wins, so an
override module can replace a bundled adapter.

```js
// Runtime registration via the module API:
game.modules.get("taptable").api.registerSystemAdapter("mysystem", {
  getVitals(actor)    { return { /* hp etc. shown on the Home pane */ }; },
  getRollables(actor) { return { /* checks/saves/skills for the roller */ }; },
  async roll(actor, kind, key, opts) { /* perform a system roll */ },
  // Optional: isSystemSheet, sheetTouchPatches, getFavorites, useFavorite,
  // adjustHp, rollInitiative, getCompendiumCategories, interceptTemplatePlacement
});
```

## The contract

- See the `NullAdapter` in [`scripts/adapter-registry.js`](scripts/adapter-registry.js) for the
  full method contract and per-method documentation.
- See [`adapters/dnd5e.js`](adapters/dnd5e.js) for a complete reference implementation.
- Desktop safety: everything TapTable renders is gated behind the `body.pf-mobile` flag, so your
  adapter only ever runs for mobile-shell users.

## Contributing your adapter

Adapter contributions for other systems are the highest-impact way to help TapTable — open a pull
request, or publish your adapter as its own module and open an issue so we can link it from the
README.
