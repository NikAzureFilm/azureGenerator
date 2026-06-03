import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function assertStageShadowsDisabled(source, label) {
  const stageTags = source.match(/<Stage\b[\s\S]*?>/g) ?? [];

  assert.ok(stageTags.length > 0, `${label} renders a Drei Stage`);

  for (const stageTag of stageTags) {
    assert.match(
      stageTag,
      /\bshadows=\{false\}/,
      `${label} disables Drei contact shadows`,
    );
  }
}

const meshPreviewSource = readSource('./MeshPreview.tsx');
const threeSceneSource = readSource('./ThreeScene.tsx');
const visualCardSource = readSource('../history/VisualCard.tsx');

assertStageShadowsDisabled(meshPreviewSource, 'MeshPreview');
assertStageShadowsDisabled(threeSceneSource, 'ThreeScene');
assertStageShadowsDisabled(visualCardSource, 'VisualCard');
assert.doesNotMatch(
  threeSceneSource,
  /\bcastShadow\b/,
  'ThreeScene lights should not request shadow casting',
);
assert.match(
  meshPreviewSource,
  /pbrMat\.aoMap\s*=\s*null/,
  'MeshPreview should clear ambient-occlusion maps that look like baked shadows',
);
