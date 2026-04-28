import { Canvas, useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  getAzureFilmMarkBounds,
  getAzureFilmMarkPoints,
} from '@/utils/azurefilmMarkGeometry';

function AzureFilmMarkVolume() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const points = useMemo(() => getAzureFilmMarkPoints(), []);
  const bounds = useMemo(() => getAzureFilmMarkBounds(points), [points]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const frontColor = new THREE.Color('#16b8ff');
    const backColor = new THREE.Color('#086dff');
    const highlightColor = new THREE.Color('#8ae8ff');
    const depthHalf = bounds.size.z / 2 || 1;

    points.forEach((point, index) => {
      dummy.position.set(
        (point.x - bounds.center.x) * 1.08,
        (point.y - bounds.center.y) * 1.08,
        (point.z - bounds.center.z) * 1.05,
      );
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);

      const depth = Math.min(
        1,
        Math.max(0, (point.z - bounds.center.z + depthHalf) / bounds.size.z),
      );
      const color = backColor.clone().lerp(frontColor, depth);
      if (point.y > bounds.center.y + bounds.size.y * 0.25) {
        color.lerp(highlightColor, 0.35);
      }
      mesh.setColorAt(index, color);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [bounds, dummy, points]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.y = Math.sin(clock.elapsedTime * 1.1) * 0.14;
    meshRef.current.rotation.x =
      Math.sin(clock.elapsedTime * 1.35) * 0.08 - 0.1;
    meshRef.current.rotation.z = -0.08;
  });

  return (
    <group rotation={[0.08, 0, 0]} scale={1.15}>
      <instancedMesh ref={meshRef} args={[undefined, undefined, points.length]}>
        <sphereGeometry args={[0.018, 8, 8]} />
        <meshStandardMaterial
          color="#128dff"
          emissive="#006dff"
          emissiveIntensity={0.62}
          vertexColors={true}
          metalness={0.18}
          roughness={0.24}
          envMapIntensity={0.4}
        />
      </instancedMesh>
    </group>
  );
}

export function AzureFilm3DMark() {
  return (
    <div
      className="h-full w-full"
      aria-label="3D AzureFilm a loading mark"
      role="img"
    >
      <Canvas
        camera={{ position: [0, 0, 4.4], fov: 38 }}
        dpr={[1, 1.75]}
        gl={{ alpha: true, antialias: true }}
      >
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 2.6, 3]} intensity={2.2} />
        <directionalLight position={[-2.8, -1.5, 2]} intensity={0.65} />
        <pointLight position={[0, 0, 3]} intensity={0.9} color="#7ddcff" />
        <AzureFilmMarkVolume />
      </Canvas>
    </div>
  );
}
