import {
  Brush,
  Check,
  DownloadIcon,
  Frown,
  Loader2,
  PlusIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useItemSelection } from '@/hooks/useItemSelection';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useImageData } from '@/hooks/useImageData';
import { useConversation } from '@/contexts/ConversationContext';
import { useAuth } from '@/contexts/AuthContext';
import { getSafeFilename } from '@/utils/file-utils';
import { ImageMaskEditDialog } from '@/components/ImageMaskEditDialog';

export function ImageViewer({
  image,
  className,
  hoverable = true,
  clickable = true,
  fit = 'cover',
}: {
  image: string;
  className?: string;
  hoverable?: boolean;
  clickable?: boolean;
  // Chat thumbnails crop to their square wrapper; a large preview pane shows
  // the whole render instead.
  fit?: 'cover' | 'contain';
}) {
  const [loaded, setLoaded] = useState(false);
  const [isMaskEditOpen, setIsMaskEditOpen] = useState(false);
  const { images, selectItem } = useItemSelection();
  const { conversation } = useConversation();
  const { session } = useAuth();

  const {
    data: { data: imageData, isLoading: isImageDataLoading },
    url: { data: imageUrl, isLoading: isImageLoading },
  } = useImageData(image);

  const isOwner = session?.user.id === conversation.user_id;

  const handleDownload = () => {
    const url = imageUrl?.url || '';
    // Parse MIME from the data URL (e.g. "data:image/jpeg;base64,...") so
    // the downloaded file's extension matches the actual bytes. gpt-image-2
    // generates jpeg, Gemini/Flux fallbacks generate png — hardcoding .png
    // would mislabel jpeg downloads and some viewers reject the mismatch.
    const mimeMatch = url.match(/^data:(image\/\w+);/);
    const mime = mimeMatch?.[1] ?? 'image/png';
    const ext =
      mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const link = document.createElement('a');
    link.href = url;
    const name = getSafeFilename(conversation.title);
    link.download = `${name}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const isSelected = useMemo(
    () => images.some((img) => img.id === image),
    [images, image],
  );

  if (imageData?.status === 'failure') {
    return (
      <div
        className={cn(
          'flex aspect-square h-full w-full flex-col items-center justify-center gap-2 rounded-lg text-adam-text-primary',
          className,
        )}
      >
        <Frown className="h-10 w-10" />
        <span>Image generation failed</span>
      </div>
    );
  }

  if (isImageDataLoading || isImageLoading || imageData?.status === 'pending') {
    return (
      <div
        className={cn(
          'flex aspect-square w-full items-center justify-center rounded-lg text-adam-text-primary',
          className,
        )}
      >
        <Loader2 className="h-10 w-10 animate-spin" />
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div
        className={cn(
          'flex aspect-square h-full w-full items-center justify-center rounded-lg text-adam-text-primary',
          className,
        )}
      >
        <Frown className="h-10 w-10" />
        <span>Image not found</span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        className={cn(
          'group relative flex w-full max-w-2xl items-center justify-center overflow-hidden rounded-lg',
          className,
        )}
      >
        <img
          className={cn(
            'h-full w-full',
            fit === 'contain' ? 'object-contain' : 'object-cover',
          )}
          src={imageUrl.url}
          alt="Image"
          onLoad={() => setLoaded(true)}
        />
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-adam-neutral-800/50 text-adam-text-primary">
            <Loader2 className="h-10 w-10 animate-spin" />
          </div>
        )}
        {clickable && (
          <>
            {/* Bottom shadow gradient that appears on hover */}
            <div
              className={`absolute inset-x-0 bottom-0 h-16 transition-opacity duration-300 ${hoverable ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
              style={{
                background:
                  'linear-gradient(to top, rgba(0,0,0,0.48) 0%, rgba(0,0,0,0) 100%)',
              }}
            />
            {/* Brush edit icon that appears on hover (owner only) */}
            {isOwner && imageData?.status === 'success' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    role="button"
                    aria-label="Edit with brush"
                    className={`absolute bottom-3 right-11 z-10 cursor-pointer transition-transform duration-200 hover:scale-110 ${hoverable ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsMaskEditOpen(true);
                    }}
                  >
                    <Brush className="h-5 w-5 text-white drop-shadow-[0px_2px_3px_rgba(0,0,0,0.4)]" />
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
                >
                  <p>Edit with brush</p>
                </TooltipContent>
              </Tooltip>
            )}
            {/* White download icon that appears on hover */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  role="button"
                  aria-label="Download image"
                  className={`absolute bottom-3 right-3 z-10 cursor-pointer transition-transform duration-200 hover:scale-110 ${hoverable ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
                  onClick={handleDownload}
                >
                  <DownloadIcon className="h-5 w-5 text-white drop-shadow-[0px_2px_3px_rgba(0,0,0,0.4)]" />
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
              >
                <p>Download image</p>
              </TooltipContent>
            </Tooltip>
            {/* Selected Image Checkbox */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  role="button"
                  aria-label={
                    isSelected ? 'Remove from selection' : 'Add to selection'
                  }
                  className={`absolute left-2 top-2 z-10 rounded-full p-1 ${isSelected ? 'bg-adam-blue' : 'bg-black'} cursor-pointer transition-transform duration-200 hover:scale-110 ${isSelected ? 'opacity-100' : hoverable ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectItem(
                      { id: image, source: 'selection', url: imageUrl.url },
                      'image',
                    );
                  }}
                >
                  {isSelected && <Check className="h-4 w-4 text-white" />}
                  {!isSelected && <PlusIcon className="h-4 w-4 text-white" />}
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
              >
                <p>
                  {isSelected ? 'Remove from selection' : 'Add to selection'}
                </p>
              </TooltipContent>
            </Tooltip>
            {isOwner && imageData?.status === 'success' && (
              <ImageMaskEditDialog
                open={isMaskEditOpen}
                onOpenChange={setIsMaskEditOpen}
                imageId={image}
                imageUrl={imageUrl.url}
                onEdited={({ id, url }) =>
                  selectItem({ id, source: 'selection', url }, 'image')
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
