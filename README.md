# TapTable

A mobile & touch usability layer for **Foundry VTT** — a phone shell with bottom navigation,
visual-viewport and on-screen-keyboard management, touch drag-and-drop, canvas touch gestures, and
touch-friendly combat interaction (token HUD, targeting, multi-select, combatant carousel, macro
drawer).

The core is **system-agnostic** and degrades gracefully on any game system; a `dnd5e` reference
adapter adds character-sheet, roll, and compendium integration. Zero desktop impact — every style
and behavior is gated behind the `body.pf-mobile` flag.

> **Not affiliated with or endorsed by Foundry Gaming LLC.** "Foundry VTT" / "Foundry Virtual
> Tabletop" are trademarks of Foundry Gaming LLC; TapTable is an independent module *for* Foundry VTT.

## Status

Early public extraction (pre-1.0). The system-agnostic adapter refactor is in progress — see the
roadmap. A full install guide, screenshots, and demo will land with the v1.0.0 release.

## License

MIT — see [`LICENSE`](LICENSE). Third-party notices in [`NOTICE`](NOTICE).
