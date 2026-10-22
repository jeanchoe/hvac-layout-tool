# HVAC Layout Tool — v1 prototype

Clickable, browser-only prototype: upload a floor plan, trace rooms, get a starting
forced-air duct layout in 3D, adjust it by dragging, and export a 2D PDF report.

> **Estimate, not for permit.** Loads use a simplified heat-transfer method with
> code-minimum defaults; duct sizes come from a friction-rate table. This is not
> ACCA Manual J/S/D.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit tests (Vitest)
npm run build      # type-check + static build in dist/
```

No backend. Deploy `dist/` to any static host.

## The six steps

1. **Start**: project name, ZIP (climate zone lookup), building and system type. Only
   single-story residential + forced-air ducted are enabled; the rest show "coming soon".
   You can also open a saved project or load one of three pre-traced sample houses.
2. **Upload**: PNG, JPG or PDF (first page via pdf.js). Sample plan images and a blank
   grid are available if you don't have a plan.
3. **Trace & scale**: click both ends of a known dimension to set the scale, then click
   corners to draw rooms. Snaps to right angles (hold Shift for free angles) and to existing
   corners. Select mode drags rooms and corners. Scroll to zoom; drag empty space to pan.
4. **Room details**: ceiling height, floor type, bedroom (closed door, gets a return),
   exterior walls (auto-detected; click a wall to toggle), windows per wall, and optional
   people/appliance overrides. Each room shows its load line by line. **Building
   assumptions** lists every load input (design temperatures, U-factors, SHGC, air
   leakage, duct allowance) with its default and source; any of them can be overridden.
5. **Layout & inspect**: auto-generated air handler, supply trunk, branches, registers and
   returns. 3D view (orbit / pan / zoom / click to inspect) or 2D plan. Drag registers, the
   AHU or the trunk; warnings re-run on every move (shown in red, listed on the right).
   **Ducts: in attic / between joists** switches routing to respect framing (joist
   direction, spacing, depth, soffit depth).
6. **Export**: preview and download the PDF (plan view, room-by-room table, equipment
   summary, duct schedule, warnings). Every page carries the estimate label.

Undo/redo (Ctrl+Z / Ctrl+Shift+Z) covers every edit; a drag is one undo step and typing is
coalesced. Save writes a `.hvac.json` file; Open restores it exactly. The last session is
also autosaved in the browser.

## Code layout

```
src/
  engine/            Pure TypeScript, no UI imports: building in, layout + warnings out
    config.ts          loads src/config/*.json (all factors live there, not in code)
    walls.ts           walls from room polygons: shared vs exterior, facing N/E/S/W
    load.ts            LoadModel interface + simplified estimate (swap for Manual J later)
    ductSizing.ts      round-duct lookup at a fixed friction rate
    layout.ts          starting-layout heuristics + scored nearby variations
    route.ts           duct tree from AHU, trunk line and registers (runs on every drag)
    validate.ts        live validation rules
    index.ts           evaluate() / generateProjectLayout() / rebalanceAirflow()
    engine.test.ts     unit tests, incl. the three sample plans
  config/            engine-config.json, zip-climate-zones.json
  state/             Zustand store with undo/redo, cached engine results, layout actions
  components/        steps, 3D scene (React Three Fiber + drei), 2D plan view
  export/            PDF report (jsPDF)
  samples/           three sample houses (rectangle, L, T) + plan-image renderer
```

## Engine summary

- **Load per room** (`src/engine/load.ts`), each line shown in the app and the PDF:
  - Walls, windows, ceiling, floor: U × area × temperature difference. Walls add 10°F
    for sun; the ceiling sees a vented attic 25°F above outdoor design. Slabs lose heat
    at the edge (F × exposed perimeter × ΔT).
  - Windows (sun): glass area × SHGC × a peak solar factor by facing (W > E > S > N in
    summer).
  - Air leakage: ACH × room volume → CFM, then 1.08 × CFM × ΔT (sensible) and
    0.68 × CFM × grains (latent).
  - People (bedrooms + 1, placed in living areas, 230 sensible + 200 latent BTU/h each)
    and a kitchen appliance allowance.
  - Duct allowance: +10% on top.
- **Defaults and sources** (`src/config/engine-config.json`): design temperatures are
  approximate ASHRAE 1%/99% values for a representative city in each IECC climate zone;
  U-factors and SHGC are IECC 2021 Table R402.1.2 code minimums; slab F-factors are from
  ASHRAE 90.1 Appendix A; indoor conditions and people/appliance gains follow ACCA Manual J
  conventions. These were entered by hand from those references and should be checked
  against the documents before anyone relies on them.
- **Equipment**: total (sensible + latent) cooling rounded up to the next nominal size;
  400 CFM/ton. Each room gets a share of the blower airflow by sensible load (at least
  25 CFM), split across ≤150 CFM registers.
- **Layout**: AHU near the plan centre (or where the user puts it); supply trunk along the
  long axis through it; supply registers 1 ft in from exterior walls, under windows first;
  each register takes the shortest branch to the trunk that avoids crossing other rooms;
  one central return plus one per bedroom. 75 variations (AHU spot × trunk offset) are
  scored on duct length, fittings, airflow balance and warnings; the best is kept.
- **Framing** (`src/engine/framing.ts`, `route.ts`): in "between joists" mode the trunk
  runs across the joists in a dropped soffit, a return trunk runs beside it, registers sit
  at bay centres, and every branch runs along the joists inside its bay. A round duct too
  deep for its space becomes the narrowest rectangle at the allowed depth (ASHRAE
  equivalent diameter, ≤ 4:1).
- **Validation**: room airflow > 10% below need; branch > 35 ft; register in a wall,
  outside its room, or overlapping; supply/return totals ≠ AHU airflow (±5%); room with no
  supply; AHU outside the building; a duct that doesn't fit its joist bay or soffit; a
  register boot landing on a joist.

## Acceptance criteria status

| Criterion | Status |
|---|---|
| Upload → exported PDF in < 15 min (3-bed plan) | Scripted run of the full flow takes ~11 s; real users not yet timed |
| Traced areas within 5% of labels | Exact on all three samples (tests + scripted tracing) |
| Every room has a supply register; airflow matches AHU | Tested on all three samples |
| Drag re-validates in < 200 ms | 2–13 ms measured in the browser; shown live in the warnings panel |
| 3D orbit, zoom, pan, click-to-inspect | Yes |
| Disabled types show "coming soon" and can't be picked | Yes (header and start screen) |
| Undo/redo for every edit | Yes |
| Save and reload restores exactly | Byte-identical round trip verified |
| "Estimate, not for permit" on every screen and the PDF | Yes |
| Unit tests: load, duct sizing, each validation rule | 89 tests, incl. hand-checked load lines and all samples in both duct spaces |

## Known simplifications

- Tracing uses SVG instead of Konva (same features, one less dependency).
- Design temperatures come from one representative city per climate zone, not the
  project's actual location; override them in Building assumptions.
- Framing is one uniform joist grid for the whole house; beams, girders and openings are
  not modelled.
- Windows are spread evenly along their wall (no position along the wall yet).
- The trunk is drawn round; returns run straight to the AHU.
- Doors, wall thickness, duct gains/losses and equivalent lengths of fittings are not modelled.
- The JS bundle is ~1.9 MB (three.js + pdf.js); no code-splitting yet.
