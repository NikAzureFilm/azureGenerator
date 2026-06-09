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
  /BOSL2\/screws\.scad/,
  'OpenSCAD code-generation prompt should prefer BOSL2 screw helpers for threaded parts',
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
