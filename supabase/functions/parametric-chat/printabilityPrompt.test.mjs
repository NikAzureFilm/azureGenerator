import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /watertight/i,
  'OpenSCAD code-generation prompt should require watertight output',
);
assert.match(
  source,
  /minimum wall thickness/i,
  'OpenSCAD code-generation prompt should require practical wall thickness',
);
assert.match(
  source,
  /1\.2 mm/i,
  'OpenSCAD code-generation prompt should provide a concrete FDM wall minimum',
);
assert.match(
  source,
  /build plate/i,
  'OpenSCAD code-generation prompt should require print-bed layout',
);
assert.match(
  source,
  /never leave floating parts/i,
  'OpenSCAD code-generation prompt should explicitly forbid floating parts',
);
assert.match(
  source,
  /overlap/i,
  'OpenSCAD code-generation prompt should require features to overlap the body they attach to',
);
assert.match(
  source,
  /one connected piece or as a kit of separate parts/i,
  'OpenSCAD code-generation prompt should frame output as one connected piece or a kit of separate parts',
);
assert.match(
  source,
  /If the user asks for a single, one-piece, contiguous, or connected object, that choice is MANDATORY/i,
  'OpenSCAD code-generation prompt should make an explicit single-piece request mandatory',
);
assert.match(
  source,
  /preserve that requirement exactly: rebuild it as one continuous solid/i,
  'self-inspection should preserve explicit single-piece requirements',
);
assert.match(
  source,
  /lowest point is at z = 0/i,
  'OpenSCAD code-generation prompt should require separate parts to rest flat on the build plate',
);
assert.match(
  source,
  /BOSL2\/screws\.scad/,
  'OpenSCAD code-generation prompt should prefer BOSL2 screw helpers for threaded parts',
);
assert.match(
  source,
  /OpenSCAD Customizer/i,
  'OpenSCAD code-generation prompt should require Customizer annotations for editable parameters',
);
assert.match(
  source,
  /full descriptive snake_case/i,
  'OpenSCAD code-generation prompt should require readable parameter names',
);
assert.match(
  source,
  /\*_color/i,
  'OpenSCAD code-generation prompt should require editable color parameters',
);
assert.match(
  source,
  /Use modules for repeated or meaningful model parts/i,
  'OpenSCAD code-generation prompt should encourage structured CAD modules',
);
assert.match(
  source,
  /BOSL2\/threading\.scad/,
  'OpenSCAD code-generation prompt should prefer BOSL2 threading helpers for custom threads',
);
assert.match(
  source,
  /BOSL2\/skin\.scad/,
  'OpenSCAD code-generation prompt should prefer BOSL2 swept and lofted geometry helpers',
);
assert.match(
  source,
  /path_sweep\(\)/,
  'OpenSCAD code-generation prompt should mention path_sweep for curved shapes',
);
