import { useCallback, useEffect, useState, useRef } from 'react';
import * as THREE from 'three';
import { GLTF } from 'three-stdlib';

/**
 * ModelWithControls - Renders a 3D model with adjustable material properties.
 *
 * This component applies visual adjustments to the model's materials:
 * - Brightness: Controls overall lighting intensity and material brightness
 * - Roughness: Controls surface shininess and material roughness
 * - Normal Intensity: Controls normal map bump strength
 * - Wireframe: Shows mesh structure in wireframe mode
 *
 * The component stores original material properties when first mounted to allow
 * non-destructive adjustments. Material changes are applied using the stored originals
 * to prevent cumulative changes that could distort the model's appearance.
 */
export function ModelWithControls({
  gltf,
  brightness,
  roughness,
  normalIntensity,
  showTexture,
  wireframe,
  isUpscaled = false,
}: {
  gltf: GLTF;
  brightness: number;
  roughness: number;
  normalIntensity: number;
  showTexture: boolean;
  wireframe: boolean;
  isUpscaled?: boolean;
}) {
  // Reference to the scene to update materials
  const modelRef = useRef<THREE.Group>(null);
  // Store original material properties including all PBR maps
  const originalMaterials = useRef<
    Map<
      THREE.Material,
      {
        color?: THREE.Color;
        emissive?: THREE.Color;
        map?: THREE.Texture | null;
        normalMap?: THREE.Texture | null;
        roughnessMap?: THREE.Texture | null;
        metalnessMap?: THREE.Texture | null;
        aoMap?: THREE.Texture | null;
        wireframe?: boolean;
        vertexColors?: boolean;
      }
    >
  >(new Map());

  // Track if initial material processing is complete
  const [materialsInitialized, setMaterialsInitialized] = useState(false);

  // Map brightness from 0-100 to 0-2 range (allows for brightening)
  const actualBrightness = brightness / 50;
  // Map roughness from 0-100 to 0.0-1.0 range
  const actualRoughness = roughness / 100;
  // Map normal intensity from 0-100 to 0.0-1.0 range
  const actualNormalIntensity = normalIntensity / 100;

  // Reset materials map when component is remounted with a different model
  useEffect(() => {
    // Clear the materials map when the component mounts
    originalMaterials.current = new Map();
    setMaterialsInitialized(false);
  }, [gltf]);

  // Function to apply material adjustments
  const applyMaterialAdjustments = useCallback(() => {
    if (!modelRef.current) return;

    modelRef.current.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.material) {
        const applyToMaterial = (mat: THREE.Material) => {
          const original = originalMaterials.current.get(mat);
          if (!original) return;

          // Handle wireframe mode first since it affects color
          if ('wireframe' in mat && 'color' in mat) {
            const wireframeMat = mat as THREE.MeshStandardMaterial;
            wireframeMat.wireframe = wireframe;

            if (wireframe) {
              // Set wireframe color to white
              wireframeMat.color.setHex(0xffffff); // White wireframe

              // Add emissive glow for brightness
              if ('emissive' in wireframeMat) {
                const emissive = wireframeMat.emissive;
                if (emissive) {
                  emissive.setHex(0xffffff); // White emissive glow
                }
              }

              // Set line width for thicker lines (where supported)
              if ('wireframeLinewidth' in wireframeMat) {
                wireframeMat.wireframeLinewidth = 3;
              }

              // Increase opacity for better visibility
              if ('opacity' in wireframeMat) {
                wireframeMat.opacity = 1.0;
              }
            } else {
              // Restore original color when wireframe is disabled
              if (original.color) {
                wireframeMat.color.copy(original.color);
              }

              // Reset emissive
              if ('emissive' in wireframeMat && original.emissive) {
                const emissive = wireframeMat.emissive;
                if (emissive) {
                  emissive.copy(original.emissive);
                }
              } else if ('emissive' in wireframeMat) {
                const emissive = wireframeMat.emissive;
                if (emissive) {
                  emissive.setHex(0x000000);
                }
              }

              // Reset wireframe line width
              if ('wireframeLinewidth' in wireframeMat) {
                wireframeMat.wireframeLinewidth = 1;
              }
            }
          }

          // Only apply brightness adjustments if not in wireframe mode
          if (!wireframe) {
            // Apply to color property if it exists
            if ('color' in mat && original.color) {
              const colorMat = mat as THREE.MeshStandardMaterial;

              // Check if model uses texture maps or vertex colors
              const hasTextureMap =
                original.map !== null && original.map !== undefined;
              const hasVertexColors = original.vertexColors === true;

              // In textureless mode for models with baked base colors (like upscaled models),
              // use neutral gray as the base instead of original color
              const useGrayBase =
                !showTexture && !hasTextureMap && !hasVertexColors;
              const baseColor = useGrayBase
                ? { r: 0.533, g: 0.533, b: 0.533 } // 0x888888 in normalized RGB
                : original.color;

              // Apply brightness
              const r = Math.min(
                1,
                Math.max(0, baseColor.r * actualBrightness),
              );
              const g = Math.min(
                1,
                Math.max(0, baseColor.g * actualBrightness),
              );
              const b = Math.min(
                1,
                Math.max(0, baseColor.b * actualBrightness),
              );

              colorMat.color.setRGB(r, g, b);
            }

            // Apply to emissive property if it exists (affects brightness)
            if ('emissive' in mat && original.emissive) {
              const emissiveMat = mat as THREE.MeshStandardMaterial;
              // Use brightness for emissive intensity
              // Upscaled models with textures need much stronger emissive to appear correctly lit
              const baseIntensity = Math.max(0, (actualBrightness - 1) * 0.2);
              const intensity = isUpscaled ? baseIntensity * 3 : baseIntensity;
              emissiveMat.emissive.setRGB(intensity, intensity, intensity);
            }
          }

          // Handle PBR material properties
          if ('roughness' in mat || 'normalMap' in mat || 'map' in mat) {
            const pbrMat = mat as THREE.MeshStandardMaterial;

            // Handle albedo/diffuse map (show/hide based on showTexture)
            // Only modify the map when toggling textures - don't clear if we have no stored original
            if ('map' in pbrMat) {
              if (!showTexture) {
                // Explicitly textureless mode - clear the map
                pbrMat.map = null;
              } else if (original.map) {
                // Restore original map if we have one stored
                pbrMat.map = original.map;
              }
              // If showTexture is true and no original.map, leave the current map alone
            }

            // Handle vertex colors (SAM-3D models use vertex colors instead of textures)
            if ('vertexColors' in pbrMat) {
              if (!showTexture) {
                // Explicitly textureless mode - disable vertex colors
                pbrMat.vertexColors = false;
              } else if (original.vertexColors !== undefined) {
                // Restore original vertex colors setting
                pbrMat.vertexColors = original.vertexColors;
              }
              // If showTexture is true and no original setting, leave it alone
            }

            if ('aoMap' in pbrMat) {
              pbrMat.aoMap = null;
            }

            // Handle roughness - use slider value
            if ('roughness' in pbrMat) {
              pbrMat.roughness = actualRoughness;
            }

            // Apply normal map intensity (only if provided)
            if (
              actualNormalIntensity !== undefined &&
              'normalMap' in pbrMat &&
              'normalScale' in pbrMat
            ) {
              pbrMat.normalScale = new THREE.Vector2(
                actualNormalIntensity,
                actualNormalIntensity,
              );
            }

            // Ensure material knows it needs to update
            pbrMat.needsUpdate = true;
          }
        };

        if (Array.isArray(child.material)) {
          child.material.forEach(applyToMaterial);
        } else {
          applyToMaterial(child.material);
        }
      }
    });
  }, [
    actualBrightness,
    actualRoughness,
    actualNormalIntensity,
    showTexture,
    wireframe,
    originalMaterials,
    isUpscaled,
  ]);

  // When component mounts, store original material properties including PBR maps
  useEffect(() => {
    if (modelRef.current && originalMaterials.current.size === 0) {
      // Force refresh to ensure refs are current
      const scene = modelRef.current;

      scene.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh && child.material) {
          const storeMaterial = (mat: THREE.MeshStandardMaterial) => {
            // Skip if we've already stored this material
            if (originalMaterials.current.has(mat)) return;

            const originalProps: {
              color?: THREE.Color;
              emissive?: THREE.Color;
              map?: THREE.Texture | null;
              normalMap?: THREE.Texture | null;
              roughnessMap?: THREE.Texture | null;
              metalnessMap?: THREE.Texture | null;
              aoMap?: THREE.Texture | null;
              wireframe?: boolean;
              vertexColors?: boolean;
            } = {};

            // Save color if material has it
            if ('color' in mat && mat.color instanceof THREE.Color) {
              originalProps.color = mat.color.clone();
            }

            // Save emissive if material has it
            if ('emissive' in mat && mat.emissive instanceof THREE.Color) {
              originalProps.emissive = mat.emissive.clone();
            }

            // Save all PBR texture maps if material has them
            if ('map' in mat) {
              originalProps.map = mat.map || null;
            }

            if ('normalMap' in mat) {
              originalProps.normalMap = mat.normalMap || null;
            }

            if ('roughnessMap' in mat) {
              originalProps.roughnessMap = mat.roughnessMap || null;
            }

            if ('metalnessMap' in mat) {
              originalProps.metalnessMap = mat.metalnessMap || null;
            }

            if ('aoMap' in mat) {
              originalProps.aoMap = mat.aoMap || null;
            }

            // Save vertexColors if material has it (SAM-3D uses vertex colors)
            if ('vertexColors' in mat) {
              originalProps.vertexColors = mat.vertexColors;
            }

            // Save wireframe if material has it
            if ('wireframe' in mat) {
              originalProps.wireframe = mat.wireframe || false;
            }

            originalMaterials.current.set(mat, originalProps);
          };

          if (Array.isArray(child.material)) {
            child.material.forEach(storeMaterial);
          } else {
            storeMaterial(child.material);
          }
        }
      });

      // Mark materials as initialized so we can apply settings immediately
      setMaterialsInitialized(true);

      // Schedule an immediate application of material adjustments
      requestAnimationFrame(() => {
        applyMaterialAdjustments();
      });
    }
  }, [gltf, applyMaterialAdjustments]);

  // Apply settings whenever they change
  useEffect(() => {
    if (materialsInitialized) {
      applyMaterialAdjustments();
    }
  }, [materialsInitialized, applyMaterialAdjustments]);

  // Force an update on each render to ensure proper application of settings
  useEffect(() => {
    return () => {
      // Clean up function to handle any potential memory leaks
      originalMaterials.current.clear();
    };
  }, []);

  return <primitive ref={modelRef} object={gltf.scene} />;
}
