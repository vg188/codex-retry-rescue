import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const A = '01a10b14-5c28-71f1-be34-b511f6300973';
const B = '01a10b14-5c28-71f1-be34-b511f6300974';
const source = readFileSync(new URL('../user_scripts/codex-retry-rescue.js', import.meta.url), 'utf8');
function harness(storage = new Map()) {
  const env = { id: A, composer: { textContent: '' }, kind: 'send', submissions: 0, sleeps: [], timers: new Map(), seq: 0 };
  const context = vm.createContext({
    window: { location: { pathname: '/' } },
    document: { querySelector: selector => selector === '[data-thread-find-target="conversation"]' ? env.content || null : env.id ? { getAttribute: () => `local:${env.id}` } : null },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    console: { log() {} },
    setTimeout(fn, ms) { if (ms < 1000) { env.sleeps.push(fn); return ++env.seq; } const id = ++env.seq; env.timers.set(id, fn); return id; },
    clearTimeout(id) { env.timers.delete(id); },
    env,
  });
  // Execute production definitions, omitting browser bootstrap/UI mounting only.
  const definitions = source.slice(0, source.indexOf('  // ------------------------------------------------------------------ 启动'));
  vm.runInContext(definitions + `
    findComposer = () => env.composer;
    buttonState = () => ({kind: env.kind});
    writeComposer = text => { env.composer.textContent = text; return true; };
    submitComposer = () => { env.submissions++; env.composer.textContent = ''; };
    clickNewChat = () => { env.id = null; env.composer = {textContent: ""}; return true; };
    markAllRetriesStale = () => {};
    markCurrentFatalsResidual = () => {};
    threadLen = () => 0;
    window.testApi = {CONFIG, state, selfHostEnabled, setSelfHost, readThreadIdCheap, readCurrentThreadId,
      fireSelfHost, sendContinueNow, resumeByPrompt, syncThreadContext, saveSettings, quickNewChatResume};
  })();`, context);
  return { env, api: context.window.testApi, context, storage,
    async advance() { assert.ok(env.sleeps.length, 'pending sleep'); env.sleeps.shift()(); await Promise.resolve(); await Promise.resolve(); } };
}

test('per-thread persistence, fresh IDs, no stale fallback, independent disable', () => {
  const h = harness();
  assert.equal(h.api.readCurrentThreadId(), A);
  h.api.setSelfHost(true);
  h.env.id = B;
  assert.equal(h.api.selfHostEnabled(), false);
  assert.equal(h.api.readCurrentThreadId(), B);
  h.api.setSelfHost(true);
  h.env.id = A;
  h.api.setSelfHost(false);
  h.env.id = B;
  assert.equal(h.api.selfHostEnabled(), true);
  const reloaded = harness(h.storage);
  assert.equal(reloaded.api.selfHostEnabled(), false);
  reloaded.env.id = B;
  assert.equal(reloaded.api.selfHostEnabled(), true);
  h.env.id = null;
  assert.equal(h.api.readCurrentThreadId(), null);
  assert.equal(h.api.setSelfHost(true), false);
  h.env.id = `client-new-thread:${A}`;
  assert.equal(h.api.readCurrentThreadId(), null);
});

test('old global true is not inherited; global saves preserve thread preferences', () => {
  const h = harness(new Map([['codexRetryRescue.settings', '{"selfHost":true}']]));
  assert.equal(h.api.selfHostEnabled(), false);
  h.api.setSelfHost(true);
  h.api.saveSettings();
  assert.equal(JSON.parse(h.storage.get('codexRetryRescue.settings')).selfHost, undefined);
  assert.equal(h.api.selfHostEnabled(), true);
});

test('old timer cannot send into another enabled thread, before a polling tick', async () => {
  const h = harness();
  h.api.setSelfHost(true);
  const callback = h.env.timers.get(h.api.state.selfHostTimer);
  h.env.id = B;
  h.api.setSelfHost(true);
  const newTimer = h.api.state.selfHostTimer;
  callback();
  assert.equal(h.api.state.selfHostTimer, newTimer);
  await Promise.resolve();
  assert.equal(h.env.sleeps.length, 0);
  assert.equal(h.env.submissions, 0);
});

for (const mutation of ['switch', 'disable', 'dispose', 'human', 'composer', 'selfHostOff']) {
  test(`pending automatic send aborts on ${mutation}`, async () => {
    const h = harness();
    h.api.setSelfHost(true);
    const sending = h.api.sendContinueNow(true);
    if (mutation === 'switch') h.env.id = B;
    if (mutation === 'disable') h.api.CONFIG.enabled = false;
    if (mutation === 'dispose') h.api.state.disposed = true;
    if (mutation === 'human') h.api.state.lastHumanInputAt = 1;
    if (mutation === 'composer') h.env.composer = { textContent: '继续' };
    if (mutation === 'selfHostOff') h.api.setSelfHost(false);
    await h.advance();
    assert.equal(await sending, false);
    assert.equal(h.env.submissions, 0);
    assert.equal(h.api.state.sending, false);
  });
}

test('double click cannot submit twice', async () => {
  const h = harness();
  const first = h.api.sendContinueNow();
  assert.equal(await h.api.sendContinueNow(), false);
  await h.advance();
  await h.advance();
  assert.equal(await first, true);
  assert.equal(h.env.submissions, 1);
});

test('paused and destroyed self-host callbacks cannot send or rearm', async () => {
  for (const key of ['paused', 'disposed']) {
    const h = harness();
    h.api.setSelfHost(true);
    h.env.timers.clear();
    if (key === 'paused') h.api.CONFIG.enabled = false;
    else h.api.state.disposed = true;
    await h.api.fireSelfHost(A);
    assert.equal(h.env.submissions, 0);
    assert.equal(h.env.timers.size, 0);
  }
});

test('switching to no-ID clears timer and turn evidence even when paused', () => {
  const h = harness();
  h.api.state.currentThreadId = A;
  h.api.setSelfHost(true);
  h.api.state.turnExhausted = {};
  h.api.state.selfHostHold = true;
  h.api.CONFIG.enabled = false;
  h.env.id = null;
  h.api.syncThreadContext();
  assert.equal(h.api.state.selfHostTimer, 0);
  assert.equal(h.api.state.turnExhausted, null);
  assert.equal(h.api.state.currentThreadId, null);
  assert.equal(h.api.state.selfHostHold, false);
});

test('exhausted continuation submits once even when immediately idle again', async () => {
  const h = harness();
  const p = h.api.resumeByPrompt();
  await h.advance();
  assert.equal(await p, true);
  assert.equal(h.env.submissions, 1);
  assert.equal(h.env.sleeps.length, 0);
});

test('draft is never overwritten and running turns cannot receive manual continuation', async () => {
  const h = harness();
  h.env.composer.textContent = 'my draft';
  assert.equal(await h.api.sendContinueNow(), false);
  assert.equal(h.env.composer.textContent, 'my draft');
  h.env.composer.textContent = '';
  h.env.kind = 'stop';
  assert.equal(await h.api.sendContinueNow(), false);
  assert.equal(h.env.submissions, 0);
});


test('temporary sidebar ID resolves only through matching bounded content ancestry', () => {
  const h = harness();
  h.env.id = 'client-new-thread:94e7b621-9841-440d-9dbe-96bca6ccceef';
  h.env.content = {__reactFiber$test: {memoizedProps: {}, return: {
    memoizedProps: {conversationId: A}, return: {memoizedProps: {clientThreadId: h.env.id}}
  }}};
  assert.equal(h.api.readCurrentThreadId(), A);
  h.api.setSelfHost(true);
  assert.equal(h.api.selfHostEnabled(), true);
  h.env.id = 'client-new-thread:another';
  assert.equal(h.api.readCurrentThreadId(), null);
  h.env.id = B;
  assert.equal(h.api.readCurrentThreadId(), null);
  h.env.id = A;
  assert.equal(h.api.readCurrentThreadId(), A);
});

test('cyclic React ancestry stays bounded and cannot invent an ID', () => {
  const h = harness();
  const fiber = { memoizedProps: {} }; fiber.return = fiber;
  h.env.content = { __reactFiber$test: fiber };
  h.env.id = null;
  assert.equal(h.api.readCurrentThreadId(), null);
});


test('quick resume does not populate a different conversation selected during wait', async () => {
  const h = harness();
  const p = h.api.quickNewChatResume();
  assert.equal(h.api.state.busy, true);
  h.env.id = B;
  await h.advance();
  await p;
  assert.equal(h.env.composer.textContent, '');
  assert.equal(h.env.submissions, 0);
  assert.equal(h.api.state.busy, false);
});

test('quick resume fills only the new-chat draft without submitting', async () => {
  const h = harness();
  const p = h.api.quickNewChatResume();
  await h.advance();
  await p;
  assert.ok(h.env.composer.textContent.includes(A));
  assert.equal(h.env.submissions, 0);
  assert.equal(h.api.state.busy, false);
});

test('exhausted continuation aborts after switching conversations', async () => {
  const h = harness();
  const p = h.api.resumeByPrompt();
  h.env.id = B;
  await h.advance();
  assert.equal(await p, false);
  assert.equal(h.env.submissions, 0);
});
