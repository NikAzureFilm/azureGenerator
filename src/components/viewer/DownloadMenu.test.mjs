import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./DownloadMenu.tsx', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /createEnhancedGLB\(gltf\.scene,\s*filename\)/,
  'enhanced GLB downloads must not bypass printable mesh processing',
);

assert.match(
  source,
  /const processedScene = await processUserModelForDownload\(gltf\);[\s\S]*const enhancedBlob = await createEnhancedGLB\(processedScene,\s*filename\);/,
  'enhanced GLB downloads should export from the printable processed scene',
);

assert.match(
  source,
  /const printableGlb = await createEnhancedGLB\(processedScene,\s*filename\);[\s\S]*extractAndDownloadTextures\([\s\S]*gltf,\s*printableGlb,\s*filename,\s*'glb',?\s*\)/,
  'texture ZIP downloads should package a printable processed GLB, not the original mesh file',
);

assert.doesNotMatch(
  source,
  /\.FBX/,
  'download menu should not offer the original FBX because it bypasses printable repair',
);

assert.doesNotMatch(
  source,
  /downloadFBX/,
  'download menu should not keep an original-FBX download path that bypasses printable repair',
);

assert.match(
  source,
  /setIsDownloading3MF\(true\);\s*setIsDropdownOpen\(false\);\s*setTimeout\(async \(\) => \{/,
  '3MF downloads should immediately dismiss the static color-count menu while the export is prepared',
);

assert.match(
  source,
  /role="status"[\s\S]*Preparing \.3MF/,
  '3MF downloads should render a visible accessible busy indicator while the export is prepared',
);
