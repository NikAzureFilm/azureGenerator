export const DEFAULT_MESH_BASE = 'none';

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

export function normalizeMeshBase(value: unknown): MeshBaseId {
  return typeof value === 'string' && MESH_BASE_ID_SET.has(value)
    ? (value as MeshBaseId)
    : DEFAULT_MESH_BASE;
}

export function getMeshBaseOption(value: unknown): MeshBaseOption {
  const meshBase = normalizeMeshBase(value);
  return (
    MESH_BASE_OPTIONS.find((option) => option.id === meshBase) ??
    MESH_BASE_OPTIONS[0]
  );
}

export function buildMeshBasePromptDirective(value: unknown) {
  return getMeshBaseOption(value).directive;
}

export function appendMeshBasePromptDirective(
  text: string | undefined,
  value: unknown,
) {
  const trimmedText = text?.trim();
  const directive = buildMeshBasePromptDirective(value);

  if (!directive) {
    return trimmedText || undefined;
  }

  return trimmedText ? `${trimmedText}\n\n${directive}` : directive;
}
