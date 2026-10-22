// Pure engine: building in, layout plus warnings out. No UI imports.
import type { DuctSegment, Floor, Framing, Layout, Project, Pt, Room, Wall, Warning } from '../types';
import { climateForZip, defaultConfig, resolveDesign, resolveFraming, type ClimateInfo, type EngineConfig, type ResolvedDesign } from './config';
import { floorFraming, roomExposure, roomsOnFloor, sortedFloors, unitTagId } from './floors';
import { joistGrid, type JoistGrid } from './framing';
import { centroid, dist, distToPolygonEdge, pointInPolygon, polygonArea } from './geometry';
import { assignAirflow, distribute, simplifiedLoadModel, sizeEquipment, type LoadModel, type RoomLoad } from './load';
import { generateLayout, scoreLayout, type LayoutScore } from './layout';
import { routeDucts } from './route';
import { roomAirflow, validate, type RoomAirflow } from './validate';
import { deriveWalls } from './walls';

export { climateForZip, defaultConfig, designDefaults, resolveDesign, resolveFraming, type DesignKey, type EngineConfig, type ResolvedDesign } from './config';
export { sizeDuct, branchEfficiency, fitDuct, rectEquivalentDiameter } from './ductSizing';
export { acrossJoists, joistGrid, joistPositions, snapToBay, type JoistGrid } from './framing';
export { equipmentForTons, sizeEquipment, simplifiedLoadModel, type LoadLine, type LoadModel, type RoomLoad } from './load';
export { deriveWalls, wallId } from './walls';
export { floorElevations, floorFraming, floorHeight, migrateProject, newFloor, roomExposure, roomsOnFloor, sortedFloors, unitTagId, type Exposure } from './floors';
export { beamLabel } from './validate';
export type { LayoutScore } from './layout';
export type { RoomAirflow } from './validate';

export interface EngineOptions {
  config?: EngineConfig;
  loadModel?: LoadModel;
}

type Totals = { areaSqFt: number; sensibleCoolingBtuh: number; latentCoolingBtuh: number; coolingBtuh: number; heatingBtuh: number };
type Equipment = { tons: number; capacityBtuh: number; airflowCfm: number };

/** Whole-building results: loads depend on what is stacked above and below each room. */
export interface BuildingAnalysis {
  climate: ClimateInfo;
  design: ResolvedDesign;
  framing: Framing;
  floors: Floor[];
  rooms: Room[];
  walls: Wall[];
  loads: RoomLoad[];
  totals: Totals;
  /** Per floor: its totals and the equipment its whole load would need. */
  byFloor: Record<string, { totals: Totals; recommended: Equipment }>;
  /** Per system (keyed by system id): the load of its zone and the unit size it needs. */
  bySystem: Record<string, { totals: Totals; recommended: Equipment }>;
  loadModelName: string;
}

/** One system on a floor, evaluated. */
export interface SystemResult {
  id: string;
  name: string;
  /** Rooms in this system's zone. */
  roomIds: string[];
  totals: Totals;
  recommended: Equipment;
  score: LayoutScore;
  stale: boolean;
}

/** One floor, evaluated: the shape the UI works with. Building-wide numbers are in `building`. */
export interface EngineResult {
  floorId: string;
  building: BuildingAnalysis;
  climate: ClimateInfo;
  design: ResolvedDesign;
  framing: Framing;
  rooms: Room[];
  walls: Wall[];
  loads: RoomLoad[];
  totals: Totals;
  recommended: Equipment;
  loadModelName: string;
  /** The floor's systems (units and the zones they serve). */
  systems: SystemResult[];
  /** All systems' ducts; ids are prefixed with the system id ("u1/branch-…"). */
  ducts: DuctSegment[];
  branchLength: Record<string, number>;
  airflow: Record<string, RoomAirflow>;
  warnings: Warning[];
  /** Totals across the floor's systems. */
  score: LayoutScore | null;
  layoutStale: boolean;
  grid: JoistGrid | null;
}

/** Rooms that can take part in the calculation (closed polygons with real area). */
export const usableRooms = (rooms: Room[]) => rooms.filter((r) => r.polygon.length >= 3 && polygonArea(r.polygon) > 1);

/** The ground floor, or the lowest floor there is. */
export const defaultFloorId = (project: Project) => sortedFloors(project.floors)[0]?.id ?? '';

/** The rooms a system serves, out of a floor's rooms. */
export const systemRooms = <R extends { id: string }>(sys: Pick<Layout, 'roomIds'>, floorRooms: R[]): R[] =>
  sys.roomIds ? floorRooms.filter((r) => sys.roomIds!.includes(r.id)) : floorRooms;

/** The system on a floor that contains a component (unit, register or duct id). */
export function systemOf(systems: Layout[], componentId: string): Layout | undefined {
  return systems.find((s) => componentId === s.airHandler.id || componentId.startsWith(`${s.id}/`) || s.registers.some((r) => r.id === componentId));
}

/** Stable signature of everything about the rooms and framing that affects a system's layout. */
export function roomsSignature(rooms: Room[], framing?: Framing, objects?: ReturnType<typeof floorObjects>): string {
  const s = JSON.stringify([
    rooms.map((r) => [r.id, r.polygon.map((p) => [p.x.toFixed(2), p.y.toFixed(2)]), r.ceilingHeight, r.floorType, r.isBedroom, r.exteriorOverrides, r.windows.map((w) => [w.wallId, w.count, w.width, w.height])]),
    framing ?? null,
    // Beams and equipment areas change where the unit should go, so they make a layout stale too.
    objects && (objects.beams.length || objects.equipmentAreas.length) ? objects : null,
  ]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const sumTotals = (loads: RoomLoad[]): Totals => {
  const t = (k: keyof Totals) => loads.reduce((s, l) => s + l[k], 0);
  return { areaSqFt: t('areaSqFt'), sensibleCoolingBtuh: t('sensibleCoolingBtuh'), latentCoolingBtuh: t('latentCoolingBtuh'), coolingBtuh: t('coolingBtuh'), heatingBtuh: t('heatingBtuh') };
};

export function analyzeBuilding(project: Project, opts: EngineOptions = {}): BuildingAnalysis {
  const config = opts.config ?? defaultConfig;
  const model = opts.loadModel ?? simplifiedLoadModel;
  const rooms = usableRooms(project.rooms);
  const climate = climateForZip(project.zipCode, config);
  const design = resolveDesign(climate, project.design, config);
  const framing = resolveFraming(project.framing, config);
  const walls = deriveWalls(rooms);
  const exposure = roomExposure(rooms, project.floors);
  const raw = model.estimate({ rooms, walls, climate, design, config, exposure });

  // Each system's unit shares its blower airflow across the rooms of its zone.
  const byFloor: BuildingAnalysis['byFloor'] = {};
  const bySystem: BuildingAnalysis['bySystem'] = {};
  const loads: RoomLoad[] = [];
  for (const floor of project.floors) {
    const mine = raw.filter((l) => rooms.find((r) => r.id === l.roomId)?.floorId === floor.id);
    const totals = sumTotals(mine);
    byFloor[floor.id] = { totals, recommended: sizeEquipment(totals.coolingBtuh, config) };
    const served = new Set<string>();
    for (const sys of project.layouts[floor.id] ?? []) {
      const zone = sys.roomIds ? mine.filter((l) => sys.roomIds!.includes(l.roomId)) : mine;
      const zt = sumTotals(zone);
      bySystem[sys.id + '@' + floor.id] = { totals: zt, recommended: sizeEquipment(zt.coolingBtuh, config) };
      loads.push(...assignAirflow(zone, sys.airHandler.airflowCfm, config.minCfmPerSupplyRegister));
      for (const l of zone) served.add(l.roomId);
    }
    // Rooms no unit serves yet: size as if one unit served them all.
    const rest = mine.filter((l) => !served.has(l.roomId));
    if (rest.length) loads.push(...assignAirflow(rest, sizeEquipment(sumTotals(rest).coolingBtuh, config).airflowCfm, config.minCfmPerSupplyRegister));
  }
  return { climate, design, framing, floors: project.floors, rooms, walls, loads, totals: sumTotals(loads), byFloor, bySystem, loadModelName: model.name };
}

/** A floor's beams and equipment areas. */
export function floorObjects(project: Project, floorId: string) {
  return {
    beams: (project.beams ?? []).filter((b) => b.floorId === floorId),
    equipmentAreas: (project.equipmentAreas ?? []).filter((a) => a.floorId === floorId),
  };
}

/** One floor's slice of the building analysis. */
function floorSlice(a: BuildingAnalysis, floorId: string) {
  const rooms = a.rooms.filter((r) => r.floorId === floorId);
  const ids = new Set(rooms.map((r) => r.id));
  const f = a.byFloor[floorId] ?? { totals: sumTotals([]), recommended: sizeEquipment(0) };
  return { rooms, walls: a.walls.filter((w) => ids.has(w.roomId)), loads: a.loads.filter((l) => ids.has(l.roomId)), totals: f.totals, recommended: f.recommended };
}

/** One system's slice of a floor: the rooms, walls and loads of its zone. */
function zoneSlice(f: ReturnType<typeof floorSlice>, sys: Pick<Layout, 'roomIds'>) {
  const rooms = systemRooms(sys, f.rooms);
  const ids = new Set(rooms.map((r) => r.id));
  return { rooms, walls: f.walls.filter((w) => ids.has(w.roomId)), loads: f.loads.filter((l) => ids.has(l.roomId)) };
}

/** Signature of a system's zone as stored in the project (used to spot stale layouts). */
function zoneSignature(project: Project, floorId: string, sys: Pick<Layout, 'roomIds'>, config: EngineConfig) {
  return roomsSignature(systemRooms(sys, roomsOnFloor(project.rooms, floorId)), floorFraming(project, floorId, config), floorObjects(project, floorId));
}

/**
 * Evaluates one floor: loads, every system's routed ducts and live warnings. Cheap enough to run
 * on every drag. Defaults to the ground floor.
 */
export function evaluate(project: Project, opts: EngineOptions & { floorId?: string; building?: BuildingAnalysis } = {}): EngineResult {
  const config = opts.config ?? defaultConfig;
  const floorId = opts.floorId ?? defaultFloorId(project);
  const a = opts.building ?? analyzeBuilding(project, opts);
  const f = floorSlice(a, floorId);
  const framing = floorFraming(project, floorId, config);
  const base = { floorId, building: a, climate: a.climate, design: a.design, framing, loadModelName: a.loadModelName, ...f };
  const systems = project.layouts[floorId] ?? [];
  if (!systems.length || f.rooms.length === 0) {
    return { ...base, systems: [], ducts: [], branchLength: {}, airflow: {}, warnings: [], score: null, layoutStale: false, grid: null };
  }
  const { beams, equipmentAreas } = floorObjects(project, floorId);
  const out = { ducts: [] as DuctSegment[], branchLength: {} as Record<string, number>, airflow: {} as Record<string, RoomAirflow>, warnings: [] as Warning[] };
  const score: LayoutScore = { total: 0, ductLength: 0, fittings: 0, imbalance: 0 };
  const sysResults: SystemResult[] = [];
  let grid: JoistGrid | null = null;
  for (const sys of systems) {
    const z = zoneSlice(f, sys);
    const route = routeDucts(z.rooms, sys, config, framing, beams, sys.id, f.rooms);
    const warnings = validate({ rooms: z.rooms, walls: z.walls, loads: z.loads, layout: sys, route, config, beams, equipmentAreas });
    const s = scoreLayout(z.rooms, z.loads, sys, route, warnings, config);
    out.ducts.push(...route.ducts);
    Object.assign(out.branchLength, route.branchLength);
    Object.assign(out.airflow, roomAirflow(z.rooms, z.loads, sys, route));
    // Name the unit in its warnings when a floor has several.
    out.warnings.push(...(systems.length > 1 ? warnings.map((w) => ({ ...w, id: `${sys.id}/${w.id}`, message: `${sys.name}: ${w.message}` })) : warnings));
    score.total += s.total;
    score.ductLength += s.ductLength;
    score.fittings += s.fittings;
    score.imbalance += s.imbalance;
    grid = route.grid ?? grid;
    const zt = a.bySystem[sys.id + '@' + floorId] ?? { totals: sumTotals(z.loads), recommended: sizeEquipment(sumTotals(z.loads).coolingBtuh, config) };
    sysResults.push({ id: sys.id, name: sys.name, roomIds: z.rooms.map((r) => r.id), ...zt, score: s, stale: sys.roomsSignature !== zoneSignature(project, floorId, sys, config) });
  }
  // Floor-wide checks: every room needs a unit, and units must not sit on top of each other.
  const served = new Set(sysResults.flatMap((s) => s.roomIds));
  for (const r of f.rooms) {
    if (!served.has(r.id)) out.warnings.push({ id: `not-served-${r.id}`, code: 'ROOM_NOT_SERVED', severity: 'error', message: `${r.name} isn't served by any unit. Assign it to one, or regenerate the zones.`, componentIds: [r.id] });
  }
  for (let i = 0; i < systems.length; i++) {
    for (let j = i + 1; j < systems.length; j++) {
      if (dist(systems[i].airHandler.position, systems[j].airHandler.position) < 3) {
        out.warnings.push({ id: `units-overlap-${i}-${j}`, code: 'COMPONENT_OVERLAP', severity: 'warning', message: `${systems[i].name} and ${systems[j].name} overlap.`, componentIds: [systems[i].airHandler.id, systems[j].airHandler.id] });
      }
    }
  }
  return { ...base, systems: sysResults, ...out, score, layoutStale: sysResults.some((s) => s.stale), grid };
}

/** Every floor, evaluated, sharing one building analysis. */
export function evaluateAll(project: Project, opts: EngineOptions = {}): Record<string, EngineResult> {
  const building = analyzeBuilding(project, opts);
  return Object.fromEntries(project.floors.map((f) => [f.id, evaluate(project, { ...opts, floorId: f.id, building })]));
}

/** How many units a floor gets automatically: enough that none is larger than the biggest allowed. */
export function autoUnitCount(coolingBtuh: number, config: EngineConfig = defaultConfig): number {
  return Math.max(1, Math.ceil(coolingBtuh / config.btuhPerTon / config.maxUnitTons));
}

/**
 * Splits rooms into `n` compact zones of roughly equal cooling load: cut the group across its
 * longer side where the running load reaches the right share, and repeat on each half.
 */
export function partitionZones(rooms: Room[], loads: RoomLoad[], n: number): Room[][] {
  const load = (r: Room) => loads.find((l) => l.roomId === r.id)?.coolingBtuh ?? 0;
  const split = (rs: Room[], k: number): Room[][] => {
    if (k <= 1 || rs.length <= 1) return [rs];
    const kA = Math.floor(k / 2);
    const cs = rs.map((r) => ({ r, c: centroid(r.polygon) }));
    const xs = cs.map((q) => q.c.x);
    const ys = cs.map((q) => q.c.y);
    const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    cs.sort((p, q) => (alongX ? p.c.x - q.c.x : p.c.y - q.c.y));
    const total = cs.reduce((s, q) => s + load(q.r), 0);
    const target = (total * kA) / k;
    let run = 0;
    let cut = 1;
    let best = Infinity;
    for (let i = 1; i < cs.length; i++) {
      run += load(cs[i - 1].r);
      if (Math.abs(run - target) < best) {
        best = Math.abs(run - target);
        cut = i;
      }
    }
    // Every zone needs at least one room.
    cut = Math.min(Math.max(cut, kA), cs.length - (k - kA));
    const sorted = cs.map((q) => q.r);
    return [...split(sorted.slice(0, cut), kA), ...split(sorted.slice(cut), k - kA)];
  };
  return split(rooms, Math.min(n, rooms.length)).filter((z) => z.length);
}

export interface GenerateFloorOptions extends EngineOptions {
  floorId?: string;
  /** Re-split the floor into zones instead of keeping the current ones. */
  rezone?: boolean;
  /** Keep each unit where it is, with its size (used when re-routing from the current spots). */
  keepUnits?: boolean;
}

/**
 * Generates a floor's systems: decide the zones (keeping existing ones unless asked to re-zone),
 * then for each zone size its unit, place it (inside an equipment area if there are any, clear of
 * the other units) and lay out its registers and ducts.
 */
export function generateFloorSystems(project: Project, opts: GenerateFloorOptions = {}): Layout[] {
  const config = opts.config ?? defaultConfig;
  const floorId = opts.floorId ?? defaultFloorId(project);
  const floor = project.floors.find((x) => x.id === floorId);
  const a = analyzeBuilding(project, opts);
  const f = floorSlice(a, floorId);
  if (!floor || f.rooms.length === 0) return [];
  const existing = project.layouts[floorId] ?? [];
  const n = floor.unitCount ?? autoUnitCount(f.totals.coolingBtuh, config);

  // Keep the current zones when they still cover every room and match the unit count.
  const ids = new Set(f.rooms.map((r) => r.id));
  const keep =
    !opts.rezone &&
    existing.length === n &&
    (n === 1 ? existing[0].roomIds === null || existing[0].roomIds.length > 0 : existing.every((s) => s.roomIds?.length)) &&
    f.rooms.every((r) => existing.some((s) => !s.roomIds || s.roomIds.includes(r.id)));
  const zones: (string[] | null)[] = keep
    ? existing.map((s) => (s.roomIds ? s.roomIds.filter((id) => ids.has(id)) : null))
    : n === 1
      ? [null]
      : partitionZones(f.rooms, f.loads, n).map((z) => z.map((r) => r.id));

  const framing = floorFraming(project, floorId, config);
  const objects = floorObjects(project, floorId);
  const taken: Pt[] = [];
  return zones.map((roomIds, i) => {
    const prev = keep ? existing[i] : undefined;
    const id = prev?.id ?? `u${i + 1}`;
    const z = zoneSlice(f, { roomIds });
    const recommended = sizeEquipment(sumTotals(z.loads).coolingBtuh, config);
    const unit = opts.keepUnits && prev ? prev.airHandler : null;
    const { layout } = generateLayout({
      rooms: z.rooms,
      walls: z.walls,
      loads: z.loads,
      tons: unit?.tons ?? recommended.tons,
      config,
      airHandlerPosition: unit?.position,
      framing,
      roomsSignature: zoneSignature(project, floorId, { roomIds }, config),
      ...objects,
      avoidSpots: taken,
      floorRooms: f.rooms,
    });
    taken.push(layout.airHandler.position);
    const multi = zones.length > 1;
    return {
      ...layout,
      id,
      name: prev?.name ?? `AHU-${i + 1}`,
      roomIds,
      // A custom unit keeps its entered capacity and airflow.
      airHandler: { ...layout.airHandler, ...(unit ? { capacityBtuh: unit.capacityBtuh, airflowCfm: unit.airflowCfm } : {}), id: unitTagId(id) },
      registers: multi ? layout.registers.map((r) => (r.id.startsWith('r-central') ? { ...r, id: r.id.replace('r-central', `r-central-${id}`) } : r)) : layout.registers,
    };
  });
}

/** Generates the systems for one floor (default: the ground floor). Kept for callers that think in floors. */
export function generateProjectLayout(project: Project, opts: GenerateFloorOptions = {}): Layout[] | null {
  const systems = generateFloorSystems(project, opts);
  return systems.length ? systems : null;
}

/** Generates systems for every floor that has rooms. */
export function generateAllLayouts(project: Project, opts: EngineOptions = {}): Record<string, Layout[]> {
  const out: Record<string, Layout[]> = {};
  for (const f of project.floors) {
    const systems = generateFloorSystems(project, { ...opts, floorId: f.id });
    if (systems.length) out[f.id] = systems;
  }
  return out;
}

/**
 * Replaces one register with `parts` registers sharing its airflow, in neighbouring joist bays
 * (or 2 ft apart outside joist bays), staying inside its room. Returns the updated system.
 */
export function splitRegister(project: Project, registerId: string, parts: number, opts: EngineOptions & { floorId?: string } = {}): Layout | null {
  const floorId = opts.floorId ?? defaultFloorId(project);
  const layout = systemOf(project.layouts[floorId] ?? [], registerId) ?? null;
  const reg = layout?.registers.find((r) => r.id === registerId);
  if (!layout || !reg || parts < 2) return layout;
  const a = analyzeBuilding(project, opts);
  const room = a.rooms.find((r) => r.id === reg.roomId);
  const framing = floorFraming(project, floorId, opts.config ?? defaultConfig);
  const grid = joistGrid(floorSlice(a, floorId).rooms, framing, opts.config ?? defaultConfig);
  const step = grid ? grid.spacingFt : 2;
  const acrossIsX = grid ? framing.joistDirection === 'y' : layout.trunk.axis === 'x';
  const gap = (opts.config ?? defaultConfig).validation.registerSpacingFt;
  const taken = layout.registers.filter((r) => r.id !== registerId).map((r) => r.position);
  const spots: Pt[] = [reg.position];
  for (let k = 1; spots.length < parts && k <= 24; k++) {
    for (const sign of [1, -1]) {
      if (spots.length >= parts) break;
      const p = acrossIsX ? { x: reg.position.x + sign * k * step, y: reg.position.y } : { x: reg.position.x, y: reg.position.y + sign * k * step };
      if (room && (!pointInPolygon(p, room.polygon) || distToPolygonEdge(p, room.polygon) < 0.75)) continue;
      // Keep pieces as far apart as any two registers must be (skips a bay when joists are close).
      if ([...taken, ...spots].some((q) => Math.hypot(q.x - p.x, q.y - p.y) < gap)) continue;
      spots.push(p);
    }
  }
  const shares = distribute(reg.targetCfm, spots.map(() => 1));
  const used = new Set(layout.registers.map((r) => r.id));
  const freshId = () => {
    let n = 2;
    while (used.has(`${reg.id}-${n}`)) n++;
    used.add(`${reg.id}-${n}`);
    return `${reg.id}-${n}`;
  };
  const pieces = spots.map((position, i) => ({ ...reg, id: i === 0 ? reg.id : freshId(), position, targetCfm: shares[i] }));
  return { ...layout, registers: layout.registers.flatMap((r) => (r.id === registerId ? pieces : [r])) };
}

/**
 * Re-splits a system's unit airflow across its existing registers by room load, keeping
 * positions. Defaults to the ground floor's first system.
 */
export function rebalanceAirflow(project: Project, opts: EngineOptions & { floorId?: string; systemId?: string } = {}): Layout | null {
  const systems = project.layouts[opts.floorId ?? defaultFloorId(project)] ?? [];
  const layout = systems.find((s) => s.id === opts.systemId) ?? systems[0];
  if (!layout) return null;
  const a = analyzeBuilding(project, opts);
  const total = layout.airHandler.airflowCfm;
  const config = opts.config ?? defaultConfig;
  const registers = layout.registers.map((r) => ({ ...r }));
  const supply = registers.filter((r) => r.kind === 'supply');
  const served = a.loads.filter((l) => supply.some((r) => r.roomId === l.roomId));
  const roomCfm = distribute(total, served.map((l) => l.sensibleCoolingBtuh), config.minCfmPerSupplyRegister);
  served.forEach((load, i) => {
    const mine = supply.filter((r) => r.roomId === load.roomId);
    for (const r of mine) r.targetCfm = Math.round(roomCfm[i] / mine.length);
  });
  const fix = (regs: typeof registers) => {
    if (!regs.length) return;
    const diff = total - regs.reduce((s, r) => s + r.targetCfm, 0);
    regs.reduce((m, r) => (r.targetCfm > m.targetCfm ? r : m)).targetCfm += diff;
  };
  fix(supply);
  // Room returns carry their room's supply (split across that room's grilles); central grilles share the rest.
  const returns = registers.filter((r) => r.kind === 'return');
  const isCentral = (r: (typeof returns)[0]) => r.id === 'r-central' || r.id.startsWith('r-central-');
  const central = returns.filter(isCentral);
  for (const roomId of new Set(returns.filter((r) => !isCentral(r)).map((r) => r.roomId))) {
    const mine = returns.filter((r) => !isCentral(r) && r.roomId === roomId);
    const cfm = supply.filter((s) => s.roomId === roomId).reduce((s, x) => s + x.targetCfm, 0);
    distribute(cfm, mine.map(() => 1)).forEach((v, i) => (mine[i].targetCfm = v));
  }
  if (central.length) {
    const rest = Math.max(0, total - returns.filter((r) => !isCentral(r)).reduce((s, r) => s + r.targetCfm, 0));
    distribute(rest, central.map(() => 1)).forEach((v, i) => (central[i].targetCfm = v));
  } else fix(returns);
  return { ...layout, registers };
}
