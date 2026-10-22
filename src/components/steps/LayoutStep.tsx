import { useEffect, useState } from 'react';
import { autoUnitCount, branchEfficiency, defaultConfig, systemOf, type EngineResult } from '../../engine';
import { centroid } from '../../engine/geometry';
import { ductSize, fmtBtuh, fmtCfm, fmtFt, fmtInt, fmtSqFt } from '../../lib/format';
import { engineResults, lastEvalMs, useEngine } from '../../state/engine';
import { addRegister, assignRoomToSystem, deleteRegister, draggableKind, generateMissingLayouts, rebalance, regenerateLayout, renameSystem, rezone, setAirHandlerTons, setCustomUnit, setFraming, setRegisterCfm, setUnitCount, splitRegister, trunkId } from '../../state/layoutActions';
import { currentFloor, useStore } from '../../state/store';
import { FloorTabs } from '../FloorTabs';
import type { Framing, Layout, Project } from '../../types';
import { COLORS, PlanView, zoneColor } from '../PlanView';
import { Scene3D, type ViewRequest, type WallMode } from '../Scene3D';
import { Button, EstimateBadge, NumberInput, Stat } from '../ui';

export function LayoutStep() {
  const project = useStore((s) => s.project);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setStep = useStore((s) => s.setStep);
  const result = useEngine();
  const floor = useStore((s) => currentFloor(s));
  const systems = project.layouts[floor.id];
  const multiFloor = project.floors.length > 1;
  const [floorView, setFloorView] = useState<'this' | 'all'>('this');
  const [mode, setMode] = useState<'3d' | 'plan'>('3d');
  const [wallMode, setWallMode] = useState<WallMode>('cutaway');
  const [showLabels, setShowLabels] = useState(true);
  const [showFraming, setShowFraming] = useState(true);
  const [viewRequest, setViewRequest] = useState<ViewRequest>({ kind: 'reset', nonce: 0 });

  // Every floor with rooms gets a starting layout the first time this step opens.
  useEffect(() => {
    generateMissingLayouts();
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

  if (!systems?.length) {
    const hasRooms = project.rooms.some((r) => r.floorId === floor.id);
    return (
      <div className="flex h-full flex-col">
        <FloorTabs />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-gray-500">
          {hasRooms ? `No layout for ${floor.name} yet.` : `${floor.name} has no rooms yet. Trace them first.`}
          {hasRooms && (
            <Button variant="primary" onClick={() => regenerateLayout(false)}>
              Generate starting layout
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
    <FloorTabs note={multiFloor ? `Each floor has its own units and zones. Editing ${floor.name}.` : undefined} />
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative min-h-[65vh] min-w-0 flex-1">
        {mode === '3d' ? (
          <Scene3D project={project} results={engineResults(project)} floorId={floor.id} floorView={multiFloor ? floorView : 'this'} selectedId={selectedId} wallMode={wallMode} showLabels={showLabels} showFraming={showFraming} viewRequest={viewRequest} />
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
          <span className="mx-1 h-5 w-px bg-gray-200" />
          <select
            aria-label="Where the ducts run"
            className="rounded-md bg-transparent px-1 py-1 text-xs font-medium text-gray-800"
            value={result.framing.ductSpace}
            onChange={(e) => setFraming({ ductSpace: e.target.value as Framing['ductSpace'] })}
          >
            <option value="attic">Ducts: in attic</option>
            <option value="joist-bays">Ducts: between joists</option>
            <option value="plenum">Ducts: ceiling plenum (around beams)</option>
          </select>
          {mode === '3d' && (
            <>
              {multiFloor && (
                <>
                  <span className="mx-1 h-5 w-px bg-gray-200" />
                  <select aria-label="Floors shown" className="rounded-md bg-transparent px-1 py-1 text-xs text-gray-700" value={floorView} onChange={(e) => setFloorView(e.target.value as 'this' | 'all')}>
                    <option value="this">Show: {floor.name} only</option>
                    <option value="all">Show: all floors</option>
                  </select>
                </>
              )}
              <span className="mx-1 h-5 w-px bg-gray-200" />
              <select className="rounded-md bg-transparent px-1 py-1 text-xs text-gray-700" value={wallMode} onChange={(e) => setWallMode(e.target.value as WallMode)}>
                <option value="cutaway">Walls: cutaway</option>
                <option value="full">Walls: full height</option>
                <option value="hidden">Walls: hidden</option>
              </select>
              <label className="flex items-center gap-1 px-2 text-xs text-gray-700">
                <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="accent-[#2563eb]" /> Labels
              </label>
              <label className="flex items-center gap-1 px-2 text-xs text-gray-700">
                <input type="checkbox" checked={showFraming} onChange={(e) => setShowFraming(e.target.checked)} className="accent-[#2563eb]" /> Framing
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
            Rooms or framing changed since this layout was generated.
            <Button variant="primary" className="!py-1" onClick={() => regenerateLayout(false)}>
              Regenerate
            </Button>
          </div>
        )}

        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col items-start gap-2">
          <div className="rounded-md bg-white/90 px-3 py-1.5 text-xs text-gray-500 shadow-sm ring-1 ring-gray-200">
            {mode === '3d' ? 'Left-drag to orbit · right-drag to pan · scroll to zoom · ' : ''}Click to inspect · drag registers, units or trunks to move them
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
      {item(COLORS.supply, 'Supply')}
      {item(COLORS.return, 'Return', true)}
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
  const systems = project.layouts[result.floorId] ?? [];
  const select = useStore((s) => s.select);
  const multi = systems.length > 1;
  const registers = systems.flatMap((s) => s.registers);
  const roomName = (id: string) => project.rooms.find((r) => r.id === id)?.name ?? '—';

  const room = result.rooms.find((r) => r.id === selectedId);
  if (room) {
    const load = result.loads.find((l) => l.roomId === room.id)!;
    const air = result.airflow[room.id];
    const regs = registers.filter((r) => r.roomId === room.id);
    const c = centroid(room.polygon);
    const servedBy = result.systems.find((s) => s.roomIds.includes(room.id));
    return (
      <Section title="Room" actions={<CloseBtn />}>
        <div className="mb-2 text-base font-semibold">{room.name}</div>
        <Row label="Area">{fmtSqFt(load.areaSqFt)}</Row>
        <Row label="Cooling load">{fmtBtuh(load.coolingBtuh)}</Row>
        <Row label="Heating load">{fmtBtuh(load.heatingBtuh)}</Row>
        <Row label="Airflow needed">{fmtCfm(air?.required ?? 0)}</Row>
        <Row label="Airflow delivered">{fmtCfm(air?.delivered ?? 0)}</Row>
        {multi && (
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <span className="text-gray-500">Served by</span>
            <select className="rounded-md border border-gray-300 px-2 py-1 text-sm" value={servedBy?.id ?? ''} onChange={(e) => assignRoomToSystem(room.id, e.target.value)}>
              {systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
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

  const reg = registers.find((r) => r.id === selectedId);
  if (reg) {
    const duct = result.ducts.find((d) => d.registerId === reg.id);
    return (
      <Section title={reg.kind === 'supply' ? 'Supply register' : 'Return grille'} actions={<CloseBtn />}>
        <Row label="Room">{roomName(reg.roomId)}</Row>
        {multi && <Row label="Unit">{systemOf(systems, reg.id)?.name}</Row>}
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="text-gray-500">Design airflow</span>
          <NumberInput className="w-32" value={reg.targetCfm} min={0} max={2000} step={5} suffix="CFM" onChange={(v) => setRegisterCfm(reg.id, v)} />
        </div>
        {duct && (
          <>
            <Row label={reg.kind === 'supply' ? 'Branch' : 'Return duct'}>
              {ductSize(duct)} · {fmtFt(duct.length)}
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

  const unitSys = selectedId?.startsWith('ahu:') ? systemOf(systems, selectedId) : undefined;
  if (unitSys) return <UnitPanel project={project} result={result} sys={unitSys} />;

  const trunkSys = selectedId?.endsWith('/trunk') ? systemOf(systems, selectedId) : undefined;
  if (trunkSys) {
    const segs = result.ducts.filter((d) => d.type === 'trunk' && d.side === 'supply' && d.id.startsWith(`${trunkSys.id}/`));
    return (
      <Section title={multi ? `Supply trunk · ${trunkSys.name}` : 'Supply trunk'} actions={<CloseBtn />}>
        {result.framing.ductSpace !== 'plenum' && <Row label="Runs">{trunkSys.trunk.axis === 'x' ? 'East–west' : 'North–south'}</Row>}
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
                <td className="py-1">{d.id.endsWith('/trunk-stub') ? 'Plenum drop' : `#${i + 1}`}</td>
                <td className="text-right">{fmtInt(d.cfm)}</td>
                <td className="text-right">{d.shape === 'rect' ? `${d.widthIn}×${d.heightIn}"` : `${d.diameter}"`}</td>
                <td className="text-right">{d.length.toFixed(1)} ft</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-gray-500">{result.framing.ductSpace === 'plenum' ? 'Mains are routed around the beams automatically; move the unit or registers to change them.' : 'Drag the trunk to move it; branches re-route automatically.'}</p>
      </Section>
    );
  }

  const duct = result.ducts.find((d) => d.id === selectedId);
  if (duct) {
    return (
      <Section title={`${duct.side === 'supply' ? 'Supply' : 'Return'} ${duct.type}`} actions={<CloseBtn />}>
        <Row label="Airflow">{fmtCfm(duct.cfm)}</Row>
        <Row label="Size">{ductSize(duct)}</Row>
        {duct.shape === 'rect' && <Row label="Round equivalent">{duct.diameter}"</Row>}
        {duct.maxHeightIn !== undefined && <Row label="Space available">{duct.maxHeightIn}" deep</Row>}
        {!duct.fits && <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-danger">No duct shape of this size fits here.</p>}
        <Row label="Length">{fmtFt(duct.length)}</Row>
        {duct.registerId && (
          <button className="mt-2 text-xs text-accent hover:underline" onClick={() => select(duct.registerId!)}>
            Select its {duct.side === 'supply' ? 'register' : 'grille'}
          </button>
        )}
      </Section>
    );
  }

  const floor = project.floors.find((f) => f.id === result.floorId);
  const auto = autoUnitCount(result.totals.coolingBtuh);
  const tons = systems.reduce((t, s) => t + s.airHandler.tons, 0);
  const supplyCount = registers.filter((r) => r.kind === 'supply').length;
  return (
    <Section title="Layout summary">
      <div className="grid grid-cols-2 gap-3">
        <Stat label={multi ? `${systems.length} units` : 'System'} value={`${+tons.toFixed(1)} ton`} sub={fmtCfm(systems.reduce((t, s) => t + s.airHandler.airflowCfm, 0))} />
        <Stat label="Cooling load" value={fmtBtuh(result.totals.coolingBtuh)} sub={`Heating ${fmtBtuh(result.totals.heatingBtuh)}`} />
        <Stat label="Duct length" value={fmtFt(result.score?.ductLength ?? 0)} sub={`${result.score?.fittings ?? 0} fittings`} />
        <Stat label="Registers" value={`${supplyCount} supply`} sub={`${registers.length - supplyCount} return`} />
      </div>
      <p className="mt-3 text-xs text-gray-500">
        {fmtSqFt(result.totals.areaSqFt)} · climate zone {result.climate.zone}. Click any component to inspect it.
      </p>

      <div className="mt-4 flex items-center justify-between gap-3 text-sm">
        <span className="text-gray-500">Units on this floor</span>
        <select
          aria-label="Units on this floor"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          value={floor?.unitCount ?? 'auto'}
          onChange={(e) => setUnitCount(e.target.value === 'auto' ? undefined : Number(e.target.value))}
        >
          <option value="auto">Automatic ({auto})</option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <ul className="mt-2 space-y-1">
        {result.systems.map((s) => {
          const sys = systems.find((x) => x.id === s.id)!;
          const under = sys.airHandler.capacityBtuh < s.totals.coolingBtuh;
          return (
            <li key={s.id}>
              <button onClick={() => select(sys.airHandler.id)} className="flex w-full items-center justify-between gap-2 rounded-md border border-gray-200 px-2.5 py-1.5 text-left text-sm hover:bg-gray-50">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: zoneColor(result.systems.indexOf(s)) }} />
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs text-gray-500">
                    {s.roomIds.length} room{s.roomIds.length === 1 ? '' : 's'}
                  </span>
                </span>
                <span className={`tabular-nums text-xs ${under ? 'text-danger' : 'text-gray-600'}`}>
                  {sys.airHandler.tons} ton · {fmtBtuh(s.totals.coolingBtuh)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex gap-2">
        <Button className="flex-1 text-xs" onClick={() => regenerateLayout(false)}>
          Regenerate
        </Button>
        {multi && (
          <Button className="flex-1 text-xs" onClick={() => rezone()}>
            Re-zone
          </Button>
        )}
        <Button className="flex-1 text-xs" onClick={() => rebalance()}>
          Rebalance airflow
        </Button>
      </div>
      <FramingPanel framing={result.framing} />
    </Section>
  );
}

function UnitPanel({ project, result, sys }: { project: Project; result: EngineResult; sys: Layout }) {
  const select = useStore((s) => s.select);
  const info = result.systems.find((s) => s.id === sys.id);
  const ahu = sys.airHandler;
  const nominal = defaultConfig.nominalTons.includes(ahu.tons) && ahu.capacityBtuh === ahu.tons * 12000;
  const [custom, setCustom] = useState(!nominal);
  const supplyTotal = sys.registers.filter((r) => r.kind === 'supply').reduce((s, r) => s + r.targetCfm, 0);
  const returnTotal = sys.registers.filter((r) => r.kind === 'return').reduce((s, r) => s + r.targetCfm, 0);
  const rooms = project.rooms.filter((r) => info?.roomIds.includes(r.id));
  return (
    <Section title="Main unit" actions={<CloseBtn />}>
      <div className="flex items-center justify-between gap-3 py-1 text-sm">
        <span className="text-gray-500">Tag</span>
        <input className="w-32 rounded-md border border-gray-300 px-2 py-1 text-right text-sm" value={sys.name} onChange={(e) => renameSystem(sys.id, e.target.value)} />
      </div>
      <div className="flex items-center justify-between gap-3 py-1 text-sm">
        <span className="text-gray-500">Size</span>
        <select
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          value={custom ? 'custom' : ahu.tons}
          onChange={(e) => {
            if (e.target.value === 'custom') return setCustom(true);
            setCustom(false);
            setAirHandlerTons(sys.id, Number(e.target.value));
          }}
        >
          {defaultConfig.nominalTons.map((t) => (
            <option key={t} value={t}>
              {t} ton{t === info?.recommended.tons ? ' (recommended)' : ''}
            </option>
          ))}
          <option value="custom">Custom unit…</option>
        </select>
      </div>
      {custom ? (
        <>
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <span className="text-gray-500">Rated capacity</span>
            <NumberInput className="w-36" value={ahu.capacityBtuh} min={6000} max={600000} step={500} suffix="BTU/h" onChange={(v) => setCustomUnit(sys.id, { capacityBtuh: v })} />
          </div>
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <span className="text-gray-500">Rated airflow</span>
            <NumberInput className="w-36" value={ahu.airflowCfm} min={200} max={20000} step={25} suffix="CFM" onChange={(v) => setCustomUnit(sys.id, { airflowCfm: v })} />
          </div>
        </>
      ) : (
        <>
          <Row label="Capacity">{fmtBtuh(ahu.capacityBtuh)}</Row>
          <Row label="Airflow">{fmtCfm(ahu.airflowCfm)}</Row>
        </>
      )}
      {info && (
        <Row label="Zone load">
          <span className={ahu.capacityBtuh < info.totals.coolingBtuh ? 'text-danger' : ''}>{fmtBtuh(info.totals.coolingBtuh)}</span>
        </Row>
      )}
      <Row label="Supply registers total">{fmtCfm(supplyTotal)}</Row>
      <Row label="Returns total">{fmtCfm(returnTotal)}</Row>
      <Row label="Position">
        {ahu.position.x.toFixed(1)}, {ahu.position.y.toFixed(1)} ft
      </Row>
      <div className="mt-2 text-xs text-gray-500">Zone: {rooms.map((r) => r.name).join(', ') || '—'}</div>
      <Button className="mt-3 w-full text-xs" onClick={() => rebalance(sys.id)}>
        Rebalance registers to {fmtCfm(ahu.airflowCfm)}
      </Button>
      <Button variant="ghost" className="mt-1 w-full text-xs" onClick={() => regenerateLayout(true)}>
        Re-route from the units' current spots
      </Button>
      <button className="mt-1 w-full text-xs text-accent hover:underline" onClick={() => select(trunkId(sys.id))}>
        Show its supply trunk
      </button>
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
            <li key={w.id} className="rounded-md border border-red-100 bg-red-50/60 hover:border-red-200">
              <button onClick={() => select(w.componentIds.find((id) => !id.startsWith('ahu:')) ?? w.componentIds[0])} className="flex w-full gap-2 px-3 py-2 text-left text-sm">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${w.severity === 'error' ? 'bg-danger' : 'bg-amber-500'}`} />
                <span className="text-gray-800">{w.message}</span>
              </button>
              {w.fix?.kind === 'split-register' && (
                <div className="px-3 pb-2 pl-7">
                  <Button className="!py-1 text-xs" onClick={() => splitRegister(w.fix!.registerId, w.fix!.parts)}>
                    Split into {w.fix.parts} {w.componentIds.some((id) => /(^|\/)return-/.test(id)) ? 'grilles' : 'registers'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const DEPTHS: { value: number; label: string }[] = [
  { value: 5.5, label: '2×6 (5½")' },
  { value: 7.25, label: '2×8 (7¼")' },
  { value: 9.25, label: '2×10 (9¼")' },
  { value: 11.25, label: '2×12 (11¼")' },
  { value: 11.875, label: 'I-joist 11⅞"' },
  { value: 14, label: 'I-joist 14"' },
  { value: 16, label: 'I-joist 16"' },
];

/** Where ducts run, and the joists they must fit between. */
function FramingPanel({ framing }: { framing: Framing }) {
  const joists = framing.ductSpace === 'joist-bays';
  const beamCount = useStore((s) => (s.project.beams ?? []).filter((b) => b.floorId === currentFloor(s).id).length);
  const floor = useStore((s) => currentFloor(s));
  const multi = useStore((s) => s.project.floors.length > 1);
  const field = 'rounded-md border border-gray-300 bg-white px-2 py-1 text-sm';
  return (
    <div className="mt-4 border-t border-gray-100 pt-4">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Duct space & framing</h4>
      <div className="flex items-center justify-between gap-3 py-1 text-sm">
        <label htmlFor="duct-space" className="text-gray-500">Ducts on {multi ? floor.name : 'this floor'} run</label>
        <select id="duct-space" className={field} value={framing.ductSpace} onChange={(e) => setFraming({ ductSpace: e.target.value as Framing['ductSpace'] })}>
          <option value="attic">In the attic, over the framing</option>
          <option value="joist-bays">Between joists</option>
          <option value="plenum">In a ceiling plenum, around beams</option>
        </select>
      </div>
      {joists ? (
        <>
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <label htmlFor="joist-dir" className="text-gray-500">Joists run</label>
            <select id="joist-dir" className={field} value={framing.joistDirection} onChange={(e) => setFraming({ joistDirection: e.target.value as Framing['joistDirection'] })}>
              <option value="y">North–south</option>
              <option value="x">East–west</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <label htmlFor="joist-spacing" className="text-gray-500">Spacing</label>
            <select id="joist-spacing" className={field} value={framing.spacingIn} onChange={(e) => setFraming({ spacingIn: Number(e.target.value) })}>
              {[12, 16, 19.2, 24].map((v) => (
                <option key={v} value={v}>
                  {v}" on centre
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <label htmlFor="joist-depth" className="text-gray-500">Joist depth</label>
            <select id="joist-depth" className={field} value={framing.depthIn} onChange={(e) => setFraming({ depthIn: Number(e.target.value) })}>
              {(DEPTHS.some((d) => d.value === framing.depthIn) ? DEPTHS : [...DEPTHS, { value: framing.depthIn, label: `${framing.depthIn}"` }]).map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <label htmlFor="soffit-depth" className="text-gray-500">Trunk soffit, max depth</label>
            <NumberInput className="w-24" value={framing.soffitDepthIn} min={4} max={36} step={1} suffix="in" onChange={(v) => setFraming({ soffitDepthIn: v })} />
          </div>
          <p className="mt-2 text-xs text-gray-500">
            {multi && 'Joist sizes apply to every floor. '}The trunk crosses the joists in a dropped soffit. Each branch runs along the joists inside one bay and turns rectangular when a round duct is too deep.
          </p>
        </>
      ) : framing.ductSpace === 'plenum' ? (
        <>
          <div className="flex items-center justify-between gap-3 py-1 text-sm">
            <label htmlFor="plenum-depth" className="text-gray-500">Plenum depth (ceiling to deck)</label>
            <NumberInput className="w-24" value={framing.plenumDepthIn} min={8} max={120} step={1} suffix="in" onChange={(v) => setFraming({ plenumDepthIn: v })} />
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {beamCount
              ? `Ducts are routed by the shortest practical path from the unit to each diffuser, around ${beamCount} beam${beamCount > 1 ? 's' : ''}: never across a main beam, and under a secondary beam only where the duct fits below it.`
              : 'Ducts are routed by the shortest practical path from the unit to each diffuser. Draw beams and equipment areas in Trace & scale and the routing avoids them.'}
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-gray-500">Flex branches lie over the ceiling framing, so they take the shortest route. Switch to “Between joists” for floor or ceiling cavities.</p>
      )}
    </div>
  );
}
