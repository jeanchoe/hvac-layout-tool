import type { Framing, Pt, Room, Trunk } from '../types';
import { defaultConfig, type EngineConfig } from './config';
import { maxCfmForSpace } from './ductSizing';
import { bbox } from './geometry';

/** Joist layout in plan, measured across the joists. */
export interface JoistGrid {
  framing: Framing;
  /** Coordinate (ft) of the first joist, across the joists. */
  origin: number;
  spacingFt: number;
  /** Clear width of one bay between joists (in). */
  clearWidthIn: number;
  /** Tallest duct that fits inside a bay (in). */
  bayHeightIn: number;
  /** Most airflow one duct can carry along a bay (CFM). */
  bayMaxCfm: number;
  /** Most airflow one duct can carry in the trunk soffit (CFM). */
  soffitMaxCfm: number;
}

/** A grille or register this close to the trunk soffit connects into its side, with no run along a bay. */
export const SOFFIT_CONNECTION_FT = 3;

/** The return trunk runs beside the supply trunk, this far over (ft). */
export const RETURN_TRUNK_GAP_FT = 1.5;

/** Position of a point measured across the joists (x when joists run north-south). */
export const acrossJoists = (p: Pt, framing: Framing) => (framing.joistDirection === 'y' ? p.x : p.y);

/** The trunk crosses the joists in a soffit, so it runs perpendicular to them. */
export const trunkAxisFor = (framing: Framing): Trunk['axis'] => (framing.joistDirection === 'y' ? 'x' : 'y');

export function joistGrid(rooms: Room[], framing: Framing, config: EngineConfig = defaultConfig): JoistGrid | null {
  if (framing.ductSpace !== 'joist-bays' || rooms.length === 0) return null;
  const b = bbox(rooms.flatMap((r) => r.polygon));
  const f = config.framing;
  const clearWidthIn = framing.spacingIn - f.joistThicknessIn;
  const bayHeightIn = framing.depthIn - f.ductClearanceIn;
  return {
    framing,
    origin: framing.joistDirection === 'y' ? b.minX : b.minY,
    spacingFt: framing.spacingIn / 12,
    clearWidthIn,
    bayHeightIn,
    bayMaxCfm: maxCfmForSpace(bayHeightIn, clearWidthIn, config),
    soffitMaxCfm: maxCfmForSpace(framing.soffitDepthIn, undefined, config),
  };
}

/** Centre of the bay nearest to `c` (a coordinate across the joists). */
export function bayCentre(c: number, grid: JoistGrid): number {
  const k = Math.floor((c - grid.origin) / grid.spacingFt);
  return grid.origin + (k + 0.5) * grid.spacingFt;
}

/** Distance (ft) from `c` to the nearest joist centreline. */
export function distToJoist(c: number, grid: JoistGrid): number {
  const r = (((c - grid.origin) % grid.spacingFt) + grid.spacingFt) % grid.spacingFt;
  return Math.min(r, grid.spacingFt - r);
}

/** True when a register boot centred at `c` would hit a joist. */
export function bootHitsJoist(c: number, grid: JoistGrid, config: EngineConfig = defaultConfig): boolean {
  const need = (config.framing.bootWidthIn / 2 + config.framing.joistThicknessIn / 2) / 12;
  return need * 2 < grid.spacingFt ? distToJoist(c, grid) < need - 1e-6 : true;
}

/** Moves a point across the joists to the centre of its bay. */
export function snapToBay(p: Pt, grid: JoistGrid): Pt {
  const c = bayCentre(acrossJoists(p, grid.framing), grid);
  return grid.framing.joistDirection === 'y' ? { x: c, y: p.y } : { x: p.x, y: c };
}

/** Joist centrelines (across-joist coordinates) spanning the building. */
export function joistPositions(rooms: Room[], grid: JoistGrid): number[] {
  const b = bbox(rooms.flatMap((r) => r.polygon));
  const max = grid.framing.joistDirection === 'y' ? b.maxX : b.maxY;
  const out: number[] = [];
  for (let c = grid.origin; c <= max + 1e-6; c += grid.spacingFt) out.push(c);
  return out;
}
