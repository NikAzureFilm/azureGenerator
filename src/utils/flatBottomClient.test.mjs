/**
 * The cut sits on the viewer's critical path — the model is not shown until it
 * resolves — so every request MUST settle, including when the worker never
 * replies. These tests drive the real client against a stub Worker.
 *
 * Run: node --experimental-strip-types src/utils/flatBottomClient.test.mjs
 */

import assert from 'node:assert/strict';

// --- Stub Worker -----------------------------------------------------------

const workers = [];

class StubWorker {
  constructor() {
    this.listeners = new Map();
    this.posted = [];
    this.terminated = false;
    workers.push(this);
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  postMessage(message) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  /** Reply to the request at `index` as the worker would. */
  reply(index, outcome) {
    this.emit('message', {
      data: { type: 'result', requestId: this.posted[index].requestId, outcome },
    });
  }
}

globalThis.Worker = StubWorker;

const OK = {
  status: 'ok',
  cutY: 0,
  cutFraction: 0.05,
  contactArea: 1,
  meshes: [null],
  uncutCount: 0,
};

const mesh = () => [
  {
    vertProperties: new Float32Array([0, 0, 0]),
    triVerts: new Uint32Array([0, 0, 0]),
    numProp: 3,
  },
];

const { computeFlatBottom } = await import('./flatBottomClient.ts');

const settled = (promise) => {
  let done = false;
  promise.then(() => {
    done = true;
  });
  return () => done;
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A normal round trip resolves with the worker's outcome.
{
  const promise = computeFlatBottom(mesh());
  const worker = workers[workers.length - 1];
  assert.equal(worker.posted.length, 1, 'the request should be posted');
  worker.reply(0, OK);
  assert.equal((await promise).status, 'ok');
}

// The worker registers the failure listeners, not just 'message'.
{
  const worker = workers[workers.length - 1];
  assert.ok(worker.listeners.has('message'));
  assert.ok(worker.listeners.has('error'), 'must listen for worker errors');
  assert.ok(
    worker.listeners.has('messageerror'),
    'must listen for unreadable results',
  );
}

// A worker that errors instead of replying still settles the caller, so the
// viewer never waits forever on a broken worker chunk.
{
  const promise = computeFlatBottom(mesh());
  const broken = workers[workers.length - 1];
  broken.emit('error', { message: 'Failed to load worker chunk' });

  const outcome = await promise;
  assert.equal(outcome.status, 'error');
  assert.match(outcome.message, /Failed to load worker chunk/);
  assert.ok(broken.terminated, 'the broken worker should be torn down');
}

// ...and the next request recovers on a fresh worker rather than queueing
// behind the dead one forever.
{
  const before = workers.length;
  const promise = computeFlatBottom(mesh());
  assert.equal(workers.length, before + 1, 'a fresh worker should be created');
  const fresh = workers[workers.length - 1];
  assert.equal(fresh.posted.length, 1, 'the request should reach it');
  fresh.reply(0, OK);
  assert.equal((await promise).status, 'ok');
}

// An unreadable result settles as an error too.
{
  const promise = computeFlatBottom(mesh());
  workers[workers.length - 1].emit('messageerror', {});
  assert.equal((await promise).status, 'error');
}

// Latest-wins: a second call supersedes the first, and the first settles
// immediately rather than hanging.
{
  const first = computeFlatBottom(mesh());
  const isFirstSettled = settled(first);
  const second = computeFlatBottom(mesh());
  await tick();
  assert.ok(isFirstSettled(), 'the superseded call must settle straight away');
  assert.equal((await first).status, 'superseded');

  // The second request is queued behind the in-flight first; replying to the
  // first should release it.
  const worker = workers[workers.length - 1];
  worker.reply(0, OK);
  await tick();
  assert.equal(worker.posted.length, 2, 'the queued request should be posted');
  worker.reply(1, OK);
  assert.equal((await second).status, 'ok');
}

// A request queued behind a worker that then dies is retried on a fresh
// worker rather than being stranded in the queue.
{
  const first = computeFlatBottom(mesh());
  const second = computeFlatBottom(mesh());
  assert.equal((await first).status, 'superseded');

  const dying = workers[workers.length - 1];
  const workersBefore = workers.length;
  dying.emit('error', { message: 'died mid-cut' });
  await tick();

  assert.equal(
    workers.length,
    workersBefore + 1,
    'the queued request should be retried on a fresh worker',
  );
  const retry = workers[workers.length - 1];
  assert.equal(retry.posted.length, 1, 'the queued request should be posted');

  const isSecondSettled = settled(second);
  retry.reply(0, OK);
  await tick();
  assert.ok(isSecondSettled(), 'the retried request should settle');
  assert.equal((await second).status, 'ok');
}

console.log('flatBottomClient tests passed');
