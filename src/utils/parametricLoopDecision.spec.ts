import { describe, expect, it } from 'vitest';
import type { LoopState, Message } from '@shared/types';
import {
  isDrivableLoopMessage,
  nextLoopAction,
} from './parametricLoopDecision';

function makeMessage(
  loop: LoopState | undefined,
  opts: { role?: 'assistant' | 'user'; code?: string | null } = {},
): Pick<Message, 'role' | 'content'> {
  const { role = 'assistant', code = 'cube(1);' } = opts;
  return {
    role,
    content: {
      loop,
      artifact: code
        ? { title: 't', version: 'v1', code, parameters: [] }
        : undefined,
    },
  };
}

const premiumLoop: LoopState = {
  round: 0,
  maxRounds: 6,
  repairs: 0,
  status: 'awaiting_client',
  tier: 'premium',
};
const liteLoop: LoopState = {
  round: 0,
  maxRounds: 0,
  repairs: 0,
  status: 'awaiting_client',
  tier: 'lite',
};

describe('isDrivableLoopMessage', () => {
  it('drives an awaiting_client assistant message with an artifact', () => {
    expect(isDrivableLoopMessage(makeMessage(premiumLoop))).toBe(true);
  });
  it('does not drive a message with no loop', () => {
    expect(isDrivableLoopMessage(makeMessage(undefined))).toBe(false);
  });
  it('does not drive a terminal loop', () => {
    expect(
      isDrivableLoopMessage(makeMessage({ ...premiumLoop, status: 'final' })),
    ).toBe(false);
  });
  it('does not drive a message without artifact code', () => {
    expect(
      isDrivableLoopMessage(makeMessage(premiumLoop, { code: null })),
    ).toBe(false);
  });
  it('does not drive a user message', () => {
    expect(
      isDrivableLoopMessage(makeMessage(premiumLoop, { role: 'user' })),
    ).toBe(false);
  });
});

describe('nextLoopAction', () => {
  it('requests a repair when compile fails and repairs remain', () => {
    expect(
      nextLoopAction(makeMessage(premiumLoop), {
        compileOk: false,
        isPremium: true,
      }),
    ).toBe('compile_error');
  });

  it('stops repairing once the repair cap is reached', () => {
    expect(
      nextLoopAction(makeMessage({ ...premiumLoop, repairs: 2 }), {
        compileOk: false,
        isPremium: true,
      }),
    ).toBe('stop');
  });

  it('inspects on premium after a clean compile within maxRounds', () => {
    expect(
      nextLoopAction(makeMessage(premiumLoop), {
        compileOk: true,
        isPremium: true,
      }),
    ).toBe('inspection');
  });

  it('does not inspect on the lite tier', () => {
    expect(
      nextLoopAction(makeMessage(liteLoop), {
        compileOk: true,
        isPremium: false,
      }),
    ).toBe('stop');
  });

  it('stops inspecting once maxRounds is reached', () => {
    expect(
      nextLoopAction(makeMessage({ ...premiumLoop, round: 6 }), {
        compileOk: true,
        isPremium: true,
      }),
    ).toBe('stop');
  });

  it('stops when the loop is already terminal', () => {
    expect(
      nextLoopAction(makeMessage({ ...premiumLoop, status: 'final' }), {
        compileOk: true,
        isPremium: true,
      }),
    ).toBe('stop');
  });

  it('prefers repair over inspection when compile fails on premium', () => {
    expect(
      nextLoopAction(makeMessage(premiumLoop), {
        compileOk: false,
        isPremium: true,
      }),
    ).toBe('compile_error');
  });
});
