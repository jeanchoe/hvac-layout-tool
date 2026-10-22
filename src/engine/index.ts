// Pure engine: building in, layout plus warnings out. No UI imports.
import type { DuctSegment, Framing, Layout, Project, Pt, Room, Wall, Warning } from '../types';
import { climateForZip, defaultConfig, resolveDesign, resolveFraming, type ClimateInfo, type EngineConfig, type ResolvedDesign } from './config';
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
export type { LayoutScore } from './layout';
export type { RoomAirflow } from './validate';

export interface EngineOptions {
  config?: EngineConfig;
  loadModel?: LoadModel;
}

export interface BuildingAnalysis {
  climate: ClimateInfo;
  design: ResolvedDesign;
  framing: Framing;
  rooms: Room[];
  walls: Wall[];
  loads: RoomLoad[];
  totals: { areaSqFt: number; sensibleCoolingBtuh: number; latentCoolingBtuh: number; coolingBtuh: number; heatingBtuh: number };
  recommended: { tons: number; capacityBtuh: number; airflowCfm: number };
  loadModelName: string;
}

export interface EngineResult extends BuildingAnalysis {
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

/** Stable signature of everything about the rooms and framing that affects the layout. */
export function roomsSignature(rooms: Room[], framing?: Framing): string {
  const s = JSON.stringify([
    rooms.map((r) => [r.id, r.polygon.map((p) => [p.x.toFixed(2), p.y.toFixed(2)]), r.ceilingHeight, r.floorType, r.isBedroom, r.exteriorOverrides, r.windows.map((w) => [w.wallId, w.count, w.width, w.height])]),
    framing ?? null,
  ]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function analyzeBuilding(project: Project, opts: EngineOptions = {}): BuildingAnalysis {
  const config = opts.config ?? defaultConfig;
  const model = opts.loadModel ?? simplifiedLoadModel;
  const rooms = usableRooms(project.rooms);
  const climate = climateForZip(project.zipCode, config);
  const design = resolveDesign(climate, project.design, config);
  const framing = resolveFraming(project.framing, config);
  const walls = deriveWalls(rooms);
  const raw = model.estimate({ rooms, walls, climate, design, config });
  const total = (k: 'areaSqFt' | 'sensibleCoolingBtuh' | 'latentCoolingBtuh' | 'coolingBtuh' | 'heatingBtuh') => raw.reduce((s, l) => s + l[k], 0);
  const totals = {
    areaSqFt: total('areaSqFt'),
    sensibleCoolingBtuh: total('sensibleCoolingBtuh'),
    latentCoolingBtuh: total('latentCoolingBtuh'),
    coolingBtuh: total('coolingBtuh'),
    heatingBtuh: total('heatingBtuh'),
  };
  const recommended = sizeEquipment(totals.coolingBtuh, config);
  // Room airflow is a share of the blower: the layout's air handler if there is one, else the recommended size.
  const blower = project.layout?.airHandler.airflowCfm ?? recommended.airflowCfm;
  const loads = assignAirflow(raw, blower, config.minCfmPerSupplyRegister);
  return { climate, design, framing, rooms, walls, loads, totals, recommended, loadModelName: model.name };
}

/** Full evaluation of a project: loads, routed ducts and live warnings. Cheap enough to run on every drag. */
export function evaluate(project: Project, opts: EngineOptions = {}): EngineResult {
  const config = opts.config ?? defaultConfig;
  const a = analyzeBuilding(project, opts);
  const layout = project.layout;
  if (!layout || a.rooms.length === 0) {
    return { ...a, ducts: [], branchLength: {}, airflow: {}, warnings: [], score: null, layoutStale: false, grid: null };
  }
  const route = routeDucts(a.rooms, layout, config, a.framing);
  const warnings = validate({ rooms: a.rooms, walls: a.walls, loads: a.loads, layout, route, config });
  return {
    ...a,
    ducts: route.ducts,
    branchLength: route.branchLength,
    airflow: roomAirflow(a.rooms, a.loads, layout, route),
    warnings,
    score: scoreLayout(a.rooms, a.loads, layout, route, warnings, config),
    layoutStale: layout.roomsSignature !== roomsSignature(project.rooms, project.framing),
    grid: route.grid,
  };
}

/** Generates a fresh starting layout for the project. */
export function generateProjectLayout(project: Project, opts: EngineOptions & { airHandlerPosition?: Pt; tons?: number } = {}): Layout | null {
  const config = opts.config ?? defaultConfig;
  const a = analyzeBuilding(project, opts);
  if (a.rooms.length === 0) return null;
  return generateLayout({
    rooms: a.rooms,
    walls: a.walls,
    loads: a.loads,
    tons: opts.tons ?? a.recommended.tons,
    config,
    airHandlerPosition: opts.airHandlerPosition,
    framing: a.framing,
    roomsSignature: roomsSignature(project.rooms, project.framing),
  }).layout;
}

/**
 * Replaces one register with `parts` registers sharing its airflow, in neighbouring joist bays
 * (or 2 ft apart outside joist bays), staying inside its room.
 */
export function splitRegister(project: Project, registerId: string, parts: number, opts: EngineOptions = {}): Layout | null {
  const layout = project.layout;
  const reg = layout?.registers.find((r) => r.id === registerId);
  if (!layout || !reg || parts < 2) return layout;
  const a = analyzeBuilding(project, opts);
  const room = a.rooms.find((r) => r.id === reg.roomId);
  const grid = joistGrid(a.rooms, a.framing, opts.config ?? defaultConfig);
  const step = grid ? grid.spacingFt : 2;
  const acrossIsX = grid ? a.framing.joistDirection === 'y' : layout.trunk.axis === 'x';
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
export function rebalanceAirflow(project: Project, opts: EngineOptions = {}): Layout | null {
  const layout = project.layout;
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
