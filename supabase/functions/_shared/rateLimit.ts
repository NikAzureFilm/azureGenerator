// Best-effort in-memory sliding-window rate limiter. State is per edge
// function isolate, so the real-world ceiling is (limit x isolate count) —
// good enough to stop a single client from burning provider tokens in a
// tight loop without needing a database round-trip.

const buckets = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 10_000;

export function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = (buckets.get(key) ?? []).filter((t) => t > cutoff);

  if (timestamps.length >= limit) {
    buckets.set(key, timestamps);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((timestamps[0] + windowMs - now) / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }

  timestamps.push(now);
  buckets.set(key, timestamps);

  if (buckets.size > MAX_TRACKED_KEYS) {
    for (const [trackedKey, trackedTimestamps] of buckets) {
      if (trackedTimestamps.every((t) => t <= cutoff)) {
        buckets.delete(trackedKey);
      }
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}
