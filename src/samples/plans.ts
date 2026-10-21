import { deriveWalls } from '../engine/walls';
import { applyRoomDefaults } from '../lib/roomDefaults';
import type { Project, Room } from '../types';

export interface SampleRoom {
  name: string;
  /** Rectangle in feet: [x0, y0, x1, y1], x east, y south. */
  rect: [number, number, number, number];
}

export interface SamplePlan {
  id: string;
  name: string;
  description: string;
  zipCode: string;
  rooms: SampleRoom[];
}

export const SAMPLE_PLANS: SamplePlan[] = [
  {
    id: 'ranch',
    name: 'Ranch — 3 bed (rectangle)',
    description: '56 × 30 ft, 1,680 sq ft',
    zipCode: '27601',
    rooms: [
      { name: 'Bedroom 2', rect: [0, 0, 12, 13] },
      { name: 'Bath 2', rect: [12, 0, 20, 9] },
      { name: 'Laundry', rect: [12, 9, 20, 13] },
      { name: 'Bedroom 3', rect: [20, 0, 32, 13] },
      { name: 'Kitchen / Dining', rect: [32, 0, 56, 13] },
      { name: 'Hall', rect: [0, 13, 32, 17] },
      { name: 'Living Room', rect: [32, 13, 56, 30] },
      { name: 'Primary Bedroom', rect: [0, 17, 16, 30] },
      { name: 'Primary Bath', rect: [16, 17, 24, 30] },
      { name: 'Den', rect: [24, 17, 32, 30] },
    ],
  },
  {
    id: 'l-shape',
    name: 'L-shape — 3 bed',
    description: '48 × 52 ft L, 1,976 sq ft',
    zipCode: '85004',
    rooms: [
      { name: 'Kitchen', rect: [0, 0, 14, 14] },
      { name: 'Dining', rect: [14, 0, 26, 14] },
      { name: 'Living Room', rect: [26, 0, 48, 18] },
      { name: 'Family Room', rect: [0, 14, 26, 26] },
      { name: 'Office', rect: [26, 18, 38, 26] },
      { name: 'Laundry', rect: [38, 18, 48, 26] },
      { name: 'Bedroom 2', rect: [0, 26, 12, 38] },
      { name: 'Bedroom 3', rect: [0, 38, 12, 52] },
      { name: 'Hall', rect: [12, 26, 17, 52] },
      { name: 'Bath 2', rect: [17, 26, 28, 34] },
      { name: 'Primary Bedroom', rect: [17, 34, 28, 52] },
    ],
  },
  {
    id: 't-shape',
    name: 'T-shape — 4 bed',
    description: '60 × 50 ft T, 2,168 sq ft',
    zipCode: '60601',
    rooms: [
      { name: 'Bedroom 2', rect: [0, 0, 12, 12] },
      { name: 'Bedroom 3', rect: [0, 12, 12, 24] },
      { name: 'Bath 2', rect: [12, 0, 18, 10] },
      { name: 'Hall West', rect: [12, 10, 18, 24] },
      { name: 'Great Room', rect: [18, 0, 42, 24] },
      { name: 'Kitchen', rect: [42, 0, 60, 14] },
      { name: 'Pantry', rect: [42, 14, 50, 24] },
      { name: 'Mudroom', rect: [50, 14, 60, 24] },
      { name: 'Bedroom 4', rect: [16, 24, 28, 37] },
      { name: 'Office', rect: [16, 37, 28, 50] },
      { name: 'Hall', rect: [28, 24, 32, 50] },
      { name: 'Primary Bedroom', rect: [32, 24, 44, 40] },
      { name: 'Primary Bath', rect: [32, 40, 44, 50] },
    ],
  },
];

/** Image layout used when rendering a sample as a floor-plan picture. */
export const SAMPLE_PX_PER_FT = 20;
export const SAMPLE_MARGIN_FT = 5;

export function sampleExtent(plan: SamplePlan) {
  const xs = plan.rooms.flatMap((r) => [r.rect[0], r.rect[2]]);
  const ys = plan.rooms.flatMap((r) => [r.rect[1], r.rect[3]]);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export const sampleLabeledArea = (r: SampleRoom) => (r.rect[2] - r.rect[0]) * (r.rect[3] - r.rect[1]);

/** A ready-traced project for a sample plan (rooms offset by the image margin so they line up with its picture). */
export function buildSampleProject(plan: SamplePlan): Project {
  const m = SAMPLE_MARGIN_FT;
  let rooms: Room[] = plan.rooms.map((r, i) => ({
    id: `${plan.id}-r${i + 1}`,
    name: r.name,
    polygon: [
      { x: r.rect[0] + m, y: r.rect[1] + m },
      { x: r.rect[2] + m, y: r.rect[1] + m },
      { x: r.rect[2] + m, y: r.rect[3] + m },
      { x: r.rect[0] + m, y: r.rect[3] + m },
    ],
    ceilingHeight: 8,
    floorType: 'slab',
    isBedroom: false,
    exteriorOverrides: {},
    windows: [],
    defaultsApplied: false,
  }));
  const walls = deriveWalls(rooms);
  let n = 0;
  rooms = rooms.map((r) => applyRoomDefaults(r, walls, () => `${r.id}-w${n++}`));
  const { width } = sampleExtent(plan);
  const s = SAMPLE_PX_PER_FT;
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    id: `sample-${plan.id}`,
    name: plan.name,
    zipCode: plan.zipCode,
    buildingType: 'single-story-residential',
    systemType: 'forced-air-ducted',
    scalePxPerFt: s,
    scaleLine: { a: { x: m * s, y: (m - 2.5) * s }, b: { x: (m + width) * s, y: (m - 2.5) * s }, lengthFt: width },
    background: null,
    rooms,
    layout: null,
    createdAt: now,
    updatedAt: now,
  };
}
