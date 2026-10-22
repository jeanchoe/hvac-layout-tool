import { describe, expect, it } from 'vitest';
import { SAMPLE_PLANS, buildSampleProject, sampleLabeledArea } from '../samples/plans';
import type { DesignInputs, Framing, Layout, Project, Room } from '../types';
import { climateForZip, defaultConfig, resolveDesign, type EngineConfig } from './config';
import { branchEfficiency, fitDuct, rectEquivalentDiameter, sizeDuct } from './ductSizing';
import { acrossJoists, bootHitsJoist, joistGrid } from './framing';
import { centroid, polygonArea } from './geometry';
import { routeTree } from './pathfind';
import { assignAirflow, equipmentForTons, simplifiedLoadModel, sizeEquipment, type LoadLine } from './load';
import { deriveWalls } from './walls';
import { analyzeBuilding, autoUnitCount, generateFloorSystems, partitionZones, defaultFloorId, floorElevations, floorFraming, newFloor, roomExposure, evaluate, evaluateAll, generateAllLayouts, migrateProject, rebalanceAirflow, roomsOnFloor, splitRegister, usableRooms } from './index';

const withLayout = (p: Project): Project => ({ ...p, layouts: generateAllLayouts(p) });
/** The ground floor's layout, for single-floor tests. */
const layoutOf = (p: Project): Layout => p.layouts[defaultFloorId(p)][0];
const withFloorLayout = (p: Project, layout: Layout | null): Project => ({ ...p, layouts: layout ? { ...p.layouts, [defaultFloorId(p)]: [layout] } : {} });
const codes = (p: Project) => evaluate(p).warnings.map((w) => w.code);
const box = (id: string, x0: number, y0: number, x1: number, y1: number, extra: Partial<Room> = {}): Room => ({
  id,
  floorId: 'f1',
  name: id,
  polygon: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
  ceilingHeight: 8,
  floorType: 'slab',
  isBedroom: false,
  exteriorOverrides: {},
  windows: [],
  defaultsApplied: true,
  ...extra,
});
const zone4 = climateForZip('27601');

describe('geometry and walls', () => {
  it('computes polygon area', () => {
    expect(polygonArea(box('a', 0, 0, 12, 10).polygon)).toBe(120);
  });

  it('detects exterior vs shared walls and their facing direction', () => {
    const walls = deriveWalls([box('a', 0, 0, 10, 10), box('b', 10, 0, 20, 10)]);
    const a = walls.filter((w) => w.roomId === 'a');
    expect(a.map((w) => [w.facing, w.exterior])).toEqual([
      ['N', true],
      ['E', false],
      ['S', true],
      ['W', true],
    ]);
    expect(a[1].sharedWithRoomId).toBe('b');
  });

  it('treats walls separated by a typical wall thickness as shared', () => {
    const walls = deriveWalls([box('a', 0, 0, 10, 10), box('b', 10.5, 0, 20, 10)]);
    expect(walls.find((w) => w.roomId === 'a' && w.facing === 'E')!.exterior).toBe(false);
  });

  it('treats a wall shared with several smaller rooms as interior', () => {
    const walls = deriveWalls([box('hall', 0, 0, 30, 4), box('a', 0, 4, 10, 14), box('b', 10, 4, 20, 14), box('c', 20, 4, 30, 14)]);
    expect(walls.find((w) => w.roomId === 'hall' && w.facing === 'S')!.exterior).toBe(false);
  });

  it('honours user exterior overrides', () => {
    const walls = deriveWalls([box('a', 0, 0, 10, 10, { exteriorOverrides: { 'a:0': false } })]);
    expect(walls[0].exterior).toBe(false);
    expect(walls[0].autoExterior).toBe(true);
  });
});

describe('climate lookup', () => {
  it('maps ZIP prefixes to climate zones and falls back to the default', () => {
    expect(climateForZip('33101').zone).toBe(1); // Miami
    expect(climateForZip('85004').zone).toBe(2); // Phoenix
    expect(climateForZip('60601').zone).toBe(5); // Chicago
    expect(climateForZip('55401').zone).toBe(6); // Minneapolis
    expect(climateForZip('abc')).toMatchObject({ zone: defaultConfig.defaultClimateZone, fromZip: false });
  });
});

describe('load estimate', () => {
  // Round-number inputs so every line can be checked by hand.
  const D: DesignInputs = {
    outdoorCoolingF: 95,
    indoorCoolingF: 75,
    outdoorHeatingF: 10,
    indoorHeatingF: 70,
    grainsDifference: 30,
    wallU: 0.05,
    windowU: 0.3,
    windowShgc: 0.4,
    ceilingU: 0.03,
    floorU: 0.05,
    slabF: 0.5,
    ach: 0.3,
    ductLoadFactor: 0,
  };
  const estimate = (rooms: Room[], design: DesignInputs = D, config: EngineConfig = defaultConfig) =>
    simplifiedLoadModel.estimate({ rooms, walls: deriveWalls(rooms), climate: zone4, design: resolveDesign(zone4, design, config), config });
  const get = (lines: LoadLine[], key: LoadLine['key']) => lines.find((l) => l.key === key)!.btuh;
  // 10 x 10 ft, 8 ft ceiling, four exterior walls (320 sq ft), slab, one person (no living room to host them).
  const [load] = estimate([box('a', 0, 0, 10, 10)]);

  it('computes cooling conduction as U x A x temperature difference', () => {
    expect(get(load.cooling, 'walls')).toBeCloseTo(320 * 0.05 * (20 + 10)); // +10°F sun on walls
    expect(get(load.cooling, 'ceiling')).toBeCloseTo(100 * 0.03 * (20 + 25)); // attic 25°F above outdoor
    expect(get(load.cooling, 'floor')).toBe(0); // slab: no cooling gain
  });

  it('computes infiltration from air changes per hour', () => {
    const cfm = (0.3 * 800) / 60;
    expect(get(load.cooling, 'infiltration')).toBeCloseTo(1.08 * cfm * 20);
    expect(get(load.latent, 'infiltration')).toBeCloseTo(0.68 * cfm * 30);
    expect(get(load.heating, 'infiltration')).toBeCloseTo(1.08 * cfm * 60);
  });

  it('computes heating loss including slab edge', () => {
    expect(get(load.heating, 'walls')).toBeCloseTo(320 * 0.05 * 60);
    expect(get(load.heating, 'ceiling')).toBeCloseTo(100 * 0.03 * 60);
    expect(get(load.heating, 'floor')).toBeCloseTo(40 * 0.5 * 60);
    expect(load.heatingBtuh).toBeCloseTo(960 + 180 + 1200 + 259.2);
  });

  it('adds people as sensible and latent gains, and splits totals', () => {
    expect(load.occupants).toBe(1);
    expect(get(load.cooling, 'people')).toBe(230);
    expect(get(load.latent, 'people')).toBe(200);
    expect(load.sensibleCoolingBtuh).toBeCloseTo(480 + 135 + 86.4 + 230);
    expect(load.latentCoolingBtuh).toBeCloseTo(81.6 + 200);
    expect(load.coolingBtuh).toBeCloseTo(load.sensibleCoolingBtuh + load.latentCoolingBtuh);
  });

  it('computes window gains: conduction plus SHGC-weighted sun by direction (W > E > S > N in summer)', () => {
    const solar = (wallId: string) => {
      const [l] = estimate([box('a', 0, 0, 10, 10, { windows: [{ id: 'w', wallId, count: 1, width: 3, height: 4 }] })]);
      expect(get(l.cooling, 'windowConduction')).toBeCloseTo(12 * 0.3 * 20);
      return get(l.cooling, 'windowSolar');
    };
    const [n, e, s, w] = ['a:0', 'a:1', 'a:2', 'a:3'].map(solar);
    expect(w).toBeGreaterThan(e);
    expect(e).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(n);
    expect(w).toBeCloseTo(12 * 0.4 * defaultConfig.loads.solarGainFactor.W);
  });

  it('reads factors from config, not code', () => {
    const cfg = structuredClone(defaultConfig);
    cfg.loads.atticTempAdderF = 0;
    expect(get(estimate([box('a', 0, 0, 10, 10)], D, cfg)[0].cooling, 'ceiling')).toBeCloseTo(100 * 0.03 * 20);
  });

  it('adds the duct allowance on top of the room load', () => {
    const [withDucts] = estimate([box('a', 0, 0, 10, 10)], { ...D, ductLoadFactor: 0.1 });
    expect(get(withDucts.cooling, 'ducts')).toBeCloseTo(load.sensibleCoolingBtuh * 0.1);
    expect(withDucts.heatingBtuh).toBeCloseTo(load.heatingBtuh * 1.1);
  });

  it('accounts for taller ceilings through wall area and air volume', () => {
    const [tall] = estimate([box('a', 0, 0, 10, 10, { ceilingHeight: 10 })]);
    expect(get(tall.cooling, 'walls')).toBeCloseTo(400 * 0.05 * 30);
    expect(tall.sensibleCoolingBtuh).toBeGreaterThan(load.sensibleCoolingBtuh);
  });

  it('places bedrooms + 1 people in living areas, honouring per-room overrides', () => {
    const rooms = [box('Bed 1', 0, 0, 10, 10, { isBedroom: true }), box('Bed 2', 10, 0, 20, 10, { isBedroom: true }), box('Living', 0, 10, 20, 20), box('Kitchen', 20, 0, 30, 20)];
    const loads = estimate(rooms);
    expect(loads.map((l) => l.occupants)).toEqual([0, 0, 3, 0]);
    expect(get(loads[3].cooling, 'appliances')).toBe(defaultConfig.loads.kitchenApplianceBtuh);
    const over = estimate(rooms.map((r) => (r.id === 'Bed 1' ? { ...r, occupants: 2 } : r)));
    expect(over.map((l) => l.occupants)).toEqual([2, 0, 1, 0]);
  });

  it('uses climate-zone defaults with sources unless the project overrides them', () => {
    const d = resolveDesign(zone4, { wallU: 0.06 });
    expect(d.wallU).toMatchObject({ value: 0.06, overridden: true });
    expect(d.windowU).toMatchObject({ value: defaultConfig.climateZones['4'].windowU, overridden: false });
    expect(d.windowU.source).toMatch(/IECC 2021/);
    expect(d.outdoorCoolingF.source).toMatch(/Raleigh/);
  });

  it('shares blower airflow across rooms by sensible load', () => {
    const loads = assignAirflow(estimate([box('a', 0, 0, 10, 10), box('b', 10, 0, 30, 10)]), 800);
    expect(loads.reduce((s, l) => s + l.requiredCfm, 0)).toBe(800);
    expect(loads[1].requiredCfm / loads[0].requiredCfm).toBeCloseTo(loads[1].sensibleCoolingBtuh / loads[0].sensibleCoolingBtuh, 1);
    // A tiny room is lifted to the minimum and the others share what's left.
    const floored = assignAirflow(estimate([box('a', 0, 0, 10, 10), box('b', 10, 0, 40, 30)]), 800, 200);
    expect(floored.map((l) => l.requiredCfm)).toEqual([200, 600]);
  });

  it('sizes equipment to the next nominal tonnage', () => {
    expect(sizeEquipment(25000).tons).toBe(2.5);
    expect(sizeEquipment(24000).tons).toBe(2);
    expect(equipmentForTons(3)).toEqual({ tons: 3, capacityBtuh: 36000, airflowCfm: 1200 });
  });
});

describe('duct sizing', () => {
  it('picks the smallest round duct that carries the airflow', () => {
    expect(sizeDuct(25)).toBe(4);
    expect(sizeDuct(100)).toBe(6);
    expect(sizeDuct(101)).toBe(7);
    expect(sizeDuct(1200)).toBe(18);
  });

  it('extrapolates beyond the table', () => {
    expect(sizeDuct(5000)).toBeGreaterThan(22);
  });

  it('loses airflow on long branches', () => {
    expect(branchEfficiency(10)).toBe(1);
    expect(branchEfficiency(30)).toBeCloseTo(0.95);
    expect(branchEfficiency(1000)).toBe(defaultConfig.branchEfficiency.minEfficiency);
  });
});

describe.each(SAMPLE_PLANS)('sample plan: $name', (plan) => {
  const project = withLayout(buildSampleProject(plan));
  const results = evaluateAll(project);
  const floors = project.floors.map((f) => ({ f, layout: project.layouts[f.id][0], result: results[f.id], rooms: usableRooms(roomsOnFloor(project.rooms, f.id)) }));

  it('room areas match the labeled areas within 5%', () => {
    project.rooms.forEach((room, i) => {
      const labeled = sampleLabeledArea(plan.rooms[i]);
      expect(Math.abs(polygonArea(room.polygon) - labeled) / labeled).toBeLessThan(0.05);
    });
  });

  it('gives every floor its own system', () => {
    for (const { layout, rooms } of floors) if (rooms.length) expect(layout).toBeDefined();
  });

  it('gives every room at least one supply register on its own floor', () => {
    for (const { layout, rooms } of floors) {
      for (const room of rooms) expect(layout.registers.some((r) => r.kind === 'supply' && r.roomId === room.id)).toBe(true);
    }
  });

  it("matches each floor's supply and return airflow to its air handler", () => {
    for (const { layout } of floors) {
      const sum = (k: string) => layout.registers.filter((r) => r.kind === k).reduce((s, r) => s + r.targetCfm, 0);
      expect(sum('supply')).toBe(layout.airHandler.airflowCfm);
      expect(sum('return')).toBe(layout.airHandler.airflowCfm);
    }
  });

  it('gives every supply register at least the minimum airflow', () => {
    for (const { layout } of floors) for (const r of layout.registers.filter((x) => x.kind === 'supply')) expect(r.targetCfm).toBeGreaterThanOrEqual(defaultConfig.minCfmPerSupplyRegister);
  });

  it('adds a return for each bedroom plus a central return on each floor', () => {
    expect(project.rooms.filter((r) => r.isBedroom).length).toBeGreaterThanOrEqual(3);
    for (const { layout, rooms } of floors) {
      for (const b of rooms.filter((r) => r.isBedroom)) expect(layout.registers.some((r) => r.kind === 'return' && r.roomId === b.id)).toBe(true);
      expect(layout.registers.some((r) => r.id === 'r-central')).toBe(true);
    }
  });

  it('produces layouts with no warnings', () => {
    for (const { result } of floors) expect(result.warnings).toEqual([]);
  });

  it('forms a duct tree with every register connected', () => {
    for (const { layout, result } of floors) {
      for (const r of layout.registers) expect(result.ducts.some((d) => d.registerId === r.id)).toBe(true);
      expect(result.ducts.some((d) => d.type === 'trunk' && d.side === 'supply')).toBe(true);
      for (const d of result.ducts) expect(d.diameter).toBe(sizeDuct(d.cfm));
    }
  });

  it('re-evaluates fast enough for live dragging (< 200 ms)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) evaluate(project);
    expect((performance.now() - t0) / 10).toBeLessThan(200);
  });

  it('survives a JSON save/load round trip exactly', () => {
    const reloaded = migrateProject(JSON.parse(JSON.stringify(project)));
    expect(reloaded).toEqual(project);
    expect(evaluateAll(reloaded)).toEqual(results);
  });
});

describe('validation rules', () => {
  const base = withLayout(buildSampleProject(SAMPLE_PLANS[0]));
  const L = layoutOf(base);
  const editRegisters = (fn: (regs: typeof L.registers) => typeof L.registers): Project => withFloorLayout(base, { ...L, registers: fn(L.registers.map((r) => ({ ...r }))) });
  const firstSupply = L.registers.find((r) => r.kind === 'supply')!;
  const roomOf = base.rooms.find((r) => r.id === firstSupply.roomId)!;

  it('starts clean', () => {
    expect(codes(base)).toEqual([]);
  });

  it('flags a room with no supply register', () => {
    const p = editRegisters((regs) => regs.filter((r) => !(r.kind === 'supply' && r.roomId === roomOf.id)));
    expect(codes(p)).toContain('ROOM_NO_SUPPLY');
  });

  it('flags a room whose airflow falls more than 10% below target', () => {
    const p = editRegisters((regs) => regs.map((r) => (r.kind === 'supply' && r.roomId === roomOf.id ? { ...r, targetCfm: Math.round(r.targetCfm * 0.5) } : r)));
    const w = evaluate(p).warnings.find((x) => x.code === 'ROOM_LOW_AIRFLOW');
    expect(w?.componentIds).toContain(roomOf.id);
  });

  it('does not flag a room at exactly 91% of target', () => {
    const r = evaluate(base);
    const ratio = r.airflow[roomOf.id].required / r.airflow[roomOf.id].delivered;
    const p = editRegisters((regs) => regs.map((x) => (x.kind === 'supply' && x.roomId === roomOf.id ? { ...x, targetCfm: x.targetCfm * ratio * 0.91 } : x)));
    expect(evaluate(p).warnings.filter((w) => w.code === 'ROOM_LOW_AIRFLOW' && w.componentIds.includes(roomOf.id))).toEqual([]);
  });

  it('flags a branch longer than the maximum', () => {
    const far = base.rooms.flatMap((r) => r.polygon).reduce((m, p) => Math.max(m, p.y), 0);
    const p: Project = withFloorLayout(base, { ...L, trunk: { axis: 'x', offset: far + 30 } });
    expect(codes(p)).toContain('BRANCH_TOO_LONG');
  });

  it('flags a register sitting inside a wall', () => {
    const wall = roomOf.polygon;
    const p = editRegisters((regs) => regs.map((r) => (r.id === firstSupply.id ? { ...r, position: { x: (wall[0].x + wall[1].x) / 2, y: wall[0].y + 0.1 } } : r)));
    expect(codes(p)).toContain('REGISTER_IN_WALL');
  });

  it('flags a register outside its room', () => {
    const other = base.rooms.find((r) => r.id !== roomOf.id && r.name === 'Living Room')!;
    const c = { x: other.polygon[0].x + 5, y: other.polygon[0].y + 5 };
    const p = editRegisters((regs) => regs.map((r) => (r.id === firstSupply.id ? { ...r, position: c } : r)));
    expect(codes(p)).toContain('REGISTER_OUTSIDE_ROOM');
  });

  it('flags overlapping components', () => {
    const p = editRegisters((regs) => {
      const second = regs.find((r) => r.id !== firstSupply.id)!;
      second.position = { x: firstSupply.position.x + 0.5, y: firstSupply.position.y };
      return regs;
    });
    expect(codes(p)).toContain('COMPONENT_OVERLAP');
  });

  it('flags total airflow not matching the air handler, and rebalancing clears it', () => {
    const p: Project = withFloorLayout(base, { ...L, airHandler: { ...L.airHandler, ...equipmentForTons(L.airHandler.tons + 1) } });
    expect(codes(p)).toContain('AIRFLOW_MISMATCH');
    const fixed: Project = withFloorLayout(p, rebalanceAirflow(p));
    expect(codes(fixed)).not.toContain('AIRFLOW_MISMATCH');
  });

  it('flags an air handler outside the building', () => {
    const p: Project = withFloorLayout(base, { ...L, airHandler: { ...L.airHandler, position: { x: -50, y: -50 } } });
    expect(codes(p)).toContain('AHU_OUTSIDE_BUILDING');
  });

  it('marks the layout stale when rooms change', () => {
    const p: Project = { ...base, rooms: base.rooms.map((r, i) => (i === 0 ? { ...r, ceilingHeight: 10 } : r)) };
    expect(evaluate(p).layoutStale).toBe(true);
    expect(evaluate(base).layoutStale).toBe(false);
  });
});

describe('analysis', () => {
  it('sizes the sample ranch to a sensible system', () => {
    const a = evaluate(buildSampleProject(SAMPLE_PLANS[0]));
    expect(a.totals.areaSqFt).toBe(1680);
    // Code-minimum 1,680 sq ft house in zone 4: roughly 600-1,000 sq ft per ton.
    expect(a.recommended.tons).toBeGreaterThanOrEqual(1.5);
    expect(a.recommended.tons).toBeLessThanOrEqual(3);
    expect(a.totals.latentCoolingBtuh).toBeGreaterThan(0);
    expect(a.totals.heatingBtuh).toBeGreaterThan(0);
  });
});

describe('rectangular ducts', () => {
  it('matches the ASHRAE equivalent diameter for a square duct', () => {
    expect(rectEquivalentDiameter(10, 10)).toBeCloseTo(10.93, 1);
  });

  it('keeps round ducts that fit and flattens ones that do not', () => {
    expect(fitDuct(8, 8.75, 22.5)).toEqual({ shape: 'round', fits: true });
    const flat = fitDuct(8, 5.5, 22.5);
    expect(flat).toMatchObject({ shape: 'rect', heightIn: 5, fits: true });
    expect(rectEquivalentDiameter(flat.widthIn!, 5)).toBeGreaterThanOrEqual(8);
    expect(fitDuct(8, 3, 22.5).fits).toBe(false); // would need a duct far wider than 4:1
  });
});

const JOISTS = (joistDirection: Framing['joistDirection']): Framing => ({ ductSpace: 'joist-bays', joistDirection, spacingIn: 24, depthIn: 9.25, soffitDepthIn: 14, plenumDepthIn: 30 });

describe.each(SAMPLE_PLANS.flatMap((plan) => (['y', 'x'] as const).map((dir) => ({ plan, dir }))))('joist bays: $plan.name, joists along $dir', ({ plan, dir }) => {
  const framing = JOISTS(dir);
  const project = withLayout({ ...buildSampleProject(plan), framing });
  const result = evaluate(project);
  const layout = layoutOf(project);
  const across = (p: { x: number; y: number }) => acrossJoists(p, framing);

  it('runs the trunk across the joists', () => {
    expect(layout.trunk.axis).toBe(dir === 'y' ? 'x' : 'y');
  });

  it('runs every supply branch along the joists, inside one bay', () => {
    const branches = result.ducts.filter((d) => d.type === 'branch' && d.side === 'supply');
    expect(branches.length).toBe(layout.registers.filter((r) => r.kind === 'supply').length);
    for (const b of branches) expect(across(b.start)).toBeCloseTo(across(b.end), 6);
  });

  it('keeps every register boot between joists', () => {
    const grid = joistGrid(usableRooms(project.rooms), framing)!;
    for (const r of layout.registers) expect(bootHitsJoist(across(r.position), grid)).toBe(false);
  });

  it('produces a layout with no warnings', () => {
    expect(result.warnings).toEqual([]);
  });
});

describe('framing rules', () => {
  const framing = JOISTS('y');
  const base = withLayout({ ...buildSampleProject(SAMPLE_PLANS[0]), framing });

  it('flags ducts that do not fit shallow joists', () => {
    const shallow: Project = { ...base, framing: { ...framing, depthIn: 3.5 } };
    const w = evaluate(shallow).warnings.filter((x) => x.code === 'DUCT_DOES_NOT_FIT');
    expect(w.length).toBeGreaterThan(0);
  });

  it('flags a register that lands on a joist', () => {
    const reg = layoutOf(base).registers.find((r) => r.kind === 'supply')!;
    const grid = evaluate(base).grid!;
    const onJoist = { x: grid.origin + Math.round((reg.position.x - grid.origin) / grid.spacingFt) * grid.spacingFt, y: reg.position.y };
    const p: Project = withFloorLayout(base, { ...layoutOf(base), registers: layoutOf(base).registers.map((r) => (r.id === reg.id ? { ...r, position: onJoist } : r)) });
    expect(evaluate(p).warnings.find((x) => x.code === 'REGISTER_ON_JOIST')?.componentIds).toEqual([reg.id]);
  });

  it('marks the layout stale when the framing changes', () => {
    expect(evaluate(base).layoutStale).toBe(false);
    expect(evaluate({ ...base, framing: { ...framing, spacingIn: 16 } }).layoutStale).toBe(true);
  });
});

describe('joist bays: every common framing generates a clean layout', () => {
  const cases = SAMPLE_PLANS.flatMap((plan) =>
    (['y', 'x'] as const).flatMap((joistDirection) =>
      [12, 16, 19.2, 24].flatMap((spacingIn) => [7.25, 9.25, 11.25, 14].map((depthIn) => ({ plan, framing: { ...JOISTS(joistDirection), spacingIn, depthIn } }))),
    ),
  );
  it.each(cases)('$plan.id, joists $framing.joistDirection, $framing.spacingIn" o.c., $framing.depthIn" deep', ({ plan, framing }) => {
    const project = withLayout({ ...buildSampleProject(plan), framing });
    expect(Object.values(evaluateAll(project)).flatMap((r) => r.warnings.map((w) => `${r.floorId}: ${w.message}`))).toEqual([]);
  });
});

describe('splitting an oversized register', () => {
  // The setup from user testing: 12" o.c. joists, 2x12, which leaves a 10.5" wide bay.
  const framing = { ...JOISTS('x'), spacingIn: 12, depthIn: 11.25 };
  const base = withLayout({ ...buildSampleProject(SAMPLE_PLANS[0]), framing });
  const reg = layoutOf(base).registers.find((r) => r.kind === 'supply' && evaluate(base).branchLength[r.id] > 4)!;
  const tooBig: Project = withFloorLayout(base, { ...layoutOf(base), registers: layoutOf(base).registers.map((r) => (r.id === reg.id ? { ...r, targetCfm: 600 } : r)) });

  it('offers a split when a branch cannot fit its bay', () => {
    const w = evaluate(tooBig).warnings.find((x) => x.code === 'DUCT_DOES_NOT_FIT');
    expect(w?.fix).toMatchObject({ kind: 'split-register', registerId: reg.id });
    expect(w!.fix!.parts).toBeGreaterThan(1);
  });

  it('clears the warning once split, keeping the airflow', () => {
    const fix = evaluate(tooBig).warnings.find((x) => x.code === 'DUCT_DOES_NOT_FIT')!.fix!;
    const split: Project = withFloorLayout(tooBig, splitRegister(tooBig, fix.registerId, fix.parts));
    const pieces = layoutOf(split).registers.filter((r) => r.id === reg.id || r.id.startsWith(`${reg.id}-`));
    expect(pieces).toHaveLength(fix.parts);
    expect(pieces.reduce((s, r) => s + r.targetCfm, 0)).toBe(600);
    expect(new Set(layoutOf(split).registers.map((r) => r.id)).size).toBe(layoutOf(split).registers.length);
    // Only the system total is off (we forced 600 CFM by hand): nothing overlaps or fails to fit.
    expect(evaluate(split).warnings.map((x) => x.code)).toEqual(['AIRFLOW_MISMATCH']);
  });
});

describe('multiple floors', () => {
  const plan = SAMPLE_PLANS.find((p) => p.id === 'two-story')!;
  const project = buildSampleProject(plan);
  const byName = (name: string) => project.rooms.find((r) => r.name === name)!;
  const exposure = roomExposure(project.rooms, project.floors);

  it('upgrades a v1 (single-floor) project file', () => {
    const v1 = { schemaVersion: 1, id: 'p', name: 'Old', zipCode: '27601', buildingType: 'single-story-residential', systemType: 'forced-air-ducted', scalePxPerFt: 20, scaleLine: null, background: null, rooms: [{ ...box('a', 0, 0, 10, 10), floorId: undefined }], layout: null, createdAt: '', updatedAt: '' };
    const v2 = migrateProject(v1);
    expect(v2.schemaVersion).toBe(3);
    expect(v2.floors).toHaveLength(1);
    expect(v2.floors[0]).toMatchObject({ level: 0, scalePxPerFt: 20 });
    expect(v2.rooms[0].floorId).toBe(v2.floors[0].id);
    expect(v2.layouts).toEqual({});
    expect('layout' in v2 || 'scalePxPerFt' in v2).toBe(false);
  });

  it('works out which ceilings and floors are covered by rooms above and below', () => {
    expect(exposure.get(byName('Living Room').id)).toMatchObject({ level: 0, ceiling: 0, floor: 1 });
    expect(exposure.get(byName('Family Room').id)).toMatchObject({ level: 0, ceiling: 1 }); // one-storey wing
    expect(exposure.get(byName('Bedroom 3').id)).toMatchObject({ level: 1, ceiling: 1, floor: 0 });
  });

  it('measures partial cover', () => {
    const rooms = [box('down', 0, 0, 20, 10), { ...box('up', 0, 0, 10, 10), floorId: 'f2' }];
    const e = roomExposure(rooms, [newFloor('f1', 0), newFloor('f2', 1)]);
    expect(e.get('down')!.ceiling).toBeCloseTo(0.5, 1);
    expect(e.get('up')!.floor).toBe(0);
  });

  it('only counts ceiling and ground losses where they apply', () => {
    const loads = analyzeBuilding(project).loads;
    const line = (name: string, list: 'cooling' | 'heating', key: string) => loads.find((l) => l.roomId === byName(name).id)![list].find((x) => x.key === key)!.btuh;
    expect(line('Living Room', 'cooling', 'ceiling')).toBe(0); // bedroom above
    expect(line('Family Room', 'cooling', 'ceiling')).toBeGreaterThan(0);
    expect(line('Bedroom 3', 'heating', 'floor')).toBe(0); // conditioned room below
    expect(line('Living Room', 'heating', 'floor')).toBeGreaterThan(0); // slab edge
  });

  it('never treats rooms on different floors as sharing a wall', () => {
    const walls = deriveWalls(project.rooms);
    const bed3 = walls.filter((w) => w.roomId === byName('Bedroom 3').id);
    expect(bed3.find((w) => w.facing === 'N')!.exterior).toBe(true);
    expect(bed3.every((w) => !w.sharedWithRoomId || project.rooms.find((r) => r.id === w.sharedWithRoomId)!.floorId === 'f2')).toBe(true);
  });

  it('runs lower-floor ducts in the floor cavity and top-floor ducts in the attic by default', () => {
    expect(floorFraming(project, 'f1').ductSpace).toBe('joist-bays');
    expect(floorFraming(project, 'f2').ductSpace).toBe('attic');
    const overridden = { ...project, floors: project.floors.map((f) => (f.id === 'f1' ? { ...f, ductSpace: 'attic' as const } : f)) };
    expect(floorFraming(overridden, 'f1').ductSpace).toBe('attic');
    const all = evaluateAll({ ...project, layouts: generateAllLayouts(project) });
    expect(all.f1.grid).not.toBeNull();
    expect(all.f2.grid).toBeNull();
  });

  it('works out floor-to-floor height from the ceiling and joists unless one is entered', () => {
    const z = floorElevations(project);
    expect(z.get('f1')).toBe(0);
    expect(z.get('f2')).toBeCloseTo(8 + 9.25 / 12 + 0.25); // 8 ft ceiling + 2x10 + subfloor
    const deeper = { ...project, framing: { ...defaultConfig.framingDefaults, depthIn: 11.875 } };
    expect(floorElevations(deeper).get('f2')).toBeCloseTo(8 + 11.875 / 12 + 0.25);
    const entered = { ...project, floors: project.floors.map((f) => (f.id === 'f1' ? { ...f, heightFt: 10 } : f)) };
    expect(floorElevations(entered).get('f2')).toBe(10);
  });

  it('sizes one system per floor', () => {
    const all = evaluateAll({ ...project, layouts: generateAllLayouts(project) });
    expect(Object.keys(all).sort()).toEqual(['f1', 'f2']);
    for (const r of Object.values(all)) {
      expect(r.recommended.tons).toBeGreaterThanOrEqual(1.5);
      expect(r.rooms.every((room) => room.floorId === r.floorId)).toBe(true);
    }
    expect(all.f1.building.totals.areaSqFt).toBe(2528);
  });
});

describe('ceiling plenum: pathfinding around beams', () => {
  const PLENUM: Framing = { ...defaultConfig.framingDefaults, ductSpace: 'plenum', plenumDepthIn: 30 };
  const room = box('hall', 0, 0, 40, 20);
  const beam = (id: string, a: { x: number; y: number }, b: { x: number; y: number }, kind: 'main' | 'secondary', depthIn = 18) => ({ id, floorId: 'f1', a, b, kind, depthIn });
  const total = (t: ReturnType<typeof routeTree>) => t.segments.reduce((s, x) => s + Math.hypot(x.end.x - x.start.x, x.end.y - x.start.y), 0);

  it('runs straight with no elbows when the way is clear', () => {
    const t = routeTree([room], [], { x: 5, y: 10 }, [{ id: 'a', at: { x: 35, y: 10 }, cfm: 100 }], defaultConfig);
    expect(t.turns).toBe(0);
    expect(total(t)).toBeCloseTo(30, 0);
  });

  it('shares a main between terminals and sizes it for both', () => {
    const t = routeTree([room], [], { x: 2, y: 10 }, [
      { id: 'a', at: { x: 38, y: 4 }, cfm: 100 },
      { id: 'b', at: { x: 38, y: 16 }, cfm: 150 },
    ], defaultConfig);
    const main = t.segments.filter((x) => x.terminalCount === 2);
    expect(main.length).toBeGreaterThan(0);
    expect(main.every((x) => x.cfm === 250)).toBe(true);
    expect(t.tees).toBe(1);
    // Shared routing is shorter than two separate runs.
    expect(total(t)).toBeLessThan(2 * (36 + 6));
  });

  it('goes around a main beam through a gap rather than crossing it', () => {
    const wallBeam = beam('b1', { x: 20, y: -1 }, { x: 20, y: 14 }, 'main');
    const t = routeTree([room], [wallBeam], { x: 5, y: 5 }, [{ id: 'a', at: { x: 35, y: 5 }, cfm: 100 }], defaultConfig);
    expect(t.segments.flatMap((x) => x.crossings)).toEqual([]);
    expect(Math.max(...t.segments.flatMap((x) => [x.start.y, x.end.y]))).toBeGreaterThan(14);
  });

  it('never runs along a main beam, and only runs along a secondary beam by passing under it', () => {
    const along = beam('m', { x: 0, y: 10 }, { x: 40, y: 10 }, 'main');
    const t = routeTree([room], [along], { x: 2, y: 10 }, [{ id: 'a', at: { x: 38, y: 10 }, cfm: 100 }], defaultConfig);
    expect(t.segments.flatMap((x) => x.crossings).filter((c) => c.kind === 'main').length).toBeLessThanOrEqual(2); // only where the unit and diffuser sit on it
    const sec = beam('s', { x: 0, y: 10 }, { x: 40, y: 10 }, 'secondary');
    const t2 = routeTree([room], [sec], { x: 2, y: 6 }, [{ id: 'a', at: { x: 38, y: 6 }, cfm: 100 }], defaultConfig);
    expect(t2.segments.flatMap((x) => x.crossings)).toEqual([]); // the clear route beside the beam wins
  });

  it('flags a main beam that cannot be avoided', () => {
    const p: Project = { ...buildSampleProject(SAMPLE_PLANS[0]), framing: PLENUM };
    const b = analyzeBuilding(p).rooms.flatMap((r) => r.polygon);
    const xs = b.map((q) => q.x);
    const ys = b.map((q) => q.y);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const withBeam: Project = { ...p, beams: [beam('b1', { x: midX, y: Math.min(...ys) - 1 }, { x: midX, y: Math.max(...ys) + 1 }, 'main')] };
    const laid = withLayout(withBeam);
    expect(evaluate(laid).warnings.some((w) => w.code === 'DUCT_CROSSES_MAIN_BEAM')).toBe(true);
  });

  it('drops under a secondary beam and flattens the duct to fit below it', () => {
    const p: Project = { ...buildSampleProject(SAMPLE_PLANS[0]), framing: PLENUM };
    const ys = analyzeBuilding(p).rooms.flatMap((r) => r.polygon.map((q) => q.y));
    const xs = analyzeBuilding(p).rooms.flatMap((r) => r.polygon.map((q) => q.x));
    const beams = [20, 30, 40].map((x, i) => beam(`s${i}`, { x: Math.min(...xs) + x, y: Math.min(...ys) - 1 }, { x: Math.min(...xs) + x, y: Math.max(...ys) + 1 }, 'secondary', 20));
    const laid = withLayout({ ...p, beams });
    const r = evaluate(laid);
    expect(r.warnings).toEqual([]);
    const under = r.ducts.filter((d) => r.building && d.maxHeightIn !== undefined && d.maxHeightIn < 29);
    expect(under.length).toBeGreaterThan(0);
    for (const d of under) expect(d.maxHeightIn).toBe(30 - 20 - 1);
    for (const d of under) expect(d.shape === 'round' ? d.diameter : d.heightIn!).toBeLessThanOrEqual(9);
  });

  it('reports a duct too big to pass under a deep secondary beam', () => {
    const p: Project = { ...buildSampleProject(SAMPLE_PLANS[0]), framing: PLENUM };
    const pts = analyzeBuilding(p).rooms.flatMap((r) => r.polygon);
    const minY = Math.min(...pts.map((q) => q.y));
    const maxY = Math.max(...pts.map((q) => q.y));
    const minX = Math.min(...pts.map((q) => q.x));
    const laid = withLayout({ ...p, beams: [10, 20, 30, 40, 50].map((x, i) => beam(`d${i}`, { x: minX + x, y: minY - 1 }, { x: minX + x, y: maxY + 1 }, 'secondary', 28)) });
    const w = evaluate(laid).warnings.find((x) => x.code === 'DUCT_DOES_NOT_FIT');
    expect(w?.message).toMatch(/under beam B-\d/);
  });

  it('places the unit inside a marked equipment area and flags it when moved out', () => {
    const p = buildSampleProject(SAMPLE_PLANS[0]);
    const area = { id: 'mech', floorId: 'f1', name: 'Mech closet', polygon: [{ x: 6, y: 19 }, { x: 11, y: 19 }, { x: 11, y: 22 }, { x: 6, y: 22 }] };
    const laid = withLayout({ ...p, equipmentAreas: [area] });
    const ahu = layoutOf(laid).airHandler.position;
    expect(ahu.x).toBeGreaterThanOrEqual(6);
    expect(ahu.x).toBeLessThanOrEqual(11);
    expect(ahu.y).toBeGreaterThanOrEqual(19);
    expect(ahu.y).toBeLessThanOrEqual(22);
    expect(codes(laid)).not.toContain('UNIT_OUTSIDE_EQUIPMENT_AREA');
    const moved = withFloorLayout(laid, { ...layoutOf(laid), airHandler: { ...layoutOf(laid).airHandler, position: { x: 40, y: 15 } } });
    expect(codes(moved)).toContain('UNIT_OUTSIDE_EQUIPMENT_AREA');
  });

  it.each(SAMPLE_PLANS)('routes $name in a plenum with no warnings, fast enough to drag', (plan) => {
    const project = withLayout({ ...buildSampleProject(plan), framing: PLENUM });
    const all = evaluateAll(project);
    expect(Object.values(all).flatMap((r) => r.warnings.map((w) => w.message))).toEqual([]);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) evaluateAll(project);
    expect((performance.now() - t0) / 5).toBeLessThan(200);
  });
});

describe('zones and multiple units', () => {
  const base = buildSampleProject(SAMPLE_PLANS.find((p) => p.id === 't-shape')!);
  const twoUnits: Project = { ...base, floors: base.floors.map((f) => ({ ...f, unitCount: 2 })) };
  const systems = generateFloorSystems(twoUnits);
  const project: Project = { ...twoUnits, layouts: { f1: systems } };
  const result = evaluate(project);

  it('splits the floor into compact zones of similar load, covering every room once', () => {
    const a = analyzeBuilding(base);
    const zones = partitionZones(a.rooms, a.loads, 2);
    expect(zones).toHaveLength(2);
    const all = zones.flat().map((r) => r.id);
    expect(new Set(all).size).toBe(a.rooms.length);
    const load = (z: Room[]) => z.reduce((s, r) => s + a.loads.find((l) => l.roomId === r.id)!.coolingBtuh, 0);
    const [l1, l2] = zones.map(load);
    expect(Math.min(l1, l2) / Math.max(l1, l2)).toBeGreaterThan(0.6);
  });

  it('adds a unit when a floor would need more than the largest unit', () => {
    expect(autoUnitCount(4.5 * 12000)).toBe(1);
    expect(autoUnitCount(7 * 12000)).toBe(2);
    expect(autoUnitCount(16 * 12000)).toBe(4);
  });

  it('gives each zone its own unit, sized by the zone load', () => {
    expect(systems.map((s) => [s.id, s.name])).toEqual([
      ['u1', 'AHU-1'],
      ['u2', 'AHU-2'],
    ]);
    for (const s of result.systems) expect(s.recommended.tons).toBeLessThan(result.recommended.tons + 0.01);
    for (const sys of systems) {
      const sum = (k: string) => sys.registers.filter((r) => r.kind === k).reduce((t, r) => t + r.targetCfm, 0);
      expect(sum('supply')).toBe(sys.airHandler.airflowCfm);
      expect(sum('return')).toBe(sys.airHandler.airflowCfm);
      for (const r of sys.registers) expect(sys.roomIds).toContain(r.roomId);
    }
    expect(Math.hypot(systems[0].airHandler.position.x - systems[1].airHandler.position.x, systems[0].airHandler.position.y - systems[1].airHandler.position.y)).toBeGreaterThanOrEqual(3);
  });

  it('routes each system separately with no warnings, ids tagged by system', () => {
    expect(result.warnings.map((w) => w.message)).toEqual([]);
    expect(result.ducts.every((d) => /^u[12]\//.test(d.id))).toBe(true);
    expect(new Set(result.ducts.map((d) => d.id)).size).toBe(result.ducts.length);
  });

  it('flags a room no unit serves, and marks a zone change as stale', () => {
    const [s1, s2] = systems;
    const moved = s1.roomIds![0];
    const dropped: Project = { ...project, layouts: { f1: [{ ...s1, roomIds: s1.roomIds!.slice(1) }, s2] } };
    expect(evaluate(dropped).warnings.find((w) => w.code === 'ROOM_NOT_SERVED')?.componentIds).toEqual([moved]);
    const reassigned: Project = { ...project, layouts: { f1: [{ ...s1, roomIds: s1.roomIds!.slice(1) }, { ...s2, roomIds: [...s2.roomIds!, moved] }] } };
    expect(evaluate(reassigned).layoutStale).toBe(true);
    // Regenerating keeps the user's zones.
    const regen = generateFloorSystems(reassigned);
    expect(regen[1].roomIds).toContain(moved);
    expect(generateFloorSystems(reassigned, { rezone: true })[1].roomIds).not.toEqual(regen[1].roomIds);
  });

  it('never stacks units when the equipment area only fits one; the overflow is flagged instead', () => {
    const c = centroid(base.rooms[0].polygon);
    const small = [{ x: c.x - 2.5, y: c.y - 1.5 }, { x: c.x + 2.5, y: c.y - 1.5 }, { x: c.x + 2.5, y: c.y + 1.5 }, { x: c.x - 2.5, y: c.y + 1.5 }];
    const p0: Project = { ...twoUnits, equipmentAreas: [{ id: 'ea1', floorId: 'f1', name: 'Mech', polygon: small }] };
    const sys = generateFloorSystems(p0);
    const [a, b] = sys.map((s) => s.airHandler.position);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(4);
    const ws = evaluate({ ...p0, layouts: { f1: sys } }).warnings;
    expect(ws.some((w) => w.code === 'COMPONENT_OVERLAP')).toBe(false);
    expect(ws.filter((w) => w.code === 'UNIT_OUTSIDE_EQUIPMENT_AREA')).toHaveLength(1);
  });

  it('upgrades a v2 project (one layout per floor) to a list of systems', () => {
    const one = generateFloorSystems(base)[0];
    const v2 = { ...base, schemaVersion: 2, layouts: { f1: { ...one, id: undefined, name: undefined, roomIds: undefined, airHandler: { ...one.airHandler, id: 'ahu' } } } };
    const v3 = migrateProject(JSON.parse(JSON.stringify(v2)));
    expect(v3.schemaVersion).toBe(3);
    expect(v3.layouts.f1).toHaveLength(1);
    expect(v3.layouts.f1[0]).toMatchObject({ id: 'u1', name: 'AHU-1', roomIds: null });
    expect(v3.layouts.f1[0].airHandler.id).toBe('ahu:u1');
  });
});
