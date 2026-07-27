import {
  Environment,
  OrbitControls,
  Stage,
  PerspectiveCamera,
} from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import {
  Download,
  Frown,
  HeartCrack,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { GLTF } from 'three-stdlib';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { CreativeLoadingBar } from './CreativeLoadingBar';
import { LightingControls } from './LightingControls';
import { ModelWithControls } from './ModelWithControls';

import posthog from 'posthog-js';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { useMeshData } from '@/hooks/useMeshData';
import {
  loadMeshBlobAsGltf,
  type DetectedPbrMaps,
} from '@/utils/loadMeshAsGltf';
import { DownloadMenu } from './DownloadMenu';
import { ViewGizmo } from './ViewGizmo';
import { WireframeIcon } from '@/components/icons/ui/WireframeIcon';
import { applyFlatBottomToScene } from '@/utils/flatBottomScene';

// Default values for material controls
import {
  DEFAULT_BRIGHTNESS,
  DEFAULT_BRIGHTNESS_UPSCALED,
  DEFAULT_ROUGHNESS,
  DEFAULT_NORMAL_INTENSITY,
  getModelDefaultBrightness,
} from '@/constants/meshConstants';
import { CreativeModel } from '@shared/types';

const NO_PBR_MAPS: DetectedPbrMaps = {
  albedo: false,
  normal: false,
  roughness: false,
  metallic: false,
  ao: false,
};

/**
 * MeshPreview - Displays a 3D model with interactive controls for visual adjustments.
 *
 * This component handles:
 * 1. Loading and displaying a 3D model from Supabase storage
 * 2. Providing tools to adjust lighting, contrast, and texture visibility
 * 3. Offering download options in various 3D formats (STL, OBJ, GLB)
 * 4. Toggling between orthographic and perspective camera views
 *
 * Key Implementation Details:
 *
 * - Remounting System:
 *   The component uses a combination of keys and a mountId state to ensure proper
 *   rendering when switching between different models or messages. When meshId changes
 *   or a new model loads, the mountId increments, forcing a complete remount of the
 *   Canvas and ModelWithControls components. This guarantees that material states are
 *   properly reset and visual settings are correctly applied, or when navigating
 *   between different messages in the conversation.
 *
 * - State Initialization:
 *   Default values are applied when loading a new model and when switching between messages.
 *   This ensures consistent behavior regardless of navigation patterns within the application.
 *
 * @param {Object} props - Component props
 * @param {string} props.meshId - Unique identifier for the 3D mesh to display
 */
export function MeshPreview({ meshId }: { meshId: string }) {
  const isMobile = useIsMobile();

  // Replace separate texture and wireframe states with a single view mode
  type ViewMode = 'textured' | 'textureless' | 'wireframe';
  const [viewMode, setViewMode] = useState<ViewMode>('textured');

  // Derived states for backward compatibility
  const showTexture = viewMode === 'textured';
  const wireframe = viewMode === 'wireframe';

  const [brightness, setBrightness] = useState(DEFAULT_BRIGHTNESS);
  const [roughness, setRoughness] = useState(DEFAULT_ROUGHNESS);
  const [normalIntensity, setNormalIntensity] = useState(
    DEFAULT_NORMAL_INTENSITY,
  );
  const [gltf, setGltf] = useState<GLTF | null>(null);
  const [polygonCount, setPolygonCount] = useState<number | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);

  // Check if model has PBR maps available
  const [hasPBRMaps, setHasPBRMaps] = useState<DetectedPbrMaps>(NO_PBR_MAPS);

  // Fetch mesh data and blob early so it can be used by effects below
  const {
    data: { data: meshData, isLoading: isMeshDataLoading },
    blob: { data: mesh, isLoading: isMeshLoading },
  } = useMeshData({
    id: meshId,
  });

  // Detect upscaled models (need special lighting treatment)
  const isUpscaled = useMemo(
    () =>
      !!(
        meshData?.prompt &&
        typeof meshData.prompt === 'object' &&
        'upscaledFrom' in meshData.prompt &&
        meshData.prompt.upscaledFrom
      ),
    [meshData?.prompt],
  );

  // Reset material states when meshId changes
  useEffect(() => {
    // Reset to defaults when switching between messages
    setViewMode('textured');
    // Set brightness based on model configuration
    // Upscaled models need higher brightness to show color correctly
    const modelBrightness = isUpscaled
      ? DEFAULT_BRIGHTNESS_UPSCALED
      : meshData?.prompt.model
        ? getModelDefaultBrightness(meshData.prompt.model as CreativeModel)
        : DEFAULT_BRIGHTNESS;
    setBrightness(modelBrightness);
    setRoughness(DEFAULT_ROUGHNESS);
    setNormalIntensity(DEFAULT_NORMAL_INTENSITY);
    setGltf(null);
    setPolygonCount(undefined);
    setError(null);
    setHasPBRMaps(NO_PBR_MAPS);
  }, [meshId, isUpscaled, meshData?.prompt.model]);

  // Was this model generated with the "flat bottom" option? The cut is applied
  // to the loaded scene here — the one object the viewport, DownloadMenu's
  // exports and both viewer dialogs all share — so they agree on the geometry.
  const wantsFlatBottom = !!(
    meshData?.prompt &&
    typeof meshData.prompt === 'object' &&
    'flatBottom' in meshData.prompt &&
    meshData.prompt.flatBottom
  );

  useEffect(() => {
    let cancelled = false;

    const loadMesh = async (meshBlob: Blob) => {
      try {
        const loaded = await loadMeshBlobAsGltf(
          meshBlob,
          meshData?.file_type || 'glb',
        );
        if (cancelled) return;

        if (wantsFlatBottom) {
          // Any non-'cut' outcome leaves the scene untouched. The model is
          // still published in that case — showing it without the flat
          // underside beats showing nothing at all.
          const cut = await applyFlatBottomToScene(loaded.gltf.scene);
          if (cancelled) return;
          if (cut.status === 'failed') {
            posthog.capture('flat_bottom_cut_failed', {
              meshId,
              reason: cut.message,
            });
          }
        }

        setGltf(loaded.gltf);
        setPolygonCount(loaded.polygonCount);
        setHasPBRMaps(loaded.pbrMaps);
        // Note: Default values are set by useEffect when meshId changes
        setViewMode('textured');
      } catch (loadError) {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Failed to process mesh',
        );
      }
    };

    if (mesh && meshData) {
      loadMesh(mesh);
    }

    return () => {
      cancelled = true;
    };
  }, [mesh, meshData, meshId, wantsFlatBottom]);

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    posthog.capture('view_mode_changed', {
      mode,
      meshId,
    });
  };

  if (meshData && meshData.status === 'pending') {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <CreativeLoadingBar
          startTime={new Date(meshData.created_at).getTime()}
          modelType="mesh"
          modelName={
            (meshData?.prompt.model ?? undefined) as CreativeModel | undefined
          }
          meshId={meshId}
        />
      </div>
    );
  }

  if (isMeshDataLoading || isMeshLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin" />
      </div>
    );
  }

  if (!meshData) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-adam-text-primary">
        <Frown className="h-10 w-10" />
        <span>3D Object Data not found</span>
      </div>
    );
  }

  if (meshData.status === 'failure' || error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-adam-text-primary">
        <HeartCrack className="h-10 w-10" />
        <span>{error ?? '3D Object failed to generate'}</span>
        <span className="text-sm text-adam-neutral-400">
          Use Retry on the message in the chat to try again
        </span>
      </div>
    );
  }

  if (!mesh) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-adam-text-primary">
        <Frown className="h-10 w-10" />
        <span>This 3D object's file is no longer available</span>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2">
      <div
        className={cn(
          'h-full w-full',
          isMobile && 'aspect-square overflow-hidden rounded-lg bg-[#3B3B3B]',
        )}
      >
        <Canvas
          gl={{ toneMapping: THREE.NoToneMapping }}
          style={{
            width: '100%',
            height: '100%',
            touchAction: 'none',
          }}
        >
          <color attach="background" args={['#3B3B3B']} />
          <PerspectiveCamera
            makeDefault
            position={[-1, 1, 1]}
            fov={45}
            near={0.1}
            far={1000}
            zoom={0.4}
          />
          <Environment preset="city" />
          <Stage
            environment={null}
            intensity={brightness / 50}
            adjustCamera={false}
            shadows={false}
          >
            <ambientLight intensity={brightness / 100} />
            {gltf && (
              <ModelWithControls
                gltf={gltf}
                brightness={brightness}
                roughness={roughness}
                normalIntensity={normalIntensity}
                showTexture={showTexture}
                wireframe={wireframe}
                isUpscaled={isUpscaled}
              />
            )}
          </Stage>
          <OrbitControls makeDefault />
          {!isMobile && <ViewGizmo alignment="top-left" margin={[80, 65]} />}
        </Canvas>
      </div>

      {/* Bottom center controls for view mode */}
      <div className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 transform lg:flex">
        {meshData?.prompt.model !== 'fast' ? (
          <ViewModeControl
            viewMode={viewMode}
            handleViewModeChange={handleViewModeChange}
          />
        ) : (
          // For fast model, only show wireframe toggle since texture isn't supported
          <div className="flex items-center gap-2 rounded-full bg-adam-neutral-900 px-3 py-2 shadow-[0px_4px_24px_0px_rgba(0,0,0,0.32)]">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => handleViewModeChange('textureless')}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                    viewMode === 'textureless' &&
                      'border-2 border-adam-neutral-500',
                  )}
                  style={{
                    background:
                      'linear-gradient(135deg, #D9D9D9 0%, #6F6F6F 100%)',
                  }}
                  aria-label="Solid view"
                ></button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
              >
                <p>Solid view</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => handleViewModeChange('wireframe')}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                    viewMode === 'wireframe'
                      ? 'border-2 border-adam-neutral-500 bg-transparent text-adam-neutral-500'
                      : 'bg-transparent text-adam-neutral-500',
                  )}
                  aria-label="Wireframe view"
                >
                  <WireframeIcon />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
              >
                <p>Wireframe view</p>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {!isMobile && (
        <LightingControls
          brightness={brightness}
          roughness={roughness}
          normalIntensity={normalIntensity}
          polygonCount={polygonCount}
          modelQuality={meshData?.prompt.model}
          isUpscaled={isUpscaled}
          onBrightnessChange={setBrightness}
          onRoughnessChange={setRoughness}
          onNormalIntensityChange={setNormalIntensity}
        />
      )}

      {/* Mobile controls */}
      {isMobile && (
        <>
          {/* Mobile download button */}
          {gltf && (
            <div className="mt-4 px-4">
              <DownloadMenu
                hasPBRMaps={hasPBRMaps}
                meshData={meshData}
                gltf={gltf}
                brightness={brightness}
                roughness={roughness}
                normalIntensity={normalIntensity}
              >
                <Button
                  size="lg"
                  className="mx-auto flex w-[75%] items-center gap-2 px-4 py-2.5 hover:bg-adam-background-2"
                >
                  <Download className="h-4 w-4" />
                  <span>Download</span>
                  <ChevronDown className="ml-1 h-3 w-3 opacity-70" />
                </Button>
              </DownloadMenu>
            </div>
          )}
        </>
      )}

      {/* Desktop download button - bottom right aligned with view mode toggles */}
      {!isMobile && gltf && (
        <div className="absolute bottom-7 right-4 z-10">
          <DownloadMenu
            hasPBRMaps={hasPBRMaps}
            meshData={meshData}
            gltf={gltf}
            brightness={brightness}
            roughness={roughness}
            normalIntensity={normalIntensity}
          >
            <Button size="lg" className="flex items-center gap-2 px-4 py-2.5">
              <Download className="h-4 w-4" />
              <span className="hidden xl:inline">Download</span>
              <ChevronDown className="ml-1 h-3 w-3 opacity-70" />
            </Button>
          </DownloadMenu>
        </div>
      )}
    </div>
  );
}

// Three-state segmented control component
function ViewModeControl({
  viewMode,
  handleViewModeChange,
}: {
  viewMode: 'textured' | 'textureless' | 'wireframe';
  handleViewModeChange: (
    mode: 'textured' | 'textureless' | 'wireframe',
  ) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-full bg-adam-neutral-900 px-3 py-2 shadow-[0px_4px_24px_0px_rgba(0,0,0,0.32)]">
      {/* Textured */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => handleViewModeChange('textured')}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
              viewMode === 'textured' && 'border-2 border-adam-neutral-500',
            )}
            style={{
              background: 'linear-gradient(135deg, #FFA3DD 0%, #05AFB8 100%)',
            }}
            aria-label="Textured view"
          ></button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
        >
          <p>Textured view</p>
        </TooltipContent>
      </Tooltip>

      {/* Textureless */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => handleViewModeChange('textureless')}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
              viewMode === 'textureless' && 'border-2 border-adam-neutral-500',
            )}
            style={{
              background: 'linear-gradient(135deg, #D9D9D9 0%, #6F6F6F 100%)',
            }}
            aria-label="Textureless view"
          ></button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
        >
          <p>Solid view</p>
        </TooltipContent>
      </Tooltip>

      {/* Wireframe */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => handleViewModeChange('wireframe')}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
              viewMode === 'wireframe'
                ? 'border-2 border-adam-neutral-500 bg-transparent text-adam-neutral-500'
                : 'bg-transparent text-adam-neutral-500',
            )}
            aria-label="Wireframe view"
          >
            <WireframeIcon />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
        >
          <p>Wireframe view</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
