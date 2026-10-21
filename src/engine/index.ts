// Pure engine: building in, layout plus warnings out. No UI imports.
import type { DuctSegment, Layout, Project, Pt, Room, Wall, Warning } from '../types';
import { climateForZip, defaultConfig, type ClimateInfo, type EngineConfig } from './config';
import { polygonArea } from './geometry';
import { simplifiedLoadModel, sizeEquipment, type LoadModel, type RoomLoad } from './load';
import { generateLayout, scoreLayout, type LayoutScore } from './layout';
import { routeDucts } from './route';
import { roomAirflow, validate, type RoomAirflow } from './validate';
import { deriveWalls } from './walls';

export { climateForZip, defaultConfig, type EngineConfig } from './config';
export { sizeDuct, branchEfficiency } from './ductSizing';
export { equipmentForTons, sizeEquipment, simplifiedLoadModel, type LoadModel, type RoomLoad } from './load';
export { deriveWalls, wallId } from './walls';
export type { LayoutScore } from './layout';
export type { RoomAirflow } from './validate';

export interface EngineOptions {
  config?: EngineConfig;
  loadModel?: LoadModel;
}

export interface BuildingAnalysis {
  climate: ClimateInfo;
  rooms: Room[];
  walls: Wall[];
  loads: RoomLoad[];
  totals: { areaSqFt: number; coolingBtuh: number; heatingBtuh: number; requiredCfm: number };
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
}

/** Rooms that can take part in the calculation (closed polygons with real area). */
export const usableRooms = (rooms: Room[]) => rooms.filter((r) => r.polygon.length >= 3 && polygonArea(r.polygon) > 1);

/** Stable signature of everything about the rooms that affects the layout. */
export function roomsSignature(rooms: Room[]): string {
  const s = JSON.stringify(
    rooms.map((r) => [r.id, r.polygon.map((p) => [p.x.toFixed(2), p.y.toFixed(2)]), r.ceilingHeight, r.floorType, r.isBedroom, r.exteriorOverrides, r.windows.map((w) => [w.wallId, w.count, w.width, w.height])]),
  );
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function analyzeBuilding(project: Project, opts: EngineOptions = {}): BuildingAnalysis {
  const config = opts.config ?? defaultConfig;
  const model = opts.loadModel ?? simplifiedLoadModel;
  const rooms = usableRooms(project.rooms);
  const climate = climateForZip(project.zipCode, config);
  const walls = deriveWalls(rooms);
  const loads = model.estimate({ rooms, walls, climate, config });
  const totals = {
    areaSqFt: loads.reduce((s, l) => s + l.areaSqFt, 0),
    coolingBtuh: loads.reduce((s, l) => s + l.coolingBtuh, 0),
    heatingBtuh: loads.reduce((s, l) => s + l.heatingBtuh, 0),
    requiredCfm: loads.reduce((s, l) => s + l.requiredCfm, 0),
  };
  return { climate, rooms, walls, loads, totals, recommended: sizeEquipment(totals.coolingBtuh, config), loadModelName: model.name };
}

/** Full evaluation of a project: loads, routed ducts and live warnings. Cheap enough to run on every drag. */
export function evaluate(project: Project, opts: EngineOptions = {}): EngineResult {
  const config = opts.config ?? defaultConfig;
  const a = analyzeBuilding(project, opts);
  const layout = project.layout;
  if (!layout || a.rooms.length === 0) {
    return { ...a, ducts: [], branchLength: {}, airflow: {}, warnings: [], score: null, layoutStale: false };
  }
  const route = routeDucts(a.rooms, layout, config);
  const warnings = validate({ rooms: a.rooms, walls: a.walls, loads: a.loads, layout, route, config });
  return {
    ...a,
    ducts: route.ducts,
    branchLength: route.branchLength,
    airflow: roomAirflow(a.rooms, a.loads, layout, route),
    warnings,
    score: scoreLayout(a.rooms, a.loads, layout, route, warnings, config),
    layoutStale: layout.roomsSignature !== roomsSignature(project.rooms),
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
    roomsSignature: roomsSignature(project.rooms),
  }).layout;
}

/** Re-splits the air handler's airflow across the existing registers by room load, keeping positions. */
export function rebalanceAirflow(project: Project, opts: EngineOptions = {}): Layout | null {
  const layout = project.layout;
  if (!layout) return null;
  const a = analyzeBuilding(project, opts);
  const total = layout.airHandler.airflowCfm;
  const totalCooling = a.totals.coolingBtuh || 1;
  const registers = layout.registers.map((r) => ({ ...r }));
  const supply = registers.filter((r) => r.kind === 'supply');
  for (const load of a.loads) {
    const mine = supply.filter((r) => r.roomId === load.roomId);
    for (const r of mine) r.targetCfm = Math.round((total * load.coolingBtuh) / totalCooling / mine.length);
  }
  const fix = (regs: typeof registers) => {
    if (!regs.length) return;
    const diff = total - regs.reduce((s, r) => s + r.targetCfm, 0);
    regs.reduce((m, r) => (r.targetCfm > m.targetCfm ? r : m)).targetCfm += diff;
  };
  fix(supply);
  const returns = registers.filter((r) => r.kind === 'return');
  const central = returns.find((r) => r.id === 'r-central');
  for (const r of returns) {
    if (r !== central) r.targetCfm = supply.filter((s) => s.roomId === r.roomId).reduce((s, x) => s + x.targetCfm, 0);
  }
  if (central) central.targetCfm = Math.max(0, total - returns.filter((r) => r !== central).reduce((s, r) => s + r.targetCfm, 0));
  else fix(returns);
  return { ...layout, registers };
}
