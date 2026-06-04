import assert from 'node:assert/strict';
import {
  buildCadSystemPrompt,
  extractPythonSource,
  normalizeBuild123dSource,
} from './build123dSource.ts';

const badPrimitiveFilletSource = `
from build123d import Box, Axis

def gen_step():
    main_body = Box(60, 30, 12)
    vertical_edges = main_body.edges().filter_by(SortBy.Z)
    main_body = main_body.fillet(6.0, vertical_edges)
    return main_body
`;

const normalized = normalizeBuild123dSource(badPrimitiveFilletSource);

assert.match(
  normalized,
  /from build123d import Box, Axis, Part/,
  'normalization must import Part when wrapping primitive operations',
);
assert.match(
  normalized,
  /vertical_edges = main_body\.edges\(\)\.filter_by\(Axis\.Z\)/,
  'normalization must keep existing SortBy axis repair',
);
assert.match(
  normalized,
  /main_body = Part\(main_body\)\.fillet\(6\.0, vertical_edges\)/,
  'normalization must wrap primitive Box before fillet',
);

assert.equal(
  extractPythonSource(`\`\`\`python\n${badPrimitiveFilletSource}\n\`\`\``),
  normalizeBuild123dSource(badPrimitiveFilletSource.trim()),
  'source extraction must apply build123d normalization after fence stripping',
);

assert.throws(
  () =>
    extractPythonSource(`
from build123d import *

def gen_step():
    with BuildPart() as model:
        Hull()
        Box(10, 10, 10)
    return model.part
`),
  /Unsupported build123d helper "Hull"/,
);

assert.match(
  buildCadSystemPrompt(),
  /Do not call \.fillet\(\), \.chamfer\(\), or boolean\/topology edit methods directly on primitives like Box/,
  'prompt must forbid build123d primitive topology chaining',
);
assert.match(
  buildCadSystemPrompt(),
  /minimum wall thickness/i,
  'STEP CAD prompt should require practical printable wall thickness defaults',
);
assert.match(
  buildCadSystemPrompt(),
  /1\.2 mm/i,
  'STEP CAD prompt should provide a concrete FDM minimum wall thickness',
);
assert.match(
  buildCadSystemPrompt(),
  /build plate/i,
  'STEP CAD prompt should require bodies to be laid out for printing',
);
assert.match(
  buildCadSystemPrompt(),
  /Do not use Hull\(\)/,
  'prompt must forbid unsupported hull helpers',
);
