import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// Loaded on demand so three.js and the model loaders stay out of the
// initial bundle for users who never open a 3D preview.
const MeshPreview = lazy(() =>
  import('./MeshPreview').then((module) => ({ default: module.MeshPreview })),
);

export function LazyMeshPreview({ meshId }: { meshId: string }) {
  return (
    <ErrorBoundary label="3D viewer">
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-10 w-10 animate-spin" />
          </div>
        }
      >
        <MeshPreview meshId={meshId} />
      </Suspense>
    </ErrorBoundary>
  );
}
