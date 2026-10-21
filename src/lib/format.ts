import type { DuctSegment } from '../types';

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
export const fmtFt = (n: number) => `${n.toFixed(1)} ft`;
export const fmtSqFt = (n: number) => `${fmtInt(n)} sq ft`;
export const fmtBtuh = (n: number) => `${fmtInt(n)} BTU/h`;

/** Duct size as drawn: `8" round` or `16×14"` for rectangular. */
export const ductSize = (d: DuctSegment) => (d.shape === 'rect' ? `${d.widthIn}×${d.heightIn}"` : `${d.diameter}" round`);
export const fmtCfm = (n: number) => `${fmtInt(n)} CFM`;

/** Parses lengths like `12`, `12.5`, `12'6"`, `12' 6`, `12ft 6in` into feet. */
export function parseFeet(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inches)?)?$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
  return v > 0 ? v : null;
}
