import type { AirHandler, Framing, Layout, Pt, Register, Room, Trunk, Wall, Warning } from '../types';
import type { EngineConfig } from './config';
import { add, bbox, centroid, closestPointOnSegment, dist, distToPolygonEdge, edges, lerp, outwardNormal, pointInPolygon, scale, sub } from './geometry';
import { joistGrid, snapToBay, trunkAxisFor, type JoistGrid } from './framing';
import { distribute, equipmentForTons, type RoomLoad } from './load';
import { routeDucts, type RouteResult } from './route';
import { roomAirflow, validate } from './validate';

export interface LayoutScore {
  total: number;
  ductLength: number;
  fittings: number;
  imbalance: number;
}

export function scoreLayout(rooms: Room[], loads: RoomLoad[], layout: Layout, route: RouteResult, warnings: Warning[], config: EngineConfig): LayoutScore {
  const airflow = roomAirflow(rooms, loads, layout, route);
  let imbalance = 0;
  for (const a of Object.values(airflow)) if (a.required > 0) imbalance += Math.abs(a.delivered - a.required) / a.required;
  const s = config.scoring;
  const penalties = warnings.reduce((p, w) => p + (w.severity === 'error' ? 200 : 40), 0);
  return {
    total: route.totalLength * s.lengthWeight + route.fittings * s.fittingWeight + imbalance * 100 * s.imbalanceWeight + route.roomCrossings * s.roomCrossingPenaltyFt + penalties,
    ductLength: route.totalLength,
    fittings: route.fittings,
    imbalance,
  };
}

function insetFromWall(p: Pt, wall: Wall, room: Room, inset: number): Pt | null {
  const n = outwardNormal(wall.start, wall.end, room.polygon);
  const q = sub(p, scale(n, inset));
  return pointInPolygon(q, room.polygon) && distToPolygonEdge(q, room.polygon) >= inset * 0.75 ? q : null;
}

/** Candidate supply spots for a room, best first: under windows, then exterior walls, then the ceiling centre. */
function supplyCandidates(room: Room, roomWalls: Wall[], config: EngineConfig): Pt[] {
  const inset = config.registerInsetFromWallFt;
  const out: Pt[] = [];
  const wallById = new Map(roomWalls.map((w) => [w.id, w]));
  const windows = [...room.windows].sort((a, b) => b.width * b.height * b.count - a.width * a.height * a.count);
  for (const win of windows) {
    const wall = wallById.get(win.wallId);
    if (!wall) continue;
    for (let k = 0; k < win.count; k++) {
      const q = insetFromWall(lerp(wall.start, wall.end, (k + 1) / (win.count + 1)), wall, room, inset);
      if (q) out.push(q);
    }
  }
  const ext = roomWalls.filter((w) => w.exterior).sort((a, b) => b.length - a.length);
  for (const fracs of [[0.5], [0.25, 0.75]]) {
    for (const wall of ext) {
      for (const f of fracs) {
        const q = insetFromWall(lerp(wall.start, wall.end, f), wall, room, inset);
        if (q) out.push(q);
      }
    }
  }
  const c = centroid(room.polygon);
  if (pointInPolygon(c, room.polygon)) out.push(c);
  // Fallback for odd shapes: interior wall midpoints.
  for (const wall of [...roomWalls].sort((a, b) => b.length - a.length)) {
    const q = insetFromWall(lerp(wall.start, wall.end, 0.5), wall, room, inset);
    if (q) out.push(q);
  }
  return out;
}

/** In joist bays, moves a spot to the nearest bay centre that stays well inside the room. */
function intoBay(p: Pt, room: Room, grid: JoistGrid | null): Pt | null {
  if (!grid) return p;
  const c = snapToBay(p, grid);
  for (const k of [0, -1, 1]) {
    const shift = k * grid.spacingFt;
    const q = grid.framing.joistDirection === 'y' ? { x: c.x + shift, y: c.y } : { x: c.x, y: c.y + shift };
    if (pointInPolygon(q, room.polygon) && distToPolygonEdge(q, room.polygon) >= 0.75) return q;
  }
  return null;
}

function pickSpaced(candidates: Pt[], n: number, spacing: number): Pt[] {
  const chosen: Pt[] = [];
  for (const minGap of [spacing, spacing / 2]) {
    for (const p of candidates) {
      if (chosen.length >= n) break;
      if (chosen.every((q) => dist(p, q) >= minGap)) chosen.push(p);
    }
    if (chosen.length >= n) break;
  }
  return chosen;
}

export function placeSupplyRegisters(rooms: Room[], walls: Wall[], loads: RoomLoad[], airflowCfm: number, config: EngineConfig, grid: JoistGrid | null = null): Register[] {
  const loadById = new Map(loads.map((l) => [l.roomId, l]));
  const valid = rooms.filter((r) => (loadById.get(r.id)?.areaSqFt ?? 0) > 1);
  // Room airflow follows sensible load (latent load doesn't change how much air a room needs).
  const roomCfm = distribute(airflowCfm, valid.map((r) => loadById.get(r.id)!.sensibleCoolingBtuh), config.minCfmPerSupplyRegister);
  const regs: Register[] = [];
  valid.forEach((room, i) => {
    const n = Math.max(1, Math.ceil(roomCfm[i] / config.maxCfmPerSupplyRegister));
    const candidates = supplyCandidates(room, walls.filter((w) => w.roomId === room.id), config)
      .map((p) => intoBay(p, room, grid))
      .filter((p): p is Pt => p !== null);
    const spots = pickSpaced(candidates, n, config.minRegisterSpacingFt);
    if (spots.length === 0) spots.push(intoBay(centroid(room.polygon), room, grid) ?? centroid(room.polygon));
    distribute(roomCfm[i], spots.map(() => 1)).forEach((cfm, k) => {
      regs.push({ id: `s-${room.id}-${k}`, roomId: room.id, position: spots[k], kind: 'supply', targetCfm: cfm });
    });
  });
  return regs;
}

function roomAt(p: Pt, rooms: Room[]): Room | undefined {
  return rooms.find((r) => pointInPolygon(p, r.polygon));
}

export function placeReturns(rooms: Room[], ahu: Pt, supply: Register[], airflowCfm: number, grid: JoistGrid | null = null): Register[] {
  const regs: Register[] = [];
  let bedroomCfm = 0;
  for (const room of rooms.filter((r) => r.isBedroom)) {
    const cfm = supply.filter((s) => s.roomId === room.id).reduce((s, r) => s + r.targetCfm, 0);
    if (cfm <= 0) continue;
    // Near the wall closest to the air handler (usually the door side).
    let best: Pt = room.polygon[0];
    for (const [a, b] of edges(room.polygon)) {
      const q = closestPointOnSegment(ahu, a, b);
      if (dist(q, ahu) < dist(best, ahu)) best = q;
    }
    const c = centroid(room.polygon);
    const toC = sub(c, best);
    const len = Math.hypot(toC.x, toC.y) || 1;
    let pos = add(best, scale(toC, 1.5 / len));
    if (!pointInPolygon(pos, room.polygon) || distToPolygonEdge(pos, room.polygon) < 0.8 || supply.some((s) => dist(s.position, pos) < 2)) pos = c;
    pos = intoBay(pos, room, grid) ?? pos;
    regs.push({ id: `r-${room.id}`, roomId: room.id, position: pos, kind: 'return', targetCfm: cfm });
    bedroomCfm += cfm;
  }

  // Central return beside the air handler, in a common area if possible.
  const b = bbox(rooms.flatMap((r) => r.polygon));
  const center = { x: b.minX + b.width / 2, y: b.minY + b.height / 2 };
  let best: { p: Pt; room: Room; d: number } | null = null;
  for (const radius of [3, 4.5, 6]) {
    for (let k = 0; k < 8; k++) {
      const ang = (k * Math.PI) / 4;
      const raw = { x: ahu.x + Math.cos(ang) * radius, y: ahu.y + Math.sin(ang) * radius };
      const room = roomAt(raw, rooms);
      const p = room ? intoBay(raw, room, grid) : null;
      if (!room || !p || room.isBedroom || distToPolygonEdge(p, room.polygon) < 1 || dist(p, ahu) < 2.5) continue;
      if (supply.some((s) => dist(s.position, p) < 2)) continue;
      const d = dist(p, center);
      if (!best || d < best.d) best = { p, room, d };
    }
    if (best) break;
  }
  const fallbackRoom = roomAt(ahu, rooms) ?? rooms[0];
  const pos = best?.p ?? { x: ahu.x + 3, y: ahu.y };
  regs.push({ id: 'r-central', roomId: best?.room.id ?? fallbackRoom.id, position: pos, kind: 'return', targetCfm: Math.max(0, airflowCfm - bedroomCfm) });
  return regs;
}

/** Candidate air handler spots near the plan's centre, kept clear of walls. */
function airHandlerCandidates(rooms: Room[]): Pt[] {
  const b = bbox(rooms.flatMap((r) => r.polygon));
  const center = { x: b.minX + b.width / 2, y: b.minY + b.height / 2 };
  const out: Pt[] = [];
  for (const dx of [-6, -3, 0, 3, 6]) {
    for (const dy of [-6, -3, 0, 3, 6]) {
      const p = { x: center.x + dx, y: center.y + dy };
      const room = roomAt(p, rooms);
      if (room && distToPolygonEdge(p, room.polygon) >= 1.5) out.push(p);
    }
  }
  if (out.length === 0) {
    const cs = rooms.map((r) => centroid(r.polygon)).filter((c, i) => pointInPolygon(c, rooms[i].polygon));
    cs.sort((p, q) => dist(p, center) - dist(q, center));
    out.push(cs[0] ?? center);
  }
  return out;
}

export interface GenerateInput {
  rooms: Room[];
  walls: Wall[];
  loads: RoomLoad[];
  tons: number;
  config: EngineConfig;
  /** User-chosen air handler spot; otherwise the engine searches near the plan centre. */
  airHandlerPosition?: Pt;
  framing: Framing;
  roomsSignature: string;
}

/** Builds a starting layout: tries nearby variations and keeps the best score. */
export function generateLayout(input: GenerateInput): { layout: Layout; score: LayoutScore } {
  const { rooms, walls, loads, tons, config, framing } = input;
  const grid = joistGrid(rooms, framing, config);
  const equipment = equipmentForTons(tons, config);
  const supply = placeSupplyRegisters(rooms, walls, loads, equipment.airflowCfm, config, grid);
  const b = bbox(rooms.flatMap((r) => r.polygon));
  const longAxis: Trunk['axis'] = b.width >= b.height ? 'x' : 'y';
  // In joist bays the trunk has to cross the joists; in an attic it follows the building's long axis.
  const axes: Trunk['axis'][] = grid ? [trunkAxisFor(framing)] : Math.max(b.width, b.height) / Math.max(1, Math.min(b.width, b.height)) < 1.3 ? ['x', 'y'] : [longAxis];
  const ahuSpots = input.airHandlerPosition ? [input.airHandlerPosition] : airHandlerCandidates(rooms);

  let best: { layout: Layout; score: LayoutScore } | null = null;
  for (const pos of ahuSpots) {
    const returns = placeReturns(rooms, pos, supply, equipment.airflowCfm, grid);
    for (const axis of axes) {
      for (const shift of [0, -3, 3]) {
        const airHandler: AirHandler = { id: 'ahu', position: pos, ...equipment };
        const trunk: Trunk = { axis, offset: (axis === 'x' ? pos.y : pos.x) + shift };
        const layout: Layout = { airHandler, trunk, registers: [...supply, ...returns], roomsSignature: input.roomsSignature };
        const route = routeDucts(rooms, layout, config, framing);
        const warnings = validate({ rooms, walls, loads, layout, route, config });
        const score = scoreLayout(rooms, loads, layout, route, warnings, config);
        if (!best || score.total < best.score.total) best = { layout, score };
      }
    }
  }
  return best!;
}
