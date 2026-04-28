import { azurefilmMarkVertices } from './azurefilmMarkVertices';

export type AzureFilmMarkPoint = {
  x: number;
  y: number;
  z: number;
};

export type AzureFilmMarkBounds = {
  center: AzureFilmMarkPoint;
  size: AzureFilmMarkPoint;
};

export function getAzureFilmMarkPoints(): AzureFilmMarkPoint[] {
  const points: AzureFilmMarkPoint[] = [];

  for (let index = 0; index < azurefilmMarkVertices.length; index += 3) {
    points.push({
      x: azurefilmMarkVertices[index],
      y: azurefilmMarkVertices[index + 1],
      z: azurefilmMarkVertices[index + 2],
    });
  }

  return points;
}

export function getAzureFilmMarkBounds(
  points: AzureFilmMarkPoint[],
): AzureFilmMarkBounds {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  points.forEach((point) => {
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
    max.z = Math.max(max.z, point.z);
  });

  return {
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
    size: {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    },
  };
}
