import type { Floor, Framing, Project, Pt, Room } from '../types';
import { defaultConfig, resolveFraming, type EngineConfig } from './config';
import { bbox, pointInPolygon, polygonArea } from './geometry';

export const sortedFloors = (floors: Floor[]) => [...floors].sort((a, b) => a.level - b.level);

/** Subfloor, underlayment and ceiling drywall added to the joist depth between floors (ft). */
export const FLOOR_BUILDUP_FT = 0.25;

/** Floor-to-floor height: as entered, or worked out from the ceilings and the floor framing. */
export function floorHeight(project: Pick<Project, 'rooms' | 'framing'>, floor: Floor, config: EngineConfig = defaultConfig): number {
  if (floor.heightFt !== undefined) return floor.heightFt;
  const ceilings = project.rooms.filter((r) => r.floorId === floor.id).map((r) => r.ceilingHeight);
  return Math.max(8, ...ceilings) + resolveFraming(project.framing, config).depthIn / 12 + FLOOR_BUILDUP_FT;
}

/** Height of each floor's finished floor above the ground floor (ft). */
export function floorElevations(project: Pick<Project, 'floors' | 'rooms' | 'framing'>, config: EngineConfig = defaultConfig): Map<string, number> {
  const out = new Map<string, number>();
  let z = 0;
  for (const f of sortedFloors(project.floors)) {
    out.set(f.id, z);
    z += floorHeight(project, f, config);
  }
  return out;
}

/** Framing for one floor: shared joist sizes, with this floor's duct space. */
export function floorFraming(project: Pick<Project, 'floors' | 'framing'>, floorId: string, config: EngineConfig = defaultConfig): Framing {
  const base = resolveFraming(project.framing, config);
  const floor = project.floors.find((f) => f.id === floorId);
  if (!floor) return base;
  const hasFloorAbove = project.floors.some((f) => f.level === floor.level + 1);
  return { ...base, ductSpace: floor.ductSpace ?? (hasFloorAbove ? 'joist-bays' : base.ductSpace) };
}

export const roomsOnFloor = (rooms: Room[], floorId: string) => rooms.filter((r) => r.floorId === floorId);

/** How much of each room's ceiling and floor face unconditioned space, as fractions of its area. */
export interface Exposure {
  level: number;
  /** Share of the ceiling with no room directly above (open to the attic). */
  ceiling: number;
  /** Share of the floor with no room directly below (on the ground, or over a garage/outdoors). */
  floor: number;
}

/** Sample points spread over a polygon (about one per `step` ft in each direction). */
function samplePoints(poly: Pt[], step = 0.75): Pt[] {
  const b = bbox(poly);
  const out: Pt[] = [];
  for (let y = b.minY + step / 2; y < b.maxY; y += step) {
    for (let x = b.minX + step / 2; x < b.maxX; x += step) {
      const p = { x, y };
      if (pointInPolygon(p, poly)) out.push(p);
    }
  }
  return out.length ? out : poly.slice(0, 1);
}

const cache = new WeakMap<Room[], WeakMap<Floor[], Map<string, Exposure>>>();

/**
 * Works out, room by room, which parts of the ceiling and floor are covered by rooms on the
 * floors above and below. Cached per rooms/floors snapshot, since it only changes with geometry.
 */
export function roomExposure(rooms: Room[], floors: Floor[]): Map<string, Exposure> {
  let byFloors = cache.get(rooms);
  if (!byFloors) cache.set(rooms, (byFloors = new WeakMap()));
  const hit = byFloors.get(floors);
  if (hit) return hit;

  const levelOf = new Map(floors.map((f) => [f.id, f.level]));
  const byLevel = new Map<number, Room[]>();
  for (const r of rooms) {
    const lv = levelOf.get(r.floorId) ?? 0;
    byLevel.set(lv, [...(byLevel.get(lv) ?? []), r]);
  }
  const coveredShare = (pts: Pt[], others: Room[]) => (others.length ? pts.filter((p) => others.some((o) => pointInPolygon(p, o.polygon))).length / pts.length : 0);
  const out = new Map<string, Exposure>();
  for (const r of rooms) {
    const level = levelOf.get(r.floorId) ?? 0;
    if (polygonArea(r.polygon) <= 0) {
      out.set(r.id, { level, ceiling: 1, floor: 1 });
      continue;
    }
    const pts = samplePoints(r.polygon);
    out.set(r.id, {
      level,
      ceiling: 1 - coveredShare(pts, byLevel.get(level + 1) ?? []),
      floor: level === 0 ? 1 : 1 - coveredShare(pts, byLevel.get(level - 1) ?? []),
    });
  }
  byFloors.set(floors, out);
  return out;
}

export const newFloor = (id: string, level: number, name = `Floor ${level + 1}`): Floor => ({
  id,
  name,
  level,
  background: null,
  scalePxPerFt: null,
  scaleLine: null,
  offsetFt: { x: 0, y: 0 },
});

/** Upgrades a saved project of any earlier version to the current schema. */
export function migrateProject(raw: unknown): Project {
  const p = raw as Record<string, unknown> & Partial<Project>;
  if (!p || typeof p !== 'object' || !Array.isArray(p.rooms)) throw new Error('That file is not an HVAC Layout Tool project.');
  if (p.schemaVersion === 2) return p as Project;
  if (p.schemaVersion !== 1) throw new Error('That project was saved by a newer version of this tool.');
  // v1: one floor, with the plan image, scale and layout stored on the project itself.
  const floor: Floor = {
    ...newFloor('f1', 0, 'Floor 1'),
    background: (p.background as Floor['background']) ?? null,
    scalePxPerFt: (p.scalePxPerFt as number | null) ?? null,
    scaleLine: (p.scaleLine as Floor['scaleLine']) ?? null,
  };
  const { background: _b, scalePxPerFt: _s, scaleLine: _l, layout, ...rest } = p as Record<string, unknown>;
  return {
    ...(rest as unknown as Project),
    schemaVersion: 2,
    floors: [floor],
    rooms: (p.rooms as Room[]).map((r) => ({ ...r, floorId: r.floorId ?? floor.id })),
    layouts: layout ? { [floor.id]: layout as Project['layouts'][string] } : {},
  };
}
