type CreationType = 'creative' | 'parametric';

interface InputImageControlOptions {
  type: CreationType;
  isMultiview: boolean;
  parametricSupportsVision: boolean;
}

interface ReferenceImageAcceptOptions {
  type: CreationType;
  imageFormats: readonly string[];
  creativeMeshExtensions: readonly string[];
}

export function shouldShowGeneratedInputImageControl({
  type,
  isMultiview,
  parametricSupportsVision,
}: InputImageControlOptions): boolean {
  if (isMultiview) return false;
  return type === 'creative' || parametricSupportsVision;
}

export function shouldShowReferenceImageControl(
  options: InputImageControlOptions,
): boolean {
  return shouldShowGeneratedInputImageControl(options);
}

export function buildReferenceImageAccept({
  type,
  imageFormats,
  creativeMeshExtensions,
}: ReferenceImageAcceptOptions): string {
  const modelFormats = type === 'creative' ? creativeMeshExtensions : ['.stl'];
  return [...imageFormats, ...modelFormats].join(', ');
}
