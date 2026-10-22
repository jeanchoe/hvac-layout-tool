import type { Beam, Pt, Room } from '../types';
import type { EngineConfig } from './config';
import { bbox, distToSegment, pointInPolygon } from './geometry';

/** Half the width of a beam's flange plus a little clearance (ft): a duct this close is under it. */
const BEAM_HALF_WIDTH_FT = 0.45;

/** A point the network must reach (a diffuser or grille) and the air it carries. */
export interface Terminal {
  id: string;
  at: Pt;
  cfm: number;
}

export interface BeamCrossing {
  beamId: string;
  kind: Beam['kind'];
  at: Pt;
}

/** One straight run of the network. `start` is upstream (towards the unit). */
export interface TreeSegment {
  start: Pt;
  end: Pt;
  cfm: number;
  /** How many terminals this run feeds, and (when it is exactly one) which. */
  terminalCount: number;
  terminalId: string | null;
  crossings: BeamCrossing[];
}

export interface DuctTree {
  segments: TreeSegment[];
  turns: number;
  tees: number;
  wallCrossings: number;
  cellFt: number;
}

// Moves on the grid: east, west, south, north (plan y grows southwards).
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const NO_DIR = 4;

/**
 * Does a grid step from `a` to `b` cross the beam `c`-`d`? A point exactly on the beam's line
 * counts as being on one fixed side, so a path along grid lines that meets a beam drawn on a
 * grid line crosses it at exactly one step, never zero or two.
 */
function crossesBeam(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const side = (p: Pt) => (cross(c, d, p) > 1e-9 ? 1 : 0);
  if (side(a) === side(b)) return false;
  // Where along the beam the step's line meets it: must be within the beam's length.
  const r = { x: b.x - a.x, y: b.y - a.y };
  const sv = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * sv.y - r.y * sv.x;
  if (Math.abs(denom) < 1e-12) return false;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  return u >= -1e-9 && u <= 1 + 1e-9;
}

/** Minimal binary heap keyed by cost. */
class Heap {
  private cost: number[] = [];
  private item: number[] = [];
  get size() {
    return this.item.length;
  }
  push(c: number, v: number) {
    this.cost.push(c);
    this.item.push(v);
    let i = this.item.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      [this.cost[p], this.cost[i]] = [this.cost[i], this.cost[p]];
      [this.item[p], this.item[i]] = [this.item[i], this.item[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.cost[0], this.item[0]];
    const lc = this.cost.pop()!;
    const li = this.item.pop()!;
    if (this.item.length) {
      this.cost[0] = lc;
      this.item[0] = li;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.item.length && this.cost[l] < this.cost[m]) m = l;
        if (r < this.item.length && this.cost[r] < this.cost[m]) m = r;
        if (m === i) break;
        [this.cost[m], this.cost[i]] = [this.cost[i], this.cost[m]];
        [this.item[m], this.item[i]] = [this.item[i], this.item[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Routes a duct network from `root` (the unit) to every terminal on an orthogonal grid over the
 * floor, as an engineer would sketch it: repeatedly connect the terminal that is cheapest to
 * reach from the network built so far (shortest-path Steiner heuristic). Mains form where
 * terminals share a route; branches tee off them.
 *
 * Cost of a path, in feet of duct: length + an elbow cost per turn + a cost per wall crossed
 * above the ceiling + a cost per secondary beam dropped under. Main beams cost so much that a
 * path crosses one only when there is no other way (and validation then flags it).
 */
export function routeTree(rooms: Room[], beams: Beam[], root: Pt, terminals: Terminal[], config: EngineConfig): DuctTree {
  const cfg = config.pathfinding;
  const empty: DuctTree = { segments: [], turns: 0, tees: 0, wallCrossings: 0, cellFt: cfg.cellFt };
  if (!rooms.length || !terminals.length) return empty;

  // ---- Grid over the floor; nodes are grid points, passable when inside a room.
  const b = bbox(rooms.flatMap((r) => r.polygon));
  const cell = Math.max(cfg.cellFt, Math.sqrt(((b.width + 2) * (b.height + 2)) / cfg.maxCells));
  const x0 = b.minX - cell;
  const y0 = b.minY - cell;
  const nx = Math.ceil((b.width + 2 * cell) / cell) + 1;
  const ny = Math.ceil((b.height + 2 * cell) / cell) + 1;
  const n = nx * ny;
  const px = (i: number) => x0 + (i % nx) * cell;
  const py = (i: number) => y0 + Math.floor(i / nx) * cell;
  const roomOf = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = { x: px(i), y: py(i) };
    for (let r = 0; r < rooms.length; r++) {
      if (pointInPolygon(p, rooms[r].polygon)) {
        roomOf[i] = r;
        break;
      }
    }
  }

  // ---- Beam crossings per grid edge (keyed by node * 4 + direction).
  const edgeBeams = new Map<number, number[]>();
  beams.forEach((beam, bi) => {
    const i0 = Math.max(0, Math.floor((Math.min(beam.a.x, beam.b.x) - x0) / cell) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(beam.a.x, beam.b.x) - x0) / cell) + 1);
    const j0 = Math.max(0, Math.floor((Math.min(beam.a.y, beam.b.y) - y0) / cell) - 1);
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(beam.a.y, beam.b.y) - y0) / cell) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const u = j * nx + i;
        for (const dir of [0, 2]) {
          const ii = i + DX[dir];
          const jj = j + DY[dir];
          if (ii >= nx || jj >= ny) continue;
          const v = jj * nx + ii;
          if (!crossesBeam({ x: px(u), y: py(u) }, { x: px(v), y: py(v) }, beam.a, beam.b)) continue;
          for (const [node, d] of [
            [u, dir],
            [v, dir ^ 1],
          ]) {
            const k = node * 4 + d;
            edgeBeams.set(k, [...(edgeBeams.get(k) ?? []), bi]);
          }
        }
      }
    }
  });
  // ---- Beam footprints: a grid point right under a beam can only be used by passing under it.
  const under = new Int32Array(n).fill(-1);
  beams.forEach((beam, bi) => {
    const i0 = Math.max(0, Math.floor((Math.min(beam.a.x, beam.b.x) - x0) / cell) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(beam.a.x, beam.b.x) - x0) / cell) + 1);
    const j0 = Math.max(0, Math.floor((Math.min(beam.a.y, beam.b.y) - y0) / cell) - 1);
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(beam.a.y, beam.b.y) - y0) / cell) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const u = j * nx + i;
        if (distToSegment({ x: px(u), y: py(u) }, beam.a, beam.b) > BEAM_HALF_WIDTH_FT) continue;
        // Where beams meet, the main (or deeper) one governs.
        const cur = under[u] >= 0 ? beams[under[u]] : null;
        if (!cur || (beam.kind === 'main' && cur.kind !== 'main') || (beam.kind === cur.kind && beam.depthIn > cur.depthIn)) under[u] = bi;
      }
    }
  });
  /** Beams a grid step meets: ones it crosses, plus one whose footprint it moves into. */
  const stepBeams = (u: number, dir: number, v: number): number[] => {
    const hit = [...(edgeBeams.get(u * 4 + dir) ?? [])];
    if (under[v] >= 0 && !hit.includes(under[v])) hit.push(under[v]);
    return hit;
  };
  const edgeCost = (u: number, dir: number, v: number) => {
    let c = cell;
    if (roomOf[u] !== roomOf[v]) c += cfg.wallCrossCostFt;
    for (const bi of stepBeams(u, dir, v)) {
      if (beams[bi].kind === 'main') c += cfg.mainBeamCostFt;
      // Dropping under a secondary beam costs a pair of offsets; staying under it a little more per step.
      else c += under[u] === bi ? cell : cfg.secondaryBeamCostFt;
    }
    return c;
  };

  /** Nearest passable node to a point. */
  const snap = (p: Pt): number => {
    const ci = Math.round((p.x - x0) / cell);
    const cj = Math.round((p.y - y0) / cell);
    for (let ring = 0; ring < Math.max(nx, ny); ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let j = cj - ring; j <= cj + ring; j++) {
        for (let i = ci - ring; i <= ci + ring; i++) {
          if (i < 0 || j < 0 || i >= nx || j >= ny || (Math.abs(i - ci) !== ring && Math.abs(j - cj) !== ring)) continue;
          const u = j * nx + i;
          if (roomOf[u] < 0) continue;
          const d = Math.hypot(px(u) - p.x, py(u) - p.y);
          if (d < bestD) {
            bestD = d;
            best = u;
          }
        }
      }
      if (best >= 0) return best;
    }
    return ci + cj * nx;
  };

  // ---- Grow the tree one terminal at a time.
  const rootNode = snap(root);
  const parent = new Int32Array(n).fill(-1);
  const inTree = new Uint8Array(n);
  inTree[rootNode] = 1;
  const treeNodes = [rootNode];
  const termAt = new Map<number, Terminal[]>();
  for (const t of terminals) {
    const u = snap(t.at);
    termAt.set(u, [...(termAt.get(u) ?? []), t]);
  }
  const pending = new Set(termAt.keys());
  pending.delete(rootNode);

  const S = 5; // states per node: arrived moving E/W/S/N, or "starting here"
  const dist = new Float64Array(n * S);
  const prev = new Int32Array(n * S);
  while (pending.size) {
    dist.fill(Infinity);
    prev.fill(-1);
    const heap = new Heap();
    for (const u of treeNodes) {
      dist[u * S + NO_DIR] = 0;
      heap.push(0, u * S + NO_DIR);
    }
    let reached = -1;
    while (heap.size) {
      const [c, s] = heap.pop();
      if (c > dist[s]) continue;
      const u = Math.floor(s / S);
      const din = s % S;
      if (pending.has(u)) {
        reached = s;
        break;
      }
      const i = u % nx;
      const j = Math.floor(u / nx);
      for (let dir = 0; dir < 4; dir++) {
        if (din !== NO_DIR && dir === (din ^ 1)) continue; // no U-turns
        const ii = i + DX[dir];
        const jj = j + DY[dir];
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const v = jj * nx + ii;
        if (roomOf[v] < 0) continue;
        const nc = c + edgeCost(u, dir, v) + (din !== NO_DIR && dir !== din ? cfg.turnCostFt : 0);
        const ns = v * S + dir;
        if (nc < dist[ns]) {
          dist[ns] = nc;
          prev[ns] = s;
          heap.push(nc, ns);
        }
      }
    }
    if (reached < 0) break; // unreachable (rooms not connected): leave the rest unrouted
    // Walk back from the terminal to the tree, hooking each new node to the next one towards it.
    let s = reached;
    while (prev[s] >= 0) {
      const u = Math.floor(s / S);
      const p = Math.floor(prev[s] / S);
      if (!inTree[u]) {
        parent[u] = p;
        inTree[u] = 1;
        treeNodes.push(u);
      }
      s = prev[s];
    }
    pending.delete(Math.floor(reached / S));
  }

  // ---- Airflow through each node: everything downstream of it.
  const cfm = new Float64Array(n);
  const count = new Int32Array(n);
  const only = new Map<number, string>();
  for (const [u, ts] of termAt) {
    if (!inTree[u]) continue;
    for (const t of ts) {
      for (let v = u; v >= 0; v = parent[v]) {
        cfm[v] += t.cfm;
        count[v] += 1;
        if (count[v] === 1) only.set(v, t.id);
      }
    }
  }
  const children = new Map<number, number[]>();
  for (const u of treeNodes) if (parent[u] >= 0) children.set(parent[u], [...(children.get(parent[u]) ?? []), u]);

  const coord = (u: number): Pt => {
    if (u === rootNode) return { ...root };
    const ts = termAt.get(u);
    // A diffuser at the end of a run connects at its real position (within half a cell).
    if (ts?.length === 1 && !children.has(u)) return { ...ts[0].at };
    return { x: px(u), y: py(u) };
  };
  const dirOf = (from: number, to: number) => (to - from === 1 ? 0 : to - from === -1 ? 1 : to - from === nx ? 2 : 3);

  // ---- Merge straight runs into segments.
  const segments: TreeSegment[] = [];
  let turns = 0;
  let tees = 0;
  let wallCrossings = 0;
  const stack = [rootNode];
  while (stack.length) {
    const u = stack.pop()!;
    const kids = children.get(u) ?? [];
    if (kids.length > 1) tees += kids.length - 1;
    for (const first of kids) {
      let v = first;
      const dir = dirOf(u, v);
      const crossings: BeamCrossing[] = [];
      const collect = (from: number, to: number) => {
        const d = dirOf(from, to);
        if (roomOf[from] !== roomOf[to]) wallCrossings++;
        for (const bi of stepBeams(from, d, to)) {
          if (crossings.some((c) => c.beamId === beams[bi].id)) continue;
          crossings.push({ beamId: beams[bi].id, kind: beams[bi].kind, at: { x: (px(from) + px(to)) / 2, y: (py(from) + py(to)) / 2 } });
        }
      };
      collect(u, v);
      // Extend while the run continues straight with the same airflow and no branch-off.
      for (;;) {
        const next = children.get(v);
        if (!next || next.length !== 1 || termAt.has(v) || dirOf(v, next[0]) !== dir || count[next[0]] !== count[v]) break;
        collect(v, next[0]);
        v = next[0];
      }
      const next = children.get(v);
      if (next?.length === 1 && dirOf(v, next[0]) !== dir) turns++;
      segments.push({ start: coord(u), end: coord(v), cfm: cfm[v], terminalCount: count[v], terminalId: count[v] === 1 ? (only.get(v) ?? null) : null, crossings });
      stack.push(v);
    }
  }
  // A path can occasionally pass back through the network and leave a stub that feeds nothing.
  return { segments: segments.filter((s) => s.terminalCount > 0), turns, tees, wallCrossings, cellFt: cell };
}
