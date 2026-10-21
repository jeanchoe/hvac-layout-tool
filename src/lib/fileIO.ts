import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { BackgroundImage, Project } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const imageSize = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = src;
  });

/** Renders the first page of a PDF to a PNG data URL, about 2000 px on its long side. */
async function pdfFirstPage(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 2000 / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

export const ACCEPTED_PLAN_TYPES = '.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf';

export async function fileToBackground(file: File): Promise<BackgroundImage> {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    return { ...(await pdfFirstPage(file)), fileName: file.name };
  }
  if (!/^image\/(png|jpeg)$/.test(file.type) && !/\.(png|jpe?g)$/.test(name)) {
    throw new Error('Please upload a PNG, JPG or PDF file.');
  }
  const dataUrl = await readAsDataUrl(file);
  return { dataUrl, ...(await imageSize(dataUrl)), fileName: file.name };
}

interface DownloadsApi {
  save(req: { filename: string; data: Blob }): Promise<unknown>;
}
type ClaudeWindow = { claude?: { use(name: 'downloads'): Promise<DownloadsApi | null> } };

/**
 * Offers a file to the user. Inside a published claude.ai page, plain downloads are blocked,
 * so this goes through the page's `downloads` capability; elsewhere it uses a normal link.
 */
export async function downloadBlob(blob: Blob, fileName: string) {
  const claude = (window as unknown as ClaudeWindow).claude;
  if (claude) {
    const downloads = await claude.use('downloads');
    if (downloads) {
      try {
        await downloads.save({ filename: fileName, data: blob });
      } catch {
        /* declined or unavailable: nothing to do */
      }
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (name: string) => name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || 'project';

export function saveProjectFile(project: Project) {
  downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${safeFileName(project.name)}.hvac.json`);
}

export async function readProjectFile(file: File): Promise<Project> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const p = data as Project;
  if (!p || p.schemaVersion !== 1 || !Array.isArray(p.rooms)) throw new Error('That file is not an HVAC Layout Tool project.');
  return p;
}

/** Opens the browser file picker and resolves with the chosen file. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
