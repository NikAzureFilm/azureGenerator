import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');

assert.match(
  source,
  /onAddBase\?:/,
  'assistant message should expose a post-generation add-base callback',
);

assert.match(
  source,
  /meshBaseSettings:/,
  'assistant add-base callback should include rotation, scale, and thickness settings',
);

assert.match(
  source,
  /const canAddBase =[\s\S]*meshDataQuery\.data\?\.status === 'success'[\s\S]*!meshDataQuery\.data\?\.prompt\?\.meshBase/s,
  'add-base action should only show for completed meshes that do not already have a generated base',
);

assert.match(
  source,
  /MESH_BASE_OPTIONS\.filter\([\s\S]*option\.id !== DEFAULT_MESH_BASE[\s\S]*\)/,
  'post-generation add-base menu should offer base presets and omit "No base"',
);

assert.match(
  source,
  /<span>Add base<\/span>/,
  'completed mesh messages should render an Add base action',
);

assert.match(
  source,
  /DEFAULT_MESH_BASE_SETTINGS/,
  'add-base menu should initialize transform controls from shared defaults',
);

assert.match(
  source,
  /Rotation[\s\S]*Scale[\s\S]*Thickness/s,
  'add-base menu should expose rotation, scale, and thickness controls',
);

assert.match(
  source,
  /<Slider[\s\S]*baseRotation[\s\S]*<Slider[\s\S]*baseScale[\s\S]*<Slider[\s\S]*baseThickness/s,
  'rotation, scale, and thickness should be adjustable with sliders',
);
