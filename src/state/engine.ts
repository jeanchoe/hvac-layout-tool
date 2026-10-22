import { evaluateAll, type EngineResult } from '../engine';
import type { Project } from '../types';
import { currentFloor, useStore } from './store';

const cache = new WeakMap<Project, Record<string, EngineResult>>();
/** Duration of the most recent engine run, shown in the UI as a live-validation check. */
export let lastEvalMs = 0;

/** Every floor's engine result for a project snapshot, memoised (projects are immutable). */
export function engineResults(project: Project): Record<string, EngineResult> {
  let r = cache.get(project);
  if (!r) {
    const t0 = performance.now();
    r = evaluateAll(project);
    lastEvalMs = performance.now() - t0;
    cache.set(project, r);
  }
  return r;
}

/** Engine result for one floor (the current one by default). */
export function engineResult(project: Project, floorId = currentFloor({ project, floorId: useStore.getState().floorId }).id): EngineResult {
  return engineResults(project)[floorId];
}

/** Engine result for the floor being viewed. */
export function useEngine(): EngineResult {
  const project = useStore((s) => s.project);
  const floor = useStore((s) => currentFloor(s));
  return engineResults(project)[floor.id];
}
