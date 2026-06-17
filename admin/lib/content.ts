export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateText(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

export function jsonPreview(value: unknown, max = 240): string {
  if (value == null) return '-';
  if (typeof value === 'string') return truncateText(value, max);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const preview = jsonPreview(item, max);
      if (preview !== '-') return preview;
    }
  }

  if (isRecord(value)) {
    for (const key of [
      'text',
      'prompt',
      'userPrompt',
      'input',
      'description',
    ]) {
      const nested = value[key];
      if (typeof nested === 'string' && nested.trim()) {
        return truncateText(nested, max);
      }
    }

    const artifact = value.artifact;
    if (isRecord(artifact) && typeof artifact.title === 'string') {
      return truncateText(`Artifact: ${artifact.title}`, max);
    }

    const cadJob = value.cadJob;
    if (isRecord(cadJob) && typeof cadJob.id === 'string') {
      const status =
        typeof cadJob.status === 'string' ? ` (${cadJob.status})` : '';
      return truncateText(`CAD job ${cadJob.id}${status}`, max);
    }

    if (isRecord(value.mesh) && typeof value.mesh.id === 'string') {
      return truncateText(`Mesh ${value.mesh.id}`, max);
    }

    if (Array.isArray(value.images) && value.images.length > 0) {
      return truncateText(`${value.images.length} image input(s)`, max);
    }

    const multiviewImages = value.multiviewImages;
    if (isRecord(multiviewImages)) {
      const slots = Object.keys(multiviewImages).filter(
        (slot) => multiviewImages[slot],
      );
      if (slots.length > 0) {
        return truncateText(`Multiview images: ${slots.join(', ')}`, max);
      }
    }
  }

  return truncateText(formatJson(value), max);
}

export function formatJson(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function hasJsonContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

export type ParsedWorkerError = {
  message: string;
  traceback: string | null;
};

// cad_jobs.error frequently embeds the build123d runner's JSON failure line
// ({"ok": false, "error": ..., "traceback": ...}) inside the worker's
// stdout/stderr dump. Pull out the human-readable message and the Python
// traceback when present; fall back to the raw text otherwise.
export function parseWorkerError(raw: string): ParsedWorkerError {
  const text = raw.trim();

  for (const candidate of [text, ...text.split('\n')]) {
    const line = candidate.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const message = typeof parsed.error === 'string' ? parsed.error : null;
      const traceback =
        typeof parsed.traceback === 'string' && parsed.traceback.trim()
          ? parsed.traceback.trim()
          : null;
      if (message || traceback) {
        return { message: message ?? text, traceback };
      }
    } catch {
      // Not a JSON line; keep scanning.
    }
  }

  const marker = text.indexOf('Traceback (most recent call last):');
  if (marker > -1) {
    const message = text.slice(0, marker).trim();
    return {
      message: message || 'Generation failed.',
      traceback: text.slice(marker).trim(),
    };
  }

  return { message: text, traceback: null };
}

export function generationKindLabel(kind: string): string {
  switch (kind) {
    case 'cad':
      return 'CAD';
    case 'parametric':
      return 'Parametric';
    case 'mesh':
      return 'Mesh';
    case 'image':
      return 'Image';
    default:
      return kind;
  }
}
