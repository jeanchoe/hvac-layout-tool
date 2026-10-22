import { defaultConfig, type EngineConfig } from './config';

/** Smallest round duct (inches) that carries `cfm` at the configured friction rate. */
export function sizeDuct(cfm: number, config: EngineConfig = defaultConfig): number {
  const table = config.roundDuctCapacityCfm;
  for (const row of table) if (cfm <= row.maxCfm) return row.diameterIn;
  // Beyond the table: scale the largest size by the airflow ratio (area ~ d^2, velocity held constant).
  const last = table[table.length - 1];
  return Math.ceil(last.diameterIn * Math.sqrt(cfm / last.maxCfm));
}

/** Share of design airflow a branch is expected to deliver given its length (simplified static-pressure loss). */
export function branchEfficiency(lengthFt: number, config: EngineConfig = defaultConfig): number {
  const { lossFreeLengthFt, lossPerFtBeyond, minEfficiency } = config.branchEfficiency;
  return Math.max(minEfficiency, 1 - Math.max(0, lengthFt - lossFreeLengthFt) * lossPerFtBeyond);
}

/** Round duct with the same friction loss as a w × h rectangle (ASHRAE equivalent-diameter formula). */
export const rectEquivalentDiameter = (w: number, h: number) => (1.3 * Math.pow(w * h, 0.625)) / Math.pow(w + h, 0.25);

export interface DuctFit {
  shape: 'round' | 'rect';
  widthIn?: number;
  heightIn?: number;
  /** False when no duct of this size fits the space. */
  fits: boolean;
}

/**
 * Picks a duct shape for an equivalent round size and the space available. Round if it fits
 * the height, otherwise the narrowest rectangle at the allowed height (whole inches).
 */
export function fitDuct(diameterIn: number, maxHeightIn?: number, maxWidthIn?: number, config: EngineConfig = defaultConfig): DuctFit {
  if (maxHeightIn === undefined || diameterIn <= maxHeightIn) {
    return { shape: 'round', fits: maxWidthIn === undefined || diameterIn <= maxWidthIn };
  }
  const h = Math.floor(maxHeightIn);
  if (h < 3) return { shape: 'rect', widthIn: diameterIn, heightIn: Math.max(1, h), fits: false };
  let w = h;
  while (rectEquivalentDiameter(w, h) < diameterIn && w < 120) w += 1;
  const fits = (maxWidthIn === undefined || w <= maxWidthIn) && w / h <= config.framing.maxAspectRatio;
  return { shape: 'rect', widthIn: w, heightIn: h, fits };
}

/** Most airflow (CFM) one duct can carry inside a space; 0 if not even the smallest duct fits. */
export function maxCfmForSpace(maxHeightIn?: number, maxWidthIn?: number, config: EngineConfig = defaultConfig): number {
  if (maxHeightIn === undefined && maxWidthIn === undefined) return Infinity;
  let best = 0;
  for (const row of config.roundDuctCapacityCfm) if (fitDuct(row.diameterIn, maxHeightIn, maxWidthIn, config).fits) best = row.maxCfm;
  return best;
}
