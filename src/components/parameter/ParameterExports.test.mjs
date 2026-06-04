import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const desktopSource = readFileSync(
  new URL('./ParameterSection.tsx', import.meta.url),
  'utf8',
);
const mobileSource = readFileSync(
  new URL('./ParameterSheetContent.tsx', import.meta.url),
  'utf8',
);

for (const [label, source] of [
  ['desktop', desktopSource],
  ['mobile', mobileSource],
]) {
  assert.match(
    source,
    /type DownloadFormat = 'stl' \| 'scad' \| 'dxf' \| 'step' \| 'obj';/,
    `${label} CAD export menu should include STEP and OBJ formats`,
  );
  assert.match(
    source,
    /downloadSTEPFile/,
    `${label} CAD export menu should use the STEP download helper`,
  );
  assert.match(
    source,
    /downloadOBJFile/,
    `${label} CAD export menu should use the OBJ download helper`,
  );
  assert.match(
    source,
    /step:\s*!!currentOutput/,
    `${label} STEP export should be available from the compiled STL output`,
  );
  assert.match(
    source,
    /obj:\s*!!currentOutput/,
    `${label} OBJ export should be available from the compiled STL output`,
  );
  assert.match(source, /\.STEP/, `${label} menu should render .STEP`);
  assert.match(source, /\.OBJ/, `${label} menu should render .OBJ`);
}
