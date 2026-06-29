import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /const MAX_QUALITY_IMAGE_TO_3D_ENDPOINT =\s*'fal-ai\/meshy\/v6-preview\/image-to-3d';/,
  'Max Quality should submit to the configured image-to-3D endpoint',
);

assert.match(
  source,
  /const MAX_QUALITY_TARGET_POLYCOUNT = 300000;/,
  'Max Quality should know the 300k polygon cap',
);

assert.match(
  source,
  /model_type: 'standard' as const,[\s\S]*target_polycount: safePolycount,[\s\S]*should_remesh: true,[\s\S]*should_texture: true,[\s\S]*enable_pbr: false,/,
  'Max Quality payload should request standard remeshed textured output',
);

assert.match(
  source,
  /: MAX_QUALITY_TARGET_POLYCOUNT;/,
  'Max Quality should default target_polycount to the 300k cap',
);
