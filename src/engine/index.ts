// Pure engine: building in, layout plus warnings out. No UI imports.
import type { DuctSegment, Floor, Framing, Layout, Project, Pt, Room, Wall, Warning } from '../types';
import { climateForZip, defaultConfig, resolveDesign, resolveFraming, type ClimateInfo, type EngineConfig, type ResolvedDesign } from './config';
import { floorFraming, roomExposure, roomsOnFloor, sortedFloors } from './floors';
import { joistGrid, type JoistGrid } from './framing';
import { distToPolygonEdge, pointInPolygon, polygonArea } from './geometry';
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
export { floorElevations, floorFraming, floorHeight, migrateProject, newFloor, roomExposure, roomsOnFloor, sortedFloors, type Exposure } from './floors';
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
  /** Per floor: its totals and the system size it needs (one system per floor). */
  byFloor: Record<string, { totals: Totals; recommended: Equipment }>;
  loadModelName: string;
}

/** One floor's system, evaluated: the shape the UI works with. Building-wide numbers are in `building`. */
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
  ducts: DuctSegment[];
  branchLength: Record<string, number>;
  airflow: Record<string, RoomAirflow>;
  warnings: Warning[];
  score: LayoutScore | null;
  layoutStale: boolean;
  grid: JoistGrid | null;
}

/** Rooms that can take part in the calculation (closed polygons with real area). */
export const usableRooms = (rooms: Room[]) => rooms.filter((r) => r.polygon.length >= 3 && polygonArea(r.polygon) > 1);

/** The ground floor, or the lowest floor there is. */
export const defaultFloorId = (project: Project) => sortedFloors(project.floors)[0]?.id ?? '';

/** Stable signature of everything about the rooms and framing that affects a floor's layout. */
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

  // Each floor has its own system: size it, then share its blower airflow across that floor's rooms.
  const byFloor: BuildingAnalysis['byFloor'] = {};
  const loads: RoomLoad[] = [];
  for (const floor of project.floors) {
    const mine = raw.filter((l) => rooms.find((r) => r.id === l.roomId)?.floorId === floor.id);
    const totals = sumTotals(mine);
    const recommended = sizeEquipment(totals.coolingBtuh, config);
    const blower = project.layouts[floor.id]?.airHandler.airflowCfm ?? recommended.airflowCfm;
    loads.push(...assignAirflow(mine, blower, config.minCfmPerSupplyRegister));
    byFloor[floor.id] = { totals, recommended };
  }
  return { climate, design, framing, floors: project.floors, rooms, walls, loads, totals: sumTotals(loads), byFloor, loadModelName: model.name };
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

/**
 * Evaluates one floor's system: loads, routed ducts and live warnings. Cheap enough to run on
 * every drag. Defaults to the ground floor.
 */
export function evaluate(project: Project, opts: EngineOptions & { floorId?: string; building?: BuildingAnalysis } = {}): EngineResult {
  const config = opts.config ?? defaultConfig;
  const floorId = opts.floorId ?? defaultFloorId(project);
  const a = opts.building ?? analyzeBuilding(project, opts);
  const f = floorSlice(a, floorId);
  const framing = floorFraming(project, floorId, config);
  const base = { floorId, building: a, climate: a.climate, design: a.design, framing, loadModelName: a.loadModelName, ...f };
  const layout = project.layouts[floorId];
  if (!layout || f.rooms.length === 0) {
    return { ...base, ducts: [], branchLength: {}, airflow: {}, warnings: [], score: null, layoutStale: false, grid: null };
  }
  const { beams, equipmentAreas } = floorObjects(project, floorId);
  const route = routeDucts(f.rooms, layout, config, framing, beams);
  const warnings = validate({ rooms: f.rooms, walls: f.walls, loads: f.loads, layout, route, config, beams, equipmentAreas });
  return {
    ...base,
    ducts: route.ducts,
    branchLength: route.branchLength,
    airflow: roomAirflow(f.rooms, f.loads, layout, route),
    warnings,
    score: scoreLayout(f.rooms, f.loads, layout, route, warnings, config),
    layoutStale: layout.roomsSignature !== roomsSignature(roomsOnFloor(project.rooms, floorId), framing, floorObjects(project, floorId)),
    grid: route.grid,
  };
}

/** Every floor, evaluated, sharing one building analysis. */
export function evaluateAll(project: Project, opts: EngineOptions = {}): Record<string, EngineResult> {
  const building = analyzeBuilding(project, opts);
  return Object.fromEntries(project.floors.map((f) => [f.id, evaluate(project, { ...opts, floorId: f.id, building })]));
}

/** Generates a fresh starting layout for one floor (default: the ground floor). */
export function generateProjectLayout(project: Project, opts: EngineOptions & { floorId?: string; airHandlerPosition?: Pt; tons?: number } = {}): Layout | null {
  const config = opts.config ?? defaultConfig;
  const floorId = opts.floorId ?? defaultFloorId(project);
  const a = analyzeBuilding(project, opts);
  const f = floorSlice(a, floorId);
  if (f.rooms.length === 0) return null;
  return generateLayout({
    rooms: f.rooms,
    walls: f.walls,
    loads: f.loads,
    tons: opts.tons ?? f.recommended.tons,
    config,
    airHandlerPosition: opts.airHandlerPosition,
    framing: floorFraming(project, floorId, config),
    roomsSignature: roomsSignature(roomsOnFloor(project.rooms, floorId), floorFraming(project, floorId, config), floorObjects(project, floorId)),
    ...floorObjects(project, floorId),
  }).layout;
}

/** Generates a layout for every floor that has rooms. */
export function generateAllLayouts(project: Project, opts: EngineOptions = {}): Record<string, Layout> {
  const out: Record<string, Layout> = {};
  for (const f of project.floors) {
    const layout = generateProjectLayout(project, { ...opts, floorId: f.id });
    if (layout) out[f.id] = layout;
  }
  return out;
}

/**
 * Replaces one register with `parts` registers sharing its airflow, in neighbouring joist bays
 * (or 2 ft apart outside joist bays), staying inside its room.
 */
export function splitRegister(project: Project, registerId: string, parts: number, opts: EngineOptions & { floorId?: string } = {}): Layout | null {
  const floorId = opts.floorId ?? defaultFloorId(project);
  const layout = project.layouts[floorId] ?? null;
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

/** Re-splits the air handler's airflow across the existing registers by room load, keeping positions. */
export function rebalanceAirflow(project: Project, opts: EngineOptions & { floorId?: string } = {}): Layout | null {
  const layout = project.layouts[opts.floorId ?? defaultFloorId(project)];
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
