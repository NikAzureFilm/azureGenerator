import type {
  DesignTreeNode,
  DesignTreeNodeKind,
  DesignTreeParseResult,
  DesignTreeParseWarning,
} from './types.ts';

const NODE_COMMENT_REGEX = /^\s*\/\/\s*@(adam|cadam)-node\s+(.+?)\s*$/gm;
const KNOWN_NODE_KINDS = new Set<string>([
  'part',
  'operation',
  'group',
  'parameter',
]);
const MAX_NODES = 200;
const MAX_ID_LENGTH = 80;
const MAX_NAME_LENGTH = 100;
const MAX_PARAMS = 100;

type NodePayload = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  parentId?: unknown;
  params?: unknown;
  moduleName?: unknown;
};

type NodeSource = { line: number; raw: string };

export default function parseDesignTree(source: string): DesignTreeParseResult {
  const nodes: DesignTreeNode[] = [];
  const warnings: DesignTreeParseWarning[] = [];
  const seenIds = new Set<string>();
  const nodeSources = new Map<string, NodeSource>();

  NODE_COMMENT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (
    nodes.length < MAX_NODES &&
    (match = NODE_COMMENT_REGEX.exec(source)) !== null
  ) {
    const raw = match[0];
    const json = match[2].trim();
    const line = lineNumberForIndex(source, match.index);
    let payload: NodePayload;

    try {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed)) {
        warnings.push(
          warning(
            'invalid-json',
            'Node data must be a JSON object.',
            line,
            raw,
          ),
        );
        continue;
      }
      payload = parsed;
    } catch {
      warnings.push(
        warning('invalid-json', 'Node data is not valid JSON.', line, raw),
      );
      continue;
    }

    const id = stringOrUndefined(payload.id, MAX_ID_LENGTH);
    if (!id) {
      warnings.push(
        warning('missing-id', 'Node data is missing a string id.', line, raw),
      );
      continue;
    }
    const kind = stringOrUndefined(payload.kind, 24);
    if (!kind) {
      warnings.push({
        ...warning(
          'missing-kind',
          'Node data is missing a string kind.',
          line,
          raw,
        ),
        id,
      });
      continue;
    }
    if (!isKnownNodeKind(kind)) {
      warnings.push({
        ...warning(
          'unknown-kind',
          `Node kind "${kind}" is not supported.`,
          line,
          raw,
        ),
        id,
        kind,
      });
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push({
        ...warning(
          'duplicate-id',
          `Node id "${id}" was already used.`,
          line,
          raw,
        ),
        id,
      });
      continue;
    }
    seenIds.add(id);

    const node: DesignTreeNode = {
      id,
      kind,
      name: stringOrUndefined(payload.name, MAX_NAME_LENGTH) ?? id,
    };
    const parentId = stringOrUndefined(payload.parentId, MAX_ID_LENGTH);
    if (parentId) node.parentId = parentId;
    const params = stringArrayResult(payload.params);
    if (params.hasInvalidEntry) {
      warnings.push({
        ...warning(
          'invalid-param-entry',
          'Node params must contain only strings.',
          line,
          raw,
        ),
        id,
      });
    }
    if (params.values.length > 0) node.params = params.values;
    const moduleName = stringOrUndefined(payload.moduleName, MAX_NAME_LENGTH);
    if (moduleName) node.moduleName = moduleName;

    nodes.push(node);
    nodeSources.set(id, { line, raw });
  }

  validateParentLinks(nodes, warnings, nodeSources);
  return { nodes, warnings };
}

function validateParentLinks(
  nodes: DesignTreeNode[],
  warnings: DesignTreeParseWarning[],
  nodeSources: Map<string, NodeSource>,
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (!node.parentId || byId.has(node.parentId)) continue;
    const source = nodeSources.get(node.id);
    warnings.push({
      code: 'missing-parent',
      message: `Node parent "${node.parentId}" does not exist.`,
      line: source?.line ?? 0,
      raw: source?.raw ?? '',
      id: node.id,
      parentId: node.parentId,
    });
  }

  const warnedCycles = new Set<string>();
  for (const node of nodes) {
    const path: string[] = [];
    const indexes = new Map<string, number>();
    let currentId: string | undefined = node.id;

    while (currentId) {
      const existingIndex = indexes.get(currentId);
      if (existingIndex !== undefined) {
        const cycleIds = path.slice(existingIndex);
        const key = [...cycleIds].sort().join('\0');
        if (!warnedCycles.has(key)) {
          warnedCycles.add(key);
          const cycleNode = byId.get(cycleIds[0]);
          const source = cycleNode ? nodeSources.get(cycleNode.id) : undefined;
          warnings.push({
            code: 'circular-parent',
            message: `Node parents contain a cycle: ${cycleIds.join(' -> ')}.`,
            line: source?.line ?? 0,
            raw: source?.raw ?? '',
            id: cycleNode?.id,
            parentId: cycleNode?.parentId,
          });
        }
        break;
      }

      indexes.set(currentId, path.length);
      path.push(currentId);
      const current = byId.get(currentId);
      if (!current?.parentId || !byId.has(current.parentId)) break;
      currentId = current.parentId;
    }
  }
}

function warning(
  code: DesignTreeParseWarning['code'],
  message: string,
  line: number,
  raw: string,
): DesignTreeParseWarning {
  return { code, message, line, raw };
}

function isKnownNodeKind(kind: string): kind is DesignTreeNodeKind {
  return KNOWN_NODE_KINDS.has(kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function stringArrayResult(value: unknown) {
  if (!Array.isArray(value)) {
    return { values: [] as string[], hasInvalidEntry: value !== undefined };
  }
  const valid = value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );
  return {
    values: valid
      .slice(0, MAX_PARAMS)
      .map((item) => item.trim().slice(0, MAX_ID_LENGTH)),
    hasInvalidEntry: valid.length !== value.length,
  };
}

function lineNumberForIndex(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}
