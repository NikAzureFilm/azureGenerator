import { useEffect, useRef, useState } from 'react';
import { BufferGeometry } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { CircleAlert } from 'lucide-react';
import { CadJob } from '@shared/types';
import { ThreeScene } from './ThreeScene';
import { CadLoadingPreview } from './CadLoadingPreview';

interface CadJobPreviewProps {
  cadJob: CadJob;
  color: string;
  onOutputChange?: (output: Blob | undefined) => void;
  isMobile?: boolean;
  backgroundColor?: string;
}

type PreviewState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; geometry: BufferGeometry }
  | { status: 'error'; message: string };

function disposeGeometry(geometry: BufferGeometry | null) {
  geometry?.dispose();
}

export function CadJobPreview({
  cadJob,
  color,
  onOutputChange,
  isMobile,
  backgroundColor,
}: CadJobPreviewProps) {
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const geometryRef = useRef<BufferGeometry | null>(null);
  const stlPath = cadJob.artifacts?.stlPath;

  useEffect(() => {
    if (cadJob.status === 'pending') {
      setPreview({ status: 'loading' });
      return;
    }

    if (cadJob.status === 'failure') {
      setPreview({
        status: 'error',
        message: cadJob.error || 'STEP CAD generation failed.',
      });
      return;
    }

    if (!stlPath) {
      setPreview({
        status: 'error',
        message: 'No web preview artifact was returned for this STEP job.',
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setPreview({ status: 'loading' });

    fetch(stlPath, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Preview artifact returned ${response.status}`);
        }
        return response.blob();
      })
      .then(async (blob) => {
        if (cancelled) return;
        onOutputChange?.(blob);

        const buffer = await blob.arrayBuffer();
        if (cancelled) return;

        const loader = new STLLoader();
        const geometry = loader.parse(buffer);
        geometry.center();
        geometry.computeVertexNormals();

        disposeGeometry(geometryRef.current);
        geometryRef.current = geometry;
        setPreview({ status: 'ready', geometry });
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setPreview({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to load STEP CAD preview.',
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cadJob.error, cadJob.status, onOutputChange, stlPath]);

  useEffect(() => {
    return () => {
      disposeGeometry(geometryRef.current);
      geometryRef.current = null;
      onOutputChange?.(undefined);
    };
  }, [onOutputChange]);

  if (preview.status === 'ready') {
    return (
      <div className="h-full w-full" data-testid="cad-job-preview">
        <ThreeScene
          geometry={preview.geometry}
          color={color}
          isMobile={isMobile}
          backgroundColor={backgroundColor}
        />
      </div>
    );
  }

  if (preview.status === 'error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-adam-text-primary">
        <CircleAlert className="h-8 w-8 text-adam-blue" />
        <p className="max-w-sm text-sm font-medium">{preview.message}</p>
      </div>
    );
  }

  return (
    <CadLoadingPreview
      generationId={cadJob.id}
      label={
        cadJob.status === 'pending'
          ? 'Generating STEP CAD model...'
          : 'Loading STEP CAD preview...'
      }
    />
  );
}
