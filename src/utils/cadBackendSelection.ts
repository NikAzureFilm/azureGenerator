import type { CadBackend, Message } from '@shared/types';
import {
  FEATURE_COSTS,
  getParametricModelTokenCost,
} from '../../shared/tokenCosts.ts';

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

export function getCadBackendTokenCost(
  backend: CadBackend,
  model: string,
): number {
  switch (backend) {
    case 'openscad':
    case 'text-to-cad':
      return FEATURE_COSTS.chat.tokens + getParametricModelTokenCost(model);
  }
}
