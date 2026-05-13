export type CreationModeType = 'parametric' | 'creative';

export type CreationModeOption = {
  type: CreationModeType;
  title: string;
  description: string;
  imageSrc: string;
  imageWebpSrc: string;
  printability: string[];
};

export const CREATION_MODE_OPTIONS: CreationModeOption[] = [
  {
    type: 'parametric',
    title: 'CAD Engineering',
    description: 'Precise parts, mechanisms, practical engineering',
    imageSrc: '/creation-mode-cad.png',
    imageWebpSrc: '/creation-mode-cad.webp',
    printability: ['dimensioned holes', 'flat faces', 'functional clearances'],
  },
  {
    type: 'creative',
    title: 'Mesh Generation',
    description: 'Figurines, organic shapes, sculpts',
    imageSrc: '/creation-mode-mesh.png',
    imageWebpSrc: '/creation-mode-mesh.webp',
    printability: ['wide base', 'thick features', 'no floating parts'],
  },
];
