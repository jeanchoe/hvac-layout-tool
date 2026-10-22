import { describe, expect, it } from 'vitest';
import { SAMPLE_PLANS, buildSampleProject, sampleLabeledArea } from '../samples/plans';
import type { DesignInputs, Framing, Project, Room } from '../types';
import { climateForZip, defaultConfig, resolveDesign, type EngineConfig } from './config';
import { branchEfficiency, fitDuct, rectEquivalentDiameter, sizeDuct } from './ductSizing';
import { acrossJoists, bootHitsJoist, joistGrid } from './framing';
import { polygonArea } from './geometry';
import { assignAirflow, equipmentForTons, simplifiedLoadModel, sizeEquipment, type LoadLine } from './load';
import { deriveWalls } from './walls';
import { analyzeBuilding, evaluate, generateProjectLayout, rebalanceAirflow, splitRegister, usableRooms } from './index';

const withLayout = (p: Project): Project => ({ ...p, layout: generateProjectLayout(p) });
const codes = (p: Project) => evaluate(p).warnings.map((w) => w.code);
const box = (id: string, x0: number, y0: number, x1: number, y1: number, extra: Partial<Room> = {}): Room => ({
  id,
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
  const result = evaluate(project);
  const layout = project.layout!;

  it('room areas match the labeled areas within 5%', () => {
    project.rooms.forEach((room, i) => {
      const labeled = sampleLabeledArea(plan.rooms[i]);
      expect(Math.abs(polygonArea(room.polygon) - labeled) / labeled).toBeLessThan(0.05);
    });
  });

  it('gives every room at least one supply register', () => {
    for (const room of usableRooms(project.rooms)) {
      expect(layout.registers.some((r) => r.kind === 'supply' && r.roomId === room.id)).toBe(true);
    }
  });

  it('matches total supply and return airflow to the air handler', () => {
    const sum = (k: string) => layout.registers.filter((r) => r.kind === k).reduce((s, r) => s + r.targetCfm, 0);
    expect(sum('supply')).toBe(layout.airHandler.airflowCfm);
    expect(sum('return')).toBe(layout.airHandler.airflowCfm);
  });

  it('gives every supply register at least the minimum airflow', () => {
    for (const r of layout.registers.filter((x) => x.kind === 'supply')) expect(r.targetCfm).toBeGreaterThanOrEqual(defaultConfig.minCfmPerSupplyRegister);
  });

  it('adds a return for each bedroom plus a central return', () => {
    const bedrooms = project.rooms.filter((r) => r.isBedroom);
    expect(bedrooms.length).toBeGreaterThanOrEqual(3);
    for (const b of bedrooms) expect(layout.registers.some((r) => r.kind === 'return' && r.roomId === b.id)).toBe(true);
    expect(layout.registers.some((r) => r.id === 'r-central')).toBe(true);
  });

  it('produces a layout with no warnings', () => {
    expect(result.warnings).toEqual([]);
  });

  it('forms a duct tree with every register connected', () => {
    for (const r of layout.registers) expect(result.ducts.some((d) => d.registerId === r.id)).toBe(true);
    const trunks = result.ducts.filter((d) => d.type === 'trunk' && d.side === 'supply');
    expect(trunks.length).toBeGreaterThan(0);
    for (const d of result.ducts) expect(d.diameter).toBe(sizeDuct(d.cfm));
  });

  it('re-evaluates fast enough for live dragging (< 200 ms)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) evaluate(project);
    expect((performance.now() - t0) / 10).toBeLessThan(200);
  });

  it('survives a JSON save/load round trip exactly', () => {
    const reloaded = JSON.parse(JSON.stringify(project)) as Project;
    expect(reloaded).toEqual(project);
    expect(evaluate(reloaded)).toEqual(result);
  });
});

describe('validation rules', () => {
  const base = withLayout(buildSampleProject(SAMPLE_PLANS[0]));
  const L = base.layout!;
  const editRegisters = (fn: (regs: typeof L.registers) => typeof L.registers): Project => ({ ...base, layout: { ...L, registers: fn(L.registers.map((r) => ({ ...r }))) } });
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
    const p: Project = { ...base, layout: { ...L, trunk: { axis: 'x', offset: far + 30 } } };
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
    const p: Project = { ...base, layout: { ...L, airHandler: { ...L.airHandler, ...equipmentForTons(L.airHandler.tons + 1) } } };
    expect(codes(p)).toContain('AIRFLOW_MISMATCH');
    const fixed: Project = { ...p, layout: rebalanceAirflow(p) };
    expect(codes(fixed)).not.toContain('AIRFLOW_MISMATCH');
  });

  it('flags an air handler outside the building', () => {
    const p: Project = { ...base, layout: { ...L, airHandler: { ...L.airHandler, position: { x: -50, y: -50 } } } };
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
    const a = analyzeBuilding(buildSampleProject(SAMPLE_PLANS[0]));
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

const JOISTS = (joistDirection: Framing['joistDirection']): Framing => ({ ductSpace: 'joist-bays', joistDirection, spacingIn: 24, depthIn: 9.25, soffitDepthIn: 14 });

describe.each(SAMPLE_PLANS.flatMap((plan) => (['y', 'x'] as const).map((dir) => ({ plan, dir }))))('joist bays: $plan.name, joists along $dir', ({ plan, dir }) => {
  const framing = JOISTS(dir);
  const project = withLayout({ ...buildSampleProject(plan), framing });
  const result = evaluate(project);
  const layout = project.layout!;
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
    const reg = base.layout!.registers.find((r) => r.kind === 'supply')!;
    const grid = evaluate(base).grid!;
    const onJoist = { x: grid.origin + Math.round((reg.position.x - grid.origin) / grid.spacingFt) * grid.spacingFt, y: reg.position.y };
    const p: Project = { ...base, layout: { ...base.layout!, registers: base.layout!.registers.map((r) => (r.id === reg.id ? { ...r, position: onJoist } : r)) } };
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
    expect(evaluate(project).warnings.map((w) => w.message)).toEqual([]);
  });
});

describe('splitting an oversized register', () => {
  // The setup from user testing: 12" o.c. joists, 2x12, which leaves a 10.5" wide bay.
  const framing = { ...JOISTS('x'), spacingIn: 12, depthIn: 11.25 };
  const base = withLayout({ ...buildSampleProject(SAMPLE_PLANS[0]), framing });
  const reg = base.layout!.registers.find((r) => r.kind === 'supply' && evaluate(base).branchLength[r.id] > 4)!;
  const tooBig: Project = { ...base, layout: { ...base.layout!, registers: base.layout!.registers.map((r) => (r.id === reg.id ? { ...r, targetCfm: 600 } : r)) } };

  it('offers a split when a branch cannot fit its bay', () => {
    const w = evaluate(tooBig).warnings.find((x) => x.code === 'DUCT_DOES_NOT_FIT');
    expect(w?.fix).toMatchObject({ kind: 'split-register', registerId: reg.id });
    expect(w!.fix!.parts).toBeGreaterThan(1);
  });

  it('clears the warning once split, keeping the airflow', () => {
    const fix = evaluate(tooBig).warnings.find((x) => x.code === 'DUCT_DOES_NOT_FIT')!.fix!;
    const split: Project = { ...tooBig, layout: splitRegister(tooBig, fix.registerId, fix.parts) };
    const pieces = split.layout!.registers.filter((r) => r.id === reg.id || r.id.startsWith(`${reg.id}-`));
    expect(pieces).toHaveLength(fix.parts);
    expect(pieces.reduce((s, r) => s + r.targetCfm, 0)).toBe(600);
    expect(new Set(split.layout!.registers.map((r) => r.id)).size).toBe(split.layout!.registers.length);
    // Only the system total is off (we forced 600 CFM by hand): nothing overlaps or fails to fit.
    expect(evaluate(split).warnings.map((x) => x.code)).toEqual(['AIRFLOW_MISMATCH']);
  });
});
