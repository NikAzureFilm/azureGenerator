import { ImageGallery } from '@/components/viewer/ImageGallery';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import Loader from '@/components/viewer/Loader';
import { LazyOpenSCADPreview } from './LazyOpenSCADPreview';
import { ArtifactVersionSwitcher } from '@/components/viewer/ArtifactVersionSwitcher';
import OpenSCADError from '@/lib/OpenSCADError';
import { ParametricArtifact } from '@shared/types';
import { DxfExporter } from '@/utils/downloadUtils';

interface ParametricPreviewSectionProps {
  isLoading: boolean;
  color: string;
  onOutputChange?: (output: Blob | undefined) => void;
  onDxfExportChange?: (exporter: DxfExporter | null) => void;
  fixError?: (error: OpenSCADError) => void;
  isMobile?: boolean;
  // Artifact version history: the full version list, the selected index and a
  // setter. When omitted (mobile) the section renders the live artifact as before.
  versions?: ParametricArtifact[];
  selectedVersionIndex?: number;
  onSelectVersion?: (index: number) => void;
  // Code of the selected version; falls back to the live artifact's code.
  selectedCode?: string;
}

export function ParametricPreviewSection({
  isLoading,
  color,
  onOutputChange,
  onDxfExportChange,
  fixError,
  isMobile,
  versions,
  selectedVersionIndex,
  onSelectVersion,
  selectedCode,
}: ParametricPreviewSectionProps) {
  const { currentMessage: message } = useCurrentMessage();
  const scadCode = selectedCode ?? message?.content.artifact?.code;
  const showSwitcher =
    !isLoading &&
    versions !== undefined &&
    selectedVersionIndex !== undefined &&
    onSelectVersion !== undefined;

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-adam-neutral-700">
      {showSwitcher && (
        <ArtifactVersionSwitcher
          versions={versions}
          selectedIndex={selectedVersionIndex}
          onSelect={onSelectVersion}
        />
      )}
      {isLoading ? (
        <div
          className={`flex h-full w-full items-center justify-center ${isMobile ? 'pb-20 pt-0' : ''}`}
        >
          <Loader message="Generating model" />
        </div>
      ) : (
        <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-2">
          {message?.content.images && Array.isArray(message.content.images) && (
            <ImageGallery imageIds={message.content.images} />
          )}
          {scadCode ? (
            <LazyOpenSCADPreview
              scadCode={scadCode}
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
