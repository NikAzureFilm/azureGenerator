import assert from 'node:assert/strict';
import test from 'node:test';
import { applyParameterSpecs, parseParameterSpecs } from './parameterSpecs.ts';

const width = {
  name: 'width',
  displayName: 'Width',
  value: 50,
  defaultValue: 50,
  type: 'number',
  range: { min: 0, max: 100 },
  options: [],
};

test('parses Adam and CADAM parameter annotations', () => {
  const specs = parseParameterSpecs(`
// @adam-param {"name":"width","label":"Overall width","type":"number","min":10,"max":200,"step":2,"unit":"mm","group":"Body"}
// @cadam-param {"name":"style","type":"string","options":[{"value":"round","label":"Round"},"square"]}
// @adam-param not-json
`);

  assert.equal(specs.length, 2);
  assert.deepEqual(specs[0], {
    name: 'width',
    label: 'Overall width',
    type: 'number',
    group: 'Body',
    unit: 'mm',
    min: 10,
    max: 200,
    step: 2,
  });
  assert.deepEqual(specs[1].options, [
    { value: 'round', label: 'Round' },
    { value: 'square' },
  ]);
});

test('overlays safe presentation metadata without changing source values', () => {
  const [result] = applyParameterSpecs(
    [width],
    [
      {
        name: 'width',
        label: 'Body width',
        description: 'Outside width of the body.',
        group: 'Body',
        unit: 'mm',
        min: 60,
        max: 200,
        step: 0.5,
        options: [
          { value: '50', label: 'Compact' },
          { value: '80', label: 'Large' },
        ],
      },
    ],
  );

  assert.equal(result.value, 50);
  assert.equal(result.defaultValue, 50);
  assert.equal(result.displayName, 'Body width');
  assert.equal(result.description, 'Outside width of the body.');
  assert.equal(result.group, 'Body');
  assert.equal(result.unit, 'mm');
  assert.deepEqual(result.range, { min: 50, max: 200, step: 0.5 });
  assert.deepEqual(result.options, [
    { value: 50, label: 'Compact' },
    { value: 80, label: 'Large' },
  ]);
});

test('ignores unknown variables and unsafe ranges', () => {
  const original = [width];
  const result = applyParameterSpecs(original, [
    { name: 'missing', label: 'Ghost' },
    { name: 'width', min: 60, max: 40, step: -1 },
  ]);

  assert.deepEqual(result[0].range, width.range);
  assert.equal(result[0].displayName, 'Width');
});

test('applies one numeric range to number-array controls', () => {
  const [result] = applyParameterSpecs(
    [
      {
        name: 'size',
        displayName: 'Size',
        value: [20, 30, 40],
        defaultValue: [20, 30, 40],
        type: 'number[]',
      },
    ],
    [{ name: 'size', min: 25, max: 35, step: 1, unit: 'mm' }],
  );

  assert.deepEqual(result.range, { min: 20, max: 40, step: 1 });
  assert.equal(result.unit, 'mm');
});
