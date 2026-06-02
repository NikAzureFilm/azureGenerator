const PRIMITIVE_PART_CLASSES = [
  'Box',
  'Cylinder',
  'Cone',
  'Sphere',
  'Torus',
  'Wedge',
];
const PRIMITIVE_TOPOLOGY_METHODS = ['fillet', 'chamfer'];

export function extractPythonSource(text: string): string {
  const fence = text.match(/```(?:python)?\s*([\s\S]*?)```/);
  const source = normalizeBuild123dSource((fence?.[1] ?? text).trim());
  if (!source.includes('def gen_step')) {
    throw new Error('Generated CAD source did not define gen_step().');
  }
  return source;
}

export function normalizeBuild123dSource(source: string): string {
  const axisNormalized = source.replace(/\bSortBy\.(X|Y|Z)\b/g, 'Axis.$1');
  return wrapPrimitiveTopologyEdits(axisNormalized);
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

function ensurePartImport(source: string): string {
  if (/\bfrom\s+build123d\s+import\s+\*/.test(source)) {
    return source;
  }

  const singleLineImportPattern = /^from\s+build123d\s+import\s+([^\n]+)$/m;
  const singleLineImport = source.match(singleLineImportPattern);
  if (!singleLineImport) {
    return `from build123d import Part\n${source}`;
  }

  const importedNames = singleLineImport[1]
    .split(',')
    .map((name) => name.trim());
  if (importedNames.includes('Part')) {
    return source;
  }

  return source.replace(
    singleLineImportPattern,
    `from build123d import ${[...importedNames, 'Part'].join(', ')}`,
  );
}
