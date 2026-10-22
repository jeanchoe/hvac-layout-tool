import type { Room, Wall } from '../types';
import type { Exposure } from './floors';
import { defaultConfig, type ClimateInfo, type EngineConfig, type ResolvedDesign } from './config';
import { polygonArea } from './geometry';

/** One line of a room's load, e.g. "Windows (sun)". */
export interface LoadLine {
  key: 'walls' | 'windowConduction' | 'windowSolar' | 'ceiling' | 'floor' | 'infiltration' | 'people' | 'appliances' | 'ducts';
  label: string;
  btuh: number;
}

export interface RoomLoad {
  roomId: string;
  areaSqFt: number;
  sensibleCoolingBtuh: number;
  latentCoolingBtuh: number;
  /** Sensible + latent. */
  coolingBtuh: number;
  heatingBtuh: number;
  /** Design airflow: the room's share of the blower airflow, by sensible load. */
  requiredCfm: number;
  occupants: number;
  cooling: LoadLine[];
  latent: LoadLine[];
  heating: LoadLine[];
}

export interface LoadInput {
  rooms: Room[];
  walls: Wall[];
  climate: ClimateInfo;
  design: ResolvedDesign;
  config: EngineConfig;
  /** Which parts of each room's ceiling and floor face unconditioned space; default: all of it, ground floor. */
  exposure?: Map<string, Exposure>;
}

/**
 * Anything that turns rooms into per-room loads. v1 ships a simplified heat-transfer method;
 * a real ACCA Manual J implementation can replace it without touching the rest of the engine.
 */
export interface LoadModel {
  name: string;
  estimate(input: LoadInput): RoomLoad[];
}

const LIVING = /living|family|great|den/i;
const KITCHEN = /kitchen/i;

/** People at the cooling peak: bedrooms + 1, placed in living areas by floor area (Manual J convention). */
export function assignOccupants(rooms: Room[]): Map<string, number> {
  const out = new Map<string, number>();
  const fixed = rooms.filter((r) => r.occupants !== undefined);
  for (const r of fixed) out.set(r.id, r.occupants!);
  const total = Math.max(0, rooms.filter((r) => r.isBedroom).length + 1 - fixed.reduce((s, r) => s + r.occupants!, 0));
  const auto = rooms.filter((r) => r.occupants === undefined);
  let hosts = auto.filter((r) => LIVING.test(r.name));
  if (!hosts.length) hosts = auto.filter((r) => /kitchen|dining/i.test(r.name));
  if (!hosts.length && auto.length) hosts = [auto.reduce((a, b) => (polygonArea(b.polygon) > polygonArea(a.polygon) ? b : a))];
  const area = hosts.reduce((s, r) => s + polygonArea(r.polygon), 0) || 1;
  for (const r of auto) out.set(r.id, hosts.includes(r) ? (total * polygonArea(r.polygon)) / area : 0);
  return out;
}

const line = (key: LoadLine['key'], label: string, btuh: number): LoadLine => ({ key, label, btuh: Math.max(0, btuh) });
const sum = (lines: LoadLine[]) => lines.reduce((s, l) => s + l.btuh, 0);

export const simplifiedLoadModel: LoadModel = {
  name: 'Simplified heat-transfer estimate (U×A×ΔT, solar, infiltration, internal gains). Not Manual J.',
  estimate({ rooms, walls, design, config, exposure }) {
    const L = config.loads;
    const v = (k: keyof ResolvedDesign) => design[k].value;
    const dtCool = v('outdoorCoolingF') - v('indoorCoolingF');
    const dtHeat = v('indoorHeatingF') - v('outdoorHeatingF');
    const people = assignOccupants(rooms);

    return rooms.map((room) => {
      const area = polygonArea(room.polygon);
      const h = room.ceilingHeight;
      const roomWalls = walls.filter((w) => w.roomId === room.id);
      const wallById = new Map(roomWalls.map((w) => [w.id, w]));
      const ext = roomWalls.filter((w) => w.exterior);
      const extLength = ext.reduce((s, w) => s + w.length, 0);

      let windowArea = 0;
      let solar = 0;
      for (const win of room.windows) {
        const wall = wallById.get(win.wallId);
        if (!wall) continue;
        const a = win.count * win.width * win.height;
        windowArea += a;
        solar += a * v('windowShgc') * L.solarGainFactor[wall.facing];
      }
      const netWall = Math.max(0, extLength * h - windowArea);
      const infCfm = (v('ach') * area * h) / 60;
      const occ = people.get(room.id) ?? 0;
      const appliances = room.applianceBtuh ?? (KITCHEN.test(room.name) ? L.kitchenApplianceBtuh : 0);
      const exp = exposure?.get(room.id) ?? { level: 0, ceiling: 1, floor: 1 };
      const ceilingArea = area * exp.ceiling;
      const ground = exp.level === 0;
      // Upper floors only lose through the part of the floor with no room below (over a garage or outdoors).
      const floorFactor = ground ? (L.floorTempDifferenceFactor[room.floorType] ?? 0) : L.floorTempDifferenceFactor['over-garage'];
      const floorArea = area * exp.floor;
      const ductF = v('ductLoadFactor');

      const coolingEnvelope = [
        line('walls', 'Walls', netWall * v('wallU') * (dtCool + L.wallSolarTempAdderF)),
        line('windowConduction', 'Windows (conduction)', windowArea * v('windowU') * dtCool),
        line('windowSolar', 'Windows (sun)', solar),
        line('ceiling', 'Ceiling to attic', ceilingArea * v('ceilingU') * (dtCool + L.atticTempAdderF)),
        line('floor', 'Floor', floorArea * v('floorU') * dtCool * floorFactor),
        line('infiltration', 'Air leakage', L.sensibleAirFactor * infCfm * dtCool),
        line('people', `People (${occ.toFixed(1)})`, occ * L.personSensibleBtuh),
        line('appliances', 'Appliances', appliances),
      ];
      const cooling = [...coolingEnvelope, line('ducts', 'Ducts', sum(coolingEnvelope) * ductF)];
      const latent = [line('infiltration', 'Air leakage (moisture)', L.latentAirFactor * infCfm * v('grainsDifference')), line('people', 'People (moisture)', occ * L.personLatentBtuh)];

      const slab = ground && room.floorType === 'slab';
      const floorHeat = slab ? extLength * v('slabF') * dtHeat : floorArea * v('floorU') * dtHeat * floorFactor;
      const heatingEnvelope = [
        line('walls', 'Walls', netWall * v('wallU') * dtHeat),
        line('windowConduction', 'Windows', windowArea * v('windowU') * dtHeat),
        line('ceiling', 'Ceiling to attic', ceilingArea * v('ceilingU') * dtHeat),
        line('floor', slab ? 'Slab edge' : 'Floor', floorHeat),
        line('infiltration', 'Air leakage', L.sensibleAirFactor * infCfm * dtHeat),
      ];
      const heating = [...heatingEnvelope, line('ducts', 'Ducts', sum(heatingEnvelope) * ductF)];

      const sensible = sum(cooling);
      const lat = sum(latent);
      return {
        roomId: room.id,
        areaSqFt: area,
        sensibleCoolingBtuh: sensible,
        latentCoolingBtuh: lat,
        coolingBtuh: sensible + lat,
        heatingBtuh: sum(heating),
        requiredCfm: 0,
        occupants: occ,
        cooling,
        latent,
        heating,
      };
    });
  },
};

/**
 * Splits `total` CFM in proportion to `weights`, as whole numbers that sum exactly. Shares below
 * `min` are raised to it and the rest of the airflow is shared among the others.
 */
export function distribute(total: number, weights: number[], min = 0): number[] {
  const floored = new Set<number>();
  let shares: number[] = [];
  for (let pass = 0; pass <= weights.length; pass++) {
    const free = total - floored.size * min;
    const sum = weights.reduce((s, w, i) => (floored.has(i) ? s : s + w), 0) || 1;
    shares = weights.map((w, i) => (floored.has(i) ? min : (free * w) / sum));
    const low = shares.findIndex((v, i) => !floored.has(i) && v < min);
    if (low < 0 || floored.size + 1 >= weights.length) break;
    shares.forEach((v, i) => v < min && floored.add(i));
  }
  const vals = shares.map((v) => Math.round(v));
  const diff = total - vals.reduce((s, v) => s + v, 0);
  if (vals.length) {
    const i = vals.indexOf(Math.max(...vals));
    vals[i] += diff;
  }
  return vals;
}

/**
 * Gives each room its share of the blower airflow, in proportion to its sensible cooling load,
 * with at least `minCfm` per room (the same split the registers get).
 */
export function assignAirflow(loads: RoomLoad[], blowerCfm: number, minCfm = 0): RoomLoad[] {
  const cfm = distribute(blowerCfm, loads.map((l) => l.sensibleCoolingBtuh), minCfm);
  return loads.map((l, i) => ({ ...l, requiredCfm: cfm[i] }));
}

/** Smallest nominal system size that covers the total (sensible + latent) cooling load. */
export function sizeEquipment(totalCoolingBtuh: number, config: EngineConfig = defaultConfig) {
  const neededTons = totalCoolingBtuh / config.btuhPerTon;
  const tons = config.nominalTons.find((t) => t >= neededTons) ?? Math.ceil(neededTons * 2) / 2;
  return equipmentForTons(tons, config);
}

export function equipmentForTons(tons: number, config: EngineConfig = defaultConfig) {
  return { tons, capacityBtuh: tons * config.btuhPerTon, airflowCfm: tons * config.cfmPerTon };
}
