# yi-sim runtime snapshot

This directory is the vendored runtime snapshot used by the overlay app.

## Source of truth

- Intended canonical upstream: your separate yi-sim fork
- Current snapshot source: local `yisim-master/` working tree copied into `vendor/yisim/`
- Snapshot date: 2026-04-10

Before publishing releases, replace this document with the actual fork URL and pinned commit SHA.

## Overlay-required local behavior

The overlay runtime depends on these fixes/behaviors being present in the vendored snapshot:

- `card_info.js`
  - exact card-name lookup checks the `card_name_to_id` map before fuzzy search
- `gamestate_full.js`
  - the `me is not defined` bug is fixed
- `gamestate_full_nolog.js`
  - the `me is not defined` bug is fixed

## Overlay runtime entrypoints

The overlay uses these files at runtime:

- `gamestate_full_nolog.js`
- `card_name_to_id_fuzzy.js`
- `card_info.js`
- `card_json_node.js`
- `card_actions.js`
- `swogi.json`
- `names.json`

Other files in this directory are kept because this is a full vendored snapshot of the current local yi-sim tree.

## Vendored runtime dependency

Because the packaged overlay loads yi-sim from unpacked `extraResources`, yi-sim cannot rely on the app bundle's normal `node_modules` resolution path. The required `@leeoniya/ufuzzy` package is therefore copied into:

- `vendor/yisim/node_modules/@leeoniya/ufuzzy`
