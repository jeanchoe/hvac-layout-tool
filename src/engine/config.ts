import raw from '../config/engine-config.json';
import zipTable from '../config/zip-climate-zones.json';
import type { DesignInputs, Direction, FloorType, Framing } from '../types';

export interface ZoneDefaults {
  label: string;
  representativeCity: string;
  outdoorCoolingF: number;
  outdoorHeatingF: number;
  grainsDifference: number;
  wallU: number;
  windowU: number;
  windowShgc: number;
  ceilingU: number;
  floorU: number;
  slabF: number;
}

export interface EngineConfig {
  climateZones: Record<string, ZoneDefaults>;
  defaultClimateZone: number;
  loads: {
    indoorCoolingF: number;
    indoorHeatingF: number;
    wallSolarTempAdderF: number;
    atticTempAdderF: number;
    solarGainFactor: Record<Direction, number>;
    ach: number;
    ductLoadFactor: number;
    sensibleAirFactor: number;
    latentAirFactor: number;
    personSensibleBtuh: number;
    personLatentBtuh: number;
    kitchenApplianceBtuh: number;
    floorTempDifferenceFactor: Record<FloorType, number>;
  };
  sources: Record<string, string>;
  cfmPerTon: number;
  btuhPerTon: number;
  nominalTons: number[];
  maxCfmPerSupplyRegister: number;
  /** Smallest airflow worth a register; tiny rooms get at least this much. */
  minCfmPerSupplyRegister: number;
  registerInsetFromWallFt: number;
  minRegisterSpacingFt: number;
  frictionRateInWcPer100Ft: number;
  roundDuctCapacityCfm: { diameterIn: number; maxCfm: number }[];
  branchEfficiency: { lossFreeLengthFt: number; lossPerFtBeyond: number; minEfficiency: number };
  framingDefaults: Framing;
  framing: {
    joistThicknessIn: number;
    ductClearanceIn: number;
    bootWidthIn: number;
    maxAspectRatio: number;
    /** Ceiling joists under an attic (drawn only; attic ducts lie on top of them). */
    atticJoistDepthIn: number;
  };
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

export type DesignKey = keyof DesignInputs;

/** Every load input with the value in use and where it came from. */
export type ResolvedDesign = Record<DesignKey, { value: number; overridden: boolean; source: string }>;

/** Climate-zone defaults for every design input, before project overrides. */
export function designDefaults(climate: ClimateInfo, config: EngineConfig = defaultConfig): Record<DesignKey, { value: number; source: string }> {
  const z = config.climateZones[String(climate.zone)];
  const s = config.sources;
  const zoneNote = `zone ${climate.zone} (${z.representativeCity})`;
  return {
    outdoorCoolingF: { value: z.outdoorCoolingF, source: `${s.designTemps}: ${zoneNote}` },
    outdoorHeatingF: { value: z.outdoorHeatingF, source: `${s.designTemps}: ${zoneNote}` },
    indoorCoolingF: { value: config.loads.indoorCoolingF, source: s.indoorTemps },
    indoorHeatingF: { value: config.loads.indoorHeatingF, source: s.indoorTemps },
    grainsDifference: { value: z.grainsDifference, source: `Typical outdoor-to-indoor moisture difference for ${zoneNote}` },
    wallU: { value: z.wallU, source: `${s.envelopeU}, zone ${climate.zone}` },
    windowU: { value: z.windowU, source: `${s.envelopeU}, zone ${climate.zone}` },
    windowShgc: { value: z.windowShgc, source: `${s.windowShgc}` },
    ceilingU: { value: z.ceilingU, source: `${s.envelopeU}, zone ${climate.zone}` },
    floorU: { value: z.floorU, source: `${s.envelopeU}, zone ${climate.zone}` },
    slabF: { value: z.slabF, source: s.slabF },
    ach: { value: config.loads.ach, source: s.infiltration },
    ductLoadFactor: { value: config.loads.ductLoadFactor, source: s.ducts },
  };
}

export function resolveDesign(climate: ClimateInfo, overrides: DesignInputs = {}, config: EngineConfig = defaultConfig): ResolvedDesign {
  const d = designDefaults(climate, config);
  const out = {} as ResolvedDesign;
  for (const key of Object.keys(d) as DesignKey[]) {
    const o = overrides[key];
    const overridden = typeof o === 'number' && Number.isFinite(o);
    out[key] = overridden ? { value: o, overridden: true, source: 'Entered for this project' } : { ...d[key], overridden: false };
  }
  return out;
}

export const resolveFraming = (framing: Framing | undefined, config: EngineConfig = defaultConfig): Framing => ({ ...config.framingDefaults, ...framing });
