import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import * as THREE from 'three';

export const DEFAULT_THREE_MF_COLOR_COUNT = 4;
export const MAX_THREE_MF_COLOR_COUNT = 16;

const CORE_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const PRODUCTION_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const SLIC3R_NAMESPACE = 'http://schemas.slic3r.org/3mf/2017/06';
const RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types';
const BAMBU_OBJECT_MODEL_PATH = '3D/Objects/Object_1_1.model';
const BAMBU_OBJECT_MODEL_REL_TARGET = '/3D/Objects/Object_1_1.model';
const BAMBU_ORCA_FILAMENT_SLOT_CODES = [
  '4',
  '8',
  '0C',
  '1C',
  '2C',
  '3C',
  '4C',
  '5C',
  '6C',
  '7C',
  '8C',
  '9C',
  'AC',
  'BC',
  'CC',
  'DC',
];
const VERTEX_KEY_PRECISION = 1e-6;
const DEGENERATE_TRIANGLE_AREA_SQUARED = 1e-20;
const SMALL_COLOR_ISLAND_TRIANGLE_COUNT = 4;
const SIMILAR_COLOR_ISLAND_DISTANCE_SQUARED = 0.03;

type VectorTuple = [number, number, number];

export type ThreeMfTriangle = {
  v1: number;
  v2: number;
  v3: number;
  colorIndex: number;
};

export type ThreeMfModelInput = {
  modelName: string;
  vertices: VectorTuple[];
  triangles: ThreeMfTriangle[];
  palette: string[];
};

type ColorSample = {
  color: THREE.Color;
  weight: number;
};

type TexturePixels = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

type SceneGeometry = {
  vertices: VectorTuple[];
  triangles: Array<
    Omit<ThreeMfTriangle, 'colorIndex'> & { color: THREE.Color }
  >;
};

type RepairedSceneGeometry = {
  vertices: VectorTuple[];
  triangles: Array<Omit<ThreeMfTriangle, 'colorIndex'>>;
};

type ThreeMfPackageParts = {
  contentTypesXml: string;
  relationshipsXml: string;
  modelRelationshipsXml: string;
  rootModelXml: string;
  objectModelXml: string;
  modelSettingsConfig: string;
  sliceInfoConfig: string;
  projectSettingsConfig: string;
};

export type ThreeMfMeshTopology = {
  vertexCount: number;
  weldedVertexCount: number;
  triangleCount: number;
  invalidVertexReferenceCount: number;
  degenerateTriangleCount: number;
  uniqueEdges: number;
  edgeUseHistogram: Record<number, number>;
  boundaryEdges: number;
  overSharedEdges: number;
  materialTransitionEdges: number;
};

type ZipTextEntry = {
  getData?: (writer: TextWriter) => Promise<string>;
};

const texturePixelCache = new WeakMap<THREE.Texture, TexturePixels | null>();

export function clampThreeMfColorCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_THREE_MF_COLOR_COUNT;
  }

  return Math.min(MAX_THREE_MF_COLOR_COUNT, Math.max(1, Math.round(value)));
}

export function buildThreeMfContentTypesXml(): string {
  return xmlDeclaration(`\
<Types xmlns="${CONTENT_TYPES_NAMESPACE}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="application/octet-stream"/>
</Types>`);
}

export function buildThreeMfRelationshipsXml(): string {
  return xmlDeclaration(`\
<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
  <Relationship Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>`);
}

export function buildThreeMfModelRelationshipsXml(): string {
  return xmlDeclaration(`\
<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
  <Relationship Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="${BAMBU_OBJECT_MODEL_REL_TARGET}"/>
</Relationships>`);
}

export function buildThreeMfModelXml({
  modelName,
  vertices,
  triangles,
  palette,
}: ThreeMfModelInput): string {
  const normalizedPalette = normalizePalette(palette);
  const baseMaterials = normalizedPalette
    .map((color, index) => {
      const filamentNumber = index + 1;
      return `      <base name="Generic PLA ${filamentNumber} (${color})" displaycolor="${color}FF"/>`;
    })
    .join('\n');
  const colors = normalizedPalette
    .map((color) => `      <m:color color="${color}FF"/>`)
    .join('\n');
  const vertexXml = vertices
    .map(
      ([x, y, z]) =>
        `        <vertex x="${formatNumber(x)}" y="${formatNumber(y)}" z="${formatNumber(z)}"/>`,
    )
    .join('\n');
  const triangleXml = triangles
    .map((triangle) => {
      const colorIndex = clampIndex(
        triangle.colorIndex,
        normalizedPalette.length,
      );
      const paintColor = getBambuOrcaPaintColor(colorIndex);
      return `        <triangle v1="${triangle.v1}" v2="${triangle.v2}" v3="${triangle.v3}" pid="1" p1="${colorIndex}" p2="${colorIndex}" p3="${colorIndex}" paint_color="${paintColor}"/>`;
    })
    .join('\n');

  return xmlDeclaration(`\
<model unit="millimeter" xml:lang="en-US" requiredextensions="m" xmlns="${CORE_NAMESPACE}" xmlns:m="${MATERIAL_NAMESPACE}">
  <metadata name="Title">${escapeXml(modelName)}</metadata>
  <metadata name="Designer">AzureFilm Generator</metadata>
  <resources>
    <basematerials id="1">
${baseMaterials}
    </basematerials>
    <m:colorgroup id="2">
${colors}
    </m:colorgroup>
    <object id="1" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
${vertexXml}
        </vertices>
        <triangles>
${triangleXml}
        </triangles>
      </mesh>
    </object>
  </resources>
</model>`);
}

export function buildThreeMfRootModelXml(modelName: string): string {
  return xmlDeclaration(`\
<model unit="millimeter" xml:lang="en-US" requiredextensions="p" xmlns="${CORE_NAMESPACE}" xmlns:slic3rpe="${SLIC3R_NAMESPACE}" xmlns:p="${PRODUCTION_NAMESPACE}">
  <metadata name="Application">AzureFilm Generator</metadata>
  <metadata name="BambuStudio:3mfVersion">1</metadata>
  <metadata name="Title">${escapeXml(modelName)}</metadata>
  <metadata name="Designer">AzureFilm Generator</metadata>
  <resources>
    <object id="2" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">
      <components>
        <component p:path="${BAMBU_OBJECT_MODEL_REL_TARGET}" objectid="1" p:UUID="00010000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
      </components>
    </object>
  </resources>
  <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">
    <item objectid="2" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" printable="1"/>
  </build>
</model>`);
}

export function buildThreeMfModelSettingsConfig(modelName: string): string {
  return xmlDeclaration(`\
<config>
  <object id="2">
    <metadata key="name" value="${escapeXml(modelName)}"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="${escapeXml(modelName)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="${escapeXml(modelName)}.3mf"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="8"/>
    </model_instance>
  </plate>
  <assemble>
  </assemble>
</config>`);
}

export function buildThreeMfSliceInfoConfig(): string {
  return xmlDeclaration(`\
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="01.08.02.56"/>
  </header>
</config>`);
}

export function buildThreeMfProjectSettingsConfig(palette: string[]): string {
  const normalizedPalette = normalizePalette(palette);
  const perFilament = (value: string) => normalizedPalette.map(() => value);

  return JSON.stringify(
    {
      name: 'project_settings',
      from: 'project',
      version: '01.08.02.56',
      filament_colour: normalizedPalette,
      default_filament_colour: normalizedPalette,
      filament_type: perFilament('PLA'),
      filament_settings_id: perFilament('Generic PLA'),
      filament_vendor: perFilament('Generic'),
      filament_diameter: perFilament('1.75'),
      filament_density: perFilament('1.24'),
      filament_cost: perFilament('20'),
      filament_ids: perFilament(''),
      filament_is_support: perFilament('0'),
      filament_soluble: perFilament('0'),
      filament_minimal_purge_on_wipe_tower: perFilament('15'),
      filament_start_gcode: perFilament(' '),
      filament_end_gcode: perFilament(' '),
      filament_max_volumetric_speed: perFilament('12'),
      filament_flow_ratio: perFilament('0.98'),
      nozzle_temperature: perFilament('220'),
      nozzle_temperature_initial_layer: perFilament('220'),
      nozzle_temperature_range_high: perFilament('240'),
      nozzle_temperature_range_low: perFilament('190'),
      nozzle_diameter: ['0.4'],
      single_extruder_multi_material: '1',
    },
    null,
    2,
  );
}

export async function createThreeMfBlobFromScene({
  scene,
  filename,
  colorCount,
}: {
  scene: THREE.Scene;
  filename: string;
  colorCount: number;
}): Promise<Blob> {
  const targetColorCount = clampThreeMfColorCount(colorCount);
  const sourceGeometry = extractSceneGeometry(scene);
  // Run the printable repair pass before palette quantization and 3MF color ids.
  const geometry = repairSceneGeometryForThreeMfExport(sourceGeometry);

  if (geometry.vertices.length === 0 || geometry.triangles.length === 0) {
    throw new Error('No printable mesh geometry was found for 3MF export.');
  }

  const coloredTriangles = assignColorsToRepairedTriangles(
    geometry,
    sourceGeometry,
  );
  const palette = quantizeTriangleColors(
    coloredTriangles.map((triangle) => ({
      color: triangle.color,
      weight: 1,
    })),
    targetColorCount,
  );

  const indexedTriangles = coloredTriangles.map((triangle) => ({
    v1: triangle.v1,
    v2: triangle.v2,
    v3: triangle.v3,
    colorIndex: findNearestPaletteIndex(triangle.color, palette),
  }));
  const { palette: usedPalette, triangles } = removeUnusedPaletteEntries(
    palette,
    smoothTriangleColorIndexes(indexedTriangles, palette),
  );

  const objectModelXml = buildThreeMfModelXml({
    modelName: filename,
    vertices: geometry.vertices,
    triangles,
    palette: usedPalette.map(colorToHex),
  });

  const packageParts = {
    contentTypesXml: buildThreeMfContentTypesXml(),
    relationshipsXml: buildThreeMfRelationshipsXml(),
    modelRelationshipsXml: buildThreeMfModelRelationshipsXml(),
    rootModelXml: buildThreeMfRootModelXml(filename),
    objectModelXml,
    modelSettingsConfig: buildThreeMfModelSettingsConfig(filename),
    sliceInfoConfig: buildThreeMfSliceInfoConfig(),
    projectSettingsConfig: buildThreeMfProjectSettingsConfig(
      usedPalette.map(colorToHex),
    ),
  };
  validateThreeMfPackageParts(packageParts);

  const blob = await createThreeMfPackage(packageParts);
  await validateThreeMfBlob(blob);
  return blob;
}

async function createThreeMfPackage({
  contentTypesXml,
  relationshipsXml,
  modelRelationshipsXml,
  rootModelXml,
  objectModelXml,
  modelSettingsConfig,
  sliceInfoConfig,
  projectSettingsConfig,
}: ThreeMfPackageParts): Promise<Blob> {
  const zipWriter = new ZipWriter(new BlobWriter('model/3mf'));
  await zipWriter.add('[Content_Types].xml', new TextReader(contentTypesXml));
  await zipWriter.add('_rels/.rels', new TextReader(relationshipsXml));
  await zipWriter.add(
    '3D/_rels/3dmodel.model.rels',
    new TextReader(modelRelationshipsXml),
  );
  await zipWriter.add('3D/3dmodel.model', new TextReader(rootModelXml));
  await zipWriter.add(BAMBU_OBJECT_MODEL_PATH, new TextReader(objectModelXml));
  await zipWriter.add(
    'Metadata/model_settings.config',
    new TextReader(modelSettingsConfig),
  );
  await zipWriter.add(
    'Metadata/slice_info.config',
    new TextReader(sliceInfoConfig),
  );
  await zipWriter.add(
    'Metadata/project_settings.config',
    new TextReader(projectSettingsConfig),
  );
  return zipWriter.close();
}

export async function validateThreeMfBlob(blob: Blob): Promise<void> {
  const zipReader = new ZipReader(new BlobReader(blob));

  try {
    const entries = await zipReader.getEntries();
    const entriesByName = new Map<string, ZipTextEntry>(
      entries.map((entry) => [entry.filename, entry as ZipTextEntry]),
    );

    const objectModelFilename = entriesByName.has(BAMBU_OBJECT_MODEL_PATH)
      ? BAMBU_OBJECT_MODEL_PATH
      : '3D/3dmodel.model';

    for (const filename of [
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
      'Metadata/project_settings.config',
    ]) {
      if (!entriesByName.has(filename)) {
        throw new Error(`3MF package is missing ${filename}`);
      }
    }

    const contentTypesXml = await readRequiredZipText(
      entriesByName,
      '[Content_Types].xml',
    );
    const relationshipsXml = await readRequiredZipText(
      entriesByName,
      '_rels/.rels',
    );
    const modelXml = await readRequiredZipText(
      entriesByName,
      '3D/3dmodel.model',
    );
    const objectModelXml =
      objectModelFilename === '3D/3dmodel.model'
        ? modelXml
        : await readRequiredZipText(entriesByName, objectModelFilename);
    const projectSettingsConfig = await readRequiredZipText(
      entriesByName,
      'Metadata/project_settings.config',
    );

    validateThreeMfPackageParts({
      contentTypesXml,
      relationshipsXml,
      modelRelationshipsXml: entriesByName.has('3D/_rels/3dmodel.model.rels')
        ? await readRequiredZipText(
            entriesByName,
            '3D/_rels/3dmodel.model.rels',
          )
        : '',
      rootModelXml: modelXml,
      objectModelXml,
      modelSettingsConfig: entriesByName.has('Metadata/model_settings.config')
        ? await readRequiredZipText(
            entriesByName,
            'Metadata/model_settings.config',
          )
        : '',
      sliceInfoConfig: entriesByName.has('Metadata/slice_info.config')
        ? await readRequiredZipText(entriesByName, 'Metadata/slice_info.config')
        : '',
      projectSettingsConfig,
    });
  } finally {
    await zipReader.close();
  }
}

export function analyzeThreeMfMeshTopology(
  modelXml: string,
  options: { weldTolerance?: number } = {},
): ThreeMfMeshTopology {
  const vertices: VectorTuple[] = [];
  for (const match of modelXml.matchAll(/<vertex\b([^>]*)\/>/g)) {
    const attributes = parseXmlAttributes(match[1]);
    vertices.push([
      Number.parseFloat(attributes.get('x') ?? '0'),
      Number.parseFloat(attributes.get('y') ?? '0'),
      Number.parseFloat(attributes.get('z') ?? '0'),
    ]);
  }

  const remappedVertices = remapTopologyVertices(
    vertices,
    options.weldTolerance,
  );
  const triangles: Array<{
    vertices: [number, number, number];
    materialIndex: number | null;
  }> = [];
  let invalidVertexReferenceCount = 0;
  let degenerateTriangleCount = 0;

  for (const match of modelXml.matchAll(/<triangle\b([^>]*)\/>/g)) {
    const attributes = parseXmlAttributes(match[1]);
    const rawVertexIndexes = ['v1', 'v2', 'v3'].map((name) =>
      Number.parseInt(attributes.get(name) ?? '', 10),
    );

    if (
      rawVertexIndexes.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || index >= vertices.length,
      )
    ) {
      invalidVertexReferenceCount += 1;
      continue;
    }

    const vertexIndexes = rawVertexIndexes.map(
      (index) => remappedVertices.vertexIndexes[index],
    ) as [number, number, number];
    if (new Set(vertexIndexes).size !== 3) {
      degenerateTriangleCount += 1;
    }

    triangles.push({
      vertices: vertexIndexes,
      materialIndex: Number.isInteger(
        Number.parseInt(attributes.get('p1') ?? '', 10),
      )
        ? Number.parseInt(attributes.get('p1') ?? '', 10)
        : null,
    });
  }

  const edgeUseCounts = new Map<string, number>();
  const edgeMaterialIndexes = new Map<string, Set<number>>();
  for (const triangle of triangles) {
    if (new Set(triangle.vertices).size !== 3) {
      continue;
    }

    for (const [a, b] of [
      [triangle.vertices[0], triangle.vertices[1]],
      [triangle.vertices[1], triangle.vertices[2]],
      [triangle.vertices[2], triangle.vertices[0]],
    ]) {
      const edgeKey = getEdgeKey(a, b);
      edgeUseCounts.set(edgeKey, (edgeUseCounts.get(edgeKey) ?? 0) + 1);
      if (triangle.materialIndex !== null) {
        const materialIndexes = edgeMaterialIndexes.get(edgeKey) ?? new Set();
        materialIndexes.add(triangle.materialIndex);
        edgeMaterialIndexes.set(edgeKey, materialIndexes);
      }
    }
  }

  const edgeUseHistogram: Record<number, number> = {};
  let boundaryEdges = 0;
  let overSharedEdges = 0;
  for (const count of edgeUseCounts.values()) {
    edgeUseHistogram[count] = (edgeUseHistogram[count] ?? 0) + 1;
    if (count === 1) {
      boundaryEdges += 1;
    } else if (count > 2) {
      overSharedEdges += 1;
    }
  }

  let materialTransitionEdges = 0;
  for (const materialIndexes of edgeMaterialIndexes.values()) {
    if (materialIndexes.size > 1) {
      materialTransitionEdges += 1;
    }
  }

  return {
    vertexCount: vertices.length,
    weldedVertexCount: remappedVertices.vertexCount,
    triangleCount: triangles.length,
    invalidVertexReferenceCount,
    degenerateTriangleCount,
    uniqueEdges: edgeUseCounts.size,
    edgeUseHistogram,
    boundaryEdges,
    overSharedEdges,
    materialTransitionEdges,
  };
}

function validateThreeMfPackageParts({
  contentTypesXml,
  relationshipsXml,
  modelRelationshipsXml,
  rootModelXml,
  objectModelXml,
  modelSettingsConfig,
  sliceInfoConfig,
  projectSettingsConfig,
}: ThreeMfPackageParts): void {
  if (
    !contentTypesXml.includes(
      'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    )
  ) {
    throw new Error('3MF package is missing the model content type');
  }

  if (!relationshipsXml.includes('Target="/3D/3dmodel.model"')) {
    throw new Error('3MF package is missing the 3D model relationship');
  }

  if (!rootModelXml.includes(`xmlns="${CORE_NAMESPACE}"`)) {
    throw new Error('3MF root model is missing the core namespace');
  }

  if (
    modelRelationshipsXml &&
    !modelRelationshipsXml.includes(`Target="${BAMBU_OBJECT_MODEL_REL_TARGET}"`)
  ) {
    throw new Error('3MF package is missing the Bambu object relationship');
  }

  if (modelSettingsConfig && !modelSettingsConfig.includes('<mesh_stat ')) {
    throw new Error('3MF package is missing Bambu model mesh stats');
  }

  if (sliceInfoConfig && !sliceInfoConfig.includes('X-BBL-Client-Version')) {
    throw new Error('3MF package is missing Bambu slice metadata');
  }

  if (!objectModelXml.includes(`xmlns="${CORE_NAMESPACE}"`)) {
    throw new Error('3MF model is missing the core namespace');
  }

  if (!objectModelXml.includes(`xmlns:m="${MATERIAL_NAMESPACE}"`)) {
    throw new Error('3MF model is missing the material namespace');
  }

  const resourceMaterialCounts = getMaterialResourceCounts(objectModelXml);
  const vertexCount = objectModelXml.match(/<vertex\b/g)?.length ?? 0;
  if (vertexCount === 0) {
    throw new Error('3MF model has no vertices');
  }

  const objectIds = new Set<string>();
  for (const match of objectModelXml.matchAll(/<object\b([^>]*)>/g)) {
    const attributes = parseXmlAttributes(match[1]);
    const objectId = attributes.get('id');
    if (objectId) {
      objectIds.add(objectId);
    }

    const pid = attributes.get('pid');
    const pindex = attributes.get('pindex');
    if (pid && pindex) {
      validateMaterialIndex(
        pid,
        Number.parseInt(pindex, 10),
        resourceMaterialCounts,
      );
    }
  }

  if (objectIds.size === 0) {
    throw new Error('3MF model has no object resources');
  }

  const rootObjectIds = new Set<string>();
  for (const match of rootModelXml.matchAll(/<object\b([^>]*)>/g)) {
    const objectId = parseXmlAttributes(match[1]).get('id');
    if (objectId) {
      rootObjectIds.add(objectId);
    }
  }

  for (const match of rootModelXml.matchAll(/<item\b([^>]*)\/>/g)) {
    const objectId = parseXmlAttributes(match[1]).get('objectid');
    if (!objectId || !rootObjectIds.has(objectId)) {
      throw new Error(
        `3MF build item references missing root object ${objectId}`,
      );
    }
  }

  let triangleCount = 0;
  for (const match of objectModelXml.matchAll(/<triangle\b([^>]*)\/>/g)) {
    triangleCount += 1;
    const attributes = parseXmlAttributes(match[1]);
    const vertexIndexes = ['v1', 'v2', 'v3'].map((name) =>
      Number.parseInt(attributes.get(name) ?? '', 10),
    );

    if (vertexIndexes.some((index) => !Number.isInteger(index))) {
      throw new Error('3MF triangle has an invalid vertex index');
    }

    if (new Set(vertexIndexes).size !== 3) {
      throw new Error('3MF triangle has duplicate vertex indexes');
    }

    for (const vertexIndex of vertexIndexes) {
      if (vertexIndex < 0 || vertexIndex >= vertexCount) {
        throw new Error(
          `3MF triangle vertex index ${vertexIndex} exceeds ${vertexCount} available vertices`,
        );
      }
    }

    const pid = attributes.get('pid');
    if (!pid) {
      throw new Error('3MF triangle is missing a material pid');
    }

    for (const name of ['p1', 'p2', 'p3']) {
      const materialIndex = Number.parseInt(attributes.get(name) ?? '', 10);
      validateMaterialIndex(pid, materialIndex, resourceMaterialCounts);
    }

    const materialIndex = Number.parseInt(attributes.get('p1') ?? '', 10);
    const paintColor = attributes.get('paint_color');
    const expectedPaintColor = getBambuOrcaPaintColor(materialIndex);
    if (paintColor !== expectedPaintColor) {
      throw new Error(
        `3MF triangle paint_color ${paintColor} does not match material slot ${expectedPaintColor}`,
      );
    }
  }

  if (triangleCount === 0) {
    throw new Error('3MF model has no triangles');
  }

  validateProjectSettingsColors(projectSettingsConfig, objectModelXml);
}

async function readRequiredZipText(
  entriesByName: Map<string, ZipTextEntry>,
  filename: string,
): Promise<string> {
  const entry = entriesByName.get(filename);
  if (!entry?.getData) {
    throw new Error(`3MF package entry ${filename} cannot be read`);
  }

  return entry.getData(new TextWriter());
}

function extractSceneGeometry(scene: THREE.Scene): SceneGeometry {
  const vertices: VectorTuple[] = [];
  const triangles: SceneGeometry['triangles'] = [];
  const vertexMap = new Map<string, number>();

  scene.updateMatrixWorld(true);
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.geometry.attributes.position) {
      return;
    }

    const geometry = node.geometry;
    const position = geometry.attributes.position;
    const colorAttribute = geometry.attributes.color;
    const uvAttribute = geometry.attributes.uv;
    const matrixWorld = node.matrixWorld;
    const materials = Array.isArray(node.material)
      ? node.material
      : [node.material];
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: getIndexCount(geometry), materialIndex: 0 }];

    const getOrCreateVertexIndex = (sourceIndex: number): number => {
      const vertex = readWorldVertex(position, sourceIndex, matrixWorld);
      const key = getVertexKey(vertex);
      const existingIndex = vertexMap.get(key);

      if (existingIndex !== undefined) {
        return existingIndex;
      }

      const vertexIndex = vertices.length;
      vertices.push(vertex);
      vertexMap.set(key, vertexIndex);
      return vertexIndex;
    };

    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0] ?? materials[0];
      const end = group.start + group.count;

      for (let offset = group.start; offset + 2 < end; offset += 3) {
        const a = getVertexIndex(geometry, offset);
        const b = getVertexIndex(geometry, offset + 1);
        const c = getVertexIndex(geometry, offset + 2);
        const v1 = getOrCreateVertexIndex(a);
        const v2 = getOrCreateVertexIndex(b);
        const v3 = getOrCreateVertexIndex(c);

        if (v1 === v2 || v2 === v3 || v1 === v3) {
          continue;
        }

        const triangleColor = sampleTriangleColor({
          material,
          colorAttribute,
          uvAttribute,
          vertexIndices: [a, b, c],
        });

        triangles.push({
          v1,
          v2,
          v3,
          color: triangleColor,
        });
      }
    }
  });

  return { vertices, triangles };
}

function repairSceneGeometryForThreeMfExport(
  geometry: SceneGeometry,
): RepairedSceneGeometry {
  const keptTriangleIndexes = new Set<number>();

  // Group non-degenerate triangles by their unordered vertex set. CSG unions
  // and AI-generated meshes routinely emit multiple coincident triangles on
  // the same three vertices — typically internal walls between solids, where
  // each side contributes a copy with opposite winding. Cancelling even
  // counts and keeping a single triangle for odd counts removes the
  // zero-volume sandwiches that Bambu Studio flags as non-manifold edges.
  const vertexSetGroups = new Map<string, number[]>();
  geometry.triangles.forEach((triangle, triangleIndex) => {
    if (isDegenerateTriangle(triangle, geometry.vertices)) {
      return;
    }
    const key = [triangle.v1, triangle.v2, triangle.v3]
      .sort((a, b) => a - b)
      .join('-');
    const group = vertexSetGroups.get(key) ?? [];
    group.push(triangleIndex);
    vertexSetGroups.set(key, group);
  });

  for (const group of vertexSetGroups.values()) {
    if (group.length % 2 === 1) {
      keptTriangleIndexes.add(group[0]);
    }
  }

  const edgeToTriangleIndexes = new Map<string, number[]>();
  for (const triangleIndex of keptTriangleIndexes) {
    const triangle = geometry.triangles[triangleIndex];
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = getEdgeKey(a, b);
      const triangleIndexes = edgeToTriangleIndexes.get(key) ?? [];
      triangleIndexes.push(triangleIndex);
      edgeToTriangleIndexes.set(key, triangleIndexes);
    }
  }

  for (const triangleIndexes of edgeToTriangleIndexes.values()) {
    const currentlyKeptTriangleIndexes = triangleIndexes.filter(
      (triangleIndex) => keptTriangleIndexes.has(triangleIndex),
    );

    if (currentlyKeptTriangleIndexes.length <= 2) {
      continue;
    }

    for (const triangleIndex of currentlyKeptTriangleIndexes.slice(2)) {
      keptTriangleIndexes.delete(triangleIndex);
    }
  }

  const repairedTriangles = geometry.triangles
    .filter((_, index) => keptTriangleIndexes.has(index))
    .map(({ v1, v2, v3 }) => ({ v1, v2, v3 }));
  return compactSceneGeometry({
    vertices: geometry.vertices,
    triangles: repairedTriangles,
  });
}

function compactSceneGeometry(
  geometry: RepairedSceneGeometry,
): RepairedSceneGeometry {
  const vertexRemap = new Map<number, number>();
  const vertices: VectorTuple[] = [];
  const triangles = geometry.triangles.map((triangle) => ({
    v1: remapVertexIndex(triangle.v1, vertexRemap, vertices, geometry.vertices),
    v2: remapVertexIndex(triangle.v2, vertexRemap, vertices, geometry.vertices),
    v3: remapVertexIndex(triangle.v3, vertexRemap, vertices, geometry.vertices),
  }));

  return { vertices, triangles };
}

function assignColorsToRepairedTriangles(
  repairedGeometry: RepairedSceneGeometry,
  sourceGeometry: SceneGeometry,
): SceneGeometry['triangles'] {
  const sourceTrianglesByGeometry = new Map<
    string,
    SceneGeometry['triangles']
  >();
  sourceGeometry.triangles.forEach((triangle) => {
    const key = getTriangleGeometryKey(sourceGeometry.vertices, triangle);
    const sourceTriangles = sourceTrianglesByGeometry.get(key) ?? [];
    sourceTriangles.push(triangle);
    sourceTrianglesByGeometry.set(key, sourceTriangles);
  });

  return repairedGeometry.triangles.map((triangle) => {
    const exactSourceTriangles = sourceTrianglesByGeometry.get(
      getTriangleGeometryKey(repairedGeometry.vertices, triangle),
    );
    const color = exactSourceTriangles?.length
      ? getDominantTriangleColor(exactSourceTriangles)
      : getNearestTriangleColor(
          triangle,
          repairedGeometry.vertices,
          sourceGeometry,
        );

    return {
      ...triangle,
      color,
    };
  });
}

function getDominantTriangleColor(
  triangles: SceneGeometry['triangles'],
): THREE.Color {
  const countsByColor = new Map<
    string,
    { color: THREE.Color; count: number; firstIndex: number }
  >();

  triangles.forEach((triangle, index) => {
    const colorKey = colorToHex(triangle.color);
    const existing = countsByColor.get(colorKey);
    if (existing) {
      existing.count += 1;
      return;
    }

    countsByColor.set(colorKey, {
      color: triangle.color,
      count: 1,
      firstIndex: index,
    });
  });

  const dominant = [...countsByColor.values()].sort(
    (a, b) => b.count - a.count || a.firstIndex - b.firstIndex,
  )[0];
  return dominant.color.clone();
}

function getNearestTriangleColor(
  triangle: RepairedSceneGeometry['triangles'][number],
  vertices: VectorTuple[],
  sourceGeometry: SceneGeometry,
): THREE.Color {
  const centroid = getTriangleCentroid(vertices, triangle);
  let nearestTriangle = sourceGeometry.triangles[0];
  let nearestDistance = Number.POSITIVE_INFINITY;

  sourceGeometry.triangles.forEach((sourceTriangle) => {
    const sourceCentroid = getTriangleCentroid(
      sourceGeometry.vertices,
      sourceTriangle,
    );
    const distance = centroid.distanceToSquared(sourceCentroid);
    if (distance < nearestDistance) {
      nearestTriangle = sourceTriangle;
      nearestDistance = distance;
    }
  });

  return nearestTriangle.color.clone();
}

function smoothTriangleColorIndexes(
  triangles: ThreeMfTriangle[],
  palette: THREE.Color[],
): ThreeMfTriangle[] {
  if (triangles.length === 0 || palette.length <= 1) {
    return triangles;
  }

  const adjacency = buildTriangleAdjacency(triangles);
  const colorIndexes = triangles.map((triangle) => triangle.colorIndex);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    let changed = false;
    const components = getSameColorTriangleComponents(colorIndexes, adjacency);

    for (const component of components) {
      if (
        component.triangleIndexes.length > SMALL_COLOR_ISLAND_TRIANGLE_COUNT
      ) {
        continue;
      }

      const neighborCounts = new Map<number, number>();
      for (const triangleIndex of component.triangleIndexes) {
        for (const neighborIndex of adjacency[triangleIndex]) {
          const neighborColorIndex = colorIndexes[neighborIndex];
          if (neighborColorIndex !== component.colorIndex) {
            neighborCounts.set(
              neighborColorIndex,
              (neighborCounts.get(neighborColorIndex) ?? 0) + 1,
            );
          }
        }
      }

      const replacement = [...neighborCounts.entries()].sort(
        (a, b) => b[1] - a[1],
      )[0];
      if (!replacement) {
        continue;
      }

      const [replacementColorIndex] = replacement;
      if (
        colorDistanceSquared(
          palette[component.colorIndex],
          palette[replacementColorIndex],
        ) > SIMILAR_COLOR_ISLAND_DISTANCE_SQUARED
      ) {
        continue;
      }

      for (const triangleIndex of component.triangleIndexes) {
        colorIndexes[triangleIndex] = replacementColorIndex;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return triangles.map((triangle, index) => ({
    ...triangle,
    colorIndex: colorIndexes[index],
  }));
}

function removeUnusedPaletteEntries(
  palette: THREE.Color[],
  triangles: ThreeMfTriangle[],
): { palette: THREE.Color[]; triangles: ThreeMfTriangle[] } {
  const usedIndexes = [
    ...new Set(triangles.map((triangle) => triangle.colorIndex)),
  ].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  usedIndexes.forEach((sourceIndex, targetIndex) => {
    remap.set(sourceIndex, targetIndex);
  });

  return {
    palette: usedIndexes.map((index) => palette[index].clone()),
    triangles: triangles.map((triangle) => ({
      ...triangle,
      colorIndex: remap.get(triangle.colorIndex) ?? 0,
    })),
  };
}

function buildTriangleAdjacency(
  triangles: Array<Omit<ThreeMfTriangle, 'colorIndex'>>,
): number[][] {
  const edgeToTriangleIndexes = new Map<string, number[]>();
  triangles.forEach((triangle, triangleIndex) => {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const edgeKey = getEdgeKey(a, b);
      const triangleIndexes = edgeToTriangleIndexes.get(edgeKey) ?? [];
      triangleIndexes.push(triangleIndex);
      edgeToTriangleIndexes.set(edgeKey, triangleIndexes);
    }
  });

  const adjacency = Array.from(
    { length: triangles.length },
    () => new Set<number>(),
  );
  for (const triangleIndexes of edgeToTriangleIndexes.values()) {
    for (const triangleIndex of triangleIndexes) {
      for (const neighborIndex of triangleIndexes) {
        if (triangleIndex !== neighborIndex) {
          adjacency[triangleIndex].add(neighborIndex);
        }
      }
    }
  }

  return adjacency.map((neighbors) => [...neighbors]);
}

function getSameColorTriangleComponents(
  colorIndexes: number[],
  adjacency: number[][],
): Array<{ colorIndex: number; triangleIndexes: number[] }> {
  const visited = new Set<number>();
  const components: Array<{ colorIndex: number; triangleIndexes: number[] }> =
    [];

  for (
    let triangleIndex = 0;
    triangleIndex < colorIndexes.length;
    triangleIndex += 1
  ) {
    if (visited.has(triangleIndex)) {
      continue;
    }

    const colorIndex = colorIndexes[triangleIndex];
    const component = { colorIndex, triangleIndexes: [] as number[] };
    const stack = [triangleIndex];
    visited.add(triangleIndex);

    while (stack.length > 0) {
      const currentIndex = stack.pop() as number;
      component.triangleIndexes.push(currentIndex);

      for (const neighborIndex of adjacency[currentIndex]) {
        if (
          !visited.has(neighborIndex) &&
          colorIndexes[neighborIndex] === colorIndex
        ) {
          visited.add(neighborIndex);
          stack.push(neighborIndex);
        }
      }
    }

    components.push(component);
  }

  return components;
}

function colorDistanceSquared(a: THREE.Color, b: THREE.Color): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

function isDegenerateTriangle(
  triangle: SceneGeometry['triangles'][number],
  vertices: VectorTuple[],
): boolean {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];

  if (!a || !b || !c) {
    return true;
  }

  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  return ab.cross(ac).lengthSq() <= DEGENERATE_TRIANGLE_AREA_SQUARED;
}

function sampleTriangleColor({
  material,
  colorAttribute,
  uvAttribute,
  vertexIndices,
}: {
  material: THREE.Material;
  colorAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  uvAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  vertexIndices: [number, number, number];
}): THREE.Color {
  const materialColor = getMaterialColor(material);
  const textureColor = sampleTextureColor(material, uvAttribute, vertexIndices);
  const vertexColor = sampleVertexColor(colorAttribute, vertexIndices);

  if (textureColor && vertexColor) {
    return textureColor.multiply(vertexColor).multiply(materialColor);
  }

  if (textureColor) {
    return textureColor.multiply(materialColor);
  }

  if (vertexColor) {
    return vertexColor.multiply(materialColor);
  }

  return materialColor;
}

function sampleTextureColor(
  material: THREE.Material,
  uvAttribute:
    | THREE.BufferAttribute
    | THREE.InterleavedBufferAttribute
    | undefined,
  vertexIndices: [number, number, number],
): THREE.Color | null {
  if (!uvAttribute || !('map' in material)) {
    return null;
  }

  const texture = material.map;
  if (!(texture instanceof THREE.Texture)) {
    return null;
  }

  const pixels = getTexturePixels(texture);
  if (!pixels) {
    return null;
  }

  try {
    const uv = new THREE.Vector2();
    for (const vertexIndex of vertexIndices) {
      uv.x += uvAttribute.getX(vertexIndex);
      uv.y += uvAttribute.getY(vertexIndex);
    }
    uv.multiplyScalar(1 / vertexIndices.length);

    const wrapU = wrapTextureCoordinate(uv.x);
    const wrapV = wrapTextureCoordinate(uv.y);
    const x = Math.min(
      pixels.width - 1,
      Math.max(0, Math.floor(wrapU * pixels.width)),
    );
    const y = Math.min(
      pixels.height - 1,
      Math.max(0, Math.floor((1 - wrapV) * pixels.height)),
    );
    const offset = (y * pixels.width + x) * 4;
    return new THREE.Color(
      pixels.data[offset] / 255,
      pixels.data[offset + 1] / 255,
      pixels.data[offset + 2] / 255,
    );
  } catch {
    return null;
  }
}

function getTexturePixels(texture: THREE.Texture): TexturePixels | null {
  if (texturePixelCache.has(texture)) {
    return texturePixelCache.get(texture) ?? null;
  }

  const image = texture.image as
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageBitmap
    | undefined;
  if (!image || !('width' in image) || !('height' in image)) {
    texturePixelCache.set(texture, null);
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    texturePixelCache.set(texture, null);
    return null;
  }

  try {
    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, image.width, image.height);
    const pixels = {
      data: imageData.data,
      width: image.width,
      height: image.height,
    };
    texturePixelCache.set(texture, pixels);
    return pixels;
  } catch {
    texturePixelCache.set(texture, null);
    return null;
  }
}

function sampleVertexColor(
  colorAttribute:
    | THREE.BufferAttribute
    | THREE.InterleavedBufferAttribute
    | undefined,
  vertexIndices: [number, number, number],
): THREE.Color | null {
  if (!colorAttribute) {
    return null;
  }

  const color = new THREE.Color();
  for (const vertexIndex of vertexIndices) {
    color.r += colorAttribute.getX(vertexIndex);
    color.g += colorAttribute.getY(vertexIndex);
    color.b += colorAttribute.getZ(vertexIndex);
  }

  color.multiplyScalar(1 / vertexIndices.length);
  return color;
}

function getMaterialColor(material: THREE.Material): THREE.Color {
  if ('color' in material && material.color instanceof THREE.Color) {
    return material.color.clone();
  }

  return new THREE.Color(0.8, 0.8, 0.8);
}

function quantizeTriangleColors(
  samples: ColorSample[],
  colorCount: number,
): THREE.Color[] {
  if (samples.length === 0) {
    return [new THREE.Color(0.8, 0.8, 0.8)];
  }

  const uniqueColors = dedupeColors(samples.map((sample) => sample.color));
  if (uniqueColors.length <= colorCount) {
    return uniqueColors;
  }

  const sortedColors = uniqueColors
    .slice()
    .sort((a, b) => perceivedBrightness(a) - perceivedBrightness(b));
  const centroids = Array.from({ length: colorCount }, (_, index) => {
    const sourceIndex =
      colorCount === 1
        ? Math.floor(sortedColors.length / 2)
        : Math.round((index * (sortedColors.length - 1)) / (colorCount - 1));
    return sortedColors[sourceIndex].clone();
  });

  while (centroids.length < colorCount) {
    centroids.push(uniqueColors[centroids.length].clone());
  }

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const buckets = centroids.map(() => ({
      color: new THREE.Color(0, 0, 0),
      weight: 0,
    }));

    for (const sample of samples) {
      const index = findNearestPaletteIndex(sample.color, centroids);
      buckets[index].color.r += sample.color.r * sample.weight;
      buckets[index].color.g += sample.color.g * sample.weight;
      buckets[index].color.b += sample.color.b * sample.weight;
      buckets[index].weight += sample.weight;
    }

    buckets.forEach((bucket, index) => {
      if (bucket.weight > 0) {
        centroids[index].setRGB(
          bucket.color.r / bucket.weight,
          bucket.color.g / bucket.weight,
          bucket.color.b / bucket.weight,
        );
      }
    });
  }

  return centroids;
}

function dedupeColors(colors: THREE.Color[]): THREE.Color[] {
  const byHex = new Map<string, THREE.Color>();
  colors.forEach((color) => {
    byHex.set(colorToHex(color), color.clone());
  });
  return [...byHex.values()];
}

function findNearestPaletteIndex(
  color: THREE.Color,
  palette: THREE.Color[],
): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  palette.forEach((paletteColor, index) => {
    const distance =
      (color.r - paletteColor.r) ** 2 +
      (color.g - paletteColor.g) ** 2 +
      (color.b - paletteColor.b) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

function perceivedBrightness(color: THREE.Color): number {
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

function colorToHex(color: THREE.Color): string {
  return `#${color.getHexString().toUpperCase()}`;
}

function getBambuOrcaPaintColor(colorIndex: number): string {
  return (
    BAMBU_ORCA_FILAMENT_SLOT_CODES[
      clampIndex(colorIndex, BAMBU_ORCA_FILAMENT_SLOT_CODES.length)
    ] ?? BAMBU_ORCA_FILAMENT_SLOT_CODES[0]
  );
}

function normalizePalette(palette: string[]): string[] {
  const normalized = palette
    .map((color) => color.trim().toUpperCase())
    .filter((color) => /^#[0-9A-F]{6}$/.test(color));

  return normalized.length > 0 ? normalized : ['#CCCCCC'];
}

function getMaterialResourceCounts(modelXml: string): Map<string, number> {
  const resourceMaterialCounts = new Map<string, number>();

  for (const match of modelXml.matchAll(
    /<basematerials\b([^>]*)>([\s\S]*?)<\/basematerials>/g,
  )) {
    const id = parseXmlAttributes(match[1]).get('id');
    if (id) {
      resourceMaterialCounts.set(id, match[2].match(/<base\b/g)?.length ?? 0);
    }
  }

  for (const match of modelXml.matchAll(
    /<m:colorgroup\b([^>]*)>([\s\S]*?)<\/m:colorgroup>/g,
  )) {
    const id = parseXmlAttributes(match[1]).get('id');
    if (id) {
      resourceMaterialCounts.set(
        id,
        match[2].match(/<m:color\b/g)?.length ?? 0,
      );
    }
  }

  return resourceMaterialCounts;
}

function validateMaterialIndex(
  pid: string,
  materialIndex: number,
  resourceMaterialCounts: Map<string, number>,
): void {
  if (!Number.isInteger(materialIndex) || materialIndex < 0) {
    throw new Error(`3MF triangle has invalid material index ${materialIndex}`);
  }

  const materialCount = resourceMaterialCounts.get(pid);
  if (materialCount === undefined) {
    throw new Error(`3MF triangle references missing material resource ${pid}`);
  }

  if (materialIndex >= materialCount) {
    throw new Error(
      `3MF triangle material index ${materialIndex} exceeds ${materialCount} available materials`,
    );
  }
}

function validateProjectSettingsColors(
  projectSettingsConfig: string,
  modelXml: string,
): void {
  const projectSettings = JSON.parse(projectSettingsConfig) as {
    filament_colour?: unknown;
    [key: string]: unknown;
  };

  if (!Array.isArray(projectSettings.filament_colour)) {
    throw new Error('3MF project settings are missing filament_colour');
  }

  const baseColors = [
    ...modelXml.matchAll(/displaycolor="(#[0-9A-Fa-f]{6})/g),
  ].map((match) => match[1].toUpperCase());
  const filamentColors = projectSettings.filament_colour.map((color) =>
    typeof color === 'string' ? color.toUpperCase() : '',
  );

  if (baseColors.length !== filamentColors.length) {
    throw new Error(
      '3MF project settings color count does not match materials',
    );
  }

  baseColors.forEach((color, index) => {
    if (filamentColors[index] !== color) {
      throw new Error(
        `3MF project settings color ${filamentColors[index]} does not match material ${color}`,
      );
    }
  });

  for (const key of [
    'default_filament_colour',
    'filament_type',
    'filament_settings_id',
    'filament_vendor',
    'filament_diameter',
    'filament_density',
    'filament_cost',
    'filament_ids',
    'filament_is_support',
    'filament_soluble',
    'filament_minimal_purge_on_wipe_tower',
    'filament_start_gcode',
    'filament_end_gcode',
    'filament_max_volumetric_speed',
    'filament_flow_ratio',
    'nozzle_temperature',
    'nozzle_temperature_initial_layer',
    'nozzle_temperature_range_high',
    'nozzle_temperature_range_low',
  ]) {
    const value = projectSettings[key];
    if (!Array.isArray(value) || value.length !== filamentColors.length) {
      throw new Error(
        `3MF project settings ${key} count does not match materials`,
      );
    }
  }
}

function parseXmlAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(
    /([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g,
  )) {
    attributes.set(match[1], match[2]);
  }
  return attributes;
}

function readWorldVertex(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  matrixWorld: THREE.Matrix4,
): VectorTuple {
  const vertex = new THREE.Vector3(
    position.getX(index),
    position.getY(index),
    position.getZ(index),
  );
  vertex.applyMatrix4(matrixWorld);
  return [vertex.x, vertex.y, vertex.z];
}

function getVertexKey([x, y, z]: VectorTuple): string {
  return [
    Math.round(x / VERTEX_KEY_PRECISION),
    Math.round(y / VERTEX_KEY_PRECISION),
    Math.round(z / VERTEX_KEY_PRECISION),
  ].join(',');
}

function getTriangleGeometryKey(
  vertices: VectorTuple[],
  triangle: Omit<ThreeMfTriangle, 'colorIndex'>,
): string {
  return [triangle.v1, triangle.v2, triangle.v3]
    .map((index) => getVertexKey(vertices[index]))
    .sort()
    .join('|');
}

function getTriangleCentroid(
  vertices: VectorTuple[],
  triangle: Omit<ThreeMfTriangle, 'colorIndex'>,
): THREE.Vector3 {
  const a = vertices[triangle.v1];
  const b = vertices[triangle.v2];
  const c = vertices[triangle.v3];

  return new THREE.Vector3(
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  );
}

function remapTopologyVertices(
  vertices: VectorTuple[],
  weldTolerance = 0,
): { vertexIndexes: number[]; vertexCount: number } {
  if (weldTolerance <= 0) {
    return {
      vertexIndexes: vertices.map((_, index) => index),
      vertexCount: vertices.length,
    };
  }

  const vertexIndexes: number[] = [];
  const weldedVertexIndexes = new Map<string, number>();
  for (const vertex of vertices) {
    const key = vertex
      .map((value) => Math.floor(value / weldTolerance))
      .join(',');
    let weldedIndex = weldedVertexIndexes.get(key);
    if (weldedIndex === undefined) {
      weldedIndex = weldedVertexIndexes.size;
      weldedVertexIndexes.set(key, weldedIndex);
    }
    vertexIndexes.push(weldedIndex);
  }

  return {
    vertexIndexes,
    vertexCount: weldedVertexIndexes.size,
  };
}

function getEdgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function remapVertexIndex(
  sourceIndex: number,
  vertexRemap: Map<number, number>,
  vertices: VectorTuple[],
  sourceVertices: VectorTuple[],
): number {
  const existingIndex = vertexRemap.get(sourceIndex);
  if (existingIndex !== undefined) {
    return existingIndex;
  }

  const vertexIndex = vertices.length;
  vertexRemap.set(sourceIndex, vertexIndex);
  vertices.push(sourceVertices[sourceIndex]);
  return vertexIndex;
}

function getIndexCount(geometry: THREE.BufferGeometry): number {
  return geometry.index?.count ?? geometry.attributes.position.count;
}

function getVertexIndex(
  geometry: THREE.BufferGeometry,
  offset: number,
): number {
  return geometry.index ? geometry.index.getX(offset) : offset;
}

function wrapTextureCoordinate(value: number): number {
  return ((value % 1) + 1) % 1;
}

function clampIndex(value: number, length: number): number {
  return Math.min(Math.max(0, value), Math.max(0, length - 1));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return Number.parseFloat(value.toFixed(6)).toString();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlDeclaration(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${content}`;
}
