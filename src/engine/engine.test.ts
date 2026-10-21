import { describe, expect, it } from 'vitest';
import { SAMPLE_PLANS, buildSampleProject, sampleLabeledArea } from '../samples/plans';
import type { Project, Room } from '../types';
import { climateForZip, defaultConfig, type EngineConfig } from './config';
import { branchEfficiency, sizeDuct } from './ductSizing';
import { polygonArea } from './geometry';
import { equipmentForTons, simplifiedLoadModel, sizeEquipment } from './load';
import { deriveWalls } from './walls';
import { analyzeBuilding, evaluate, generateProjectLayout, rebalanceAirflow, usableRooms } from './index';

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
  const estimate = (rooms: Room[], config: EngineConfig = defaultConfig) =>
    simplifiedLoadModel.estimate({ rooms, walls: deriveWalls(rooms), climate: zone4, config });
  const factor = defaultConfig.climateZones['4'].coolingBtuhPerSqFt;

  it('base load is floor area times the climate-zone factor', () => {
    const [load] = estimate([box('a', 0, 0, 10, 10, { exteriorOverrides: { 'a:0': false, 'a:1': false, 'a:2': false, 'a:3': false } })]);
    expect(load.coolingBtuh).toBeCloseTo(100 * factor);
    expect(load.breakdown.walls).toBe(0);
  });

  it('reads factors from config, not code', () => {
    const cfg = structuredClone(defaultConfig);
    cfg.climateZones['4'].coolingBtuhPerSqFt = factor * 2;
    const interior = { exteriorOverrides: { 'a:0': false, 'a:1': false, 'a:2': false, 'a:3': false } };
    expect(estimate([box('a', 0, 0, 10, 10, interior)], cfg)[0].coolingBtuh).toBeCloseTo(200 * factor);
  });

  it('weights window gain by direction: west > south > east > north', () => {
    const gain = (wallId: string) =>
      estimate([box('a', 0, 0, 10, 10, { windows: [{ id: 'w', wallId, count: 1, width: 3, height: 4 }] })])[0].breakdown.windows;
    const [n, e, s, w] = ['a:0', 'a:1', 'a:2', 'a:3'].map(gain);
    expect(w).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(e);
    expect(e).toBeGreaterThan(n);
    expect(w).toBeCloseTo(12 * defaultConfig.windowCoolingBtuhPerSqFt.W);
  });

  it('adds load for exterior walls and for ceilings above 8 ft', () => {
    const interior = box('a', 0, 0, 10, 10, { exteriorOverrides: { 'a:0': false, 'a:1': false, 'a:2': false, 'a:3': false } });
    const exterior = box('a', 0, 0, 10, 10);
    const tall = box('a', 0, 0, 10, 10, { ceilingHeight: 10 });
    const [li, le, lt] = [interior, exterior, tall].map((r) => estimate([r])[0].coolingBtuh);
    expect(le).toBeGreaterThan(li);
    expect(lt).toBeGreaterThan(le);
    expect(estimate([tall])[0].breakdown.ceiling).toBeCloseTo(100 * factor * 2 * defaultConfig.ceilingHeightFactorPerFtAbove8);
  });

  it('converts cooling load to airflow at 400 CFM per ton', () => {
    const [load] = estimate([box('a', 0, 0, 20, 30)]);
    expect(load.requiredCfm).toBeCloseTo((load.coolingBtuh / 12000) * 400);
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
    expect(a.recommended.tons).toBeGreaterThanOrEqual(2.5);
    expect(a.recommended.tons).toBeLessThanOrEqual(4);
  });
});
