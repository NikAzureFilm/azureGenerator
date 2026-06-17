import * as Sentry from '@sentry/react';
import { HeartCrack, RefreshCw } from 'lucide-react';
import { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * ErrorBoundary - Catches render errors in a subtree so one crashing
 * component (e.g. the 3D viewer hitting a WebGL edge case) doesn't take
 * down the whole view. Errors are reported to Sentry and the user gets a
 * reset affordance instead of a blank screen.
 */
export function ErrorBoundary({
  children,
  label,
}: {
  children: ReactNode;
  /** Short description of the wrapped area, e.g. "3D viewer" */
  label?: string;
}) {
  return (
    <Sentry.ErrorBoundary
      fallback={({ resetError }) => (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-adam-text-primary">
          <HeartCrack className="h-10 w-10" />
          <span>
            {label ? `The ${label} ran into a problem` : 'Something went wrong'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={resetError}
            className="gap-1.5"
          >
            <RefreshCw className="h-3 w-3" />
            Try again
          </Button>
        </div>
      )}
    >
      {children}
    </Sentry.ErrorBoundary>
  );
}
