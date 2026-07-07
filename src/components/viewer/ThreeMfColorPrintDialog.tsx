import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { GLTF } from 'three-stdlib';
import { Canvas } from '@react-three/fiber';
import { Environment, OrbitControls, Stage } from '@react-three/drei';
import {
  AlertTriangle,
  Download,
  Layers,
  Loader2,
  Palette,
} from 'lucide-react';
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
  type ThreeMfMixedFilamentPlan,
  type ThreeMfSemanticMaterialMap,
  type ThreeMfTargetMaterialPalette,
} from '@/utils/threeMfExport';
import {
  FULL_SPECTRUM_FILAMENT_PRESETS,
  FULL_SPECTRUM_LAYER_HEIGHT_MM,
  buildFullSpectrumPlan,
  describeMixQuality,
  recommendPrintMode,
  type MixQuality,
} from '@/utils/fullSpectrumMixing';

const RECOMPUTE_DEBOUNCE_MS = 300;

// Full Spectrum blends a fixed translucent CMY + white + black set; there is a
// single filament set, so the dialog uses it directly.
const FULL_SPECTRUM_PRESET = FULL_SPECTRUM_FILAMENT_PRESETS[0];
// Faces whose normals differ by more than this stay hard-edged in the preview;
// smoother angles get averaged so the model reads as smooth as the main viewer.
const PREVIEW_CREASE_ANGLE_COS = Math.cos((60 * Math.PI) / 180);

type PrintMode = 'classic' | 'fullSpectrum';

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

function computeTriangleFaceNormal(
  vertices: ThreeMfColoredMesh['vertices'],
  triangle: ThreeMfColoredMesh['triangles'][number],
): THREE.Vector3 {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];
  const va = new THREE.Vector3(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0);
  const vb = new THREE.Vector3(b?.[0] ?? 0, b?.[1] ?? 0, b?.[2] ?? 0);
  const vc = new THREE.Vector3(c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0);
  const normal = new THREE.Vector3()
    .subVectors(vb, va)
    .cross(new THREE.Vector3().subVectors(vc, va));
  const lengthSq = normal.lengthSq();
  return lengthSq > 0 ? normal.multiplyScalar(1 / Math.sqrt(lengthSq)) : normal;
}

function buildColoredMeshGeometry(
  coloredMesh: ThreeMfColoredMesh,
  palette: string[],
): THREE.BufferGeometry {
  const { vertices, triangles } = coloredMesh;
  const positions = new Float32Array(triangles.length * 9);
  const colors = new Float32Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);
  const paletteColors = palette.map((hex) => new THREE.Color(hex));
  const fallbackColor = new THREE.Color('#CCCCCC');

  // The coloredMesh vertices are shared/indexed, so per-corner normals can be
  // smoothed by averaging the face normals of the triangles that meet at each
  // vertex — but only across faces within the crease angle, so hard edges stay
  // crisp. Colors remain per-corner from each triangle's palette index.
  const faceNormals = triangles.map((triangle) =>
    computeTriangleFaceNormal(vertices, triangle),
  );
  const vertexTriangleIndexes = new Map<number, number[]>();
  triangles.forEach((triangle, triangleIndex) => {
    for (const vertexIndex of [triangle.v1, triangle.v2, triangle.v3]) {
      const list = vertexTriangleIndexes.get(vertexIndex);
      if (list) {
        list.push(triangleIndex);
      } else {
        vertexTriangleIndexes.set(vertexIndex, [triangleIndex]);
      }
    }
  });

  const smoothedNormal = new THREE.Vector3();
  triangles.forEach((triangle, triangleIndex) => {
    const color = paletteColors[triangle.colorIndex] ?? fallbackColor;
    const faceNormal = faceNormals[triangleIndex];
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

        smoothedNormal.set(0, 0, 0);
        for (const neighborIndex of vertexTriangleIndexes.get(vertexIndex) ??
          []) {
          const neighborNormal = faceNormals[neighborIndex];
          if (neighborNormal.dot(faceNormal) >= PREVIEW_CREASE_ANGLE_COS) {
            smoothedNormal.add(neighborNormal);
          }
        }
        if (smoothedNormal.lengthSq() === 0) {
          smoothedNormal.copy(faceNormal);
        }
        smoothedNormal.normalize();
        normals[offset] = smoothedNormal.x;
        normals[offset + 1] = smoothedNormal.y;
        normals[offset + 2] = smoothedNormal.z;
      },
    );
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
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
      <meshStandardMaterial vertexColors roughness={0.6} metalness={0.05} />
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

// A <input type="color"> needs a lowercase #rrggbb value; the app stores
// palette colors as #RRGGBB, which the picker accepts either way.
function toColorInputValue(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return match ? `#${match[1].toLowerCase()}` : '#cccccc';
}

function ModeCard({
  selected,
  recommended,
  icon,
  title,
  beta,
  description,
  onSelect,
}: {
  selected: boolean;
  recommended: boolean;
  icon: ReactNode;
  title: string;
  beta?: boolean;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-1 flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
        selected
          ? 'border-adam-blue bg-adam-blue/10 ring-1 ring-adam-blue'
          : 'border-adam-neutral-700 hover:border-adam-neutral-500',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border',
            selected
              ? 'border-adam-blue bg-adam-blue'
              : 'border-adam-neutral-500',
          )}
        >
          {selected ? (
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          ) : null}
        </span>
        {icon}
        <span className="text-sm font-medium">{title}</span>
        {beta ? (
          <span className="rounded bg-adam-blue/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-adam-blue">
            Beta
          </span>
        ) : null}
        {recommended ? (
          <span className="ml-auto rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
            ★ Recommended
          </span>
        ) : null}
      </div>
      <p className="text-xs text-adam-text-secondary">{description}</p>
    </button>
  );
}

export function ThreeMfColorPrintDialog({
  open,
  onOpenChange,
  gltf,
  semanticMaterialMap,
  targetMaterialPalette,
  isDownloading,
  initialMode = 'classic',
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gltf: GLTF;
  semanticMaterialMap: ThreeMfSemanticMaterialMap | null;
  targetMaterialPalette: ThreeMfTargetMaterialPalette | null;
  isDownloading: boolean;
  initialMode?: PrintMode;
  onDownload: (options: {
    colorCount: number;
    colorDetail: number;
    coloredMesh: ThreeMfColoredMesh;
    mode: PrintMode;
    fullSpectrum?: ThreeMfMixedFilamentPlan;
  }) => void;
}) {
  const [mode, setMode] = useState<PrintMode>(initialMode);
  const [colorCount, setColorCount] = useState(DEFAULT_THREE_MF_COLOR_COUNT);
  const [colorDetail, setColorDetail] = useState(DEFAULT_THREE_MF_COLOR_DETAIL);
  const [coloredMesh, setColoredMesh] = useState<ThreeMfColoredMesh | null>(
    null,
  );
  const [isComputing, setIsComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  // Full-spectrum previews show the achieved blended colors by default so the
  // user sees what the print will actually look like.
  const [simulateBlend, setSimulateBlend] = useState(true);
  // User edits to detected palette colors, keyed by palette index and applied
  // everywhere downstream (preview, mixing plan, export).
  const [paletteOverrides, setPaletteOverrides] = useState<
    Record<number, string>
  >({});

  // Full-spectrum mode reserves the physical filament slots, so the number of
  // extra printable colors is capped so the total never exceeds the 16 slots.
  const maxColorCount =
    mode === 'fullSpectrum'
      ? Math.max(
          1,
          MAX_THREE_MF_COLOR_COUNT - FULL_SPECTRUM_PRESET.filaments.length,
        )
      : MAX_THREE_MF_COLOR_COUNT;

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

  // Reset the per-open UI choices (mode, blend simulation, color edits) each
  // time the dialog opens so a previous session doesn't leak into a new model.
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setSimulateBlend(true);
      setPaletteOverrides({});
    }
  }, [open, initialMode]);

  // Keep the requested color count within the current mode's slot budget.
  useEffect(() => {
    setColorCount((count) => Math.min(count, maxColorCount));
  }, [maxColorCount]);

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

  // Drop overrides that no longer point at a palette entry when the detected
  // palette shrinks (fewer colors), so "Reset colors" reflects real edits.
  useEffect(() => {
    const paletteLength = coloredMesh?.palette.length ?? 0;
    setPaletteOverrides((previous) => {
      const entries = Object.entries(previous).filter(
        ([index]) => Number(index) < paletteLength,
      );
      return entries.length === Object.keys(previous).length
        ? previous
        : Object.fromEntries(entries);
    });
  }, [coloredMesh]);

  // The detected palette with the user's color edits applied.
  const editedPalette = useMemo(() => {
    if (!coloredMesh) {
      return [] as string[];
    }
    return coloredMesh.palette.map(
      (hex, index) => paletteOverrides[index] ?? hex,
    );
  }, [coloredMesh, paletteOverrides]);

  const fullSpectrumPlan = useMemo(
    () =>
      editedPalette.length > 0
        ? buildFullSpectrumPlan({
            paletteHex: editedPalette,
            preset: FULL_SPECTRUM_PRESET,
          })
        : null,
    [editedPalette],
  );

  const modeRecommendation = useMemo(
    () => (editedPalette.length > 0 ? recommendPrintMode(editedPalette) : null),
    [editedPalette],
  );

  // Memoized so the preview geometry (which averages normals and builds an
  // adjacency map) is only rebuilt when the shown palette actually changes,
  // not on every render while blend simulation is on.
  const previewPalette = useMemo(
    () =>
      mode === 'fullSpectrum' && simulateBlend && fullSpectrumPlan
        ? fullSpectrumPlan.recipes.map((recipe) => recipe.achievedHex)
        : editedPalette,
    [mode, simulateBlend, fullSpectrumPlan, editedPalette],
  );

  const hasOverrides = Object.keys(paletteOverrides).length > 0;

  const handleDownload = () => {
    if (!coloredMesh) {
      return;
    }

    const exportedMesh: ThreeMfColoredMesh = {
      ...coloredMesh,
      palette: editedPalette,
    };
    const fullSpectrum =
      mode === 'fullSpectrum' && fullSpectrumPlan
        ? {
            presetFilaments: FULL_SPECTRUM_PRESET.filaments.map((filament) => ({
              name: filament.name,
              hex: filament.hex,
            })),
            recipes: fullSpectrumPlan.recipes.map((recipe) => ({
              achievedHex: recipe.achievedHex,
              layerFilamentIndexes: recipe.layerFilamentIndexes,
            })),
          }
        : undefined;

    onDownload({
      colorCount,
      colorDetail,
      coloredMesh: exportedMesh,
      mode,
      fullSpectrum,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-5xl overflow-y-auto text-adam-text-primary">
        <DialogHeader>
          <DialogTitle>.3MF Color Print</DialogTitle>
          <DialogDescription>
            Preview how the model will be split into filament colors before
            downloading. Colors are stored per-triangle in the .3MF and map to
            filament slots in your slicer.
          </DialogDescription>
        </DialogHeader>

        <div
          role="radiogroup"
          aria-label="Color print technique"
          className="flex flex-col gap-3 sm:flex-row"
        >
          <ModeCard
            selected={mode === 'classic'}
            recommended={modeRecommendation?.mode === 'classic'}
            icon={<Palette className="h-4 w-4 text-adam-blue" />}
            title="Classic multi-color"
            onSelect={() => setMode('classic')}
            description="Prints each detected palette color with its own filament — the standard multi-color technique (e.g. red, yellow, blue, white, black spools)."
          />
          <ModeCard
            selected={mode === 'fullSpectrum'}
            recommended={modeRecommendation?.mode === 'fullSpectrum'}
            icon={<Layers className="h-4 w-4 text-adam-blue" />}
            title="Full Spectrum layer mixing"
            beta
            onSelect={() => setMode('fullSpectrum')}
            description="Blends translucent Cyan, Magenta, Yellow + White + Black layer-by-layer to reproduce the full color spectrum."
          />
        </div>
        {modeRecommendation ? (
          <p className="-mt-1 text-[11px] text-adam-text-secondary/80">
            <span className="text-emerald-400">★ Recommended:</span>{' '}
            {modeRecommendation.reason}
          </p>
        ) : null}

        <div className="relative h-72 overflow-hidden rounded-md border border-adam-neutral-700 bg-adam-neutral-950 sm:h-96">
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
              <OrbitControls
                makeDefault
                enablePan
                mouseButtons={{
                  LEFT: THREE.MOUSE.ROTATE,
                  MIDDLE: THREE.MOUSE.PAN,
                  RIGHT: THREE.MOUSE.PAN,
                }}
              />
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
            {coloredMesh.palette.map((_, index) => {
              const currentHex = editedPalette[index];
              const isEdited = paletteOverrides[index] !== undefined;
              return (
                <label
                  key={index}
                  title="Click to edit this color"
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-adam-text-secondary transition-colors hover:border-adam-neutral-500',
                    isEdited
                      ? 'border-adam-blue/70'
                      : 'border-adam-neutral-700',
                  )}
                >
                  <span
                    className="h-3 w-3 rounded-sm border border-black/30"
                    style={{ backgroundColor: currentHex }}
                  />
                  {currentHex}
                  <input
                    type="color"
                    value={toColorInputValue(currentHex)}
                    onChange={(event) =>
                      setPaletteOverrides((previous) => ({
                        ...previous,
                        [index]: event.target.value.toUpperCase(),
                      }))
                    }
                    className="sr-only"
                  />
                </label>
              );
            })}
            {hasOverrides ? (
              <button
                type="button"
                onClick={() => setPaletteOverrides({})}
                className="rounded border border-adam-neutral-700 px-1.5 py-0.5 text-[10px] text-adam-text-secondary hover:border-adam-neutral-500"
              >
                Reset colors
              </button>
            ) : null}
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
              value={[Math.min(colorCount, maxColorCount)]}
              min={1}
              max={maxColorCount}
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

        {mode === 'fullSpectrum' ? (
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
                Preview blended result
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
              mixed color. The export loads the filament set below and writes
              the mixed-filament slots so the slicer prints each blend
              automatically.{' '}
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
              {FULL_SPECTRUM_PRESET.filaments.map((filament, index) => (
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
                    Blends look best on vertical walls; avoid dithering on
                    shallow slopes and sphere tops.
                  </li>
                  <li>
                    Print a small test palette first to check stripe visibility
                    and color accuracy.
                  </li>
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isDownloading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDownload}
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
