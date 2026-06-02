import type { CadBackend, Message } from '@shared/types';
export { getCadBackendTokenCost } from '../../shared/tokenCosts.ts';

type BackendMessage = Pick<Message, 'role' | 'content'>;

export const DEFAULT_CAD_BACKEND: CadBackend = 'openscad';

export function getComposerCadBackendHint(
  message?: BackendMessage | null,
): CadBackend | undefined {
  const backend = message?.content.cadBackend;
  if (backend === 'openscad' || backend === 'text-to-cad') {
    return backend;
  }
  return undefined;
}
