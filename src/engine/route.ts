import type { DuctSegment, Framing, Layout, Pt, Register, Room, Trunk } from '../types';
import { defaultConfig, resolveFraming, type EngineConfig } from './config';
import { bbox, dist, pointInPolygon } from './geometry';
import { branchEfficiency, fitDuct, sizeDuct } from './ductSizing';
import { RETURN_TRUNK_GAP_FT, SOFFIT_CONNECTION_FT, joistGrid, type JoistGrid } from './framing';

export interface RouteResult {
  ducts: DuctSegment[];
  /** Branch length per register id. */
  branchLength: Record<string, number>;
  /** Estimated share of design airflow delivered per register id. */
  efficiency: Record<string, number>;
  totalLength: number;
  fittings: number;
  roomCrossings: number;
  /** Joist layout when ducts run in joist bays, else null. */
  grid: JoistGrid | null;
}

/** Usable extent of the trunk along its axis: the building's bounding box, inset 1 ft. */
export function trunkExtent(rooms: Room[], trunk: Trunk) {
  const b = bbox(rooms.flatMap((r) => r.polygon));
  return trunk.axis === 'x' ? { min: b.minX + 1, max: b.maxX - 1 } : { min: b.minY + 1, max: b.maxY - 1 };
}

/** Point at position `t` along a line parallel to the trunk at perpendicular `offset`. */
const pointOn = (axis: Trunk['axis'], offset: number, t: number): Pt => (axis === 'x' ? { x: t, y: offset } : { x: offset, y: t });
export const trunkPoint = (trunk: Trunk, t: number): Pt => pointOn(trunk.axis, trunk.offset, t);

const along = (trunk: Trunk, p: Pt) => (trunk.axis === 'x' ? p.x : p.y);
const clamp = (v: number, e: { min: number; max: number }) => Math.min(e.max, Math.max(e.min, v));

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
    const t = Math.round(clamp(proj + k * 2, extent) * 100) / 100;
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

interface SpaceLimit {
  maxHeightIn?: number;
  maxWidthIn?: number;
}

function seg(id: string, start: Pt, end: Pt, type: DuctSegment['type'], side: DuctSegment['side'], cfm: number, config: EngineConfig, limit: SpaceLimit, registerId?: string): DuctSegment {
  const diameter = sizeDuct(cfm, config);
  const fit = fitDuct(diameter, limit.maxHeightIn, limit.maxWidthIn, config);
  return {
    id,
    start,
    end,
    type,
    side,
    cfm: Math.round(cfm),
    diameter,
    shape: fit.shape,
    ...(fit.shape === 'rect' ? { widthIn: fit.widthIn, heightIn: fit.heightIn } : {}),
    ...(limit.maxHeightIn !== undefined ? { maxHeightIn: limit.maxHeightIn } : {}),
    fits: fit.fits,
    length: dist(start, end),
    ...(registerId ? { registerId } : {}),
  };
}

/**
 * Lays a reducing run along a line on both sides of `a0`: each segment carries everything
 * downstream of it. Returns the number of fittings added.
 */
function reducingRun(prefix: string, side: DuctSegment['side'], stops: { t: number; cfm: number }[], a0: number, at: (t: number) => Pt, limit: SpaceLimit, ducts: DuctSegment[], config: EngineConfig): number {
  let fittings = 0;
  for (const dir of ['L', 'R'] as const) {
    const mine = stops.filter((k) => (dir === 'L' ? k.t < a0 - 1e-6 : k.t >= a0 - 1e-6)).sort((p, q) => Math.abs(p.t - a0) - Math.abs(q.t - a0));
    if (!mine.length) continue;
    const merged: { t: number; cfm: number }[] = [];
    for (const k of mine) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.t - k.t) < 0.1) last.cfm += k.cfm;
      else merged.push({ ...k });
    }
    let remaining = merged.reduce((s, x) => s + x.cfm, 0);
    let prev = a0;
    merged.forEach((stop, i) => {
      if (Math.abs(stop.t - prev) > 0.05) ducts.push(seg(`${prefix}-${dir}${i}`, at(prev), at(stop.t), 'trunk', side, remaining, config, limit));
      remaining -= stop.cfm;
      prev = stop.t;
      fittings += 1; // takeoff
    });
    fittings += 1; // end cap
  }
  return fittings;
}

/**
 * Builds the duct tree from the air handler, the supply trunk line and the registers.
 * Pure and fast: the UI calls it on every drag.
 *
 * Attic: branches take the shortest path to the trunk and returns run straight back.
 * Joist bays: the trunk (and a parallel return trunk) cross the joists in a soffit, and every
 * branch runs along the joists inside its bay.
 */
export function routeDucts(rooms: Room[], layout: Layout, config: EngineConfig = defaultConfig, framingIn?: Framing): RouteResult {
  const framing = resolveFraming(framingIn, config);
  const grid = joistGrid(rooms, framing, config);
  const { airHandler, trunk, registers } = layout;
  const ducts: DuctSegment[] = [];
  const branchLength: Record<string, number> = {};
  const efficiency: Record<string, number> = {};
  let fittings = 0;
  let roomCrossings = 0;
  if (rooms.length === 0) return { ducts, branchLength, efficiency, totalLength: 0, fittings, roomCrossings, grid };

  const soffit: SpaceLimit = grid ? { maxHeightIn: framing.soffitDepthIn } : {};
  const bay: SpaceLimit = grid ? { maxHeightIn: grid.bayHeightIn, maxWidthIn: grid.clearWidthIn } : {};
  const extent = trunkExtent(rooms, trunk);
  const a0 = along(trunk, airHandler.position);
  const ext = { min: Math.min(extent.min, a0), max: Math.max(extent.max, a0) };

  // Supply: a takeoff on the trunk for every supply register.
  const supply = registers.filter((r) => r.kind === 'supply');
  const takeoffs = supply.map((reg) => {
    if (!grid) return { reg, ...chooseTakeoff(reg, rooms, trunk, ext, config) };
    // In a joist bay the branch can only run along the joists, straight to the trunk.
    const t = clamp(along(trunk, reg.position), ext);
    return { reg, t, crossings: roomsCrossed(trunkPoint(trunk, t), reg.position, rooms, reg.roomId) };
  });
  const totalSupply = supply.reduce((s, r) => s + r.targetCfm, 0);

  const origin = trunkPoint(trunk, a0);
  if (dist(origin, airHandler.position) > 0.05) {
    ducts.push(seg('trunk-stub', airHandler.position, origin, 'trunk', 'supply', totalSupply, config, soffit));
    fittings += 1;
  }
  fittings += reducingRun('trunk', 'supply', takeoffs.map((k) => ({ t: k.t, cfm: k.reg.targetCfm })), a0, (t) => trunkPoint(trunk, t), soffit, ducts, config);

  // Next to the soffit a register connects into its side, so only longer runs are limited by the bay.
  const legLimit = (a: Pt, b: Pt) => (grid && dist(a, b) <= SOFFIT_CONNECTION_FT ? soffit : bay);
  for (const k of takeoffs) {
    const start = trunkPoint(trunk, k.t);
    const d = seg(`branch-${k.reg.id}`, start, k.reg.position, 'branch', 'supply', k.reg.targetCfm, config, legLimit(start, k.reg.position), k.reg.id);
    ducts.push(d);
    branchLength[k.reg.id] = d.length;
    efficiency[k.reg.id] = branchEfficiency(d.length, config);
    roomCrossings += k.crossings;
    fittings += 1; // boot
  }

  const returns = registers.filter((r) => r.kind === 'return');
  if (!grid) {
    // Returns run straight back to the air handler; the largest one is the central return trunk.
    const central = returns.reduce<Register | null>((m, r) => (!m || r.targetCfm > m.targetCfm ? r : m), null);
    for (const reg of returns) {
      const d = seg(`return-${reg.id}`, reg.position, airHandler.position, reg === central ? 'trunk' : 'branch', 'return', reg.targetCfm, config, {}, reg.id);
      ducts.push(d);
      branchLength[reg.id] = d.length;
      efficiency[reg.id] = 1;
      roomCrossings += roomsCrossed(reg.position, airHandler.position, rooms, reg.roomId);
      fittings += 2; // grille boot + return plenum connection
    }
  } else if (returns.length) {
    // A return trunk runs beside the supply trunk in the same soffit.
    const rOffset = trunk.offset + RETURN_TRUNK_GAP_FT;
    const at = (t: number) => pointOn(trunk.axis, rOffset, t);
    const legs = returns.map((reg) => ({ reg, t: clamp(along(trunk, reg.position), ext) }));
    for (const { reg, t } of legs) {
      const d = seg(`return-${reg.id}`, reg.position, at(t), 'branch', 'return', reg.targetCfm, config, legLimit(reg.position, at(t)), reg.id);
      ducts.push(d);
      branchLength[reg.id] = d.length;
      efficiency[reg.id] = 1;
      fittings += 1;
    }
    fittings += reducingRun('return-trunk', 'return', legs.map((k) => ({ t: k.t, cfm: k.reg.targetCfm })), a0, at, soffit, ducts, config);
    const total = returns.reduce((s, r) => s + r.targetCfm, 0);
    ducts.push(seg('return-stub', at(a0), airHandler.position, 'trunk', 'return', total, config, soffit));
    fittings += 1;
  }

  const totalLength = ducts.reduce((s, d) => s + d.length, 0);
  return { ducts, branchLength, efficiency, totalLength, fittings, roomCrossings, grid };
}
