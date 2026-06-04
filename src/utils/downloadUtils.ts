import { generate3DModelFilename } from '@/utils/file-utils';
import {
  stlBlobToOBJContent,
  stlBlobToSTEPContent,
} from '@/utils/cadMeshExport';
import { Message } from '@shared/types';

// On-demand DXF generator. The OpenSCAD worker produces DXF output by recompiling
// the source through a top-down projection, so consumers receive a callback rather
// than a ready blob.
export type DxfExporter = () => Promise<Blob>;

interface DownloadOptions {
  content: Blob | string;
  filename: string;
  mimeType?: string;
}

interface GenerateDownloadFilenameOptions {
  currentMessage?: Message | null;
  fallback?: string;
  extension: string;
}

/**
 * Downloads a file by creating a temporary download link
 */
export function downloadFile({
  content,
  filename,
  mimeType = 'application/octet-stream',
}: DownloadOptions): void {
  let blob: Blob;

  if (typeof content === 'string') {
    blob = new Blob([content], { type: mimeType });
  } else {
    blob = content;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generates a base filename for downloads using the 3D model filename utility
 */
export function generateDownloadBaseName({
  currentMessage,
  fallback = 'parametric-model',
}: Omit<GenerateDownloadFilenameOptions, 'extension'>): string {
  return generate3DModelFilename({
    conversationTitle: undefined,
    assistantMessage: currentMessage || undefined,
    modelName: undefined,
    fallback,
  });
}

/**
 * Generates a filename for downloads using the 3D model filename utility
 */
export function generateDownloadFilename({
  currentMessage,
  fallback = 'parametric-model',
  extension,
}: GenerateDownloadFilenameOptions): string {
  const baseName = generateDownloadBaseName({ currentMessage, fallback });
  return `${baseName}.${extension}`;
}

async function fetchArtifactBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download CAD artifact: ${response.status}`);
  }
  return response.blob();
}

export async function downloadUrlFile({
  url,
  filename,
  mimeType = 'application/octet-stream',
}: {
  url: string;
  filename: string;
  mimeType?: string;
}): Promise<void> {
  const blob = await fetchArtifactBlob(url);
  downloadFile({
    content: blob,
    filename,
    mimeType: blob.type || mimeType,
  });
}

/**
 * Downloads STL file from blob
 */
export function downloadSTLFile(
  output: Blob,
  currentMessage?: Message | null,
): void {
  const filename = generateDownloadFilename({
    currentMessage,
    extension: 'stl',
  });

  downloadFile({
    content: output,
    filename,
    mimeType: 'application/octet-stream',
  });
}

/**
 * Downloads OpenSCAD code as .scad file
 */
export function downloadOpenSCADFile(
  code: string,
  currentMessage?: Message | null,
): void {
  const filename = generateDownloadFilename({
    currentMessage,
    extension: 'scad',
  });

  downloadFile({
    content: code,
    filename,
    mimeType: 'text/plain',
  });
}

/**
 * Downloads DXF file from blob
 */
export function downloadDXFFile(
  output: Blob,
  currentMessage?: Message | null,
): void {
  const filename = generateDownloadFilename({
    currentMessage,
    extension: 'dxf',
  });

  downloadFile({
    content: output,
    filename,
    mimeType: 'application/dxf',
  });
}

/**
 * Converts compiled STL mesh output to OBJ and downloads it.
 */
export async function downloadOBJFile(
  output: Blob,
  currentMessage?: Message | null,
): Promise<void> {
  const baseName = generateDownloadBaseName({ currentMessage });
  const objContent = await stlBlobToOBJContent(output, baseName);

  downloadFile({
    content: objContent,
    filename: `${baseName}.obj`,
    mimeType: 'text/plain',
  });
}

/**
 * Converts compiled STL mesh output to a faceted STEP BREP and downloads it.
 */
export async function downloadSTEPFile(
  output: Blob,
  currentMessage?: Message | null,
): Promise<void> {
  const baseName = generateDownloadBaseName({ currentMessage });
  const stepContent = await stlBlobToSTEPContent(output, baseName);

  downloadFile({
    content: stepContent,
    filename: `${baseName}.step`,
    mimeType: 'model/step',
  });
}

/**
 * Downloads a backend-provided native STEP artifact.
 */
export async function downloadSTEPArtifactFile(
  stepUrl: string,
  currentMessage?: Message | null,
): Promise<void> {
  await downloadUrlFile({
    url: stepUrl,
    filename: generateDownloadFilename({
      currentMessage,
      fallback: 'step-cad-model',
      extension: 'step',
    }),
    mimeType: 'model/step',
  });
}

/**
 * Fetches a backend STL artifact, converts it to OBJ, and downloads it.
 */
export async function downloadOBJArtifactFile(
  stlUrl: string,
  currentMessage?: Message | null,
): Promise<void> {
  await downloadOBJFile(await fetchArtifactBlob(stlUrl), currentMessage);
}
