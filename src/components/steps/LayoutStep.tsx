import { useEffect, useState } from 'react';
import { branchEfficiency, defaultConfig, type EngineResult } from '../../engine';
import { centroid } from '../../engine/geometry';
import { fmtBtuh, fmtCfm, fmtFt, fmtInt, fmtSqFt } from '../../lib/format';
import { lastEvalMs, useEngine } from '../../state/engine';
import { addRegister, deleteRegister, draggableKind, rebalance, regenerateLayout, setAirHandlerTons, setRegisterCfm } from '../../state/layoutActions';
import { useStore } from '../../state/store';
import type { Project } from '../../types';
import { PlanView } from '../PlanView';
import { Scene3D, type ViewRequest, type WallMode } from '../Scene3D';
import { Button, EstimateBadge, NumberInput, Stat } from '../ui';

export function LayoutStep() {
  const project = useStore((s) => s.project);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setStep = useStore((s) => s.setStep);
  const result = useEngine();
  const [mode, setMode] = useState<'3d' | 'plan'>('3d');
  const [wallMode, setWallMode] = useState<WallMode>('cutaway');
  const [showLabels, setShowLabels] = useState(true);
  const [viewRequest, setViewRequest] = useState<ViewRequest>({ kind: 'reset', nonce: 0 });

  useEffect(() => {
    if (!useStore.getState().project.layout) regenerateLayout(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Escape') select(null);
      const id = useStore.getState().selectedId;
      if ((e.key === 'Delete' || e.key === 'Backspace') && draggableKind(id) === 'register') deleteRegister(id!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  if (!project.layout) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-500">
        No layout yet.
        <Button variant="primary" onClick={() => regenerateLayout(false)}>
          Generate starting layout
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="relative min-h-[65vh] min-w-0 flex-1">
        {mode === '3d' ? (
          <Scene3D project={project} result={result} selectedId={selectedId} wallMode={wallMode} showLabels={showLabels} viewRequest={viewRequest} />
        ) : (
          <div className="h-full w-full p-6">
            <PlanView project={project} result={result} selectedId={selectedId} onSelect={select} showLayout editable className="h-full w-full" />
          </div>
        )}

        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-white/95 p-1 shadow-sm">
          {(['3d', 'plan'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-md px-3 py-1 text-sm ${mode === m ? 'bg-accent text-white' : 'text-gray-700 hover:bg-gray-100'}`}>
              {m === '3d' ? '3D' : 'Plan'}
            </button>
          ))}
          {mode === '3d' && (
            <>
              <span className="mx-1 h-5 w-px bg-gray-200" />
              <select className="rounded-md bg-transparent px-1 py-1 text-xs text-gray-700" value={wallMode} onChange={(e) => setWallMode(e.target.value as WallMode)}>
                <option value="cutaway">Walls: cutaway</option>
                <option value="full">Walls: full height</option>
                <option value="hidden">Walls: hidden</option>
              </select>
              <label className="flex items-center gap-1 px-2 text-xs text-gray-700">
                <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="accent-[#2563eb]" /> Labels
              </label>
              <button className="rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100" onClick={() => setViewRequest({ kind: 'reset', nonce: viewRequest.nonce + 1 })}>
                Reset view
              </button>
              <button className="rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100" onClick={() => setViewRequest({ kind: 'top', nonce: viewRequest.nonce + 1 })}>
                Top
              </button>
            </>
          )}
        </div>

        {result.layoutStale && (
          <div className="absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-sm">
            Rooms changed since this layout was generated.
            <Button variant="primary" className="!py-1" onClick={() => regenerateLayout(false)}>
              Regenerate
            </Button>
          </div>
        )}

        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col items-start gap-2">
          <div className="rounded-md bg-white/90 px-3 py-1.5 text-xs text-gray-500 shadow-sm ring-1 ring-gray-200">
            {mode === '3d' ? 'Left-drag to orbit · right-drag to pan · scroll to zoom · ' : ''}Click to inspect · drag registers, the AHU or the trunk to move them
          </div>
          <EstimateBadge />
        </div>
        <Legend />
      </div>

      <aside className="flex w-full shrink-0 flex-col border-t border-gray-200 bg-white lg:w-[360px] lg:border-l lg:border-t-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Properties project={project} result={result} selectedId={selectedId} />
          <Warnings result={result} />
        </div>
        <div className="border-t border-gray-100 p-4">
          <Button variant="primary" className="w-full" onClick={() => setStep(5)}>
            Export report →
          </Button>
        </div>
      </aside>
    </div>
  );
}

function Legend() {
  const item = (color: string, label: string, dashed = false) => (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-1 w-5 rounded" style={{ background: dashed ? `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 8px)` : color }} />
      {label}
    </span>
  );
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 flex gap-3 rounded-md bg-white/90 px-3 py-1.5 text-xs text-gray-600 shadow-sm ring-1 ring-gray-200">
      {item('#2563eb', 'Supply')}
      {item('#64748b', 'Return', true)}
      {item('#dc2626', 'Warning')}
      {item('#f59e0b', 'Selected')}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-right tabular-nums text-gray-900">{children}</span>
    </div>
  );
}

function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="border-b border-gray-100 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Properties({ project, result, selectedId }: { project: Project; result: EngineResult; selectedId: string | null }) {
  const layout = project.layout!;
  const select = useStore((s) => s.select);
  const ahu = layout.airHandler;
  const supplyTotal = layout.registers.filter((r) => r.kind === 'supply').reduce((s, r) => s + r.targetCfm, 0);
  const returnTotal = layout.registers.filter((r) => r.kind === 'return').reduce((s, r) => s + r.targetCfm, 0);
  const roomName = (id: string) => project.rooms.find((r) => r.id === id)?.name ?? '—';

  const room = result.rooms.find((r) => r.id === selectedId);
  if (room) {
    const load = result.loads.find((l) => l.roomId === room.id)!;
    const air = result.airflow[room.id];
    const regs = layout.registers.filter((r) => r.roomId === room.id);
    const c = centroid(room.polygon);
    return (
      <Section title="Room" actions={<CloseBtn />}>
        <div className="mb-2 text-base font-semibold">{room.name}</div>
        <Row label="Area">{fmtSqFt(load.areaSqFt)}</Row>
        <Row label="Cooling load">{fmtBtuh(load.coolingBtuh)}</Row>
        <Row label="Heating load">{fmtBtuh(load.heatingBtuh)}</Row>
        <Row label="Airflow needed">{fmtCfm(air?.required ?? 0)}</Row>
        <Row label="Airflow delivered">{fmtCfm(air?.delivered ?? 0)}</Row>
        <div className="mt-3 space-y-1">
          {regs.map((r) => (
            <button key={r.id} onClick={() => select(r.id)} className="flex w-full justify-between rounded px-2 py-1 text-left text-sm hover:bg-gray-50">
              <span>{r.kind === 'supply' ? 'Supply register' : 'Return grille'}</span>
              <span className="tabular-nums text-gray-500">{fmtCfm(r.targetCfm)}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button className="flex-1 text-xs" onClick={() => addRegister(room.id, 'supply', c)}>
            + Supply
          </Button>
          <Button className="flex-1 text-xs" onClick={() => addRegister(room.id, 'return', { x: c.x + 2, y: c.y })}>
            + Return
          </Button>
        </div>
      </Section>
    );
  }

  const reg = layout.registers.find((r) => r.id === selectedId);
  if (reg) {
    const duct = result.ducts.find((d) => d.registerId === reg.id);
    return (
      <Section title={reg.kind === 'supply' ? 'Supply register' : 'Return grille'} actions={<CloseBtn />}>
        <Row label="Room">{roomName(reg.roomId)}</Row>
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="text-gray-500">Design airflow</span>
          <NumberInput className="w-32" value={reg.targetCfm} min={0} max={2000} step={5} suffix="CFM" onChange={(v) => setRegisterCfm(reg.id, v)} />
        </div>
        {duct && (
          <>
            <Row label={reg.kind === 'supply' ? 'Branch' : 'Return duct'}>
              {duct.diameter}" round · {fmtFt(duct.length)}
            </Row>
            {reg.kind === 'supply' && <Row label="Est. delivered">{fmtCfm(reg.targetCfm * branchEfficiency(duct.length))}</Row>}
          </>
        )}
        <Row label="Position">
          {reg.position.x.toFixed(1)}, {reg.position.y.toFixed(1)} ft
        </Row>
        <Button variant="danger" className="mt-3 w-full text-xs" onClick={() => deleteRegister(reg.id)}>
          Delete {reg.kind === 'supply' ? 'register' : 'grille'}
        </Button>
      </Section>
    );
  }

  if (selectedId === 'ahu') {
    return (
      <Section title="Air handler" actions={<CloseBtn />}>
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="text-gray-500">Size</span>
          <select className="rounded-md border border-gray-300 px-2 py-1 text-sm" value={ahu.tons} onChange={(e) => setAirHandlerTons(Number(e.target.value))}>
            {defaultConfig.nominalTons.map((t) => (
              <option key={t} value={t}>
                {t} ton{t === result.recommended.tons ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
        </div>
        <Row label="Capacity">{fmtBtuh(ahu.capacityBtuh)}</Row>
        <Row label="Airflow">{fmtCfm(ahu.airflowCfm)}</Row>
        <Row label="Supply registers total">{fmtCfm(supplyTotal)}</Row>
        <Row label="Returns total">{fmtCfm(returnTotal)}</Row>
        <Row label="Position">
          {ahu.position.x.toFixed(1)}, {ahu.position.y.toFixed(1)} ft
        </Row>
        <Button className="mt-3 w-full text-xs" onClick={rebalance}>
          Rebalance registers to {fmtCfm(ahu.airflowCfm)}
        </Button>
        <Button variant="ghost" className="mt-1 w-full text-xs" onClick={() => regenerateLayout(true)}>
          Re-route everything from this spot
        </Button>
      </Section>
    );
  }

  if (selectedId?.startsWith('trunk')) {
    const segs = result.ducts.filter((d) => d.type === 'trunk' && d.side === 'supply');
    return (
      <Section title="Supply trunk" actions={<CloseBtn />}>
        <Row label="Runs">{layout.trunk.axis === 'x' ? 'East–west' : 'North–south'}</Row>
        <Row label="Total length">{fmtFt(segs.reduce((s, d) => s + d.length, 0))}</Row>
        <table className="mt-2 w-full text-xs">
          <thead className="text-left text-gray-500">
            <tr>
              <th className="font-medium">Segment</th>
              <th className="text-right font-medium">CFM</th>
              <th className="text-right font-medium">Size</th>
              <th className="text-right font-medium">Length</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {segs.map((d, i) => (
              <tr key={d.id} className="border-t border-gray-100">
                <td className="py-1">{d.id === 'trunk-stub' ? 'Plenum drop' : `#${i + 1}`}</td>
                <td className="text-right">{fmtInt(d.cfm)}</td>
                <td className="text-right">{d.diameter}"</td>
                <td className="text-right">{d.length.toFixed(1)} ft</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-gray-500">Drag the trunk to move it; branches re-route automatically.</p>
      </Section>
    );
  }

  const duct = result.ducts.find((d) => d.id === selectedId);
  if (duct) {
    return (
      <Section title={`${duct.side === 'supply' ? 'Supply' : 'Return'} ${duct.type}`} actions={<CloseBtn />}>
        <Row label="Airflow">{fmtCfm(duct.cfm)}</Row>
        <Row label="Size">{duct.diameter}" round</Row>
        <Row label="Length">{fmtFt(duct.length)}</Row>
        {duct.registerId && (
          <button className="mt-2 text-xs text-accent hover:underline" onClick={() => select(duct.registerId!)}>
            Select its {duct.side === 'supply' ? 'register' : 'grille'}
          </button>
        )}
      </Section>
    );
  }

  return (
    <Section title="Layout summary">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="System" value={`${ahu.tons} ton`} sub={fmtCfm(ahu.airflowCfm)} />
        <Stat label="Cooling load" value={fmtBtuh(result.totals.coolingBtuh)} sub={`Heating ${fmtBtuh(result.totals.heatingBtuh)}`} />
        <Stat label="Duct length" value={fmtFt(result.score?.ductLength ?? 0)} sub={`${result.score?.fittings ?? 0} fittings`} />
        <Stat label="Registers" value={`${layout.registers.filter((r) => r.kind === 'supply').length} supply`} sub={`${layout.registers.filter((r) => r.kind === 'return').length} return`} />
      </div>
      <p className="mt-3 text-xs text-gray-500">
        {fmtSqFt(result.totals.areaSqFt)} · climate zone {result.climate.zone}. Click any component to inspect it.
      </p>
      <div className="mt-3 flex gap-2">
        <Button className="flex-1 text-xs" onClick={() => regenerateLayout(false)}>
          Regenerate
        </Button>
        <Button className="flex-1 text-xs" onClick={rebalance}>
          Rebalance airflow
        </Button>
      </div>
    </Section>
  );
}

function CloseBtn() {
  const select = useStore((s) => s.select);
  return (
    <button className="text-xs text-gray-400 hover:text-gray-700" onClick={() => select(null)}>
      ✕
    </button>
  );
}

function Warnings({ result }: { result: EngineResult }) {
  const select = useStore((s) => s.select);
  const ws = result.warnings;
  return (
    <Section
      title={`Warnings (${ws.length})`}
      actions={<span className="text-[11px] text-gray-400">checked in {lastEvalMs.toFixed(1)} ms</span>}
    >
      {ws.length === 0 ? (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">All checks pass.</p>
      ) : (
        <ul className="space-y-1.5">
          {ws.map((w) => (
            <li key={w.id}>
              <button onClick={() => select(w.componentIds.find((id) => id !== 'ahu') ?? w.componentIds[0])} className="flex w-full gap-2 rounded-md border border-red-100 bg-red-50/60 px-3 py-2 text-left text-sm hover:border-red-200">
                <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${w.severity === 'error' ? 'bg-danger' : 'bg-amber-500'}`} />
                <span className="text-gray-800">{w.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
