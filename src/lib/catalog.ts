import type { BuildingType, SystemType } from '../types';

export const BUILDING_TYPES: { id: BuildingType; label: string; enabled: boolean }[] = [
  { id: 'single-story-residential', label: 'Single-story residential', enabled: true },
  { id: 'multi-story-residential', label: 'Multi-story residential', enabled: true },
  { id: 'light-commercial', label: 'Light commercial', enabled: false },
];

export const SYSTEM_TYPES: { id: SystemType; label: string; enabled: boolean }[] = [
  { id: 'forced-air-ducted', label: 'Forced-air ducted', enabled: true },
  { id: 'multi-zone', label: 'Multi-zone', enabled: false },
  { id: 'mini-split', label: 'Mini-split', enabled: false },
];

export const ESTIMATE_LABEL = 'Estimate, not for permit';
