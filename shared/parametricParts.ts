// OpenSCAD shape/transform/boolean/definition keywords plus `include`/`use`
// statements. A model the WASM worker can actually render contains at least
// one of these. Pure prose, apologies, or truncated replies contain none.
const OPENSCAD_TOKEN_PATTERN =
  /\b(?:module|function|cube|cylinder|sphere|polyhedron|circle|square|polygon|text|union|difference|intersection|hull|minkowski|translate|rotate|scale|resize|mirror|multmatrix|color|offset|linear_extrude|rotate_extrude|projection|surface|import)\b|(?:^|\n)\s*(?:include|use)\s*</;

export function hasRenderableScadCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (trimmed.length === 0) return false;
  return OPENSCAD_TOKEN_PATTERN.test(trimmed);
}
