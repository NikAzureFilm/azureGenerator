import { lazy, Suspense, type ComponentProps } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import Loader from '@/components/viewer/Loader';

// Loaded on demand so three.js and the OpenSCAD WASM toolchain stay out of
// the initial bundle for users who never open a parametric preview.
const OpenSCADPreview = lazy(() =>
  import('./OpenSCADViewer').then((module) => ({
    default: module.OpenSCADPreview,
  })),
);

export function LazyOpenSCADPreview(
  props: ComponentProps<typeof OpenSCADPreview>,
) {
  return (
    <ErrorBoundary label="3D viewer">
      <Suspense fallback={<Loader message="Loading viewer" />}>
        <OpenSCADPreview {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
