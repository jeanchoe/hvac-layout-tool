import { jsPDF } from 'jspdf';
import type { EngineResult } from '../engine';
import { bbox, centroid, lerp } from '../engine/geometry';
import { BUILDING_TYPES, ESTIMATE_LABEL, SYSTEM_TYPES } from '../lib/catalog';
import { fmtInt } from '../lib/format';
import type { Project, Pt } from '../types';

type RGB = [number, number, number];
const C = {
  ink: [17, 24, 39] as RGB,
  muted: [107, 114, 128] as RGB,
  line: [229, 231, 235] as RGB,
  accent: [37, 99, 235] as RGB,
  ret: [100, 116, 139] as RGB,
  danger: [220, 38, 38] as RGB,
  amberBg: [255, 251, 235] as RGB,
  amber: [146, 64, 14] as RGB,
  window: [125, 211, 252] as RGB,
};

const PAGE = { w: 792, h: 612, m: 36 };

export function buildReport(project: Project, result: EngineResult): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const layout = project.layout;
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const color = (kind: 'draw' | 'fill' | 'text', c: RGB) => (kind === 'draw' ? doc.setDrawColor(...c) : kind === 'fill' ? doc.setFillColor(...c) : doc.setTextColor(...c));
  const font = (size: number, style: 'normal' | 'bold' = 'normal', c: RGB = C.ink) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    color('text', c);
  };
  const polygon = (pts: Pt[], style: 'S' | 'F' | 'FD') => {
    if (pts.length < 3) return;
    doc.lines(
      pts.slice(1).map((p, i) => [p.x - pts[i].x, p.y - pts[i].y]),
      pts[0].x,
      pts[0].y,
      [1, 1],
      style,
      true,
    );
  };

  const header = (subtitle: string) => {
    font(16, 'bold');
    doc.text('HVAC Layout Report', PAGE.m, PAGE.m + 10);
    font(9, 'normal', C.muted);
    doc.text(`${project.name}  ·  ${subtitle}`, PAGE.m, PAGE.m + 26);
    const label = ESTIMATE_LABEL.toUpperCase();
    font(9, 'bold', C.amber);
    const w = doc.getTextWidth(label) + 20;
    color('fill', C.amberBg);
    color('draw', [252, 211, 77]);
    doc.setLineWidth(0.8);
    doc.roundedRect(PAGE.w - PAGE.m - w, PAGE.m - 4, w, 22, 3, 3, 'FD');
    doc.text(label, PAGE.w - PAGE.m - w / 2, PAGE.m + 11, { align: 'center' });
    color('draw', C.line);
    doc.setLineWidth(0.5);
    doc.line(PAGE.m, PAGE.m + 36, PAGE.w - PAGE.m, PAGE.m + 36);
  };

  // ---------- Page 1: plan view ----------
  header(`Plan view  ·  ${date}`);
  const box = { x: PAGE.m, y: PAGE.m + 50, w: 500, h: PAGE.h - PAGE.m * 2 - 80 };
  const rooms = result.rooms;
  if (rooms.length) {
    const b = bbox(rooms.flatMap((r) => r.polygon));
    const s = Math.min(box.w / (b.width + 6), box.h / (b.height + 6));
    const ox = box.x + (box.w - b.width * s) / 2 - b.minX * s;
    const oy = box.y + (box.h - b.height * s) / 2 - b.minY * s;
    const P = (p: Pt): Pt => ({ x: ox + p.x * s, y: oy + p.y * s });

    color('fill', [250, 250, 250]);
    for (const r of rooms) polygon(r.polygon.map(P), 'F');
    for (const w of result.walls) {
      color('draw', w.exterior ? C.ink : [156, 163, 175]);
      doc.setLineWidth(w.exterior ? 1.8 : 0.6);
      const a = P(w.start);
      const c = P(w.end);
      doc.line(a.x, a.y, c.x, c.y);
    }
    color('draw', C.window);
    doc.setLineWidth(1.6);
    for (const r of rooms) {
      for (const win of r.windows) {
        const w = result.walls.find((x) => x.id === win.wallId);
        if (!w) continue;
        for (let k = 0; k < win.count; k++) {
          const t = (k + 1) / (win.count + 1);
          const half = win.width / 2 / w.length;
          const a = P(lerp(w.start, w.end, Math.max(0, t - half)));
          const c = P(lerp(w.start, w.end, Math.min(1, t + half)));
          doc.line(a.x, a.y, c.x, c.y);
        }
      }
    }

    if (layout) {
      const warned = new Set(result.warnings.flatMap((w) => w.componentIds));
      for (const d of [...result.ducts].sort((p, q) => (p.side === 'return' ? -1 : 1) - (q.side === 'return' ? -1 : 1))) {
        color('draw', warned.has(d.id) ? C.danger : d.side === 'supply' ? C.accent : C.ret);
        doc.setLineWidth(Math.max(0.8, (d.diameter / 12) * s * 0.8));
        doc.setLineDashPattern(d.side === 'return' ? [3, 2] : [], 0);
        const a = P(d.start);
        const c = P(d.end);
        doc.line(a.x, a.y, c.x, c.y);
      }
      doc.setLineDashPattern([], 0);
      for (const r of layout.registers) {
        const p = P(r.position);
        const z = (r.kind === 'supply' ? 1.4 : 1.8) * s;
        const c = warned.has(r.id) ? C.danger : r.kind === 'supply' ? C.accent : C.ret;
        color('draw', c);
        color('fill', r.kind === 'supply' ? c : [255, 255, 255]);
        doc.setLineWidth(0.8);
        doc.rect(p.x - z / 2, p.y - z / 2, z, z, 'FD');
        if (r.kind === 'return') {
          doc.setLineWidth(0.4);
          for (const dy of [-z / 4, 0, z / 4]) doc.line(p.x - z / 3, p.y + dy, p.x + z / 3, p.y + dy);
        }
      }
      const a = P(layout.airHandler.position);
      const z = 2.5 * s;
      color('fill', C.ink);
      doc.rect(a.x - z / 2, a.y - z / 2, z, z, 'F');
      font(Math.max(5, Math.min(8, z / 3)), 'bold', [255, 255, 255]);
      doc.text('AHU', a.x, a.y + 2.5, { align: 'center' });
    }

    for (const r of rooms) {
      const c = P(centroid(r.polygon));
      const load = result.loads.find((l) => l.roomId === r.id);
      const air = result.airflow[r.id];
      font(7, 'bold');
      doc.text(r.name, c.x, c.y - 4, { align: 'center' });
      font(6, 'normal', C.muted);
      doc.text(`${fmtInt(load?.areaSqFt ?? 0)} sq ft${air ? ` · ${fmtInt(air.required)} CFM` : ''}`, c.x, c.y + 4, { align: 'center' });
    }

    // North arrow and scale bar
    const nx = box.x + 14;
    const ny = box.y + 18;
    color('fill', C.ink);
    doc.triangle(nx, ny - 12, nx - 5, ny + 2, nx + 5, ny + 2, 'F');
    font(8, 'bold');
    doc.text('N', nx, ny + 12, { align: 'center' });
    const barFt = b.width > 60 ? 20 : 10;
    const bx = box.x + 4;
    const by = box.y + box.h - 6;
    color('draw', C.ink);
    doc.setLineWidth(1);
    doc.line(bx, by, bx + barFt * s, by);
    doc.line(bx, by - 3, bx, by + 3);
    doc.line(bx + barFt * s, by - 3, bx + barFt * s, by + 3);
    font(7, 'normal', C.muted);
    doc.text(`${barFt} ft`, bx + (barFt * s) / 2, by - 4, { align: 'center' });
  }

  // Side column: project + equipment summary + legend
  let y = box.y + 4;
  const col = 560;
  const kv = (k: string, v: string) => {
    font(8, 'normal', C.muted);
    doc.text(k, col, y);
    font(8, 'bold');
    doc.text(v, PAGE.w - PAGE.m, y, { align: 'right' });
    y += 13;
  };
  const sectionTitle = (t: string) => {
    font(9, 'bold');
    doc.text(t.toUpperCase(), col, y);
    y += 14;
  };
  sectionTitle('Project');
  kv('Location', project.zipCode ? `ZIP ${project.zipCode}` : '—');
  kv('Climate zone', `${result.climate.zone} (${result.climate.label})`);
  kv('Building', BUILDING_TYPES.find((t) => t.id === project.buildingType)?.label ?? '');
  kv('System', SYSTEM_TYPES.find((t) => t.id === project.systemType)?.label ?? '');
  kv('Conditioned area', `${fmtInt(result.totals.areaSqFt)} sq ft`);
  kv('Rooms', String(rooms.length));
  y += 8;
  sectionTitle('Equipment');
  if (layout) {
    const ahu = layout.airHandler;
    kv('Air handler', `${ahu.tons} ton`);
    kv('Capacity', `${fmtInt(ahu.capacityBtuh)} BTU/h`);
    kv('Airflow', `${fmtInt(ahu.airflowCfm)} CFM`);
  }
  kv('Cooling load (est.)', `${fmtInt(result.totals.coolingBtuh)} BTU/h`);
  kv('Heating load (est.)', `${fmtInt(result.totals.heatingBtuh)} BTU/h`);
  kv('Recommended size', `${result.recommended.tons} ton`);
  if (layout) {
    y += 8;
    sectionTitle('Distribution');
    const len = (f: (d: (typeof result.ducts)[0]) => boolean) => result.ducts.filter(f).reduce((s, d) => s + d.length, 0);
    kv('Supply registers', String(layout.registers.filter((r) => r.kind === 'supply').length));
    kv('Return grilles', String(layout.registers.filter((r) => r.kind === 'return').length));
    kv('Supply trunk', `${len((d) => d.side === 'supply' && d.type === 'trunk').toFixed(0)} ft`);
    kv('Supply branches', `${len((d) => d.side === 'supply' && d.type === 'branch').toFixed(0)} ft`);
    kv('Return ducts', `${len((d) => d.side === 'return').toFixed(0)} ft`);
    kv('Fittings', String(result.score?.fittings ?? 0));
    kv('Open warnings', String(result.warnings.length));
  }
  y += 8;
  sectionTitle('Legend');
  const legend = (c: RGB, label: string, kind: 'line' | 'dash' | 'box' | 'grille' | 'ahu') => {
    color('draw', c);
    color('fill', c);
    doc.setLineWidth(kind === 'line' || kind === 'dash' ? 2 : 0.8);
    if (kind === 'line' || kind === 'dash') {
      doc.setLineDashPattern(kind === 'dash' ? [3, 2] : [], 0);
      doc.line(col, y - 3, col + 18, y - 3);
      doc.setLineDashPattern([], 0);
    } else if (kind === 'grille') {
      color('fill', [255, 255, 255]);
      doc.rect(col + 5, y - 8, 8, 8, 'FD');
    } else doc.rect(col + 5, y - 8, 8, 8, 'F');
    font(8, 'normal');
    doc.text(label, col + 26, y);
    y += 13;
  };
  legend(C.accent, 'Supply duct (width ~ size)', 'line');
  legend(C.ret, 'Return duct', 'dash');
  legend(C.accent, 'Supply register', 'box');
  legend(C.ret, 'Return grille', 'grille');
  legend(C.ink, 'Air handler (AHU)', 'ahu');
  legend(C.danger, 'Has a warning', 'line');
  legend(C.window, 'Window', 'line');

  // ---------- Page 2+: room table ----------
  doc.addPage();
  header(`Room-by-room estimate  ·  ${date}`);
  const cols = [
    { h: 'Room', w: 140, a: 'left' as const },
    { h: 'Area (sq ft)', w: 62 },
    { h: 'Ceiling (ft)', w: 56 },
    { h: 'Ext. walls (ft)', w: 66 },
    { h: 'Windows (sq ft)', w: 72 },
    { h: 'Cooling (BTU/h)', w: 78 },
    { h: 'Heating (BTU/h)', w: 78 },
    { h: 'Needed CFM', w: 60 },
    { h: 'Delivered CFM', w: 66 },
    { h: 'Supply / Return', w: 82 },
  ];
  y = PAGE.m + 60;
  const drawRow = (cells: string[], opts: { bold?: boolean; head?: boolean; red?: boolean } = {}) => {
    let x = PAGE.m;
    if (opts.head) {
      color('fill', [249, 250, 251]);
      doc.rect(PAGE.m, y - 11, PAGE.w - 2 * PAGE.m, 16, 'F');
    }
    cells.forEach((cell, i) => {
      const c = cols[i];
      font(opts.head ? 7.5 : 8, opts.bold || opts.head ? 'bold' : 'normal', opts.head ? C.muted : opts.red && i === 8 ? C.danger : C.ink);
      if (c.a === 'left') doc.text(cell, x + 4, y);
      else doc.text(cell, x + c.w - 4, y, { align: 'right' });
      x += c.w;
    });
    color('draw', C.line);
    doc.setLineWidth(0.5);
    doc.line(PAGE.m, y + 5, PAGE.w - PAGE.m, y + 5);
    y += 17;
  };
  const head = () => drawRow(cols.map((c) => c.h), { head: true });
  head();
  for (const r of rooms) {
    if (y > PAGE.h - PAGE.m - 40) {
      doc.addPage();
      header(`Room-by-room estimate (continued)  ·  ${date}`);
      y = PAGE.m + 60;
      head();
    }
    const load = result.loads.find((l) => l.roomId === r.id)!;
    const ext = result.walls.filter((w) => w.roomId === r.id && w.exterior).reduce((s, w) => s + w.length, 0);
    const win = r.windows.reduce((s, w) => s + w.count * w.width * w.height, 0);
    const air = result.airflow[r.id];
    const regs = layout?.registers.filter((x) => x.roomId === r.id) ?? [];
    const low = !!air && air.delivered < air.required * 0.9;
    drawRow(
      [
        r.name,
        fmtInt(load.areaSqFt),
        r.ceilingHeight.toFixed(1),
        ext.toFixed(0),
        fmtInt(win),
        fmtInt(load.coolingBtuh),
        fmtInt(load.heatingBtuh),
        fmtInt(load.requiredCfm),
        air ? fmtInt(air.delivered) : '—',
        `${regs.filter((x) => x.kind === 'supply').length} / ${regs.filter((x) => x.kind === 'return').length}`,
      ],
      { red: low },
    );
  }
  const totalDelivered = Object.values(result.airflow).reduce((s, a) => s + a.delivered, 0);
  drawRow(
    [
      'Total',
      fmtInt(result.totals.areaSqFt),
      '',
      '',
      fmtInt(rooms.reduce((s, r) => s + r.windows.reduce((t, w) => t + w.count * w.width * w.height, 0), 0)),
      fmtInt(result.totals.coolingBtuh),
      fmtInt(result.totals.heatingBtuh),
      fmtInt(result.totals.requiredCfm),
      layout ? fmtInt(totalDelivered) : '—',
      layout ? `${layout.registers.filter((x) => x.kind === 'supply').length} / ${layout.registers.filter((x) => x.kind === 'return').length}` : '—',
    ],
    { bold: true },
  );

  // Duct schedule + warnings + assumptions
  if (y > PAGE.h - PAGE.m - 200) {
    doc.addPage();
    header(`Equipment & ducts  ·  ${date}`);
    y = PAGE.m + 60;
  } else y += 16;
  const top = y;
  font(10, 'bold');
  doc.text('Duct schedule', PAGE.m, y);
  y += 16;
  const sched = new Map<string, { count: number; length: number }>();
  for (const d of result.ducts) {
    const key = `${d.side === 'supply' ? 'Supply' : 'Return'} ${d.type} · ${d.diameter}" round`;
    const e = sched.get(key) ?? { count: 0, length: 0 };
    e.count += 1;
    e.length += d.length;
    sched.set(key, e);
  }
  for (const [k, v] of [...sched.entries()].sort()) {
    font(8);
    doc.text(k, PAGE.m, y);
    doc.text(`${v.count} pcs`, PAGE.m + 200, y, { align: 'right' });
    doc.text(`${v.length.toFixed(0)} ft`, PAGE.m + 250, y, { align: 'right' });
    y += 12;
  }
  font(7, 'normal', C.muted);
  doc.text('Sized from a round-duct table at 0.08 in. w.c. per 100 ft.', PAGE.m, y + 4);

  let y2 = top;
  const x2 = PAGE.m + 300;
  font(10, 'bold');
  doc.text('Warnings', x2, y2);
  y2 += 16;
  if (!result.warnings.length) {
    font(8, 'normal', [21, 128, 61]);
    doc.text('No open warnings: every check passes.', x2, y2);
    y2 += 12;
  }
  for (const w of result.warnings.slice(0, 14)) {
    font(8, 'normal', w.severity === 'error' ? C.danger : C.amber);
    const lines = doc.splitTextToSize(`• ${w.message}`, PAGE.w - PAGE.m - x2);
    doc.text(lines, x2, y2);
    y2 += 11 * lines.length;
  }
  if (result.warnings.length > 14) {
    font(8, 'normal', C.muted);
    doc.text(`…and ${result.warnings.length - 14} more`, x2, y2);
    y2 += 11;
  }
  y2 += 10;
  font(10, 'bold');
  doc.text('Method & assumptions', x2, y2);
  y2 += 14;
  font(7.5, 'normal', C.muted);
  const notes = [
    `Loads: ${result.loadModelName}. Floor area × climate-zone factor, plus window gain by facing, exterior wall area and ceiling height above 8 ft.`,
    'Airflow: 400 CFM per ton (12,000 BTU/h). Equipment rounded up to the next nominal size; airflow shared across rooms by load.',
    'Delivered airflow is reduced on branches longer than 20 ft as a rough allowance for static-pressure loss.',
    'This is not an ACCA Manual J, S or D calculation and must not be used for permitting or final equipment selection.',
  ];
  for (const n of notes) {
    const lines = doc.splitTextToSize(n, PAGE.w - PAGE.m - x2);
    doc.text(lines, x2, y2);
    y2 += 10 * lines.length + 3;
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    color('draw', C.line);
    doc.setLineWidth(0.5);
    doc.line(PAGE.m, PAGE.h - PAGE.m + 4, PAGE.w - PAGE.m, PAGE.h - PAGE.m + 4);
    font(7.5, 'bold', C.amber);
    doc.text(`${ESTIMATE_LABEL.toUpperCase()}.`, PAGE.m, PAGE.h - PAGE.m + 16);
    font(7.5, 'normal', C.muted);
    doc.text('Simplified estimates for discussion only; not ACCA Manual J/S/D. Generated by HVAC Layout Tool v1 prototype.', PAGE.m + doc.getTextWidth(`${ESTIMATE_LABEL.toUpperCase()}.  `) + 6, PAGE.h - PAGE.m + 16);
    doc.text(`Page ${i} of ${pages}`, PAGE.w - PAGE.m, PAGE.h - PAGE.m + 16, { align: 'right' });
  }
  return doc;
}
