import { jsPDF } from 'jspdf';
import { sortedFloors, type DesignKey, type EngineResult, type LoadLine } from '../engine';
import { bbox, centroid, lerp } from '../engine/geometry';
import { BUILDING_TYPES, ESTIMATE_LABEL, SYSTEM_TYPES } from '../lib/catalog';
import { ductSize, fmtInt } from '../lib/format';
import type { Project, Pt } from '../types';

type RGB = [number, number, number];
const C = {
  ink: [17, 24, 39] as RGB,
  muted: [107, 114, 128] as RGB,
  line: [229, 231, 235] as RGB,
  accent: [37, 99, 235] as RGB,
  // Drafting colours: supply dark blue, return pink.
  supply: [30, 64, 175] as RGB,
  ret: [219, 39, 119] as RGB,
  danger: [220, 38, 38] as RGB,
  amberBg: [255, 251, 235] as RGB,
  amber: [146, 64, 14] as RGB,
  window: [125, 211, 252] as RGB,
};

const PAGE = { w: 792, h: 612, m: 36 };

/** The report for the whole building: one plan page per floor, then building-wide tables. */
export function buildReport(project: Project, results: Record<string, EngineResult>): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const floors = sortedFloors(project.floors).filter((f) => results[f.id]);
  const multi = floors.length > 1;
  const building = results[floors[0].id].building;
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

  // ---------- One plan page per floor ----------
  let y = 0;
  floors.forEach((floor, fi) => {
  if (fi) doc.addPage();
  const result = results[floor.id];
  const layout = project.layouts[floor.id];
  header(`Plan view${multi ? `  ·  ${floor.name}` : ''}  ·  ${date}`);
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

    // Equipment areas and beams on this floor.
    for (const a of (project.equipmentAreas ?? []).filter((x) => x.floorId === floor.id)) {
      color('fill', [209, 250, 229]);
      color('draw', [5, 150, 105]);
      doc.setLineWidth(0.6);
      doc.setLineDashPattern([2, 1.5], 0);
      polygon(a.polygon.map(P), 'FD');
      doc.setLineDashPattern([], 0);
      const c = P(centroid(a.polygon));
      font(6, 'bold', [4, 120, 87]);
      doc.text(a.name, c.x, c.y + 10, { align: 'center' });
    }
    (project.beams ?? [])
      .filter((x) => x.floorId === floor.id)
      .forEach((bm, i) => {
        const a = P(bm.a);
        const c = P(bm.b);
        color('draw', bm.kind === 'main' ? [127, 29, 29] : [87, 83, 78]);
        doc.setLineWidth(bm.kind === 'main' ? 2.2 : 1.2);
        doc.setLineDashPattern(bm.kind === 'main' ? [] : [4, 2], 0);
        doc.line(a.x, a.y, c.x, c.y);
        doc.setLineDashPattern([], 0);
        font(6, 'bold', bm.kind === 'main' ? [127, 29, 29] : [68, 64, 60]);
        doc.text(`B-${i + 1}`, (a.x + c.x) / 2 + 3, (a.y + c.y) / 2 - 3);
      });

    if (layout) {
      const warned = new Set(result.warnings.flatMap((w) => w.componentIds));
      for (const d of [...result.ducts].sort((p, q) => (p.side === 'return' ? -1 : 1) - (q.side === 'return' ? -1 : 1))) {
        color('draw', warned.has(d.id) ? C.danger : d.side === 'supply' ? C.supply : C.ret);
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
        const c = warned.has(r.id) ? C.danger : r.kind === 'supply' ? C.supply : C.ret;
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
  y = box.y + 4;
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
  if (multi) kv('Floor', `${floor.name} (${floor.level + 1} of ${floors.length})`);
  kv(multi ? 'Area, this floor' : 'Conditioned area', `${fmtInt(result.totals.areaSqFt)} sq ft`);
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
  const fr = result.framing;
  kv('Ducts run', fr.ductSpace === 'attic' ? 'In attic' : fr.ductSpace === 'plenum' ? `Ceiling plenum, ${fr.plenumDepthIn}" deep` : `Between ${fr.depthIn}" joists, ${fr.spacingIn}" o.c.`);
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
  legend(C.supply, 'Supply duct (width ~ size)', 'line');
  legend(C.ret, 'Return duct', 'dash');
  legend(C.supply, 'Supply register', 'box');
  legend(C.ret, 'Return grille', 'grille');
  legend(C.ink, 'Air handler (AHU)', 'ahu');
  legend(C.danger, 'Has a warning', 'line');
  legend(C.window, 'Window', 'line');
  if ((project.beams ?? []).some((x) => x.floorId === floor.id)) {
    legend([127, 29, 29], 'Main beam (not crossed)', 'line');
    legend([87, 83, 78], 'Secondary beam', 'dash');
  }
  if ((project.equipmentAreas ?? []).some((x) => x.floorId === floor.id)) legend([5, 150, 105], 'Equipment area', 'box');
  });

  // Building-wide figures for the tables that follow.
  const roomsAll = floors.flatMap((f) => results[f.id].rooms);
  const registersAll = floors.flatMap((f) => project.layouts[f.id]?.registers ?? []);
  const result = {
    loads: building.loads,
    walls: building.walls,
    totals: building.totals,
    design: building.design,
    loadModelName: building.loadModelName,
    airflow: Object.assign({}, ...floors.map((f) => results[f.id].airflow)) as EngineResult['airflow'],
    ducts: floors.flatMap((f) => results[f.id].ducts),
    warnings: floors.flatMap((f) => results[f.id].warnings.map((w) => (multi ? { ...w, message: `${f.name}: ${w.message}` } : w))),
  };
  const rooms = roomsAll;

  // ---------- Page 2+: room table ----------
  doc.addPage();
  header(`Room-by-room estimate  ·  ${date}`);
  const cols = [
    { h: 'Room', w: 120, a: 'left' as const },
    { h: 'Area (sq ft)', w: 52 },
    { h: 'Ceiling (ft)', w: 48 },
    { h: 'Ext. walls (ft)', w: 58 },
    { h: 'Windows (sq ft)', w: 60 },
    { h: 'Sensible (BTU/h)', w: 70 },
    { h: 'Latent (BTU/h)', w: 58 },
    { h: 'Heating (BTU/h)', w: 70 },
    { h: 'Design CFM', w: 62 },
    { h: 'Delivered CFM', w: 66 },
    { h: 'Supply / Ret.', w: 56 },
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
      font(opts.head ? 7 : 8, opts.bold || opts.head ? 'bold' : 'normal', opts.head ? C.muted : opts.red && i === 9 ? C.danger : C.ink);
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
  let floorShown = '';
  for (const r of rooms) {
    if (multi && r.floorId !== floorShown) {
      floorShown = r.floorId;
      font(8.5, 'bold', C.accent);
      doc.text(floors.find((f) => f.id === r.floorId)!.name, PAGE.m + 4, y + 2);
      y += 15;
    }
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
    const regs = registersAll.filter((x) => x.roomId === r.id);
    const low = !!air && air.delivered < air.required * 0.9;
    drawRow(
      [
        r.name,
        fmtInt(load.areaSqFt),
        r.ceilingHeight.toFixed(1),
        ext.toFixed(0),
        fmtInt(win),
        fmtInt(load.sensibleCoolingBtuh),
        fmtInt(load.latentCoolingBtuh),
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
      fmtInt(result.totals.sensibleCoolingBtuh),
      fmtInt(result.totals.latentCoolingBtuh),
      fmtInt(result.totals.heatingBtuh),
      fmtInt(result.loads.reduce((s, l) => s + l.requiredCfm, 0)),
      registersAll.length ? fmtInt(totalDelivered) : '—',
      registersAll.length ? `${registersAll.filter((x) => x.kind === 'supply').length} / ${registersAll.filter((x) => x.kind === 'return').length}` : '—',
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
    const key = `${d.side === 'supply' ? 'Supply' : 'Return'} ${d.type} · ${ductSize(d)}`;
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
  doc.text('Sized from a round-duct table at 0.08 in. w.c. per 100 ft; rectangles use the ASHRAE equivalent diameter.', PAGE.m, y + 4);

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
    `Loads: ${result.loadModelName} Inputs and sources are listed on the next page.`,
    'Airflow: 400 CFM per nominal ton. Equipment is the next nominal size above the total load; each room gets a share of the blower airflow by its sensible load.',
    'Delivered airflow is reduced on branches longer than 20 ft as a rough allowance for static-pressure loss.',
    'This is not an ACCA Manual J, S or D calculation and must not be used for permitting or final equipment selection.',
  ];
  for (const n of notes) {
    const lines = doc.splitTextToSize(n, PAGE.w - PAGE.m - x2);
    doc.text(lines, x2, y2);
    y2 += 10 * lines.length + 3;
  }

  // ---------- Load inputs & sources ----------
  doc.addPage();
  header(`Load method & inputs  ·  ${date}`);
  y = PAGE.m + 60;
  font(10, 'bold');
  doc.text('Inputs used', PAGE.m, y);
  y += 16;
  const inputs: [DesignKey, string, (v: number) => string][] = [
    ['outdoorCoolingF', 'Outdoor design, summer', (v) => `${v}°F`],
    ['indoorCoolingF', 'Indoor design, summer', (v) => `${v}°F`],
    ['outdoorHeatingF', 'Outdoor design, winter', (v) => `${v}°F`],
    ['indoorHeatingF', 'Indoor design, winter', (v) => `${v}°F`],
    ['grainsDifference', 'Moisture difference', (v) => `${v} gr/lb`],
    ['wallU', 'Wall U-factor', (v) => v.toFixed(3)],
    ['windowU', 'Window U-factor', (v) => v.toFixed(2)],
    ['windowShgc', 'Window SHGC', (v) => v.toFixed(2)],
    ['ceilingU', 'Ceiling U-factor', (v) => v.toFixed(3)],
    ['floorU', 'Floor U-factor', (v) => v.toFixed(3)],
    ['slabF', 'Slab edge F-factor', (v) => v.toFixed(2)],
    ['ach', 'Infiltration', (v) => `${v} ACH`],
    ['ductLoadFactor', 'Duct load allowance', (v) => `${Math.round(v * 100)}%`],
  ];
  for (const [key, label, show] of inputs) {
    const d = result.design[key];
    font(8, 'normal');
    doc.text(label, PAGE.m, y);
    font(8, 'bold', d.overridden ? C.accent : C.ink);
    doc.text(show(d.value), PAGE.m + 150, y, { align: 'right' });
    font(7, 'normal', C.muted);
    const src = doc.splitTextToSize(d.source, 300);
    doc.text(src[0] + (src.length > 1 ? '…' : ''), PAGE.m + 162, y);
    y += 13;
  }
  font(7, 'normal', C.muted);
  doc.text('Values in blue were entered for this project; the rest are climate-zone defaults.', PAGE.m, y + 4);

  // Whole-house breakdown by line
  let yb = PAGE.m + 60;
  const xb = PAGE.m + 500;
  font(10, 'bold');
  doc.text('Whole-house breakdown (BTU/h)', xb, yb);
  yb += 16;
  const group = (title: string, pick: (l: (typeof result.loads)[0]) => LoadLine[]) => {
    const byLabel = new Map<string, number>();
    for (const l of result.loads) for (const ln of pick(l)) byLabel.set(ln.label.replace(/ \(.*\)$/, ''), (byLabel.get(ln.label.replace(/ \(.*\)$/, '')) ?? 0) + ln.btuh);
    font(7.5, 'bold', C.muted);
    doc.text(title.toUpperCase(), xb, yb);
    yb += 11;
    let total = 0;
    for (const [label, v] of byLabel) {
      if (v < 0.5) continue;
      total += v;
      font(8);
      doc.text(label, xb, yb);
      doc.text(fmtInt(v), PAGE.w - PAGE.m, yb, { align: 'right' });
      yb += 11;
    }
    font(8, 'bold');
    doc.text('Total', xb, yb);
    doc.text(fmtInt(total), PAGE.w - PAGE.m, yb, { align: 'right' });
    yb += 16;
  };
  group('Cooling, sensible', (l) => l.cooling);
  group('Cooling, latent', (l) => l.latent);
  group('Heating', (l) => l.heating);

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
