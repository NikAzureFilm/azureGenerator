import parseParameters from './parseParameter.ts';

Deno.test('structured parameter annotations enrich parsed controls', () => {
  const source = [
    '// @adam-param {"name":"width","label":"Overall width","type":"number","min":10,"max":100,"step":1,"unit":"mm","description":"Outside width.","group":"Body"}',
    'width = 50; // [0:5:200]',
    '// @adam-node {"id":"body","kind":"part","name":"Body","params":["width"]}',
    'module body() { cube(width); }',
  ].join('\n');

  const [parameter] = parseParameters(source);
  if (!parameter) throw new Error('Expected width parameter');
  if (parameter.displayName !== 'Overall width') {
    throw new Error(`Unexpected label: ${parameter.displayName}`);
  }
  if (parameter.description !== 'Outside width.') {
    throw new Error(`Unexpected description: ${parameter.description}`);
  }
  if (parameter.group !== 'Body' || parameter.unit !== 'mm') {
    throw new Error('Expected structured group and unit metadata');
  }
  if (
    parameter.range?.min !== 10 ||
    parameter.range.max !== 100 ||
    parameter.range.step !== 1
  ) {
    throw new Error(`Unexpected range: ${JSON.stringify(parameter.range)}`);
  }
});

Deno.test('legacy Customizer parameters remain supported', () => {
  const [parameter] = parseParameters('height = 25; // [5:5:50]');
  if (
    parameter?.displayName !== 'Height' ||
    parameter.range?.min !== 5 ||
    parameter.range.max !== 50 ||
    parameter.range.step !== 5
  ) {
    throw new Error(`Legacy parameter changed: ${JSON.stringify(parameter)}`);
  }
});
