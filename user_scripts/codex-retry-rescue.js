// ==UserScript==
// @name         Codex Retry Rescue
// @version      0.11.1
// @description  Codex 断流/限流/会话死亡自动救援：重试逼近上限时打断并继续刷新预算，400 类死会话自动开新对话接续，带状态条与后台看门狗
// ==/UserScript==
//
// 背景：上游通道池满载时（网关侧常见的 get_channel_failed / high demand），Codex
// 会指数退避重试到 stream_max_retries 就放弃，整个 turn 作废。本脚本在重试逼近上限
// 前打断，让重试预算归零，直到某一轮真正挤进通道。
//
// ⚠ 换服务商先改这里：CONFIG.platform 一节集中放了「报错文案长什么样」的正则
//   （重试行 / 限流 / 会话已死 / 错误框容器）。这些是从作者自己那条链路上实测来的，
//   别的网关文案多半不同，不改就是「认不出来」而不是「认错」。
//
// 两条恢复路径（行为由实际使用观察得出）：
//   A 主动打断后 —— 按钮变「继续」，点它即可，不必重发 prompt，重试次数归零。
//   B 重试自然耗尽后 —— 报错，按钮变「发送」，此时必须往输入框写内容才能触发
//     新一轮，写 "继续" 即可（不重发原始 prompt，避免让模型从头再做一遍）。
//
// 0.9.1 按错误类型分流：
//   * high demand / 上游地址失败 / 一般重连 → 仍做预防性打断（跳号+验收窗）
//   * rate limit / token rate limit / 429  → 不做预防性打断，等 10/10 耗尽再发「继续」
//     （限流时打断+继续等于继续加请求，等耗尽更稳）
//
// 实测要点（都是踩过的坑，改动前先读）：
//   * 重试次数是滚动数字动画，textContent 读出来是 "0123456789"，真值在
//     span[aria-label] 上。直接正则匹配文本会永远匹配不到，且不会报错。
//   * 界面可能被汉化，中英文都要认。
//   * 历史重试行会永久留在 transcript 里且冻结不变。「最后一条重试行」既可能是
//     正在进行的重试，也可能是上一轮的残留 —— 只靠它做判断会误触发。0.5 起用
//     「重试会话」判定：只有本 turn 内次数爬升过（或新行刚出现）才算活跃重试；
//     爬升停止超过 sessionIdleMs、一旦内容开始产出、或脚本动过手，会话结束。
//     会话外的冻结高次数行（含上次接管留下的 7~9）永远不会触发打断 —— 否则
//     模型长时间思考（无输出滚动）时会被残留计数误判成正在重试。
//   * 输入框/发送/停止/继续 是同一个 composer 按钮，靠 aria-label 区分状态；
//     不要全局扫 button，顶部工具栏的「创建文件或站点」也带同样的 class 片段。
//   * 绝对不要用 MutationObserver 驱动这个脚本：状态条自身在被观察的树里，
//     改它 -> 触发观察器 -> 又改它，而观察器回调是微任务，这个环永远不让出
//     事件循环，渲染进程主线程会直接饿死。主定时器用 setInterval；窗口
//     最小化/后台时 Chromium 会掐紧主线程 setInterval，所以再挂一个 Worker
//     时钟兜底，并在 visibilitychange 回前台时立刻补一拍。
//   * 窗口最小化后 getBoundingClientRect() 常塌成 0×0，按几何判断 visible() 会
//     让所有按钮「不可见」，救援直接哑掉。可见性判断必须先问「布局是否可用」。

(() => {
  if (window.top && window.self && window.top !== window.self) return;

  const API_KEY = "__codexRetryRescue";
  const BADGE_ID = "codex-retry-rescue-badge";
  const PANEL_ID = "codex-retry-rescue-panel";
  const HOST_ID = "codex-retry-rescue-host";
  const QUICK_BTN_ID = "codex-retry-rescue-quick";
  const CONT_BTN_ID = "codex-retry-rescue-cont";
  const SELF_HOST_ID = "codex-retry-rescue-selfhost";

  // 热重载幂等：先拆掉上一版
  const previous = window[API_KEY];
  if (previous && typeof previous.destroy === "function") {
    try { previous.destroy(); } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------------ 配置
  const CONFIG = {
    // 预防性打断（high demand / 上游断流）：跳号 + 验收窗 + 随机临界
    enablePreventiveRescue: true,
    // rate limit 时禁止预防性打断，只等 10/10 耗尽后发「继续」
    skipPreventiveOnRateLimit: true,
    thresholds: [7, 8, 9],
    confirmWindowMs: [3000, 4000],
    settleMs: [200, 600],
    resumeDelayMs: [2500, 7000],
    postRateLimitResumeMs: [1000, 3000],
    continueText: "继续",
    // 快捷键：发送 continueText。alt+ctrl+c（Continue）
    sendContinueHotkey: { ctrl: true, alt: true, key: "c" },
    // 自托管：每轮正常结束后自动发「继续」。延迟随机 30–300s，避开固定节奏。
    // 有输入 / 切会话 / 手动发送则取消本轮，不抢人工。
    selfHost: false,
    selfHostDelayMs: [30000, 300000],
    // 延迟取值向小端倾斜：越大越难抽到（skew 越大越集中在下限）
    selfHostDelaySkew: 2.5,
    quietMs: 4000,
    growthEpsilon: 40,
    minRescueGapMs: 15000,
    sessionIdleMs: 30000,
    maxRounds: 30,
    // ---- 400/会话已死：原地「继续」救不回来，只能开新对话接活 ----
    // 错误文案长什么样见下方 platform.fatalText；这里只管「哪些状态码算会话已死」。
    // 注意：不与重试救援混用。重试是流断了还能原地续；这是请求本身被拒。
    fatalCodes: [400, 413, 422],
    maxMigrations: 3,
    // 400 迁移前的静默确认。打开历史报错对话时，错误框会立刻出现，
    // 必须等一会并复核仍在，才允许开新聊天 —— 否则一点旧会话就自动迁移。
    fatalConfirmMs: 8000,
    // 只带「去读旧对话」，不做简报摘录（新会话自己按需读）
    migratePrompt: "读取{threadId}，继续",
    // CDP 看门狗存活探测（脚本只探测、不自动拉起；需要时手动跑 start-retry-watchdog.cmd）
    watchdogPingUrl: "http://127.0.0.1:57328/ping",
    pollMs: 700,
    enabled: true,
    // 指示器位置，存的是距右下角的偏移量而不是绝对坐标 —— 这样窗口缩放后
    // 它仍然贴在原来的角落附近，不会跑到屏幕外
    pos: { right: 14, bottom: 76 },

    // ====================================================== 平台适配（换服务商先看这里）
    // 下面几条「报错长什么样」是从作者自己那条链路上实测出来的，换一家网关/模型基本都要改。
    // 全部是正则字符串（注意 JSON 式的双反斜杠），改完热重载生效；改错了不会让脚本起不来，
    // 只会退化成「认不出来」——宁可不救，也不要点错。
    platform: {
      // 重试行的文案。中英都留着，界面可能被汉化。用来认「正在重新连接 8/10」这类行。
      retryText: "正在重新连接|重新连接|Reconnecting|Reconnect",
      // 限流文案。命中即当作 rate limit：不做预防性打断，等 10/10 耗尽后再发「继续」。
      rateLimitText: "rate\\s*limit|token\\s*rate\\s*limit|\\b429\\b|限流|超出.{0,6}限",
      // 「本次请求被拒、这个会话已经救不回来」的文案。必须有第 1 个捕获组给出 3 位 HTTP 状态码，
      // 状态码再拿去和上面的 fatalCodes 比。换服务商时先照抄界面原文再改这里的数字部分。
      fatalText: "bad response status code\\s*(\\d{3})",
      // 从同一段文案里抠出请求标识，用来去重（同一 request id 只迁一次）。
      // 你的报错里没有这种字段就留空字符串 ""，脚本会退回用文本前缀去重。
      fatalRequestId: "request id:\\s*([^)\\s]+)",
      // 错误框的 DOM 特征：逗号分隔的 CSS 选择器，节点自身或其祖先命中任意一条才算错误框。
      // 这条是防「正文里偶然出现 400 就被当成会话已死」的关键，换皮时通常要跟着改。
      fatalContainers: "aside,.wrap-anywhere",
    },
  };

  // 平台文案统一在这里编译成正则；写坏了就退化成永不匹配，不能连累整个脚本。
  const toRe = (src, flags) => {
    try { return src ? new RegExp(src, flags) : /(?!)/; } catch (_) { return /(?!)/; }
  };
  const RETRY_RE = toRe(CONFIG.platform.retryText);
  const RATE_LIMIT_RE = toRe(CONFIG.platform.rateLimitText);
  const FATAL_ERR_RE = toRe(CONFIG.platform.fatalText, "i");
  const FATAL_REQ_ID_RE = toRe(CONFIG.platform.fatalRequestId, "i");
  const FATAL_CONTAINER_SEL = (CONFIG.platform.fatalContainers || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  // 幂次加权抽样：把均匀值取 skew 次幂，结果向 lo 聚拢，skew>1 时 hi 附近概率单调变小
  const randSkew = (lo, hi, skew) => lo + Math.pow(Math.random(), skew) * (hi - lo);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // -------------------------------------------------------------- 设置持久化
  // 面板里改的值要能扛过 Codex 重启，否则每次重载都得重调一遍。
  // 阈值不在持久化范围内 —— 它是逻辑正确性的一部分（见上面的注释），不该被随手改掉。
  const SETTINGS_KEY = "codexRetryRescue.settings";
  const PERSISTED = ["enabled", "maxRounds", "quietMs", "continueText", "pos", "sessionIdleMs",
    "migratePrompt", "maxMigrations", "fatalConfirmMs", "selfHost"];

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const k of PERSISTED) {
        if (saved[k] !== undefined) CONFIG[k] = saved[k];
      }
    } catch (_) { /* 没有 localStorage 或数据损坏都不该影响主流程 */ }
  }

  function saveSettings() {
    try {
      const out = {};
      for (const k of PERSISTED) out[k] = CONFIG[k];
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
    } catch (_) { /* ignore */ }
  }

  loadSettings();

  const state = {
    round: 0,
    threshold: pick(CONFIG.thresholds),
    busy: false,          // 正在执行一次救援，避免重入
    engaged: false,       // 这轮是不是我们在管；防止劫持用户自己的手动打断
    activeRetryEl: null,  // turn 运行期间看到的那条活跃重试行
    armed: false,         // 只有「活跃重试会话」才武装；启动时绝不能被残留行武装
    actedRetryEl: null,
    actedAtN: Infinity,
    lastRescueAt: 0,
    // 内容流动追踪：用来区分「正在重试」和「已重连正在输出」
    len: 0,
    lastGrowthAt: 0,
    lenAtRetryStart: null,
    // 重试会话：本 turn 内次数爬升过才算真在重试
    retrySession: false,
    sessionLastNAt: 0,    // 最近一次观测到次数变化/新活跃行的时间
    seenN: new Map(),     // el -> 上次读到的 n，用来识别「次数爬升」
    staleEls: new WeakSet(), // 已确认是历史残留 / 已处理过的行
    // 本轮「重试打满」的证据。必须是 turn 级的：10/10 之后再也不会爬升，
    // 若只挂在 activeRetryEl 上，sessionIdleMs 空闲超时会先把它清掉，
    // 等按钮回到发送态（真正该续跑的时刻）判定已经失效了。
    turnExhausted: null,
    prevBtnKind: null,    // 识别 turn 边界（send/continue -> stop）
    status: "idle",
    panelOpen: false,
    panelSig: "",
    log: [],
    timer: 0,
    worker: null,
    workerUrl: "",
    badgeSig: "",
    lastKickAt: 0,
    // 死会话迁移：同一 request id 只迁一次；整脚本最多迁 maxMigrations 次
    migrations: 0,
    actedErrKeys: new Set(),
    // 启动时/turn 开始前就躺在 transcript 里的 400 —— 绝不能当成本 turn 新故障
    residualErrKeys: new Set(),
    // 本 turn 是否真的跑起来过（见过停止钮）。没跑过就不要因历史 400 去开新聊天
    sawRunningTurn: false,
    lastThreadId: null,
    // turn 运行期间打到的 thread id 快照。迁移时优先用它 ——
    // 迁移会切到新聊天，那时再读会读到新会话/别的会话的 id。
    turnThreadId: null,
    // 当前会话 id（用于检测「你手动切到了另一条对话」）
    currentThreadId: null,
    // 400 延迟确认：先记下候选，等 fatalConfirmMs 仍存在才动手
    pendingFatalKey: null,
    pendingFatalAt: 0,
    tidCache: null,
    tidCacheAt: 0,
    rateLimitCache: false,
    rateLimitCacheAt: 0,
    fatalCache: null,
    fatalCacheAt: 0,
    selfHostAt: 0,
    selfHostTimer: 0,
    // 人工取消后本 turn 不再排期，避免「取消→下一拍又 arm」看起来像读秒被重置
    selfHostHold: false,
    lastHumanInputAt: 0,
    selfHostOn: false,
    tidCheap: null,
    tidCheapAt: 0,
    candsCache: null,
    candsCacheAt: 0,
    lenCache: 0,
    lenCacheAt: 0,
    watchdogAlive: false,
    watchdogCheckedAt: 0,
    watchdogTimer: 0,
    // 跳号后成功验收窗：证实「上一发失败」后，给「刚起来这一发」几秒证明自己
    confirmAt: 0,
    confirmUntil: 0,
    confirmLen: 0,
    confirmN: 0,
    confirming: false,
    sawRateLimitAt: 0,
  };

  function note(msg) {
    state.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.log.length > 200) state.log.shift();
    console.log("[retry-rescue]", msg);
  }

  // -------------------------------------------------------------- DOM 读取
  function findComposer() {
    return document.querySelector("[data-codex-composer]")
        || document.querySelector(".ProseMirror[contenteditable='true']")
        || document.querySelector("[role='textbox'][contenteditable='true']")
        || document.querySelector("[contenteditable='true']")
        || document.querySelector("textarea");
  }

  /**
   * 窗口最小化 / 后台时布局几何不可信（rect 塌成 0×0，或页面 visibilityState=hidden）。
   * 此时不能用 getBoundingClientRect 判可见，否则 composer 按钮全部「消失」，
   * 救援链路直接断掉 —— 这就是「窗口缩小/最小化后不再后台重试」的主因之一。
   */
  function layoutUsable() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
    if (window.innerWidth <= 0 || window.innerHeight <= 0) return false;
    // 有的最小化形态仍保留 innerWidth/Height，但整页 body 的 rect 已塌成 0
    try {
      const br = document.body?.getBoundingClientRect?.();
      if (br && br.width === 0 && br.height === 0) return false;
    } catch (_) { /* ignore */ }
    return true;
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (!layoutUsable()) return true;
    const r = el.getBoundingClientRect();
    // 个别最小化形态仍保留 innerWidth/Height，但子节点 rect 全是 0 —— 一并放过
    if (r.width === 0 && r.height === 0) {
      // 正常布局下 0×0 才是真的不可见
      return false;
    }
    return r.width > 0 && r.height > 0;
  }

  /** 布局塌掉时的「可见」策略：只要求节点还在文档里 */
  function effectivelyVisible(el) {
    if (!el || !el.isConnected) return false;
    return layoutUsable() ? visible(el) : true;
  }

  /**
   * composer 那个圆形动作按钮，发送/停止/继续都是它。
   * 以输入框为锚点向上限定范围，避免命中顶部工具栏那颗同 class 的按钮。
   */
  function composerButton() {
    const input = findComposer();
    if (!input) return null;
    let scope = input.parentElement;
    for (let i = 0; i < 8 && scope; i++) {
      const legacy = [...scope.querySelectorAll('[class*="size-token-button-composer"]')]
        .find(effectivelyVisible);
      if (legacy) return legacy;

      const byStateLabel = [...scope.querySelectorAll("button[aria-label], button[data-testid]")]
        .find(b => effectivelyVisible(b) && /(停止|中断|继续|发送|Stop|Interrupt|Resume|Continue|Send)/i.test(
          `${b.getAttribute("aria-label") || ""} ${b.getAttribute("data-testid") || ""}`,
        ));
      if (byStateLabel) return byStateLabel;
      scope = scope.parentElement;
    }
    return null;
  }

  /**
   * 按钮状态。只正面识别已实测确认的 label，其余归为 unknown ——
   * 千万不要把「排队」之类未知态当成「继续」去点（0.7.1 修）。
   */
  function buttonState() {
    const btn = composerButton();
    if (!btn) return { kind: null, btn: null, label: "" };
    const label = (btn.getAttribute("aria-label") || "").trim();
    let kind;
    if (/停止|中断|Stop|Interrupt/i.test(label)) kind = "stop";
    else if (/发送|Send/i.test(label)) kind = "send";
    else if (/继续|恢复|Continue|Resume/i.test(label)) kind = "continue";
    else kind = "unknown";
    return { kind, btn, label };
  }

  /** 当前对话根节点。新版 Codex 偶尔会改 data 属性，所以这里集中兜底 */
  function threadRoot() {
    return document.querySelector("[data-thread-find-target]")
        || document.querySelector("[data-turn-key]")?.parentElement
        || document.querySelector("main")
        || document.body;
  }

  function retryCandidates() {
    // 长对话下 querySelector 很贵；500ms 内复用
    const t = now();
    if (state.candsCache && t - state.candsCacheAt < 500) return state.candsCache;
    const root = threadRoot();
    if (!root) { state.candsCache = []; state.candsCacheAt = t; return []; }

    const minimal = nodes => nodes.filter(el => ![...el.children].some(c => RETRY_RE.test(c.textContent || "")));

    // 2026-08 的 Codex 把 activity 文本放在 span.text-size-chat 叶子里；父 div 也含重试文本，
    // 但会被「最小节点」过滤掉。旧版只扫 div，因此真实页面上 readRetry() 会返回 null。
    const classBased = minimal([...root.querySelectorAll(
      "div.min-w-0.text-size-chat, div[class*='text-size-chat'], span[class*='text-size-chat']",
    )].filter(el => {
      if (el.id === HOST_ID || el.closest?.(`#${HOST_ID}`)) return false;
      return RETRY_RE.test(el.textContent || "");
    }));
    if (classBased.length) {
      state.candsCache = classBased;
      state.candsCacheAt = t;
      return classBased;
    }

    // 类名再变时的兜底：扫对话区里的元素，只保留「最小」匹配节点，避免拿到整段 transcript 容器。
    const fallback = minimal([...root.querySelectorAll("div, span, p, [role='status'], [aria-live]")]
      .filter(el => {
        if (el.id === HOST_ID || el.closest?.(`#${HOST_ID}`)) return false;
        return RETRY_RE.test(el.textContent || "");
      }));
    state.candsCache = fallback;
    state.candsCacheAt = t;
    return fallback;
  }

  function parseRetryCount(el) {
    const text = el.textContent || "";
    let n = null;
    let max = null;

    for (const s of el.querySelectorAll("span[aria-label], [aria-valuenow], [aria-valuemax]")) {
      const label = [s.getAttribute("aria-label"), s.getAttribute("aria-valuenow")].filter(Boolean).join(" ");
      const m = label.match(/\d{1,3}/);
      if (n == null && m) n = parseInt(m[0], 10);
      const mx = s.getAttribute("aria-valuemax") || (label.match(/(?:\/|of|共)\s*(\d{1,3})/i)?.[1]);
      if (max == null && mx) max = parseInt(mx, 10);
    }

    const pair = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    if (pair) {
      if (n == null) n = parseInt(pair[1], 10);
      if (max == null) max = parseInt(pair[2], 10);
    }
    if (max == null) {
      const m = text.match(/(?:\/|of|共)\s*(\d{1,3})\s*$/i);
      if (m) max = parseInt(m[1], 10);
    }

    if (n == null || max == null || n > max) return null;
    return { n, max };
  }

  /** 重试指示器。取 DOM 顺序最后一条；次数优先取 aria，避免滚动数字污染 textContent */
  function readRetryFrom(cands) {
    let last = null;
    for (const el of cands) last = el;
    if (!last) return null;
    const count = parseRetryCount(last);
    if (!count) return null;
    return { ...count, el: last };
  }

  function readRetry() {
    return readRetryFrom(retryCandidates());
  }

  /**
   * 错误文案叶节点（限流 / 会话已死）。
   * 这里故意不要求它在 aside 容器里 —— 同一段报错在界面上会出现两份（错误框里一份、
   * 会话条目里一份），只要像报错文案就不该算成模型产出。容器约束是给 400 迁移用的
   * （那边认错代价是乱开新聊天），这边漏扣一百字最多让「没产出」更容易成立。
   *
   * 不缓存：报错框出现的那一拍必须同时把它从长度里扣掉。缓存过期会让 len 先跳一百多字
   * 再落回去，而那一跳正好足够把「本轮耗尽证据」误判成「已产出」永久清掉。
   * 实测整棵对话树扫一遍约 1ms，而调用方 threadLenFrom 本身已有 500ms 缓存。
   */
  function isErrorTextLeaf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === HOST_ID || el.closest?.(`#${HOST_ID}`)) return false;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 400) return false;
    if (!FATAL_ERR_RE.test(t) && !RATE_LIMIT_RE.test(t)) return false;
    return ![...el.children].some(c => {
      const s = c.textContent || "";
      return FATAL_ERR_RE.test(s) || RATE_LIMIT_RE.test(s);
    });
  }

  function errorTextLeaves() {
    const out = [];
    const root = threadRoot();
    if (!root) return out;
    for (const el of root.querySelectorAll("span, div, aside, pre, code")) {
      if (isErrorTextLeaf(el)) out.push(el);
    }
    return out;
  }

  function subtractTextLen(root, el) {
    if (!root || !el || !root.contains(el)) return 0;
    return (el.textContent || "").length;
  }

  /** 对话区文本长度。排除重试状态行、错误文案和脚本自身 UI，否则它们的滚动文本会被误判为输出 */
  function threadLenFrom(cands) {
    const t = now();
    if (state.lenCacheAt && t - state.lenCacheAt < 500) return state.lenCache;
    const root = threadRoot();
    if (!root) { state.lenCache = 0; state.lenCacheAt = t; return 0; }
    let len = (root.textContent || "").length;
    const ignored = new Set(cands);
    ignored.add(document.getElementById(HOST_ID));
    ignored.add(findComposer());
    for (const el of errorTextLeaves()) ignored.add(el);
    for (const el of ignored) len -= subtractTextLen(root, el);
    state.lenCache = Math.max(0, len);
    state.lenCacheAt = t;
    return state.lenCache;
  }

  function threadLen() {
    return threadLenFrom(retryCandidates());
  }

  // -------------------------------------------------------------- DOM 写入
  /** ProseMirror 不能直接赋值，走 execCommand insertText（官方脚本同款做法） */
  function writeComposer(text) {
    const input = findComposer();
    if (!input) return false;
    input.focus();
    try {
      const sel = window.getSelection?.();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel?.removeAllRanges?.();
      sel?.addRange?.(range);
    } catch (_) { /* ignore */ }

    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (_) { ok = false; }
    if (!ok) {
      try {
        input.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true, cancelable: true, inputType: "insertText", data: text,
        }));
        input.textContent = text;
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true, cancelable: true, inputType: "insertText", data: text,
        }));
        ok = true;
      } catch (_) { ok = false; }
    }
    return ok;
  }

  function submitComposer() {
    const st = buttonState();
    if (st.kind === "send" && st.btn) { st.btn.click(); return true; }
    const input = findComposer();
    if (!input) return false;
    input.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    }
    return true;
  }

  // ------------------------------------------------------------------ 判定
  /**
   * 内容正在流动 = 连接是活的。
   * 这是区分「卡在重试」和「已重连、正在输出」的关键：两者的重试行长得一模一样
   * （都冻结在某个 N/M），但后者会持续产出文本。
   */
  function flowing(s, cfg) {
    return now() - s.lastGrowthAt < cfg.quietMs;
  }

  /** 重试开始后是否产出过实质内容（用于区分「重试后成功收尾」和「重试耗尽报错」） */
  function producedSinceRetry(s, cfg) {
    if (s.lenAtRetryStart == null) return false;
    return s.len - s.lenAtRetryStart >= cfg.growthEpsilon;
  }

  function markRetryStale(el) {
    if (el) state.staleEls.add(el);
  }

  function markAllRetriesStale() {
    for (const el of retryCandidates()) {
      markRetryStale(el);
      const c = parseRetryCount(el);
      if (c) state.seenN.set(el, c.n);
    }
  }

  /**
   * 结束重试会话。之后冻结的高次数行只当历史残留 —— 这正是「上次接管/上次重试
   * 的计数残留」误伤长思考的根因，必须在动手前掐掉。
   */
  function endRetrySession(reason) {
    if (state.retrySession && reason) note(`重试会话结束（${reason}）`);
    state.retrySession = false;
    state.armed = false;
    state.confirming = false;
    state.confirmUntil = 0;
    markAllRetriesStale();
    state.activeRetryEl = null;
    state.lenAtRetryStart = null;
  }

  /** 次数爬升 / 新活跃行 = 真的在重试 */
  function touchRetrySession(reading, why) {
    state.retrySession = true;
    state.sessionLastNAt = now();
    state.armed = true;
    if (state.activeRetryEl !== reading.el) state.lenAtRetryStart = state.len;
    state.activeRetryEl = reading.el;
    state.staleEls.delete(reading.el);
    if (why) note(why);
  }

  /**
   * 更新重试读数的活跃性。返回 true 表示这是「本会话内的活跃重试」。
   * 只有次数相对上次读数爬升了，或新行刚出现（还没进 stale 集合），才算活跃。
   * 启动时 / turn 边界 / 我们动过手 / 内容一旦产出，现存行全部进 stale 集合。
   */
  function updateRetryActivity(reading) {
    if (!reading) return false;
    const prev = state.seenN.get(reading.el);
    state.seenN.set(reading.el, reading.n);

    const isStale = state.staleEls.has(reading.el);
    const nIncreased = prev !== undefined && reading.n > prev;
    const brandNew = prev === undefined && !isStale;

    if (nIncreased) {
      const starting = !state.retrySession;
      touchRetrySession(reading, starting
        ? `活跃重试 ${reading.n}/${reading.max}（次数爬升）`
        : null);
      return true;
    }
    if (brandNew) {
      // 真正的新重试几乎总是从 1~2 爬起。高次数的「新行」多半是虚拟滚动
      // 把历史残留克隆成了新节点 —— 当残留处理，等它次数真的爬升再说。
      if (reading.n <= 2) {
        touchRetrySession(reading, `活跃重试 ${reading.n}/${reading.max}（新行）`);
        return true;
      }
      markRetryStale(reading.el);
      return false;
    }
    // 残留 / 冻结：只有当前会话已经在跟踪同一条且尚未空闲超时，才继续算活跃
    // （这就是两次重试之间的退避窗口，正是本脚本要动手的时机）
    if (state.retrySession && state.activeRetryEl === reading.el
        && now() - state.sessionLastNAt < CONFIG.sessionIdleMs) {
      state.armed = true;
      return true;
    }
    return false;
  }

  function retrySessionFresh() {
    return state.retrySession
      && now() - state.sessionLastNAt < CONFIG.sessionIdleMs;
  }

  /** 界面是否出现限流文案。缓存 3s，避免每拍强制读 innerText 拖死页面 */
  function rateLimitVisible() {
    const t = now();
    if (state.rateLimitCacheAt && t - state.rateLimitCacheAt < 3000) {
      return state.rateLimitCache;
    }
    state.rateLimitCacheAt = t;
    try {
      const root = threadRoot() || document.body;
      // 只读最近一段，不必扫全 transcript
      const text = (root.innerText || "");
      const tail = text.length > 4000 ? text.slice(-4000) : text;
      state.rateLimitCache = RATE_LIMIT_RE.test(tail);
    } catch (_) {
      state.rateLimitCache = false;
    }
    return state.rateLimitCache;
  }

  /**
   * 跳号验收窗：上一发失败已证实，但刚起来这一发可能已经接上。
   * 窗口内出正文 / 会话结束 → 放弃；仍卡在重连且无正文 → 才打断。
   */
  function startConfirmWindow(reading, failedN) {
    state.confirming = true;
    state.confirmAt = now();
    state.confirmUntil = state.confirmAt + Math.round(rand(CONFIG.confirmWindowMs[0], CONFIG.confirmWindowMs[1]));
    state.confirmLen = state.len;
    state.confirmN = reading ? reading.n : 0;
    note(`第 ${failedN} 次失败已证实（n→${state.confirmN}），验收 ${((state.confirmUntil - state.confirmAt) / 1000).toFixed(1)}s`);
  }

  function clearConfirmWindow(reason) {
    if (state.confirming && reason) note(`取消打断（${reason}）`);
    state.confirming = false;
    state.confirmUntil = 0;
  }

  /**
   * 兼容旧调试接口：是否值得为这条读数重新武装。
   * 现在的语义是「这是活跃重试会话吗」，不再用 actedEl/actedAtN 做指针比较 ——
   * 旧逻辑在虚拟滚动换节点、actedAtN=Infinity 时会错误 rearm 残留行。
   */
  function shouldRearm(reading, s) {
    if (!reading) return false;
    if (s.armed) return false;
    return updateRetryActivity(reading);
  }

  // ------------------------------------------------------------ 救援流程
  /** 路径 A：主动打断 -> 点继续 */
  async function rescue(reading) {
    if (state.busy) return;
    // rate limit 可能在验收窗里才刷出来 —— 动手前最后再挡一道
    if (CONFIG.skipPreventiveOnRateLimit && rateLimitVisible()) {
      clearConfirmWindow("限流中，放弃预防性打断");
      note("限流中，不打断，等耗尽后发继续");
      return;
    }
    state.busy = true;
    state.engaged = true;
    state.status = "acting";
    try {
      state.round++;
      const st = buttonState();
      if (st.kind !== "stop") { note(`第 ${state.round} 轮：按钮不是停止态（${st.label}），跳过`); return; }

      // 失败已证实后的落稳（随机，短；长等待已由验收窗承担）
      const settle = Math.round(rand(CONFIG.settleMs[0], CONFIG.settleMs[1]));
      if (settle > 0) await sleep(settle);
      if (!CONFIG.enabled) return;
      const st2 = buttonState();
      if (st2.kind !== "stop") { note(`落稳后按钮已变（${st2.label}），取消打断`); return; }
      // 落稳期间若出字，说明这一发其实成功了
      if (flowing(state, CONFIG)) { note("落稳期间已有输出，取消打断"); clearConfirmWindow("出字了"); return; }

      note(`第 ${state.round} 轮：第 ${state.threshold} 次失败后接管（当前 ${reading.n}/${reading.max}），打断`);
      // 先结束会话并标记残留再动手：被打断的这条行会永久留在 transcript 里，
      // 次数就冻结在 7~9，正是后面误伤长思考的「残留计数」。
      state.armed = false;
      state.actedRetryEl = reading.el;
      state.actedAtN = reading.n;
      state.lastRescueAt = now();
      endRetrySession("已接管打断");
      st.btn.click();

      const delay = Math.round(rand(CONFIG.resumeDelayMs[0], CONFIG.resumeDelayMs[1]));
      note(`等待 ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
      // 限流时多躲一下再继续，避免立刻又撞上去（打断本身仍要做）
      if (rateLimitVisible()) {
        const extra = Math.round(rand(CONFIG.postRateLimitResumeMs[0], CONFIG.postRateLimitResumeMs[1]));
        note(`检测到限流，继续前多等 ${(extra / 1000).toFixed(1)}s`);
        await sleep(extra);
      }
      if (!CONFIG.enabled) { note("已停用，取消恢复"); return; }

      const after = buttonState();
      if (after.kind === "continue") {
        note(`点继续（${after.label}）`);
        after.btn.click();
      } else if (after.kind === "send") {
        note("打断后为发送态，改用续跑提示词");
        await resumeByPrompt();
      } else {
        note(`打断后按钮状态异常（${after.label}），本轮不动作`);
      }

      state.threshold = pick(CONFIG.thresholds);
      state.lenAtRetryStart = null;
      note(`下一轮阈值 ${state.threshold}`);
      await sleep(3000);
    } finally {
      state.busy = false;
    }
  }

  // ------------------------------------------------------------ 自托管 / 快捷
  // 架构故意做得很薄：一个 setTimeout 计时器；到点 = 点一次「继续」快捷按钮。
  // 人工输入 / 切会话 / 新 turn = 打断并重置计时。

  function composerEmpty() {
    const t = (findComposer()?.textContent || "").replace(/[\s\ufeff\u200b]/g, "");
    return !t;
  }

  /** 启动/重置计时（加权随机 30–300s，小秒数概率更高） */
  function armSelfHost(reason) {
    if (!CONFIG.selfHost) return;
    clearSelfHostTimer();
    const delay = Math.round(randSkew(CONFIG.selfHostDelayMs[0], CONFIG.selfHostDelayMs[1], CONFIG.selfHostDelaySkew));
    state.selfHostAt = now() + delay;
    state.selfHostTimer = setTimeout(() => {
      state.selfHostTimer = 0;
      void fireSelfHost();
    }, delay);
    note(`自托管计时 ${(delay / 1000).toFixed(0)}s（${reason || ""}）`);
  }

  /** 打断计时 */
  function clearSelfHostTimer() {
    if (state.selfHostTimer) {
      clearTimeout(state.selfHostTimer);
      state.selfHostTimer = 0;
    }
    state.selfHostAt = 0;
  }

  function cancelSelfHost(reason) {
    if (!state.selfHostTimer && !state.selfHostAt) return;
    clearSelfHostTimer();
    if (reason) note(`自托管计时已打断（${reason}）`);
  }

  /** 仅在「本 turn 刚结束进待命」时排期一次；本 turn 内不再重复 arm */
  function armSelfHostOnceOnIdle(reason) {
    if (!CONFIG.selfHost) return;
    if (state.selfHostHold) return;
    if (state.selfHostTimer) return;
    armSelfHost(reason);
  }

  /** 到点：等价于点一次「继续」按钮；条件不满足就重置计时 */
  async function fireSelfHost() {
    if (!CONFIG.selfHost) return;
    const st = buttonState();
    // 未到发送态 / 有草稿 / 刚有人操作：短顺延，不要又抽满 30–300s
    if (st.kind !== "send") {
      state.selfHostAt = now() + 15000;
      state.selfHostTimer = setTimeout(() => { state.selfHostTimer = 0; void fireSelfHost(); }, 15000);
      return;
    }
    if (!composerEmpty()) {
      state.selfHostAt = now() + 20000;
      state.selfHostTimer = setTimeout(() => { state.selfHostTimer = 0; void fireSelfHost(); }, 20000);
      return;
    }
    if (now() - state.lastHumanInputAt < 5000) {
      state.selfHostAt = now() + 10000;
      state.selfHostTimer = setTimeout(() => { state.selfHostTimer = 0; void fireSelfHost(); }, 10000);
      return;
    }
    note("自托管：到点，按一次「继续」");
    const ok = await sendContinueNow();
    if (!ok) {
      state.selfHostAt = now() + 20000;
      state.selfHostTimer = setTimeout(() => { state.selfHostTimer = 0; void fireSelfHost(); }, 20000);
    }
  }

  /** 与「继续」按钮同一条路径 */
  async function sendContinueNow() {
    if (state.busy) return false;
    if (!composerEmpty()) {
      note("输入框有内容，发送已忽略");
      return false;
    }
    if (!writeComposer(CONFIG.continueText)) return false;
    await sleep(150);
    submitComposer();
    await sleep(300);
    const st = buttonState();
    return st.kind === "stop" || st.kind === "continue" || composerEmpty();
  }

  function onHotkey(e) {
    const hk = CONFIG.sendContinueHotkey;
    if (!hk) return;
    const key = (e.key || "").toLowerCase();
    if (key !== String(hk.key).toLowerCase()) return;
    if (!!e.ctrlKey !== !!hk.ctrl) return;
    if (!!e.altKey !== !!hk.alt) return;
    if (!!e.shiftKey !== !!hk.shift) return;
    e.preventDefault();
    e.stopPropagation();
    sendContinueNow();
  }

  /**
   * 快捷接续：开新聊天，填好「读取{id}，继续」，【不自动发送】——由你确认后再发。
   */
  async function quickNewChatResume() {
    if (state.busy) return;
    const threadId = state.turnThreadId || readCurrentThreadId() || "上一个对话";
    const prompt = (CONFIG.migratePrompt || "读取{threadId}，继续")
      .replace("{threadId}", threadId);
    note(`快捷接续：${prompt}（填入后请手动发送）`);

    const draft = (findComposer()?.textContent || "").trim();
    if (draft) {
      note("输入框有内容，先清掉或自己发，快捷接续未执行");
      return;
    }

    if (!clickNewChat()) {
      note("没找到「新聊天」按钮");
      return;
    }
    await sleep(800);
    if (!CONFIG.enabled) return;
    if ((findComposer()?.textContent || "").trim()) {
      note("新聊天输入框非空，不覆盖");
      return;
    }
    writeComposer(prompt);
    // 刻意不 submit —— 等你手动发
  }

  async function resumeByPrompt() {
    const composer = findComposer();
    if (composer && (composer.textContent || "").trim()) {
      note("输入框里有你正在写的内容，不覆盖，跳过");
      return false;
    }
    if (!writeComposer(CONFIG.continueText)) { note("写入输入框失败"); return false; }
    await sleep(200);
    submitComposer();
    note(`已发送续跑指令`);
    cancelSelfHost("已手动/自动续跑");

    // 自检：发送后若仍是「发送」态，说明没接上，再补一次
    for (let i = 0; i < 2; i++) {
      await sleep(2000);
      const st = buttonState();
      if (st.kind === "stop") { note("续跑已启动"); return true; }
      if (st.kind === "send" && (findComposer()?.textContent || "").trim() === "") {
        note(`续跑未生效（${st.label}），补发一次`);
        if (!writeComposer(CONFIG.continueText)) break;
        await sleep(200);
        submitComposer();
      } else {
        break;
      }
    }
    return true;
  }

  async function handleExhausted(reading) {
    if (state.busy) return;
    state.busy = true;
    state.status = "acting";
    // 证据只消费一次：续跑失败也不重复轰炸，交给「脱离接管」那条路
    state.turnExhausted = null;
    try {
      state.round++;
      note(`第 ${state.round} 轮：重试已耗尽并报错，用续跑提示词重新触发`);
      state.armed = false;
      state.actedRetryEl = reading ? reading.el : null;
      // 注意：不要再写 Infinity —— 旧逻辑 shouldRearm 用 n < actedAtN 判断，
      // Infinity 会把任何残留行都判成「新的一轮」从而重新武装。
      state.actedAtN = reading ? reading.n : 0;
      state.lastRescueAt = now();
      endRetrySession("耗尽待续跑");

      const ok = await resumeByPrompt();
      state.activeRetryEl = null;
      state.lenAtRetryStart = null;
      if (!ok) {
        state.engaged = false;
        note("续跑失败，脱离接管（可点状态条重新启用）");
        return;
      }
      state.threshold = pick(CONFIG.thresholds);
      await sleep(3000);
    } finally {
      state.busy = false;
    }
  }

  // ---------------------------------------------------------- 死会话迁移（400）
  /**
   * 是否是「对话末尾那个特殊错误框」里的匹配节点。
   * 作者这条链路的实测形态：aside（圆角描边框 + ⓘ）> … > span.wrap-anywhere
   *   > "bad response status code 400 (…)"
   * 要求节点必须落在 CONFIG.platform.fatalContainers 列出的容器里 ——
   * 正文里偶然出现「400」不算，否则好端端的对话会被判成会话已死。
   */
  function inFatalContainer(el) {
    try { return FATAL_CONTAINER_SEL.some(sel => el.closest(sel)); } catch (_) { return false; }
  }

  function isFatalErrorLeaf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === HOST_ID || el.closest?.(`#${HOST_ID}`)) return false;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 300 || !FATAL_ERR_RE.test(t)) return false;
    if ([...el.children].some(c => FATAL_ERR_RE.test(c.textContent || ""))) return false;
    return inFatalContainer(el);
  }

  function parseFatalLeaf(el) {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    const m = t.match(FATAL_ERR_RE);
    if (!m) return null;
    const code = parseInt(m[1], 10);
    if (!CONFIG.fatalCodes.includes(code)) return null;
    const reqId = t.match(FATAL_REQ_ID_RE)?.[1] || "";
    return { code, text: t.slice(0, 180), el, key: reqId || t.slice(0, 120) };
  }

  /** 对话区里所有「错误框」叶节点（文档序） */
  function fatalErrorLeaves() {
    const root = threadRoot() || document.body;
    const out = [];
    for (const el of root.querySelectorAll("span, div, aside, pre, code")) {
      if (isFatalErrorLeaf(el)) out.push(el);
    }
    return out;
  }

  /**
   * 识别 turn 末尾的致命错误框。只取文档序最后一条 ——
   * 历史 400 会永久留在 transcript 里，不能当成本 turn 的。
   */
  function readFatalError() {
    const t = now();
    if (state.fatalCacheAt && t - state.fatalCacheAt < 2000) return state.fatalCache;
    const leaves = fatalErrorLeaves();
    const last = leaves[leaves.length - 1];
    const parsed = last ? parseFatalLeaf(last) : null;
    state.fatalCache = parsed;
    state.fatalCacheAt = t;
    return parsed;
  }

  /**
   * 把「已经躺在界面上的」致命错误标成残留。
   * 启动时、turn 开始前、以及切换会话时都要跑：历史 400 会永远留在 transcript 里。
   */
  function markCurrentFatalsResidual() {
    const seen = new Set();
    for (const el of fatalErrorLeaves()) {
      const parsed = parseFatalLeaf(el);
      if (!parsed) continue;
      seen.add(parsed.key);
      state.residualErrKeys.add(parsed.key);
    }
    // 等待中的候选一并作废
    state.pendingFatalKey = null;
    state.pendingFatalAt = 0;
    return seen;
  }

  /** 从任意字符串里抠 UUID（参考 codex-context-used-meter 的 normalizeConversationUuid） */
  function normalizeConversationUuid(value) {
    if (value == null) return null;
    const m = String(value).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0].toLowerCase() : null;
  }

  /**
   * 当前 thread id。用户续跑习惯是「读取{id}，继续」，id 与
   * 「复制深度链接」codex://threads/{id} 以及 /state 里「会话/对话串」一致。
   *
   * 实测优先级（0.7.2 修正，之前用 codexThreadScroll 的 at 最大值会命中别的会话）：
   *   1) /state 面板「会话/对话串：UUID」—— 与深度链接一致的真值
   *   2) 侧栏选中行 data-app-action-sidebar-thread-id=local:01a0…
   *      （local:client-new-thread:UUID 不是 thread id）
   *   3) React fiber 挖 threadId / conversationId
   *   4) 主对话区里的 01a0…（若 /state 开着，第一条就是真 id）
   */
  /**
   * 极轻量：只读侧栏选中行的 thread id（主循环每拍用这个检测会话切换）。
   * 绝不要在这里跑 React 扫描 —— 每 700ms 扫 fiber 会把渲染线程打死。
   */
  function readThreadIdCheap() {
    const t = now();
    if (state.tidCheapAt && t - state.tidCheapAt < 2000) return state.tidCheap;
    state.tidCheapAt = t;
    try {
      const sel =
        document.querySelector('[aria-current="page"][data-app-action-sidebar-thread-id]')
        || document.querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]')
        || document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
      const raw = sel?.getAttribute("data-app-action-sidebar-thread-id") || "";
      const uuid = normalizeConversationUuid(raw);
      state.tidCheap = uuid && /^01a0/i.test(uuid) ? uuid : state.tidCheap;
    } catch (_) { /* ignore */ }
    return state.tidCheap;
  }

  function readCurrentThreadId() {
    // 主循环每拍都会问一次（用于检测会话切换）；React 扫描很贵，做 1.5s 缓存
    const t = now();
    if (state.tidCache && t - state.tidCacheAt < 1500) return state.tidCache;

    const result = readCurrentThreadIdUncached();
    state.tidCache = result;
    state.tidCacheAt = t;
    return result;
  }

  function readCurrentThreadIdUncached() {
    // ---- 1) /state 面板 ----
    const fromState = readThreadIdFromStatePanel();
    if (fromState) {
      state.lastThreadId = fromState;
      return fromState;
    }

    // ---- 2) 侧栏 selected / active 的 local:01a0… ----
    const sel =
      document.querySelector('[aria-current="page"][data-app-action-sidebar-thread-id]')
      || document.querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]')
      || document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
    if (sel) {
      const raw =
        sel.getAttribute("data-app-action-sidebar-thread-id")
        || sel.getAttribute("data-thread-id")
        || sel.getAttribute("data-conversation-id")
        || "";
      // 只接受 01a0… 形态；client-new-thread 的随机 UUID 不是 thread id
      const uuid = normalizeConversationUuid(raw);
      if (uuid && /^01a0/i.test(uuid)) {
        state.lastThreadId = uuid;
        return uuid;
      }
    }

    // ---- 3) React fiber ----
    const reactId = readThreadIdFromReact();
    if (reactId) {
      state.lastThreadId = reactId;
      return reactId;
    }

    // ---- 4) 主对话区 01a0… 文本 ----
    const main = document.querySelector("main")
      || document.querySelector("[data-thread-find-target]")
      || threadRoot();
    const viaText = (main?.innerText || "").match(/\b(01a0[0-9a-f-]{30,})\b/i);
    if (viaText) {
      state.lastThreadId = viaText[1].toLowerCase();
      return state.lastThreadId;
    }

    return state.lastThreadId;
  }

  /**
   * 从 /state 状态块读 thread id。
   * 实测 DOM：label 节点文本「会话/对话串：」，父级 contents 里拼着
   * 「会话/对话串：01a0xxxx-…」，与「复制深度链接」完全一致。
   * 面板没开时返回 null。
   */
  function readThreadIdFromStatePanel() {
    const body = threadRoot()?.innerText || document.body.innerText || "";
    const m = body.match(/会话\/对话串[^0-9a-f]{0,24}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m && /^01a0/i.test(m[1])) return m[1].toLowerCase();

    // 英文界面兜底
    const m2 = body.match(/(?:Session|Conversation|Thread)\s*(?:ID|id)[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m2 && /^01a0/i.test(m2[1])) return m2[1].toLowerCase();
    return null;
  }

  /**
   * 轻量 React fiber 扫描：只在稳定锚点上找 conversationId/threadId。
   * 完整版见 codex-context-used-meter（3800 行）；这里只抄迁移需要的最小集合。
   */
  function readThreadIdFromReact() {
    const anchors = [
      document.querySelector('[data-thread-find-target="conversation"]'),
      document.querySelector("[data-codex-composer]"),
      document.querySelector("main"),
      document.getElementById("root"),
    ].filter(Boolean);

    const KEYS = ["threadId", "conversationId", "localConversationId", "id", "key"];
    const seen = new WeakSet();

    const walk = (value, depth) => {
      if (!value || typeof value !== "object" || depth < 0 || seen.has(value)) return null;
      seen.add(value);

      for (const key of KEYS) {
        let candidate;
        try { candidate = value[key]; } catch { continue; }
        const uuid = normalizeConversationUuid(candidate);
        if (uuid && /^01a0/i.test(uuid)) return uuid;
      }

      if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, 20); i++) {
          const hit = walk(value[i], depth - 1);
          if (hit) return hit;
        }
        return null;
      }

      // React 私有属性 __reactProps$ / __reactFiber$ / __reactContainer$
      for (const k of Object.keys(value)) {
        if (!/^__react(?:Props|Fiber|Container)\$/.test(k)) continue;
        let child;
        try { child = value[k]; } catch { continue; }
        const hit = walk(child, depth - 1);
        if (hit) return hit;
      }
      return null;
    };

    for (const anchor of anchors) {
      for (const k of Object.keys(anchor)) {
        if (!/^__react(?:Props|Fiber|Container)\$/.test(k)) continue;
        let child;
        try { child = anchor[k]; } catch { continue; }
        const hit = walk(child, 10);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** 左上角「新聊天」。不要点「在 xxx 中开始新聊天」，文本必须等于「新聊天」 */
  function clickNewChat() {
    for (const b of document.querySelectorAll("button, [role=button]")) {
      if (!effectivelyVisible(b)) continue;
      const label = (b.getAttribute("aria-label") || "").trim();
      const text = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (label === "新聊天" || text === "新聊天") {
        b.click();
        return true;
      }
    }
    return false;
  }

  /**
   * 会话已死（400 等）：原地继续必失败。
   * 开新对话，只发「读取{旧id}，继续」—— 不摘录简报，新会话自己按需去读。
   */
  /**
   * 400 迁移延迟确认。
   * 打开历史报错对话时，错误框会立刻出现。必须：
   *   1) 连续看到同一个 request id 满 fatalConfirmMs
   *   2) 期间没有切会话、没有开始打字
   *   3) 本 turn 真的跑过（或我们正在接管）
   * 才允许开新聊天。刚看见就立刻迁移 = 一点旧会话就被劫持。
   */
  function confirmFatalPending(err) {
    const waitMs = CONFIG.fatalConfirmMs;
    if (state.pendingFatalKey !== err.key) {
      state.pendingFatalKey = err.key;
      state.pendingFatalAt = now();
      state.status = "fatal_pending";
      note(`看到 HTTP ${err.code}，等待 ${Math.round(waitMs / 1000)}s 确认（防止误伤旧会话）`);
      return false;
    }
    if (now() - state.pendingFatalAt < waitMs) {
      state.status = "fatal_pending";
      return false;
    }
    // 复核：错误还在、没在打字、没切会话
    const fresh = readFatalError();
    if (!fresh || fresh.key !== err.key) {
      state.pendingFatalKey = null;
      note("确认期内错误已消失，取消迁移");
      return false;
    }
    const draft = (findComposer()?.textContent || "").trim();
    if (draft) {
      state.pendingFatalKey = null;
      note("确认期内你开始输入，取消迁移");
      return false;
    }
    return true;
  }

  async function handleFatalError(err) {
    if (state.busy) return;
    if (state.actedErrKeys.has(err.key) || state.residualErrKeys.has(err.key)) return;
    // 没见过本 turn 真正跑起来（停止钮）就不要自动开新聊天 ——
    // 典型误伤：只是打开了一条历史上带 400 的旧会话。
    if (!state.sawRunningTurn && !state.engaged) {
      state.residualErrKeys.add(err.key);
      state.pendingFatalKey = null;
      note("界面有历史错误但本 turn 未运行过，按残留忽略");
      return;
    }
    if (state.migrations >= CONFIG.maxMigrations) {
      note(`迁移已达上限 ${CONFIG.maxMigrations}，不再自动开新对话`);
      state.status = "migrate_blocked";
      return;
    }

    // 先看输入框：你在打字就绝不动，更不能先切到新聊天把草稿丢了
    const draft = (findComposer()?.textContent || "").trim();
    if (draft) {
      note("输入框里有你正在写的内容，迁移跳过");
      state.status = "migrate_blocked";
      return;
    }

    // 延迟确认：不能一看到错误框就开新聊天
    if (!confirmFatalPending(err)) return;

    state.busy = true;
    state.status = "migrating";
    try {
      state.actedErrKeys.add(err.key);
      state.migrations++;
      state.sawRunningTurn = false;
      state.pendingFatalKey = null;
      endRetrySession("致命错误，准备迁移");
      cancelSelfHost("400 迁移");

      // 优先用 turn 运行期间打的快照，其次才现场读
      // （现场读可能已经混进别的会话 id，见 0.7.2 修正说明）
      const threadId = state.turnThreadId || readCurrentThreadId() || "上一个对话";
      const prompt = (CONFIG.migratePrompt || "读取{threadId}，继续")
        .replace("{threadId}", threadId);
      note(`检测到 HTTP ${err.code}（${err.key}），第 ${state.migrations} 次迁移到新对话`);
      note(`续跑指令：${prompt}`);

      if (!clickNewChat()) {
        note("没找到「新聊天」按钮，迁移失败");
        state.status = "migrate_blocked";
        state.engaged = false;
        return;
      }

      // 等新会话壳起来、输入框清空
      await sleep(800);
      if (!CONFIG.enabled) { note("已停用，取消迁移"); return; }

      if ((findComposer()?.textContent || "").trim()) {
        note("新对话输入框非空，不覆盖，迁移中止");
        state.status = "migrate_blocked";
        return;
      }

      if (!writeComposer(prompt)) {
        note("写入续跑指令失败");
        state.status = "migrate_blocked";
        return;
      }
      await sleep(250);
      submitComposer();

      state.engaged = false;          // 新会话按普通轮次走，不绑旧接管
      state.activeRetryEl = null;
      state.lenAtRetryStart = null;
      state.turnThreadId = null;
      state.status = "migrated";
      note("已在新对话发出接续指令");
      await sleep(2000);
    } finally {
      state.busy = false;
    }
  }

  // ------------------------------------------------------------------ 主循环
  function tick() {
    // 一拍只扫一次 DOM：retryCandidates 最贵，不能让 threadLen 和 readRetry 各扫一遍
    const cands = retryCandidates();
    const reading = readRetryFrom(cands);
    const len = threadLenFrom(cands);
    const grew = len > state.len;
    if (grew) state.lastGrowthAt = now();
    state.len = len;

    const st = buttonState();

    if (!CONFIG.enabled) { state.status = "paused"; return; }
    if (state.busy) return;

    // turn 边界：上一拍还不是 stop（send/继续/未知）现在变 stop = 新的一轮开始了。
    // 此时把现存重试行/历史错误全部打成残留，避免上一轮的计数或旧 400 进入本轮判定。
    if (st.kind === "stop" && state.prevBtnKind !== null && state.prevBtnKind !== "stop") {
      endRetrySession("新 turn 开始");
      clearConfirmWindow();
      cancelSelfHost("新 turn 开始");
      state.selfHostHold = false;   // 新一轮结束后允许再排期
      state.turnExhausted = null;   // 上一轮的耗尽证据随 turn 作废
      markCurrentFatalsResidual();
    }
    // 会话切换：你手动点开别的对话（含历史报错对话）时，整段 turn 状态必须清零。
    // 用轻量侧栏 id，禁止每拍 React 扫描。
    const nowTid = readThreadIdCheap();
    if (nowTid && state.currentThreadId && nowTid !== state.currentThreadId) {
      note(`切换会话 ${state.currentThreadId.slice(0, 8)} → ${nowTid.slice(0, 8)}`);
      state.sawRunningTurn = false;
      state.turnThreadId = null;
      state.engaged = false;
      endRetrySession("切换会话");
      clearConfirmWindow();
      cancelSelfHost("切换会话");
      state.turnExhausted = null;
      markCurrentFatalsResidual();   // 新会话里已有的 400 全是残留
    }
    if (nowTid) state.currentThreadId = nowTid;

    if (st.kind === "stop") {
      state.sawRunningTurn = true;
      // 只用轻量侧栏 id 打快照。禁止在 tick 里跑 React 扫描。
      if (nowTid) state.turnThreadId = nowTid;
    }
    state.prevBtnKind = st.kind || state.prevBtnKind;

    // 一旦有实质产出，重试就算连上了；冻结的那行立刻降级为历史残留。
    if (grew && state.retrySession && producedSinceRetry(state, CONFIG)) {
      endRetrySession("已产出内容，重试应已成功");
    }

    // 会话空闲超时：次数很久没爬 = 已经不在重试（成功后在长考 / 或就是残留）。
    if (state.retrySession && !retrySessionFresh()) {
      endRetrySession("次数长时间未爬升");
    }

    // 打满之后真的开始出字了 → 那一发是成功的，本轮不需要收尸。
    // 注意这条不受 endRetrySession 影响：turnExhausted 是 turn 级的。
    if (state.turnExhausted && state.len - state.turnExhausted.len >= CONFIG.growthEpsilon) {
      note("打满后已有实质产出，本轮不续跑");
      state.turnExhausted = null;
    }

    if (st.kind === "stop") {
      const prevSeenN = reading && state.seenN.has(reading.el) ? state.seenN.get(reading.el) : undefined;
      const active = updateRetryActivity(reading);
      const isFlowing = flowing(state, CONFIG);
      const rateLimited = rateLimitVisible();
      if (rateLimited) state.sawRateLimitAt = now();

      // 打满必须在还看得见这条行时记成证据：10/10 之后次数永远不再爬升，
      // 30 秒后它就会被上面的空闲超时当成残留清掉，而那时按钮还没回到发送态。
      if (reading && reading.n >= reading.max && state.activeRetryEl === reading.el) {
        if (state.turnExhausted && state.turnExhausted.el === reading.el) {
          state.turnExhausted.at = now();
        } else {
          state.turnExhausted = { el: reading.el, n: reading.n, max: reading.max, at: now(), len: state.len };
          note(`第 ${reading.n}/${reading.max} 打满：记下耗尽证据，等 turn 结束再决定续跑`);
        }
      }

      // n 上跳 = 上一发失败已证实（允许跳号，如 7→10）
      const nIncreased = reading && prevSeenN !== undefined && reading.n > prevSeenN;
      const failedN = nIncreased
        ? Math.max(prevSeenN, reading.n - 1)
        : null;

      state.status = isFlowing ? "streaming"
        : state.confirming ? "confirming"
        : (active && reading ? "retrying" : "running");

      if (state.round >= CONFIG.maxRounds) return;
      const cooled = now() - state.lastRescueAt >= CONFIG.minRescueGapMs;

      // —— 预防性打断（high demand / 上游）：跳号证实第 T 次失败 → 验收窗 → 打断 ——
      // rate limit：不做预防性打断（skipPreventiveOnRateLimit），只等 10/10 耗尽再续跑。
      const allowPreventive = CONFIG.enablePreventiveRescue
        && !(CONFIG.skipPreventiveOnRateLimit && rateLimited);

      if (allowPreventive
          && nIncreased && active && state.retrySession
          && failedN != null && failedN >= state.threshold) {
        startConfirmWindow(reading, failedN);
      }

      if (allowPreventive && state.confirming) {
        // 限流中途刷出来 → 立刻放弃打断，等耗尽
        if (CONFIG.skipPreventiveOnRateLimit && rateLimited) {
          clearConfirmWindow("验收期出现限流，改等耗尽");
          return;
        }
        // 验收窗内：成功就撤
        if (isFlowing || (state.len - state.confirmLen >= CONFIG.growthEpsilon)) {
          clearConfirmWindow("验收期内出字，这一发成功");
          return;
        }
        if (!active || !reading || st.kind !== "stop") {
          clearConfirmWindow("重试已结束");
          return;
        }
        if (now() < state.confirmUntil) {
          // 还在验收，别动手
          return;
        }
        // 验收期满仍是「重连中、无正文」→ 这一发也不行，抢在下一发之前动手
        if (cooled && !isFlowing && state.armed && retrySessionFresh()) {
          const target = reading;
          clearConfirmWindow();
          rescue(target);
          return;
        }
        clearConfirmWindow("冷却中或会话不新鲜");
        return;
      }

      // rate limit 或关闭预防性打断时：只观察，等 10/10 耗尽后在 send 分支发「继续」。
      return;
    }

    if (st.kind === "continue") {
      state.status = "interrupted";
      // 我们刚打断，残留计数必须降级；下一轮靠次数爬升重新开会话
      if (state.retrySession) endRetrySession("已打断，等待继续");
      return;
    }

    // 「排队」等未知态：什么都不要做（既不点它，也不结束重试会话）
    if (st.kind === "unknown") {
      state.status = "running";
      return;
    }

    if (st.kind === "send") {
      // 发送态下先分清「正常结束 / 重试耗尽 / 会话已死」。
      // 会话已死（400 等）原地继续必失败，必须开新对话；优先级高于耗尽续跑。
      // 即使 engaged=false 也要认 —— 400 会把整条会话停掉，不因我们没接管就放过。
      // 但历史残留的 400（打开旧会话就看得到）绝不能触发迁移，见 handleFatalError。
      const fatal = readFatalError();
      if (fatal && !state.actedErrKeys.has(fatal.key) && !state.residualErrKeys.has(fatal.key)) {
        handleFatalError(fatal);
        return;
      }

      // 耗尽判定（不依赖 engaged —— 0.9 起我们通常没预防性打断过）：
      //   1. 本轮活跃重试行曾经真的打满（turnExhausted，运行期记下的证据）
      //   2. 打满到现在没有实质正文 —— 区分「第 10 次成功」和「耗尽报错」
      // 早先这里是 reading.el === state.activeRetryEl && n >= max，永远等不到：
      // 打满后次数不再爬升，空闲超时先把会话结束掉、activeRetryEl 清空，
      // 等按钮回到发送态时条件已经不成立（错误框文案还会被误判成产出）。
      const exhausted = !!state.turnExhausted
        && state.len - state.turnExhausted.len < CONFIG.growthEpsilon;

      if (exhausted && state.round < CONFIG.maxRounds) {
        state.status = "exhausted";
        handleExhausted(reading);
        return;
      }

      if (!state.engaged) {
        state.status = "idle";
        state.sawRunningTurn = false;
        if (state.retrySession) endRetrySession("回到发送态且未接管");
        armSelfHostOnceOnIdle("输出结束，进入待命");
        return;
      }

      state.engaged = false;
      state.sawRunningTurn = false;
      endRetrySession("本 turn 结束");
      state.status = "done";
      note(producedSinceRetry(state, CONFIG) ? "这轮已产出内容并正常收尾，脱离接管" : "这轮已结束，脱离接管");
      armSelfHostOnceOnIdle("输出结束，进入待命");
    }
  }

  // ------------------------------------------------------------ 状态指示器
  const STATUS_META = {
    paused:          { dot: "#8b8b8b", label: "已暂停" },
    idle:            { dot: "#8b8b8b", label: "待命" },
    running:         { dot: "#3b82f6", label: "运行中" },
    streaming:       { dot: "#22c55e", label: "输出中" },
    retrying:        { dot: "#f59e0b", label: "重试中" },
    confirming:      { dot: "#eab308", label: "验收中" },
    acting:          { dot: "#f97316", label: "接管中" },
    interrupted:     { dot: "#a855f7", label: "已打断" },
    exhausted:       { dot: "#ef4444", label: "重试耗尽" },
    fatal_pending:   { dot: "#eab308", label: "待确认" },
    migrating:       { dot: "#06b6d4", label: "迁移中" },
    migrated:        { dot: "#22c55e", label: "已迁移" },
    migrate_blocked: { dot: "#ef4444", label: "迁移受阻" },
    done:            { dot: "#22c55e", label: "已完成" },
  };

  // ------------------------------------------------------ 容器与拖动
  /**
   * 面板和指示器放在同一个容器里（面板在上、指示器在下，右对齐），
   * 这样拖动只需要移动容器，面板会自动跟着走，不用两处各算一遍坐标。
   */
  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;

    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = [
      "position:fixed", "z-index:2147483600",
      "display:flex", "flex-direction:column", "align-items:flex-end", "gap:8px",
      "pointer-events:none",   // 容器本身不吃事件，只有子元素吃
    ].join(";");
    document.body.appendChild(host);
    applyPos();
    return host;
  }

  /** 自托管独立状态条：开/关 + 倒计时，点击可切换 */
  function ensureSelfHostEl() {
    let el = document.getElementById(SELF_HOST_ID);
    if (el) return el;
    const host = ensureHost();
    el = document.createElement("button");
    el.id = SELF_HOST_ID;
    el.type = "button";
    el.title = "点击开关自托管（轮次结束后随机 30–300s 自动发「继续」）";
    el.style.cssText = [
      "pointer-events:auto", "cursor:pointer",
      "display:flex", "align-items:center", "gap:6px",
      "padding:5px 11px", "border-radius:999px",
      "font:600 11px/1.3 ui-monospace,Consolas,monospace",
      "color:#e8e8ea", "background:rgba(24,24,27,.78)",
      "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
      "border:1px solid rgba(255,255,255,.12)",
      "box-shadow:0 4px 16px rgba(0,0,0,.28)",
      "user-select:none", "touch-action:none", "white-space:nowrap",
      "-webkit-app-region:no-drag",
    ].join(";");

    const dot = document.createElement("span");
    dot.dataset.role = "sh-dot";
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:#8b8b8b";
    const label = document.createElement("span");
    label.dataset.role = "sh-label";
    label.textContent = "自托管 关";
    el.append(dot, label);

    el.addEventListener("click", e => {
      e.stopPropagation();
      CONFIG.selfHost = !CONFIG.selfHost;
      saveSettings();
      if (!CONFIG.selfHost) cancelSelfHost("已关闭");
      else {
        state.selfHostHold = false;
        armSelfHost("手动开启");
      }
      paintSelfHost();
    });

    host.appendChild(el);
    return el;
  }

  function paintSelfHost() {
    const el = ensureSelfHostEl();
    const on = !!CONFIG.selfHost;
    const left = state.selfHostAt ? Math.max(0, Math.round((state.selfHostAt - now()) / 1000)) : 0;
    const text = on
      ? (state.selfHostTimer ? `自托管 ${left}s` : "自托管 待命")
      : "自托管 关";
    const color = on ? (state.selfHostTimer ? "#22c55e" : "#eab308") : "#8b8b8b";
    const sig = text + color;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const dot = el.querySelector('[data-role="sh-dot"]');
    const label = el.querySelector('[data-role="sh-label"]');
    if (dot) {
      dot.style.background = color;
      dot.style.boxShadow = on ? `0 0 6px ${color}99` : "none";
    }
    if (label) label.textContent = text;
    el.style.opacity = on ? "1" : "0.72";
  }

  /** 快捷「继续」按钮：发送 continueText */
  function ensureContBtn() {
    let el = document.getElementById(CONT_BTN_ID);
    if (el) return el;
    const host = ensureHost();
    el = document.createElement("button");
    el.id = CONT_BTN_ID;
    el.type = "button";
    el.textContent = "继续";
    el.title = "发送「继续」（Ctrl+Alt+C 亦可）";
    el.style.cssText = [
      "pointer-events:auto", "cursor:pointer",
      "padding:5px 12px", "border-radius:999px",
      "font:600 11px/1.3 ui-sans-serif,-apple-system,'Segoe UI',sans-serif",
      "color:#e8e8ea", "background:rgba(24,24,27,.78)",
      "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
      "border:1px solid rgba(255,255,255,.12)",
      "box-shadow:0 4px 16px rgba(0,0,0,.28)",
      "user-select:none", "touch-action:none",
      "-webkit-app-region:no-drag",
    ].join(";");
    el.addEventListener("click", e => {
      e.stopPropagation();
      sendContinueNow();
    });
    host.insertBefore(el, host.firstChild);
    return el;
  }

  /** 快捷「接续」按钮：开新聊天 + 填好指令，不发送 */
  function ensureQuickBtn() {
    let el = document.getElementById(QUICK_BTN_ID);
    if (el) return el;
    const host = ensureHost();
    el = document.createElement("button");
    el.id = QUICK_BTN_ID;
    el.type = "button";
    el.textContent = "接续";
    el.title = "新聊天并填入：读取{当前id}，继续（不自动发送）";
    el.style.cssText = [
      "pointer-events:auto", "cursor:pointer",
      "padding:5px 12px", "border-radius:999px",
      "font:600 11px/1.3 ui-sans-serif,-apple-system,'Segoe UI',sans-serif",
      "color:#e8e8ea", "background:rgba(24,24,27,.78)",
      "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
      "border:1px solid rgba(255,255,255,.12)",
      "box-shadow:0 4px 16px rgba(0,0,0,.28)",
      "user-select:none", "touch-action:none",
      "-webkit-app-region:no-drag",
    ].join(";");
    el.addEventListener("click", e => {
      e.stopPropagation();
      quickNewChatResume();
    });
    // 排在 badge 上面（host 是 column，flex-end）
    const badge = document.getElementById(BADGE_ID);
    if (badge) host.insertBefore(el, badge);
    else host.appendChild(el);
    return el;
  }

  /** 把 CONFIG.pos 写到容器上，并夹住不让它跑出可视区 */
  function applyPos() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const w = rect.width || 240;
    const h = rect.height || 34;
    const right = clamp(CONFIG.pos.right, 0, Math.max(0, window.innerWidth - w));
    const bottom = clamp(CONFIG.pos.bottom, 0, Math.max(0, window.innerHeight - h));
    CONFIG.pos.right = right;
    CONFIG.pos.bottom = bottom;
    host.style.right = `${right}px`;
    host.style.bottom = `${bottom}px`;
  }

  /**
   * 指示器兼作拖动手柄。难点是同一个元素既要能点（展开面板）又要能拖，
   * 所以用位移阈值区分：移动不超过 DRAG_SLOP 才算点击。
   */
  const DRAG_SLOP = 4;

  function attachDrag(handle) {
    let dragging = false;
    let moved = 0;
    let startX = 0, startY = 0, startRight = 0, startBottom = 0;

    handle.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      dragging = true;
      moved = 0;
      startX = e.clientX; startY = e.clientY;
      startRight = CONFIG.pos.right; startBottom = CONFIG.pos.bottom;
      handle.setPointerCapture?.(e.pointerId);
      handle.style.cursor = "grabbing";
      e.preventDefault();
    });

    handle.addEventListener("pointermove", e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      // 往左拖 = right 变大；往上拖 = bottom 变大
      CONFIG.pos.right = startRight - dx;
      CONFIG.pos.bottom = startBottom - dy;
      applyPos();
    });

    const finish = e => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = "pointer";
      handle.releasePointerCapture?.(e.pointerId);
      if (moved <= DRAG_SLOP) togglePanel();   // 没怎么动 = 这是一次点击
      else saveSettings();                      // 真拖了才落盘
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function ensureBadge() {
    let el = document.getElementById(BADGE_ID);
    if (el) return el;

    const host = ensureHost();
    el = document.createElement("div");
    el.id = BADGE_ID;
    el.style.cssText = [
      "display:flex", "align-items:center", "gap:8px",
      "padding:6px 11px 6px 9px", "border-radius:999px",
      "font:500 11.5px/1.4 ui-sans-serif,-apple-system,'Segoe UI',sans-serif",
      "color:#e8e8ea", "background:rgba(24,24,27,.78)",
      "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
      "border:1px solid rgba(255,255,255,.10)",
      "box-shadow:0 4px 16px rgba(0,0,0,.28)",
      "cursor:pointer", "user-select:none", "pointer-events:auto",
      "touch-action:none",     // 否则触控/触摸板拖动会被浏览器手势吃掉
      "transition:opacity .18s ease",
    ].join(";");
    el.title = "点击展开面板 · 拖动可移动位置";

    const dot = document.createElement("span");
    dot.dataset.role = "dot";
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;flex:0 0 auto;transition:background .2s ease,box-shadow .2s ease";

    const label = document.createElement("span");
    label.dataset.role = "label";

    const meter = document.createElement("span");
    meter.dataset.role = "meter";
    meter.style.cssText = "font:600 11px ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.92;font-variant-numeric:tabular-nums";

    const sub = document.createElement("span");
    sub.dataset.role = "sub";
    sub.style.cssText = "opacity:.55;font-size:10.5px";

    const caret = document.createElement("span");
    caret.dataset.role = "caret";
    caret.style.cssText = "opacity:.45;font-size:9px;margin-left:1px;transition:transform .18s ease";
    caret.textContent = "▾";

    el.append(dot, label, meter, sub, caret);
    attachDrag(el);
    ensureQuickBtn();
    ensureContBtn();
    ensureSelfHostEl();
    host.appendChild(el);
    return el;
  }

  function paintBadge() {
    const el = ensureBadge();
    const meta = STATUS_META[state.status] || STATUS_META.idle;
    const r = readRetry();

    const meterText = state.status === "retrying" && r ? `${r.n}/${r.max}`
      : state.status === "streaming" ? ""
      : r && state.engaged ? `${r.n}/${r.max}` : "";
    const bits = [];
    if (state.round) bits.push(`已救 ${state.round}`);
    if (state.migrations) bits.push(`迁移 ${state.migrations}`);
    if (!state.watchdogAlive) bits.push("看门狗✗");
    if (state.retrySession && !state.armed) bits.push("会话跟踪");
    if (!state.retrySession && state.engaged) bits.push("等活跃重试");
    const subText = bits.join(" · ");

    const sig = `${state.status}|${meterText}|${subText}|${CONFIG.enabled}|${state.panelOpen}`;
    if (sig === state.badgeSig) return;
    state.badgeSig = sig;

    const dot = el.querySelector('[data-role="dot"]');
    dot.style.background = meta.dot;
    dot.style.boxShadow = CONFIG.enabled ? `0 0 6px ${meta.dot}99` : "none";
    el.querySelector('[data-role="label"]').textContent = meta.label;
    el.querySelector('[data-role="meter"]').textContent = meterText;
    el.querySelector('[data-role="sub"]').textContent = subText;
    el.querySelector('[data-role="caret"]').style.transform = state.panelOpen ? "rotate(180deg)" : "none";
    el.style.opacity = CONFIG.enabled ? "1" : "0.5";
  }

  // ---------------------------------------------------------------- 面板
  const PANEL_CSS = {
    row: "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0",
    key: "opacity:.5;font-size:11px;white-space:nowrap",
    val: "font:600 11px ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;text-align:right",
    sep: "height:1px;background:rgba(255,255,255,.09);margin:8px 0",
    input: "width:64px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);"
         + "border-radius:6px;color:#e8e8ea;padding:3px 6px;font:600 11px ui-monospace,Consolas,monospace;"
         + "text-align:center;outline:none",
    btn: "background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:6px;"
       + "color:#e8e8ea;width:20px;height:20px;line-height:1;cursor:pointer;font-size:12px;"
       + "display:flex;align-items:center;justify-content:center;padding:0",
    wide: "flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:6px;"
        + "color:#e8e8ea;padding:5px 8px;font:500 11px ui-sans-serif,sans-serif;cursor:pointer",
  };

  function mkRow(keyText, valueNode) {
    const row = document.createElement("div");
    row.style.cssText = PANEL_CSS.row;
    const k = document.createElement("span");
    k.style.cssText = PANEL_CSS.key;
    k.textContent = keyText;
    row.append(k, valueNode);
    return row;
  }

  function mkInfo(keyText, role) {
    const v = document.createElement("span");
    v.dataset.role = role;
    v.style.cssText = PANEL_CSS.val;
    return mkRow(keyText, v);
  }

  /** 数字步进器：减号 / 输入框 / 加号 */
  function mkStepper(keyText, role, { min, max, step, onSet }) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:5px";

    const dec = document.createElement("button");
    dec.style.cssText = PANEL_CSS.btn;
    dec.textContent = "−";

    const input = document.createElement("input");
    input.dataset.role = role;
    input.type = "text";
    input.inputMode = "numeric";
    input.style.cssText = PANEL_CSS.input;

    const inc = document.createElement("button");
    inc.style.cssText = PANEL_CSS.btn;
    inc.textContent = "+";

    const apply = raw => {
      const v = clamp(parseInt(raw, 10) || min, min, max);
      onSet(v);
      input.value = String(v);
      saveSettings();
      state.panelSig = "";   // 强制下一帧重画
      paintPanel();
    };
    dec.addEventListener("click", e => { e.stopPropagation(); apply(parseInt(input.value, 10) - step); });
    inc.addEventListener("click", e => { e.stopPropagation(); apply(parseInt(input.value, 10) + step); });
    input.addEventListener("change", () => apply(input.value));
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(input.value); input.blur(); } });

    wrap.append(dec, input, inc);
    return mkRow(keyText, wrap);
  }

  function ensurePanel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;

    p = document.createElement("div");
    p.id = PANEL_ID;
    p.style.cssText = [
      "width:236px", "padding:12px 13px", "border-radius:12px",
      "font:500 11.5px/1.5 ui-sans-serif,-apple-system,'Segoe UI',sans-serif",
      "color:#e8e8ea", "background:rgba(24,24,27,.92)",
      "backdrop-filter:blur(14px)", "-webkit-backdrop-filter:blur(14px)",
      "border:1px solid rgba(255,255,255,.12)",
      "box-shadow:0 10px 34px rgba(0,0,0,.42)",
      "user-select:none", "pointer-events:auto",
    ].join(";");
    // 面板内部的点击不要冒泡到 badge，否则一点就折叠
    p.addEventListener("click", e => e.stopPropagation());
    // 也别让面板上的拖动手势被当成移动指示器
    p.addEventListener("pointerdown", e => e.stopPropagation());

    // ---- 头部：标题 + 启用开关 ----
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:9px";
    const title = document.createElement("span");
    title.style.cssText = "font-weight:600;font-size:12px";
    title.textContent = "重试救援";
    const toggle = document.createElement("button");
    toggle.dataset.role = "toggle";
    toggle.style.cssText = PANEL_CSS.btn + ";width:auto;padding:0 9px;height:22px;font-size:11px";
    toggle.addEventListener("click", e => {
      e.stopPropagation();
      CONFIG.enabled = !CONFIG.enabled;
      saveSettings();
      note(CONFIG.enabled ? "已恢复" : "已暂停");
      state.panelSig = ""; state.badgeSig = "";
      paintPanel(); paintBadge();
    });
    head.append(title, toggle);

    // ---- 信息区 ----
    const info = document.createElement("div");
    info.append(
      mkInfo("状态", "i-status"),
      mkInfo("重试", "i-retry"),
      mkInfo("已救轮数", "i-rounds"),
      mkInfo("会话", "i-armed"),
      mkInfo("内容", "i-flow"),
    );

    const sep1 = document.createElement("div");
    sep1.style.cssText = PANEL_CSS.sep;

    // ---- 设置区 ----
    const settings = document.createElement("div");
    settings.append(
      mkStepper("最大轮数", "s-rounds", {
        min: 1, max: 999, step: 5, onSet: v => { CONFIG.maxRounds = v; },
      }),
      mkStepper("静默判定 ms", "s-quiet", {
        min: 1000, max: 30000, step: 1000, onSet: v => { CONFIG.quietMs = v; },
      }),
      mkStepper("会话空闲 ms", "s-idle", {
        min: 10000, max: 120000, step: 5000, onSet: v => { CONFIG.sessionIdleMs = v; },
      }),
    );

    // 续跑提示词
    const textIn = document.createElement("input");
    textIn.dataset.role = "s-text";
    textIn.type = "text";
    textIn.style.cssText = PANEL_CSS.input + ";width:86px;text-align:left;font-family:inherit";
    const commitText = () => {
      const v = textIn.value.trim();
      if (v) { CONFIG.continueText = v; saveSettings(); }
      else textIn.value = CONFIG.continueText;
    };
    textIn.addEventListener("change", commitText);
    textIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); commitText(); textIn.blur(); } });
    settings.append(mkRow("续跑提示词", textIn));

    // 阈值只读展示：它是逻辑正确性的一部分，不开放修改
    const thr = document.createElement("span");
    thr.style.cssText = PANEL_CSS.val + ";opacity:.55";
    thr.textContent = CONFIG.thresholds.map(t => `第${t}次失败后`).join(" / ");
    settings.append(mkRow("打断阈值", thr));

    const sep2 = document.createElement("div");
    sep2.style.cssText = PANEL_CSS.sep;

    // ---- 操作 ----
    const selfBtn = document.createElement("button");
    selfBtn.dataset.role = "s-selfhost";
    selfBtn.style.cssText = PANEL_CSS.wide;
    selfBtn.addEventListener("click", e => {
      e.stopPropagation();
      CONFIG.selfHost = !CONFIG.selfHost;
      saveSettings();
      if (!CONFIG.selfHost) cancelSelfHost("已关闭");
      else {
        state.selfHostHold = false;
        armSelfHost("手动开启");
      }
      note(CONFIG.selfHost ? "自托管已开启" : "自托管已关闭");
      state.panelSig = ""; state.badgeSig = "";
      paintPanel(); paintBadge();
    });

    const reset = document.createElement("button");
    reset.style.cssText = PANEL_CSS.wide;
    reset.textContent = "重置轮数计数";
    reset.addEventListener("click", e => {
      e.stopPropagation();
      state.round = 0;
      endRetrySession("手动重置");
      note("轮数计数已重置");
      state.panelSig = ""; state.badgeSig = "";
      paintPanel(); paintBadge();
    });

    const sep3 = document.createElement("div");
    sep3.style.cssText = PANEL_CSS.sep;

    const logBox = document.createElement("div");
    logBox.dataset.role = "log";
    logBox.style.cssText = "font:400 10px/1.55 ui-monospace,Consolas,monospace;opacity:.45;"
      + "max-height:56px;overflow:hidden;white-space:pre-wrap;word-break:break-all";

    p.append(head, info, sep1, settings, sep2, selfBtn, reset, sep3, logBox);
    ensureHost().prepend(p);   // 面板在指示器上方
    return p;
  }

  function paintPanel() {
    if (!state.panelOpen) return;
    const p = ensurePanel();
    const r = readRetry();
    const isFlowing = flowing(state, CONFIG);

    const vals = {
      "i-status": (STATUS_META[state.status] || STATUS_META.idle).label,
      "i-retry": r ? `${r.n}/${r.max}` : "—",
      "i-rounds": `${state.round} / ${CONFIG.maxRounds}`,
      "i-armed": rateLimitVisible()
        ? "限流·耗尽续跑"
        : CONFIG.enablePreventiveRescue
          ? (state.retrySession ? (state.armed ? "活跃" : "跟踪中") : "残留/空闲")
          : "耗尽续跑",
      "i-flow": isFlowing ? "流动中" : "静默",
    };
    const logText = state.log.slice(-3).reverse().join("\n");
    const sig = JSON.stringify(vals) + "|" + logText + "|" + CONFIG.enabled
      + "|" + CONFIG.maxRounds + "|" + CONFIG.quietMs + "|" + CONFIG.sessionIdleMs
      + "|" + CONFIG.continueText;
    if (sig === state.panelSig) return;
    state.panelSig = sig;

    for (const [role, text] of Object.entries(vals)) {
      const el = p.querySelector(`[data-role="${role}"]`);
      if (el) el.textContent = text;
    }
    p.querySelector('[data-role="log"]').textContent = logText;

    const toggle = p.querySelector('[data-role="toggle"]');
    toggle.textContent = CONFIG.enabled ? "已启用" : "已暂停";
    toggle.style.color = CONFIG.enabled ? "#22c55e" : "#8b8b8b";

    // 输入框正在被编辑时不要覆盖，否则没法打字
    const setIfIdle = (role, value) => {
      const el = p.querySelector(`[data-role="${role}"]`);
      if (el && document.activeElement !== el) el.value = String(value);
    };
    setIfIdle("s-rounds", CONFIG.maxRounds);
    setIfIdle("s-quiet", CONFIG.quietMs);
    setIfIdle("s-idle", CONFIG.sessionIdleMs);
    setIfIdle("s-self", Math.round((CONFIG.selfHostDelayMs[0] + CONFIG.selfHostDelayMs[1]) / 2));
    setIfIdle("s-text", CONFIG.continueText);

    const selfBtn = p.querySelector('[data-role="s-selfhost"]');
    if (selfBtn) {
      selfBtn.textContent = CONFIG.selfHost
        ? `自托管：开（${state.selfHostAt ? Math.max(0, Math.round((state.selfHostAt - now()) / 1000)) + "s" : "待命"}）`
        : "自托管：关（点此开启）";
    }
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    const p = state.panelOpen ? ensurePanel() : document.getElementById(PANEL_ID);
    if (p) p.style.display = state.panelOpen ? "block" : "none";
    state.panelSig = ""; state.badgeSig = "";
    if (state.panelOpen) paintPanel();
    paintBadge();
    applyPos();   // 展开后容器变高，重新夹一次免得顶出屏幕
  }

  // ------------------------------------------------------------------ 启动
  state.lastGrowthAt = now();
  state.len = threadLen();
  // 启动时把已经躺在 transcript 里的重试行/错误全部打成残留 —— 否则「上次接管留下的
  // 8/10」或历史 400 会在第一拍就被当成新状况，误触发。
  markAllRetriesStale();
  markCurrentFatalsResidual();
  state.currentThreadId = readCurrentThreadId();

  const pulse = () => {
    try {
      tick();
      paintBadge();
      paintSelfHost();
      paintPanel();
    } catch (e) {
      try { note(`pulse 异常已忽略: ${e.message || e}`); } catch (_) { /* ignore */ }
    }
  };

  /**
   * 双时钟：主线程 setInterval（正常时）+ Worker setInterval（窗口最小化/后台时
   * Chromium 会把前者掐到分钟级甚至更狠，Worker 相对能扛）。两边都触发也无妨，
   * tick 有 busy/幂等守卫。
   */
  function startClocks() {
    state.timer = setInterval(pulse, CONFIG.pollMs);
    try {
      const src = `setInterval(() => postMessage(1), ${CONFIG.pollMs});`;
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const worker = new Worker(url);
      // 仅在页面隐藏时用 Worker 补拍，前台避免与 setInterval 双打
      worker.onmessage = () => {
        if (document.visibilityState === "hidden" || document.hidden) pulse();
      };
      state.worker = worker;
      state.workerUrl = url;
    } catch (_) {
      // CSP 禁止 blob Worker 时退回纯 setInterval，前台仍然可用
      state.worker = null;
    }
  }

  function stopClocks() {
    if (state.timer) { clearInterval(state.timer); state.timer = 0; }
    if (state.worker) {
      try { state.worker.terminate(); } catch (_) { /* ignore */ }
      state.worker = null;
    }
    if (state.workerUrl) {
      try { URL.revokeObjectURL(state.workerUrl); } catch (_) { /* ignore */ }
      state.workerUrl = "";
    }
  }

  startClocks();
  paintBadge();
  state.onHotkey = onHotkey;
  window.addEventListener?.("keydown", state.onHotkey, true);

  // 只把「在输入框打字」当人工：滑动对话、点空白都不该碰自托管。
  // 取消后置 hold，避免下一拍 send 分支又 arm，看起来像读秒被重置。
  state.onComposerHuman = ev => {
    const t = ev.target;
    if (!t || !findComposer()) return;
    const composer = findComposer();
    if (t === composer || composer.contains?.(t) || t.closest?.("[data-codex-composer], .ProseMirror")) {
      state.lastHumanInputAt = now();
      if (state.selfHostTimer) {
        state.selfHostHold = true;
        cancelSelfHost("输入框人工，等下一轮");
      }
    }
  };
  state.onHotkey = onHotkey;
  window.addEventListener?.("keydown", state.onHotkey, true);
  document.addEventListener?.("input", state.onComposerHuman, true);
  document.addEventListener?.("keydown", state.onComposerHuman, true);
  // 脚本加载即拉起看门狗（协议未注册时静默提示一次）
  ensureWatchdog(true).catch(() => {});
  state.watchdogTimer = setInterval(() => { ensureWatchdog().catch(() => {}); }, 60000);

  // 窗口变小时把指示器夹回可视区
  state.onResize = () => { applyPos(); };
  window.addEventListener?.("resize", state.onResize);

  // 回到前台立刻补一拍并重算几何：最小化期间可能积压了好几轮状态
  state.onVisibility = () => {
    if (document.visibilityState === "visible") {
      applyPos();
      pulse();
    }
  };
  document.addEventListener?.("visibilitychange", state.onVisibility);

  note(`已启动，阈值 ${state.threshold}（0.5 会话判定 / 后台双时钟 / CDP kick）`);

  /** 供进程外 CDP 看门狗强制推进一拍。渲染进程被后台限流时，Runtime.evaluate 仍能进来。 */
  function kick(reason) {
    if (reason) state.lastKickAt = now();
    pulse();
    return {
      ok: true,
      status: state.status,
      round: state.round,
      engaged: state.engaged,
      enabled: CONFIG.enabled,
      busy: state.busy,
    };
  }

  /**
   * CDP 看门狗探活（只探测，不自动拉起 —— 需要时手动跑 start-retry-watchdog.cmd）。
   * 在线则状态条正常；不在线显示「看门狗✗」。
   */
  async function ensureWatchdog(force) {
    const t = now();
    if (!force && t - state.watchdogCheckedAt < 20000) return state.watchdogAlive;
    state.watchdogCheckedAt = t;

    try {
      const res = await fetch(CONFIG.watchdogPingUrl, { cache: "no-store" });
      if (res.ok) {
        if (!state.watchdogAlive) note("看门狗在线");
        state.watchdogAlive = true;
        return true;
      }
    } catch (_) { /* 不在 */ }

    if (state.watchdogAlive !== false) note("看门狗未运行（手动启动：start-retry-watchdog.cmd）");
    state.watchdogAlive = false;
    return false;
  }

  function destroy() {
    CONFIG.enabled = false;
    stopClocks();
    clearSelfHostTimer();
    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = 0;
    }
    if (state.onResize) window.removeEventListener?.("resize", state.onResize);
    if (state.onVisibility) document.removeEventListener?.("visibilitychange", state.onVisibility);
    if (state.onHotkey) window.removeEventListener?.("keydown", state.onHotkey, true);
    if (state.onComposerHuman) {
      document.removeEventListener?.("input", state.onComposerHuman, true);
      document.removeEventListener?.("keydown", state.onComposerHuman, true);
    }
    document.getElementById(HOST_ID)?.remove();   // 连带移除面板和指示器
    document.getElementById(BADGE_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    console.log("[retry-rescue] destroyed");
  }

  window[API_KEY] = {
    destroy,
    kick,
    forceTick: kick,
    config: CONFIG,
    state,
    togglePanel,
    saveSettings,
    applyPos,
    // 调试 / 测试用
    read: readRetry,
    button: buttonState,
    composer: findComposer,
    shouldRearm,
    updateRetryActivity,
    endRetrySession,
    flowing,
    producedSinceRetry,
    threadLen,
    layoutUsable,
    readFatalError,
    readCurrentThreadId,
    clickNewChat,
    handleFatalError,
    confirmFatalPending,
    markCurrentFatalsResidual,
    ensureWatchdog,
    startConfirmWindow,
    clearConfirmWindow,
    rateLimitVisible,
    quickNewChatResume,
    sendContinueNow,
  };
})();
