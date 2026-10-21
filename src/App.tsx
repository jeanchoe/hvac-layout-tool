import { useEffect } from 'react';
import { Header } from './components/Header';
import { Stepper } from './components/Stepper';
import { StartStep } from './components/steps/StartStep';
import { UploadStep } from './components/steps/UploadStep';
import { TraceStep } from './components/steps/TraceStep';
import { RoomsStep } from './components/steps/RoomsStep';
import { LayoutStep } from './components/steps/LayoutStep';
import { ExportStep } from './components/steps/ExportStep';
import { useStore } from './state/store';

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

export default function App() {
  const step = useStore((s) => s.step);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        useStore.getState().redo();
      } else if (k === 's') {
        e.preventDefault();
        import('./lib/fileIO').then((m) => m.saveProjectFile(useStore.getState().project));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header />
      <Stepper />
      <main className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        {step === 0 && <StartStep />}
        {step === 1 && <UploadStep />}
        {step === 2 && <TraceStep />}
        {step === 3 && <RoomsStep />}
        {step === 4 && <LayoutStep />}
        {step === 5 && <ExportStep />}
      </main>
    </div>
  );
}
