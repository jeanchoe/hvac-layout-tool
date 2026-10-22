import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { centroid, dist, polygonArea } from '../../engine/geometry';
import { newId } from '../../lib/ids';
import { fmtSqFt, parseFeet } from '../../lib/format';
import { sortedFloors } from '../../engine';
import { currentFloor, useStore, type TraceTool } from '../../state/store';
import { FloorTabs } from '../FloorTabs';
import type { Pt, Room } from '../../types';
import { Button, Kbd, inputClass } from '../ui';
import { BLANK_GRID } from './UploadStep';

interface View {
  x: number;
  y: number;
  k: number;
}

type Drag =
  | { kind: 'pending'; sx: number; sy: number; vx: number; vy: number; panning: boolean }
  | { kind: 'vertex'; roomId: string; index: number; moved: boolean }
  | { kind: 'room'; roomId: string; start: Pt; orig: Pt[]; moved: boolean }
  | { kind: 'align'; start: Pt; offset: Pt; rooms: Map<string, Pt[]>; moved: boolean };

const SNAP_PX = 10;

export function newRoom(name: string, polygon: Pt[], floorId: string): Room {
  return { id: newId('r'), floorId, name, polygon, ceilingHeight: 8, floorType: 'slab', isBedroom: false, exteriorOverrides: {}, windows: [], defaultsApplied: false };
}

export function TraceStep() {
  const project = useStore((s) => s.project);
  const update = useStore((s) => s.update);
  const checkpoint = useStore((s) => s.checkpoint);
  const tool = useStore((s) => s.traceTool);
  const setTool = useStore((s) => s.setTraceTool);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setStep = useStore((s) => s.setStep);

  const floor = useStore((s) => currentFloor(s));
  const rooms = project.rooms.filter((r) => r.floorId === floor.id);
  const below = sortedFloors(project.floors).find((f) => f.level === floor.level - 1);
  const belowRooms = below ? project.rooms.filter((r) => r.floorId === below.id) : [];
  const scale = floor.scalePxPerFt;
  const bg = floor.background;
  const off = floor.offsetFt;
  /** Edits this floor inside an update. */
  const floorIn = (d: { floors: typeof project.floors }) => d.floors.find((f) => f.id === floor.id)!;
  const size = bg ? { w: bg.width, h: bg.height } : { w: BLANK_GRID.width, h: BLANK_GRID.height };
  const effectiveTool: TraceTool = !scale && (tool === 'draw' || tool === 'align') ? 'scale' : tool === 'align' && !below ? 'select' : tool;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [scaleDraft, setScaleDraft] = useState<Pt[]>([]);
  const [scaleInput, setScaleInput] = useState('');
  const [ortho, setOrtho] = useState(true);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const drag = useRef<Drag | null>(null);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const k = Math.min(el.clientWidth / size.w, el.clientHeight / size.h) * 0.95;
    setView({ k, x: (el.clientWidth - size.w * k) / 2, y: (el.clientHeight - size.h * k) / 2 });
  }, [size.w, size.h]);
  useLayoutEffect(fit, [fit]);

  const toImg = (e: { clientX: number; clientY: number }): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };
  // Rooms are stored in building feet; this floor's image sits at `off` in that space.
  const ftToPx = (p: Pt): Pt => ({ x: (p.x - off.x) * (scale ?? 1), y: (p.y - off.y) * (scale ?? 1) });
  const pxToFt = (p: Pt): Pt => ({ x: p.x / (scale ?? 1) + off.x, y: p.y / (scale ?? 1) + off.y });

  /** Snaps a point (image px): to existing corners, to right angles from `prev`, and to the grid when there's no image. */
  const snap = (raw: Pt, prev: Pt | null, exclude?: { roomId: string; index: number }): Pt => {
    const tol = SNAP_PX / view.k;
    const corners: Pt[] = [];
    for (const r of [...rooms, ...belowRooms]) r.polygon.forEach((p, i) => (exclude?.roomId === r.id && exclude.index === i ? null : corners.push(ftToPx(p))));
    corners.push(...draft);
    let best: Pt | null = null;
    for (const c of corners) if (dist(c, raw) < tol && (!best || dist(c, raw) < dist(best, raw))) best = c;
    if (best) return best;
    let p = { ...raw };
    if (prev && ortho && !shiftHeld) p = Math.abs(raw.x - prev.x) > Math.abs(raw.y - prev.y) ? { x: raw.x, y: prev.y } : { x: prev.x, y: raw.y };
    // Line up with other corners along the free axis.
    for (const c of corners) {
      if ((!prev || p.y === prev.y || !ortho) && Math.abs(c.x - p.x) < tol) p.x = c.x;
      if ((!prev || p.x === prev.x || !ortho) && Math.abs(c.y - p.y) < tol) p.y = c.y;
    }
    if (!bg && scale) {
      const g = scale / 2; // half-foot grid
      p = { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
    }
    return p;
  };

  const closeDraft = () => {
    if (draft.length < 3 || !scale) return;
    const room = newRoom(`Room ${project.rooms.length + 1}`, draft.map(pxToFt), floor.id);
    if (polygonArea(room.polygon) < 4) return;
    update((d) => void d.rooms.push(room));
    setDraft([]);
    select(room.id);
  };

  const applyScale = () => {
    const ft = parseFeet(scaleInput);
    if (!ft || scaleDraft.length !== 2) return;
    const px = dist(scaleDraft[0], scaleDraft[1]);
    if (px < 2) return;
    const next = px / ft;
    update((d) => {
      const fl = floorIn(d);
      // Keep this floor's traced rooms on the same pixels of the image.
      if (fl.scalePxPerFt) {
        const f = fl.scalePxPerFt / next;
        for (const r of d.rooms) if (r.floorId === floor.id) r.polygon = r.polygon.map((p) => ({ x: (p.x - off.x) * f + off.x, y: (p.y - off.y) * f + off.y }));
      }
      fl.scalePxPerFt = next;
      fl.scaleLine = { a: scaleDraft[0], b: scaleDraft[1], lengthFt: ft };
    });
    setScaleDraft([]);
    setScaleInput('');
    setTool('draw');
  };

  const onClickCanvas = (p: Pt) => {
    if (effectiveTool === 'draw') {
      if (draft.length >= 3 && dist(p, draft[0]) < SNAP_PX / view.k) return closeDraft();
      const s = snap(p, draft[draft.length - 1] ?? null);
      if (draft.length && dist(s, draft[draft.length - 1]) < 0.5) return;
      setDraft([...draft, s]);
    } else if (effectiveTool === 'scale') {
      if (scaleDraft.length >= 2) setScaleDraft([p]);
      else setScaleDraft([...scaleDraft, scaleDraft.length ? snap(p, scaleDraft[0]) : p]);
    } else {
      select(null);
    }
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      setShiftHeld(e.shiftKey);
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ' ') {
        setSpaceHeld(true);
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        setDraft([]);
        setScaleDraft([]);
      }
      if (e.key === 'Enter') closeDraft();
      if (e.key === 'Backspace' && draft.length) setDraft(draft.slice(0, -1));
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && rooms.some((r) => r.id === selectedId)) {
        update((d) => void (d.rooms = d.rooms.filter((r) => r.id !== selectedId)));
        select(null);
      }
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key === 'v') setTool('select');
        if (e.key === 'd') setTool('draw');
        if (e.key === 's') setTool('scale');
        if (e.key === 'a' && below) setTool('align');
      }
    };
    const up = (e: KeyboardEvent) => {
      setShiftHeld(e.shiftKey);
      if (e.key === ' ') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  const onWheel = (e: React.WheelEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const k = Math.min(20, Math.max(0.05, view.k * Math.exp(-e.deltaY * 0.0015)));
    setView({ k, x: sx - ((sx - view.x) * k) / view.k, y: sy - ((sy - view.y) * k) / view.k });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const panning = e.button === 1 || spaceHeld;
    if (effectiveTool === 'align' && !panning) {
      drag.current = { kind: 'align', start: toImg(e), offset: { ...off }, rooms: new Map(rooms.map((r) => [r.id, r.polygon])), moved: false };
      return;
    }
    drag.current = { kind: 'pending', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, panning };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toImg(e);
    const d = drag.current;
    if (effectiveTool === 'draw') setCursor(snap(p, draft[draft.length - 1] ?? null));
    else if (effectiveTool === 'scale') setCursor(scaleDraft.length === 1 ? snap(p, scaleDraft[0]) : p);
    else setCursor(p);
    if (!d) return;
    if (d.kind === 'pending') {
      if (!d.panning && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.panning = true;
      if (d.panning) setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    } else if (d.kind === 'vertex') {
      if (!d.moved) checkpoint();
      d.moved = true;
      // No right-angle lock here (it would break the other neighbour); corners still line up with each other.
      const s = snap(p, null, { roomId: d.roomId, index: d.index });
      update((draft) => {
        const r = draft.rooms.find((x) => x.id === d.roomId)!;
        r.polygon[d.index] = pxToFt(s);
      }, { history: false });
    } else if (d.kind === 'room') {
      if (!d.moved) checkpoint();
      d.moved = true;
      const delta = { x: (p.x - d.start.x) / (scale ?? 1), y: (p.y - d.start.y) / (scale ?? 1) };
      update((draft) => {
        const r = draft.rooms.find((x) => x.id === d.roomId)!;
        r.polygon = d.orig.map((q) => ({ x: q.x + delta.x, y: q.y + delta.y }));
      }, { history: false });
    } else if (d.kind === 'align') {
      // Slide the floor below's outline over this plan. This floor's rooms stay on their pixels.
      if (!d.moved) checkpoint();
      d.moved = true;
      const delta = { x: -(p.x - d.start.x) / (scale ?? 1), y: -(p.y - d.start.y) / (scale ?? 1) };
      update((draft) => {
        floorIn(draft).offsetFt = { x: d.offset.x + delta.x, y: d.offset.y + delta.y };
        for (const r of draft.rooms) {
          const orig = d.rooms.get(r.id);
          if (orig) r.polygon = orig.map((q) => ({ x: q.x + delta.x, y: q.y + delta.y }));
        }
      }, { history: false });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'pending' && !d.panning) onClickCanvas(toImg(e));
  };

  const k = view.k;
  const stroke = 1.5 / k;
  const scalePreview = scaleDraft.length === 1 && cursor ? [scaleDraft[0], cursor] : scaleDraft.length === 2 ? scaleDraft : null;
  const cursorStyle = spaceHeld ? 'grab' : effectiveTool === 'select' ? 'default' : effectiveTool === 'align' ? 'move' : 'crosshair';

  return (
    <div className="flex h-full min-h-0 flex-col">
    <FloorTabs note={below ? `${below.name} shows as an orange dashed outline.` : undefined} />
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative min-h-[65vh] min-w-0 flex-1 border-r border-gray-200 bg-gray-100">
        <div ref={wrapRef} className="absolute inset-0 overflow-hidden" style={{ cursor: cursorStyle, touchAction: 'none' }} onWheel={onWheel}>
          <svg className="h-full w-full select-none" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => setCursor(null)} onDoubleClick={closeDraft}>
            <defs>
              <pattern id="grid" width={scale ?? 20} height={scale ?? 20} patternUnits="userSpaceOnUse">
                <path d={`M ${scale ?? 20} 0 L 0 0 0 ${scale ?? 20}`} fill="none" stroke="#e5e7eb" strokeWidth={1} />
              </pattern>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
              {bg ? (
                <image href={bg.dataUrl} width={bg.width} height={bg.height} style={{ imageRendering: k > 2 ? 'pixelated' : 'auto' }} />
              ) : (
                <>
                  <rect width={size.w} height={size.h} fill="#fff" />
                  <rect width={size.w} height={size.h} fill="url(#grid)" />
                </>
              )}

              {scale &&
                belowRooms.map((room) => (
                  <g key={`below-${room.id}`} style={{ pointerEvents: 'none' }}>
                    <polygon points={room.polygon.map(ftToPx).map((p) => `${p.x},${p.y}`).join(' ')} fill={effectiveTool === 'align' ? 'rgb(245 158 11 / 0.10)' : 'none'} stroke="#f59e0b" strokeWidth={1.5 / k} strokeDasharray={`${6 / k} ${4 / k}`} />
                  </g>
                ))}
              {scale &&
                rooms.map((room) => {
                  const pts = room.polygon.map(ftToPx);
                  const sel = room.id === selectedId;
                  const c = ftToPx(centroid(room.polygon));
                  return (
                    <g key={room.id}>
                      <polygon
                        points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill={sel ? 'rgb(37 99 235 / 0.22)' : 'rgb(37 99 235 / 0.10)'}
                        stroke="#2563eb"
                        strokeWidth={(sel ? 2.5 : 1.5) / k}
                        style={{ pointerEvents: effectiveTool === 'select' ? 'auto' : 'none', cursor: 'move' }}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || spaceHeld) return;
                          e.stopPropagation();
                          (e.currentTarget.ownerSVGElement as Element).setPointerCapture(e.pointerId);
                          select(room.id);
                          drag.current = { kind: 'room', roomId: room.id, start: toImg(e), orig: room.polygon, moved: false };
                        }}
                      />
                      <text x={c.x} y={c.y + (bg ? 34 / k : 0)} textAnchor="middle" fontSize={12 / k} fontWeight={600} fill="#1e3a8a" style={{ pointerEvents: 'none', paintOrder: 'stroke' }} stroke="#fff" strokeWidth={3 / k}>
                        {room.name}
                      </text>
                      <text x={c.x} y={c.y + (bg ? 48 : 14) / k} textAnchor="middle" fontSize={11 / k} fill="#1e3a8a" style={{ pointerEvents: 'none', paintOrder: 'stroke' }} stroke="#fff" strokeWidth={3 / k}>
                        {fmtSqFt(polygonArea(room.polygon))}
                      </text>
                      {sel &&
                        effectiveTool === 'select' &&
                        pts.map((p, i) => (
                          <circle
                            key={i}
                            cx={p.x}
                            cy={p.y}
                            r={5 / k}
                            fill="#fff"
                            stroke="#2563eb"
                            strokeWidth={2 / k}
                            style={{ cursor: 'grab' }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              (e.currentTarget.ownerSVGElement as Element).setPointerCapture(e.pointerId);
                              drag.current = { kind: 'vertex', roomId: room.id, index: i, moved: false };
                            }}
                          />
                        ))}
                    </g>
                  );
                })}

              {floor.scaleLine && !scaleDraft.length && (
                <g style={{ pointerEvents: 'none' }}>
                  <line x1={floor.scaleLine.a.x} y1={floor.scaleLine.a.y} x2={floor.scaleLine.b.x} y2={floor.scaleLine.b.y} stroke="#f59e0b" strokeWidth={2 / k} strokeDasharray={`${6 / k} ${4 / k}`} />
                  <text x={(floor.scaleLine.a.x + floor.scaleLine.b.x) / 2} y={(floor.scaleLine.a.y + floor.scaleLine.b.y) / 2 - 6 / k} textAnchor="middle" fontSize={11 / k} fill="#b45309">
                    {floor.scaleLine.lengthFt.toFixed(2)} ft
                  </text>
                </g>
              )}

              {scalePreview && (
                <g style={{ pointerEvents: 'none' }}>
                  <line x1={scalePreview[0].x} y1={scalePreview[0].y} x2={scalePreview[1].x} y2={scalePreview[1].y} stroke="#f59e0b" strokeWidth={2.5 / k} />
                  {scalePreview.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={4 / k} fill="#f59e0b" />
                  ))}
                </g>
              )}

              {draft.length > 0 && (
                <g style={{ pointerEvents: 'none' }}>
                  <polyline points={[...draft, ...(cursor ? [cursor] : [])].map((p) => `${p.x},${p.y}`).join(' ')} fill="rgb(37 99 235 / 0.08)" stroke="#2563eb" strokeWidth={2 / k} />
                  {draft.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={(i === 0 ? 6 : 3.5) / k} fill={i === 0 ? '#fff' : '#2563eb'} stroke="#2563eb" strokeWidth={stroke} />
                  ))}
                  {cursor && scale && (
                    <text x={cursor.x + 10 / k} y={cursor.y - 10 / k} fontSize={11 / k} fill="#1e3a8a" stroke="#fff" strokeWidth={3 / k} style={{ paintOrder: 'stroke' }}>
                      {(dist(cursor, draft[draft.length - 1]) / scale).toFixed(1)} ft
                    </text>
                  )}
                </g>
              )}
              {cursor && effectiveTool !== 'select' && <circle cx={cursor.x} cy={cursor.y} r={3 / k} fill="none" stroke="#111827" strokeWidth={1 / k} style={{ pointerEvents: 'none' }} />}
            </g>
          </svg>
        </div>

        <div className="absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
          {(
            [
              ['select', 'Select', 'V'],
              ['scale', 'Set scale', 'S'],
              ['draw', 'Draw room', 'D'],
              ...(below ? ([['align', `Align to ${below.name}`, 'A']] as const) : []),
            ] as const
          ).map(([id, label, key]) => (
            <button
              key={id}
              disabled={(id === 'draw' || id === 'align') && !scale}
              title={id === 'draw' && !scale ? 'Set the scale first' : `${label} (${key})`}
              onClick={() => setTool(id)}
              className={`rounded-md px-3 py-1 text-sm disabled:opacity-40 ${effectiveTool === id ? 'bg-accent text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-gray-200" />
          <label className="flex items-center gap-1.5 px-2 text-xs text-gray-600">
            <input type="checkbox" checked={ortho} onChange={(e) => setOrtho(e.target.checked)} className="accent-[#2563eb]" />
            Right angles
          </label>
          <button className="rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100" onClick={fit} title="Fit to screen">
            ⤢
          </button>
        </div>

        {effectiveTool === 'scale' && scaleDraft.length === 2 && (
          <div className="absolute left-1/2 top-16 w-80 -translate-x-1/2 rounded-lg border border-gray-200 bg-white p-4 shadow-lg">
            <div className="mb-2 text-sm font-medium">How long is this line in real life?</div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                applyScale();
              }}
            >
              <input autoFocus className={inputClass} placeholder={`e.g. 12'6" or 12.5`} value={scaleInput} onChange={(e) => setScaleInput(e.target.value)} />
              <Button type="submit" variant="primary" disabled={!parseFeet(scaleInput)}>
                Set
              </Button>
            </form>
            <p className="mt-2 text-xs text-gray-500">{dist(scaleDraft[0], scaleDraft[1]).toFixed(0)} px on the image</p>
          </div>
        )}
      </div>

      <aside className="flex w-full shrink-0 flex-col bg-white lg:w-80">
        <div className="space-y-3 border-b border-gray-100 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold">Scale</span>
            {scale ? <span className="text-xs text-gray-600">{scale.toFixed(2)} px / ft</span> : <span className="text-xs font-medium text-amber-700">Not set</span>}
          </div>
          <TraceHelp tool={effectiveTool} hasScale={!!scale} drafting={draft.length > 0} belowName={below?.name} />
        </div>
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-sm font-semibold">Rooms ({rooms.length})</span>
          <span className="text-xs text-gray-500">{fmtSqFt(rooms.reduce((s, r) => s + polygonArea(r.polygon), 0))}</span>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2">
          {rooms.map((room) => (
            <li key={room.id} className={`group mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 ${room.id === selectedId ? 'bg-accent-soft' : 'hover:bg-gray-50'}`} onClick={() => select(room.id)}>
              <input
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-gray-200 focus:border-accent focus:bg-white focus:outline-none"
                value={room.name}
                autoFocus={room.id === selectedId && /^Room \d+$/.test(room.name)}
                onFocus={(e) => e.target.select()}
                onChange={(e) => update((d) => void (d.rooms.find((r) => r.id === room.id)!.name = e.target.value), { coalesce: `name-${room.id}` })}
              />
              <span className="shrink-0 text-xs tabular-nums text-gray-500">{Math.round(polygonArea(room.polygon))} ft²</span>
              <button
                title="Delete room"
                className="shrink-0 text-gray-300 hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  update((d) => void (d.rooms = d.rooms.filter((r) => r.id !== room.id)));
                }}
              >
                ✕
              </button>
            </li>
          ))}
          {rooms.length === 0 && <li className="px-2 py-4 text-xs text-gray-500">No rooms yet. Use “Draw room” to click around each room’s corners.</li>}
        </ul>
        <div className="border-t border-gray-100 p-4">
          <Button variant="primary" className="w-full" disabled={!project.rooms.length} onClick={() => setStep(3)}>
            Continue to room details →
          </Button>
        </div>
      </aside>
    </div>
    </div>
  );
}

function TraceHelp({ tool, hasScale, drafting, belowName }: { tool: TraceTool; hasScale: boolean; drafting: boolean; belowName?: string }) {
  const lines: React.ReactNode[] =
    tool === 'align'
      ? [`Drag to slide ${belowName}'s outline (orange, dashed) until it lines up with this plan's outside walls or stairs.`, 'Rooms on this floor stay where they are on the image.']
      : tool === 'scale'
      ? ['Click both ends of a wall or dimension whose length you know, then type its length.', hasScale ? 'Re-setting the scale keeps traced rooms on the image.' : 'You need a scale before drawing rooms.']
      : tool === 'draw'
        ? [
            drafting ? (
              <>
                Click the first corner, press <Kbd>Enter</Kbd> or double-click to close. <Kbd>Backspace</Kbd> undoes a corner, <Kbd>Esc</Kbd> cancels.
              </>
            ) : (
              'Click each corner of a room. Corners snap to right angles and to existing corners.'
            ),
            <>
              Hold <Kbd>Shift</Kbd> for free angles.
            </>,
          ]
        : ['Click a room to select it. Drag the room or its corner handles to adjust.', <>
            <Kbd>Delete</Kbd> removes the selected room.
          </>];
  return (
    <div className="space-y-1.5 rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
      {lines.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
      <p className="text-gray-400">
        Scroll to zoom · drag empty space or hold <Kbd>Space</Kbd> to pan
      </p>
    </div>
  );
}
