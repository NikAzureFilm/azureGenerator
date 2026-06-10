'use client';

import { useEffect, useRef, useState } from 'react';
import type * as ThreeNS from 'three';

// Interactive three.js viewer for generation outputs. Renders on demand
// (initial load, orbit, resize) rather than a continuous animation loop so an
// open admin tab stays cheap.
export default function ModelViewer({
  src,
  format,
  height = 460,
}: {
  src: string;
  format: string;
  height?: number;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        const THREE = await import('three');
        const { OrbitControls } = await import(
          'three/examples/jsm/controls/OrbitControls.js'
        );

        const object = await loadObject(THREE, src, format);
        if (disposed) return;

        // --- scene -----------------------------------------------------
        const scene = new THREE.Scene();

        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        object.position.sub(center);
        scene.add(object);

        const grid = new THREE.GridHelper(maxDim * 4, 20, 0x39404f, 0x262a35);
        grid.position.y = -size.y / 2;
        scene.add(grid);

        scene.add(new THREE.HemisphereLight(0xdde4f0, 0x30343f, 1.1));
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
        keyLight.position.set(1, 2, 1.5).multiplyScalar(maxDim);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xaebcd8, 0.5);
        fillLight.position.set(-1.5, 0.6, -1).multiplyScalar(maxDim);
        scene.add(fillLight);

        // --- camera + renderer ------------------------------------------
        const camera = new THREE.PerspectiveCamera(
          45,
          mount.clientWidth / Math.max(mount.clientHeight, 1),
          maxDim / 100,
          maxDim * 100,
        );
        const homePosition = new THREE.Vector3(0.9, 0.6, 1.5)
          .normalize()
          .multiplyScalar(maxDim * 1.9);
        camera.position.copy(homePosition);

        const renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        mount.appendChild(renderer.domElement);

        // Environment map so PBR materials in GLB exports don't render black.
        try {
          const { RoomEnvironment } = await import(
            'three/examples/jsm/environments/RoomEnvironment.js'
          );
          const pmrem = new THREE.PMREMGenerator(renderer);
          scene.environment = pmrem.fromScene(
            new RoomEnvironment(),
            0.04,
          ).texture;
          pmrem.dispose();
        } catch {
          // lights above are enough of a fallback
        }

        const render = () => renderer.render(scene, camera);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.addEventListener('change', render);

        resetViewRef.current = () => {
          camera.position.copy(homePosition);
          controls.target.set(0, 0, 0);
          controls.update();
          render();
        };

        const observer = new ResizeObserver(() => {
          const w = mount.clientWidth;
          const h = mount.clientHeight;
          if (w === 0 || h === 0) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
          render();
        });
        observer.observe(mount);

        render();
        setPhase('ready');

        cleanup = () => {
          observer.disconnect();
          controls.dispose();
          scene.traverse((node) => {
            const mesh = node as ThreeNS.Mesh;
            if (mesh.geometry) mesh.geometry.dispose();
            const material = mesh.material as
              | ThreeNS.Material
              | ThreeNS.Material[]
              | undefined;
            if (Array.isArray(material)) {
              material.forEach((m) => m.dispose());
            } else if (material) {
              material.dispose();
            }
          });
          scene.environment?.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
        if (disposed) {
          cleanup();
          cleanup = null;
        }
      } catch (error) {
        if (disposed) return;
        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to load model',
        );
        setPhase('error');
      }
    })();

    return () => {
      disposed = true;
      resetViewRef.current = null;
      cleanup?.();
    };
  }, [src, format]);

  return (
    <div className="viewer">
      <div className="viewer-canvas" style={{ height }} ref={mountRef}>
        {phase === 'loading' && (
          <div className="viewer-overlay muted">Loading model...</div>
        )}
        {phase === 'error' && (
          <div className="viewer-overlay">
            <span className="error-inline">
              Could not render model: {errorMessage}
            </span>
          </div>
        )}
      </div>
      <div className="viewer-toolbar">
        <span className="muted tiny">
          Drag to orbit - scroll to zoom - right-drag to pan
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => resetViewRef.current?.()}
        >
          Reset view
        </button>
      </div>
    </div>
  );
}

type ThreeModule = typeof import('three');

async function loadObject(
  THREE: ThreeModule,
  src: string,
  format: string,
): Promise<ThreeNS.Object3D> {
  const fmt = format.toLowerCase();

  if (fmt === 'glb' || fmt === 'gltf') {
    const { GLTFLoader } = await import(
      'three/examples/jsm/loaders/GLTFLoader.js'
    );
    const gltf = await new GLTFLoader().loadAsync(src);
    return gltf.scene;
  }

  if (fmt === 'stl') {
    const { STLLoader } = await import(
      'three/examples/jsm/loaders/STLLoader.js'
    );
    const geometry = await new STLLoader().loadAsync(src);
    if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, defaultMaterial(THREE));
  }

  if (fmt === 'obj') {
    const { OBJLoader } = await import(
      'three/examples/jsm/loaders/OBJLoader.js'
    );
    const object = await new OBJLoader().loadAsync(src);
    applyDefaultMaterial(THREE, object);
    return object;
  }

  if (fmt === 'fbx') {
    const { FBXLoader } = await import(
      'three/examples/jsm/loaders/FBXLoader.js'
    );
    return await new FBXLoader().loadAsync(src);
  }

  if (fmt === '3mf') {
    const { ThreeMFLoader } = await import(
      'three/examples/jsm/loaders/3MFLoader.js'
    );
    return await new ThreeMFLoader().loadAsync(src);
  }

  throw new Error(`Unsupported format: ${format}`);
}

function defaultMaterial(THREE: ThreeModule) {
  return new THREE.MeshStandardMaterial({
    color: 0x9db4d8,
    metalness: 0.1,
    roughness: 0.55,
  });
}

// OBJ files without .mtl come in with a flat default; give them the same
// neutral PBR material used for STL so lighting reads properly.
function applyDefaultMaterial(THREE: ThreeModule, object: ThreeNS.Object3D) {
  object.traverse((node) => {
    const mesh = node as ThreeNS.Mesh;
    if (mesh.isMesh) {
      mesh.material = defaultMaterial(THREE);
      if (!mesh.geometry.hasAttribute('normal')) {
        mesh.geometry.computeVertexNormals();
      }
    }
  });
}
