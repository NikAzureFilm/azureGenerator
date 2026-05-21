import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import * as THREE from 'three';

export const DEFAULT_THREE_MF_COLOR_COUNT = 4;
export const MAX_THREE_MF_COLOR_COUNT = 16;

const CORE_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types';

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
  <Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`);
}

export function buildThreeMfRelationshipsXml(): string {
  return xmlDeclaration(`\
<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
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
  const multiProperties = normalizedPalette
    .map((_, index) => `      <m:multi pindices="${index} ${index}"/>`)
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
      return `        <triangle v1="${triangle.v1}" v2="${triangle.v2}" v3="${triangle.v3}" pid="3" p1="${colorIndex}" p2="${colorIndex}" p3="${colorIndex}"/>`;
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
    <m:multiproperties id="3" pids="1 2">
${multiProperties}
    </m:multiproperties>
    <object id="4" type="model" pid="3" pindex="0">
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
  <build>
    <item objectid="4"/>
  </build>
</model>`);
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
  const geometry = extractSceneGeometry(scene);

  if (geometry.vertices.length === 0 || geometry.triangles.length === 0) {
    throw new Error('No printable mesh geometry was found for 3MF export.');
  }

  const palette = quantizeTriangleColors(
    geometry.triangles.map((triangle) => ({
      color: triangle.color,
      weight: 1,
    })),
    targetColorCount,
  );

  const triangles = geometry.triangles.map((triangle) => ({
    v1: triangle.v1,
    v2: triangle.v2,
    v3: triangle.v3,
    colorIndex: findNearestPaletteIndex(triangle.color, palette),
  }));

  const modelXml = buildThreeMfModelXml({
    modelName: filename,
    vertices: geometry.vertices,
    triangles,
    palette: palette.map(colorToHex),
  });

  return createThreeMfPackage({
    contentTypesXml: buildThreeMfContentTypesXml(),
    relationshipsXml: buildThreeMfRelationshipsXml(),
    modelXml,
  });
}

async function createThreeMfPackage({
  contentTypesXml,
  relationshipsXml,
  modelXml,
}: {
  contentTypesXml: string;
  relationshipsXml: string;
  modelXml: string;
}): Promise<Blob> {
  const zipWriter = new ZipWriter(new BlobWriter('model/3mf'));
  await zipWriter.add('[Content_Types].xml', new TextReader(contentTypesXml));
  await zipWriter.add('_rels/.rels', new TextReader(relationshipsXml));
  await zipWriter.add('3D/3dmodel.model', new TextReader(modelXml));
  return zipWriter.close();
}

function extractSceneGeometry(scene: THREE.Scene): SceneGeometry {
  const vertices: VectorTuple[] = [];
  const triangles: SceneGeometry['triangles'] = [];

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

    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0] ?? materials[0];
      const end = group.start + group.count;

      for (let offset = group.start; offset + 2 < end; offset += 3) {
        const a = getVertexIndex(geometry, offset);
        const b = getVertexIndex(geometry, offset + 1);
        const c = getVertexIndex(geometry, offset + 2);
        const triangleVertices = [a, b, c].map((index) =>
          readWorldVertex(position, index, matrixWorld),
        );
        const triangleColor = sampleTriangleColor({
          material,
          colorAttribute,
          uvAttribute,
          vertexIndices: [a, b, c],
        });
        const firstVertexIndex = vertices.length;

        vertices.push(...triangleVertices);
        triangles.push({
          v1: firstVertexIndex,
          v2: firstVertexIndex + 1,
          v3: firstVertexIndex + 2,
          color: triangleColor,
        });
      }
    }
  });

  return { vertices, triangles };
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

function normalizePalette(palette: string[]): string[] {
  const normalized = palette
    .map((color) => color.trim().toUpperCase())
    .filter((color) => /^#[0-9A-F]{6}$/.test(color));

  return normalized.length > 0 ? normalized : ['#CCCCCC'];
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
