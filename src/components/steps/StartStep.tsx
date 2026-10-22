import { useState } from 'react';
import { climateForZip } from '../../engine';
import { BUILDING_TYPES, SYSTEM_TYPES } from '../../lib/catalog';
import { SAMPLE_PLANS, buildSampleProject } from '../../samples/plans';
import { renderSamplePlanImage } from '../../samples/renderPlanImage';
import { emptyProject, restoreAutosave, useStore } from '../../state/store';
import { openProjectFromDisk } from '../Header';
import { Button, Field, Panel, TextInput } from '../ui';

function TypeCards<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; enabled: boolean }[]; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            disabled={!o.enabled}
            onClick={() => onChange(o.id)}
            className={`rounded-md border px-3 py-2.5 text-left text-sm transition ${
              active ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-gray-200 hover:border-gray-300'
            } disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400`}
          >
            {o.label}
            {!o.enabled && <span className="mt-0.5 block text-[11px] font-medium uppercase tracking-wide">Coming soon</span>}
          </button>
        );
      })}
    </div>
  );
}

export function StartStep() {
  const project = useStore((s) => s.project);
  const update = useStore((s) => s.update);
  const setStep = useStore((s) => s.setStep);
  const replaceProject = useStore((s) => s.replaceProject);
  const [error, setError] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const climate = climateForZip(project.zipCode);
  const zipValid = /^\d{5}$/.test(project.zipCode);

  const loadSample = (i: number) => {
    const plan = SAMPLE_PLANS[i];
    const project = buildSampleProject(plan);
    replaceProject({ ...project, floors: project.floors.map((f) => ({ ...f, background: renderSamplePlanImage(plan, f.level) })) }, 3);
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-4 py-8 lg:grid-cols-[1fr_320px]">
      <Panel
        title="Project"
        actions={
          project.rooms.length > 0 &&
          (confirmNew ? (
            <span className="flex items-center gap-2 text-xs text-gray-600">
              Discard this project?
              <Button variant="danger" className="!py-1 text-xs" onClick={() => (replaceProject(emptyProject()), setConfirmNew(false))}>
                Discard
              </Button>
              <Button variant="ghost" className="!py-1 text-xs" onClick={() => setConfirmNew(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button variant="ghost" className="!py-1 text-xs" onClick={() => setConfirmNew(true)}>
              New project
            </Button>
          ))
        }
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project name">
              <TextInput value={project.name} onChange={(v) => update((d) => void (d.name = v), { coalesce: 'name' })} />
            </Field>
            <Field
              label="Location (ZIP code)"
              hint={zipValid ? `Climate zone ${climate.zone} · ${climate.label}${climate.fromZip ? '' : ' (default)'}` : 'Used to look up the climate zone.'}
            >
              <TextInput value={project.zipCode} inputMode="numeric" maxLength={5} placeholder="e.g. 27601" onChange={(v) => update((d) => void (d.zipCode = v.replace(/\D/g, '')), { coalesce: 'zip' })} />
            </Field>
          </div>
          <Field label="Building type">
            <TypeCards value={project.buildingType} options={BUILDING_TYPES} onChange={(v) => update((d) => void (d.buildingType = v))} />
          </Field>
          <Field label="System type">
            <TypeCards value={project.systemType} options={SYSTEM_TYPES} onChange={(v) => update((d) => void (d.systemType = v))} />
          </Field>
          <div className="flex items-center justify-between border-t border-gray-100 pt-4">
            <p className="text-xs text-gray-500">v1 supports single-story residential, forced-air ducted systems.</p>
            <Button variant="primary" onClick={() => setStep(1)}>
              Continue →
            </Button>
          </div>
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel title="Open a saved project">
          <Button className="w-full" onClick={async () => setError(await openProjectFromDisk())}>
            Open project file…
          </Button>
          <Button variant="ghost" className="mt-2 w-full text-xs" onClick={() => !restoreAutosave() && setError('No autosaved project in this browser.')}>
            Restore last session
          </Button>
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </Panel>
        <Panel title="Try a sample house">
          <p className="mb-3 text-xs text-gray-500">Pre-traced plans you can take straight to layout.</p>
          <div className="space-y-2">
            {SAMPLE_PLANS.map((plan, i) => (
              <button key={plan.id} onClick={() => loadSample(i)} className="block w-full rounded-md border border-gray-200 px-3 py-2 text-left hover:border-accent">
                <div className="text-sm font-medium">{plan.name}</div>
                <div className="text-xs text-gray-500">{plan.description}</div>
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
