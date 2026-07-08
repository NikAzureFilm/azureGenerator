import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COST_CEILING_USD,
  MAX_INSPECTION_BYTES,
  MAX_REPAIRS,
  MISSING_USAGE_FALLBACK_USD,
  PREMIUM_MAX_ROUNDS,
  computeLlmCallCostUsd,
  decideContinuation,
  expectedInspectionPath,
  finalizeLoop,
  initialLoopState,
  isValidInspectionPng,
  loopStateFromRow,
  maxAffordableOutputTokens,
  affordableContinuationOutputCap,
  buildGoogleCodeGenConfig,
  canAffordReview,
  clampText,
  effectiveOutputCap,
  MIN_AFFORDABLE_OUTPUT_TOKENS,
  parseContinuationBody,
  parseReviewerVerdict,
  tierForModel,
  truncateError,
} from './loop.ts';

test('tierForModel maps Fable to premium and everything else to lite', () => {
  assert.equal(tierForModel('anthropic/claude-fable-5'), 'premium');
  assert.equal(tierForModel('google/gemini-3.5-flash'), 'lite');
  assert.equal(tierForModel('whatever'), 'lite');
});

test('initialLoopState sets awaiting_client with tier-scoped maxRounds', () => {
  const premium = initialLoopState('premium');
  assert.deepEqual(premium, {
    round: 0,
    maxRounds: PREMIUM_MAX_ROUNDS,
    repairs: 0,
    status: 'awaiting_client',
    tier: 'premium',
  });
  const lite = initialLoopState('lite');
  assert.equal(lite.maxRounds, 0);
  assert.equal(lite.status, 'awaiting_client');
});

test('finalizeLoop produces a terminal status', () => {
  assert.equal(finalizeLoop(initialLoopState('premium')).status, 'final');
  assert.equal(
    finalizeLoop(initialLoopState('lite'), 'failed').status,
    'failed',
  );
});

test('COST_CEILING_USD is $0.60', () => {
  assert.equal(COST_CEILING_USD, 0.6);
});

test('decideContinuation runs a repair while under the cap', () => {
  const loop = { ...initialLoopState('lite'), repairs: 1 };
  const d = decideContinuation(loop, { type: 'compile_error', error: 'x' }, 0);
  assert.deepEqual(d, { action: 'repair' });
});

test('decideContinuation finalizes when repairs are exhausted', () => {
  const loop = { ...initialLoopState('lite'), repairs: MAX_REPAIRS };
  const d = decideContinuation(loop, { type: 'compile_error', error: 'x' }, 0);
  assert.equal(d.action, 'reject');
  assert.equal(d.finalize, true);
  assert.equal(d.httpStatus, 200);
});

test('decideContinuation rejects inspection on the lite tier', () => {
  const loop = initialLoopState('lite');
  const d = decideContinuation(loop, { type: 'inspection', imagePath: 'p' }, 0);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'inspection_not_premium');
  assert.equal(d.finalize, true);
});

test('decideContinuation inspects on premium under maxRounds', () => {
  const loop = initialLoopState('premium');
  const d = decideContinuation(loop, { type: 'inspection', imagePath: 'p' }, 0);
  assert.deepEqual(d, { action: 'inspect' });
});

test('decideContinuation finalizes premium once maxRounds reached', () => {
  const loop = { ...initialLoopState('premium'), round: PREMIUM_MAX_ROUNDS };
  const d = decideContinuation(
    loop,
    { type: 'inspection', imagePath: 'p' },
    PREMIUM_MAX_ROUNDS,
  );
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'rounds_exhausted');
  assert.equal(d.finalize, true);
});

test('decideContinuation ignores a stale round without clobbering', () => {
  const loop = { ...initialLoopState('premium'), round: 2 };
  const d = decideContinuation(loop, { type: 'compile_error', error: 'x' }, 1);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'round_mismatch');
  assert.equal(d.finalize, false);
  assert.equal(d.httpStatus, 409);
});

test('decideContinuation ignores a non-awaiting_client message', () => {
  const loop = { ...initialLoopState('premium'), status: 'final' };
  const d = decideContinuation(loop, { type: 'compile_error', error: 'x' }, 0);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'not_awaiting_client');
  assert.equal(d.finalize, false);
});

test('parseContinuationBody accepts a well-formed compile_error', () => {
  const r = parseContinuationBody({
    continuation: {
      conversationId: 'c',
      assistantMessageId: 'm',
      round: 0,
      result: { type: 'compile_error', error: 'boom' },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.continuation.result.type, 'compile_error');
});

test('parseContinuationBody accepts a well-formed inspection', () => {
  const r = parseContinuationBody({
    continuation: {
      conversationId: 'c',
      assistantMessageId: 'm',
      round: 3,
      result: { type: 'inspection', imagePath: 'u/c/inspection-m-r3' },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.continuation.round, 3);
});

test('parseContinuationBody rejects malformed payloads', () => {
  assert.equal(parseContinuationBody(null).ok, false);
  assert.equal(parseContinuationBody({}).ok, false);
  assert.equal(
    parseContinuationBody({ continuation: { conversationId: 'c' } }).ok,
    false,
  );
  assert.equal(
    parseContinuationBody({
      continuation: {
        conversationId: 'c',
        assistantMessageId: 'm',
        round: -1,
        result: { type: 'compile_error', error: 'x' },
      },
    }).ok,
    false,
  );
  assert.equal(
    parseContinuationBody({
      continuation: {
        conversationId: 'c',
        assistantMessageId: 'm',
        round: 0,
        result: { type: 'bogus' },
      },
    }).ok,
    false,
  );
});

test('parseReviewerVerdict parses a clean good verdict', () => {
  const v = parseReviewerVerdict(
    '{"verdict":"good","final_message":"Looks great."}',
  );
  assert.deepEqual(v, { verdict: 'good', finalMessage: 'Looks great.' });
});

test('parseReviewerVerdict parses a revise verdict', () => {
  const v = parseReviewerVerdict(
    '{"verdict":"revise","revision_instructions":"Add the handle."}',
  );
  assert.deepEqual(v, {
    verdict: 'revise',
    revisionInstructions: 'Add the handle.',
  });
});

test('parseReviewerVerdict extracts JSON from surrounding prose/fences', () => {
  const v = parseReviewerVerdict(
    'Sure!\n```json\n{"verdict":"revise","revision_instructions":"Thicken walls"}\n```\nDone.',
  );
  assert.equal(v.verdict, 'revise');
  assert.equal(v.revisionInstructions, 'Thicken walls');
});

test('parseReviewerVerdict falls back to good on malformed input', () => {
  assert.deepEqual(parseReviewerVerdict('not json at all'), {
    verdict: 'good',
  });
  assert.deepEqual(parseReviewerVerdict('{ verdict: broken'), {
    verdict: 'good',
  });
  assert.deepEqual(parseReviewerVerdict(''), { verdict: 'good' });
});

test('parseReviewerVerdict treats an empty revise as good', () => {
  assert.deepEqual(
    parseReviewerVerdict('{"verdict":"revise","revision_instructions":"  "}'),
    { verdict: 'good' },
  );
});

// --- Authoritative-state helpers (fix round) ----------------------------

test('loopStateFromRow derives maxRounds from tier', () => {
  assert.deepEqual(
    loopStateFromRow({
      round: 2,
      repairs: 1,
      status: 'awaiting_client',
      tier: 'premium',
    }),
    {
      round: 2,
      maxRounds: PREMIUM_MAX_ROUNDS,
      repairs: 1,
      status: 'awaiting_client',
      tier: 'premium',
    },
  );
  assert.equal(
    loopStateFromRow({ round: 0, repairs: 0, status: 'working', tier: 'lite' })
      .maxRounds,
    0,
  );
});

test('decideContinuation rejects a claimed (working) row — CAS busy semantics', () => {
  // The atomic claim only transitions awaiting_client → working; a request that
  // sees a row already 'working' is a lost race and must not run or spend.
  const state = loopStateFromRow({
    round: 0,
    repairs: 0,
    status: 'working',
    tier: 'premium',
  });
  const d = decideContinuation(state, { type: 'compile_error', error: 'x' }, 0);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'not_awaiting_client');
  assert.equal(d.finalize, false);
});

test('computeLlmCallCostUsd prefers the provider-reported cost', () => {
  assert.equal(
    computeLlmCallCostUsd('anthropic/claude-fable-5', {
      inputTokens: 1000,
      outputTokens: 1000,
      costUsdOverride: 0.42,
    }),
    0.42,
  );
});

test('computeLlmCallCostUsd falls back to the rate table', () => {
  // Fable: $10/M in, $50/M out → 1M in + 1M out = $60.
  assert.equal(
    computeLlmCallCostUsd('anthropic/claude-fable-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
    60,
  );
});

test('computeLlmCallCostUsd charges the flat fallback when usage is absent', () => {
  assert.equal(
    computeLlmCallCostUsd('anthropic/claude-fable-5', null),
    MISSING_USAGE_FALLBACK_USD,
  );
});

test('per-call cost accounting charges a usage-less call in a fallback chain', () => {
  // A google-direct call that returned no usage, then an OpenRouter call that
  // did: BOTH are charged (the first at the flat fallback, not skipped).
  const total =
    computeLlmCallCostUsd('google/gemini-3.5-flash', null) +
    computeLlmCallCostUsd('google/gemini-3.5-flash', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
  // gemini-3.5-flash: $1.5/M in + $9/M out = $10.50, plus the $0.08 fallback.
  assert.equal(total, MISSING_USAGE_FALLBACK_USD + 10.5);
});

test('maxAffordableOutputTokens scales output cap with remaining budget', () => {
  // Fable: $50/M out → floor(0.60/50 * 1e6 * 0.8) = 9600.
  assert.equal(
    maxAffordableOutputTokens('anthropic/claude-fable-5', 0.6),
    9600,
  );
  // Gemini: $9/M out → floor(0.60/9 * 1e6 * 0.8) = 53333.
  assert.equal(
    maxAffordableOutputTokens('google/gemini-3.5-flash', 0.6),
    53333,
  );
});

test('maxAffordableOutputTokens returns 0 when nothing is left', () => {
  assert.equal(maxAffordableOutputTokens('anthropic/claude-fable-5', 0), 0);
  assert.equal(maxAffordableOutputTokens('anthropic/claude-fable-5', -1), 0);
});

test('maxAffordableOutputTokens does not cap an unknown-priced model', () => {
  assert.equal(
    maxAffordableOutputTokens('some/unknown-model', 0.6),
    Number.MAX_SAFE_INTEGER,
  );
});

test('maxAffordableOutputTokens crosses the finalize threshold near the ceiling', () => {
  // $0.10 remaining on Fable → 1600 output tokens, below the 2000 floor.
  assert.ok(
    maxAffordableOutputTokens('anthropic/claude-fable-5', 0.1) <
      MIN_AFFORDABLE_OUTPUT_TOKENS,
  );
  // $0.20 remaining → 3200, comfortably above it.
  assert.ok(
    maxAffordableOutputTokens('anthropic/claude-fable-5', 0.2) >=
      MIN_AFFORDABLE_OUTPUT_TOKENS,
  );
});

test('affordableContinuationOutputCap subtracts input cost from the output budget', () => {
  // Fable, $0.60 remaining, 4000 prompt chars (=1000 input tokens):
  // input $0.01, output budget (0.60-0.01)*0.8=$0.472 → floor(0.472/50*1e6)=9439
  // (floating-point floor).
  assert.equal(
    affordableContinuationOutputCap({
      model: 'anthropic/claude-fable-5',
      remainingUsd: 0.6,
      promptChars: 4000,
      hasImage: false,
    }),
    9439,
  );
});

test('affordableContinuationOutputCap returns null when input + min output exceed budget', () => {
  // Fable min output alone is $0.10; $0.10 remaining can't also cover input.
  assert.equal(
    affordableContinuationOutputCap({
      model: 'anthropic/claude-fable-5',
      remainingUsd: 0.1,
      promptChars: 4000,
      hasImage: false,
    }),
    null,
  );
});

test('affordableContinuationOutputCap enforces the floor AFTER the 0.8 fraction', () => {
  // Fable $0.11 remaining, 4000 chars ($0.01 input): the OLD pre-fraction check
  // (remaining ≥ input + cost(2000) = $0.11) passed and returned a sub-floor
  // 1600-token cap. The new order applies ×0.8 first → 1600 < 2000 → null.
  assert.equal(
    affordableContinuationOutputCap({
      model: 'anthropic/claude-fable-5',
      remainingUsd: 0.11,
      promptChars: 4000,
      hasImage: false,
    }),
    null,
  );
  // Lite ~$0.0208 remaining, 4000 chars: post-fraction cap ≈ 1715 < 2000 → null.
  assert.equal(
    affordableContinuationOutputCap({
      model: 'google/gemini-3.5-flash',
      remainingUsd: 0.0208,
      promptChars: 4000,
      hasImage: false,
    }),
    null,
  );
  // Enough headroom to clear the floor after the fraction → a real cap.
  assert.ok(
    affordableContinuationOutputCap({
      model: 'anthropic/claude-fable-5',
      remainingUsd: 0.14,
      promptChars: 4000,
      hasImage: false,
    }) >= MIN_AFFORDABLE_OUTPUT_TOKENS,
  );
});

test('affordableContinuationOutputCap charges for an attached image', () => {
  const withoutImage = affordableContinuationOutputCap({
    model: 'anthropic/claude-fable-5',
    remainingUsd: 0.6,
    promptChars: 4000,
    hasImage: false,
  });
  const withImage = affordableContinuationOutputCap({
    model: 'anthropic/claude-fable-5',
    remainingUsd: 0.6,
    promptChars: 4000,
    hasImage: true,
  });
  // The image adds input tokens, shrinking the affordable output cap.
  assert.ok(withImage < withoutImage);
});

test('effectiveOutputCap clamps only when a budget cap is given', () => {
  assert.equal(effectiveOutputCap(32000, 5000), 5000);
  assert.equal(effectiveOutputCap(32000, 40000), 32000);
  assert.equal(effectiveOutputCap(32000, undefined), 32000);
});

test('buildGoogleCodeGenConfig applies the budget clamp and keeps thinking under it', () => {
  const clamped = buildGoogleCodeGenConfig({
    systemInstruction: 'sys',
    baseOutputCap: 32000,
    maxOutputTokens: 5000,
  });
  assert.equal(clamped.maxOutputTokens, 5000);
  assert.equal(clamped.thinkingConfig.thinkingBudget, 2500); // min(8192, 5000/2)
  assert.equal(clamped.systemInstruction, 'sys');

  const uncapped = buildGoogleCodeGenConfig({
    systemInstruction: 'sys',
    baseOutputCap: 32000,
  });
  assert.equal(uncapped.maxOutputTokens, 32000);
  assert.equal(uncapped.thinkingConfig.thinkingBudget, 8192);
});

test('clampText truncates only past the limit', () => {
  assert.equal(clampText('abcdef', 3), 'abc');
  assert.equal(clampText('ab', 3), 'ab');
});

test('canAffordReview gates the image-bearing review call on remaining budget', () => {
  // Fable, 4000 prompt chars → input 1000 + 2000 image = 3000 tokens ($0.03),
  // output 3000 tokens ($0.15) → needs $0.18.
  assert.equal(
    canAffordReview({
      model: 'anthropic/claude-fable-5',
      remainingUsd: 0.6,
      promptChars: 4000,
    }),
    true,
  );
  assert.equal(
    canAffordReview({
      model: 'anthropic/claude-fable-5',
      remainingUsd: 0.15,
      promptChars: 4000,
    }),
    false,
  );
});

test('canAffordReview includes the image token estimate', () => {
  // $0.165 would cover the review WITHOUT the image (1000 input tok = $0.01 +
  // $0.15 output = $0.16) but NOT with the 2000-token image ($0.03 + $0.15 =
  // $0.18) — so it must be unaffordable.
  assert.equal(
    canAffordReview({
      model: 'anthropic/claude-fable-5',
      remainingUsd: 0.165,
      promptChars: 4000,
    }),
    false,
  );
});

test('expectedInspectionPath is the owner-scoped, round-scoped path', () => {
  assert.equal(
    expectedInspectionPath('u1', 'c1', 'm1', 3),
    'u1/c1/inspection-m1-r3',
  );
});

test('truncateError bounds the error text and tolerates non-strings', () => {
  assert.equal(truncateError('x'.repeat(5000)).length, 4000);
  assert.equal(truncateError('short'), 'short');
  assert.equal(truncateError(undefined), '');
  assert.equal(truncateError(12345), '');
});

// Build a minimal PNG header (8-byte signature + IHDR width@16 / height@20).
function pngHeader(width, height, length = 24) {
  const b = new Uint8Array(length);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const writeU32 = (value, offset) => {
    b[offset] = (value >>> 24) & 0xff;
    b[offset + 1] = (value >>> 16) & 0xff;
    b[offset + 2] = (value >>> 8) & 0xff;
    b[offset + 3] = value & 0xff;
  };
  writeU32(width, 16);
  writeU32(height, 20);
  return b;
}

test('isValidInspectionPng accepts a real PNG header and rejects others', () => {
  assert.equal(isValidInspectionPng(pngHeader(1568, 800)), true);
  // Wrong magic (JPEG start).
  assert.equal(
    isValidInspectionPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])),
    false,
  );
  // Too short to hold the IHDR dimensions.
  assert.equal(isValidInspectionPng(new Uint8Array([0x89, 0x50])), false);
  // Null / empty.
  assert.equal(isValidInspectionPng(null), false);
  assert.equal(isValidInspectionPng(undefined), false);
});

test('isValidInspectionPng rejects oversized blobs', () => {
  const oversized = new Uint8Array(MAX_INSPECTION_BYTES + 1);
  oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(isValidInspectionPng(oversized), false);
});

test('isValidInspectionPng rejects out-of-range IHDR dimensions', () => {
  assert.equal(isValidInspectionPng(pngHeader(0, 800)), false);
  assert.equal(isValidInspectionPng(pngHeader(1568, 0)), false);
  assert.equal(isValidInspectionPng(pngHeader(5000, 800)), false);
  assert.equal(isValidInspectionPng(pngHeader(800, 5000)), false);
  assert.equal(isValidInspectionPng(pngHeader(4096, 4096)), true);
});

test('decideContinuation closes cleanly on compile_ok', () => {
  // The client only sends compile_ok when it decides to stop; the server closes
  // authoritatively regardless of tier / rounds remaining.
  for (const state of [
    initialLoopState('lite'),
    { ...initialLoopState('premium'), round: PREMIUM_MAX_ROUNDS },
    initialLoopState('premium'),
  ]) {
    const d = decideContinuation(state, { type: 'compile_ok' }, state.round);
    assert.deepEqual(d, { action: 'finalize_clean' });
  }
});

test('decideContinuation rejects compile_ok on a stale round or claimed row', () => {
  const stale = { ...initialLoopState('premium'), round: 2 };
  assert.equal(
    decideContinuation(stale, { type: 'compile_ok' }, 1).reason,
    'round_mismatch',
  );
  const claimed = loopStateFromRow({
    round: 0,
    repairs: 0,
    status: 'working',
    tier: 'lite',
  });
  assert.equal(
    decideContinuation(claimed, { type: 'compile_ok' }, 0).reason,
    'not_awaiting_client',
  );
});

test('parseContinuationBody accepts compile_ok', () => {
  const r = parseContinuationBody({
    continuation: {
      conversationId: 'c',
      assistantMessageId: 'm',
      round: 1,
      result: { type: 'compile_ok' },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.continuation.result.type, 'compile_ok');
});
