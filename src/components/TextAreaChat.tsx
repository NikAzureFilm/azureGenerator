import React, {
  useState,
  useRef,
  ChangeEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useCallback,
} from 'react';
import {
  ArrowUp,
  ImagePlus,
  Images,
  Loader2,
  Square,
  CircleX,
  Wand2,
  Box,
  Ruler,
  Sparkles,
} from 'lucide-react';
import {
  cn,
  CREATIVE_MODELS,
  PARAMETRIC_MODELS,
  parametricModelSupportsVision,
} from '@/lib/utils';
import {
  Content,
  CreativeModel,
  DEFAULT_CREATIVE_MODEL,
  Model,
  MultiviewImages,
} from '@shared/types';
import {
  MultiviewComposer,
  MultiviewSlotMap,
  slotsToMultiviewImages,
  hasFrontMultiviewSlot,
  hasAnyMultiviewSlot,
  anyMultiviewBusy,
} from '@/components/MultiviewComposer';
import { ImageGenerateDialog } from '@/components/ImageGenerateDialog';
import {
  QuadsButton,
  PolygonButton,
} from '@/components/chat/MeshTopologyControls';
import {
  SUPPORTED_MESH_EXTENSIONS,
  VALID_IMAGE_FORMATS,
  getMeshFileType,
  isSupportedMeshFile,
  readBlobAsDataUrl,
} from '@/utils/chatAttachments';
import {
  shouldShowPolygonControls,
  getModelDefaultPolygonCount,
  getMaxPolygonCount,
} from '@/constants/meshConstants';

// Local helper functions for this component
const shouldShowQuadsControls = (model: Model): boolean => {
  return shouldShowPolygonControls(model as CreativeModel);
};
import { MessageItem } from '../types/misc.ts';
import { useToast } from '@/hooks/use-toast';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useMutation, useQueries } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { ModelSelector } from '@/components/ModelSelector';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar } from '@/components/ui/avatar';
import { useItemSelection } from '@/hooks/useItemSelection';
// meshUtils functions are imported dynamically inside upload handlers so
// three.js stays out of the chat composer's initial bundle.
import type { BoundingBox } from '@/utils/meshUtils';
import { useMeshFiles } from '@/contexts/MeshFilesContext';
import { AnimatePresence, motion } from 'framer-motion';
import { BrandLogo } from '@/components/BrandLogo';
import { FEATURE_COSTS, formatTokenCost } from '@shared/tokenCosts';
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  getImageGenerationProvider,
  getImageGenerationTokenCost,
  normalizeImageGenerationModel,
  type ImageGenerationModel,
} from '@shared/imageGeneration';
import {
  buildReferenceImageAccept,
  shouldShowReferenceImageControl,
} from '@/utils/inputImageControls';
import {
  buildHydratedMultiviewSlots,
  getMultiviewImageEntries,
  multiviewSlotMapsMatchPreviews,
} from '@/utils/multiviewReference';

interface TextAreaChatProps {
  type: 'parametric' | 'creative';
  onSubmit: (content: Content) => void;
  onFocus?: () => void;
  isLoading?: boolean;
  placeholder?: string;
  stopGenerating?: () => void;
  disabled?: boolean;
  model: Model;
  setModel: (model: Model) => void;
  imageGenerationModel?: ImageGenerationModel;
  setImageGenerationModel?: (model: ImageGenerationModel) => void;
  showPromptGenerator?: boolean;
  showFullLabels?: boolean; // Controls whether to show full text labels on buttons
  onTypeChange?: (type: 'parametric' | 'creative') => void;
  conversation: {
    id: string;
    user_id: string;
  };
  composerFocusRequest?: {
    id: number;
    draft?: string;
  };
  seedMultiviewImages?: MultiviewImages;
}

const MULTIVIEW_ENABLED = true;

const DEFAULT_CREATIVE_PROMPT = 'a simple centered 3D object asset';

function TextAreaChat({
  onSubmit,
  onFocus,
  isLoading = false,
  placeholder = 'What can AzureFilm Generator help you build today?',
  type,
  stopGenerating,
  disabled = false,
  model,
  setModel,
  imageGenerationModel = DEFAULT_IMAGE_GENERATION_MODEL,
  setImageGenerationModel,
  showPromptGenerator = false,
  showFullLabels = false,
  onTypeChange,
  conversation,
  composerFocusRequest,
  seedMultiviewImages,
}: TextAreaChatProps) {
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isDragHover, setIsDragHover] = useState(false);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isGeneratingInputImage, setIsGeneratingInputImage] = useState(false);
  const [isImageCreatorOpen, setIsImageCreatorOpen] = useState(false);
  const [imageCreatorPrompt, setImageCreatorPrompt] = useState('');
  const [imageCreatorModel, setImageCreatorModel] =
    useState<ImageGenerationModel>(DEFAULT_IMAGE_GENERATION_MODEL);
  const [imageCreatorRef, setImageCreatorRef] = useState<{
    id: string;
    previewUrl: string;
  } | null>(null);
  const [isUploadingCreatorRef, setIsUploadingCreatorRef] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [dropMessageOpacityClass, setDropMessageOpacityClass] = useState(
    'opacity-0 pointer-events-none',
  );
  const [dropMessageTransitionClass, setDropMessageTransitionClass] =
    useState('');
  const prevIsDraggingRef = useRef(isDragging);
  const { toast } = useToast();
  const { session } = useAuth();
  const { images, mesh, setImages, setMesh } = useItemSelection();
  const meshFiles = useMeshFiles();
  const focusRequestId = composerFocusRequest?.id;
  const focusRequestDraft = composerFocusRequest?.draft;

  // Parametric mode: bounding box and filename from STL parsing
  const [meshBoundingBox, setMeshBoundingBox] = useState<BoundingBox | null>(
    null,
  );
  const [meshFilename, setMeshFilename] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRequestId) return;

    if (focusRequestDraft !== undefined) {
      setInput(focusRequestDraft);
    }

    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.focus();
      if (focusRequestDraft !== undefined) {
        const cursorPosition = focusRequestDraft.length;
        textarea.setSelectionRange(cursorPosition, cursorPosition);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [focusRequestDraft, focusRequestId]);

  // Multiview 4-slot state (only used when model === 'multiview')
  const [multiviewSlots, setMultiviewSlots] = useState<MultiviewSlotMap>({});
  const lastHydratedMultiviewSeedRef = useRef<string | null>(null);
  const isMultiview =
    MULTIVIEW_ENABLED && type === 'creative' && model === 'multiview';
  const selectedImageGenerationModel =
    normalizeImageGenerationModel(imageGenerationModel);

  const seedMultiviewEntries = useMemo(
    () => getMultiviewImageEntries(seedMultiviewImages),
    [seedMultiviewImages],
  );
  const seedMultiviewImagesKey = useMemo(
    () => seedMultiviewEntries.map(({ slot, id }) => `${slot}:${id}`).join('|'),
    [seedMultiviewEntries],
  );
  const seedMultiviewUrlQueries = useQueries({
    queries: seedMultiviewEntries.map(({ id }) => ({
      queryKey: [
        'multiviewSlotPreview',
        conversation.user_id,
        conversation.id,
        id,
      ],
      enabled: isMultiview && !!id,
      queryFn: async () => {
        const { data, error } = await supabase.storage
          .from('images')
          .download(`${conversation.user_id}/${conversation.id}/${id}`);
        if (error) throw error;
        if (!data) throw new Error('Failed to download multiview image');
        return { id, url: await readBlobAsDataUrl(data) };
      },
    })),
  });
  const hasAllSeedMultiviewUrls =
    seedMultiviewEntries.length > 0 &&
    seedMultiviewEntries.every(({ id }) =>
      seedMultiviewUrlQueries.some(
        (query) => query.data?.id === id && query.data.url.length > 0,
      ),
    );

  useEffect(() => {
    if (!MULTIVIEW_ENABLED && type === 'creative' && model === 'multiview') {
      setModel(DEFAULT_CREATIVE_MODEL);
      setMultiviewSlots({});
    }
  }, [model, setModel, type]);

  useEffect(() => {
    if (
      !isMultiview ||
      !seedMultiviewImages ||
      !seedMultiviewImagesKey ||
      !hasAllSeedMultiviewUrls ||
      lastHydratedMultiviewSeedRef.current === seedMultiviewImagesKey
    ) {
      return;
    }

    const imageUrls = seedMultiviewUrlQueries.flatMap((query) =>
      query.data ? [query.data] : [],
    );
    const hydratedSlots = buildHydratedMultiviewSlots({
      multiviewImages: seedMultiviewImages,
      imageUrls,
    }) as MultiviewSlotMap;

    setMultiviewSlots((currentSlots) => {
      if (anyMultiviewBusy(currentSlots)) return currentSlots;

      lastHydratedMultiviewSeedRef.current = seedMultiviewImagesKey;
      return multiviewSlotMapsMatchPreviews(currentSlots, hydratedSlots)
        ? currentSlots
        : hydratedSlots;
    });
  }, [
    hasAllSeedMultiviewUrls,
    isMultiview,
    seedMultiviewImages,
    seedMultiviewImagesKey,
    seedMultiviewUrlQueries,
  ]);

  // Quads vs Polys toggle state (only for ultra model)
  const [meshTopology, setMeshTopology] = useState<'quads' | 'polys'>(() => {
    // Default to 'polys' (quads disabled by default)
    // Only use localStorage if it's explicitly set to 'quads'
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('adam-mesh-topology');
      // Only return 'quads' if explicitly stored, otherwise default to 'polys'
      return stored === 'quads' ? 'quads' : 'polys';
    }
    return 'polys';
  });

  // Polygon count state - single source of truth for user overrides
  const [polygonOverrides, setPolygonOverrides] = useState<
    Record<string, number>
  >(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('adam-polygon-overrides');
        if (stored) {
          const parsed = JSON.parse(stored);
          // Validate that it's an object with number values
          if (typeof parsed === 'object' && parsed !== null) {
            const isValid = Object.entries(parsed).every(
              ([key, value]) =>
                typeof key === 'string' && typeof value === 'number',
            );
            return isValid ? parsed : {};
          }
        }
      } catch (error) {
        console.warn(
          'Failed to parse polygon overrides from localStorage, resetting:',
          error,
        );
        localStorage.removeItem('adam-polygon-overrides');
      }
    }
    return {};
  });

  // Set polygon count for current model+topology combination
  const setPolygonCountForCurrentModel = useCallback(
    (count: number) => {
      if (type !== 'creative') return;
      const modelTopologyKey = `${model}-${meshTopology}`;
      const defaultCount = getModelDefaultPolygonCount(
        model as CreativeModel,
        meshTopology,
      );

      // If setting to default, remove the override instead of storing it
      if (count === defaultCount) {
        setPolygonOverrides((prev) => {
          const { [modelTopologyKey]: _, ...rest } = prev;
          return rest;
        });
      } else {
        setPolygonOverrides((prev) => ({
          ...prev,
          [modelTopologyKey]: count,
        }));
      }
    },
    [model, meshTopology, type],
  );

  // Persist meshTopology changes to localStorage
  const handleMeshTopologyChange = useCallback(
    (newTopology: 'quads' | 'polys') => {
      setMeshTopology(newTopology);

      // Reset polygon count to the model-specific default for the new topology
      const modelSpecificDefault = getModelDefaultPolygonCount(
        model as CreativeModel,
        newTopology,
      );
      setPolygonCountForCurrentModel(modelSpecificDefault);
    },
    [setPolygonCountForCurrentModel, model],
  );

  // Derived polygon count - no useState needed, calculated from model + topology + overrides
  const polygonCount = useMemo(() => {
    if (type !== 'creative') return 0;
    const modelTopologyKey = `${model}-${meshTopology}`;
    const userOverride = polygonOverrides[modelTopologyKey];
    return (
      userOverride ??
      getModelDefaultPolygonCount(model as CreativeModel, meshTopology)
    );
  }, [model, meshTopology, polygonOverrides, type]);

  // Persist polygon overrides to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(
        'adam-polygon-overrides',
        JSON.stringify(polygonOverrides),
      );
    }
  }, [polygonOverrides]);

  // Persist mesh topology to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('adam-mesh-topology', meshTopology);
    }
  }, [meshTopology]);

  // Reset polygon count to default for current model and topology
  const resetPolygonCount = useCallback(() => {
    const modelTopologyKey = `${model}-${meshTopology}`;
    setPolygonOverrides((prev) => {
      const { [modelTopologyKey]: _, ...rest } = prev;
      return rest;
    });
  }, [model, meshTopology]);

  // When model changes, clear any polygon overrides to use the new model's defaults
  useEffect(() => {
    if (type !== 'creative') return;

    // Clear all overrides when switching models to ensure we use the new model's defaults
    setPolygonOverrides({});
  }, [model, type]);

  // Computed polygon values for server submission
  const maxPolygonCount =
    type === 'creative'
      ? getMaxPolygonCount(model as CreativeModel, meshTopology)
      : 0;

  // Refs for the two hot-zones
  const topDropZoneRef = useRef<HTMLDivElement>(null);
  const textAreaContainerZoneRef = useRef<HTMLDivElement>(null);

  // Animation variants for image/mesh thumbnails
  const itemAnimationVariants = {
    initial: { opacity: 0, scale: 0.8 },
    animate: {
      opacity: 1,
      scale: 1,
    },
    exit: {
      opacity: 0,
      scale: 0.8,
    },
  };

  const memoizedModels = useMemo(() => {
    if (type === 'creative') {
      return CREATIVE_MODELS;
    }
    return PARAMETRIC_MODELS;
  }, [type]);

  // ------------------------------------------------------------
  // Placeholder â€“ Typed-out Animation
  // When the target placeholder (based on mode & image state)
  // changes, we progressively reveal each character so it looks
  // like it's being typed in real-time. This gives users a more
  // delightful sense of state change without abrupt flashes.
  // ------------------------------------------------------------

  // Helper to decide which placeholder we're targeting right now
  const computeTargetPlaceholder = useCallback(() => {
    if (type === 'creative') {
      if (isMultiview) {
        return hasAnyMultiviewSlot(multiviewSlots)
          ? 'Describe tweaks or leave blank to build...'
          : 'Describe the object, then fill the 4 views...';
      }
      if (images.length > 0) return 'Edit uploaded image...';
      if (model === 'ultra') return 'Make a production ready 3D asset...';
      return 'Speak anything into existence...';
    }
    return placeholder;
  }, [type, images.length, placeholder, model, isMultiview, multiviewSlots]);

  // The text currently shown in the placeholder (animates)
  const [placeholderAnim, setPlaceholderAnim] = useState('');
  const [placeholderOpacity, setPlaceholderOpacity] = useState(1);
  const placeholderRef = useRef('');

  // Shared helper that performs the crossfade animation
  const startCrossfade = (target: string) => {
    placeholderRef.current = target;

    // Start fade out
    setPlaceholderOpacity(0);

    // After fade out, update text and fade in
    setTimeout(() => {
      setPlaceholderAnim(target);
      setPlaceholderOpacity(1);
    }, 150);
  };

  // Kick off crossfade effect whenever the target placeholder changes
  useEffect(() => {
    const target = computeTargetPlaceholder();

    // If nothing has changed, make sure we're synced and bail.
    if (target === placeholderRef.current) {
      if (placeholderAnim !== target) {
        setPlaceholderAnim(target);
      }
      return;
    }

    startCrossfade(target);
  }, [
    type,
    images.length,
    placeholder,
    model,
    computeTargetPlaceholder,
    placeholderAnim,
  ]);

  useEffect(() => {
    // Multiview manages its own 4-slot state, don't force-switch models on it.
    if (type === 'creative' && !isMultiview && images.length > 1) {
      if (model !== DEFAULT_CREATIVE_MODEL) {
        setModel(DEFAULT_CREATIVE_MODEL);
      }
    }
  }, [images, setModel, model, type, isMultiview]);

  const handleSubmit = async () => {
    if (isMultiview) {
      // Multiview submit requires at least the front view (Tripo requirement)
      // and no slot still uploading/generating.
      if (
        isLoading ||
        !hasFrontMultiviewSlot(multiviewSlots) ||
        anyMultiviewBusy(multiviewSlots)
      ) {
        return;
      }
      const multiviewImages = slotsToMultiviewImages(multiviewSlots);
      const content: Content = {
        ...(input.trim() !== '' && { text: input.trim() }),
        model,
        multiviewImages,
        imageGenerationModel: selectedImageGenerationModel,
      };
      onSubmit(content);
      setInput('');
      return;
    }

    const trimmedInput = input.trim();
    const hasNoContent =
      images.length === 0 && !trimmedInput && !mesh && type !== 'creative';
    const hasUploadingImages = images.some((img) => img.isUploading);

    if (
      hasNoContent ||
      isLoading ||
      hasUploadingImages ||
      isGeneratingInputImage
    ) {
      return;
    }
    let content: Content = {
      ...(trimmedInput !== '' && { text: trimmedInput }),
      ...(images.length > 0 && { images: images.map((img) => img.id) }),
      model: model,
      ...(type === 'creative' && {
        imageGenerationModel: selectedImageGenerationModel,
      }),
    };
    if (type === 'creative') {
      content = {
        ...content,
        ...(trimmedInput === '' &&
          images.length === 0 &&
          !mesh && { text: DEFAULT_CREATIVE_PROMPT }),
        ...(mesh && {
          mesh: { id: mesh.id, fileType: mesh.fileType || 'glb' },
        }),
        // Include meshTopology preference for standard and ultra models
        ...(shouldShowPolygonControls(model as CreativeModel) && {
          meshTopology,
        }),
        // Include polygonCount preference for standard and ultra (respect quads mode limit)
        ...(shouldShowPolygonControls(model as CreativeModel) && {
          polygonCount: Math.min(polygonCount, maxPolygonCount),
        }),
      };
    } else if (type === 'parametric' && mesh) {
      content = {
        ...content,
        mesh: { id: mesh.id, fileType: 'stl' },
        ...(meshBoundingBox && { meshBoundingBox }),
        ...(meshFilename && { meshFilename }),
      };
    }
    onSubmit(content);
    setInput('');
    setImages([]);
    setMesh(null);
    setMeshBoundingBox(null);
    setMeshFilename(null);
  };

  const { mutateAsync: uploadImageAsync } = useMutation({
    mutationFn: async ({ file, id }: { file: File; id: string }) => {
      const { error } = await supabase.storage
        .from('images')
        .upload(`${conversation.user_id}/${conversation.id}/${id}`, file);

      if (error) throw error;

      const reader = new FileReader();
      const urlPromise = new Promise((resolve) => {
        reader.onload = () => {
          resolve(reader.result as string);
        };
      });
      reader.readAsDataURL(file);
      const url = (await urlPromise) as string;

      return url;
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to upload image',
        variant: 'destructive',
      });
    },
  });

  const { mutateAsync: uploadMeshAsync } = useMutation({
    mutationFn: async ({ file, id }: { file: File; id: string }) => {
      // Determine file extension
      const fileExtension = getMeshFileType(file.name);

      const { error } = await supabase.storage
        .from('meshes')
        .upload(
          `${conversation.user_id}/${conversation.id}/${id}.${fileExtension}`,
          file,
        );

      if (error) throw error;

      // Check if preview exists in storage
      const previewPath = `${conversation.user_id}/${conversation.id}/preview-${id}`;

      const { data } = await supabase.storage
        .from('images')
        .createSignedUrl(previewPath, 60 * 60); // 1 hour expiry

      if (data && data.signedUrl) {
        return data.signedUrl;
      }

      // If preview doesn't exist, generate it with the correct file type
      const { generatePreview } = await import('@/utils/meshUtils');
      const preview = await generatePreview(file, fileExtension);

      // Only upload if the current user is the conversation owner
      if (session?.user.id === conversation.user_id) {
        // Convert data URL to Blob
        const response = await fetch(preview);
        const blob = await response.blob();

        // Save the preview to storage
        const { error: uploadError } = await supabase.storage
          .from('images')
          .upload(previewPath, blob, {
            contentType: 'image/png',
            upsert: true,
          });

        if (uploadError) {
          console.error('Error uploading preview:', uploadError);
          return preview; // Return the preview anyway even if upload fails
        }

        // Get the signed URL of the uploaded preview
        const { data } = await supabase.storage
          .from('images')
          .createSignedUrl(previewPath, 60 * 60); // 1 hour expiry
        return data?.signedUrl;
      }

      // If not the owner, just return the generated preview
      return preview;
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to upload mesh',
        variant: 'destructive',
      });
    },
  });

  const addItems = async (files: FileList) => {
    const newItems = Array.from(files);
    let hasSmallImages = false;
    let hasLargeImages = false;
    let hasInvalidImages = false;
    let hasInvalidItems = false;
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit

    const validImages = await Promise.all(
      newItems.map(async (file) => {
        // First check file type Must be jpeg, png, gif, or webp.
        if (!file.type.includes('image')) {
          return null;
        }

        if (!VALID_IMAGE_FORMATS.includes(file.type)) {
          hasInvalidImages = true;
          return null;
        }

        // Check file size
        if (file.size > MAX_FILE_SIZE) {
          hasLargeImages = true;
          return null;
        }

        // Check dimensions asynchronously
        return new Promise<File | null>((resolve) => {
          const img = new Image();
          img.src = URL.createObjectURL(file);
          img.onload = () => {
            if (img.naturalWidth < 256 || img.naturalHeight < 256) {
              hasSmallImages = true;
              resolve(null); // Image too small
            } else {
              resolve(file); // Valid image
            }
            URL.revokeObjectURL(img.src);
          };
          img.onerror = () => {
            resolve(null); // Invalid image
            URL.revokeObjectURL(img.src);
          };
        });
      }),
    );

    const validMeshes = newItems.map((file) => {
      if (!isSupportedMeshFile(file.name, type)) {
        return null;
      }

      return file;
    });

    // Filter out null values (invalid images)
    const filteredImages = validImages.filter(
      (img): img is File => img !== null,
    );

    const filteredMeshes = validMeshes.filter(
      (mesh): mesh is File => mesh !== null,
    );

    hasInvalidItems =
      newItems.length > filteredImages.length + filteredMeshes.length;

    // Show specific errors first, then generic error only if there are truly invalid file types
    if (hasSmallImages) {
      toast({
        title: 'Image too small',
        description:
          'Some images were not added because they are smaller than 256x256 pixels.',
      });
    } else if (hasLargeImages) {
      toast({
        title: 'Image too large',
        description:
          'Some images were not added because they are larger than 100MB.',
      });
    } else if (hasInvalidImages) {
      toast({
        title: 'Invalid image format',
        description:
          'Some images were not added because they are not valid image formats. Must be jpeg, png, or webp.',
      });
    } else if (hasInvalidItems) {
      toast({
        title: 'Invalid file format',
        description:
          type === 'creative'
            ? 'Some files were not added because they are not valid file formats. Must be jpeg, png, webp, glb, stl, or obj.'
            : 'Some files were not added because they are not valid file formats. Must be jpeg, png, webp, or stl.',
      });
    }

    filteredMeshes.forEach(async (file) => {
      const tempId = crypto.randomUUID();
      const fileType = getMeshFileType(file.name);
      setMesh({ id: tempId, isUploading: true, source: 'upload', fileType });
      try {
        // For parametric mode STL files, extract bounding box and generate multi-angle renders
        if (type === 'parametric' && fileType === 'stl') {
          const { parseSTL, renderMultipleAngles } = await import(
            '@/utils/meshUtils'
          );
          const { geometry, boundingBox } = await parseSTL(file);
          setMeshBoundingBox(boundingBox);
          setMeshFilename(file.name);

          // Store STL blob in context for WASM filesystem access
          meshFiles.setMeshFile(file.name, file);

          // Generate multi-angle renders and upload as images
          const renders = await renderMultipleAngles(geometry, boundingBox);
          for (const renderBlob of renders) {
            const renderId = crypto.randomUUID();
            const renderFile = new File(
              [renderBlob],
              `render-${renderId}.png`,
              {
                type: 'image/png',
              },
            );
            const url = URL.createObjectURL(renderBlob);
            setImages((prevImages) => [
              ...prevImages,
              { id: renderId, isUploading: true, source: 'upload', url },
            ]);
            try {
              const signedUrl = await uploadImageAsync({
                file: renderFile,
                id: renderId,
              });
              URL.revokeObjectURL(url);
              setImages((prevImages) =>
                prevImages.map((img) =>
                  img.id === renderId
                    ? { ...img, isUploading: false, url: signedUrl }
                    : img,
                ),
              );
            } catch (renderError) {
              console.error('Error uploading render:', renderError);
              setImages((prevImages) =>
                prevImages.filter((img) => img.id !== renderId),
              );
            }
          }

          geometry.dispose();
        }

        const url = await uploadMeshAsync({ file: file, id: tempId });
        setMesh({
          id: tempId,
          isUploading: false,
          url,
          source: 'upload',
          fileType,
        });
      } catch (error) {
        console.error('Error uploading mesh:', error);
        setMesh(null);
        setMeshBoundingBox(null);
        setMeshFilename(null);
      }
    });

    // Upload each valid image immediately
    filteredImages.forEach(async (file) => {
      const tempId = crypto.randomUUID();
      const url = URL.createObjectURL(file);
      setImages((prevImages) => [
        ...prevImages,
        { id: tempId, isUploading: true, source: 'upload', url },
      ]);
      try {
        const signedUrl = await uploadImageAsync({ file, id: tempId });
        URL.revokeObjectURL(url);
        setImages((prevImages) =>
          prevImages.map((img) =>
            img.id === tempId
              ? { ...img, isUploading: false, url: signedUrl }
              : img,
          ),
        );
      } catch (error) {
        console.error('Error uploading image:', error);
        setImages((prevImages) =>
          prevImages.filter((img) => img.id !== tempId),
        );
      }
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSubmit = isMultiview
    ? hasFrontMultiviewSlot(multiviewSlots) && !anyMultiviewBusy(multiviewSlots)
    : type === 'creative' || images.length > 0 || !!input.trim() || !!mesh;

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData.files;
    if (files && files.length > 0) {
      event.preventDefault();
      addItems(files);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); // Signal that this component handled the drop
    const droppedFiles = event.dataTransfer?.files;

    let shouldAddItems = false;
    const target = event.target as Node;

    if (
      topDropZoneRef.current?.contains(target) ||
      textAreaContainerZoneRef.current?.contains(target)
    ) {
      shouldAddItems = true;
    }

    // In multiview mode the flat image list is unused â€” each view has its own
    // slot. Ignore general-area drops so users don't accumulate orphaned files.
    if (isMultiview) {
      shouldAddItems = false;
    }

    if (shouldAddItems && droppedFiles && droppedFiles.length > 0) {
      await addItems(droppedFiles);
    }

    // Always reset drag states, regardless of whether files were added
    setIsDragging(false);
    setIsDragHover(false);
  };

  const handleItemsChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedItems = event.target.files;
    if (selectedItems && selectedItems.length > 0) {
      addItems(selectedItems);
    }
  };

  const openReferenceFilePicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = buildReferenceImageAccept({
      type,
      imageFormats: VALID_IMAGE_FORMATS,
      creativeMeshExtensions: SUPPORTED_MESH_EXTENSIONS,
    });
    input.onchange = (event) => {
      handleItemsChange(event as unknown as ChangeEvent<HTMLInputElement>);
    };
    input.click();
  };

  const handleMeshRemoved = async () => {
    if (mesh?.source === 'upload') {
      try {
        const fileExtension = mesh.fileType || 'glb'; // Default to glb if fileType is not set
        await Promise.all([
          supabase.storage
            .from('meshes')
            .remove([
              `${session?.user?.id}/${conversation.id}/${mesh.id}.${fileExtension}`,
            ]),
          supabase.storage
            .from('images')
            .remove([
              `${session?.user?.id}/${conversation.id}/preview-${mesh.id}`,
            ]),
        ]);
      } catch (error) {
        console.error('Error removing mesh:', error);
      }
    }
    setMesh(null);
  };

  const handleImageRemoved = async (image: MessageItem) => {
    if (!image.isUploading) {
      // Only try to remove from storage if the item has been uploaded
      if (image.source === 'upload') {
        try {
          await supabase.storage
            .from('images')
            .remove([`${session?.user?.id}/${conversation.id}/${image.id}`]);
        } catch (error) {
          console.error('Error removing image:', error);
        }
      }
      setImages((prevImages) =>
        prevImages.filter((img) => img.id !== image.id),
      );
    }
  };

  const generatePrompt = async () => {
    if (isGeneratingPrompt) return;
    setIsGeneratingPrompt(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'prompt-generator',
        {
          method: 'POST',
          body: {
            existingText: input.trim() || null,
            type: type, // Send the mode type (parametric or creative)
          },
        },
      );

      if (error) throw error;
      if (!data?.prompt) throw new Error('No prompt generated');

      setInput(data.prompt);
    } catch (error) {
      console.error('Error generating prompt:', error);
      toast({
        title: 'Error',
        description: 'Failed to generate prompt',
        variant: 'destructive',
      });
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  const generateInputImage = async (options?: {
    promptOverride?: string;
    refImageId?: string;
  }) => {
    if (isGeneratingInputImage || type !== 'creative' || isMultiview) return;
    const prompt =
      options?.promptOverride?.trim() ||
      input.trim() ||
      DEFAULT_CREATIVE_PROMPT;

    setIsGeneratingInputImage(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-view', {
        method: 'POST',
        body: {
          conversationId: conversation.id,
          view: 'front',
          prompt,
          provider: getImageGenerationProvider(imageCreatorModel),
          mode: 'input',
          ...(options?.refImageId ? { refImageId: options.refImageId } : {}),
        },
      });

      if (error) throw error;
      if (!data?.id || !data?.url) {
        throw new Error('No image returned from generator');
      }

      setImages((prevImages) => [
        ...prevImages,
        {
          id: data.id as string,
          url: data.url as string,
          isUploading: false,
          source: 'upload',
        },
      ]);
      setIsImageCreatorOpen(false);
      setImageCreatorPrompt('');
      setImageCreatorRef(null);
    } catch (error) {
      console.error('Error generating input image:', error);
      toast({
        title: 'Image generation failed',
        description:
          error instanceof Error
            ? error.message
            : 'Could not generate an input image. Try again.',
        variant: 'destructive',
      });
    } finally {
      setIsGeneratingInputImage(false);
    }
  };

  const openImageCreator = useCallback(() => {
    setImageCreatorPrompt(input.trim());
    setImageCreatorModel(selectedImageGenerationModel);
    setImageCreatorRef(null);
    setIsImageCreatorOpen(true);
  }, [input, selectedImageGenerationModel]);

  const handleImageCreatorAddRef = async (file: File) => {
    if (!VALID_IMAGE_FORMATS.includes(file.type)) {
      toast({
        title: 'Unsupported image',
        description: 'Use a JPG, PNG, or WebP image.',
        variant: 'destructive',
      });
      return;
    }
    const id = crypto.randomUUID();
    setIsUploadingCreatorRef(true);
    try {
      const previewUrl = await uploadImageAsync({ file, id });
      setImageCreatorRef({ id, previewUrl });
    } catch {
      // toast already handled by uploadImageAsync onError
    } finally {
      setIsUploadingCreatorRef(false);
    }
  };

  // Add global drag-and-drop listeners so that dropping files anywhere on the page is handled.
  useEffect(() => {
    // Prevent default browser behaviour (e.g. opening the image in a new tab)
    const preventDefaults = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
      // When a drag operation newly enters the window, assume it's not hovering
      // over a specific component's hot-zone yet. Hot-zones will override this.
      setIsDragHover(false);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      // When leaving the window entirely (relatedTarget is null), reset dragging state
      if (
        (e as unknown as { relatedTarget: Node | null }).relatedTarget === null
      ) {
        setIsDragging(false);
        setIsDragHover(false);
      }
    };

    const handleDropGlobal = async (e: DragEvent) => {
      // If a more specific drop handler (like in TextAreaChat) already handled this event
      // and called e.preventDefault(), the global handler should not interfere.
      if (e.defaultPrevented) {
        return;
      }

      // If we're here, the drop occurred outside a component that handled it.
      // Prevent the browser's default action (e.g., opening the file).
      e.preventDefault();

      // For a global drop outside handled areas, we don't add items.
      // We just clear the overall drag UI state.
      setIsDragging(false);
      setIsDragHover(false);
      // NO call to addItems() here.
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', preventDefaults);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDropGlobal);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', preventDefaults);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDropGlobal);
    };
  }, []);

  useEffect(() => {
    if (images.length === 0 && mesh === null) {
      // Case 1: No items are present in the drop zone
      if (isDragging) {
        // If dragging, the message should be visible and can transition
        setDropMessageOpacityClass('opacity-100');
        setDropMessageTransitionClass(
          'transition-opacity duration-200 ease-in-out',
        );
      } else {
        // Not dragging. Message should be hidden.
        if (prevIsDraggingRef.current) {
          // If it WAS dragging and now it's not, it should fade out.
          setDropMessageTransitionClass(
            'transition-opacity duration-200 ease-in-out',
          );
          setDropMessageOpacityClass('opacity-0 pointer-events-none');
        } else {
          // If it was NOT dragging and still isn't (e.g., mounting fresh after image removal),
          // it should be instantly hidden, no transition.
          setDropMessageTransitionClass('');
          setDropMessageOpacityClass('opacity-0 pointer-events-none');
        }
      }
    } else {
      // Case 2: Items ARE present in the drop zone, message should be instantly hidden.
      setDropMessageTransitionClass('');
      setDropMessageOpacityClass('opacity-0 pointer-events-none');
    }
    prevIsDraggingRef.current = isDragging;
  }, [isDragging, images.length, mesh]); // Listen to images.length and mesh too

  return (
    <div
      className="group relative"
      onDrop={handleDrop}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        // If the drag operation leaves the bounds of this entire component,
        // then isDragHover should definitely be false.
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setIsDragHover(false);
        }
      }}
      onClick={() => {
        onFocus?.();
        textareaRef.current?.focus();
      }}
    >
      <Dialog
        open={!!previewImageUrl}
        onOpenChange={(open) => {
          if (!open) setPreviewImageUrl(null);
        }}
      >
        <DialogContent
          className="max-w-3xl border-adam-neutral-700 bg-adam-neutral-950 p-2"
          onClick={(event) => event.stopPropagation()}
        >
          {previewImageUrl && (
            <img
              src={previewImageUrl}
              alt="Preview"
              className="mx-auto max-h-[80vh] w-auto rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
      <ImageGenerateDialog
        open={isImageCreatorOpen}
        onOpenChange={setIsImageCreatorOpen}
        title="Create input image"
        description="The Object Agent creates a clean 3D object reference from your current brief and optional image."
        references={
          imageCreatorRef
            ? [
                {
                  id: imageCreatorRef.id,
                  previewUrl: imageCreatorRef.previewUrl,
                },
              ]
            : []
        }
        onAddReferenceFile={handleImageCreatorAddRef}
        onRemoveReference={() => setImageCreatorRef(null)}
        isUploadingReference={isUploadingCreatorRef}
        prompt={imageCreatorPrompt}
        onPromptChange={setImageCreatorPrompt}
        promptPlaceholder={DEFAULT_CREATIVE_PROMPT}
        model={imageCreatorModel}
        onModelChange={(nextModel) => {
          setImageCreatorModel(nextModel);
          setImageGenerationModel?.(nextModel);
        }}
        isGenerating={isGeneratingInputImage}
        onGenerate={() =>
          void generateInputImage({
            promptOverride: imageCreatorPrompt,
            refImageId: imageCreatorRef?.id,
          })
        }
        maxReferences={1}
      />
      {isMultiview ? (
        <div
          className={cn(
            'mx-auto w-[95%] min-w-52 overflow-hidden rounded-t-xl border-x-2 border-t-2',
            'border-adam-neutral-700 bg-adam-neutral-950',
            disabled && 'pointer-events-none opacity-50',
          )}
        >
          <MultiviewComposer
            conversationId={conversation.id}
            userId={conversation.user_id}
            slots={multiviewSlots}
            onSlotsChange={setMultiviewSlots}
            prompt={input}
            imageGenerationModel={selectedImageGenerationModel}
            onImageGenerationModelChange={setImageGenerationModel}
            disabled={disabled || isLoading}
          />
        </div>
      ) : null}
      <div
        ref={topDropZoneRef}
        className={cn(
          'mx-auto flex w-[95%] min-w-52 overflow-hidden rounded-t-xl border-x-2 border-t-2',
          'transition-[height,opacity,border-color,background-color] duration-200 ease-in-out',
          isMultiview
            ? 'h-0 border-transparent bg-transparent opacity-0'
            : disabled
              ? 'h-0 border-transparent bg-transparent opacity-0'
              : !isDragging && images.length === 0 && mesh === null
                ? 'h-0 border-transparent bg-transparent opacity-0'
                : isDragging
                  ? isDragHover
                    ? 'h-20 border-[#0F5FF4] bg-[rgba(15,95,244,0.24)] opacity-100' // Blue, full height
                    : 'h-20 border-[#0B4FD0] bg-[rgba(15,95,244,0.12)] opacity-100' // Intermediate blue, full height
                  : images.length > 0 || mesh !== null
                    ? 'h-20 border-adam-neutral-700 bg-adam-neutral-950 opacity-100'
                    : 'h-0 border-transparent bg-transparent opacity-0',
        )}
        onDragEnter={(event) => {
          if (isDragging) {
            event.preventDefault();
            setIsDragHover(true);
          }
        }}
        onDragOver={(event) => {
          if (isDragging) {
            event.preventDefault();
            setIsDragHover(true);
          }
        }}
        onDragLeave={(event) => {
          if (isDragging) {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setIsDragHover(false);
            }
          }
        }}
      >
        {!disabled && (
          <>
            {/* Case 1: Dragging, and items are ALREADY present -> Show "Add more images" prompt */}
            {isDragging && (images.length > 0 || mesh !== null) ? (
              <div
                className={cn(
                  'flex h-full w-full flex-row items-center justify-center gap-2', // Ensure it fills parent
                  // Opacity is handled by the parent's transition when it appears/disappears due to isDragging
                )}
              >
                <Images
                  className="h-5 w-5"
                  style={{
                    color: isDragHover ? '#0F5FF4' : 'rgba(15, 95, 244, 0.85)',
                  }}
                />
                <p
                  className="text-sm font-normal"
                  style={{
                    color: isDragHover ? '#0F5FF4' : 'rgba(15, 95, 244, 0.85)',
                  }}
                >
                  Add more images here
                </p>
              </div>
            ) : /* Case 2: No items (images/mesh are zero) -> Show original "Drop images and 3D models here" logic */
            images.length === 0 && mesh === null ? (
              <div
                className={cn(
                  'flex h-full w-full flex-row items-center justify-center gap-2', // Ensure it fills parent
                  dropMessageTransitionClass,
                  dropMessageOpacityClass,
                )}
              >
                <Images
                  className="h-5 w-5"
                  style={{
                    color: isDragHover ? '#0F5FF4' : 'rgba(15, 95, 244, 0.85)',
                  }}
                />
                <p
                  className="text-sm font-normal"
                  style={{
                    color: isDragHover ? '#0F5FF4' : 'rgba(15, 95, 244, 0.85)',
                  }}
                >
                  Drop images and 3D models here
                </p>
              </div>
            ) : (
              /* Case 3: Items are present, and NOT dragging -> Show thumbnails */
              (images.length > 0 || mesh !== null) && (
                <div
                  className={cn(
                    'flex w-full items-center gap-4 overflow-x-auto overflow-y-hidden p-4',
                    // Opacity dimming logic can remain if desired, or be simplified
                    isDragging && (images.length > 0 || mesh !== null)
                      ? 'opacity-60'
                      : 'opacity-100',
                    'transition-opacity duration-150',
                  )}
                >
                  <AnimatePresence>
                    {' '}
                    {/* Ensure no initial={false} here */}
                    {mesh && (
                      <motion.div
                        key={`mesh-${mesh.id}`}
                        className="relative h-12 w-12 flex-shrink-0"
                        variants={itemAnimationVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        layout
                      >
                        {mesh.url && (
                          <img
                            src={mesh.url}
                            alt="Mesh"
                            className="h-12 w-12 rounded-md object-cover"
                          />
                        )}
                        {mesh.isUploading && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/50">
                            <Loader2 className="h-4 w-4 animate-spin text-white" />
                          </div>
                        )}
                        {!mesh.isUploading && (
                          <div className="absolute bottom-[-0.50rem] right-[-0.50rem] rounded-full border border-adam-neutral-500 bg-adam-neutral-500 text-white transition-colors duration-200 hover:border-adam-neutral-700 hover:bg-adam-neutral-700">
                            <Box className="h-4 w-4 text-white" />
                          </div>
                        )}
                        <button
                          onClick={handleMeshRemoved}
                          disabled={mesh.isUploading}
                          className={cn(
                            'absolute right-[-0.50rem] top-[-0.50rem] rounded-full border border-adam-neutral-500 bg-adam-neutral-500 text-white transition-colors duration-200 hover:border-adam-neutral-700 hover:bg-adam-neutral-700',
                            mesh.isUploading && 'opacity-50',
                          )}
                        >
                          <CircleX className="h-4 w-4 stroke-[1.5]" />
                        </button>
                      </motion.div>
                    )}
                    {images.map((image) => (
                      <motion.div
                        key={`image-${image.id}`}
                        className="relative h-12 w-12 flex-shrink-0"
                        variants={itemAnimationVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        layout
                      >
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (image.isUploading || !image.url) return;
                            setPreviewImageUrl(image.url);
                          }}
                          disabled={image.isUploading || !image.url}
                          className="block h-12 w-12 overflow-hidden rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-adam-blue"
                          aria-label="Preview image"
                        >
                          <img
                            src={image.url}
                            alt="Image"
                            className="h-12 w-12 rounded-md object-cover transition-opacity hover:opacity-80"
                          />
                        </button>
                        {image.isUploading && (
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-black/50">
                            <Loader2 className="h-4 w-4 animate-spin text-white" />
                          </div>
                        )}
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            handleImageRemoved(image);
                          }}
                          disabled={image.isUploading}
                          className={cn(
                            'absolute right-[-0.50rem] top-[-0.50rem] rounded-full border border-adam-neutral-500 bg-adam-neutral-500 text-white transition-colors duration-200 hover:border-adam-neutral-700 hover:bg-adam-neutral-700',
                            image.isUploading && 'opacity-50',
                          )}
                        >
                          <CircleX className="h-4 w-4 stroke-[1.5]" />
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )
            )}
          </>
        )}
      </div>
      <div
        ref={textAreaContainerZoneRef}
        className={cn(
          'relative rounded-2xl border-2',
          isFocused
            ? 'border-adam-blue shadow-[inset_0px_0px_8px_0px_rgba(0,0,0,0.08)]'
            : 'border-adam-neutral-700 shadow-[inset_0px_0px_8px_0px_rgba(0,0,0,0.08)] hover:border-adam-neutral-400',
          'bg-adam-background-2 transition-all duration-300',
        )}
        onDragEnter={(event) => {
          if (isDragging) {
            event.preventDefault();
            setIsDragHover(true);
          }
        }}
        onDragOver={(event) => {
          if (isDragging) {
            event.preventDefault();
            setIsDragHover(true);
          }
        }}
        onDragLeave={(event) => {
          if (isDragging) {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setIsDragHover(false);
            }
          }
        }}
      >
        <div className="flex select-none items-center justify-between p-2">
          <Avatar className="h-8 w-8">
            <div className="h-full w-full p-1.5">
              <BrandLogo variant="mark" className="h-full w-full" />
            </div>
          </Avatar>
          <div className="relative grid w-full">
            <Textarea
              disabled={isLoading || disabled}
              value={input}
              ref={textareaRef}
              translate="no"
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onBlur={() => setIsFocused(false)}
              onFocus={() => setIsFocused(true)}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              placeholder={placeholderAnim}
              className="hide-scrollbar z-40 block h-auto min-h-0 w-full resize-none overflow-hidden whitespace-pre-line break-words border-none bg-adam-neutral-800 bg-transparent px-3 py-2 text-base text-adam-text-primary outline-none transition-all duration-500 placeholder:text-adam-text-secondary placeholder:opacity-[var(--placeholder-opacity)] placeholder:transition-all placeholder:duration-300 placeholder:ease-in-out hover:placeholder:blur-[0.2px] focus:border-0 focus:shadow-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:text-gray-200 sm:px-4 sm:text-sm"
              style={
                {
                  '--placeholder-opacity': placeholderOpacity,
                  gridArea: '1 / -1',
                } as React.CSSProperties
              }
              rows={1}
            />
            <div
              className="pointer-events-none col-start-1 row-start-1 w-full overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm opacity-0 sm:px-4"
              style={{ gridArea: '1 / -1' }}
            >
              <span>{input}</span>
              <br />
            </div>
          </div>
          {showPromptGenerator && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full hover:bg-adam-neutral-800"
                  onClick={(e) => {
                    e.stopPropagation();
                    generatePrompt();
                  }}
                  disabled={isGeneratingPrompt || isLoading || disabled}
                >
                  {isGeneratingPrompt ? (
                    <Loader2 className="h-4 w-4 animate-spin text-adam-blue" />
                  ) : (
                    <Wand2 className="h-4 w-4 text-gray-400 transition-colors duration-200 hover:text-white" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {input.trim() ? 'Enhance Prompt' : 'Generate Prompt'} (
                {formatTokenCost(FEATURE_COSTS.promptGeneration.tokens)})
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[#2a2a2a] p-3">
          <div className="flex items-center gap-1">
            {shouldShowReferenceImageControl({
              type,
              isMultiview,
              parametricSupportsVision: parametricModelSupportsVision(model),
            }) && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0 rounded-lg border border-[#2a2a2a] bg-adam-background-2 text-adam-text-secondary hover:bg-adam-bg-secondary-dark data-[state=open]:bg-adam-bg-secondary-dark"
                        disabled={disabled || isGeneratingInputImage}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Add reference image"
                      >
                        {isGeneratingInputImage ? (
                          <Loader2 className="h-4 w-4 animate-spin text-adam-blue" />
                        ) : (
                          <ImagePlus className="h-4 w-4" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Add reference image</TooltipContent>
                </Tooltip>
                <DropdownMenuContent
                  align="start"
                  side="top"
                  className="w-56 p-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DropdownMenuItem
                    className="gap-2 rounded-md text-adam-text-primary hover:cursor-pointer"
                    onSelect={() => openReferenceFilePicker()}
                  >
                    <ImagePlus className="h-4 w-4 text-adam-text-secondary" />
                    <span>Upload</span>
                  </DropdownMenuItem>
                  {type === 'creative' && (
                    <DropdownMenuItem
                      className="gap-2 rounded-md text-adam-text-primary hover:cursor-pointer"
                      disabled={isLoading || isGeneratingInputImage}
                      onSelect={() => openImageCreator()}
                    >
                      <Sparkles className="h-4 w-4 text-adam-blue" />
                      <span>Generate</span>
                      <span className="ml-auto rounded-md bg-adam-neutral-800 px-1.5 py-0.5 text-[10px] text-adam-text-secondary">
                        {formatTokenCost(
                          getImageGenerationTokenCost(
                            selectedImageGenerationModel,
                          ),
                        )}
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* CAD / Mesh segmented control */}
            {onTypeChange && (
              <div className="flex items-center gap-0.5 rounded-lg border border-[#2a2a2a] bg-adam-background-2 p-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
                        type === 'parametric'
                          ? 'bg-adam-blue/15 text-adam-blue'
                          : 'text-adam-text-secondary hover:bg-adam-bg-secondary-dark',
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (type !== 'parametric') onTypeChange('parametric');
                      }}
                    >
                      <Ruler className="h-4 w-4" />
                      <span className="hidden lg:inline">CAD</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Generate a CAD model â€” precise parts, mechanisms,
                    practical engineering
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
                        type === 'creative'
                          ? 'bg-adam-blue/15 text-adam-blue'
                          : 'text-adam-text-secondary hover:bg-adam-bg-secondary-dark',
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (type !== 'creative') onTypeChange('creative');
                      }}
                    >
                      <Box className="h-4 w-4" />
                      <span className="hidden lg:inline">Mesh</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Generate a mesh â€” figurines, organic shapes, sculpts
                  </TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* Quads vs Polys toggle button - show for standard and ultra models */}
            {type === 'creative' && shouldShowQuadsControls(model) && (
              <QuadsButton
                meshTopology={meshTopology}
                showFullLabels={showFullLabels}
                isLoading={isLoading}
                disabled={disabled}
                onToggle={() =>
                  handleMeshTopologyChange(
                    meshTopology === 'quads' ? 'polys' : 'quads',
                  )
                }
              />
            )}

            {/* Polygon Count button - show for standard and ultra models */}
            {type === 'creative' && shouldShowQuadsControls(model) && (
              <PolygonButton
                polygonCount={polygonCount}
                meshTopology={meshTopology}
                model={model}
                showFullLabels={showFullLabels}
                isLoading={isLoading}
                disabled={disabled || false}
                onPolygonCountChange={setPolygonCountForCurrentModel}
                onReset={resetPolygonCount}
              />
            )}
          </div>

          <div className="flex items-center gap-2">
            <ModelSelector
              disabled={isLoading || disabled}
              models={memoizedModels}
              selectedModel={model}
              onModelChange={setModel}
              type={type}
              focused={isFocused}
            />
            {/* Enhanced submit button */}
            {isLoading && stopGenerating ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={stopGenerating}
                    className="flex h-8 w-8 transform items-center justify-center rounded-lg bg-adam-neutral-700 p-1 text-white transition-all duration-300 hover:scale-105 hover:bg-adam-blue/90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 disabled:hover:bg-adam-blue"
                  >
                    <Square className="h-5 w-5 fill-white" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Stop generation</TooltipContent>
              </Tooltip>
            ) : (
              <button
                onClick={() => {
                  handleSubmit();
                }}
                className={cn(
                  'flex h-8 w-8 transform items-center justify-center rounded-lg bg-adam-neutral-700 p-1 text-white transition-all duration-300 hover:scale-105 hover:bg-adam-blue/90 disabled:opacity-50 disabled:hover:scale-100 disabled:hover:bg-adam-blue',
                  (images.some((img) => img.isUploading) ||
                    anyMultiviewBusy(multiviewSlots)) &&
                    'opacity-50',
                )}
                disabled={
                  isLoading ||
                  disabled ||
                  isGeneratingInputImage ||
                  !canSubmit ||
                  (isMultiview ? false : images.some((img) => img.isUploading))
                }
              >
                <ArrowUp className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TextAreaChat;
