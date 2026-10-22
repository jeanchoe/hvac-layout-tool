import type { Direction, Room, Wall } from '../types';
import { dist, outwardNormal } from './geometry';

/** Max gap between two parallel room edges for them to count as one shared wall (ft). */
const SHARED_WALL_TOLERANCE_FT = 1.0;

export const wallId = (roomId: string, edgeIndex: number) => `${roomId}:${edgeIndex}`;

export function directionOf(n: { x: number; y: number }): Direction {
  if (Math.abs(n.x) > Math.abs(n.y)) return n.x > 0 ? 'E' : 'W';
  return n.y > 0 ? 'S' : 'N';
}

/** Length of edge (a,b) that overlaps edge (c,d), if they are parallel and close. */
function sharedLength(a: Room['polygon'][0], b: Room['polygon'][0], c: Room['polygon'][0], d: Room['polygon'][0]) {
  const len = dist(a, b);
  if (len < 1e-6) return 0;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const len2 = dist(c, d) || 1;
  const vx = (d.x - c.x) / len2;
  const vy = (d.y - c.y) / len2;
  if (Math.abs(ux * vy - uy * vx) > 0.05) return 0; // not parallel
  const perp = Math.abs((c.x - a.x) * -uy + (c.y - a.y) * ux);
  if (perp > SHARED_WALL_TOLERANCE_FT) return 0;
  const t1 = (c.x - a.x) * ux + (c.y - a.y) * uy;
  const t2 = (d.x - a.x) * ux + (d.y - a.y) * uy;
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(len, Math.max(t1, t2));
  return Math.max(0, hi - lo);
}

/** One wall per room edge. An edge mostly overlapped by another room's edge is interior. */
export function deriveWalls(rooms: Room[]): Wall[] {
  const walls: Wall[] = [];
  for (const room of rooms) {
    const poly = room.polygon;
    if (poly.length < 3) continue;
    poly.forEach((start, i) => {
      const end = poly[(i + 1) % poly.length];
      const length = dist(start, end);
      // A wall can border several rooms (a hall beside three bedrooms): add up all the overlap.
      let sharedWithRoomId: string | null = null;
      let bestShared = 0;
      let totalShared = 0;
      for (const other of rooms) {
        if (other.id === room.id || other.polygon.length < 3) continue;
        let shared = 0;
        other.polygon.forEach((c, j) => {
          shared += sharedLength(start, end, c, other.polygon[(j + 1) % other.polygon.length]);
        });
        totalShared += shared;
        if (shared > bestShared) {
          bestShared = shared;
          sharedWithRoomId = other.id;
        }
      }
      const autoExterior = totalShared < length * 0.5;
      const id = wallId(room.id, i);
      const override = room.exteriorOverrides[id];
      walls.push({
        id,
        roomId: room.id,
        edgeIndex: i,
        start,
        end,
        length,
        autoExterior,
        exterior: override ?? autoExterior,
        facing: directionOf(outwardNormal(start, end, poly)),
        sharedWithRoomId: autoExterior ? null : sharedWithRoomId,
      });
    });
  }
  return walls;
}
