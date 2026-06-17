import { describe, expect, it } from 'vitest';
import { getMeshFileType, isSupportedMeshFile } from './chatAttachments';

describe('getMeshFileType', () => {
  it('detects known extensions case-insensitively', () => {
    expect(getMeshFileType('part.stl')).toBe('stl');
    expect(getMeshFileType('PART.STL')).toBe('stl');
    expect(getMeshFileType('model.obj')).toBe('obj');
    expect(getMeshFileType('rig.FBX')).toBe('fbx');
  });

  it('falls back to glb for unknown extensions', () => {
    expect(getMeshFileType('scene.glb')).toBe('glb');
    expect(getMeshFileType('readme.txt')).toBe('glb');
    expect(getMeshFileType('noextension')).toBe('glb');
  });
});

describe('isSupportedMeshFile', () => {
  it('accepts all mesh formats in creative mode', () => {
    expect(isSupportedMeshFile('a.glb', 'creative')).toBe(true);
    expect(isSupportedMeshFile('a.stl', 'creative')).toBe(true);
    expect(isSupportedMeshFile('a.obj', 'creative')).toBe(true);
    expect(isSupportedMeshFile('a.fbx', 'creative')).toBe(true);
    expect(isSupportedMeshFile('a.step', 'creative')).toBe(false);
  });

  it('accepts only STL in parametric mode', () => {
    expect(isSupportedMeshFile('a.stl', 'parametric')).toBe(true);
    expect(isSupportedMeshFile('a.STL', 'parametric')).toBe(true);
    expect(isSupportedMeshFile('a.glb', 'parametric')).toBe(false);
    expect(isSupportedMeshFile('a.obj', 'parametric')).toBe(false);
  });
});
