import { Html, Line, OrbitControls } from '@react-three/drei';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { joistPositions, type EngineResult, type JoistGrid } from '../engine';
import { bbox, centroid, dist } from '../engine/geometry';
import { draggableKind, moveComponent } from '../state/layoutActions';
import { useStore } from '../state/store';
import type { DuctSegment, Project, Pt, Room } from '../types';
import { COLORS } from './PlanView';

export type WallMode = 'cutaway' | 'full' | 'hidden';
export interface ViewRequest {
  kind: 'reset' | 'top';
  nonce: number;
}

interface SceneProps {
  project: Project;
  result: EngineResult;
  selectedId: string | null;
  wallMode: WallMode;
  showLabels: boolean;
  viewRequest: ViewRequest;
}

const AHU_SIZE = { w: 2.5, h: 4.5, d: 2.5 };

export function Scene3D(props: SceneProps) {
  const select = useStore((s) => s.select);
  const down = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className="h-full w-full"
      onPointerDownCapture={(e) => (down.current = { x: e.clientX, y: e.clientY })}
    >
      <Canvas
        camera={{ fov: 40, near: 0.5, far: 2000, position: [0, 60, 60] }}
        dpr={[1, 2]}
        onPointerMissed={(e) => {
          if (down.current && Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) < 4) select(null);
        }}
      >
        <color attach="background" args={['#ffffff']} />
        <ambientLight intensity={1.6} />
        <directionalLight position={[40, 80, 30]} intensity={1.4} />
        <directionalLight position={[-30, 40, -40]} intensity={0.5} />
        <SceneContent {...props} />
      </Canvas>
    </div>
  );
}

function SceneContent({ project, result, selectedId, wallMode, showLabels, viewRequest }: SceneProps) {
  const layout = project.layout;
  const select = useStore((s) => s.select);
  const warned = useMemo(() => new Set(result.warnings.flatMap((w) => w.componentIds)), [result.warnings]);
  const pts = result.rooms.flatMap((r) => r.polygon);
  const b = pts.length ? bbox(pts) : { minX: 0, minY: 0, maxX: 40, maxY: 30, width: 40, height: 30 };
  const center = new THREE.Vector3(b.minX + b.width / 2, 0, b.minY + b.height / 2);
  const maxCeiling = Math.max(8, ...result.rooms.map((r) => r.ceilingHeight));
  const roomById = new Map(result.rooms.map((r) => [r.id, r]));
  const grid = result.grid;
  // Attic: ducts lie above the ceiling. Joist bays: branches sit inside the joist depth and the
  // trunks hang below the joists in a soffit.
  const ductY = grid ? maxCeiling + grid.framing.depthIn / 24 : maxCeiling + 0.9;
  const returnY = grid ? ductY : ductY + 0.9;
  const ductHeight = (d: DuctSegment) => {
    if (!grid || d.type === 'branch') return d.side === 'return' ? returnY : ductY;
    return maxCeiling - (d.shape === 'rect' ? d.heightIn! : d.diameter) / 24;
  };
  const plenumTop = grid ? maxCeiling + grid.framing.depthIn / 12 + 0.5 : ductY + 2;

  const isSel = (id: string) => id === selectedId || (id.startsWith('trunk') && !!selectedId?.startsWith('trunk'));
  const colorFor = (id: string, base: string) => (isSel(id) ? COLORS.select : warned.has(id) ? COLORS.danger : base);

  return (
    <>
      <CameraRig center={center} span={Math.max(b.width, b.height)} request={viewRequest} />

      {/* Ground */}
      <mesh rotation-x={-Math.PI / 2} position={[center.x, -0.05, center.z]}>
        <planeGeometry args={[b.width + 60, b.height + 60]} />
        <meshBasicMaterial color="#f8fafc" />
      </mesh>

      {result.rooms.map((room) => (
        <RoomFloor key={room.id} id={room.id} polygon={room.polygon} selected={room.id === selectedId} warned={warned.has(room.id)} onSelect={() => select(room.id)} />
      ))}

      {wallMode !== 'hidden' &&
        result.walls
          .filter((w) => !w.sharedWithRoomId || w.roomId < w.sharedWithRoomId)
          .map((w) => {
            const room = roomById.get(w.roomId)!;
            const h = wallMode === 'cutaway' ? 3 : room.ceilingHeight;
            const ang = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x);
            return (
              <mesh key={w.id} position={[(w.start.x + w.end.x) / 2, h / 2, (w.start.y + w.end.y) / 2]} rotation-y={-ang} raycast={() => null}>
                <boxGeometry args={[w.length + (w.exterior ? 0.4 : 0), h, w.exterior ? 0.4 : 0.25]} />
                <meshStandardMaterial color={w.exterior ? '#cbd5e1' : '#e2e8f0'} transparent opacity={wallMode === 'full' ? 0.35 : 0.9} depthWrite={wallMode !== 'full'} />
              </mesh>
            );
          })}

      {grid && <Joists rooms={result.rooms} grid={grid} ceiling={maxCeiling} />}

      {showLabels &&
        result.rooms.map((room) => {
          const c = centroid(room.polygon);
          return (
            <Html key={room.id} position={[c.x, 0.1, c.y]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
              <div className="whitespace-nowrap rounded bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-gray-700 shadow-sm">{room.name}</div>
            </Html>
          );
        })}

      {layout && (
        <>
          {result.ducts.map((d) => {
            const isTrunk = d.type === 'trunk' && d.side === 'supply';
            const y = ductHeight(d);
            const id = isTrunk ? 'trunk' : d.id;
            return (
              <Draggable key={d.id} id={id} height={y} project={project}>
                <Duct duct={d} y={y} color={colorFor(isTrunk ? 'trunk' : d.id, d.side === 'supply' ? COLORS.accent : COLORS.return)} highlight={warned.has(d.id)} />
              </Draggable>
            );
          })}

          {layout.registers.map((r) => {
            const room = roomById.get(r.roomId);
            const ceil = room?.ceilingHeight ?? 8;
            const top = r.kind === 'return' ? returnY : ductY;
            const color = colorFor(r.id, r.kind === 'supply' ? COLORS.accent : COLORS.return);
            const size = r.kind === 'supply' ? [1.2, 0.12, 0.8] : [1.8, 0.12, 1.4];
            return (
              <Draggable key={r.id} id={r.id} height={ceil} project={project}>
                <group position={[r.position.x, 0, r.position.y]}>
                  <mesh position={[0, ceil, 0]}>
                    <boxGeometry args={size as [number, number, number]} />
                    <meshStandardMaterial color={color} emissive={color} emissiveIntensity={isSel(r.id) ? 0.5 : 0.15} />
                  </mesh>
                  {/* Boot up to the duct run */}
                  <mesh position={[0, (ceil + top) / 2, 0]}>
                    <cylinderGeometry args={[0.22, 0.3, top - ceil, 12]} />
                    <meshStandardMaterial color={color} transparent opacity={0.6} />
                  </mesh>
                  {/* Air direction cue */}
                  <mesh position={[0, ceil - 0.6, 0]} rotation-x={r.kind === 'supply' ? Math.PI : 0}>
                    <coneGeometry args={[0.25, 0.6, 12]} />
                    <meshBasicMaterial color={color} transparent opacity={0.45} />
                  </mesh>
                </group>
              </Draggable>
            );
          })}

          <Draggable id="ahu" height={AHU_SIZE.h} project={project}>
            <group position={[layout.airHandler.position.x, 0, layout.airHandler.position.y]}>
              <mesh position={[0, AHU_SIZE.h / 2, 0]}>
                <boxGeometry args={[AHU_SIZE.w, AHU_SIZE.h, AHU_SIZE.d]} />
                <meshStandardMaterial color={colorFor('ahu', '#334155')} emissive={isSel('ahu') ? COLORS.select : '#000'} emissiveIntensity={0.3} />
              </mesh>
              {/* Plenum rises above the duct runs so the unit stays easy to grab from any angle. */}
              <mesh position={[0, (AHU_SIZE.h + plenumTop) / 2, 0]}>
                <boxGeometry args={[2, plenumTop - AHU_SIZE.h, 2]} />
                <meshStandardMaterial color={isSel('ahu') ? COLORS.select : '#94a3b8'} />
              </mesh>
              {showLabels && (
                <Html position={[0, plenumTop + 0.6, 0]} center style={{ pointerEvents: 'none' }}>
                  <div className="whitespace-nowrap rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">AHU {layout.airHandler.tons} t</div>
                </Html>
              )}
            </group>
          </Draggable>
        </>
      )}

      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI / 2.05} />
    </>
  );
}

function CameraRig({ center, span, request }: { center: THREE.Vector3; span: number; request: ViewRequest }) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!controls) return;
    const d = span * 1.05 + 10;
    if (request.kind === 'top') camera.position.set(center.x, d * 1.4, center.z + 0.01);
    else camera.position.set(center.x + d * 0.35, d * 0.85, center.z + d * 0.95);
    controls.target.copy(center);
    controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, request.nonce]);
  return null;
}

function RoomFloor({ id, polygon, selected, warned, onSelect }: { id: string; polygon: Pt[]; selected: boolean; warned: boolean; onSelect: () => void }) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    polygon.forEach((p, i) => (i === 0 ? s.moveTo(p.x, -p.y) : s.lineTo(p.x, -p.y)));
    s.closePath();
    return s;
  }, [polygon]);
  const outline = useMemo(() => [...polygon, polygon[0]].map((p) => [p.x, 0.03, p.y] as [number, number, number]), [polygon]);
  return (
    <group>
      <mesh
        name={id}
        rotation-x={-Math.PI / 2}
        onClick={(e) => {
          if (e.delta > 4) return;
          e.stopPropagation();
          onSelect();
        }}
      >
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color={selected ? '#dbeafe' : warned ? '#fee2e2' : '#ffffff'} side={THREE.DoubleSide} />
      </mesh>
      <Line points={outline} color={selected ? COLORS.accent : '#94a3b8'} lineWidth={selected ? 2 : 1} />
    </group>
  );
}

function Duct({ duct, y, color, highlight }: { duct: DuctSegment; y: number; color: string; highlight: boolean }) {
  const { start: a, end: b } = duct;
  const len = dist(a, b);
  const rect = duct.shape === 'rect';
  const radius = Math.max(0.2, duct.diameter / 24);
  const { position, quaternion, angle } = useMemo(() => {
    const dir = new THREE.Vector3(b.x - a.x, 0, b.y - a.y).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.lengthSq() ? dir : new THREE.Vector3(1, 0, 0));
    return { position: new THREE.Vector3((a.x + b.x) / 2, y, (a.y + b.y) / 2), quaternion: q, angle: -Math.atan2(b.y - a.y, b.x - a.x) };
  }, [a.x, a.y, b.x, b.y, y]);
  if (len < 0.01) return null;
  const material = <meshStandardMaterial color={color} emissive={highlight ? COLORS.danger : '#000'} emissiveIntensity={0.25} metalness={0.2} roughness={0.5} />;
  if (rect) {
    return (
      <mesh position={position} rotation-y={angle}>
        <boxGeometry args={[len, duct.heightIn! / 12, duct.widthIn! / 12]} />
        {material}
      </mesh>
    );
  }
  return (
    <group>
      <mesh position={position} quaternion={quaternion}>
        <cylinderGeometry args={[radius, radius, len, 16]} />
        {material}
      </mesh>
      <mesh position={[b.x, y, b.y]}>
        <sphereGeometry args={[radius, 12, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
}

/** Where a joist line (fixed across-joist coordinate `c`) runs inside a room, as [from, to] along the joists. */
function joistSpans(c: number, poly: Pt[], dir: 'x' | 'y'): [number, number][] {
  const hits: number[] = [];
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const [pa, qa, pb, qb] = dir === 'y' ? [p.x, q.x, p.y, q.y] : [p.y, q.y, p.x, q.x];
    if (pa > c !== qa > c) hits.push(pb + ((c - pa) / (qa - pa)) * (qb - pb));
  });
  hits.sort((m, n) => m - n);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  return out;
}

/** Ceiling joists above the rooms, so ducts read as sitting between them. */
function Joists({ rooms, grid, ceiling }: { rooms: Room[]; grid: JoistGrid; ceiling: number }) {
  const dir = grid.framing.joistDirection;
  const depth = grid.framing.depthIn / 12;
  const thick = 1.5 / 12;
  const spans = useMemo(
    () =>
      joistPositions(rooms, grid).flatMap((c) =>
        rooms.flatMap((r) => joistSpans(c, r.polygon, dir).map(([from, to]) => ({ c, from, to }))),
      ),
    [rooms, grid, dir],
  );
  return (
    <group>
      {spans.map(({ c, from, to }, i) => {
        const mid = (from + to) / 2;
        const len = to - from;
        return (
          <mesh key={i} position={dir === 'y' ? [c, ceiling + depth / 2, mid] : [mid, ceiling + depth / 2, c]} raycast={() => null}>
            <boxGeometry args={dir === 'y' ? [thick, depth, len] : [len, depth, thick]} />
            <meshStandardMaterial color="#d6b98c" transparent opacity={0.75} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Click to inspect; drag (for movable components) along a horizontal plane at `height`. */
function Draggable({ id, height, project, children }: { id: string; height: number; project: Project; children: React.ReactNode }) {
  const select = useStore((s) => s.select);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const drag = useRef<{ plane: THREE.Plane; offset: Pt; moved: boolean } | null>(null);
  const hit = (e: ThreeEvent<PointerEvent>, plane: THREE.Plane) => {
    const v = new THREE.Vector3();
    return e.ray.intersectPlane(plane, v) ? { x: v.x, y: v.z } : null;
  };
  const position = (): Pt => {
    const L = project.layout!;
    if (id === 'ahu') return L.airHandler.position;
    if (id === 'trunk') return L.trunk.axis === 'x' ? { x: 0, y: L.trunk.offset } : { x: L.trunk.offset, y: 0 };
    return L.registers.find((r) => r.id === id)?.position ?? { x: 0, y: 0 };
  };
  type Capturable = { setPointerCapture(id: number): void; releasePointerCapture(id: number): void };
  return (
    <group
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        select(id);
        if (!draggableKind(id)) return;
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -height);
        const p = hit(e, plane);
        if (!p) return;
        (e.target as unknown as Capturable).setPointerCapture(e.pointerId);
        const c = position();
        drag.current = { plane, offset: { x: c.x - p.x, y: c.y - p.y }, moved: false };
        if (controls) controls.enabled = false;
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        e.stopPropagation();
        const p = hit(e, d.plane);
        if (!p) return;
        if (!d.moved) useStore.getState().checkpoint();
        d.moved = true;
        moveComponent(id, { x: p.x + d.offset.x, y: p.y + d.offset.y });
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        e.stopPropagation();
        (e.target as unknown as Capturable).releasePointerCapture(e.pointerId);
        drag.current = null;
        if (controls) controls.enabled = true;
      }}
      onPointerOver={() => (document.body.style.cursor = draggableKind(id) ? 'move' : 'pointer')}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      {children}
    </group>
  );
}
