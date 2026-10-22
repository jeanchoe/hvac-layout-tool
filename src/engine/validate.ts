import type { Layout, Room, Warning, Wall } from '../types';
import { defaultConfig, type EngineConfig } from './config';
import { maxCfmForSpace } from './ductSizing';
import { acrossJoists, bootHitsJoist } from './framing';
import { dist, distToSegment, pointInPolygon } from './geometry';
import type { RoomLoad } from './load';
import type { RouteResult } from './route';

export interface RoomAirflow {
  /** Airflow the room's load calls for. */
  required: number;
  /** Estimated airflow from supply registers physically inside the room, after branch losses. */
  delivered: number;
}

export interface ValidationInput {
  rooms: Room[];
  walls: Wall[];
  loads: RoomLoad[];
  layout: Layout;
  route: RouteResult;
  config?: EngineConfig;
}

export function roomAirflow(rooms: Room[], loads: RoomLoad[], layout: Layout, route: RouteResult): Record<string, RoomAirflow> {
  const out: Record<string, RoomAirflow> = {};
  for (const room of rooms) {
    const load = loads.find((l) => l.roomId === room.id);
    const delivered = layout.registers
      .filter((r) => r.kind === 'supply' && pointInPolygon(r.position, room.polygon))
      .reduce((s, r) => s + r.targetCfm * (route.efficiency[r.id] ?? 1), 0);
    out[room.id] = { required: load?.requiredCfm ?? 0, delivered };
  }
  return out;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** All live validation rules. Recomputed after every edit. */
export function validate({ rooms, walls, loads, layout, route, config = defaultConfig }: ValidationInput): Warning[] {
  const v = config.validation;
  const warnings: Warning[] = [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const ahu = layout.airHandler;

  // 1. Every room gets a supply register, and enough airflow.
  const airflow = roomAirflow(rooms, loads, layout, route);
  for (const room of rooms) {
    const regs = layout.registers.filter((r) => r.kind === 'supply' && r.roomId === room.id);
    if (regs.length === 0) {
      warnings.push({ id: `no-supply-${room.id}`, code: 'ROOM_NO_SUPPLY', severity: 'error', message: `${room.name} has no supply register.`, componentIds: [room.id] });
      continue;
    }
    const { required, delivered } = airflow[room.id];
    if (required > 0 && delivered < required * (1 - v.lowAirflowTolerance)) {
      const pct = Math.round((1 - delivered / required) * 100);
      warnings.push({
        id: `low-airflow-${room.id}`,
        code: 'ROOM_LOW_AIRFLOW',
        severity: 'warning',
        message: `${room.name} gets ${fmt(delivered)} CFM, ${pct}% below the ${fmt(required)} CFM it needs.`,
        componentIds: [room.id, ...regs.map((r) => r.id)],
      });
    }
  }

  // 2. Branch length.
  for (const d of route.ducts) {
    if (d.type !== 'branch' || d.length <= v.maxBranchLengthFt) continue;
    warnings.push({
      id: `long-branch-${d.id}`,
      code: 'BRANCH_TOO_LONG',
      severity: 'warning',
      message: `${d.side === 'supply' ? 'Supply' : 'Return'} branch is ${d.length.toFixed(1)} ft (max ${v.maxBranchLengthFt} ft).`,
      componentIds: [d.id, ...(d.registerId ? [d.registerId] : [])],
    });
  }

  // 3. Register placement: in a wall, outside its room, or overlapping another component.
  for (const reg of layout.registers) {
    const label = `${reg.kind === 'supply' ? 'Supply register' : 'Return grille'} in ${roomById.get(reg.roomId)?.name ?? 'unknown room'}`;
    const inWall = walls.some((w) => distToSegment(reg.position, w.start, w.end) < v.registerWallClearanceFt);
    const room = roomById.get(reg.roomId);
    if (inWall) {
      warnings.push({ id: `in-wall-${reg.id}`, code: 'REGISTER_IN_WALL', severity: 'error', message: `${label} sits inside a wall.`, componentIds: [reg.id] });
    } else if (!room || !pointInPolygon(reg.position, room.polygon)) {
      warnings.push({ id: `outside-${reg.id}`, code: 'REGISTER_OUTSIDE_ROOM', severity: 'error', message: `${label} is outside its room.`, componentIds: [reg.id] });
    }
  }
  const regs = layout.registers;
  for (let i = 0; i < regs.length; i++) {
    for (let j = i + 1; j < regs.length; j++) {
      if (dist(regs[i].position, regs[j].position) < v.registerSpacingFt) {
        warnings.push({ id: `overlap-${regs[i].id}-${regs[j].id}`, code: 'COMPONENT_OVERLAP', severity: 'warning', message: 'Two registers overlap.', componentIds: [regs[i].id, regs[j].id] });
      }
    }
    if (dist(regs[i].position, ahu.position) < v.airHandlerClearanceFt) {
      warnings.push({ id: `overlap-${regs[i].id}-ahu`, code: 'COMPONENT_OVERLAP', severity: 'warning', message: 'A register overlaps the air handler.', componentIds: [regs[i].id, ahu.id] });
    }
  }
  // 4. Framing: every duct must fit the space it runs in, and boots must land between joists.
  // A branch that is too big can be split into several grilles in neighbouring bays.
  const fixBySplitting = (d: (typeof route.ducts)[0]): Pick<Warning, 'fix'> => {
    if (d.type !== 'branch' || !d.registerId || !route.grid) return {};
    const cap = maxCfmForSpace(d.maxHeightIn, route.grid.clearWidthIn, config);
    return cap > 0 ? { fix: { kind: 'split-register', registerId: d.registerId, parts: Math.ceil(d.cfm / cap) } } : {};
  };
  for (const d of route.ducts) {
    if (d.fits) continue;
    const inches = (v = 0) => `${Math.round(v * 10) / 10}"`;
    const where = d.type === 'branch' ? `${inches(route.grid?.clearWidthIn)} wide × ${inches(d.maxHeightIn)} deep joist bay` : `${inches(d.maxHeightIn)} soffit`;
    warnings.push({
      id: `no-fit-${d.id}`,
      code: 'DUCT_DOES_NOT_FIT',
      severity: 'error',
      message: `A ${fmt(d.cfm)} CFM ${d.side} ${d.type} (${d.diameter}" round equivalent) doesn't fit the ${where}.`,
      componentIds: [d.id, ...(d.registerId ? [d.registerId] : [])],
      ...fixBySplitting(d),
    });
  }
  if (route.grid) {
    for (const reg of regs) {
      if (!bootHitsJoist(acrossJoists(reg.position, route.grid.framing), route.grid, config)) continue;
      warnings.push({
        id: `on-joist-${reg.id}`,
        code: 'REGISTER_ON_JOIST',
        severity: 'warning',
        message: `${reg.kind === 'supply' ? 'Supply register' : 'Return grille'} in ${roomById.get(reg.roomId)?.name ?? 'unknown room'} lands on a joist. Move it into a bay.`,
        componentIds: [reg.id],
      });
    }
  }

  if (!rooms.some((r) => pointInPolygon(ahu.position, r.polygon))) {
    warnings.push({ id: 'ahu-outside', code: 'AHU_OUTSIDE_BUILDING', severity: 'warning', message: 'The air handler is outside the traced rooms.', componentIds: [ahu.id] });
  }

  // 5. Total airflow must match the air handler.
  for (const kind of ['supply', 'return'] as const) {
    const total = regs.filter((r) => r.kind === kind).reduce((s, r) => s + r.targetCfm, 0);
    if (Math.abs(total - ahu.airflowCfm) > ahu.airflowCfm * v.airflowMatchTolerance) {
      warnings.push({
        id: `mismatch-${kind}`,
        code: 'AIRFLOW_MISMATCH',
        severity: 'warning',
        message: `Total ${kind} airflow is ${fmt(total)} CFM but the air handler moves ${fmt(ahu.airflowCfm)} CFM.`,
        componentIds: [ahu.id, ...regs.filter((r) => r.kind === kind).map((r) => r.id)],
      });
    }
  }

  return warnings;
}
