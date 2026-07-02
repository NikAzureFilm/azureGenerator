import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTF } from 'three-stdlib';
import { Canvas } from '@react-three/fiber';
import { Environment, OrbitControls, Stage } from '@react-three/drei';
import { AlertTriangle, Download, Layers, Loader2 } from 'lucide-react';
import * as Sentry from '@sentry/react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import { Switch } from '../ui/switch';
import { cn } from '@/lib/utils';
import { processUserModelForDownload } from '@/utils/meshPrintProcessUtils';
import {
  DEFAULT_THREE_MF_COLOR_COUNT,
  DEFAULT_THREE_MF_COLOR_DETAIL,
  MAX_THREE_MF_COLOR_COUNT,
  computeThreeMfColoredMesh,
  type ThreeMfColoredMesh,
  type ThreeMfSemanticMaterialMap,
  type ThreeMfTargetMaterialPalette,
} from '@/utils/threeMfExport';
import {
  FULL_SPECTRUM_FILAMENT_PRESETS,
  FULL_SPECTRUM_LAYER_HEIGHT_MM,
  buildFullSpectrumPlan,
  describeMixQuality,
  recommendFilamentPreset,
  type MixQuality,
} from '@/utils/fullSpectrumMixing';

const RECOMPUTE_DEBOUNCE_MS = 300;

const MIX_QUALITY_STYLES: Record<MixQuality, string> = {
  excellent: 'bg-emerald-400',
  good: 'bg-amber-400',
  approximate: 'bg-red-400',
};

function disposeScene(scene: THREE.Scene | null | undefined): void {
  scene?.traverse((child) => {
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

function buildColoredMeshGeometry(
  coloredMesh: ThreeMfColoredMesh,
  palette: string[],
): THREE.BufferGeometry {
  const { vertices, triangles } = coloredMesh;
  const positions = new Float32Array(triangles.length * 9);
  const colors = new Float32Array(triangles.length * 9);
  const paletteColors = palette.map((hex) => new THREE.Color(hex));
  const fallbackColor = new THREE.Color('#CCCCCC');

  triangles.forEach((triangle, triangleIndex) => {
    const color = paletteColors[triangle.colorIndex] ?? fallbackColor;
    [triangle.v1, triangle.v2, triangle.v3].forEach(
      (vertexIndex, cornerIndex) => {
        const offset = triangleIndex * 9 + cornerIndex * 3;
        const vertex = vertices[vertexIndex];
        positions[offset] = vertex?.[0] ?? 0;
        positions[offset + 1] = vertex?.[1] ?? 0;
        positions[offset + 2] = vertex?.[2] ?? 0;
        colors[offset] = color.r;
        colors[offset + 1] = color.g;
        colors[offset + 2] = color.b;
      },
    );
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function ColoredMeshPreview({
  coloredMesh,
  palette,
}: {
  coloredMesh: ThreeMfColoredMesh;
  palette: string[];
}) {
  const geometry = useMemo(
    () => buildColoredMeshGeometry(coloredMesh, palette),
    [coloredMesh, palette],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        vertexColors
        flatShading
        roughness={0.6}
        metalness={0.05}
      />
    </mesh>
  );
}

function getColorDetailLabel(colorDetail: number): string {
  if (colorDetail < 25) {
    return 'Very rough — few large color regions';
  }
  if (colorDetail < 50) {
    return 'Rough — merges small color patches';
  }
  if (colorDetail === 50) {
    return 'Balanced (default)';
  }
  if (colorDetail <= 75) {
    return 'Detailed — keeps small color patches';
  }
  return 'Very detailed — per-triangle texture detail';
}

export function ThreeMfColorPrintDialog({
  open,
  onOpenChange,
  gltf,
  semanticMaterialMap,
  targetMaterialPalette,
  isDownloading,
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gltf: GLTF;
  semanticMaterialMap: ThreeMfSemanticMaterialMap | null;
  targetMaterialPalette: ThreeMfTargetMaterialPalette | null;
  isDownloading: boolean;
  onDownload: (options: {
    colorCount: number;
    colorDetail: number;
    coloredMesh: ThreeMfColoredMesh;
  }) => void;
}) {
  const [colorCount, setColorCount] = useState(DEFAULT_THREE_MF_COLOR_COUNT);
  const [colorDetail, setColorDetail] = useState(DEFAULT_THREE_MF_COLOR_DETAIL);
  const [coloredMesh, setColoredMesh] = useState<ThreeMfColoredMesh | null>(
    null,
  );
  const [isComputing, setIsComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [simulateBlend, setSimulateBlend] = useState(false);

  // The printable-processed scene is expensive to build, so it is prepared
  // once per gltf behind a shared promise: overlapping computes await the
  // same scene instead of each building (and leaking) their own copy.
  const processedSceneRef = useRef<{
    forGltf: GLTF;
    promise: Promise<THREE.Scene>;
  } | null>(null);
  const resultCacheRef = useRef(new Map<string, ThreeMfColoredMesh>());
  const computeTokenRef = useRef(0);

  useEffect(
    () => () => {
      processedSceneRef.current?.promise.then(disposeScene).catch(() => {});
      processedSceneRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!open || !gltf) {
      return;
    }

    if (processedSceneRef.current?.forGltf !== gltf) {
      resultCacheRef.current.clear();
      setColoredMesh(null);
    }

    const cacheKey = `${colorCount}:${colorDetail}`;
    const cached = resultCacheRef.current.get(cacheKey);
    if (cached) {
      // Invalidate any in-flight compute so a stale result can't replace
      // the cached mesh after we show it.
      computeTokenRef.current += 1;
      setColoredMesh(cached);
      setIsComputing(false);
      setComputeError(null);
      return;
    }

    const token = ++computeTokenRef.current;
    setIsComputing(true);
    setComputeError(null);

    const timeout = window.setTimeout(async () => {
      try {
        if (processedSceneRef.current?.forGltf !== gltf) {
          processedSceneRef.current?.promise.then(disposeScene).catch(() => {});
          processedSceneRef.current = {
            forGltf: gltf,
            promise: processUserModelForDownload(gltf),
          };
        }

        const scene = await processedSceneRef.current.promise;
        const mesh = await computeThreeMfColoredMesh({
          scene,
          colorCount,
          colorDetail,
          semanticMaterialMap,
          targetMaterialPalette,
        });

        if (computeTokenRef.current !== token) {
          return;
        }

        resultCacheRef.current.set(cacheKey, mesh);
        setColoredMesh(mesh);
      } catch (error) {
        if (computeTokenRef.current !== token) {
          return;
        }

        Sentry.captureException(error, {
          extra: {
            context: '3MF color print preview',
            colorCount,
            colorDetail,
          },
        });
        setComputeError(
          'Failed to build the color preview. You can still download the .3MF.',
        );
      } finally {
        if (computeTokenRef.current === token) {
          setIsComputing(false);
        }
      }
    }, RECOMPUTE_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [
    open,
    gltf,
    colorCount,
    colorDetail,
    semanticMaterialMap,
    targetMaterialPalette,
  ]);

  const recommendation = useMemo(
    () =>
      coloredMesh && coloredMesh.palette.length > 0
        ? recommendFilamentPreset(coloredMesh.palette)
        : null,
    [coloredMesh],
  );

  const activePreset =
    FULL_SPECTRUM_FILAMENT_PRESETS.find((preset) => preset.id === presetId) ??
    recommendation?.preset ??
    FULL_SPECTRUM_FILAMENT_PRESETS[0];

  const fullSpectrumPlan = useMemo(
    () =>
      coloredMesh && coloredMesh.palette.length > 0
        ? buildFullSpectrumPlan({
            paletteHex: coloredMesh.palette,
            preset: activePreset,
          })
        : null,
    [coloredMesh, activePreset],
  );

  const previewPalette =
    simulateBlend && fullSpectrumPlan && coloredMesh
      ? fullSpectrumPlan.recipes.map((recipe) => recipe.achievedHex)
      : (coloredMesh?.palette ?? []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto text-adam-text-primary">
        <DialogHeader>
          <DialogTitle>.3MF Color Print</DialogTitle>
          <DialogDescription>
            Preview how the model will be split into filament colors before
            downloading. Colors are stored per-triangle in the .3MF and map to
            filament slots in Bambu Studio / Orca.
          </DialogDescription>
        </DialogHeader>

        <div className="relative h-64 overflow-hidden rounded-md border border-adam-neutral-700 bg-adam-neutral-950 sm:h-80">
          {coloredMesh && coloredMesh.triangles.length > 0 ? (
            <Canvas dpr={[1, 2]} camera={{ fov: 45 }}>
              <Environment preset="city" />
              <Stage
                environment={null}
                adjustCamera={1.5}
                intensity={0.5}
                shadows={false}
              >
                <ColoredMeshPreview
                  coloredMesh={coloredMesh}
                  palette={previewPalette}
                />
              </Stage>
              <OrbitControls makeDefault enablePan={false} />
            </Canvas>
          ) : null}
          {isComputing || (!coloredMesh && !computeError) ? (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-adam-neutral-950/60 text-sm text-adam-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin text-adam-blue" />
              Building color preview…
            </div>
          ) : null}
          {computeError ? (
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-red-950/80 px-3 py-2 text-xs text-red-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {computeError}
            </div>
          ) : null}
        </div>

        {coloredMesh && coloredMesh.palette.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-adam-text-secondary">
              Detected palette:
            </span>
            {coloredMesh.palette.map((hex, index) => (
              <span
                key={`${hex}-${index}`}
                className="inline-flex items-center gap-1 rounded border border-adam-neutral-700 px-1.5 py-0.5 text-[10px] text-adam-text-secondary"
              >
                <span
                  className="h-3 w-3 rounded-sm border border-black/30"
                  style={{ backgroundColor: hex }}
                />
                {hex}
              </span>
            ))}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label className="text-sm font-medium">Colors</label>
              <span className="text-xs text-adam-text-secondary">
                {colorCount} filament{colorCount === 1 ? '' : 's'}
              </span>
            </div>
            <Slider
              value={[colorCount]}
              min={1}
              max={MAX_THREE_MF_COLOR_COUNT}
              step={1}
              defaultValue={[DEFAULT_THREE_MF_COLOR_COUNT]}
              onValueChange={([value]) => setColorCount(value)}
            />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label className="text-sm font-medium">Sensitivity</label>
              <span className="text-xs text-adam-text-secondary">
                {getColorDetailLabel(colorDetail)}
              </span>
            </div>
            <Slider
              value={[colorDetail]}
              min={0}
              max={100}
              step={5}
              defaultValue={[DEFAULT_THREE_MF_COLOR_DETAIL]}
              onValueChange={([value]) => setColorDetail(value)}
            />
            <div className="mt-1 flex justify-between text-[10px] text-adam-text-secondary/70">
              <span>Rough regions</span>
              <span>Fine detail</span>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-adam-neutral-700 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-adam-blue" />
              <span className="text-sm font-medium">
                Full Spectrum layer mixing
              </span>
              <span className="rounded bg-adam-blue/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-adam-blue">
                Beta
              </span>
            </div>
            <label className="flex items-center gap-2 text-xs text-adam-text-secondary">
              Simulate blended colors in preview
              <Switch
                checked={simulateBlend}
                onCheckedChange={setSimulateBlend}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-adam-text-secondary">
            Tool-changer printers (e.g. Snapmaker U1 with Snapmaker Orca ≥
            2.3.3) can blend a few filaments into many colors by alternating
            them layer by layer — stacks under 0.2&nbsp;mm read as a single
            mixed color. Load the filament set below and enter each pattern in
            the slicer&apos;s Cycle Mix; the .3MF itself keeps the plain palette
            colors.{' '}
            <a
              href="https://www.snapmaker.com/blog/getting-started-with-full-spectrum-slicing/"
              target="_blank"
              rel="noreferrer"
              className="text-adam-blue underline underline-offset-2"
            >
              Learn the technique
            </a>
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {FULL_SPECTRUM_FILAMENT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setPresetId(preset.id)}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition-colors',
                  preset.id === activePreset.id
                    ? 'border-adam-blue bg-adam-blue/15 text-adam-text-primary'
                    : 'border-adam-neutral-700 text-adam-text-secondary hover:border-adam-neutral-500',
                )}
                title={preset.description}
              >
                {preset.label}
                {recommendation?.preset.id === preset.id ? (
                  <span className="ml-1 text-[10px] text-emerald-400">
                    ★ recommended
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {recommendation ? (
            <p className="mt-1 text-[11px] text-adam-text-secondary/80">
              {recommendation.reason}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {activePreset.filaments.map((filament, index) => (
              <span
                key={filament.name}
                className="inline-flex items-center gap-1.5 rounded border border-adam-neutral-700 px-1.5 py-0.5 text-[10px] text-adam-text-secondary"
              >
                <span className="font-semibold text-adam-text-primary">
                  {index + 1}
                </span>
                <span
                  className="h-3 w-3 rounded-sm border border-black/30"
                  style={{ backgroundColor: filament.hex }}
                />
                {filament.name}
              </span>
            ))}
          </div>

          {fullSpectrumPlan ? (
            <div className="mt-3 space-y-1.5">
              {fullSpectrumPlan.recipes.map((recipe, index) => {
                const quality = describeMixQuality(recipe.deltaE);
                return (
                  <div
                    key={`${recipe.targetHex}-${index}`}
                    className="flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span
                      className="h-4 w-4 rounded-sm border border-black/30"
                      style={{ backgroundColor: recipe.targetHex }}
                      title={`Target ${recipe.targetHex}`}
                    />
                    <span className="text-adam-text-secondary">→</span>
                    <span
                      className="h-4 w-4 rounded-sm border border-black/30"
                      style={{ backgroundColor: recipe.achievedHex }}
                      title={`Blended result ${recipe.achievedHex}`}
                    />
                    <span className="font-mono text-adam-text-primary">
                      {recipe.patternLabel}
                    </span>
                    <span className="flex items-center gap-1 text-adam-text-secondary">
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full',
                          MIX_QUALITY_STYLES[quality],
                        )}
                      />
                      ΔE {recipe.deltaE.toFixed(1)} ({quality})
                    </span>
                    <span className="text-adam-text-secondary/70">
                      {recipe.stackHeightMm.toFixed(2)} mm stack
                    </span>
                    {recipe.exceedsInvisibleStack ? (
                      <span
                        className="flex items-center gap-1 text-amber-400"
                        title="Repeating stack is taller than 0.2 mm — layer stripes may be visible on shallow slopes."
                      >
                        <AlertTriangle className="h-3 w-3" /> stripes possible
                      </span>
                    ) : null}
                  </div>
                );
              })}
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-adam-text-secondary/80">
                <li>
                  Slice at {FULL_SPECTRUM_LAYER_HEIGHT_MM} –0.1&nbsp;mm layer
                  height; thicker layers make the color cycles visible.
                </li>
                <li>
                  Translucent filaments (transmission distance 5–8&nbsp;mm)
                  blend far better than opaque ones.
                </li>
                <li>
                  Blends look best on vertical walls; avoid dithering on shallow
                  slopes and sphere tops.
                </li>
                <li>
                  Print a small test palette first to check stripe visibility
                  and color accuracy.
                </li>
              </ul>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isDownloading}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (coloredMesh) {
                onDownload({ colorCount, colorDetail, coloredMesh });
              }
            }}
            disabled={!coloredMesh || isComputing || isDownloading}
          >
            {isDownloading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download .3MF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
