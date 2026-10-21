import type { Room, Wall } from '../types';
import { defaultConfig, type ClimateInfo, type EngineConfig } from './config';
import { polygonArea } from './geometry';

export interface RoomLoad {
  roomId: string;
  areaSqFt: number;
  coolingBtuh: number;
  heatingBtuh: number;
  /** Airflow the room needs for its cooling load (CFM). */
  requiredCfm: number;
  breakdown: { base: number; windows: number; walls: number; ceiling: number };
}

export interface LoadInput {
  rooms: Room[];
  walls: Wall[];
  climate: ClimateInfo;
  config: EngineConfig;
}

/**
 * Anything that turns rooms into per-room loads. v1 ships a simplified rule-of-thumb model;
 * a real ACCA Manual J implementation can replace it without touching the rest of the engine.
 */
export interface LoadModel {
  name: string;
  estimate(input: LoadInput): RoomLoad[];
}

export const simplifiedLoadModel: LoadModel = {
  name: 'Simplified area-factor estimate (not Manual J)',
  estimate({ rooms, walls, climate, config }) {
    const zone = config.climateZones[String(climate.zone)];
    return rooms.map((room) => {
      const area = polygonArea(room.polygon);
      const roomWalls = walls.filter((w) => w.roomId === room.id);
      const wallById = new Map(roomWalls.map((w) => [w.id, w]));

      const baseCool = area * zone.coolingBtuhPerSqFt;
      const baseHeat = area * zone.heatingBtuhPerSqFt * (config.floorTypeHeatingMultiplier[room.floorType] ?? 1);

      let windowCool = 0;
      let windowArea = 0;
      for (const win of room.windows) {
        const wall = wallById.get(win.wallId);
        if (!wall) continue;
        const a = win.count * win.width * win.height;
        windowArea += a;
        windowCool += a * config.windowCoolingBtuhPerSqFt[wall.facing];
      }
      const windowHeat = windowArea * config.windowHeatingBtuhPerSqFtPerZone * climate.zone;

      const extWallArea = roomWalls.filter((w) => w.exterior).reduce((s, w) => s + w.length * room.ceilingHeight, 0);
      const netWallArea = Math.max(0, extWallArea - windowArea);
      const wallCool = netWallArea * config.exteriorWallCoolingBtuhPerSqFt;
      const wallHeat = netWallArea * config.exteriorWallHeatingBtuhPerSqFtPerZone * climate.zone;

      const ceilingFactor = Math.max(0, room.ceilingHeight - 8) * config.ceilingHeightFactorPerFtAbove8;
      const ceilingCool = baseCool * ceilingFactor;
      const ceilingHeat = baseHeat * ceilingFactor;

      const coolingBtuh = baseCool + windowCool + wallCool + ceilingCool;
      const heatingBtuh = baseHeat + windowHeat + wallHeat + ceilingHeat;
      return {
        roomId: room.id,
        areaSqFt: area,
        coolingBtuh,
        heatingBtuh,
        requiredCfm: (coolingBtuh / config.btuhPerTon) * config.cfmPerTon,
        breakdown: { base: baseCool, windows: windowCool, walls: wallCool, ceiling: ceilingCool },
      };
    });
  },
};

/** Smallest nominal system size that covers the total cooling load. */
export function sizeEquipment(totalCoolingBtuh: number, config: EngineConfig = defaultConfig) {
  const neededTons = totalCoolingBtuh / config.btuhPerTon;
  const tons = config.nominalTons.find((t) => t >= neededTons) ?? Math.ceil(neededTons * 2) / 2;
  return equipmentForTons(tons, config);
}

export function equipmentForTons(tons: number, config: EngineConfig = defaultConfig) {
  return { tons, capacityBtuh: tons * config.btuhPerTon, airflowCfm: tons * config.cfmPerTon };
}
