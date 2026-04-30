export type CreationModeType = 'parametric' | 'creative';

export type CreationModeOption = {
  type: CreationModeType;
  title: string;
  description: string;
  printability: string[];
};

export const CREATION_MODE_OPTIONS: CreationModeOption[] = [
  {
    type: 'parametric',
    title: 'CAD Engineering',
    description: 'Precise parts, mechanisms, practical engineering',
    printability: ['dimensioned holes', 'flat faces', 'functional clearances'],
  },
  {
    type: 'creative',
    title: 'Mesh Generation',
    description: 'Figurines, organic shapes, sculpts',
    printability: ['wide base', 'thick features', 'no floating parts'],
  },
];
