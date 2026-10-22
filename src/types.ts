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

/** One storey. Each has its own plan image, scale and room tracing. */
export interface Floor {
  id: string;
  name: string;
  /** 0 = ground floor, 1 = the floor above, and so on. */
  level: number;
  /**
   * Floor-to-floor height (ft). Undefined = automatic: the tallest ceiling on this floor plus
   * the floor framing above it and allowance for subfloor and drywall.
   */
  heightFt?: number;
  background: BackgroundImage | null;
  /** Pixels of this floor's plan image per foot; null until the user sets the scale. */
  scalePxPerFt: number | null;
  scaleLine: ScaleLine | null;
  /** Where this floor's plan image sits in building coordinates (ft), so floors line up. */
  offsetFt: Pt;
  /**
   * Where this floor's ducts run. Undefined = automatic: between joists when another floor is
   * above (the floor cavity), otherwise the project's setting.
   */
  ductSpace?: Framing['ductSpace'];
  /** How many main units serve this floor. Undefined = automatic, from the floor's load. */
  unitCount?: number;
}

export interface Room {
  id: string;
  floorId: string;
  name: string;
  /** Polygon corners in feet, in building coordinates (shared by all floors). */
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
  /** People counted in this room at the cooling peak. Undefined = automatic. */
  occupants?: number;
  /** Sensible appliance gain (BTU/h). Undefined = automatic (kitchens get an allowance). */
  applianceBtuh?: number;
}

/**
 * Per-project overrides of the load-calculation inputs. Anything left undefined uses the
 * climate-zone default from the engine config.
 */
export interface DesignInputs {
  outdoorCoolingF?: number;
  outdoorHeatingF?: number;
  indoorCoolingF?: number;
  indoorHeatingF?: number;
  /** Outdoor minus indoor humidity ratio at cooling design (grains of moisture per lb of dry air). */
  grainsDifference?: number;
  wallU?: number;
  windowU?: number;
  windowShgc?: number;
  ceilingU?: number;
  floorU?: number;
  /** Slab-edge heat loss factor (BTU/h per ft of exposed perimeter per °F). */
  slabF?: number;
  /** Natural air changes per hour from infiltration. */
  ach?: number;
  /** Extra load from ducts outside the conditioned space, as a fraction (0.1 = 10%). */
  ductLoadFactor?: number;
}

/** Where ducts run, and the framing they have to fit around. */
export interface Framing {
  /**
   * 'attic': flex duct laid over the ceiling framing. 'joist-bays': ducts run inside the joist
   * spaces. 'plenum': a ceiling plenum under a structural deck with beams; ducts are routed by
   * pathfinding around the beams.
   */
  ductSpace: 'attic' | 'joist-bays' | 'plenum';
  /** Direction the joists run: 'x' = east-west, 'y' = north-south. */
  joistDirection: 'x' | 'y';
  /** Joist spacing, on centre (in). */
  spacingIn: number;
  /** Joist depth (in). */
  depthIn: number;
  /** Deepest dropped soffit allowed for the trunk, which runs across the joists (in). */
  soffitDepthIn: number;
  /** Ceiling plenum: clear height from the ceiling to the underside of the deck (in). */
  plenumDepthIn: number;
}

/**
 * A structural beam in a ceiling plenum. Ducts never cross a main beam (girder); they may drop
 * under a secondary beam if they fit in the space below it.
 */
export interface Beam {
  id: string;
  floorId: string;
  a: Pt;
  b: Pt;
  kind: 'main' | 'secondary';
  /** Depth below the deck (in). */
  depthIn: number;
}

/** Where main units may go on a floor: a mechanical room, roof area, mezzanine or closet. */
export interface EquipmentArea {
  id: string;
  floorId: string;
  name: string;
  polygon: Pt[];
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
  /** Equivalent round diameter (in), from the friction-rate table. */
  diameter: number;
  /** Shape actually drawn: round, or rectangular when round won't fit the framing depth. */
  shape: 'round' | 'rect';
  /** Rectangular size (in), when shape is 'rect'. */
  widthIn?: number;
  heightIn?: number;
  /** Largest duct height the space allows here (in), or undefined if unconstrained. */
  maxHeightIn?: number;
  /** False when no duct shape of this size fits the space it runs through. */
  fits: boolean;
  length: number;
  registerId?: string;
}

/**
 * One system: a main unit, the zone (rooms) it serves, its registers and grilles. The ducts are
 * derived. A floor has one or more systems.
 */
export interface Layout {
  /** Stable id, e.g. "u1". */
  id: string;
  /** Unit tag shown on drawings, e.g. "AHU-1". */
  name: string;
  /** Rooms this unit serves; null = every room on the floor (a single-system floor). */
  roomIds: string[] | null;
  airHandler: AirHandler;
  trunk: Trunk;
  registers: Register[];
  /** Signature of the rooms and framing the layout was generated from, to detect stale layouts. */
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
    | 'AHU_OUTSIDE_BUILDING'
    | 'DUCT_DOES_NOT_FIT'
    | 'REGISTER_ON_JOIST'
    | 'DUCT_CROSSES_MAIN_BEAM'
    | 'UNIT_OUTSIDE_EQUIPMENT_AREA'
    | 'ROOM_NOT_SERVED';
  severity: Severity;
  message: string;
  componentIds: string[];
  /** A one-step fix the UI can offer. */
  fix?: { kind: 'split-register'; registerId: string; parts: number };
}

export interface Project {
  schemaVersion: 3;
  id: string;
  name: string;
  zipCode: string;
  buildingType: BuildingType;
  systemType: SystemType;
  floors: Floor[];
  rooms: Room[];
  /** Overrides of the load-calculation inputs (optional; older files have none). */
  design?: DesignInputs;
  /** Duct space and framing (optional; defaults to ducts in the attic). */
  framing?: Framing;
  /** Structural beams, per floor (optional). */
  beams?: Beam[];
  /** Areas where main units may be placed, per floor (optional; none = anywhere). */
  equipmentAreas?: EquipmentArea[];
  /** The systems on each floor, keyed by floor id. */
  layouts: Record<string, Layout[]>;
  createdAt: string;
  updatedAt: string;
}
