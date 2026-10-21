import { useMemo, useRef } from 'react';
import { joistPositions, type EngineResult } from '../engine';
import { bbox, centroid, lerp, outwardNormal } from '../engine/geometry';
import { draggableKind, moveComponent } from '../state/layoutActions';
import { useStore } from '../state/store';
import type { Project, Pt, Wall } from '../types';

export const COLORS = { accent: '#2563eb', return: '#64748b', danger: '#dc2626', wall: '#1f2937', select: '#f59e0b' };

interface Props {
  project: Project;
  result: EngineResult;
  selectedId: string | null;
  onSelect?: (id: string | null) => void;
  showLayout?: boolean;
  /** Enables dragging layout components. */
  editable?: boolean;
  focusRoomId?: string | null;
  onWallClick?: (wall: Wall) => void;
  className?: string;
}

/** Top-down plan in feet: rooms, walls, windows and (optionally) the duct layout. */
export function PlanView({ project, result, selectedId, onSelect, showLayout, editable, focusRoomId, onWallClick, className = '' }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; offset: Pt; moved: boolean } | null>(null);
  const layout = project.layout;
  const warned = useMemo(() => new Set(result.warnings.flatMap((w) => w.componentIds)), [result.warnings]);

  const pts = result.rooms.flatMap((r) => r.polygon);
  const b = pts.length ? bbox(pts) : { minX: 0, minY: 0, width: 40, height: 30 };
  const pad = 4;
  const vb = `${b.minX - pad} ${b.minY - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`;

  const toFt = (e: React.PointerEvent): Pt => {
    const m = svgRef.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  };
  const componentPos = (id: string): Pt | null => {
    if (!layout) return null;
    if (id === 'ahu') return layout.airHandler.position;
    if (draggableKind(id) === 'trunk') return layout.trunk.axis === 'x' ? { x: 0, y: layout.trunk.offset } : { x: layout.trunk.offset, y: 0 };
    return layout.registers.find((r) => r.id === id)?.position ?? null;
  };
  const startDrag = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect?.(id);
    if (!editable || !draggableKind(id)) return;
    svgRef.current!.setPointerCapture(e.pointerId);
    const p = toFt(e);
    const c = componentPos(id)!;
    drag.current = { id, offset: { x: c.x - p.x, y: c.y - p.y }, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) useStore.getState().checkpoint();
    d.moved = true;
    const p = toFt(e);
    moveComponent(d.id, { x: p.x + d.offset.x, y: p.y + d.offset.y });
  };

  const color = (id: string, base: string) => (warned.has(id) ? COLORS.danger : base);
  const sel = (id: string) => id === selectedId || (id.startsWith('trunk') && selectedId?.startsWith('trunk'));

  return (
    <svg
      ref={svgRef}
      viewBox={vb}
      className={`select-none ${className}`}
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
      onPointerDown={() => onSelect?.(null)}
      style={{ touchAction: 'none' }}
    >
      {result.rooms.map((room) => {
        const c = centroid(room.polygon);
        const focus = room.id === focusRoomId || room.id === selectedId;
        return (
          <g key={room.id} onPointerDown={(e) => (e.stopPropagation(), onSelect?.(room.id))} style={{ cursor: onSelect ? 'pointer' : undefined }}>
            <polygon points={room.polygon.map((p) => `${p.x},${p.y}`).join(' ')} fill={focus ? 'rgb(37 99 235 / 0.12)' : warned.has(room.id) ? 'rgb(220 38 38 / 0.06)' : '#fafafa'} />
            <text x={c.x} y={c.y - (showLayout ? 0 : 0.3)} textAnchor="middle" fontSize={0.95} fontWeight={600} fill="#374151" style={{ pointerEvents: 'none' }}>
              {room.name}
            </text>
            {!showLayout && (
              <text x={c.x} y={c.y + 1.1} textAnchor="middle" fontSize={0.8} fill="#6b7280" style={{ pointerEvents: 'none' }}>
                {Math.round(result.loads.find((l) => l.roomId === room.id)?.areaSqFt ?? 0)} sq ft
              </text>
            )}
          </g>
        );
      })}

      {result.walls.map((w) => {
        const room = result.rooms.find((r) => r.id === w.roomId)!;
        const n = outwardNormal(w.start, w.end, room.polygon);
        const showFacing = !showLayout && (w.roomId === focusRoomId || w.roomId === selectedId);
        const mid = lerp(w.start, w.end, 0.5);
        return (
          <g key={w.id}>
            <line
              x1={w.start.x}
              y1={w.start.y}
              x2={w.end.x}
              y2={w.end.y}
              stroke={w.exterior ? COLORS.wall : '#9ca3af'}
              strokeWidth={w.exterior ? 0.45 : 0.2}
              strokeLinecap="square"
            />
            {onWallClick && showFacing && (
              <line x1={w.start.x} y1={w.start.y} x2={w.end.x} y2={w.end.y} stroke="transparent" strokeWidth={1.2} style={{ cursor: 'pointer' }} onPointerDown={(e) => (e.stopPropagation(), onWallClick(w))} />
            )}
            {showFacing && (
              <text x={mid.x - n.x * 1.1} y={mid.y - n.y * 1.1 + 0.3} textAnchor="middle" fontSize={0.8} fontWeight={600} fill={COLORS.accent} style={{ pointerEvents: 'none' }}>
                {w.facing}
              </text>
            )}
          </g>
        );
      })}

      {result.rooms.flatMap((room) =>
        room.windows.flatMap((win) => {
          const w = result.walls.find((x) => x.id === win.wallId);
          if (!w) return [];
          return Array.from({ length: win.count }, (_, k) => {
            const t = (k + 1) / (win.count + 1);
            const half = win.width / 2 / w.length;
            const a = lerp(w.start, w.end, Math.max(0, t - half));
            const c = lerp(w.start, w.end, Math.min(1, t + half));
            return <line key={`${win.id}-${k}`} x1={a.x} y1={a.y} x2={c.x} y2={c.y} stroke="#7dd3fc" strokeWidth={0.3} style={{ pointerEvents: 'none' }} />;
          });
        }),
      )}

      {showLayout && result.grid && (
        <g clipPath="url(#plan-rooms)" style={{ pointerEvents: 'none' }}>
          <clipPath id="plan-rooms">
            {result.rooms.map((r) => (
              <polygon key={r.id} points={r.polygon.map((p) => `${p.x},${p.y}`).join(' ')} />
            ))}
          </clipPath>
          {joistPositions(result.rooms, result.grid).map((c) =>
            result.grid!.framing.joistDirection === 'y' ? (
              <line key={c} x1={c} y1={b.minY} x2={c} y2={b.minY + b.height} stroke="#c8a97a" strokeWidth={0.125} />
            ) : (
              <line key={c} x1={b.minX} y1={c} x2={b.minX + b.width} y2={c} stroke="#c8a97a" strokeWidth={0.125} />
            ),
          )}
        </g>
      )}

      {showLayout && layout && (
        <g>
          {result.ducts.map((d) => {
            const isTrunk = d.type === 'trunk' && d.side === 'supply';
            const base = d.side === 'supply' ? COLORS.accent : COLORS.return;
            const id = isTrunk ? 'trunk' : d.id;
            return (
              <line
                key={d.id}
                x1={d.start.x}
                y1={d.start.y}
                x2={d.end.x}
                y2={d.end.y}
                stroke={sel(d.id) || (isTrunk && sel('trunk')) ? COLORS.select : color(d.id, base)}
                strokeOpacity={d.side === 'return' ? 0.7 : 0.85}
                strokeWidth={Math.max(0.25, (d.shape === 'rect' ? d.widthIn! : d.diameter) / 12)}
                strokeDasharray={d.side === 'return' ? '0.6 0.4' : undefined}
                strokeLinecap={d.shape === 'rect' ? 'butt' : 'round'}
                style={{ cursor: isTrunk && editable ? (layout.trunk.axis === 'x' ? 'ns-resize' : 'ew-resize') : 'pointer' }}
                onPointerDown={startDrag(id)}
              />
            );
          })}
          {layout.registers.map((r) => {
            const s = r.kind === 'supply' ? 1.4 : 1.8;
            const base = r.kind === 'supply' ? COLORS.accent : COLORS.return;
            return (
              <g key={r.id} onPointerDown={startDrag(r.id)} style={{ cursor: editable ? 'move' : 'pointer' }}>
                <rect x={r.position.x - s / 2} y={r.position.y - s / 2} width={s} height={s} rx={0.1} fill={r.kind === 'supply' ? color(r.id, base) : '#fff'} stroke={sel(r.id) ? COLORS.select : color(r.id, base)} strokeWidth={sel(r.id) ? 0.35 : 0.2} />
                {r.kind === 'return' && <path d={`M${r.position.x - s / 3} ${r.position.y - s / 4}h${(2 * s) / 3}M${r.position.x - s / 3} ${r.position.y}h${(2 * s) / 3}M${r.position.x - s / 3} ${r.position.y + s / 4}h${(2 * s) / 3}`} stroke={color(r.id, base)} strokeWidth={0.12} />}
              </g>
            );
          })}
          <g onPointerDown={startDrag('ahu')} style={{ cursor: editable ? 'move' : 'pointer' }}>
            <rect
              x={layout.airHandler.position.x - 1.25}
              y={layout.airHandler.position.y - 1.25}
              width={2.5}
              height={2.5}
              rx={0.2}
              fill="#111827"
              stroke={sel('ahu') ? COLORS.select : color('ahu', '#111827')}
              strokeWidth={0.35}
            />
            <text x={layout.airHandler.position.x} y={layout.airHandler.position.y + 0.3} textAnchor="middle" fontSize={0.75} fontWeight={700} fill="#fff" style={{ pointerEvents: 'none' }}>
              AHU
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
