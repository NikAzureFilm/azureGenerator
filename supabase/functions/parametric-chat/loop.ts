// Pure state-machine logic for the agentic generation loop. No Deno / network
// APIs live here so the same functions can be unit-tested under `node --test`
// (see loop.test.mjs). The effectful continuation handler in index.ts drives
// these decisions and performs the actual LLM / storage / DB work.

import type { LoopState, LoopStatus, LoopTier } from '@shared/types.ts';
import {
  inspectionRoundsForModel,
  normalizeParametricGenerationModel,
} from '../../../shared/parametricRouting.ts';
import {
  llmCostUsd,
  llmInputPerMUsd,
  llmOutputPerMUsd,
} from '../../../shared/providerPricing.ts';

// Shared compile-error repair cap (both tiers).
export const MAX_REPAIRS = 2;
// Inspection rounds available to premium only.
export const PREMIUM_MAX_ROUNDS = 6;
// Hard true-cost ceiling per generation, enforced from the authoritative
// parametric_loop_state.spent_usd row (with the provider_usage sum kept as a
// secondary check). Crossing it finalizes the loop with the current artifact.
export const COST_CEILING_USD = 0.6;
// Conservative charge for an LLM call whose response carried no usage numbers,
// so a provider that omits usage can't let a round run "for free" past the
// ceiling.
export const MISSING_USAGE_FALLBACK_USD = 0.08;
// Reject inspection PNGs larger than this before base64-ing / sending to the
// vision model.
export const MAX_INSPECTION_BYTES = 8 * 1024 * 1024;
// The inspection sheet is rendered at a FIXED, deterministic pixel size
// (src/utils/renderInspectionSheet.ts: SHEET_W = CELL_W*COLS = 1568,
// SHEET_H = CELL_H*ROWS = 800, with renderer.setPixelRatio(1) and a fixed
// composite canvas — NOT devicePixelRatio-scaled). So a legitimate sheet is
// EXACTLY these dimensions. Enforcing the exact size (not just an upper bound)
// tightens the guard: a client can write to the inspection path, and an
// oversized-but-under-8MB PNG that merely passed a loose bound could still run
// up input-token cost on the vision model.
export const EXPECTED_INSPECTION_WIDTH = 1568;
export const EXPECTED_INSPECTION_HEIGHT = 800;
// A continuation code-gen call is only worth making if it can afford at least
// this many output tokens under the remaining budget; otherwise finalize.
export const MIN_AFFORDABLE_OUTPUT_TOKENS = 2000;
// Only spend up to this fraction of the remaining (post-input) budget on one
// call's output, leaving headroom for input-token estimate error.
const OUTPUT_BUDGET_FRACTION = 0.8;
// Rough chars-per-token for prompt input estimation.
const CHARS_PER_TOKEN = 4;
// Flat token estimate for one attached image in an input prompt.
export const IMAGE_INPUT_TOKEN_ESTIMATE = 2000;
// Server-side prompt input clamps for continuation code-gen (bound input cost).
export const MAX_PROMPT_USER_TEXT_CHARS = 6000;
export const MAX_PROMPT_BASE_CODE_CHARS = 100_000;

export function clampText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// Largest output-token cap the remaining USD budget can afford for `model`
// (output-only; used by tests and as a building block). Returns 0 when nothing
// is left and a very large number when the output price is unknown.
export function maxAffordableOutputTokens(
  model: string,
  remainingUsd: number,
): number {
  if (remainingUsd <= 0) return 0;
  const perM = llmOutputPerMUsd(model);
  if (perM <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor((remainingUsd / perM) * 1_000_000 * OUTPUT_BUDGET_FRACTION);
}

// Affordable output-token cap for a continuation code-gen call that ALSO
// accounts for estimated INPUT cost. Returns null when the remaining budget
// can't cover the estimated input plus a minimal output — the caller must
// finalize instead of making the call. Output budget = (remaining − input) ×
// fraction, so a large prompt shrinks the output cap rather than blowing past
// the ceiling.
export function affordableContinuationOutputCap(params: {
  model: string;
  remainingUsd: number;
  promptChars: number;
  hasImage: boolean;
}): number | null {
  const { model, remainingUsd, promptChars, hasImage } = params;
  const inputTokens =
    Math.ceil(promptChars / CHARS_PER_TOKEN) +
    (hasImage ? IMAGE_INPUT_TOKEN_ESTIMATE : 0);
  const outputPerM = llmOutputPerMUsd(model);
  const estimatedInputUsd = (inputTokens * llmInputPerMUsd(model)) / 1_000_000;
  const remainingAfterInputUsd = remainingUsd - estimatedInputUsd;
  if (remainingAfterInputUsd <= 0) return null;
  if (outputPerM <= 0) return Number.MAX_SAFE_INTEGER;
  // Apply the output-budget fraction FIRST, then enforce the floor on the
  // ACTUAL cap — otherwise a pre-fraction check lets a sub-2000 cap slip
  // through (e.g. remaining = input + cost(2000) → cap = 1600 < 2000).
  const cap = Math.floor(
    ((remainingAfterInputUsd * OUTPUT_BUDGET_FRACTION) / outputPerM) *
      1_000_000,
  );
  return cap < MIN_AFFORDABLE_OUTPUT_TOKENS ? null : cap;
}

// Clamp a model's base output cap by an optional budget-derived cap.
export function effectiveOutputCap(
  baseCap: number,
  maxOutputTokens?: number,
): number {
  return typeof maxOutputTokens === 'number'
    ? Math.min(baseCap, maxOutputTokens)
    : baseCap;
}

// Fixed output-token estimate for the vision reviewer call: 2000 completion
// (max_tokens) plus a small buffer for the now-minimal excluded reasoning. Its
// output is hard-capped, so affordability is a boolean.
export const REVIEW_OUTPUT_TOKEN_ESTIMATE = 2500;

// Whether the remaining budget can cover the inspection-review call: its
// estimated INPUT (prompt chars + one image) plus its fixed output. The
// reviewer's output is capped, so there's no variable cap to return — just a
// go / no-go used to skip the review and finalize 'good' when unaffordable.
export function canAffordReview(params: {
  model: string;
  remainingUsd: number;
  promptChars: number;
}): boolean {
  const { model, remainingUsd, promptChars } = params;
  const inputTokens =
    Math.ceil(promptChars / CHARS_PER_TOKEN) + IMAGE_INPUT_TOKEN_ESTIMATE;
  const estimatedInputUsd = (inputTokens * llmInputPerMUsd(model)) / 1_000_000;
  const outputUsd =
    (REVIEW_OUTPUT_TOKEN_ESTIMATE * llmOutputPerMUsd(model)) / 1_000_000;
  return remainingUsd >= estimatedInputUsd + outputUsd;
}

// Hard cap on total PROMPT TEXT chars sent to the google-direct code-gen call.
// Belt-and-braces so no content shape can ever explode text input again.
export const MAX_GOOGLE_PROMPT_CHARS = 200_000;

export type GooglePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };
export type GoogleContent = { role: 'user' | 'model'; parts: GooglePart[] };

type GoogleSourceBlock = {
  type?: string;
  text?: string;
  image_url?: { url?: string };
};
type GoogleSourceMessage = {
  role: string;
  content: string | GoogleSourceBlock[];
};

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

// Build proper @google/genai `contents` from OpenAI-style messages. Text blocks
// become {text}; image data URLs become {inlineData} (NEVER JSON.stringified
// into prompt text — that was the megabyte-of-base64 blowup); non-data image
// URLs and unknown block types are dropped. Total TEXT is clamped to
// `maxTextChars` (image bytes are not counted — they're proper image input).
export function buildGoogleContents(
  messages: GoogleSourceMessage[],
  maxTextChars = MAX_GOOGLE_PROMPT_CHARS,
): { contents: GoogleContent[]; clampedTextChars: boolean } {
  let remainingChars = maxTextChars;
  let clampedTextChars = false;
  const contents: GoogleContent[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue; // system → systemInstruction
    const role: 'user' | 'model' =
      message.role === 'assistant' ? 'model' : 'user';
    const parts: GooglePart[] = [];

    const pushText = (text: string) => {
      if (!text) return;
      if (remainingChars <= 0) {
        clampedTextChars = true;
        return;
      }
      let slice = text;
      if (slice.length > remainingChars) {
        slice = slice.slice(0, remainingChars);
        clampedTextChars = true;
      }
      remainingChars -= slice.length;
      parts.push({ text: slice });
    };

    if (typeof message.content === 'string') {
      pushText(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          pushText(block.text);
        } else if (block.type === 'image_url' && block.image_url?.url) {
          const parsed = parseDataUrl(block.image_url.url);
          if (parsed) {
            parts.push({
              inlineData: { mimeType: parsed.mimeType, data: parsed.data },
            });
          }
          // Non-data (http) image URLs and unknown block types are dropped.
        }
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  return { contents, clampedTextChars };
}

// Build the @google/genai config for a continuation code-gen call so the
// google-direct branch honors the budget-derived output cap too (the OpenRouter
// branch already clamps via applyCompletionTokenLimit). thinkingBudget is kept
// under the output cap so a tight budget can't starve the actual output.
export function buildGoogleCodeGenConfig(params: {
  systemInstruction: string;
  baseOutputCap: number;
  maxOutputTokens?: number;
}): {
  systemInstruction: string;
  thinkingConfig: { thinkingBudget: number };
  maxOutputTokens: number;
} {
  const cap = effectiveOutputCap(params.baseOutputCap, params.maxOutputTokens);
  return {
    systemInstruction: params.systemInstruction,
    thinkingConfig: { thinkingBudget: Math.min(8192, Math.floor(cap / 2)) },
    maxOutputTokens: cap,
  };
}

// A model gets inspection rounds ('premium') when its roster
// maxInspectionRounds > 0; otherwise it's a no-inspection draft ('lite'). The
// tier string is still stored on the row for display, but the actual round count
// is derived per-model (see loopStateFromRow / inspectionRoundsForModel).
export function tierForModel(model: string): LoopTier {
  return inspectionRoundsForModel(model) > 0 ? 'premium' : 'lite';
}

// Build the in-memory LoopState the decision functions expect from a persisted
// state row. maxRounds is DERIVED (never stored): recomputed each continuation
// from the AUTHORITATIVE paid model so per-model round counts (Gemini 3.1 Pro =
// 4, Fable/GPT/Opus = 6, Lite = 0) stay a single source of truth.
//
// SECURITY: the authoritative model is `row.model` — persisted by the edge
// function (service-role only, RLS-locked) at round 0. The passed `model` is
// only a fallback for pre-migration rows whose `model` column is null (it comes
// from the client-writable content.model, so it must never override the row).
// When neither is present, fall back to the stored tier (legacy behavior).
export function loopStateFromRow(
  row: {
    round: number;
    repairs: number;
    status: string;
    tier: string;
    model?: string | null;
  },
  model?: string,
): LoopState {
  const tier: LoopTier = row.tier === 'premium' ? 'premium' : 'lite';
  const rawModel = row.model ?? model;
  const authoritativeModel =
    rawModel != null ? normalizeParametricGenerationModel(rawModel) : undefined;
  const maxRounds =
    authoritativeModel !== undefined
      ? inspectionRoundsForModel(authoritativeModel)
      : tier === 'premium'
        ? PREMIUM_MAX_ROUNDS
        : 0;
  return {
    round: row.round,
    maxRounds,
    repairs: row.repairs,
    status: row.status as LoopStatus,
    tier,
  };
}

export type LlmCallUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  // The provider's own billed cost, when it returns one (OpenRouter does).
  costUsdOverride?: number;
};

// Synchronous USD cost of a single LLM call, used to accumulate spend within a
// round without waiting on the async provider_usage writes. Prefers the
// provider-reported cost; falls back to the rate table; charges a conservative
// flat fee when usage is entirely absent.
export function computeLlmCallCostUsd(
  model: string,
  usage: LlmCallUsage | null,
): number {
  if (!usage) return MISSING_USAGE_FALLBACK_USD;
  if (
    typeof usage.costUsdOverride === 'number' &&
    Number.isFinite(usage.costUsdOverride)
  ) {
    return Math.max(0, usage.costUsdOverride);
  }
  const rateCost = llmCostUsd(
    model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens ?? 0,
  );
  // llmCostUsd returns 0 for a model absent from the price table. If the call
  // actually consumed tokens (e.g. OpenRouter silently rerouted to an unpriced
  // served id that returned usage but no billed cost), meter the conservative
  // flat fee instead of $0 so an unpriced leg can never escape spend accounting
  // and slip the $0.60 ceiling.
  if (rateCost <= 0 && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
    return MISSING_USAGE_FALLBACK_USD;
  }
  return rateCost;
}

// The one legitimate storage path for a round's inspection sheet. The server
// computes this itself instead of trusting the client's imagePath, so a client
// can't point the reviewer at an arbitrary object it can read.
export function expectedInspectionPath(
  userId: string,
  conversationId: string,
  messageId: string,
  round: number,
): string {
  return `${userId}/${conversationId}/inspection-${messageId}-r${round}`;
}

export function truncateError(error: unknown, max = 4000): string {
  return typeof error === 'string' ? error.slice(0, max) : '';
}

// Validate that a downloaded inspection asset is actually a PNG of sane size
// AND sane pixel dimensions before it reaches the vision model. Needs at least
// the 8-byte signature + IHDR through the height field (offset 20-23).
export function isValidInspectionPng(
  bytes: Uint8Array | null | undefined,
): boolean {
  if (!bytes || bytes.length < 24 || bytes.length > MAX_INSPECTION_BYTES) {
    return false;
  }
  const magicOk =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (!magicOk) return false;

  // IHDR width @16, height @20 — big-endian uint32. `>>> 0` keeps them unsigned.
  const readU32 = (offset: number): number =>
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0;
  const width = readU32(16);
  const height = readU32(20);
  // Exact-size match against our own render (see the constants above).
  if (
    width !== EXPECTED_INSPECTION_WIDTH ||
    height !== EXPECTED_INSPECTION_HEIGHT
  ) {
    return false;
  }
  return true;
}

// State stamped onto the assistant message once round 0 produced an artifact.
// Every model starts `awaiting_client` so the client can drive compile repairs;
// maxRounds comes from the model's roster inspection rounds (Lite = 0 → no
// inspection, cheap draft).
export function initialLoopState(model: string): LoopState {
  const maxRounds = inspectionRoundsForModel(model);
  return {
    round: 0,
    maxRounds,
    repairs: 0,
    status: 'awaiting_client',
    tier: maxRounds > 0 ? 'premium' : 'lite',
  };
}

export function finalizeLoop(
  loop: LoopState,
  status: Extract<LoopStatus, 'final' | 'failed'> = 'final',
): LoopState {
  return { ...loop, status };
}

export type ContinuationResult =
  | { type: 'compile_error'; error: string }
  // Clean compile with nothing left to do — the client asks the server to close
  // the loop authoritatively (no LLM call, no spend) instead of only patching
  // the local mirror, so a stale awaiting_client row can't be reopened with a
  // fabricated compile error.
  | { type: 'compile_ok' }
  | { type: 'inspection'; imagePath: string };

// Structural validation of the untrusted continuation payload. Returns a typed
// result on success or an error string on any shape mismatch.
export function parseContinuationBody(body: unknown):
  | {
      ok: true;
      continuation: {
        conversationId: string;
        assistantMessageId: string;
        round: number;
        result: ContinuationResult;
      };
    }
  | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'missing continuation' };
  }
  const c = (body as { continuation?: unknown }).continuation;
  if (typeof c !== 'object' || c === null) {
    return { ok: false, error: 'missing continuation' };
  }
  const { conversationId, assistantMessageId, round, result } = c as Record<
    string,
    unknown
  >;
  if (typeof conversationId !== 'string' || !conversationId) {
    return { ok: false, error: 'invalid conversationId' };
  }
  if (typeof assistantMessageId !== 'string' || !assistantMessageId) {
    return { ok: false, error: 'invalid assistantMessageId' };
  }
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
    return { ok: false, error: 'invalid round' };
  }
  if (typeof result !== 'object' || result === null) {
    return { ok: false, error: 'invalid result' };
  }
  const r = result as Record<string, unknown>;
  if (r.type === 'compile_error') {
    if (typeof r.error !== 'string') {
      return { ok: false, error: 'invalid compile_error' };
    }
    return {
      ok: true,
      continuation: {
        conversationId,
        assistantMessageId,
        round,
        result: { type: 'compile_error', error: r.error },
      },
    };
  }
  if (r.type === 'compile_ok') {
    return {
      ok: true,
      continuation: {
        conversationId,
        assistantMessageId,
        round,
        result: { type: 'compile_ok' },
      },
    };
  }
  if (r.type === 'inspection') {
    if (typeof r.imagePath !== 'string' || !r.imagePath) {
      return { ok: false, error: 'invalid inspection' };
    }
    return {
      ok: true,
      continuation: {
        conversationId,
        assistantMessageId,
        round,
        result: { type: 'inspection', imagePath: r.imagePath },
      },
    };
  }
  return { ok: false, error: 'unknown result type' };
}

export type ContinuationDecision =
  // Run a code-gen repair round.
  | { action: 'repair' }
  // Run an inspection (review → maybe revision) round.
  | { action: 'inspect' }
  // Clean-compile close: claim then finalize the row, no LLM call, no spend.
  | { action: 'finalize_clean' }
  // Stop iterating. `finalize` = write a terminal loop state (caps reached);
  // otherwise the request is a stale / mismatched no-op that must not clobber
  // the current state.
  | { action: 'reject'; reason: string; finalize: boolean; httpStatus: number };

// Decide what a validated continuation should do given the persisted loop
// state. Caps are enforced here — never trust the client to stop.
export function decideContinuation(
  loop: LoopState,
  result: ContinuationResult,
  round: number,
): ContinuationDecision {
  if (loop.status !== 'awaiting_client') {
    // Already terminal or mid-review — nothing to drive, don't rewrite state.
    return {
      action: 'reject',
      reason: 'not_awaiting_client',
      finalize: false,
      httpStatus: 409,
    };
  }
  if (round !== loop.round) {
    // Client is out of sync with the server's round; ignore without clobbering.
    return {
      action: 'reject',
      reason: 'round_mismatch',
      finalize: false,
      httpStatus: 409,
    };
  }
  if (result.type === 'compile_ok') {
    // Nothing to compute — just close the loop authoritatively.
    return { action: 'finalize_clean' };
  }
  if (result.type === 'compile_error') {
    if (loop.repairs >= MAX_REPAIRS) {
      return {
        action: 'reject',
        reason: 'repairs_exhausted',
        finalize: true,
        httpStatus: 200,
      };
    }
    return { action: 'repair' };
  }
  // inspection — driven off the per-model round budget, not the tier enum, so
  // every vision model with maxRounds > 0 inspects and Lite (0) is skipped.
  if (loop.maxRounds <= 0) {
    return {
      action: 'reject',
      reason: 'inspection_disabled',
      finalize: true,
      httpStatus: 200,
    };
  }
  if (loop.round >= loop.maxRounds) {
    return {
      action: 'reject',
      reason: 'rounds_exhausted',
      finalize: true,
      httpStatus: 200,
    };
  }
  return { action: 'inspect' };
}

export type ReviewerVerdict =
  | { verdict: 'good'; finalMessage?: string }
  | { verdict: 'revise'; revisionInstructions: string }
  // The reply wasn't a usable verdict (no JSON, truncated/malformed JSON,
  // unknown verdict, or an empty "revise"). The CALLER decides what to do:
  // treat as a revision if rounds remain, else finalize — so a truncated JSON
  // no longer silently passes a bad model as 'good'.
  | { verdict: 'unparseable' };

// Defensively parse the reviewer's JSON-only reply. Extracts the first {...}
// block so leading prose or code fences don't break it. A clean 'good' / 'revise'
// is returned as-is; anything unusable returns 'unparseable'.
export function parseReviewerVerdict(raw: string): ReviewerVerdict {
  const unparseable: ReviewerVerdict = { verdict: 'unparseable' };
  if (typeof raw !== 'string' || !raw.trim()) return unparseable;

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return unparseable;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return unparseable;
  }
  if (typeof parsed !== 'object' || parsed === null) return unparseable;

  const obj = parsed as Record<string, unknown>;
  if (obj.verdict === 'revise') {
    const instructions =
      typeof obj.revision_instructions === 'string'
        ? obj.revision_instructions.trim()
        : '';
    // A "revise" with no actionable instructions can't drive a revision.
    if (!instructions) return unparseable;
    return { verdict: 'revise', revisionInstructions: instructions };
  }
  if (obj.verdict === 'good') {
    return typeof obj.final_message === 'string' && obj.final_message.trim()
      ? { verdict: 'good', finalMessage: obj.final_message.trim() }
      : { verdict: 'good' };
  }
  return unparseable;
}
