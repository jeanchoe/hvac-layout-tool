import { useEffect, useState } from 'react';
import { ACCEPTED_PLAN_TYPES, fileToBackground } from '../../lib/fileIO';
import { SAMPLE_PLANS, sampleLevels } from '../../samples/plans';
import { renderSamplePlanImage } from '../../samples/renderPlanImage';
import { currentFloor, useStore } from '../../state/store';
import { FloorTabs } from '../FloorTabs';
import type { BackgroundImage } from '../../types';
import { Button, Panel } from '../ui';

/** Grid used when the user draws without a floor plan image. */
export const BLANK_GRID: Omit<BackgroundImage, 'dataUrl'> & { pxPerFt: number } = { width: 2000, height: 1400, fileName: '', pxPerFt: 20 };

export function UploadStep() {
  const floor = useStore((s) => currentFloor(s));
  const background = floor.background;
  const hasRooms = useStore((s) => s.project.rooms.some((r) => r.floorId === floor.id));
  const update = useStore((s) => s.update);
  const setStep = useStore((s) => s.setStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const useBackground = (bg: BackgroundImage) => {
    update((d) => {
      const f = d.floors.find((x) => x.id === floor.id)!;
      f.background = bg;
      // A new image means a new pixel space: the old scale no longer applies.
      f.scalePxPerFt = null;
      f.scaleLine = null;
    });
    useStore.getState().setTraceTool('scale');
    setStep(2);
  };

  const handleFile = async (file: File | null | undefined) => {
    if (!file) {
      setError('No file came through. If you dragged the image from a web page or chat, save it to your computer first, then drop or choose the saved file.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      useBackground(await fileToBackground(file));
    } catch (e) {
      setError((e as Error).message || 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  // A screenshot on the clipboard can be pasted straight in.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
      if (file) {
        e.preventDefault();
        handleFile(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  return (
    <>
    <FloorTabs note={`Upload the plan for ${floor.name}.`} />
    <div className="mx-auto grid max-w-5xl gap-6 px-4 py-8 lg:grid-cols-[1fr_300px]">
      <div>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files[0]);
          }}
          className={`flex h-80 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-center transition ${
            dragOver ? 'border-accent bg-accent-soft' : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          <input
            type="file"
            accept={ACCEPTED_PLAN_TYPES}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Clear it so choosing the same file again still triggers a change.
              e.target.value = '';
              if (file) handleFile(file);
            }}
          />
          <div className="text-3xl text-gray-300">⬆</div>
          <div className="mt-2 text-sm font-medium">{busy ? 'Reading file…' : 'Drop a floor plan here, or click to browse'}</div>
          <div className="mt-1 text-xs text-gray-500">PDF, PNG or JPG (a PDF's first page is used) · or paste a screenshot with Ctrl/⌘+V</div>
          {hasRooms && <div className="mt-2 text-xs text-amber-700">A new plan clears the scale. Traced rooms stay but may need re-aligning.</div>}
        </label>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        {background && (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-gray-600">
                Current plan: <span className="font-medium text-gray-900">{background.fileName || 'image'}</span> ({background.width}×{background.height}px)
              </span>
              <Button variant="primary" onClick={() => setStep(2)}>
                Continue →
              </Button>
            </div>
            <img src={background.dataUrl} alt="Floor plan" className="max-h-72 w-full rounded border border-gray-200 object-contain" />
          </div>
        )}
      </div>
      <div className="space-y-4">
        <Panel title="No plan handy?">
          <p className="mb-3 text-xs text-gray-500">Use a sample floor plan image to try tracing, or draw on a blank grid.</p>
          <div className="space-y-2">
            {SAMPLE_PLANS.map((plan) => (
              <Button key={plan.id} className="w-full !justify-start" onClick={() => useBackground(renderSamplePlanImage(plan, sampleLevels(plan).includes(floor.level) ? floor.level : 0))}>
                {plan.name}
              </Button>
            ))}
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                update((d) => {
                  const f = d.floors.find((x) => x.id === floor.id)!;
                  f.background = null;
                  f.scalePxPerFt = BLANK_GRID.pxPerFt;
                  f.scaleLine = null;
                });
                useStore.getState().setTraceTool('draw');
                setStep(2);
              }}
            >
              Draw on a blank grid
            </Button>
          </div>
        </Panel>
      </div>
    </div>
    </>
  );
}
