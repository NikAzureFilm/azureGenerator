'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ModelViewer from './ModelViewer';
import type {
  OpenScadRenderRequest,
  OpenScadRenderResponse,
} from './openscadWorker';

type ViewerParam = {
  name: string;
  type?: string;
  value: unknown;
};

type Phase =
  | { state: 'compiling'; startedAt: number }
  | { state: 'stl'; url: string }
  | { state: 'svg'; url: string }
  | { state: 'error'; message: string; log: string[] };

// Compiles the OpenSCAD artifact in a web worker (10 MB wasm, cached after
// the first model) and shows the result in the shared three.js viewer.
export default function OpenScadViewer({
  code,
  parameters,
}: {
  code: string;
  parameters: ViewerParam[];
}) {
  const [phase, setPhase] = useState<Phase>({
    state: 'compiling',
    startedAt: Date.now(),
  });
  const [elapsed, setElapsed] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  const render = useCallback(() => {
    workerRef.current?.terminate();
    releaseObjectUrl();
    setPhase({ state: 'compiling', startedAt: Date.now() });

    const worker = new Worker(new URL('./openscadWorker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<OpenScadRenderResponse>) => {
      const message = event.data;
      if (message.ok && message.kind === 'stl') {
        const url = URL.createObjectURL(
          new Blob([message.data], { type: 'model/stl' }),
        );
        objectUrlRef.current = url;
        setPhase({ state: 'stl', url });
      } else if (message.ok && message.kind === 'svg') {
        const url = URL.createObjectURL(
          new Blob([message.data], { type: 'image/svg+xml' }),
        );
        objectUrlRef.current = url;
        setPhase({ state: 'svg', url });
      } else if (!message.ok) {
        setPhase({
          state: 'error',
          message: message.error,
          log: message.log.slice(-12),
        });
      }
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.onerror = (event) => {
      setPhase({
        state: 'error',
        message: event.message || 'Render worker failed',
        log: [],
      });
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    const request: OpenScadRenderRequest = {
      code,
      params: parameters.map(({ name, type, value }) => ({
        name,
        type,
        value,
      })),
    };
    worker.postMessage(request);
  }, [code, parameters]);

  useEffect(() => {
    render();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      releaseObjectUrl();
    };
  }, [render]);

  useEffect(() => {
    if (phase.state !== 'compiling') return;
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - phase.startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [phase]);

  if (phase.state === 'stl') {
    return <ModelViewer src={phase.url} format="stl" />;
  }

  if (phase.state === 'svg') {
    return (
      <div className="viewer">
        <div className="viewer-canvas svg-canvas" style={{ height: 460 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={phase.url} alt="2D model preview" />
        </div>
        <div className="viewer-toolbar">
          <span className="muted tiny">2D model - rendered as SVG</span>
        </div>
      </div>
    );
  }

  if (phase.state === 'error') {
    return (
      <div className="viewer">
        <div className="viewer-canvas" style={{ height: 220 }}>
          <div className="viewer-overlay">
            <div>
              <div className="error-inline">{phase.message}</div>
              {phase.log.length > 0 && (
                <pre className="code-block compile-log">
                  {phase.log.join('\n')}
                </pre>
              )}
            </div>
          </div>
        </div>
        <div className="viewer-toolbar">
          <span className="muted tiny">
            Compiled in-browser with OpenSCAD WASM
          </span>
          <button type="button" className="btn" onClick={render}>
            Retry render
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer-canvas" style={{ height: 460 }}>
        <div className="viewer-overlay muted">
          Compiling OpenSCAD model in your browser...
          {elapsed > 2 ? ` (${elapsed}s)` : ''}
          {elapsed > 15 ? ' - complex models can take a while' : ''}
        </div>
      </div>
      <div className="viewer-toolbar">
        <span className="muted tiny">
          First render downloads the ~10 MB OpenSCAD engine; it is cached after
          that.
        </span>
      </div>
    </div>
  );
}
