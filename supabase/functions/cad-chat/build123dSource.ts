const PRIMITIVE_PART_CLASSES = [
  'Box',
  'Cylinder',
  'Cone',
  'Sphere',
  'Torus',
  'Wedge',
];
const PRIMITIVE_TOPOLOGY_METHODS = ['fillet', 'chamfer'];
const UNSUPPORTED_HELPERS = ['Hull'];

export function extractPythonSource(text: string): string {
  const fence = text.match(/```(?:python)?\s*([\s\S]*?)```/);
  const source = normalizeBuild123dSource((fence?.[1] ?? text).trim());
  if (!source.includes('def gen_step')) {
    throw new Error('Generated CAD source did not define gen_step().');
  }
  assertNoUnsupportedBuild123dHelpers(source);
  return source;
}

export function normalizeBuild123dSource(source: string): string {
  const axisNormalized = source.replace(/\bSortBy\.(X|Y|Z)\b/g, 'Axis.$1');
  const slotNormalized = rewriteEndpointSlotCenterToCenterCalls(axisNormalized);
  const polygonNormalized = unpackSinglePolygonPointCollection(slotNormalized);
  return wrapPrimitiveTopologyEdits(polygonNormalized);
}

export function buildCadSystemPrompt(): string {
  return `You generate build123d Python CAD source for STEP export.

Return only Python source code. No markdown.

Requirements:
- Use millimeters.
- Import from build123d.
- Define a function named gen_step().
- gen_step() must return one closed STEP-ready build123d Part, Solid, Compound, or Assembly.
- Prefer precise mechanical geometry: boxes, cylinders, holes, slots, chamfers, fillets, ribs, bosses, standoffs.
- Use named parameters near the top.
- Keep the model robust and simple enough to export.
- Make the result 3D-printable by default: watertight closed solids, no floating parts, no unsupported internal loose bodies, and no paper-thin walls.
- Use a practical minimum wall thickness of 1.2 mm when dimensions are missing; use thicker walls, ribs, or bosses for load-bearing features.
- Avoid zero-thickness surfaces, open shells, self-intersections, fragile spikes, and details too small for a 0.4 mm FDM nozzle.
- For functional mechanisms such as hinges, clips, pivots, and pins, prefer a print-ready kit with separate parts laid out on the build plate instead of an assembled model with trapped or floating parts.
- Use practical FDM clearances when dimensions are missing: 0.3-0.5 mm radial clearance for pins/holes and 0.4-0.6 mm axial gaps between moving knuckles or sliding parts.
- Place every separate printable body so its lowest Z is on the build plate, with enough spacing between bodies for slicers to separate or print them cleanly.
- Use build123d-safe topology edits: either use BuildPart builder mode, or convert primitives before edits, e.g. body = Part(Box(length, width, height)); body = body.fillet(radius, edges).
- Do not call .fillet(), .chamfer(), or boolean/topology edit methods directly on primitives like Box(...), Cylinder(...), Cone(...), Sphere(...), Torus(...), or Wedge(...).
- Do not use Hull(), hull(), make_hull(), convex_hull(), or other hull helpers; approximate link outlines with boxes, cylinders, slots, ribs, fillets, and chamfers.
- For sketch polygons, pass points as separate arguments or unpack point lists, e.g. Polygon(p1, p2, p3) or Polygon(*points); never Polygon([p1, p2, p3]).
- For slots, SlotCenterToCenter takes numeric center separation and height, e.g. SlotCenterToCenter(120, 24). For point-defined slots use SlotCenterPoint(center, point, height); never SlotCenterToCenter((x1, y1), (x2, y2), height).
- For coordinate sorting, use sort_by(Axis.X), sort_by(Axis.Y), or sort_by(Axis.Z). Do not use SortBy.X, SortBy.Y, or SortBy.Z.
- Do not read files, write files, use network, subprocess, shell, or external services.
- Do not call export_step; the worker does that.`;
}

export function buildCadUserPrompt(
  promptText: string,
  previousError?: string,
): string {
  const correction = previousError
    ? `

The previous generated source failed with this build123d error:
${previousError}

Return corrected Python source that avoids that error.`
    : '';

  return `Create STEP-first build123d CAD source for this request:

${promptText}

If dimensions are missing, make reasonable printable assumptions and encode them as named parameters.
If the request describes an assembly that cannot print as one reliable object, return a print-ready kit: separate closed solids arranged on the build plate with assembly clearances.${correction}`;
}

function wrapPrimitiveTopologyEdits(source: string): string {
  const primitiveNames = PRIMITIVE_PART_CLASSES.join('|');
  const topologyMethods = PRIMITIVE_TOPOLOGY_METHODS.join('|');
  const primitiveAssignmentPattern = new RegExp(
    `^\\s*([A-Za-z_]\\w*)\\s*=\\s*(?:build123d\\.)?(?:${primitiveNames})\\s*\\(`,
  );
  const topologyEditPattern = new RegExp(
    `^(\\s*)([A-Za-z_]\\w*)\\s*=\\s*([A-Za-z_]\\w*)\\.(${topologyMethods})\\((.*)\\)(\\s*(?:#.*)?)$`,
  );
  const primitiveVariables = new Set<string>();
  let wrappedPrimitiveTopologyEdit = false;

  const lines = source.split(/\r?\n/).map((line) => {
    const primitiveAssignment = line.match(primitiveAssignmentPattern);
    if (primitiveAssignment) {
      primitiveVariables.add(primitiveAssignment[1]);
    }

    const topologyEdit = line.match(topologyEditPattern);
    if (!topologyEdit) {
      return line;
    }

    const [, indent, target, receiver, method, args, suffix] = topologyEdit;
    if (target !== receiver || !primitiveVariables.has(receiver)) {
      return line;
    }

    wrappedPrimitiveTopologyEdit = true;
    primitiveVariables.delete(receiver);
    return `${indent}${target} = Part(${receiver}).${method}(${args})${suffix}`;
  });

  const normalized = lines.join('\n');
  return wrappedPrimitiveTopologyEdit
    ? ensurePartImport(normalized)
    : normalized;
}

function assertNoUnsupportedBuild123dHelpers(source: string) {
  for (const helper of UNSUPPORTED_HELPERS) {
    const helperCall = new RegExp(`\\b(?:build123d\\.)?${helper}\\s*\\(`);
    if (helperCall.test(source)) {
      throw new Error(
        `Unsupported build123d helper "${helper}"; approximate that shape with primitives, booleans, fillets, or chamfers.`,
      );
    }
  }
}

type TopLevelArgument = {
  text: string;
  start: number;
};

function rewriteEndpointSlotCenterToCenterCalls(source: string): string {
  const callName = 'SlotCenterToCenter';
  const replacementName = 'SlotCenterPoint';
  let result = '';
  let cursor = 0;
  let rewritten = false;

  while (cursor < source.length) {
    const callIndex = source.indexOf(callName, cursor);
    if (callIndex === -1) {
      result += source.slice(cursor);
      break;
    }

    const openParenIndex = getCallOpenParenIndex(
      source,
      callIndex,
      callName.length,
    );
    if (openParenIndex === -1) {
      result += source.slice(cursor, callIndex + callName.length);
      cursor = callIndex + callName.length;
      continue;
    }

    const closeParenIndex = findMatchingDelimiter(
      source,
      openParenIndex,
      '(',
      ')',
    );
    if (closeParenIndex === -1) {
      result += source.slice(cursor);
      break;
    }

    const args = source.slice(openParenIndex + 1, closeParenIndex);
    const rewrittenArgs = rewriteEndpointSlotArguments(args);
    if (rewrittenArgs === args) {
      result += source.slice(cursor, closeParenIndex + 1);
    } else {
      rewritten = true;
      result +=
        source.slice(cursor, callIndex) +
        replacementName +
        `(${rewrittenArgs})`;
    }
    cursor = closeParenIndex + 1;
  }

  return rewritten ? ensureBuild123dImport(result, 'SlotCenterPoint') : result;
}

function rewriteEndpointSlotArguments(args: string): string {
  const topLevelArgs = splitTopLevelArguments(args);
  if (topLevelArgs.length < 3) {
    return args;
  }

  const startPoint = parseTwoItemTuple(topLevelArgs[0].text);
  const endPoint = parseTwoItemTuple(topLevelArgs[1].text);
  if (!startPoint || !endPoint) {
    return args;
  }

  const height = topLevelArgs[2].text.trim();
  if (!height || isTopLevelKeywordArgument(height)) {
    return args;
  }

  const [startX, startY] = startPoint;
  const [endX, endY] = endPoint;
  const midpoint = `(((${startX}) + (${endX})) / 2, ((${startY}) + (${endY})) / 2)`;
  const endpoint = `(${endX}, ${endY})`;
  const remainingArgs = topLevelArgs
    .slice(3)
    .map((arg) => arg.text.trim())
    .filter(Boolean);

  return [midpoint, endpoint, height, ...remainingArgs].join(', ');
}

function parseTwoItemTuple(text: string): [string, string] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(')) {
    return null;
  }

  const closeIndex = findMatchingDelimiter(trimmed, 0, '(', ')');
  if (closeIndex !== trimmed.length - 1) {
    return null;
  }

  const tupleItems = splitTopLevelArguments(trimmed.slice(1, -1)).map((arg) =>
    arg.text.trim(),
  );
  if (tupleItems.length !== 2 || tupleItems.some((item) => !item)) {
    return null;
  }

  return [tupleItems[0], tupleItems[1]];
}

function unpackSinglePolygonPointCollection(source: string): string {
  const polygonName = 'Polygon';
  let result = '';
  let cursor = 0;

  while (cursor < source.length) {
    const polygonIndex = source.indexOf(polygonName, cursor);
    if (polygonIndex === -1) {
      result += source.slice(cursor);
      break;
    }

    const openParenIndex = getCallOpenParenIndex(
      source,
      polygonIndex,
      polygonName.length,
    );
    if (openParenIndex === -1) {
      result += source.slice(cursor, polygonIndex + polygonName.length);
      cursor = polygonIndex + polygonName.length;
      continue;
    }

    const closeParenIndex = findMatchingDelimiter(
      source,
      openParenIndex,
      '(',
      ')',
    );
    if (closeParenIndex === -1) {
      result += source.slice(cursor);
      break;
    }

    const args = source.slice(openParenIndex + 1, closeParenIndex);
    result +=
      source.slice(cursor, openParenIndex + 1) +
      unpackSinglePositionalArgument(args) +
      ')';
    cursor = closeParenIndex + 1;
  }

  return result;
}

function getCallOpenParenIndex(
  source: string,
  callIndex: number,
  callNameLength: number,
): number {
  const previous = source[callIndex - 1];
  if (previous && isIdentifierCharacter(previous)) {
    return -1;
  }

  let index = callIndex + callNameLength;
  while (index < source.length && /[ \t]/.test(source[index])) {
    index += 1;
  }

  return source[index] === '(' ? index : -1;
}

function unpackSinglePositionalArgument(args: string): string {
  const topLevelArgs = splitTopLevelArguments(args);
  const positionalArgs = topLevelArgs.filter((arg) => {
    const trimmed = arg.text.trim();
    return (
      trimmed &&
      !trimmed.startsWith('**') &&
      !isTopLevelKeywordArgument(trimmed)
    );
  });

  if (positionalArgs.length !== 1) {
    return args;
  }

  const [singleArg] = positionalArgs;
  const leadingWhitespaceLength = singleArg.text.match(/^\s*/)?.[0].length ?? 0;
  const insertIndex = singleArg.start + leadingWhitespaceLength;
  if (args[insertIndex] === '*') {
    return args;
  }

  return `${args.slice(0, insertIndex)}*${args.slice(insertIndex)}`;
}

function splitTopLevelArguments(args: string): TopLevelArgument[] {
  const topLevelArgs: TopLevelArgument[] = [];
  let segmentStart = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let tripleQuoted = false;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];

    if (inComment) {
      if (char === '\n') {
        inComment = false;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (!tripleQuoted && char === '\\') {
        escaped = true;
        continue;
      }
      if (tripleQuoted && args.slice(index, index + 3) === quote.repeat(3)) {
        quote = null;
        tripleQuoted = false;
        index += 2;
        continue;
      }
      if (!tripleQuoted && char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '#') {
      inComment = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tripleQuoted = args.slice(index, index + 3) === char.repeat(3);
      if (tripleQuoted) {
        index += 2;
      }
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === ',' && depth === 0) {
      topLevelArgs.push({
        text: args.slice(segmentStart, index),
        start: segmentStart,
      });
      segmentStart = index + 1;
    }
  }

  topLevelArgs.push({
    text: args.slice(segmentStart),
    start: segmentStart,
  });

  return topLevelArgs;
}

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  openDelimiter: string,
  closeDelimiter: string,
): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let tripleQuoted = false;
  let escaped = false;
  let inComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inComment) {
      if (char === '\n') {
        inComment = false;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (!tripleQuoted && char === '\\') {
        escaped = true;
        continue;
      }
      if (tripleQuoted && source.slice(index, index + 3) === quote.repeat(3)) {
        quote = null;
        tripleQuoted = false;
        index += 2;
        continue;
      }
      if (!tripleQuoted && char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '#') {
      inComment = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tripleQuoted = source.slice(index, index + 3) === char.repeat(3);
      if (tripleQuoted) {
        index += 2;
      }
      continue;
    }

    if (char === openDelimiter) {
      depth += 1;
      continue;
    }

    if (char === closeDelimiter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isTopLevelKeywordArgument(arg: string): boolean {
  return /^[A-Za-z_]\w*\s*=/.test(arg);
}

function isIdentifierCharacter(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function ensurePartImport(source: string): string {
  return ensureBuild123dImport(source, 'Part');
}

function ensureBuild123dImport(source: string, importedName: string): string {
  if (/\bfrom\s+build123d\s+import\s+\*/.test(source)) {
    return source;
  }

  const singleLineImportPattern = /^from\s+build123d\s+import\s+([^\n]+)$/m;
  const singleLineImport = source.match(singleLineImportPattern);
  if (!singleLineImport) {
    return `from build123d import ${importedName}\n${source}`;
  }

  const importedNames = singleLineImport[1]
    .split(',')
    .map((name) => name.trim());
  if (importedNames.includes(importedName)) {
    return source;
  }

  return source.replace(
    singleLineImportPattern,
    `from build123d import ${[...importedNames, importedName].join(', ')}`,
  );
}
