import { equipmentForTons, generateProjectLayout, rebalanceAirflow, snapToBay, splitRegister as splitRegisterLayout, type DesignKey } from '../engine';
import type { Framing, Pt } from '../types';
import { engineResult } from './engine';
import { useStore } from './store';

const snapFt = (v: number) => Math.round(v * 4) / 4;

/** Kinds of layout component a user can drag. */
export function draggableKind(id: string | null): 'ahu' | 'trunk' | 'register' | null {
  if (!id) return null;
  if (id === 'ahu') return 'ahu';
  if (id === 'trunk' || id.startsWith('trunk-')) return 'trunk';
  const layout = useStore.getState().project.layout;
  return layout?.registers.some((r) => r.id === id) ? 'register' : null;
}

/** Moves a layout component during a drag (call `checkpoint()` once when the drag starts). */
export function moveComponent(id: string, p: Pt) {
  const kind = draggableKind(id);
  if (!kind) return;
  let q = { x: snapFt(p.x), y: snapFt(p.y) };
  // In joist bays a register boot has to sit between joists.
  const grid = kind === 'register' ? engineResult(useStore.getState().project).grid : null;
  if (grid) q = snapToBay(q, grid);
  useStore.getState().update(
    (d) => {
      const L = d.layout!;
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

export function regenerateLayout(keepAirHandler: boolean) {
  const { project, update } = useStore.getState();
  const layout = generateProjectLayout(project, {
    airHandlerPosition: keepAirHandler ? project.layout?.airHandler.position : undefined,
    tons: keepAirHandler ? project.layout?.airHandler.tons : undefined,
  });
  update((d) => void (d.layout = layout));
}

export function setAirHandlerTons(tons: number) {
  useStore.getState().update((d) => {
    if (d.layout) Object.assign(d.layout.airHandler, equipmentForTons(tons));
  });
}

export function rebalance() {
  const { project, update } = useStore.getState();
  const layout = rebalanceAirflow(project);
  update((d) => void (d.layout = layout));
}

/** Splits a register or grille into several in neighbouring bays, sharing its airflow. */
export function splitRegister(id: string, parts: number) {
  const { project, update, select } = useStore.getState();
  const layout = splitRegisterLayout(project, id, parts);
  update((d) => void (d.layout = layout));
  select(null);
}

export function setRegisterCfm(id: string, cfm: number) {
  useStore.getState().update(
    (d) => {
      const r = d.layout?.registers.find((x) => x.id === id);
      if (r) r.targetCfm = cfm;
    },
    { coalesce: `cfm-${id}` },
  );
}

export function deleteRegister(id: string) {
  useStore.getState().update((d) => {
    if (d.layout) d.layout.registers = d.layout.registers.filter((r) => r.id !== id);
  });
  useStore.getState().select(null);
}

export function addRegister(roomId: string, kind: 'supply' | 'return', position: Pt) {
  const id = `${kind === 'supply' ? 's' : 'r'}-${roomId}-${Math.random().toString(36).slice(2, 6)}`;
  useStore.getState().update((d) => void d.layout?.registers.push({ id, roomId, kind, position, targetCfm: kind === 'supply' ? 75 : 100 }));
  useStore.getState().select(id);
}

export function setFraming(patch: Partial<Framing>) {
  useStore.getState().update(
    (d) => {
      d.framing = { ...engineResult(useStore.getState().project).framing, ...patch };
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
