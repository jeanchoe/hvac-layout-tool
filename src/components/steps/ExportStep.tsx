import { useEffect, useState } from 'react';
import { buildReport } from '../../export/pdfReport';
import { fmtBtuh, fmtCfm, fmtSqFt } from '../../lib/format';
import { downloadBlob, safeFileName, saveProjectFile } from '../../lib/fileIO';
import { useEngine } from '../../state/engine';
import { useStore } from '../../state/store';
import { Button, EstimateBadge, Stat } from '../ui';

export function ExportStep() {
  const project = useStore((s) => s.project);
  const setStep = useStore((s) => s.setStep);
  const result = useEngine();
  const [pdf, setPdf] = useState<{ url: string; blob: Blob } | null>(null);

  useEffect(() => {
    const blob = buildReport(project, result).output('blob');
    const url = URL.createObjectURL(blob);
    setPdf({ url, blob });
    return () => URL.revokeObjectURL(url);
  }, [project, result]);
  const url = pdf?.url;

  const fileName = `${safeFileName(project.name)}-hvac-report.pdf`;
  const layout = project.layout;

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="min-h-[60vh] min-w-0 flex-1 bg-gray-100 p-4">
        {url ? <iframe title="Report preview" src={`${url}#view=FitH`} className="h-full w-full rounded border border-gray-200 bg-white" /> : <div className="p-8 text-sm text-gray-500">Building report…</div>}
      </div>
      <aside className="w-full shrink-0 space-y-5 overflow-y-auto border-t border-gray-200 bg-white p-5 lg:w-80 lg:border-l lg:border-t-0">
        <div>
          <h2 className="text-base font-semibold">Report</h2>
          <p className="mt-1 text-xs text-gray-500">Plan view with components, a room-by-room table and the equipment summary.</p>
        </div>
        <EstimateBadge />
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Area" value={fmtSqFt(result.totals.areaSqFt)} />
          <Stat label="System" value={layout ? `${layout.airHandler.tons} ton` : '—'} sub={layout ? fmtCfm(layout.airHandler.airflowCfm) : undefined} />
          <Stat label="Cooling" value={fmtBtuh(result.totals.coolingBtuh)} />
          <Stat label="Warnings" value={result.warnings.length} />
        </div>
        {result.warnings.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            The layout still has {result.warnings.length} warning{result.warnings.length > 1 ? 's' : ''}. They are listed in the report.{' '}
            <button className="underline" onClick={() => setStep(4)}>
              Back to layout
            </button>
          </p>
        )}
        <div className="space-y-2">
          <Button variant="primary" className="w-full !py-2" disabled={!pdf} onClick={() => pdf && downloadBlob(pdf.blob, fileName)}>
            Download PDF
          </Button>
          <Button className="w-full" onClick={() => saveProjectFile(project)}>
            Save project file (.json)
          </Button>
        </div>
      </aside>
    </div>
  );
}
