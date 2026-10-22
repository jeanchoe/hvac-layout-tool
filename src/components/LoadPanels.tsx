import { designDefaults, type DesignKey, type EngineResult, type RoomLoad } from '../engine';
import { fmtBtuh, fmtInt, fmtSqFt } from '../lib/format';
import { setDesignInput } from '../state/layoutActions';
import { useStore } from '../state/store';
import { Stat, OptionalNumberInput } from './ui';

function Lines({ title, lines, total }: { title: string; lines: { label: string; btuh: number }[]; total: number }) {
  return (
    <tbody className="tabular-nums">
      <tr>
        <th colSpan={2} className="pt-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </th>
      </tr>
      {lines
        .filter((l) => l.btuh > 0.5)
        .map((l) => (
          <tr key={l.label} className="text-gray-600">
            <td className="py-0.5">{l.label}</td>
            <td className="py-0.5 text-right">{fmtInt(l.btuh)}</td>
          </tr>
        ))}
      <tr className="border-t border-gray-200 font-semibold text-gray-900">
        <td className="py-1">Total</td>
        <td className="py-1 text-right">{fmtBtuh(total)}</td>
      </tr>
    </tbody>
  );
}

/** Line-by-line cooling and heating load for one room. */
export function LoadBreakdown({ load }: { load: RoomLoad }) {
  return (
    <div className="rounded-md bg-gray-50 p-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Cooling" value={fmtInt(load.coolingBtuh)} sub="BTU/h" />
        <Stat label="Heating" value={fmtInt(load.heatingBtuh)} sub="BTU/h" />
        <Stat label="Airflow" value={fmtInt(load.requiredCfm)} sub="CFM" />
      </div>
      <table className="mt-1 w-full text-xs">
        <Lines title="Cooling, sensible" lines={load.cooling} total={load.sensibleCoolingBtuh} />
        <Lines title="Cooling, latent (moisture)" lines={load.latent} total={load.latentCoolingBtuh} />
        <Lines title="Heating" lines={load.heating} total={load.heatingBtuh} />
      </table>
    </div>
  );
}

const GROUPS: { title: string; rows: { key: DesignKey; label: string; suffix: string; step: number; percent?: boolean }[] }[] = [
  {
    title: 'Design conditions',
    rows: [
      { key: 'outdoorCoolingF', label: 'Outdoor, summer', suffix: '°F', step: 1 },
      { key: 'indoorCoolingF', label: 'Indoor, summer', suffix: '°F', step: 1 },
      { key: 'outdoorHeatingF', label: 'Outdoor, winter', suffix: '°F', step: 1 },
      { key: 'indoorHeatingF', label: 'Indoor, winter', suffix: '°F', step: 1 },
      { key: 'grainsDifference', label: 'Moisture difference', suffix: 'gr/lb', step: 1 },
    ],
  },
  {
    title: 'Envelope',
    rows: [
      { key: 'wallU', label: 'Wall U-factor', suffix: 'U', step: 0.001 },
      { key: 'windowU', label: 'Window U-factor', suffix: 'U', step: 0.01 },
      { key: 'windowShgc', label: 'Window SHGC', suffix: '', step: 0.01 },
      { key: 'ceilingU', label: 'Ceiling U-factor', suffix: 'U', step: 0.001 },
      { key: 'floorU', label: 'Floor U-factor', suffix: 'U', step: 0.001 },
      { key: 'slabF', label: 'Slab edge F-factor', suffix: 'F', step: 0.01 },
    ],
  },
  {
    title: 'Air leakage & ducts',
    rows: [
      { key: 'ach', label: 'Infiltration', suffix: 'ACH', step: 0.05 },
      { key: 'ductLoadFactor', label: 'Duct load allowance', suffix: '%', step: 1, percent: true },
    ],
  },
];

/** Project-wide load inputs: climate-zone defaults with their sources, each editable. */
export function BuildingAssumptions({ result }: { result: EngineResult }) {
  const design = useStore((s) => s.project.design) ?? {};
  const defaults = designDefaults(result.climate);
  const t = result.totals;
  const tons = result.recommended.tons;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Building assumptions</h3>
        <p className="mt-1 text-xs text-gray-500">
          Defaults come from climate zone {result.climate.zone} and code-minimum construction. Type a value to override it for this project; clear the field to go back to the default.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-md bg-gray-50 p-3">
        <Stat label="Cooling" value={fmtBtuh(t.coolingBtuh)} sub={`${fmtInt(t.sensibleCoolingBtuh)} sensible + ${fmtInt(t.latentCoolingBtuh)} latent`} />
        <Stat label="Heating" value={fmtBtuh(t.heatingBtuh)} />
        <Stat label="Suggested system" value={`${tons} ton`} sub={`${fmtInt(t.areaSqFt / tons)} sq ft per ton`} />
        <Stat label="Area" value={fmtSqFt(t.areaSqFt)} />
      </div>
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{g.title}</h4>
          <div className="space-y-3">
            {g.rows.map((row) => {
              const k = row.key;
              const scale = row.percent ? 100 : 1;
              const value = design[k];
              const def = defaults[k];
              return (
                <div key={k}>
                  <div className="flex items-center gap-3">
                    <label htmlFor={`design-${k}`} className="flex-1 text-sm text-gray-700">
                      {row.label}
                      {value !== undefined && (
                        <button className="ml-2 text-xs text-accent hover:underline" onClick={() => setDesignInput(k, undefined)}>
                          reset
                        </button>
                      )}
                    </label>
                    <OptionalNumberInput
                      id={`design-${k}`}
                      className="w-32"
                      step={row.step}
                      suffix={row.suffix}
                      placeholder={Math.round(def.value * scale * 1000) / 1000}
                      value={value === undefined ? undefined : Math.round(value * scale * 1000) / 1000}
                      onChange={(v) => setDesignInput(k, v === undefined ? undefined : v / scale)}
                    />
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-gray-400">{value !== undefined ? `Entered for this project (default ${Math.round(def.value * scale * 1000) / 1000}). ` : ''}{def.source}</p>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
