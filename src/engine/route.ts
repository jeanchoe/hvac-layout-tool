import type { DuctSegment, Layout, Pt, Register, Room, Trunk } from '../types';
import { defaultConfig, type EngineConfig } from './config';
import { bbox, dist, pointInPolygon } from './geometry';
import { branchEfficiency, sizeDuct } from './ductSizing';

export interface RouteResult {
  ducts: DuctSegment[];
  /** Branch length per register id. */
  branchLength: Record<string, number>;
  /** Estimated share of design airflow delivered per register id. */
  efficiency: Record<string, number>;
  totalLength: number;
  fittings: number;
  roomCrossings: number;
}

/** Usable extent of the trunk along its axis: the building's bounding box, inset 1 ft. */
export function trunkExtent(rooms: Room[], trunk: Trunk) {
  const b = bbox(rooms.flatMap((r) => r.polygon));
  return trunk.axis === 'x' ? { min: b.minX + 1, max: b.maxX - 1 } : { min: b.minY + 1, max: b.maxY - 1 };
}

export const trunkPoint = (trunk: Trunk, t: number): Pt =>
  trunk.axis === 'x' ? { x: t, y: trunk.offset } : { x: trunk.offset, y: t };

const along = (trunk: Trunk, p: Pt) => (trunk.axis === 'x' ? p.x : p.y);

/** Number of rooms (other than `ownRoomId`) the straight segment a-b passes through. */
export function roomsCrossed(a: Pt, b: Pt, rooms: Room[], ownRoomId: string): number {
  const len = dist(a, b);
  const steps = Math.max(1, Math.ceil(len / 0.5));
  const crossed = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    for (const r of rooms) {
      if (r.id === ownRoomId || crossed.has(r.id)) continue;
      if (pointInPolygon(p, r.polygon)) crossed.add(r.id);
    }
  }
  return crossed.size;
}

/** Shortest takeoff along the trunk for a register, penalising branches that cut through other rooms. */
export function chooseTakeoff(reg: Register, rooms: Room[], trunk: Trunk, extent: { min: number; max: number }, config: EngineConfig) {
  const proj = along(trunk, reg.position);
  const seen = new Set<number>();
  let best = { t: proj, length: Infinity, crossings: 0, score: Infinity };
  for (let k = -4; k <= 4; k++) {
    const t = Math.round(Math.min(extent.max, Math.max(extent.min, proj + k * 2)) * 100) / 100;
    if (seen.has(t)) continue;
    seen.add(t);
    const tp = trunkPoint(trunk, t);
    const length = dist(tp, reg.position);
    const crossings = roomsCrossed(tp, reg.position, rooms, reg.roomId);
    const score = length + crossings * config.scoring.roomCrossingPenaltyFt;
    if (score < best.score - 1e-9) best = { t, length, crossings, score };
  }
  return best;
}

const seg = (id: string, start: Pt, end: Pt, type: DuctSegment['type'], side: DuctSegment['side'], cfm: number, config: EngineConfig, registerId?: string): DuctSegment => ({
  id,
  start,
  end,
  type,
  side,
  cfm: Math.round(cfm),
  diameter: sizeDuct(cfm, config),
  length: dist(start, end),
  ...(registerId ? { registerId } : {}),
});

/**
 * Builds the duct tree from the air handler, the supply trunk line and the registers.
 * Pure and fast: the UI calls it on every drag.
 */
export function routeDucts(rooms: Room[], layout: Layout, config: EngineConfig = defaultConfig): RouteResult {
  const { airHandler, trunk, registers } = layout;
  const ducts: DuctSegment[] = [];
  const branchLength: Record<string, number> = {};
  const efficiency: Record<string, number> = {};
  let fittings = 0;
  let roomCrossings = 0;
  if (rooms.length === 0) return { ducts, branchLength, efficiency, totalLength: 0, fittings, roomCrossings };

  const extent = trunkExtent(rooms, trunk);
  const a0 = along(trunk, airHandler.position);
  const ext = { min: Math.min(extent.min, a0), max: Math.max(extent.max, a0) };

  // Supply: choose a takeoff on the trunk for every supply register.
  const supply = registers.filter((r) => r.kind === 'supply');
  const takeoffs = supply.map((reg) => ({ reg, ...chooseTakeoff(reg, rooms, trunk, ext, config) }));
  const totalSupply = supply.reduce((s, r) => s + r.targetCfm, 0);

  // Plenum stub from the air handler to the trunk line, if the trunk was moved off the AHU.
  const origin = trunkPoint(trunk, a0);
  if (dist(origin, airHandler.position) > 0.05) {
    ducts.push(seg('trunk-stub', airHandler.position, origin, 'trunk', 'supply', totalSupply, config));
    fittings += 1;
  }

  // Each side of the trunk is a reducing run: segment i carries everything downstream of it.
  for (const side of ['L', 'R'] as const) {
    const mine = takeoffs
      .filter((k) => (side === 'L' ? k.t < a0 - 1e-6 : k.t >= a0 - 1e-6))
      .sort((p, q) => Math.abs(p.t - a0) - Math.abs(q.t - a0));
    if (mine.length === 0) continue;
    const stops: { t: number; cfm: number }[] = [];
    for (const k of mine) {
      const last = stops[stops.length - 1];
      if (last && Math.abs(last.t - k.t) < 0.1) last.cfm += k.reg.targetCfm;
      else stops.push({ t: k.t, cfm: k.reg.targetCfm });
    }
    let remaining = stops.reduce((s, x) => s + x.cfm, 0);
    let prev = a0;
    stops.forEach((stop, i) => {
      if (Math.abs(stop.t - prev) > 0.05) {
        ducts.push(seg(`trunk-${side}${i}`, trunkPoint(trunk, prev), trunkPoint(trunk, stop.t), 'trunk', 'supply', remaining, config));
      }
      remaining -= stop.cfm;
      prev = stop.t;
      fittings += 1; // takeoff
    });
    fittings += 1; // end cap
  }

  for (const k of takeoffs) {
    const d = seg(`branch-${k.reg.id}`, trunkPoint(trunk, k.t), k.reg.position, 'branch', 'supply', k.reg.targetCfm, config, k.reg.id);
    ducts.push(d);
    branchLength[k.reg.id] = d.length;
    efficiency[k.reg.id] = branchEfficiency(d.length, config);
    roomCrossings += k.crossings;
    fittings += 1; // boot
  }

  // Returns run straight back to the air handler; the largest one is the central return trunk.
  const returns = registers.filter((r) => r.kind === 'return');
  const central = returns.reduce<Register | null>((m, r) => (!m || r.targetCfm > m.targetCfm ? r : m), null);
  for (const reg of returns) {
    const d = seg(`return-${reg.id}`, reg.position, airHandler.position, reg === central ? 'trunk' : 'branch', 'return', reg.targetCfm, config, reg.id);
    ducts.push(d);
    branchLength[reg.id] = d.length;
    efficiency[reg.id] = 1;
    roomCrossings += roomsCrossed(reg.position, airHandler.position, rooms, reg.roomId);
    fittings += 2; // grille boot + return plenum connection
  }

  const totalLength = ducts.reduce((s, d) => s + d.length, 0);
  return { ducts, branchLength, efficiency, totalLength, fittings, roomCrossings };
}
