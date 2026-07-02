import { MeshData } from '@shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Loader2 } from 'lucide-react';
import { ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import posthog from 'posthog-js';
import {
  processUserModelForDownload,
  processUserModelForPrint,
} from '@/utils/meshPrintProcessUtils';
import { useConversation } from '@/contexts/ConversationContext';
import { useToast } from '@/hooks/use-toast';
import { generate3DModelFilename } from '@/utils/file-utils';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import { GLTF, OBJExporter, GLTFExporter } from 'three-stdlib';
import { useIsMobile } from '@/hooks/useIsMobile';
import * as Sentry from '@sentry/react';
import * as THREE from 'three';
import { applyMaterialAdjustments } from '@/utils/meshUtils';
import { MeshGifPreview } from './MeshGifPreview';
import { extractAndDownloadTextures } from '@/utils/textureExtraction';
import {
  DEFAULT_THREE_MF_COLOR_DETAIL,
  createThreeMfBlobFromColoredMesh,
  createThreeMfBlobFromScene,
  type ThreeMfColoredMesh,
  type ThreeMfTargetMaterialPalette,
  type ThreeMfSemanticMaterialMap,
} from '@/utils/threeMfExport';
import { ThreeMfColorPrintDialog } from './ThreeMfColorPrintDialog';

// Default values for material controls
const DEFAULT_BRIGHTNESS = 50;
const DEFAULT_ROUGHNESS = 50;
const DEFAULT_NORMAL_INTENSITY = 100;

function getThreeMfSemanticMaterialMap(
  value: unknown,
): ThreeMfSemanticMaterialMap | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<ThreeMfSemanticMaterialMap>;
  if (!Array.isArray(candidate.classes)) {
    return null;
  }

  const classes = candidate.classes.filter(
    (materialClass) =>
      materialClass &&
      typeof materialClass === 'object' &&
      Number.isInteger(materialClass.id) &&
      typeof materialClass.name === 'string' &&
      /^#?[0-9a-fA-F]{6}$/.test(materialClass.color),
  );
  const triangleMaterialIds = Array.isArray(candidate.triangleMaterialIds)
    ? candidate.triangleMaterialIds.filter((id) => Number.isInteger(id))
    : undefined;

  if (classes.length === 0) {
    return null;
  }

  return {
    classes,
    ...(triangleMaterialIds?.length ? { triangleMaterialIds } : {}),
  };
}

function getThreeMfTargetMaterialPalette({
  semanticMaterialMap,
}: {
  semanticMaterialMap: ThreeMfSemanticMaterialMap | null;
}): ThreeMfTargetMaterialPalette | null {
  if (semanticMaterialMap?.triangleMaterialIds?.length) {
    return null;
  }

  if (semanticMaterialMap?.classes.length) {
    return semanticMaterialMap.classes.map(
      (materialClass) => materialClass.color,
    );
  }

  return null;
}

// Reusable download menu items component
export function DownloadMenu({
  hasPBRMaps,
  meshData,
  gltf,
  brightness,
  roughness,
  normalIntensity,
  children,
}: {
  hasPBRMaps: { [key: string]: boolean };
  meshData: MeshData;
  gltf: GLTF;
  brightness: number;
  roughness: number;
  normalIntensity: number;
  children: ReactNode;
}) {
  const { conversation } = useConversation();
  const { toast } = useToast();
  const { currentMessage } = useCurrentMessage();
  const isMobile = useIsMobile();

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isColorPrintDialogOpen, setIsColorPrintDialogOpen] = useState(false);

  // GIF generation state
  const [_isGifGenerating, setIsGifGenerating] = useState(false);
  const [_gifProgress, setGifProgress] = useState(0);
  const [isGifReady, setIsGifReady] = useState(false);
  const gifRef = useRef<{ downloadGIF: () => Promise<void> } | null>(null);

  const [isDownloadingSTL, setIsDownloadingSTL] = useState(false);
  const [isDownloading3MF, setIsDownloading3MF] = useState(false);
  const [isDownloadingOBJ, setIsDownloadingOBJ] = useState(false);
  const [isDownloadingGIF, setIsDownloadingGIF] = useState(false);
  const [isDownloadingWithTextures, setIsDownloadingWithTextures] =
    useState(false);
  const [isDownloadingGLB, setIsDownloadingGLB] = useState(false);

  // Generate a safe filename for downloads
  const filename = useMemo(() => {
    return generate3DModelFilename({
      conversationTitle: conversation?.title,
      assistantMessage: currentMessage || undefined,
      modelName: meshData?.prompt.model,
      fallback: `3d-model-${meshData.id}`,
    });
  }, [
    conversation?.title,
    currentMessage,
    meshData?.prompt.model,
    meshData.id,
  ]);

  const semanticMaterialMap = useMemo(
    () => getThreeMfSemanticMaterialMap(meshData.prompt.semanticMaterialMap),
    [meshData.prompt.semanticMaterialMap],
  );
  const targetMaterialPalette = useMemo(
    () => getThreeMfTargetMaterialPalette({ semanticMaterialMap }),
    [semanticMaterialMap],
  );

  const downloadSTL = useCallback(() => {
    posthog.capture('3d_model_download', {
      meshId: meshData.id,
      model_name: meshData?.prompt.model || 'Unknown Model',
      format: 'STL',
      conversation_id: conversation.id,
    });

    setIsDownloadingSTL(true);

    // Force the download to macro task queue
    setTimeout(async () => {
      try {
        // Apply the same scaling logic used for printable model exports.
        const processedFile = await processUserModelForPrint(
          gltf,
          () => filename,
        );

        // The processUserModelForPrint already returns a properly sized STL file
        const url = URL.createObjectURL(processedFile);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.stl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            meshId: meshData.id,
            format: 'STL',
          },
        });
        toast({
          title: 'Error',
          description: 'Failed to prepare STL file.',
          variant: 'destructive',
        });
      } finally {
        setIsDownloadingSTL(false);
        setIsDropdownOpen(false);
      }
    }, 0);
  }, [gltf, toast, filename, meshData, conversation.id]);

  const download3MF = useCallback(
    (
      colorCount: number,
      {
        colorDetail = DEFAULT_THREE_MF_COLOR_DETAIL,
        coloredMesh,
      }: {
        colorDetail?: number;
        coloredMesh?: ThreeMfColoredMesh;
      } = {},
    ) => {
      posthog.capture('3d_model_download', {
        meshId: meshData.id,
        model_name: meshData?.prompt.model || 'Unknown Model',
        format: '3MF_MULTI_COLOR',
        conversation_id: conversation.id,
        color_count: colorCount,
        color_detail: colorDetail,
      });

      setIsDownloading3MF(true);
      setIsDropdownOpen(false);

      setTimeout(async () => {
        try {
          let threeMfBlob: Blob;
          if (coloredMesh) {
            // The color print dialog already computed the colored mesh for
            // its preview; package exactly what the user saw.
            threeMfBlob = await createThreeMfBlobFromColoredMesh({
              coloredMesh,
              filename,
            });
          } else {
            const processedScene = await processUserModelForDownload(gltf);
            threeMfBlob = await createThreeMfBlobFromScene({
              scene: processedScene,
              filename,
              colorCount,
              colorDetail,
              semanticMaterialMap,
              targetMaterialPalette: getThreeMfTargetMaterialPalette({
                semanticMaterialMap,
              }),
            });

            processedScene.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                  child.material.forEach((mat) => mat.dispose());
                } else {
                  child.material.dispose();
                }
              }
            });
          }

          const url = URL.createObjectURL(threeMfBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${filename}.3mf`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (error) {
          Sentry.captureException(error, {
            extra: {
              meshId: meshData.id,
              format: '3MF_MULTI_COLOR',
              color_count: colorCount,
              color_detail: colorDetail,
            },
          });
          toast({
            title: 'Error',
            description: 'Failed to prepare the multi-color 3MF file.',
            variant: 'destructive',
          });
        } finally {
          setIsDownloading3MF(false);
          setIsDropdownOpen(false);
          setIsColorPrintDialogOpen(false);
        }
      }, 0);
    },
    [conversation.id, filename, gltf, meshData, semanticMaterialMap, toast],
  );

  const downloadOBJ = useCallback(() => {
    posthog.capture('3d_model_download', {
      meshId: meshData.id,
      model_name: meshData?.prompt.model || 'Unknown Model',
      format: 'OBJ_WITH_MTL',
      conversation_id: conversation.id,
    });

    setIsDownloadingOBJ(true);

    setTimeout(async () => {
      try {
        // Apply the same scaling logic used for printable model exports.
        const processedScene = await processUserModelForDownload(gltf);

        // Helper function to clone and adjust material settings
        const cloneAndAdjustMaterial = (
          mat: THREE.MeshStandardMaterial,
          materialIndex: number,
        ): THREE.MeshStandardMaterial => {
          const clonedMat = mat.clone();

          // Apply current UI settings using shared helper
          const actualBrightness = brightness / 50;
          const actualRoughness = roughness / 100;
          applyMaterialAdjustments(
            clonedMat,
            actualBrightness,
            actualRoughness,
          );

          // Assign material name for MTL reference
          if (!materials.has(clonedMat)) {
            materials.set(clonedMat, `material_${materialIndex}`);
          }

          return clonedMat;
        };

        // Create a clone of the processed scene with current material settings applied
        const clonedScene = new THREE.Scene();
        const materials = new Map<THREE.Material, string>();
        let materialIndex = 0;

        // Clone the processed scene with applied material settings and collect materials
        processedScene.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            const newGeometry = node.geometry.clone();
            let newMaterial;

            if (Array.isArray(node.material)) {
              newMaterial = node.material.map((mat) =>
                cloneAndAdjustMaterial(mat, materialIndex++),
              );
            } else {
              newMaterial = cloneAndAdjustMaterial(
                node.material,
                materialIndex++,
              );
            }

            const newMesh = new THREE.Mesh(newGeometry, newMaterial);
            newMesh.position.copy(node.position);
            newMesh.quaternion.copy(node.quaternion);
            newMesh.scale.copy(node.scale);
            // Use the generated filename instead of "tripo" or original name
            newMesh.name = filename;
            clonedScene.add(newMesh);
          }
        });

        // Export OBJ with material references
        const objExporter = new OBJExporter();
        const objContent = objExporter.parse(clonedScene);

        // Create MTL content
        let mtlContent = `# MTL file for ${filename}\n`;
        mtlContent += `# Generated by AzureFilm - ${new Date().toISOString()}\n`;
        mtlContent += `# Model processed with printable export scaling\n\n`;

        for (const [material, materialName] of materials.entries()) {
          mtlContent += `newmtl ${materialName}\n`;

          // Add diffuse color (main color)
          if ('color' in material && material.color instanceof THREE.Color) {
            const color = material.color as THREE.Color;
            mtlContent += `Kd ${color.r.toFixed(6)} ${color.g.toFixed(6)} ${color.b.toFixed(6)}\n`;
            // Ambient color (slightly darker)
            mtlContent += `Ka ${(color.r * 0.2).toFixed(6)} ${(color.g * 0.2).toFixed(6)} ${(color.b * 0.2).toFixed(6)}\n`;
          } else {
            // Default gray color
            mtlContent += `Kd 0.800000 0.800000 0.800000\n`;
            mtlContent += `Ka 0.200000 0.200000 0.200000\n`;
          }

          // Add specular properties based on roughness
          if ('roughness' in material) {
            const roughness =
              (material as THREE.MeshStandardMaterial).roughness || 0.5;
            const shininess = Math.max(1, (1 - roughness) * 128);
            mtlContent += `Ns ${shininess.toFixed(6)}\n`;
            mtlContent += `Ks 0.500000 0.500000 0.500000\n`;
          } else {
            mtlContent += `Ns 32.000000\n`;
            mtlContent += `Ks 0.500000 0.500000 0.500000\n`;
          }

          // Illumination model (2 = highlight on)
          mtlContent += `illum 2\n`;
          // Opacity
          mtlContent += `d 1.000000\n\n`;
        }

        // Add MTL reference to OBJ content
        const objWithMtl = `mtllib ${filename}.mtl\n${objContent}`;

        // Create download helper function
        const downloadFile = (
          content: string,
          filename: string,
          mimeType: string,
        ): Promise<void> => {
          return new Promise((resolve) => {
            const blob = new Blob([content], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;

            // Use event listener to know when download completes
            link.addEventListener('click', () => {
              // Small delay to ensure download starts, then clean up and resolve
              setTimeout(() => {
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                resolve();
              }, 100);
            });

            document.body.appendChild(link);
            link.click();
          });
        };

        // Download OBJ file first, then MTL file
        await downloadFile(objWithMtl, `${filename}.obj`, 'text/plain');
        await downloadFile(mtlContent, `${filename}.mtl`, 'text/plain');

        // Clean up cloned scene
        clonedScene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => mat.dispose());
            } else {
              child.material.dispose();
            }
          }
        });

        // Clean up processed scene
        processedScene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => mat.dispose());
            } else {
              child.material.dispose();
            }
          }
        });
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            meshId: meshData.id,
            format: 'OBJ_WITH_MTL',
          },
        });

        toast({
          title: 'Error',
          description: 'Failed to prepare the OBJ files with colors.',
          variant: 'destructive',
        });
      } finally {
        setIsDownloadingOBJ(false);
        setIsDropdownOpen(false);
      }
    }, 0);
  }, [gltf, brightness, roughness, filename, meshData, conversation.id, toast]);

  const downloadGIF = useCallback(() => {
    posthog.capture('3d_model_download', {
      meshId: meshData.id,
      model_name: meshData?.prompt.model || 'Unknown Model',
      format: 'GIF',
      conversation_id: conversation.id,
    });

    setIsDownloadingGIF(true);

    setTimeout(async () => {
      try {
        if (gifRef.current && isGifReady) {
          await gifRef.current.downloadGIF();
        }
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            meshId: meshData.id,
            format: 'GIF',
          },
        });

        toast({
          title: 'Error',
          description: 'Failed to generate GIF. Please try again.',
          variant: 'destructive',
        });
      } finally {
        setIsDownloadingGIF(false);
        setIsDropdownOpen(false);
      }
    }, 0);
  }, [isGifReady, meshData, conversation.id, toast]);

  // Helper function to apply current UI settings to a material
  const applyCurrentSettingsToMaterial = useCallback(
    (material: THREE.MeshStandardMaterial) => {
      const actualBrightness = brightness / 50;
      const actualRoughness = roughness / 100;
      const actualNormalIntensity = normalIntensity / 100;

      applyMaterialAdjustments(
        material,
        actualBrightness,
        actualRoughness,
        actualNormalIntensity,
      );
    },
    [brightness, roughness, normalIntensity],
  );

  // Enhanced GLB creation with embedded PBR textures and applied settings
  const createEnhancedGLB = useCallback(
    async (
      originalScene: THREE.Group | THREE.Scene,
      filename: string,
    ): Promise<Blob> => {
      return new Promise((resolve, reject) => {
        try {
          // Clone the scene with current material settings applied
          const enhancedScene = new THREE.Scene();

          originalScene.traverse((node) => {
            if (node instanceof THREE.Mesh) {
              const newGeometry = node.geometry.clone();
              let newMaterial;

              if (Array.isArray(node.material)) {
                newMaterial = node.material.map((mat) => {
                  const clonedMat = mat.clone();
                  // Apply current UI settings to the cloned material
                  applyCurrentSettingsToMaterial(clonedMat);
                  return clonedMat;
                });
              } else {
                newMaterial = node.material.clone();
                // Apply current UI settings to the cloned material
                applyCurrentSettingsToMaterial(newMaterial);
              }

              const newMesh = new THREE.Mesh(newGeometry, newMaterial);
              newMesh.position.copy(node.position);
              newMesh.quaternion.copy(node.quaternion);
              newMesh.scale.copy(node.scale);
              newMesh.name = filename;
              enhancedScene.add(newMesh);
            }
          });

          // Use GLTFExporter to create GLB with embedded textures
          const exporter = new GLTFExporter();
          exporter.parse(
            enhancedScene,
            (result) => {
              const blob = new Blob([result as ArrayBuffer], {
                type: 'model/gltf-binary',
              });

              // Clean up cloned scene
              enhancedScene.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                  child.geometry.dispose();
                  if (Array.isArray(child.material)) {
                    child.material.forEach((mat) => mat.dispose());
                  } else {
                    child.material.dispose();
                  }
                }
              });

              resolve(blob);
            },
            (error) => {
              reject(error);
            },
            {
              binary: true,
              embedImages: true, // Embed all textures in the GLB
              maxTextureSize: 2048, // Reasonable size limit for compatibility
              includeCustomExtensions: true,
            },
          );
        } catch (error) {
          reject(error);
        }
      });
    },
    [applyCurrentSettingsToMaterial],
  );

  const downloadWithTextures = useCallback(() => {
    posthog.capture('3d_model_download', {
      meshId: meshData.id,
      model_name: meshData?.prompt.model || 'Unknown Model',
      format: 'ZIP_WITH_PRINTABLE_GLB_AND_TEXTURES',
      conversation_id: conversation.id,
      texture_types: Object.entries(hasPBRMaps)
        .filter(([_, hasMap]) => hasMap)
        .map(([type, _]) => type),
    });

    setIsDownloadingWithTextures(true);

    setTimeout(async () => {
      let processedScene: THREE.Scene | null = null;
      try {
        processedScene = await processUserModelForDownload(gltf);
        const printableGlb = await createEnhancedGLB(processedScene, filename);

        const success = await extractAndDownloadTextures(
          gltf,
          printableGlb,
          filename,
          'glb',
        );

        if (!success) {
          throw new Error('Texture extraction returned false');
        }
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            meshId: meshData.id,
            format: 'ZIP_WITH_PRINTABLE_GLB_AND_TEXTURES',
            error: error instanceof Error ? error.message : 'Unknown error',
            texture_types: Object.entries(hasPBRMaps)
              .filter(([_, hasMap]) => hasMap)
              .map(([type, _]) => type),
          },
        });

        // Provide more helpful error messages
        let errorDescription = 'Failed to extract textures. ';

        if (error instanceof Error) {
          if (error.message.includes('No PBR textures found')) {
            errorDescription +=
              'The model does not contain any PBR texture maps.';
          } else if (error.message.includes('Failed to convert')) {
            errorDescription +=
              'Texture conversion failed. The texture format might not be supported.';
          } else if (error.message.includes('WebGL')) {
            errorDescription +=
              'Graphics rendering issue. Try refreshing the page.';
          }
        } else {
          errorDescription +=
            'Unknown error occurred during texture extraction.';
        }

        toast({
          title: 'Texture extraction failed',
          description:
            errorDescription + ' You can still download the standard GLB file.',
          variant: 'destructive',
          duration: 8000,
        });
      } finally {
        if (processedScene) {
          processedScene.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose();
              if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose());
              } else {
                child.material.dispose();
              }
            }
          });
        }
        setIsDownloadingWithTextures(false);
        setIsDropdownOpen(false);
      }
    }, 0);
  }, [
    createEnhancedGLB,
    filename,
    gltf,
    hasPBRMaps,
    meshData,
    conversation.id,
    toast,
  ]);

  const downloadGLB = useCallback(() => {
    posthog.capture('3d_model_download', {
      meshId: meshData.id,
      model_name: meshData?.prompt.model || 'Unknown Model',
      format: 'GLB_PRINTABLE_ENHANCED',
      conversation_id: conversation.id,
      has_embedded_textures: Object.values(hasPBRMaps).some(Boolean),
      has_material_adjustments:
        brightness !== DEFAULT_BRIGHTNESS ||
        roughness !== DEFAULT_ROUGHNESS ||
        normalIntensity !== DEFAULT_NORMAL_INTENSITY,
    });

    setIsDownloadingGLB(true);

    setTimeout(async () => {
      let processedScene: THREE.Scene | null = null;
      try {
        processedScene = await processUserModelForDownload(gltf);
        const enhancedBlob = await createEnhancedGLB(processedScene, filename);

        const url = URL.createObjectURL(enhancedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.glb`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (error) {
        Sentry.captureException(error, {
          extra: {
            meshId: meshData.id,
            format: 'GLB_PRINTABLE_ENHANCED',
          },
        });

        toast({
          title: 'Error',
          description: 'Failed to create printable GLB.',
          variant: 'destructive',
        });
      } finally {
        if (processedScene) {
          processedScene.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose();
              if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose());
              } else {
                child.material.dispose();
              }
            }
          });
        }
        setIsDownloadingGLB(false);
        setIsDropdownOpen(false);
      }
    }, 0);
  }, [
    gltf,
    meshData,
    conversation.id,
    toast,
    createEnhancedGLB,
    hasPBRMaps,
    brightness,
    roughness,
    normalIntensity,
    filename,
  ]);

  return (
    <>
      <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align={isMobile ? 'center' : 'end'}>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              downloadSTL();
            }}
            className="cursor-pointer text-adam-text-primary"
            disabled={isDownloadingSTL}
          >
            {isDownloadingSTL ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            <span className="text-sm">.STL</span>
            <span className="ml-3 text-xs text-adam-text-primary/60">
              {isDownloadingSTL ? 'Downloading...' : '3D Printing'}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              posthog.capture('3mf_color_print_dialog_open', {
                meshId: meshData.id,
                conversation_id: conversation.id,
              });
              setIsDropdownOpen(false);
              setIsColorPrintDialogOpen(true);
            }}
            className="cursor-pointer text-adam-text-primary"
            disabled={isDownloading3MF}
          >
            {isDownloading3MF ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            <span className="text-sm">.3MF</span>
            <span className="ml-3 text-xs text-adam-text-primary/60">
              {isDownloading3MF ? 'Downloading...' : 'Color print'}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              downloadOBJ();
            }}
            className="cursor-pointer text-adam-text-primary"
            disabled={isDownloadingOBJ}
          >
            {isDownloadingOBJ ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            <span className="text-sm">.OBJ</span>
            <span className="ml-3 text-xs text-adam-text-primary/60">
              {isDownloadingOBJ ? 'Downloading...' : 'Universal'}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              downloadGLB();
            }}
            className="cursor-pointer text-adam-text-primary"
            disabled={isDownloadingGLB}
          >
            {isDownloadingGLB ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            <span className="text-sm">.GLB</span>
            <span className="ml-3 text-xs text-adam-text-primary/60">
              {isDownloadingGLB ? 'Downloading...' : 'Web & XR'}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              downloadGIF();
            }}
            className="cursor-pointer text-adam-text-primary"
            disabled={!isGifReady || isDownloadingGIF}
          >
            {isDownloadingGIF ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            <span className="text-sm">.GIF</span>
            <span className="ml-3 text-xs text-adam-text-primary/60">
              {isDownloadingGIF ? 'Downloading...' : 'Animation'}
            </span>
          </DropdownMenuItem>
          {/* Conditionally show Download with Textures */}
          {Object.values(hasPBRMaps).some(Boolean) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => {
                  e.preventDefault();
                  downloadWithTextures();
                }}
                className="cursor-pointer text-adam-text-primary"
                disabled={!gltf || isDownloadingWithTextures}
              >
                {isDownloadingWithTextures ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                <span className="text-sm">.ZIP with Textures</span>
                <span className="ml-3 text-xs text-adam-text-primary/60">
                  {isDownloadingWithTextures
                    ? 'Downloading...'
                    : 'GLB With Textures'}
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ThreeMfColorPrintDialog
        open={isColorPrintDialogOpen}
        onOpenChange={setIsColorPrintDialogOpen}
        gltf={gltf}
        semanticMaterialMap={semanticMaterialMap}
        targetMaterialPalette={targetMaterialPalette}
        isDownloading={isDownloading3MF}
        onDownload={({ colorCount, colorDetail, coloredMesh }) =>
          download3MF(colorCount, { colorDetail, coloredMesh })
        }
      />
      <div
        className="pointer-events-none fixed -left-[1000px] -top-[1000px] z-[-1]"
        style={{
          width: '512px',
          height: '317px',
        }}
      >
        <MeshGifPreview
          ref={gifRef}
          meshId={meshData.id}
          setIsGenerating={setIsGifGenerating}
          setProgress={setGifProgress}
          setReadyToDownload={setIsGifReady}
        />
      </div>
      {isDownloading3MF ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 right-4 z-50 w-[min(calc(100vw-2rem),20rem)] overflow-hidden rounded-md border border-adam-blue/40 bg-adam-neutral-950/95 text-adam-text-primary shadow-2xl shadow-black/40 backdrop-blur sm:bottom-8 sm:right-8"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-adam-blue" />
            <div className="min-w-0">
              <div className="text-sm font-medium">Preparing .3MF</div>
              <div className="text-xs text-adam-text-secondary">
                Building color print file
              </div>
            </div>
          </div>
          <div className="h-1 overflow-hidden bg-adam-neutral-800">
            <div className="h-full w-1/2 animate-[download-progress_1.1s_ease-in-out_infinite] bg-adam-blue" />
          </div>
        </div>
      ) : null}
    </>
  );
}
