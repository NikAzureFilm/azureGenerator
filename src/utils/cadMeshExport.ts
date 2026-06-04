import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

export type VectorTuple = [number, number, number];
export type FaceTuple = [number, number, number];

export interface TriangleMesh {
  vertices: VectorTuple[];
  faces: FaceTuple[];
}

const ZERO_EPSILON = 1e-9;

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < ZERO_EPSILON) return 0;
  return Number(value.toFixed(6));
}

function formatNumber(value: number): string {
  return normalizeNumber(value).toString();
}

function coordinateKey(vertex: VectorTuple): string {
  return vertex.map(formatNumber).join(',');
}

function subtract(a: VectorTuple, b: VectorTuple): VectorTuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: VectorTuple, b: VectorTuple): VectorTuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vectorLength(vector: VectorTuple): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalizeVector(vector: VectorTuple): VectorTuple {
  const length = vectorLength(vector);
  if (length < ZERO_EPSILON) return [0, 0, 0];
  return [
    normalizeNumber(vector[0] / length),
    normalizeNumber(vector[1] / length),
    normalizeNumber(vector[2] / length),
  ];
}

function faceNormal(a: VectorTuple, b: VectorTuple, c: VectorTuple) {
  return normalizeVector(cross(subtract(b, a), subtract(c, a)));
}

function isDegenerateFace(a: VectorTuple, b: VectorTuple, c: VectorTuple) {
  return vectorLength(cross(subtract(b, a), subtract(c, a))) < ZERO_EPSILON;
}

function sanitizeObjName(name: string): string {
  return (
    name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'cad_model'
  );
}

function escapeStepString(value: string): string {
  const withoutControlCharacters = Array.from(value, (character) =>
    character < ' ' ? ' ' : character,
  ).join('');
  return withoutControlCharacters.replace(/'/g, "''");
}

function tuple(values: VectorTuple): string {
  return `(${values.map(formatNumber).join(',')})`;
}

export function geometryToTriangleMesh(
  geometry: THREE.BufferGeometry,
): TriangleMesh {
  const position = geometry.getAttribute('position');
  if (!position) {
    throw new Error('Cannot export CAD mesh without position data.');
  }

  const vertices: VectorTuple[] = [];
  const vertexIndexByKey = new Map<string, number>();

  const addVertex = (sourceIndex: number): number => {
    const vertex: VectorTuple = [
      normalizeNumber(position.getX(sourceIndex)),
      normalizeNumber(position.getY(sourceIndex)),
      normalizeNumber(position.getZ(sourceIndex)),
    ];
    const key = coordinateKey(vertex);
    const existingIndex = vertexIndexByKey.get(key);
    if (existingIndex !== undefined) return existingIndex;

    const nextIndex = vertices.length;
    vertices.push(vertex);
    vertexIndexByKey.set(key, nextIndex);
    return nextIndex;
  };

  const faces: FaceTuple[] = [];
  const appendFace = (aSource: number, bSource: number, cSource: number) => {
    const a = addVertex(aSource);
    const b = addVertex(bSource);
    const c = addVertex(cSource);
    if (a === b || b === c || a === c) return;
    if (isDegenerateFace(vertices[a], vertices[b], vertices[c])) return;
    faces.push([a, b, c]);
  };

  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      appendFace(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    }
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) {
      appendFace(i, i + 1, i + 2);
    }
  }

  if (faces.length === 0) {
    throw new Error('Cannot export CAD mesh without triangle faces.');
  }

  return { vertices, faces };
}

export function triangleMeshToOBJ(mesh: TriangleMesh, name: string): string {
  const lines = [
    '# AzureFilm Generator OBJ export',
    `o ${sanitizeObjName(name)}`,
    ...mesh.vertices.map(
      (vertex) =>
        `v ${formatNumber(vertex[0])} ${formatNumber(vertex[1])} ${formatNumber(vertex[2])}`,
    ),
    ...mesh.faces.map(
      (face) => `f ${face[0] + 1} ${face[1] + 1} ${face[2] + 1}`,
    ),
  ];

  return `${lines.join('\n')}\n`;
}

export function triangleMeshToFacetedSTEP(
  mesh: TriangleMesh,
  name: string,
): string {
  const entities: string[] = [];
  const next = (entity: string) => {
    const id = entities.length + 1;
    entities.push(`#${id}=${entity};`);
    return id;
  };

  const appContext = next("APPLICATION_CONTEXT('automotive design')");
  const protocol = next(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`,
  );
  const productContext = next(
    `PRODUCT_CONTEXT('',#${appContext},'mechanical')`,
  );
  const product = next(
    `PRODUCT('${escapeStepString(name)}','${escapeStepString(name)}','',(#${productContext}))`,
  );
  const productFormation = next(
    `PRODUCT_DEFINITION_FORMATION('','',#${product})`,
  );
  const productDefinitionContext = next(
    `PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`,
  );
  const productDefinition = next(
    `PRODUCT_DEFINITION('','',#${productFormation},#${productDefinitionContext})`,
  );
  const productShape = next(
    `PRODUCT_DEFINITION_SHAPE('','',#${productDefinition})`,
  );

  const pointIds = mesh.vertices.map((vertex) =>
    next(`CARTESIAN_POINT('',${tuple(vertex)})`),
  );
  const vertexPointIds = pointIds.map((pointId) =>
    next(`VERTEX_POINT('',#${pointId})`),
  );
  const edgeCurves = new Map<
    string,
    { edgeCurveId: number; startIndex: number; endIndex: number }
  >();

  const getEdgeCurve = (fromIndex: number, toIndex: number) => {
    const startIndex = Math.min(fromIndex, toIndex);
    const endIndex = Math.max(fromIndex, toIndex);
    const key = `${startIndex}:${endIndex}`;
    const existingEdge = edgeCurves.get(key);
    if (existingEdge) {
      return {
        edgeCurveId: existingEdge.edgeCurveId,
        orientation: fromIndex === existingEdge.startIndex,
      };
    }

    const start = mesh.vertices[startIndex];
    const end = mesh.vertices[endIndex];
    const edgeVector = subtract(end, start);
    const edgeLength = vectorLength(edgeVector);
    if (edgeLength < ZERO_EPSILON) {
      throw new Error('Cannot export STEP with zero-length edges.');
    }

    const directionId = next(
      `DIRECTION('',${tuple(normalizeVector(edgeVector))})`,
    );
    const vectorId = next(
      `VECTOR('',#${directionId},${formatNumber(edgeLength)})`,
    );
    const lineId = next(`LINE('',#${pointIds[startIndex]},#${vectorId})`);
    const edgeCurveId = next(
      `EDGE_CURVE('',#${vertexPointIds[startIndex]},#${vertexPointIds[endIndex]},#${lineId},.T.)`,
    );

    edgeCurves.set(key, { edgeCurveId, startIndex, endIndex });

    return {
      edgeCurveId,
      orientation: fromIndex === startIndex,
    };
  };

  const faceIds: number[] = [];
  for (const [aIndex, bIndex, cIndex] of mesh.faces) {
    const a = mesh.vertices[aIndex];
    const b = mesh.vertices[bIndex];
    const c = mesh.vertices[cIndex];
    const normal = faceNormal(a, b, c);
    const refDirection = normalizeVector(subtract(b, a));
    if (vectorLength(normal) < ZERO_EPSILON) continue;

    const normalId = next(`DIRECTION('',${tuple(normal)})`);
    const refDirectionId = next(`DIRECTION('',${tuple(refDirection)})`);
    const placementId = next(
      `AXIS2_PLACEMENT_3D('',#${pointIds[aIndex]},#${normalId},#${refDirectionId})`,
    );
    const planeId = next(`PLANE('',#${placementId})`);
    const orientedEdgeIds = [
      [aIndex, bIndex],
      [bIndex, cIndex],
      [cIndex, aIndex],
    ].map(([fromIndex, toIndex]) => {
      const edge = getEdgeCurve(fromIndex, toIndex);
      return next(
        `ORIENTED_EDGE('',*,*,#${edge.edgeCurveId},${edge.orientation ? '.T.' : '.F.'})`,
      );
    });
    const loopId = next(
      `EDGE_LOOP('',(${orientedEdgeIds.map((id) => `#${id}`).join(',')}))`,
    );
    const boundId = next(`FACE_OUTER_BOUND('',#${loopId},.T.)`);
    faceIds.push(next(`ADVANCED_FACE('',(#${boundId}),#${planeId},.T.)`));
  }

  if (faceIds.length === 0) {
    throw new Error('Cannot export STEP without valid faces.');
  }

  const shellId = next(
    `CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(',')}))`,
  );
  const brepId = next(
    `MANIFOLD_SOLID_BREP('${escapeStepString(name)}',#${shellId})`,
  );
  const originId = next("CARTESIAN_POINT('',(0,0,0))");
  const zDirectionId = next("DIRECTION('',(0,0,1))");
  const xDirectionId = next("DIRECTION('',(1,0,0))");
  const axisPlacementId = next(
    `AXIS2_PLACEMENT_3D('',#${originId},#${zDirectionId},#${xDirectionId})`,
  );
  const unitId = next('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const uncertaintyId = next(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${unitId},'distance_accuracy_value','Maximum model space distance between geometric entities at asserted connectivities')`,
  );
  const contextId = next(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertaintyId}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${unitId}))REPRESENTATION_CONTEXT('','3D'))`,
  );
  const shapeRepresentationId = next(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${axisPlacementId},#${brepId}),#${contextId})`,
  );
  next(
    `SHAPE_DEFINITION_REPRESENTATION(#${productShape},#${shapeRepresentationId})`,
  );

  const escapedName = escapeStepString(`${sanitizeObjName(name)}.step`);
  const timestamp = new Date().toISOString();

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('AzureFilm Generator faceted STEP export'),'2;1');",
    `FILE_NAME('${escapedName}','${timestamp}',('AzureFilm Generator'),('AzureFilm'),'AzureFilm Generator','AzureFilm Generator','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN_CC2'));",
    'ENDSEC;',
    'DATA;',
    ...entities,
    `/* protocol entity retained: #${protocol} */`,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

export async function stlBlobToTriangleMesh(blob: Blob): Promise<TriangleMesh> {
  const loader = new STLLoader();
  const geometry = loader.parse(await blob.arrayBuffer());
  try {
    return geometryToTriangleMesh(geometry);
  } finally {
    geometry.dispose();
  }
}

export async function stlBlobToOBJContent(
  blob: Blob,
  name: string,
): Promise<string> {
  return triangleMeshToOBJ(await stlBlobToTriangleMesh(blob), name);
}

export async function stlBlobToSTEPContent(
  blob: Blob,
  name: string,
): Promise<string> {
  return triangleMeshToFacetedSTEP(await stlBlobToTriangleMesh(blob), name);
}
