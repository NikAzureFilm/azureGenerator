import { MeshFileType } from '@shared/types';

export const SUPPORTED_MESH_EXTENSIONS = [
  '.glb',
  '.stl',
  '.obj',
  '.fbx',
] as const;

export const VALID_IMAGE_FORMATS = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

export const getMeshFileType = (filename: string): MeshFileType => {
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith('.stl')) return 'stl';
  if (lowerFilename.endsWith('.obj')) return 'obj';
  if (lowerFilename.endsWith('.fbx')) return 'fbx';
  return 'glb';
};

export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export const isSupportedMeshFile = (
  filename: string,
  type: 'creative' | 'parametric',
): boolean => {
  const lowerFilename = filename.toLowerCase();
  if (type === 'creative') {
    return SUPPORTED_MESH_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext));
  }
  // Parametric mode only supports STL (for OpenSCAD import)
  return lowerFilename.endsWith('.stl');
};
