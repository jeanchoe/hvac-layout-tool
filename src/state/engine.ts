import { evaluate, type EngineResult } from '../engine';
import type { Project } from '../types';
import { useStore } from './store';

const cache = new WeakMap<Project, EngineResult>();
/** Duration of the most recent engine run, shown in the UI as a live-validation check. */
export let lastEvalMs = 0;

/** Memoised engine result for a project snapshot (projects are immutable). */
export function engineResult(project: Project): EngineResult {
  let r = cache.get(project);
  if (!r) {
    const t0 = performance.now();
    r = evaluate(project);
    lastEvalMs = performance.now() - t0;
    cache.set(project, r);
  }
  return r;
}

export const useEngine = () => engineResult(useStore((s) => s.project));
