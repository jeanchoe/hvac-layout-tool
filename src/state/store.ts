import { produce } from 'immer';
import { create } from 'zustand';
import { defaultFloorId, migrateProject, newFloor } from '../engine';
import type { BuildingType, Floor, Project, SystemType } from '../types';
import { newId } from '../lib/ids';

export const STEPS = ['Start', 'Upload', 'Trace & scale', 'Room details', 'Layout & inspect', 'Export'] as const;
export type StepIndex = 0 | 1 | 2 | 3 | 4 | 5;
export type TraceTool = 'select' | 'scale' | 'draw' | 'align' | 'beam' | 'area';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1200;
const AUTOSAVE_KEY = 'hvac-layout-tool:autosave';

export function emptyProject(): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    id: newId('p'),
    name: 'Untitled project',
    zipCode: '',
    buildingType: 'single-story-residential' satisfies BuildingType,
    systemType: 'forced-air-ducted' satisfies SystemType,
    floors: [newFloor('f1', 0)],
    rooms: [],
    layouts: {},
    createdAt: now,
    updatedAt: now,
  };
}

interface UpdateOptions {
  /** Edits with the same key in quick succession share one undo step (e.g. typing). */
  coalesce?: string;
  /** false = don't record history (used while dragging, after a checkpoint). */
  history?: boolean;
}

interface Store {
  project: Project;
  past: Project[];
  future: Project[];
  lastEdit: { key: string; at: number } | null;
  step: StepIndex;
  selectedId: string | null;
  traceTool: TraceTool;
  /** Floor being viewed and edited. */
  floorId: string;

  update(recipe: (draft: Project) => void, opts?: UpdateOptions): void;
  /** Records the current state as an undo step, before a multi-event edit such as a drag. */
  checkpoint(): void;
  replaceProject(project: Project, step?: StepIndex): void;
  undo(): void;
  redo(): void;
  setStep(step: StepIndex): void;
  select(id: string | null): void;
  setTraceTool(tool: TraceTool): void;
  setFloor(floorId: string): void;
}

function loadAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? migrateProject(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export const useStore = create<Store>((set, get) => ({
  project: emptyProject(),
  past: [],
  future: [],
  lastEdit: null,
  step: 0,
  selectedId: null,
  traceTool: 'draw',
  floorId: 'f1',

  update(recipe, opts = {}) {
    const { project, past, lastEdit } = get();
    const next = produce(project, (d) => {
      recipe(d);
      d.updatedAt = new Date().toISOString();
    });
    const now = Date.now();
    const coalesced = !!opts.coalesce && lastEdit?.key === opts.coalesce && now - lastEdit.at < COALESCE_MS;
    const record = opts.history !== false && !coalesced;
    set({
      project: next,
      past: record ? [...past, project].slice(-HISTORY_LIMIT) : past,
      future: [],
      lastEdit: opts.coalesce ? { key: opts.coalesce, at: now } : null,
    });
  },

  checkpoint() {
    const { project, past } = get();
    set({ past: [...past, project].slice(-HISTORY_LIMIT), future: [], lastEdit: null });
  },

  replaceProject(project, step = 0) {
    set({ project, past: [], future: [], lastEdit: null, step, selectedId: null, floorId: defaultFloorId(project) });
  },

  undo() {
    const { past, project, future } = get();
    if (!past.length) return;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], lastEdit: null });
  },

  redo() {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], past: [...past, project], future: future.slice(1), lastEdit: null });
  },

  setStep: (step) => set({ step, selectedId: null }),
  select: (selectedId) => set({ selectedId }),
  setTraceTool: (traceTool) => set({ traceTool }),
  setFloor: (floorId) => set({ floorId, selectedId: null }),
}));

/** The floor being viewed (falls back to the ground floor if the current one was deleted or undone). */
export function currentFloor(s: Pick<Store, 'project' | 'floorId'> = useStore.getState()): Floor {
  return s.project.floors.find((f) => f.id === s.floorId) ?? s.project.floors.find((f) => f.id === defaultFloorId(s.project))!;
}

export const useCurrentFloor = () => useStore((s) => currentFloor(s));

export function restoreAutosave(): boolean {
  const saved = loadAutosave();
  if (!saved) return false;
  useStore.getState().replaceProject(saved, 0);
  return true;
}

// Per-browser convenience only; the real save format is the JSON file.
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(s.project));
    } catch {
      /* storage full or unavailable: ignore */
    }
  }, 500);
});
