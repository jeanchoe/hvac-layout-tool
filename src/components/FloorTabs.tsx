import { useState } from 'react';
import { sortedFloors } from '../engine';
import { addFloor, deleteFloor, updateFloor } from '../state/layoutActions';
import { currentFloor, useStore } from '../state/store';
import { Button, NumberInput } from './ui';

/** Floor switcher shown on every per-floor step. Hidden for single-storey projects. */
export function FloorTabs({ note }: { note?: React.ReactNode }) {
  const project = useStore((s) => s.project);
  const floor = useStore((s) => currentFloor(s));
  const setFloor = useStore((s) => s.setFloor);
  const [settings, setSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const multi = project.buildingType === 'multi-story-residential' || project.floors.length > 1;
  if (!multi) return null;
  const floors = sortedFloors(project.floors);
  const roomCount = (id: string) => project.rooms.filter((r) => r.floorId === id).length;

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      <div className="flex flex-wrap items-center gap-1 px-4 py-1.5">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-gray-500">Floor</span>
        {floors.map((f) => (
          <button
            key={f.id}
            onClick={() => setFloor(f.id)}
            className={`rounded-md px-3 py-1 text-sm ${f.id === floor.id ? 'bg-white font-semibold text-accent shadow-sm ring-1 ring-gray-200' : 'text-gray-600 hover:bg-white'}`}
          >
            {f.name}
            <span className="ml-1.5 text-xs font-normal text-gray-400">{roomCount(f.id)}</span>
          </button>
        ))}
        <Button variant="ghost" className="!py-1 text-xs" onClick={addFloor}>
          + Add floor
        </Button>
        <Button variant="ghost" className="ml-auto !py-1 text-xs" onClick={() => (setSettings(!settings), setConfirmDelete(false))} aria-expanded={settings}>
          {settings ? 'Done' : `${floor.name} settings`}
        </Button>
        {note && <span className="w-full text-xs text-gray-500 sm:w-auto">{note}</span>}
      </div>
      {settings && (
        <div className="flex flex-wrap items-end gap-4 border-t border-gray-200 px-4 py-3">
          <label className="text-xs text-gray-600">
            Name
            <input id="floor-name" className="mt-1 block w-40 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm" value={floor.name} onChange={(e) => updateFloor(floor.id, { name: e.target.value })} />
          </label>
          <label className="text-xs text-gray-600">
            Floor-to-floor height
            <NumberInput className="mt-1 w-28" value={floor.heightFt} min={7} max={30} step={0.5} suffix="ft" onChange={(v) => updateFloor(floor.id, { heightFt: v })} />
          </label>
          <span className="text-xs text-gray-500">Level {floor.level + 1} of {floors.length}</span>
          {floors.length > 1 &&
            (confirmDelete ? (
              <span className="ml-auto flex items-center gap-2 text-xs text-gray-700">
                Delete {floor.name} and its {roomCount(floor.id)} rooms?
                <Button variant="danger" className="!py-1 text-xs" onClick={() => (deleteFloor(floor.id), setConfirmDelete(false), setSettings(false))}>
                  Delete floor
                </Button>
                <Button variant="ghost" className="!py-1 text-xs" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button variant="danger" className="ml-auto !py-1 text-xs" onClick={() => setConfirmDelete(true)}>
                Delete floor…
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
