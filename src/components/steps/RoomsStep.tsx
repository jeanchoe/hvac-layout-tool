import { useEffect } from 'react';
import { deriveWalls } from '../../engine';
import { polygonArea } from '../../engine/geometry';
import { newId } from '../../lib/ids';
import { fmtSqFt } from '../../lib/format';
import { applyRoomDefaults } from '../../lib/roomDefaults';
import { useEngine } from '../../state/engine';
import { useStore } from '../../state/store';
import type { FloorType, Room, Wall } from '../../types';
import { BuildingAssumptions, LoadBreakdown } from '../LoadPanels';
import { PlanView } from '../PlanView';
import { Button, Field, NumberInput, OptionalNumberInput, Select, TextInput } from '../ui';

/** Selection id for the project-wide assumptions panel. */
const BUILDING = '__building__';

const FLOOR_TYPES: { id: FloorType; label: string }[] = [
  { id: 'slab', label: 'Slab on grade' },
  { id: 'crawlspace', label: 'Over crawlspace' },
  { id: 'basement', label: 'Over basement' },
  { id: 'over-garage', label: 'Over garage' },
];

export function RoomsStep() {
  const project = useStore((s) => s.project);
  const update = useStore((s) => s.update);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setStep = useStore((s) => s.setStep);
  const result = useEngine();

  // Prefill sensible defaults for rooms that haven't had them yet (one undo step).
  useEffect(() => {
    const { project: p, update: u } = useStore.getState();
    if (p.rooms.every((r) => r.defaultsApplied)) return;
    const walls = deriveWalls(p.rooms);
    u((d) => {
      d.rooms = d.rooms.map((r) => (r.defaultsApplied ? r : applyRoomDefaults(r, walls)));
    });
  }, []);

  const showBuilding = selectedId === BUILDING;
  const room = project.rooms.find((r) => r.id === selectedId) ?? project.rooms[0];
  useEffect(() => {
    if (!showBuilding && room && room.id !== selectedId) select(room.id);
  }, [room, selectedId, select, showBuilding]);

  const editRoom = (fn: (r: Room) => void, coalesce?: string) =>
    update(
      (d) => {
        const r = d.rooms.find((x) => x.id === room.id);
        if (r) fn(r);
      },
      coalesce ? { coalesce: `${coalesce}-${room.id}` } : undefined,
    );

  if (!room) return <div className="p-8 text-sm text-gray-500">No rooms yet. Go back and trace some rooms.</div>;
  const walls = result.walls.filter((w) => w.roomId === room.id);
  const load = result.loads.find((l) => l.roomId === room.id);

  const toggleExterior = (w: Wall) =>
    editRoom((r) => {
      const next = !w.exterior;
      if (next === w.autoExterior) delete r.exteriorOverrides[w.id];
      else r.exteriorOverrides[w.id] = next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-gray-200 p-2 lg:block lg:w-56 lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <button onClick={() => select(BUILDING)} className={`mb-1 block shrink-0 rounded-md border px-3 py-2 text-left text-sm lg:w-full ${showBuilding ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-gray-200 hover:bg-gray-50'}`}>
          <div>Building assumptions</div>
          <div className="text-xs text-gray-500">Temperatures, insulation, air leakage</div>
        </button>
        {project.rooms.map((r) => (
          <button key={r.id} onClick={() => select(r.id)} className={`mb-0.5 block shrink-0 rounded-md px-3 py-2 text-left text-sm lg:w-full ${!showBuilding && r.id === room.id ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-gray-50'}`}>
            <div className="truncate">{r.name}</div>
            <div className="text-xs text-gray-500">
              {Math.round(polygonArea(r.polygon))} ft² · {r.ceilingHeight} ft{r.isBedroom ? ' · bedroom' : ''}
            </div>
          </button>
        ))}
      </aside>

      <div className="relative min-h-[55vh] min-w-0 flex-1 bg-white p-4">
        <PlanView project={project} result={result} selectedId={showBuilding ? null : room.id} focusRoomId={showBuilding ? null : room.id} onSelect={(id) => id && project.rooms.some((r) => r.id === id) && select(id)} onWallClick={toggleExterior} className="h-full w-full" />
        <div className="absolute bottom-4 left-4 rounded-md bg-white/90 px-3 py-2 text-xs text-gray-500 shadow-sm ring-1 ring-gray-200">
          Click a wall of the selected room to toggle exterior. <span className="font-semibold text-gray-800">━</span> exterior <span className="text-gray-400">━</span> interior <span className="text-sky-400">━</span> window · North is up
        </div>
      </div>

      <aside className="w-full shrink-0 overflow-y-auto border-t border-gray-200 bg-white lg:w-[380px] lg:border-l lg:border-t-0">
        {showBuilding ? (
          <div className="p-4">
            <BuildingAssumptions result={result} />
          </div>
        ) : (
        <div className="space-y-4 p-4">
          <Field label="Room name">
            <TextInput value={room.name} onChange={(v) => editRoom((r) => void (r.name = v), 'name')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ceiling height">
              <NumberInput value={room.ceilingHeight} min={7} max={20} step={0.5} suffix="ft" onChange={(v) => editRoom((r) => void (r.ceilingHeight = v), 'ceiling')} />
            </Field>
            <Field label="Floor">
              <Select value={room.floorType} options={FLOOR_TYPES} onChange={(v) => editRoom((r) => void (r.floorType = v))} />
            </Field>
          </div>
          <button className="-mt-2 text-xs text-accent hover:underline" onClick={() => update((d) => d.rooms.forEach((r) => (r.ceilingHeight = room.ceilingHeight)))}>
            Use {room.ceilingHeight} ft ceilings in every room
          </button>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 accent-[#2563eb]" checked={room.isBedroom} onChange={(e) => editRoom((r) => void (r.isBedroom = e.target.checked))} />
            <span>
              Closed-door room (bedroom)
              <span className="block text-xs text-gray-500">Gets its own return grille.</span>
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <Field label="People at peak" hint="Blank = automatic">
              <OptionalNumberInput value={room.occupants} placeholder={Math.round((load?.occupants ?? 0) * 10) / 10} step={0.5} onChange={(v) => editRoom((r) => void (r.occupants = v), 'occ')} />
            </Field>
            <Field label="Appliances" hint="Blank = automatic">
              <OptionalNumberInput value={room.applianceBtuh} placeholder={Math.round(load?.cooling.find((l) => l.key === 'appliances')?.btuh ?? 0)} step={100} suffix="BTU/h" onChange={(v) => editRoom((r) => void (r.applianceBtuh = v), 'appl')} />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h4 className="text-sm font-semibold">Walls & windows</h4>
              <span className="text-xs text-gray-500">{walls.filter((w) => w.exterior).length} exterior</span>
            </div>
            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
              {walls.map((w) => {
                const wins = room.windows.filter((x) => x.wallId === w.id);
                return (
                  <li key={w.id} className="px-3 py-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-5 font-semibold text-accent">{w.facing}</span>
                      <span className="flex-1 tabular-nums text-gray-600">{w.length.toFixed(1)} ft</span>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" className="accent-[#2563eb]" checked={w.exterior} onChange={() => toggleExterior(w)} />
                        Exterior{w.exterior !== w.autoExterior && <span className="text-gray-400">(edited)</span>}
                      </label>
                      <button
                        className="text-xs text-accent hover:underline"
                        onClick={() => editRoom((r) => void r.windows.push({ id: newId('w'), wallId: w.id, count: 1, width: 3, height: 4 }))}
                      >
                        + Window
                      </button>
                    </div>
                    {wins.map((win) => (
                      <div key={win.id} className="mt-2 flex items-center gap-1.5 pl-7 text-xs text-gray-500">
                        <NumberInput className="w-14" value={win.count} min={1} max={20} onChange={(v) => editRoom((r) => void (r.windows.find((x) => x.id === win.id)!.count = v), `wc-${win.id}`)} />
                        <span>×</span>
                        <NumberInput className="w-20" value={win.width} min={0.5} max={30} step={0.5} suffix="w" onChange={(v) => editRoom((r) => void (r.windows.find((x) => x.id === win.id)!.width = v), `ww-${win.id}`)} />
                        <span>×</span>
                        <NumberInput className="w-20" value={win.height} min={0.5} max={15} step={0.5} suffix="h" onChange={(v) => editRoom((r) => void (r.windows.find((x) => x.id === win.id)!.height = v), `wh-${win.id}`)} />
                        <span>ft</span>
                        <button className="ml-auto text-gray-300 hover:text-danger" title="Remove window" onClick={() => editRoom((r) => void (r.windows = r.windows.filter((x) => x.id !== win.id)))}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </li>
                );
              })}
            </ul>
          </div>

          {load && <LoadBreakdown load={load} />}
        </div>
        )}
        <div className="sticky bottom-0 border-t border-gray-100 bg-white p-4">
          <div className="mb-3 flex justify-between text-xs text-gray-500">
            <span>
              {result.rooms.length} rooms · {fmtSqFt(result.totals.areaSqFt)}
            </span>
            <span>Climate zone {result.climate.zone}</span>
          </div>
          <Button variant="primary" className="w-full" onClick={() => setStep(4)}>
            Generate layout →
          </Button>
        </div>
      </aside>
    </div>
  );
}
