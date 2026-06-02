import { ImageGallery } from '@/components/viewer/ImageGallery';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import Loader from '@/components/viewer/Loader';
import { OpenSCADPreview } from './OpenSCADViewer';
import OpenSCADError from '@/lib/OpenSCADError';
import { DxfExporter } from '@/utils/downloadUtils';
import { CadJobPreview } from './CadJobPreview';

interface ParametricPreviewSectionProps {
  isLoading: boolean;
  color: string;
  onOutputChange?: (output: Blob | undefined) => void;
  onDxfExportChange?: (exporter: DxfExporter | null) => void;
  fixError?: (error: OpenSCADError) => void;
  isMobile?: boolean;
}

export function ParametricPreviewSection({
  isLoading,
  color,
  onOutputChange,
  onDxfExportChange,
  fixError,
  isMobile,
}: ParametricPreviewSectionProps) {
  const { currentMessage: message } = useCurrentMessage();
  const cadJob = message?.content.cadJob;

  return (
    <div className="flex h-full w-full items-center justify-center bg-adam-neutral-700">
      {isLoading ? (
        <div
          className={`flex h-full items-center justify-center ${isMobile ? 'pb-20 pt-0' : ''}`}
        >
          <Loader message="Generating model" />
        </div>
      ) : (
        <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-2">
          {message?.content.images && Array.isArray(message.content.images) && (
            <ImageGallery imageIds={message.content.images} />
          )}
          {cadJob ? (
            <CadJobPreview
              cadJob={cadJob}
              color={color}
              onOutputChange={onOutputChange}
              isMobile={isMobile}
            />
          ) : message?.content.artifact?.code ? (
            <OpenSCADPreview
              scadCode={message.content.artifact.code}
              color={color}
              onOutputChange={onOutputChange}
              onDxfExportChange={onDxfExportChange}
              fixError={fixError}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
