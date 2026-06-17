import * as THREE from 'three';
import { GLTF, GLTFLoader, GLTFParser } from 'three-stdlib';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export type DetectedPbrMaps = {
  albedo: boolean;
  normal: boolean;
  roughness: boolean;
  metallic: boolean;
  ao: boolean;
};

export type LoadedMesh = {
  gltf: GLTF;
  polygonCount: number;
  pbrMaps: DetectedPbrMaps;
};

const NO_PBR_MAPS: DetectedPbrMaps = {
  albedo: false,
  normal: false,
  roughness: false,
  metallic: false,
  ao: false,
};

// Function to calculate polygon count from a 3D model
function calculatePolygonCount(gltfModel: GLTF): number {
  let totalPolygons = 0;

  gltfModel.scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const geometry = child.geometry;

      if (geometry.index) {
        // If geometry has an index, count triangles from index
        totalPolygons += geometry.index.count / 3;
      } else if (geometry.attributes.position) {
        // If no index, count triangles from position attribute
        totalPolygons += geometry.attributes.position.count / 3;
      }
    }
  });

  return Math.floor(totalPolygons);
}

function wrapAsGltf(scene: THREE.Group): GLTF {
  return {
    scene,
    scenes: [scene],
    cameras: [],
    animations: [],
    asset: {},
    parser: {} as GLTFParser,
    userData: {},
  };
}

function loadStl(arrayBuffer: ArrayBuffer): LoadedMesh {
  const loader = new STLLoader();
  const geometry = loader.parse(arrayBuffer);

  // Center the geometry
  geometry.center();
  geometry.computeVertexNormals();

  // Create a mesh with the STL geometry
  const material = new THREE.MeshStandardMaterial({
    color: 0x888888,
    metalness: 0.6,
    roughness: 0.3,
  });
  const stlMesh = new THREE.Mesh(geometry, material);

  const scene = new THREE.Group();
  scene.add(stlMesh);

  const mockGltf = wrapAsGltf(scene);
  return {
    gltf: mockGltf,
    polygonCount: calculatePolygonCount(mockGltf),
    pbrMaps: NO_PBR_MAPS,
  };
}

function loadObj(arrayBuffer: ArrayBuffer): LoadedMesh {
  const loader = new OBJLoader();
  const objText = new TextDecoder().decode(arrayBuffer);
  const objGroup = loader.parse(objText);

  const mockGltf = wrapAsGltf(objGroup);
  return {
    gltf: mockGltf,
    polygonCount: calculatePolygonCount(mockGltf),
    pbrMaps: NO_PBR_MAPS,
  };
}

function loadFbx(arrayBuffer: ArrayBuffer): LoadedMesh {
  const loader = new FBXLoader();
  // FBX files from Tripo are binary format, not text
  // Use the binary data directly
  const fbxGroup = loader.parse(arrayBuffer, '');

  // Scale down FBX models (they tend to be very large)
  fbxGroup.scale.setScalar(0.01); // Scale to 1% of original size

  // Center the model
  const box = new THREE.Box3().setFromObject(fbxGroup);
  const center = box.getCenter(new THREE.Vector3());
  fbxGroup.position.sub(center);

  // Convert FBX materials to MeshStandardMaterial for PBR support
  fbxGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      const convertedMaterials = materials.map((mat) => {
        // If it's already MeshStandardMaterial, keep it
        if (mat instanceof THREE.MeshStandardMaterial) {
          return mat;
        }

        // Convert other material types to MeshStandardMaterial
        const standardMat = new THREE.MeshStandardMaterial();

        // Copy common properties
        if ('color' in mat && mat.color) {
          standardMat.color = mat.color.clone();
        }
        if ('map' in mat && mat.map) {
          standardMat.map = mat.map;
        }
        if ('normalMap' in mat && mat.normalMap) {
          standardMat.normalMap = mat.normalMap;
        }
        if ('emissive' in mat && mat.emissive) {
          standardMat.emissive = mat.emissive.clone();
        }
        if ('emissiveMap' in mat && mat.emissiveMap) {
          standardMat.emissiveMap = mat.emissiveMap;
        }

        // Set default PBR values for converted materials
        standardMat.roughness = 0.5; // Default roughness
        standardMat.metalness = 0.0; // Default metalness

        // Copy other common properties
        standardMat.transparent = mat.transparent;
        standardMat.opacity = mat.opacity;
        standardMat.side = mat.side;

        // Dispose of the original material to free WebGL resources
        mat.dispose();

        return standardMat;
      });

      // Apply the converted materials
      if (Array.isArray(child.material)) {
        child.material = convertedMaterials;
      } else {
        child.material = convertedMaterials[0];
      }
    }
  });

  const mockGltf = wrapAsGltf(fbxGroup);
  return {
    gltf: mockGltf,
    polygonCount: calculatePolygonCount(mockGltf),
    pbrMaps: NO_PBR_MAPS,
  };
}

function loadGlb(buffer: ArrayBuffer): Promise<LoadedMesh> {
  const loader = new GLTFLoader();
  return new Promise<LoadedMesh>((resolve, reject) => {
    loader.parse(
      buffer,
      '',
      (parsedGltf) => {
        // Center the model
        const box = new THREE.Box3().setFromObject(parsedGltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        parsedGltf.scene.position.sub(center);

        // Analyze the loaded model to detect available PBR maps
        const detectedMaps: DetectedPbrMaps = { ...NO_PBR_MAPS };

        parsedGltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const materials = Array.isArray(child.material)
              ? child.material
              : [child.material];

            materials.forEach((mat) => {
              if ('map' in mat && mat.map) {
                detectedMaps.albedo = true;
              }
              if ('normalMap' in mat && mat.normalMap) {
                detectedMaps.normal = true;
              }
              if ('roughnessMap' in mat && mat.roughnessMap) {
                detectedMaps.roughness = true;
              }
              if ('metalnessMap' in mat && mat.metalnessMap) {
                detectedMaps.metallic = true;
              }
              if ('aoMap' in mat && mat.aoMap) {
                detectedMaps.ao = true;
              }
            });
          }
        });

        resolve({
          gltf: parsedGltf,
          polygonCount: calculatePolygonCount(parsedGltf),
          pbrMaps: detectedMaps,
        });
      },
      () => {
        reject(new Error('Failed to load GLB mesh'));
      },
    );
  });
}

/**
 * Parses a mesh blob (stl | obj | fbx | glb) into a GLTF-compatible structure
 * with its polygon count and detected PBR maps. OBJ and FBX parsing fall back
 * to GLB when the file turns out not to match its declared type.
 */
export async function loadMeshBlobAsGltf(
  meshBlob: Blob,
  fileType: string,
): Promise<LoadedMesh> {
  const arrayBuffer = await meshBlob.arrayBuffer();

  if (fileType === 'stl') {
    return loadStl(arrayBuffer);
  }

  if (fileType === 'obj') {
    try {
      return loadObj(arrayBuffer);
    } catch {
      return loadGlb(arrayBuffer);
    }
  }

  if (fileType === 'fbx') {
    try {
      return loadFbx(arrayBuffer);
    } catch {
      return loadGlb(arrayBuffer);
    }
  }

  return loadGlb(arrayBuffer);
}
