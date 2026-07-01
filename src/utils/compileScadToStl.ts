import {
  OpenSCADWorkerResponseData,
  WorkerMessage,
  WorkerMessageType,
} from '@/worker/types';

/**
 * Compile OpenSCAD source to a binary STL Blob using a transient worker.
 *
 * Unlike the `useOpenSCAD` hook (which keeps a worker alive for an interactive
 * viewer), this spins up a one-shot worker, runs a single EXPORT, and
 * terminates it. That keeps thumbnail generation from holding a persistent
 * OpenSCAD worker per list/sidebar row.
 */
export async function compileScadToStl(code: string): Promise<Blob> {
  const worker = new Worker(new URL('../worker/worker.ts', import.meta.url), {
    type: 'module',
  });

  try {
    const requestId = `thumb-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const response = await new Promise<OpenSCADWorkerResponseData>(
      (resolve, reject) => {
        const handleMessage = (event: MessageEvent) => {
          const data = event.data;
          if (!data || data.id !== requestId) return;

          worker.removeEventListener('message', handleMessage);

          if (data.err) {
            reject(new Error(data.err.message || 'OpenSCAD compile failed'));
          } else {
            resolve(data.data as OpenSCADWorkerResponseData);
          }
        };

        worker.addEventListener('message', handleMessage);

        const message: WorkerMessage & { id: string } = {
          id: requestId,
          type: WorkerMessageType.EXPORT,
          data: { code, params: [], fileType: 'stl' },
        };

        worker.postMessage(message);
      },
    );

    if (!response.output) {
      throw new Error('OpenSCAD did not return an STL output');
    }

    // Copy worker bytes into a normal ArrayBuffer-backed view for the Blob.
    const bytes = new Uint8Array(response.output);
    return new Blob([bytes], { type: 'model/stl' });
  } finally {
    worker.terminate();
  }
}
