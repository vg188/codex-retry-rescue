import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const A = '01a10b14-5c28-71f1-be34-b511f6300973';
const B = '01a10b14-5c28-71f1-be34-b511f6300974';
const source = readFileSync(new URL('../user_scripts/codex-retry-rescue.js', import.meta.url), 'utf8');
function harness(storage = new Map(), { nativeWrite = false } = {}) {
  const env = { id: A, composer: { textContent: '' }, kind: 'send', submissions: 0, sleeps: [], timers: new Map(), seq: 0 };
  env.nativeWrite = nativeWrite;
  env.composer.focus = () => {};
  env.composer.dispatchEvent = event => { env.onInput({...event, target:env.composer}); return true; };
  const context = vm.createContext({
    window: { location: { pathname: '/' } },
    document: {
      querySelector: selector => selector === '[data-thread-find-target="conversation"]' ? env.content || null : env.id ? { getAttribute: () => `local:${env.id}` } : null,
      getElementById: () => env.host || null,
      createRange: () => ({selectNodeContents() {}}),
      execCommand(command, unused, text) {
        if (env.execCommandResult === false) return false;
        env.composer.textContent = text;
        // Chromium's execCommand creates a trusted input event, despite its JS caller.
        env.onInput({type:'input', isTrusted:true, target:env.composer});
        return true;
      },
    },
    InputEvent: class { constructor(type, options) { Object.assign(this, options, {type, isTrusted:false}); } },
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
    if (!env.nativeWrite) writeComposer = text => { env.composer.textContent = text; return true; };
    submitComposer = () => { env.submissions++; env.composer.textContent = ''; };
    clickNewChat = () => { env.id = null; env.composer = {textContent: ""}; return true; };
    markAllRetriesStale = () => {};
    markCurrentFatalsResidual = () => {};
    threadLen = () => 0;
    const realThreadRoot = threadRoot;
    threadRoot = () => env.root || realThreadRoot();
    window.testApi = {CONFIG, state, selfHostEnabled, setSelfHost, readThreadIdCheap, readCurrentThreadId,
      fireSelfHost, sendContinueNow, resumeByPrompt, syncThreadContext, saveSettings, quickNewChatResume, writeComposer, onComposerHuman,
      threadLenFrom, errorTextLeaves, isErrorTextLeaf, trackHighDemandBoxes, producedSinceRetry};
  })();`, context);
  env.onInput = context.window.testApi.onComposerHuman;
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


test('trusted execCommand input does not cancel automatic continuation', async () => {
  const h = harness(new Map(), {nativeWrite:true});
  h.api.setSelfHost(true);
  const humanAt = h.api.state.lastHumanInputAt;
  const p = h.api.sendContinueNow(true);
  assert.equal(h.env.composer.textContent, h.api.CONFIG.continueText);
  assert.equal(h.api.state.lastHumanInputAt, humanAt);
  assert.equal(h.api.state.composerWriteDepth, 0);
  await h.advance();
  await h.advance();
  assert.equal(await p, true);
  assert.equal(h.env.submissions, 1);
});

test('real trusted human input during the await still cancels submission', async () => {
  const h = harness(new Map(), {nativeWrite:true});
  h.api.setSelfHost(true);
  const p = h.api.sendContinueNow(true);
  assert.equal(h.api.state.sending, true);
  h.env.composer.textContent += ' human edit';
  h.api.onComposerHuman({type:'input', isTrusted:true, target:h.env.composer});
  assert.ok(h.api.state.lastHumanInputAt > 0);
  await h.advance();
  assert.equal(await p, false);
  assert.equal(h.env.submissions, 0);
  assert.ok(h.env.composer.textContent.endsWith(' human edit'));
});

test('trusted programmatic write does not cancel timer but real human input does', () => {
  const h = harness(new Map(), {nativeWrite:true});
  h.api.setSelfHost(true);
  const timer = h.api.state.selfHostTimer;
  assert.equal(h.api.writeComposer('continue'), true);
  assert.equal(h.api.state.selfHostTimer, timer);
  assert.equal(h.api.state.selfHostHold, false);
  h.api.onComposerHuman({type:'input', isTrusted:true, target:h.env.composer});
  assert.equal(h.api.state.selfHostTimer, 0);
  assert.equal(h.api.state.selfHostHold, true);
});

test('write guard is released after exceptions and fallback input', () => {
  const h = harness(new Map(), {nativeWrite:true});
  h.env.composer.focus = () => { throw new Error('focus failure'); };
  assert.throws(() => h.api.writeComposer('continue'), /focus failure/);
  assert.equal(h.api.state.composerWriteDepth, 0);
  h.env.composer.focus = () => {};
  h.env.execCommandResult = false;
  assert.equal(h.api.writeComposer('fallback'), true);
  assert.equal(h.env.composer.textContent, 'fallback');
  assert.equal(h.api.state.composerWriteDepth, 0);
  assert.equal(h.api.state.lastHumanInputAt, 0);
});

// ---- high demand 报错框（v0.15）------------------------------------------------
// 实测形态：aside > div > span.wrap-anywhere，文本 75 字符，比 growthEpsilon(40) 长。
// 它一旦被算成正文产出，重试会话 / 验收窗 / 耗尽证据会同时作废。
const HD = 'We’re currently experiencing high demand, which may cause temporary errors.';

class FakeEl {
  constructor(tag, { cls = '', text = '', kids = [] } = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.id = '';
    this.text = text;
    this.kids = kids;
    this.parent = null;
    for (const k of kids) k.parent = this;
  }
  get textContent() { return this.text + this.kids.map(k => k.textContent).join(''); }
  get children() { return this.kids; }
  set children(v) { this.kids = v; for (const k of v) k.parent = this; }
  descendants() {
    const out = [];
    for (const k of this.kids) { out.push(k); out.push(...k.descendants()); }
    return out;
  }
  querySelectorAll(sel) {
    const tags = sel.split(',').map(s => s.trim().toLowerCase());
    return this.descendants().filter(e => tags.includes(e.tagName.toLowerCase()));
  }
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some(s =>
      s.startsWith('#') ? this.id === s.slice(1)
        : s.startsWith('.') ? this.className.split(' ').includes(s.slice(1))
        : this.tagName.toLowerCase() === s);
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  contains(el) { for (let n = el; n; n = n.parent) if (n === this) return true; return false; }
}

/** 长度扫描带 500ms 缓存，测试里每读一次都要作废掉 */
const measure = h => { h.api.state.lenCacheAt = 0; return h.api.threadLenFrom([]); };

test('high demand box adds nothing to the output length and is not treated as produced content', () => {
  const h = harness();
  const prose = new FakeEl('div', { cls: 'min-w-0 text-size-chat', kids: [
    new FakeEl('span', { text: '好的，我接着把剩下的四百步跑完：先登记进度，再按每五十步一段提交结果，中途不再做阶段总结。' }),
  ] });
  const box = new FakeEl('aside', { cls: 'relative isolate bg-surface border', kids: [
    new FakeEl('div', { cls: 'min-w-0 flex-1', kids: [new FakeEl('span', { cls: 'wrap-anywhere', text: HD })] }),
  ] });
  const root = new FakeEl('div', { kids: [prose] });
  h.env.root = root;

  const beforeBox = measure(h);
  root.children = [prose, box];
  const withBox = measure(h);
  assert.equal(withBox, beforeBox, '报错框出现后长度必须不变');
  assert.equal(h.api.state.hdLeaves, 1);
  assert.equal(h.api.state.rlLeaves, 0);

  // 只取最小叶子：aside 和中间 div 都含同一句文案，重复扣字会把长度算负
  const leaves = h.api.errorTextLeaves();
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].tagName, 'SPAN');
  assert.equal(leaves[0].textContent, HD);

  // 这一条就是被打断取消的根因：lenAtRetryStart 在框出现之前，框出现后不许算产出
  h.api.state.lenAtRetryStart = beforeBox;
  h.api.state.len = withBox;
  assert.equal(h.api.producedSinceRetry(h.api.state, h.api.CONFIG), false);

  // 反例：真出了正文，producedSinceRetry 必须成立（修好了也不能把真产出看漏）
  const realOutput = new FakeEl('div', { cls: 'min-w-0 text-size-chat', kids: [
    new FakeEl('span', { text: '第一段：已登记 120 步进度，接下来按每五十步一段提交结果，中途不再做阶段总结。' }),
  ] });
  root.children = [prose, box, realOutput];
  h.api.state.len = measure(h);
  assert.equal(h.api.producedSinceRetry(h.api.state, h.api.CONFIG), true);
});

test('the same sentence quoted inside model prose stays counted', () => {
  const h = harness();
  const quote = new FakeEl('div', { cls: 'min-w-0 text-size-chat', kids: [
    new FakeEl('span', { text: `网关返回的原文是 ${HD}，这就是 high demand 的典型文案。` }),
  ] });
  const root = new FakeEl('div', { kids: [quote] });
  h.env.root = root;
  assert.equal(h.api.errorTextLeaves().length, 0);
  assert.equal(measure(h), root.textContent.length);
  assert.equal(h.api.state.hdLeaves, 0);
});

test('a newly mounted high demand box becomes this-turn evidence, base follows virtual scroll', () => {
  const h = harness();
  const s = h.api.state;
  s.highDemandBase = 0; s.highDemandHit = null;
  s.hdLeaves = 0;
  h.api.trackHighDemandBoxes();
  assert.equal(s.highDemandHit, null, '数量没变多不许当成本轮撞到');

  s.len = 5000;
  s.hdLeaves = 1;
  h.api.trackHighDemandBoxes();
  // 证据对象是在脚本自己的 vm realm 里 new 的，跨 realm 只能比字段不能比引用
  assert.equal(s.highDemandHit?.len, 5000);
  assert.equal(s.highDemandBase, 1);

  // 虚拟滚动把框摘掉：基准跟着下调，否则永远等不到「变多」；已记下的证据不许丢
  s.hdLeaves = 0;
  h.api.trackHighDemandBoxes();
  assert.equal(s.highDemandBase, 0);
  assert.ok(s.highDemandHit, '摘掉旧框不该作废本轮证据');
});
