import { Html, Line, OrbitControls } from '@react-three/drei';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { defaultConfig, floorElevations, joistGrid, joistPositions, systemOf, type EngineResult, type JoistGrid } from '../engine';
import { bbox, centroid, dist } from '../engine/geometry';
import { draggableKind, moveComponent } from '../state/layoutActions';
import { useStore } from '../state/store';
import type { DuctSegment, Layout, Project, Pt, Room } from '../types';
import { COLORS } from './PlanView';

export type WallMode = 'cutaway' | 'full' | 'hidden';
export interface ViewRequest {
  kind: 'reset' | 'top';
  nonce: number;
}

interface SceneProps {
  project: Project;
  /** Every floor's result; `floorId` picks the one being edited. */
  results: Record<string, EngineResult>;
  floorId: string;
  /** Show just the floor being edited, or the whole building with the other floors faded. */
  floorView: 'this' | 'all';
  selectedId: string | null;
  wallMode: WallMode;
  showLabels: boolean;
  /** Draw joists (floor cavities and attic ceilings). */
  showFraming: boolean;
  viewRequest: ViewRequest;
}

interface FloorProps {
  project: Project;
  result: EngineResult;
  elevation: number;
  /** Faded, not interactive: another floor shown for context. */
  ghost: boolean;
  selectedId: string | null;
  wallMode: WallMode;
  showLabels: boolean;
  showFraming: boolean;
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

function SceneContent({ project, results, floorId, floorView, selectedId, wallMode, showLabels, showFraming, viewRequest }: SceneProps) {
  const elevations = floorElevations(project);
  const shown = floorView === 'all' ? project.floors.map((f) => f.id) : [floorId];
  const pts = shown.flatMap((id) => results[id]?.rooms.flatMap((r) => r.polygon) ?? []);
  const b = pts.length ? bbox(pts) : { minX: 0, minY: 0, maxX: 40, maxY: 30, width: 40, height: 30 };
  const top = Math.max(...shown.map((id) => elevations.get(id) ?? 0));
  const center = new THREE.Vector3(b.minX + b.width / 2, floorView === 'all' ? top / 2 : (elevations.get(floorId) ?? 0), b.minY + b.height / 2);
  return (
    <>
      <CameraRig center={center} span={Math.max(b.width, b.height, top)} request={viewRequest} />
      {/* Ground */}
      <mesh rotation-x={-Math.PI / 2} position={[center.x, -0.05, center.z]}>
        <planeGeometry args={[b.width + 60, b.height + 60]} />
        <meshBasicMaterial color="#f8fafc" />
      </mesh>
      {shown.map((id) =>
        results[id] ? (
          <FloorContent
            key={id}
            project={project}
            result={results[id]}
            elevation={elevations.get(id) ?? 0}
            ghost={id !== floorId}
            selectedId={selectedId}
            wallMode={
              // With every floor shown, lower floors get full-height walls so the stack reads as one building.
              floorView === 'all' && (elevations.get(id) ?? 0) < top ? 'full' : id === floorId ? wallMode : 'cutaway'
            }
            showLabels={showLabels && id === floorId}
            showFraming={showFraming}
          />
        ) : null,
      )}
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI / 2.05} />
    </>
  );
}

/** Fades everything inside a group and stops it reacting to the pointer. */
function Ghost({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    ref.current?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.raycast = () => {};
      const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      for (const m of mats) {
        m.transparent = true;
        m.opacity = Math.min(m.opacity, 0.22);
        m.depthWrite = false;
      }
    });
  });
  return <group ref={ref}>{children}</group>;
}

function FloorContent({ project, result, elevation, ghost, selectedId, wallMode, showLabels, showFraming }: FloorProps) {
  const systems = project.layouts[result.floorId] ?? [];
  const layout = systems.length ? systems : undefined;
  const select = useStore((s) => s.select);
  const warned = useMemo(() => new Set(result.warnings.flatMap((w) => w.componentIds)), [result.warnings]);
  const maxCeiling = Math.max(8, ...result.rooms.map((r) => r.ceilingHeight));
  const roomById = new Map(result.rooms.map((r) => [r.id, r]));
  const grid = result.grid;
  // Every floor has ceiling framing: the floor cavity when ducts run between joists, otherwise
  // the attic's ceiling joists, which attic ducts lie on top of.
  const atticJoistFt = defaultConfig.framing.atticJoistDepthIn / 12;
  const framingGrid = grid ?? joistGrid(result.rooms, { ...result.framing, ductSpace: 'joist-bays' });
  const framingDepthFt = grid ? grid.framing.depthIn / 12 : atticJoistFt;
  const halfHeight = (d: DuctSegment) => (d.shape === 'rect' ? d.heightIn! : d.diameter) / 24;
  const supplyTrunkFt = Math.max(0, ...result.ducts.filter((d) => d.side === 'supply' && d.type === 'trunk').map((d) => halfHeight(d) * 2));
  const plenum = result.framing.ductSpace === 'plenum';
  const deck = maxCeiling + result.framing.plenumDepthIn / 12;
  const plenumFull = result.framing.plenumDepthIn - defaultConfig.pathfinding.beamClearanceIn;
  const ductHeight = (d: DuctSegment) => {
    if (plenum) {
      // Ducts hang just under the deck; a run that drops under a beam sits in the space below it.
      const under = d.maxHeightIn !== undefined && d.maxHeightIn < plenumFull - 1e-6;
      return under ? maxCeiling + d.maxHeightIn! / 12 - halfHeight(d) : deck - 0.08 - halfHeight(d);
    }
    if (grid) {
      // Branches sit inside the joist depth; trunks hang below the joists in a soffit.
      return d.type === 'branch' ? maxCeiling + grid.framing.depthIn / 24 : maxCeiling - halfHeight(d);
    }
    // Attic: every duct rests on the ceiling joists; returns cross over the supply trunk.
    const onJoists = maxCeiling + atticJoistFt;
    return d.side === 'return' ? onJoists + supplyTrunkFt + halfHeight(d) : onJoists + halfHeight(d);
  };
  const branchOf = new Map(result.ducts.filter((d) => d.registerId).map((d) => [d.registerId!, d]));
  const ductTop = Math.max(maxCeiling + framingDepthFt, ...result.ducts.map((d) => ductHeight(d) + halfHeight(d)));
  const plenumTop = ductTop + 0.5;

  const isSel = (id: string) => id === selectedId;
  const colorFor = (id: string, base: string) => (isSel(id) ? COLORS.select : warned.has(id) ? COLORS.danger : base);

  const body = (
    <group position-y={elevation}>

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

      {showFraming && !plenum && framingGrid && <Joists rooms={result.rooms} grid={framingGrid} ceiling={maxCeiling} depthFt={framingDepthFt} attic={!grid} />}
      {showFraming &&
        (project.beams ?? [])
          .filter((bm) => bm.floorId === result.floorId)
          .map((bm) => {
            const len = Math.hypot(bm.b.x - bm.a.x, bm.b.y - bm.a.y);
            const depth = bm.depthIn / 12;
            return (
              <mesh key={bm.id} position={[(bm.a.x + bm.b.x) / 2, deck - depth / 2, (bm.a.y + bm.b.y) / 2]} rotation-y={-Math.atan2(bm.b.y - bm.a.y, bm.b.x - bm.a.x)} raycast={() => null}>
                <boxGeometry args={[len, depth, bm.kind === 'main' ? 0.75 : 0.5]} />
                <meshStandardMaterial color={bm.kind === 'main' ? '#7f1d1d' : '#78716c'} metalness={0.4} roughness={0.5} />
              </mesh>
            );
          })}
      {(project.equipmentAreas ?? [])
        .filter((a) => a.floorId === result.floorId)
        .map((a) => (
          <EquipmentPatch key={a.id} polygon={a.polygon} />
        ))}

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
            const id = isTrunk ? `${d.id.split('/')[0]}/trunk` : d.id;
            return (
              <MaybeDrag ghost={ghost} layout={layout} elevation={elevation} key={d.id} id={id} height={y}>
                <Duct duct={d} y={y} color={colorFor(isSel(id) ? id : d.id, d.side === 'supply' ? COLORS.supply : COLORS.return)} highlight={warned.has(d.id)} />
              </MaybeDrag>
            );
          })}

          {systems.flatMap((sys) => sys.registers).map((r) => {
            const room = roomById.get(r.roomId);
            const ceil = room?.ceilingHeight ?? 8;
            const branch = branchOf.get(r.id);
            const top = branch ? ductHeight(branch) : maxCeiling + framingDepthFt;
            const color = colorFor(r.id, r.kind === 'supply' ? COLORS.supply : COLORS.return);
            const size = r.kind === 'supply' ? [1.2, 0.12, 0.8] : [1.8, 0.12, 1.4];
            return (
              <MaybeDrag ghost={ghost} layout={layout} elevation={elevation} key={r.id} id={r.id} height={ceil}>
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
              </MaybeDrag>
            );
          })}

          {systems.map((sys) => {
            const ahu = sys.airHandler;
            return (
              <MaybeDrag ghost={ghost} layout={layout} elevation={elevation} key={ahu.id} id={ahu.id} height={AHU_SIZE.h}>
                <group position={[ahu.position.x, 0, ahu.position.y]}>
                  <mesh position={[0, AHU_SIZE.h / 2, 0]}>
                    <boxGeometry args={[AHU_SIZE.w, AHU_SIZE.h, AHU_SIZE.d]} />
                    <meshStandardMaterial color={colorFor(ahu.id, '#334155')} emissive={isSel(ahu.id) ? COLORS.select : '#000'} emissiveIntensity={0.3} />
                  </mesh>
                  {/* Plenum rises above the duct runs so the unit stays easy to grab from any angle. */}
                  <mesh position={[0, (AHU_SIZE.h + plenumTop) / 2, 0]}>
                    <boxGeometry args={[2, plenumTop - AHU_SIZE.h, 2]} />
                    <meshStandardMaterial color={isSel(ahu.id) ? COLORS.select : '#94a3b8'} />
                  </mesh>
                  {showLabels && (
                    <Html position={[0, plenumTop + 0.6, 0]} center style={{ pointerEvents: 'none' }}>
                      <div className="whitespace-nowrap rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {sys.name} · {ahu.tons} t
                      </div>
                    </Html>
                  )}
                </group>
              </MaybeDrag>
            );
          })}
        </>
      )}

    </group>
  );
  return ghost ? <Ghost>{body}</Ghost> : body;
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

/** A marked equipment area, shown as a green patch on the floor. */
function EquipmentPatch({ polygon }: { polygon: Pt[] }) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    polygon.forEach((p, i) => (i === 0 ? s.moveTo(p.x, -p.y) : s.lineTo(p.x, -p.y)));
    s.closePath();
    return s;
  }, [polygon]);
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={0.04} raycast={() => null}>
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color="#10b981" transparent opacity={0.25} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Ceiling joists above the rooms: the floor cavity ducts run inside, or the attic ceiling they lie on. */
function Joists({ rooms, grid, ceiling, depthFt, attic }: { rooms: Room[]; grid: JoistGrid; ceiling: number; depthFt: number; attic: boolean }) {
  const dir = grid.framing.joistDirection;
  const depth = depthFt;
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
            <meshStandardMaterial color="#d6b98c" transparent opacity={attic ? 0.45 : 0.75} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Draggable on the floor being edited; plain on ghost floors. Drag heights are in world space. */
function MaybeDrag({ ghost, layout, elevation, id, height, children }: { ghost: boolean; layout: Layout[] | undefined; elevation: number; id: string; height: number; children: React.ReactNode }) {
  if (ghost || !layout) return <>{children}</>;
  return (
    <Draggable id={id} height={height + elevation} layout={layout}>
      {children}
    </Draggable>
  );
}

/** Click to inspect; drag (for movable components) along a horizontal plane at `height`. */
function Draggable({ id, height, layout, children }: { id: string; height: number; layout: Layout[]; children: React.ReactNode }) {
  const select = useStore((s) => s.select);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const drag = useRef<{ plane: THREE.Plane; offset: Pt; moved: boolean } | null>(null);
  const hit = (e: ThreeEvent<PointerEvent>, plane: THREE.Plane) => {
    const v = new THREE.Vector3();
    return e.ray.intersectPlane(plane, v) ? { x: v.x, y: v.z } : null;
  };
  const position = (): Pt => {
    const L = systemOf(layout, id);
    if (!L) return { x: 0, y: 0 };
    if (id === L.airHandler.id) return L.airHandler.position;
    if (id.endsWith('/trunk')) return L.trunk.axis === 'x' ? { x: 0, y: L.trunk.offset } : { x: L.trunk.offset, y: 0 };
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
