export const DEFAULT_MESH_BASE = 'none';
export const DEFAULT_ADDED_MESH_BASE = 'round';

export type MeshBaseSettings = {
  rotationDeg: number;
  scalePercent: number;
  thicknessPercent: number;
};

export const DEFAULT_MESH_BASE_SETTINGS: MeshBaseSettings = {
  rotationDeg: 0,
  scalePercent: 115,
  thicknessPercent: 10,
};

export const MESH_BASE_IDS = [
  'none',
  'round',
  'square',
  'hex',
  'oval',
  'terrain',
] as const;

export type MeshBaseId = (typeof MESH_BASE_IDS)[number];

export type MeshBaseOption = {
  id: MeshBaseId;
  label: string;
  description: string;
  directive?: string;
};

export const MESH_BASE_OPTIONS: readonly MeshBaseOption[] = [
  {
    id: 'none',
    label: 'No base',
    description: 'No generated display base',
  },
  {
    id: 'round',
    label: 'Round',
    description: 'Circular display plinth',
    directive:
      'Base requirement: add an integrated round display base under the subject. Make it a low-profile circular plinth with a flat underside for the print bed, visibly connected to the model, and not a separate loose object.',
  },
  {
    id: 'square',
    label: 'Square',
    description: 'Simple square plinth',
    directive:
      'Base requirement: add an integrated square display base under the subject. Make it a low-profile square plinth with a flat underside for the print bed, visibly connected to the model, and not a separate loose object.',
  },
  {
    id: 'hex',
    label: 'Hex',
    description: 'Faceted hex plinth',
    directive:
      'Base requirement: add an integrated hexagonal display base under the subject. Make it a low-profile six-sided plinth with a flat underside for the print bed, visibly connected to the model, and not a separate loose object.',
  },
  {
    id: 'oval',
    label: 'Oval',
    description: 'Soft oval plinth',
    directive:
      'Base requirement: add an integrated oval display base under the subject. Make it a low-profile oval plinth with a flat underside for the print bed, visibly connected to the model, and not a separate loose object.',
  },
  {
    id: 'terrain',
    label: 'Terrain',
    description: 'Rocky terrain base',
    directive:
      'Base requirement: add an integrated rocky terrain display base under the subject. Make it a low-profile sculpted terrain plinth with a flat underside for the print bed, visibly connected to the model, and not a separate loose object.',
  },
] as const;

const MESH_BASE_ID_SET = new Set<string>(MESH_BASE_IDS);

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

export function normalizeMeshBase(value: unknown): MeshBaseId {
  return typeof value === 'string' && MESH_BASE_ID_SET.has(value)
    ? (value as MeshBaseId)
    : DEFAULT_MESH_BASE;
}

export function normalizeAddedMeshBase(value: unknown): MeshBaseId {
  const meshBase = normalizeMeshBase(value);
  return meshBase === DEFAULT_MESH_BASE ? DEFAULT_ADDED_MESH_BASE : meshBase;
}

export function normalizeMeshBaseSettings(value: unknown): MeshBaseSettings {
  const settings =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};

  return {
    rotationDeg: clampNumber(
      settings.rotationDeg ?? settings.rotation,
      0,
      360,
      DEFAULT_MESH_BASE_SETTINGS.rotationDeg,
    ),
    scalePercent: clampNumber(
      settings.scalePercent ?? settings.scale,
      80,
      200,
      DEFAULT_MESH_BASE_SETTINGS.scalePercent,
    ),
    thicknessPercent: clampNumber(
      settings.thicknessPercent ?? settings.thickness,
      4,
      35,
      DEFAULT_MESH_BASE_SETTINGS.thicknessPercent,
    ),
  };
}

export function getMeshBaseOption(value: unknown): MeshBaseOption {
  const meshBase = normalizeMeshBase(value);
  return (
    MESH_BASE_OPTIONS.find((option) => option.id === meshBase) ??
    MESH_BASE_OPTIONS[0]
  );
}

export function buildMeshBasePromptDirective(
  value: unknown,
  settings?: unknown,
) {
  const directive = getMeshBaseOption(value).directive;
  if (!directive) {
    return undefined;
  }

  const normalizedSettings = normalizeMeshBaseSettings(settings);
  const transformDirective =
    `Base transform: rotate the base ${normalizedSettings.rotationDeg} degrees around the vertical axis, ` +
    `keep its footprint scale at ${normalizedSettings.scalePercent}% of the subject footprint, ` +
    `and make the base thickness around ${normalizedSettings.thicknessPercent}% of the subject height.`;

  return `${directive} ${transformDirective}`;
}

export function appendMeshBasePromptDirective(
  text: string | undefined,
  value: unknown,
  settings?: unknown,
) {
  const trimmedText = text?.trim();
  const directive = buildMeshBasePromptDirective(value, settings);

  if (!directive) {
    return trimmedText || undefined;
  }

  return trimmedText ? `${trimmedText}\n\n${directive}` : directive;
}
