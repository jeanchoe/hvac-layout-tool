import type { Room, Wall } from '../types';
import { newId } from './ids';

export const isBedroomName = (name: string) => /bed/i.test(name) && !/bath/i.test(name);

/**
 * Sensible starting values for a freshly traced room, guessed from its name and walls:
 * bedrooms get a return, and exterior walls get typical windows. Everything stays editable.
 */
export function applyRoomDefaults(room: Room, walls: Wall[], makeId: () => string = () => newId('w')): Room {
  const name = room.name.toLowerCase();
  const ext = walls.filter((w) => w.roomId === room.id && w.exterior && w.length >= 6).sort((a, b) => b.length - a.length);
  const noWindows = /closet|hall|pantry|laundry|utility|storage|mud/.test(name);
  const small = /bath|wc|powder/.test(name);
  const big = /living|family|great|kitchen|dining/.test(name);
  const windows: Room['windows'] = [];
  if (!noWindows) {
    for (const wall of small ? ext.slice(0, 1) : ext) {
      windows.push({
        id: makeId(),
        wallId: wall.id,
        count: !small && wall.length >= 14 ? 2 : 1,
        width: small ? 2 : big ? 4 : 3,
        height: small ? 3 : big ? 5 : 4,
      });
    }
  }
  return { ...room, isBedroom: isBedroomName(room.name), windows, defaultsApplied: true };
}
