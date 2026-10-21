// Core data model. All geometry is in feet on a 2D plan (x to the east, y to the
// south, i.e. image coordinates with north up). The 3D view is derived from this.

export interface Pt {
  x: number;
  y: number;
}

export type BuildingType = 'single-story-residential' | 'multi-story-residential' | 'light-commercial';
export type SystemType = 'forced-air-ducted' | 'multi-zone' | 'mini-split';
export type Direction = 'N' | 'E' | 'S' | 'W';
export type FloorType = 'slab' | 'crawlspace' | 'basement' | 'over-garage';

export interface BackgroundImage {
  dataUrl: string;
  /** Natural size in image pixels. */
  width: number;
  height: number;
  fileName: string;
}

/** The reference line the user marked to set the scale (image pixels). */
export interface ScaleLine {
  a: Pt;
  b: Pt;
  lengthFt: number;
}

export interface WindowSpec {
  id: string;
  /** Wall id (`<roomId>:<edgeIndex>`); direction comes from the wall. */
  wallId: string;
  count: number;
  width: number;
  height: number;
}

export interface Room {
  id: string;
  name: string;
  /** Polygon corners in feet. */
  polygon: Pt[];
  ceilingHeight: number;
  floorType: FloorType;
  /** Closed-door room (bedroom): gets its own return grille. */
  isBedroom: boolean;
  /** User overrides of the auto-detected exterior flag, keyed by wall id. */
  exteriorOverrides: Record<string, boolean>;
  windows: WindowSpec[];
  /** Set once the room-details step has prefilled defaults. */
  defaultsApplied: boolean;
}

/** Derived from room polygons; never stored. One per room edge. */
export interface Wall {
  id: string;
  roomId: string;
  edgeIndex: number;
  start: Pt;
  end: Pt;
  length: number;
  exterior: boolean;
  /** Exterior flag before user overrides. */
  autoExterior: boolean;
  facing: Direction;
  /** Room on the other side of a shared wall, if any. */
  sharedWithRoomId: string | null;
}

export interface AirHandler {
  id: string;
  position: Pt;
  tons: number;
  capacityBtuh: number;
  airflowCfm: number;
}

export type AirSide = 'supply' | 'return';
export type DuctType = 'trunk' | 'branch';

/** Supply trunk: a straight line along one axis. axis 'x' runs east-west at y = offset. */
export interface Trunk {
  axis: 'x' | 'y';
  offset: number;
}

export interface Register {
  id: string;
  roomId: string;
  position: Pt;
  kind: AirSide;
  targetCfm: number;
}

/** Derived by the engine from the air handler, trunk and registers. */
export interface DuctSegment {
  id: string;
  start: Pt;
  end: Pt;
  type: DuctType;
  side: AirSide;
  cfm: number;
  diameter: number;
  length: number;
  registerId?: string;
}

export interface Layout {
  airHandler: AirHandler;
  trunk: Trunk;
  registers: Register[];
  /** Signature of the rooms the layout was generated from, to detect stale layouts. */
  roomsSignature: string;
}

export type Severity = 'error' | 'warning';

export interface Warning {
  id: string;
  code:
    | 'ROOM_NO_SUPPLY'
    | 'ROOM_LOW_AIRFLOW'
    | 'BRANCH_TOO_LONG'
    | 'REGISTER_IN_WALL'
    | 'REGISTER_OUTSIDE_ROOM'
    | 'COMPONENT_OVERLAP'
    | 'AIRFLOW_MISMATCH'
    | 'AHU_OUTSIDE_BUILDING';
  severity: Severity;
  message: string;
  componentIds: string[];
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  zipCode: string;
  buildingType: BuildingType;
  systemType: SystemType;
  /** Pixels of the background image per foot; null until the user sets the scale. */
  scalePxPerFt: number | null;
  scaleLine: ScaleLine | null;
  background: BackgroundImage | null;
  rooms: Room[];
  layout: Layout | null;
  createdAt: string;
  updatedAt: string;
}
