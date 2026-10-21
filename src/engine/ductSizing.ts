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
