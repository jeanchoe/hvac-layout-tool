import { produce } from 'immer';
import { create } from 'zustand';
import type { BuildingType, Project, SystemType } from '../types';
import { newId } from '../lib/ids';

export const STEPS = ['Start', 'Upload', 'Trace & scale', 'Room details', 'Layout & inspect', 'Export'] as const;
export type StepIndex = 0 | 1 | 2 | 3 | 4 | 5;
export type TraceTool = 'select' | 'scale' | 'draw';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1200;
const AUTOSAVE_KEY = 'hvac-layout-tool:autosave';

export function emptyProject(): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: newId('p'),
    name: 'Untitled project',
    zipCode: '',
    buildingType: 'single-story-residential' satisfies BuildingType,
    systemType: 'forced-air-ducted' satisfies SystemType,
    scalePxPerFt: null,
    scaleLine: null,
    background: null,
    rooms: [],
    layout: null,
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

  update(recipe: (draft: Project) => void, opts?: UpdateOptions): void;
  /** Records the current state as an undo step, before a multi-event edit such as a drag. */
  checkpoint(): void;
  replaceProject(project: Project, step?: StepIndex): void;
  undo(): void;
  redo(): void;
  setStep(step: StepIndex): void;
  select(id: string | null): void;
  setTraceTool(tool: TraceTool): void;
}

function loadAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? (JSON.parse(raw) as Project) : null;
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
    set({ project, past: [], future: [], lastEdit: null, step, selectedId: null });
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
}));

export function restoreAutosave(): boolean {
  const saved = loadAutosave();
  if (!saved || saved.schemaVersion !== 1) return false;
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
