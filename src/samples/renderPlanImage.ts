import { deriveWalls } from '../engine/walls';
import type { BackgroundImage } from '../types';
import { SAMPLE_MARGIN_FT, SAMPLE_PX_PER_FT, buildSampleProject, sampleExtent, sampleLabeledArea, sampleLevels, type SamplePlan } from './plans';

/**
 * Draws one floor of a sample plan as a simple architectural floor-plan picture, so the
 * upload/trace flow can be tried. Every floor uses the same canvas size, so floors line up.
 */
export function renderSamplePlanImage(plan: SamplePlan, level = 0): BackgroundImage {
  const s = SAMPLE_PX_PER_FT;
  const m = SAMPLE_MARGIN_FT;
  const { width, height } = sampleExtent(plan);
  const canvas = document.createElement('canvas');
  canvas.width = (width + 2 * m) * s;
  canvas.height = (height + 2 * m) * s;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const project = buildSampleProject(plan);
  const floorId = `f${level + 1}`;
  project.rooms = project.rooms.filter((r) => r.floorId === floorId);
  const walls = deriveWalls(project.rooms);
  const px = (v: number) => v * s;

  ctx.lineCap = 'square';
  ctx.strokeStyle = '#1f2937';
  for (const w of walls) {
    ctx.lineWidth = w.exterior ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(px(w.start.x), px(w.start.y));
    ctx.lineTo(px(w.end.x), px(w.end.y));
    ctx.stroke();
  }
  // Windows: white gap with a thin double line.
  for (const room of project.rooms) {
    for (const win of room.windows) {
      const w = walls.find((x) => x.id === win.wallId);
      if (!w) continue;
      for (let k = 0; k < win.count; k++) {
        const t = (k + 1) / (win.count + 1);
        const cx = w.start.x + (w.end.x - w.start.x) * t;
        const cy = w.start.y + (w.end.y - w.start.y) * t;
        const ux = (w.end.x - w.start.x) / w.length;
        const uy = (w.end.y - w.start.y) / w.length;
        const half = win.width / 2;
        const a = { x: px(cx - ux * half), y: px(cy - uy * half) };
        const b = { x: px(cx + ux * half), y: px(cy + uy * half) };
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.strokeStyle = '#1f2937';
        ctx.lineWidth = 1;
        for (const off of [-3, 3]) {
          ctx.beginPath();
          ctx.moveTo(a.x - uy * off, a.y + ux * off);
          ctx.lineTo(b.x - uy * off, b.y + ux * off);
          ctx.stroke();
        }
      }
    }
  }
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'center';
  plan.rooms.filter((r) => (r.level ?? 0) === level).forEach((r) => {
    const cx = px((r.rect[0] + r.rect[2]) / 2 + m);
    const cy = px((r.rect[1] + r.rect[3]) / 2 + m);
    const w = r.rect[2] - r.rect[0];
    const h = r.rect[3] - r.rect[1];
    const small = Math.min(w, h) < 7;
    ctx.font = `600 ${small ? 10 : 13}px sans-serif`;
    ctx.fillText(r.name.toUpperCase(), cx, cy - (small ? 2 : 6));
    ctx.font = `${small ? 9 : 11}px sans-serif`;
    ctx.fillText(`${w}' × ${h}'`, cx, cy + (small ? 9 : 9));
    if (!small) ctx.fillText(`${sampleLabeledArea(r)} sq ft`, cx, cy + 23);
  });
  // Overall dimension line along the top.
  const y = px(m - 2.5);
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px(m), y);
  ctx.lineTo(px(m + width), y);
  for (const x of [px(m), px(m + width)]) {
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y + 8);
  }
  ctx.stroke();
  ctx.font = '600 13px sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillRect(px(m + width / 2) - 30, y - 10, 60, 20);
  ctx.fillStyle = '#111827';
  ctx.fillText(`${width}'-0"`, px(m + width / 2), y + 5);
  ctx.textAlign = 'left';
  ctx.font = '11px sans-serif';
  const floorName = sampleLevels(plan).length > 1 ? `  ·  FLOOR ${level + 1}` : '';
  ctx.fillText(`${plan.name.toUpperCase()}${floorName}  ·  SAMPLE FLOOR PLAN  ·  N ↑`, px(m), canvas.height - px(m) / 2);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, fileName: `${plan.id}-floor-${level + 1}-sample-plan.png` };
}
