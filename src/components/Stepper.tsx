import { usableRooms } from '../engine';
import { STEPS, useStore, type StepIndex } from '../state/store';

/** Why a step can't be opened yet, or null if it can. */
export function stepBlocker(step: StepIndex, s: ReturnType<typeof useStore.getState>): string | null {
  const p = s.project;
  if (step >= 3 && usableRooms(p.rooms).length === 0) return 'Trace at least one room first.';
  if (step >= 5 && !p.layout) return 'Generate a layout first.';
  return null;
}

export function Stepper() {
  const state = useStore();
  const { step, setStep } = state;
  return (
    <nav className="border-b border-gray-200 bg-white">
      <ol className="mx-auto flex max-w-[1600px] items-center gap-1 overflow-x-auto px-4 py-2">
        {STEPS.map((label, i) => {
          const idx = i as StepIndex;
          const blocker = stepBlocker(idx, state);
          const active = idx === step;
          const done = idx < step;
          return (
            <li key={label} className="flex items-center">
              {i > 0 && <span className="mx-1 h-px w-6 bg-gray-200" />}
              <button
                type="button"
                disabled={!!blocker}
                title={blocker ?? undefined}
                onClick={() => setStep(idx)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  active ? 'bg-accent-soft font-semibold text-accent' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                    active ? 'border-accent bg-accent text-white' : done ? 'border-accent text-accent' : 'border-gray-300 text-gray-500'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
