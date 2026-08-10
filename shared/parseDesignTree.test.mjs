import assert from 'node:assert/strict';
import test from 'node:test';
import parseDesignTree from './parseDesignTree.ts';

test('parses a hierarchy with linked parameter names', () => {
  const result = parseDesignTree(`
// @adam-node {"id":"body","kind":"part","name":"Main body","params":["width","height"],"moduleName":"body"}
// @adam-node {"id":"holes","kind":"operation","name":"Mounting holes","parentId":"body","params":["hole_diameter"]}
`);

  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.nodes, [
    {
      id: 'body',
      kind: 'part',
      name: 'Main body',
      params: ['width', 'height'],
      moduleName: 'body',
    },
    {
      id: 'holes',
      kind: 'operation',
      name: 'Mounting holes',
      parentId: 'body',
      params: ['hole_diameter'],
    },
  ]);
});

test('accepts legacy CADAM annotations', () => {
  const result = parseDesignTree(
    '// @cadam-node {"id":"root","kind":"group","name":"Assembly"}',
  );
  assert.equal(result.nodes[0].id, 'root');
  assert.equal(result.warnings.length, 0);
});

test('reports malformed, duplicate, and missing-parent annotations', () => {
  const result = parseDesignTree(`
// @adam-node nope
// @adam-node {"id":"body","kind":"part"}
// @adam-node {"id":"body","kind":"part"}
// @adam-node {"id":"holes","kind":"operation","parentId":"missing","params":["size",12]}
`);

  assert.deepEqual(
    result.warnings.map((item) => item.code),
    ['invalid-json', 'duplicate-id', 'invalid-param-entry', 'missing-parent'],
  );
});

test('reports parent cycles without looping', () => {
  const result = parseDesignTree(`
// @adam-node {"id":"a","kind":"part","parentId":"b"}
// @adam-node {"id":"b","kind":"group","parentId":"a"}
`);
  assert.equal(
    result.warnings.filter((warning) => warning.code === 'circular-parent')
      .length,
    1,
  );
});
