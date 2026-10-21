import { useState } from 'react';
import { BUILDING_TYPES, SYSTEM_TYPES } from '../lib/catalog';
import { pickFile, readProjectFile, saveProjectFile } from '../lib/fileIO';
import { useStore } from '../state/store';
import { Button, EstimateBadge, Select } from './ui';

export async function openProjectFromDisk(): Promise<string | null> {
  const file = await pickFile('.json,application/json');
  if (!file) return null;
  try {
    const project = await readProjectFile(file);
    useStore.getState().replaceProject(project, project.layout ? 4 : project.rooms.length ? 3 : 0);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function Header() {
  const project = useStore((s) => s.project);
  const update = useStore((s) => s.update);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const [error, setError] = useState<string | null>(null);

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">≋</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">HVAC Layout Tool</div>
            <div className="max-w-[220px] truncate text-xs text-gray-500">{project.name}</div>
          </div>
        </div>
        <EstimateBadge />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            className="!w-auto !py-1 text-xs"
            value={project.buildingType}
            options={BUILDING_TYPES}
            onChange={(v) => update((d) => void (d.buildingType = v))}
          />
          <Select className="!w-auto !py-1 text-xs" value={project.systemType} options={SYSTEM_TYPES} onChange={(v) => update((d) => void (d.systemType = v))} />
          <span className="mx-1 h-5 w-px bg-gray-200" />
          <Button variant="ghost" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
            ↶ Undo
          </Button>
          <Button variant="ghost" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            ↷ Redo
          </Button>
          <span className="mx-1 h-5 w-px bg-gray-200" />
          <Button onClick={async () => setError(await openProjectFromDisk())}>Open…</Button>
          <Button onClick={() => saveProjectFile(project)}>Save</Button>
        </div>
      </div>
      {error && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-1.5 text-center text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </header>
  );
}
