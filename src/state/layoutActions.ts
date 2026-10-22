import { equipmentForTons, generateFloorSystems, newFloor, rebalanceAirflow, resolveFraming, snapToBay, sortedFloors, splitRegister as splitRegisterLayout, systemOf, type DesignKey } from '../engine';
import { newId } from '../lib/ids';
import type { Floor, Framing, Layout, Pt } from '../types';
import { engineResult } from './engine';
import { currentFloor, useStore } from './store';

const snapFt = (v: number) => Math.round(v * 4) / 4;

/** Every layout action works on the floor being viewed. */
const floorId = () => currentFloor().id;
const currentSystems = (): Layout[] => useStore.getState().project.layouts[floorId()] ?? [];

/** Selection id for a system's supply trunk. */
export const trunkId = (systemId: string) => `${systemId}/trunk`;

/** Kinds of layout component a user can drag. */
export function draggableKind(id: string | null): 'ahu' | 'trunk' | 'register' | null {
  if (!id) return null;
  if (id.startsWith('ahu:')) return 'ahu';
  if (id.endsWith('/trunk')) return 'trunk';
  return currentSystems().some((s) => s.registers.some((r) => r.id === id)) ? 'register' : null;
}

/** Moves a layout component during a drag (call `checkpoint()` once when the drag starts). */
export function moveComponent(id: string, p: Pt) {
  const kind = draggableKind(id);
  if (!kind) return;
  let q = { x: snapFt(p.x), y: snapFt(p.y) };
  // In joist bays a register boot has to sit between joists.
  const grid = kind === 'register' ? engineResult(useStore.getState().project).grid : null;
  if (grid) q = snapToBay(q, grid);
  const f = floorId();
  useStore.getState().update(
    (d) => {
      const L = systemOf(d.layouts[f] ?? [], id);
      if (!L) return;
      if (kind === 'ahu') {
        // The trunk runs through the air handler, so it follows it.
        const old = L.airHandler.position;
        L.trunk.offset += L.trunk.axis === 'x' ? q.y - old.y : q.x - old.x;
        L.airHandler.position = q;
      } else if (kind === 'trunk') {
        L.trunk.offset = L.trunk.axis === 'x' ? q.y : q.x;
      } else {
        L.registers.find((r) => r.id === id)!.position = q;
      }
    },
    { history: false },
  );
}

/** Sets one floor's systems (an empty list clears the floor). */
function setSystems(f: string, systems: Layout[]) {
  useStore.getState().update((d) => {
    const next = { ...d.layouts };
    if (systems.length) next[f] = systems;
    else delete next[f];
    d.layouts = next;
  });
}

/** Replaces one system on the floor. */
function replaceSystem(f: string, system: Layout | null) {
  if (!system) return;
  useStore.getState().update((d) => {
    const list = d.layouts[f];
    const i = list?.findIndex((s) => s.id === system.id) ?? -1;
    if (i >= 0) list![i] = system;
  });
}

/** Re-lays out the floor's systems, keeping their zones; `keepUnits` keeps each unit's spot and size. */
export function regenerateLayout(keepUnits: boolean, f = floorId()) {
  setSystems(f, generateFloorSystems(useStore.getState().project, { floorId: f, keepUnits }));
}

/** Splits the floor into zones afresh, one unit each, and lays them out. */
export function rezone(f = floorId()) {
  setSystems(f, generateFloorSystems(useStore.getState().project, { floorId: f, rezone: true }));
}

/** Sets how many units serve the floor (undefined = automatic from the load), then re-zones. */
export function setUnitCount(n: number | undefined) {
  const f = floorId();
  useStore.getState().update((d) => {
    const floor = d.floors.find((x) => x.id === f);
    if (!floor) return;
    if (n === undefined) delete floor.unitCount;
    else floor.unitCount = n;
  });
  rezone(f);
}

/** Generates layouts for every floor that has rooms but no layout yet (one undo step). */
export function generateMissingLayouts() {
  const { project, update } = useStore.getState();
  const missing = project.floors.filter((fl) => !project.layouts[fl.id]?.length && project.rooms.some((r) => r.floorId === fl.id));
  if (!missing.length) return;
  const made = Object.fromEntries(missing.map((fl) => [fl.id, generateFloorSystems(project, { floorId: fl.id })]).filter(([, l]) => l.length));
  update((d) => void (d.layouts = { ...d.layouts, ...made }));
}

function editSystem(systemId: string, fn: (s: Layout) => void, coalesce?: string) {
  const f = floorId();
  useStore.getState().update(
    (d) => {
      const s = d.layouts[f]?.find((x) => x.id === systemId);
      if (s) fn(s);
    },
    coalesce ? { coalesce } : undefined,
  );
}

/** Picks a standard unit size. */
export function setAirHandlerTons(systemId: string, tons: number) {
  editSystem(systemId, (s) => Object.assign(s.airHandler, equipmentForTons(tons)));
}

/** Enters a custom unit: its own rated capacity and airflow. */
export function setCustomUnit(systemId: string, patch: { capacityBtuh?: number; airflowCfm?: number }) {
  editSystem(
    systemId,
    (s) => {
      if (patch.capacityBtuh !== undefined) {
        s.airHandler.capacityBtuh = patch.capacityBtuh;
        s.airHandler.tons = Math.round((patch.capacityBtuh / 12000) * 10) / 10;
      }
      if (patch.airflowCfm !== undefined) s.airHandler.airflowCfm = patch.airflowCfm;
    },
    `unit-${systemId}-${Object.keys(patch).join()}`,
  );
}

export function renameSystem(systemId: string, name: string) {
  editSystem(systemId, (s) => void (s.name = name), `name-${systemId}`);
}

/**
 * Moves a room into another unit's zone. Its registers move with it; zones become explicit lists.
 * Rebalance or regenerate afterwards to resize airflow.
 */
export function assignRoomToSystem(roomId: string, systemId: string) {
  const f = floorId();
  const { project, update } = useStore.getState();
  const floorRooms = project.rooms.filter((r) => r.floorId === f).map((r) => r.id);
  update((d) => {
    const list = d.layouts[f];
    const to = list?.find((s) => s.id === systemId);
    if (!list || !to) return;
    for (const s of list) {
      s.roomIds = (s.roomIds ?? floorRooms).filter((id) => id !== roomId);
      if (s !== to) {
        const moving = s.registers.filter((r) => r.roomId === roomId);
        s.registers = s.registers.filter((r) => r.roomId !== roomId);
        to.registers.push(...moving);
      }
    }
    to.roomIds!.push(roomId);
  });
}

export function rebalance(systemId?: string) {
  const f = floorId();
  const project = useStore.getState().project;
  // One undo step for the whole floor.
  setSystems(f, currentSystems().map((s) => (!systemId || s.id === systemId ? (rebalanceAirflow(project, { floorId: f, systemId: s.id }) ?? s) : s)));
}

/** Splits a register or grille into several in neighbouring bays, sharing its airflow. */
export function splitRegister(id: string, parts: number) {
  const f = floorId();
  replaceSystem(f, splitRegisterLayout(useStore.getState().project, id, parts, { floorId: f }));
  useStore.getState().select(null);
}

export function setRegisterCfm(id: string, cfm: number) {
  const f = floorId();
  useStore.getState().update(
    (d) => {
      const r = systemOf(d.layouts[f] ?? [], id)?.registers.find((x) => x.id === id);
      if (r) r.targetCfm = cfm;
    },
    { coalesce: `cfm-${id}` },
  );
}

export function deleteRegister(id: string) {
  const f = floorId();
  useStore.getState().update((d) => {
    const s = systemOf(d.layouts[f] ?? [], id);
    if (s) s.registers = s.registers.filter((r) => r.id !== id);
  });
  useStore.getState().select(null);
}

/** Adds a register to the system whose zone holds the room. */
export function addRegister(roomId: string, kind: 'supply' | 'return', position: Pt) {
  const f = floorId();
  const id = `${kind === 'supply' ? 's' : 'r'}-${roomId}-${Math.random().toString(36).slice(2, 6)}`;
  useStore.getState().update((d) => {
    const list = d.layouts[f] ?? [];
    const s = list.find((x) => x.roomIds?.includes(roomId)) ?? list.find((x) => !x.roomIds) ?? list[0];
    s?.registers.push({ id, roomId, kind, position, targetCfm: kind === 'supply' ? 75 : 100 });
  });
  useStore.getState().select(id);
}

/** Joist sizes are shared by the building; where ducts run is set per floor. */
export function setFraming(patch: Partial<Framing>) {
  const { ductSpace, ...shared } = patch;
  const f = floorId();
  useStore.getState().update(
    (d) => {
      if (Object.keys(shared).length) d.framing = { ...resolveFraming(d.framing), ...shared };
      if (ductSpace) {
        const floor = d.floors.find((x) => x.id === f)!;
        if (d.floors.length > 1) floor.ductSpace = ductSpace;
        else d.framing = { ...resolveFraming(d.framing), ductSpace };
      }
    },
    { coalesce: `framing-${Object.keys(patch).join()}` },
  );
}

/** Sets one load-calculation input for this project; undefined restores the climate-zone default. */
export function setDesignInput(key: DesignKey, value: number | undefined) {
  useStore.getState().update(
    (d) => {
      const next = { ...d.design };
      if (value === undefined) delete next[key];
      else next[key] = value;
      d.design = next;
    },
    { coalesce: `design-${key}` },
  );
}

/** Adds a floor on top of the building and switches to it. */
export function addFloor() {
  const { project, update, setFloor } = useStore.getState();
  const top = sortedFloors(project.floors).at(-1);
  const level = top ? top.level + 1 : 0;
  // Start the new floor with the same scale and alignment as the one below, so a plan drawn
  // at the same scale lines up straight away.
  const floor: Floor = { ...newFloor(newId('f'), level), scalePxPerFt: top?.scalePxPerFt ?? null, offsetFt: top ? { ...top.offsetFt } : { x: 0, y: 0 } };
  update((d) => {
    d.floors.push(floor);
    if (d.floors.length > 1) d.buildingType = 'multi-story-residential';
  });
  setFloor(floor.id);
}

export function updateFloor(id: string, patch: Partial<Pick<Floor, 'name' | 'heightFt'>>) {
  // An undefined height switches the floor back to the automatic height.
  useStore.getState().update(
    (d) => {
      const f = d.floors.find((x) => x.id === id);
      if (!f) return;
      if (patch.name !== undefined) f.name = patch.name;
      if ('heightFt' in patch) {
        if (patch.heightFt === undefined) delete f.heightFt;
        else f.heightFt = patch.heightFt;
      }
    },
    { coalesce: `floor-${id}-${Object.keys(patch).join()}` },
  );
}

/** Removes a floor with its rooms and layout; floors above move down a level. */
export function deleteFloor(id: string) {
  const { project, update, setFloor } = useStore.getState();
  if (project.floors.length <= 1) return;
  const gone = project.floors.find((f) => f.id === id);
  if (!gone) return;
  update((d) => {
    d.floors = d.floors.filter((f) => f.id !== id).map((f) => (f.level > gone.level ? { ...f, level: f.level - 1 } : f));
    d.rooms = d.rooms.filter((r) => r.floorId !== id);
    const next = { ...d.layouts };
    delete next[id];
    d.layouts = next;
  });
  setFloor(sortedFloors(useStore.getState().project.floors)[0].id);
}
