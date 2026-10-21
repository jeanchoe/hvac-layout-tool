import raw from '../config/engine-config.json';
import zipTable from '../config/zip-climate-zones.json';
import type { Direction, FloorType } from '../types';

export interface EngineConfig {
  climateZones: Record<string, { label: string; coolingBtuhPerSqFt: number; heatingBtuhPerSqFt: number }>;
  defaultClimateZone: number;
  windowCoolingBtuhPerSqFt: Record<Direction, number>;
  windowHeatingBtuhPerSqFtPerZone: number;
  exteriorWallCoolingBtuhPerSqFt: number;
  exteriorWallHeatingBtuhPerSqFtPerZone: number;
  ceilingHeightFactorPerFtAbove8: number;
  floorTypeHeatingMultiplier: Record<FloorType, number>;
  cfmPerTon: number;
  btuhPerTon: number;
  nominalTons: number[];
  maxCfmPerSupplyRegister: number;
  registerInsetFromWallFt: number;
  minRegisterSpacingFt: number;
  frictionRateInWcPer100Ft: number;
  roundDuctCapacityCfm: { diameterIn: number; maxCfm: number }[];
  branchEfficiency: { lossFreeLengthFt: number; lossPerFtBeyond: number; minEfficiency: number };
  validation: {
    lowAirflowTolerance: number;
    airflowMatchTolerance: number;
    maxBranchLengthFt: number;
    registerWallClearanceFt: number;
    registerSpacingFt: number;
    airHandlerClearanceFt: number;
  };
  scoring: { lengthWeight: number; fittingWeight: number; imbalanceWeight: number; roomCrossingPenaltyFt: number };
}

export const defaultConfig = raw as unknown as EngineConfig;

export interface ClimateInfo {
  zone: number;
  label: string;
  fromZip: boolean;
}

export function climateForZip(zip: string, config: EngineConfig = defaultConfig): ClimateInfo {
  const m = /^(\d{3})\d{2}$/.exec(zip.trim());
  let zone: number | null = null;
  if (m) {
    const prefix = Number(m[1]);
    for (const [lo, hi, z] of zipTable.ranges as [number, number, number][]) {
      if (prefix >= lo && prefix <= hi) {
        zone = z;
        break;
      }
    }
  }
  const z = zone ?? config.defaultClimateZone;
  return { zone: z, label: config.climateZones[String(z)].label, fromZip: zone !== null };
}
