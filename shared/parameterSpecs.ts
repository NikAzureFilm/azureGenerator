import type { Parameter, ParameterOption, ParameterSpec } from './types.ts';

const PARAMETER_ANNOTATION_REGEX =
  /^\s*\/\/\s*@(adam|cadam)-param\s+(.+?)\s*$/gm;

const MAX_SPECS = 100;
const MAX_OPTIONS = 50;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_GROUP_LENGTH = 60;
const MAX_OPTION_LENGTH = 120;
const MAX_UNIT_LENGTH = 12;
const MAX_BOUND_MAGNITUDE = 1e9;
const MIN_STEP = 1e-9;

export function parseParameterSpecs(source: string): ParameterSpec[] {
  const specs: ParameterSpec[] = [];
  const seenNames = new Set<string>();
  let match: RegExpExecArray | null;

  PARAMETER_ANNOTATION_REGEX.lastIndex = 0;
  while (
    specs.length < MAX_SPECS &&
    (match = PARAMETER_ANNOTATION_REGEX.exec(source)) !== null
  ) {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (!isRecord(parsed)) continue;
      payload = parsed;
    } catch {
      continue;
    }

    const name = cleanString(payload.name);
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);

    const spec: ParameterSpec = { name };
    const label = cleanString(payload.label);
    const type = cleanString(payload.type);
    const description = cleanString(payload.description);
    const group = cleanString(payload.group);
    const unit = cleanString(payload.unit);
    if (label) spec.label = label;
    if (type === 'number' || type === 'string' || type === 'boolean') {
      spec.type = type;
    }
    if (description) spec.description = description;
    if (group) spec.group = group;
    if (unit) spec.unit = unit;

    const min = finiteNumber(payload.min);
    const max = finiteNumber(payload.max);
    const step = finiteNumber(payload.step);
    if (min !== undefined) spec.min = min;
    if (max !== undefined) spec.max = max;
    if (step !== undefined) spec.step = step;

    const options = parseOptions(payload.options);
    if (options.length > 0) spec.options = options;
    specs.push(spec);
  }

  return specs;
}

/**
 * Overlay validated, model-authored presentation metadata on parameters parsed
 * from the OpenSCAD source. Source variables remain authoritative, so malformed
 * or stale annotations can never create controls for variables that do not
 * exist or silently change a model's current value.
 */
export function applyParameterSpecs(
  parameters: Parameter[],
  specs: ParameterSpec[] | null | undefined,
): Parameter[] {
  if (!Array.isArray(specs) || specs.length === 0) return parameters;

  const byName = new Map<string, ParameterSpec>();
  for (const spec of specs.slice(0, MAX_SPECS)) {
    if (
      spec &&
      typeof spec === 'object' &&
      typeof spec.name === 'string' &&
      !byName.has(spec.name)
    ) {
      byName.set(spec.name, spec);
    }
  }

  return parameters.map((parameter) => {
    const spec = byName.get(parameter.name);
    if (!spec) return parameter;

    const merged: Parameter = { ...parameter };
    if (typeof spec.label === 'string' && spec.label.trim()) {
      merged.displayName = spec.label.trim().slice(0, MAX_LABEL_LENGTH);
    }
    if (typeof spec.description === 'string' && spec.description.trim()) {
      merged.description = spec.description
        .trim()
        .slice(0, MAX_DESCRIPTION_LENGTH);
    }
    if (typeof spec.group === 'string' && spec.group.trim()) {
      merged.group = spec.group.trim().slice(0, MAX_GROUP_LENGTH);
    }
    if (typeof spec.unit === 'string' && spec.unit.trim()) {
      merged.unit = spec.unit.trim().slice(0, MAX_UNIT_LENGTH);
    }

    if (parameter.type === 'number' || parameter.type === 'number[]') {
      const range = { ...parameter.range };
      if (typeof spec.min === 'number' && isSaneBound(spec.min)) {
        range.min = spec.min;
      }
      if (typeof spec.max === 'number' && isSaneBound(spec.max)) {
        range.max = spec.max;
      }
      if (
        typeof spec.step === 'number' &&
        isSaneBound(spec.step) &&
        spec.step >= MIN_STEP
      ) {
        range.step = spec.step;
      }

      const values = Array.isArray(parameter.value)
        ? parameter.value.filter(
            (value): value is number => typeof value === 'number',
          )
        : typeof parameter.value === 'number'
          ? [parameter.value]
          : [];
      if (values.length > 0) {
        const currentMin = Math.min(...values);
        const currentMax = Math.max(...values);
        if (range.min !== undefined && range.min > currentMin) {
          range.min = currentMin;
        }
        if (range.max !== undefined && range.max < currentMax) {
          range.max = currentMax;
        }
      }

      const degenerate =
        range.min !== undefined &&
        range.max !== undefined &&
        range.min >= range.max;
      merged.range = degenerate ? parameter.range : range;
    }

    const options = sanitizeOptions(parameter, spec.options);
    if (options.length > 0) merged.options = options;
    return merged;
  });
}

function parseOptions(value: unknown): ParameterOption[] {
  if (!Array.isArray(value)) return [];
  const options: ParameterOption[] = [];

  for (const item of value.slice(0, MAX_OPTIONS)) {
    if (typeof item === 'string' || typeof item === 'number') {
      if (typeof item === 'number' && !Number.isFinite(item)) continue;
      options.push({ value: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const optionValue = item.value;
    if (typeof optionValue !== 'string' && typeof optionValue !== 'number') {
      continue;
    }
    if (typeof optionValue === 'number' && !Number.isFinite(optionValue)) {
      continue;
    }
    const label = cleanString(item.label);
    options.push(
      label ? { value: optionValue, label } : { value: optionValue },
    );
  }

  return options;
}

function sanitizeOptions(
  parameter: Parameter,
  source: ParameterOption[] | undefined,
): ParameterOption[] {
  if (!Array.isArray(source) || source.length === 0) return [];
  if (parameter.type !== 'number' && parameter.type !== 'string') return [];

  const options: ParameterOption[] = [];
  const seen = new Set<string>();
  for (const option of source.slice(0, MAX_OPTIONS)) {
    if (!option || typeof option !== 'object') continue;
    const raw = option.value;
    let value: string | number;
    if (parameter.type === 'number') {
      value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) continue;
    } else {
      if (typeof raw !== 'string') continue;
      value = raw.slice(0, MAX_OPTION_LENGTH);
      if (!value) continue;
    }

    const key = `${typeof value}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label =
      typeof option.label === 'string' && option.label.trim()
        ? option.label.trim().slice(0, MAX_OPTION_LENGTH)
        : undefined;
    options.push(label ? { value, label } : { value });
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function isSaneBound(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_BOUND_MAGNITUDE;
}
