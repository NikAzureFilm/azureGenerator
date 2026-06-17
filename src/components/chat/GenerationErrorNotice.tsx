import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  KNOWN_GENERATION_ERRORS,
  describeGenerationError,
} from '@/utils/generationErrors';

export function GenerationErrorNotice({
  error,
  onRetry,
  disabled,
}: {
  error: string;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const friendly = describeGenerationError(error);
  // Show the raw error when it carries information the friendly copy lost
  // (worker messages, tracebacks) — but never for opaque internal codes.
  const showDetail =
    !KNOWN_GENERATION_ERRORS[error] &&
    friendly !== error &&
    error.length > 3 &&
    error.length <= 500;

  return (
    <div className="flex flex-col gap-2 px-1">
      <span>{friendly}</span>
      {showDetail && (
        <details className="text-xs text-adam-neutral-400">
          <summary className="cursor-pointer select-none">
            Technical details
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-adam-neutral-950 p-2">
            {error}
          </pre>
        </details>
      )}
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={disabled}
          className="w-fit gap-1.5"
        >
          <RefreshCw className="h-3 w-3" />
          Try again
        </Button>
      )}
    </div>
  );
}
