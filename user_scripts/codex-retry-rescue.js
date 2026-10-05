// ==UserScript==
// @name         Codex Retry Rescue
// @version      0.14.0
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
//   * 0.13 起：限流把这一轮停住后立刻发「继续」，不再排自托管读秒。判据是「本轮
//     新弹出一个报错框 + 之后没有任何实质产出 + 本轮真的跑过」，缺一条都不动手，
//     免得点开一条历史限流会话就被当成故障。
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
  const BAR_ID = "codex-retry-rescue-bar";
  const PANEL_ID = "codex-retry-rescue-panel";
  const HOST_ID = "codex-retry-rescue-host";
  const STYLE_ID = "codex-retry-rescue-style";
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
    // rate limit 时禁止预防性打断，只等耗尽后发「继续」
    skipPreventiveOnRateLimit: true,
    // 本轮确实撞到限流、且已停止 → 立刻发「继续」，不等自托管读秒
    rateLimitImmediate: true,
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
    "migratePrompt", "maxMigrations", "fatalConfirmMs"];

  // 单独按对话存储，避免旧版全局 true 自动开启所有聊天。
  const THREAD_SETTINGS_PREFIX = "codexRetryRescue.selfHost.thread.";
  const threadSelfHost = new Map();
  function selfHostEnabled(id = readThreadIdCheap()) {
    if (!id) return false;
    try {
      const value = localStorage.getItem(THREAD_SETTINGS_PREFIX + id) === "true";
      threadSelfHost.set(id, value);
      return value;
    } catch (_) { return threadSelfHost.get(id) === true; }
  }
  function setSelfHost(enabled) {
    const id = readThreadIdCheap();
    if (!id) { note("未确认当前对话 ID，自托管保持关闭"); return false; }
    threadSelfHost.set(id, !!enabled);
    try { localStorage.setItem(THREAD_SETTINGS_PREFIX + id, String(!!enabled)); } catch (_) {}
    CONFIG.selfHost = !!enabled;
    cancelSelfHost("开关变更");
    state.selfHostHold = false;
    if (enabled && CONFIG.enabled && buttonState().kind === "send") armSelfHost("当前对话手动开启");
    return true;
  }

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
    sending: false,
    disposed: false,
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
    barSig: "",
    theme: "",
    themeAt: 0,
    lastKickAt: 0,
    // 死会话迁移：同一 request id 只迁一次；整脚本最多迁 maxMigrations 次
    migrations: 0,
    actedErrKeys: new Set(),
    // 启动时/turn 开始前就躺在 transcript 里的 400 —— 绝不能当成本 turn 新故障
    residualErrKeys: new Set(),
    // 本 turn 是否真的跑起来过（见过停止钮）。没跑过就不要因历史 400 去开新聊天
    sawRunningTurn: false,
    // turn 运行期间打到的 thread id 快照。迁移时优先用它 ——
    // 迁移会切到新聊天，那时再读会读到新会话/别的会话的 id。
    turnThreadId: null,
    // 当前会话 id（用于检测「你手动切到了另一条对话」）
    currentThreadId: null,
    // 400 延迟确认：先记下候选，等 fatalConfirmMs 仍存在才动手
    pendingFatalKey: null,
    pendingFatalAt: 0,
    rateLimitCache: false,
    rateLimitCacheAt: 0,
    fatalCache: null,
    fatalCacheAt: 0,
    selfHostAt: 0,
    selfHostTimer: 0,
    selfHostGeneration: 0,
    // 人工取消后本 turn 不再排期，避免「取消→下一拍又 arm」看起来像读秒被重置
    selfHostHold: false,
    lastHumanInputAt: 0,
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
    // 本轮「新撞到限流」的证据。基准 = 已经算过的历史报错框数量，数量变多才是这一轮
    // 又弹了一个；只凭「界面上看得到限流文案」不行 —— 报错框会永久留在 transcript 里，
    // 那样点开任何一条旧限流会话都会被当成故障。撞框后又出了正文就把证据作废。
    rateLimitBase: 0,
    rateLimitHit: null,   // { len }：撞框那一刻的对话区长度（已扣除报错文案）
    rlLeaves: 0,          // 最近一次长度扫描数到的限流文案叶节点数
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
    if (!root) { state.lenCache = 0; state.lenCacheAt = t; state.rlLeaves = 0; return 0; }
    let len = (root.textContent || "").length;
    const ignored = new Set(cands);
    ignored.add(document.getElementById(HOST_ID));
    ignored.add(findComposer());
    // 顺手数一下限流文案有几份：这次扫描本来就要遍历这些叶子，不再另开一遍
    let rl = 0;
    for (const el of errorTextLeaves()) {
      ignored.add(el);
      if (RATE_LIMIT_RE.test((el.textContent || "").replace(/\s+/g, " ").trim())) rl++;
    }
    state.rlLeaves = rl;
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
   * 每拍跟一次限流报错框的数量：比基准多 = 这一轮新撞了一个，记下当时的长度作为证据。
   * 基准跟着数量下调 —— 虚拟滚动会把旧框摘掉，不降就会永远等不到「变多」。
   */
  function trackRateLimitBoxes() {
    const n = state.rlLeaves;
    if (n < state.rateLimitBase) state.rateLimitBase = n;
    if (n > state.rateLimitBase) {
      state.rateLimitBase = n;
      state.rateLimitHit = { len: state.len };
    }
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
    const ctx = captureSendContext();
    state.engaged = true;
    state.status = "acting";
    try {
      state.round++;
      const st = buttonState();
      if (st.kind !== "stop") { note(`第 ${state.round} 轮：按钮不是停止态（${st.label}），跳过`); return; }

      // 失败已证实后的落稳（随机，短；长等待已由验收窗承担）
      const settle = Math.round(rand(CONFIG.settleMs[0], CONFIG.settleMs[1]));
      if (settle > 0) await sleep(settle);
      if (!contextValid(ctx)) return;
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
      st2.btn.click();

      const delay = Math.round(rand(CONFIG.resumeDelayMs[0], CONFIG.resumeDelayMs[1]));
      note(`等待 ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
      // 限流时多躲一下再继续，避免立刻又撞上去（打断本身仍要做）
      if (rateLimitVisible()) {
        const extra = Math.round(rand(CONFIG.postRateLimitResumeMs[0], CONFIG.postRateLimitResumeMs[1]));
        note(`检测到限流，继续前多等 ${(extra / 1000).toFixed(1)}s`);
        await sleep(extra);
      }
      if (!contextValid(ctx)) { note("会话或输入已变，取消恢复"); return; }

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
    if (!CONFIG.enabled || state.disposed || !selfHostEnabled()) return;
    clearSelfHostTimer();
    const delay = Math.round(randSkew(CONFIG.selfHostDelayMs[0], CONFIG.selfHostDelayMs[1], CONFIG.selfHostDelaySkew));
    const owner = readThreadIdCheap();
    const generation = state.selfHostGeneration;
    state.selfHostAt = now() + delay;
    state.selfHostTimer = setTimeout(() => {
      if (generation !== state.selfHostGeneration) return;
      state.selfHostAt = 0;
      state.selfHostTimer = 0;
      void fireSelfHost(owner);
    }, delay);
    note(`自托管计时 ${(delay / 1000).toFixed(0)}s（${reason || ""}）`);
  }

  /** 打断计时 */
  function clearSelfHostTimer() {
    state.selfHostGeneration++;
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
    if (!CONFIG.enabled || state.disposed || !selfHostEnabled()) return;
    if (state.selfHostHold) return;
    if (state.selfHostTimer) return;
    armSelfHost(reason);
  }

  /** 顺延重排：到点但条件不合适，只往后挪一小段，不重抽满 30–300s */
  function rearmSelfHostLater(ms, owner = readThreadIdCheap()) {
    if (!CONFIG.enabled || state.disposed || state.selfHostHold || !owner || owner !== readThreadIdCheap() || !selfHostEnabled(owner)) return;
    clearSelfHostTimer();
    const generation = state.selfHostGeneration;
    state.selfHostAt = now() + ms;
    state.selfHostTimer = setTimeout(() => { if (generation !== state.selfHostGeneration) return; state.selfHostAt = 0; state.selfHostTimer = 0; void fireSelfHost(owner); }, ms);
  }

  /** 到点：等价于点一次「继续」按钮；条件不满足就短顺延 */
  async function fireSelfHost(owner) {
    if (!owner || owner !== readThreadIdCheap() || state.disposed || !CONFIG.enabled || !selfHostEnabled(owner)) return;
    if (state.selfHostHold) return;
    if (buttonState().kind !== "send") return rearmSelfHostLater(15000, owner);
    if (!composerEmpty()) return rearmSelfHostLater(20000, owner);
    if (now() - state.lastHumanInputAt < 5000) return rearmSelfHostLater(10000, owner);
    note("自托管：到点，按一次「继续」");
    if (!await sendContinueNow(true)) rearmSelfHostLater(20000, owner);
  }

  // await 后必须复核对话、输入框和人工输入；禁止两个发送流程重入。
  function captureSendContext() {
    return { id: readThreadIdCheap(), composer: findComposer(), humanAt: state.lastHumanInputAt };
  }
  function contextValid(ctx) {
    return !state.disposed && CONFIG.enabled && !!ctx.id && ctx.id === readThreadIdCheap()
      && ctx.composer === findComposer() && ctx.humanAt === state.lastHumanInputAt;
  }
  async function sendContinueNow(automatic = false) {
    if (state.busy || state.sending || !CONFIG.enabled || state.disposed) return false;
    const ctx = captureSendContext();
    if (!contextValid(ctx) || buttonState().kind !== "send" || !composerEmpty()) return false;
    state.sending = true;
    cancelSelfHost("正在续跑");
    try {
      if (!writeComposer(CONFIG.continueText)) return false;
      await sleep(150);
      if (!contextValid(ctx) || (automatic && (!selfHostEnabled(ctx.id) || state.selfHostHold))) return false;
      if ((findComposer()?.textContent || "").trim() !== CONFIG.continueText.trim()) return false;
      submitComposer();
      await sleep(300);
      if (!contextValid(ctx)) return false;
      const st = buttonState();
      return st.kind === "stop" || st.kind === "continue" || composerEmpty();
    } finally { state.sending = false; }
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
    if (state.busy || state.sending || state.disposed) return;
    state.busy = true;
    cancelSelfHost("快捷接续");
    try {
      const threadId = readCurrentThreadId();
      if (!threadId) { note("未确认当前对话 ID，取消接续"); return; }
      const prompt = (CONFIG.migratePrompt || "读取{threadId}，继续")
        .replace("{threadId}", threadId);
      note(`快捷接续：${prompt}（填入后请手动发送）`);

      const draft = (findComposer()?.textContent || "").trim();
      if (draft) {
        note("输入框有内容，先清掉或自己发，快捷接续未执行");
        return;
      }

      // 你手动接管这条线了，本轮耗尽证据作废 —— 否则切完新聊天，
      // 旧会话那侧还可能被补发一次「继续」。
      state.turnExhausted = null;

      if (!clickNewChat()) {
        note("没找到「新聊天」按钮");
        return;
      }
      const humanAt = state.lastHumanInputAt;
      await sleep(800);
      if (state.disposed || !CONFIG.enabled || readThreadIdCheap() || state.lastHumanInputAt !== humanAt) return;
      if ((findComposer()?.textContent || "").trim()) {
        note("新聊天输入框非空，不覆盖");
        return;
      }
      writeComposer(prompt);
      // 刻意不 submit —— 等你手动发
    } finally { state.busy = false; }
  }

  async function resumeByPrompt() {
    const ctx = captureSendContext();
    if (!contextValid(ctx) || !composerEmpty() || state.sending) return false;
    state.sending = true;
    try {
      if (!writeComposer(CONFIG.continueText)) return false;
      await sleep(200);
      if (!contextValid(ctx) || (findComposer()?.textContent || "").trim() !== CONFIG.continueText.trim()) return false;
      submitComposer();
      note("已发送续跑指令（不因快速结束而重复补发）");
      cancelSelfHost("已续跑");
      return true;
    } finally { state.sending = false; }
  }

  async function handleExhausted(reading, reason) {
    if (state.busy) return;
    state.busy = true;
    state.status = "acting";
    // 证据只消费一次：续跑失败也不重复轰炸，交给「脱离接管」那条路
    state.turnExhausted = null;
    state.rateLimitHit = null;
    try {
      state.round++;
      note(`第 ${state.round} 轮：${reason || "重试已耗尽并报错"}，立即用续跑提示词重新触发`);
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
   * 错误框容器判定。作者这条链路的实测形态：
   *   aside（圆角描边框 + ⓘ）> … > span.wrap-anywhere > "bad response status code 400 (…)"
   * 选择器来自 CONFIG.platform.fatalContainers，换皮时在那里改。
   */
  function inFatalContainer(el) {
    try { return FATAL_CONTAINER_SEL.some(sel => el.closest(sel)); } catch (_) { return false; }
  }

  /**
   * 致命错误框 = 错误文案叶节点里，命中状态码正则、且确实在错误容器里的那些。
   * 复用 errorTextLeaves 的扫描结果，免得每拍多扫一遍整棵树。
   * 容器这一层不能省：正文里偶然出现「400」不该被当成会话已死。
   */
  function fatalErrorLeaves() {
    const out = [];
    for (const el of errorTextLeaves()) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 300) continue;
      if (FATAL_ERR_RE.test(t) && inFatalContainer(el)) out.push(el);
    }
    return out;
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
    const m = String(value).match(/^(?:local:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return m ? m[1].toLowerCase() : null;
  }

  // 只沿正文 DOM 的 fiber.return 走最多 32 层，不递归扫描 children/state。
  // 新聊天开始后侧栏可能仍用 client-new-thread；必须核对祖先上的映射。
  function readThreadIdentityFromContent() {
    const el = document.querySelector('[data-thread-find-target="conversation"]');
    if (!el) return null;
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    let fiber = key && el[key];
    let id = null;
    let clientId = null;
    for (let depth = 0; fiber && depth < 32; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props) continue;
      id ||= normalizeConversationUuid(props.conversationId) || normalizeConversationUuid(props.threadId);
      if (typeof props.clientThreadId === "string") clientId ||= props.clientThreadId;
      if (id && clientId) break;
    }
    return id ? { id, clientId } : null;
  }

  /** 从当前选中项或明确的 thread 路由读取 ID，不限制时间前缀。 */
  function readThreadIdCheap() {
    // 轻量 DOM 读取不缓存：计时回调必须看到此刻的选中项，不能沿用旧会话。
    try {
      const sel = document.querySelector('[aria-current="page"][data-app-action-sidebar-thread-id]')
        || document.querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]')
        || document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
      const raw = sel ? (sel.getAttribute("data-app-action-sidebar-thread-id") || sel.getAttribute("data-thread-id") || "")
        : (window.location?.pathname || "").match(/\/threads\/([^/]+)/)?.[1];
      const content = readThreadIdentityFromContent();
      if (/client-new-thread/i.test(raw || "")) {
        return content && content.clientId === raw.replace(/^local:/, "") ? content.id : null;
      }
      const selectedId = normalizeConversationUuid(raw);
      // 侧栏先切、正文后切时宁可暂缓，不能把旧正文的操作送到新对话。
      if (selectedId && content && selectedId !== content.id) return null;
      return selectedId || (!sel && content ? content.id : null);
    } catch (_) { return null; }
  }

  function readCurrentThreadId() {
    // 不从正文或历史 /state 文本猜 ID，避免把被引用的其他聊天当成当前聊天。
    return readThreadIdCheap();
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
    if (state.busy || state.sending || state.disposed || !readThreadIdCheap()) return;
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
      state.turnExhausted = null;   // 会话已死，别再往它里面发「继续」
      return;
    }

    // 先看输入框：你在打字就绝不动，更不能先切到新聊天把草稿丢了
    const draft = (findComposer()?.textContent || "").trim();
    if (draft) {
      note("输入框里有你正在写的内容，迁移跳过");
      state.status = "migrate_blocked";
      state.turnExhausted = null;
      return;
    }

    // 确认期还没过也先作废本轮耗尽证据：这条会话已经救不回来，
    // 留在手里只会在迁移失败的某个拍上被当成「该发继续」。
    state.turnExhausted = null;

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
      const humanAt = state.lastHumanInputAt;
      await sleep(800);
      if (state.disposed || !CONFIG.enabled || readThreadIdCheap() || state.lastHumanInputAt !== humanAt) { note("会话或输入已变，取消迁移"); return; }
      const newComposer = findComposer();

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
      if (state.disposed || !CONFIG.enabled || readThreadIdCheap() || findComposer() !== newComposer || state.lastHumanInputAt !== humanAt) return;
      if ((newComposer?.textContent || "").trim() !== prompt.trim()) return;
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
  function syncThreadContext() {
    // 会话切换：你手动点开别的对话（含历史报错对话）时，整段 turn 状态必须清零。
    // 用轻量侧栏 id，禁止每拍 React 扫描。
    const nowTid = readThreadIdCheap();
    CONFIG.selfHost = selfHostEnabled(nowTid);
    if (nowTid !== state.currentThreadId) {
      note(`切换会话 ${state.currentThreadId?.slice(0, 8) || "无"} → ${nowTid?.slice(0, 8) || "无"}`);
      state.selfHostHold = false;
      state.prevBtnKind = null;
      state.sawRunningTurn = false;
      state.turnThreadId = null;
      state.engaged = false;
      endRetrySession("切换会话");
      clearConfirmWindow();
      cancelSelfHost("切换会话");
      state.turnExhausted = null;
      // 新会话里已有的报错框全是历史，基准必须按新 DOM 重扫一遍再定，
      // 否则「一进来就数到 3 个框」会被当成刚撞上限流。
      state.candsCacheAt = 0;
      state.candsCache = null;
      state.fatalCacheAt = 0;
      state.fatalCache = null;
      state.rateLimitCacheAt = 0;
      state.lenCacheAt = 0;
      markAllRetriesStale();
      state.len = threadLen();
      state.rateLimitHit = null;
      state.rateLimitBase = state.rlLeaves;
      markCurrentFatalsResidual();   // 新会话里已有的 400 全是残留
    }
    state.currentThreadId = nowTid;

  }

  function tick() {
    syncThreadContext();
    // 一拍只扫一次 DOM：retryCandidates 最贵，不能让 threadLen 和 readRetry 各扫一遍
    const cands = retryCandidates();
    const reading = readRetryFrom(cands);
    const len = threadLenFrom(cands);
    const grew = len > state.len;
    if (grew) state.lastGrowthAt = now();
    state.len = len;

    const st = buttonState();

    CONFIG.selfHost = selfHostEnabled();
    if (!CONFIG.enabled) { cancelSelfHost("已暂停"); state.status = "paused"; return; }
    if (state.busy || state.sending) return;

    // 限流报错框的「本轮新撞」判定要在任何分支之前先跟一遍
    trackRateLimitBoxes();

    // turn 边界：上一拍还不是 stop（send/继续/未知）现在变 stop = 新的一轮开始了。
    // 此时把现存重试行/历史错误全部打成残留，避免上一轮的计数或旧 400 进入本轮判定。
    if (st.kind === "stop" && state.prevBtnKind !== null && state.prevBtnKind !== "stop") {
      endRetrySession("新 turn 开始");
      clearConfirmWindow();
      cancelSelfHost("新 turn 开始");
      state.selfHostHold = false;   // 新一轮结束后允许再排期
      state.turnExhausted = null;   // 上一轮的耗尽证据随 turn 作废
      state.rateLimitHit = null;
      state.rateLimitBase = state.rlLeaves;   // 本轮开始就存在的框，全部算历史
      markCurrentFatalsResidual();
    }
    const nowTid = state.currentThreadId;

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

    // 撞框之后又出了实质正文 → 那一发是连上的，不是收尸现场
    if (state.rateLimitHit && state.len - state.rateLimitHit.len >= CONFIG.growthEpsilon) {
      state.rateLimitHit = null;
    }

    if (st.kind === "stop") {
      const prevSeenN = reading && state.seenN.has(reading.el) ? state.seenN.get(reading.el) : undefined;
      const active = updateRetryActivity(reading);
      const isFlowing = flowing(state, CONFIG);
      const rateLimited = rateLimitVisible();

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

      // 本轮新撞到限流、之后没有任何实质产出、并且已经停下 → 立刻续跑，不排自托管读秒。
      // 上面那条打满判定要求「看见过 10/10 这一行」，而限流经常是请求直接被打回、
      // 重连行还没冒出来（或被虚拟滚动摘掉）就已经停在发送态，于是只能干等读秒。
      // sawRunningTurn 是必需的闸：点开一条历史限流会话时按钮一直是发送态，
      // 滚动让旧框重新挂载也会让数量变多，只有「本轮真的跑过」才允许动手。
      if (CONFIG.rateLimitImmediate && state.rateLimitHit && state.sawRunningTurn
          && state.round < CONFIG.maxRounds) {
        state.status = "exhausted";
        handleExhausted(reading, "本轮撞上限流且已停止");   // 证据在这里消费掉
        return;
      }

      if (!state.engaged) {
        // 只有本轮真的跑过才排读秒。点开一条新会话（例如「创建新项目」）时按钮一直是
        // 发送态，每拍都会走到这里 —— 不加这道闸，脚本就会自己往空会话里发「继续」。
        const ranTurn = state.sawRunningTurn;
        state.status = "idle";
        state.sawRunningTurn = false;
        if (state.retrySession) endRetrySession("回到发送态且未接管");
        if (ranTurn) armSelfHostOnceOnIdle("输出结束，进入待命");
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

  // ------------------------------------------------------------ 状态与样式
  /**
   * 14 个状态收敛成 5 种语义色，颜色只回答「现在要不要你操心」，
   * 具体在做什么交给文案。原来同一种绿要分给三个状态、橙黄各两个，读不出差别。
   */
  const C = {
    neutral: "#9a958c",  // 待命 / 已暂停
    live:    "#4c8dff",  // 正在跑：运行中 / 输出中 / 已打断 / 迁移中
    wait:    "#e8a33d",  // 需要等：重试中 / 验收中 / 接管中 / 待确认
    good:    "#3fbf7f",  // 成了：已迁移 / 已完成
    bad:     "#e2573b",  // 出事：重试耗尽 / 迁移受阻
  };

  const STATUS_META = {
    paused:          { dot: C.neutral, label: "已暂停" },
    idle:            { dot: C.neutral, label: "待命" },
    running:         { dot: C.live,    label: "运行中" },
    streaming:       { dot: C.live,    label: "输出中" },
    retrying:        { dot: C.wait,    label: "重试中" },
    confirming:      { dot: C.wait,    label: "验收中" },
    acting:          { dot: C.wait,    label: "接管中" },
    interrupted:     { dot: C.live,    label: "已打断" },
    exhausted:       { dot: C.bad,     label: "重试耗尽" },
    fatal_pending:   { dot: C.wait,    label: "待确认" },
    migrating:       { dot: C.live,    label: "迁移中" },
    migrated:        { dot: C.good,    label: "已迁移" },
    migrate_blocked: { dot: C.bad,     label: "迁移受阻" },
    done:            { dot: C.good,    label: "已完成" },
  };

  /**
   * 样式一次性注入。原来四个元素各自往 cssText 上写同一段玻璃拟态，
   * 改一个数值要动四处；而且写死深色，Codex 换亮色主题就变成一块脏黑。
   * 现在颜色全部走 CSS 变量，靠 host 的 data-theme 切明暗。
   */
  const UI_CSS = `
#${HOST_ID} {
  --crr-ui: ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --crr-mono: ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace;
  --fg: #eceae6; --fg-dim: rgba(236,234,230,.56); --fg-faint: rgba(236,234,230,.34);
  --surface: rgba(20,19,17,.80); --surface-2: rgba(255,255,255,.07);
  --line: rgba(255,255,255,.13); --line-strong: rgba(255,255,255,.26); --line-soft: rgba(255,255,255,.07);
  --shadow: 0 8px 28px rgba(0,0,0,.34); --ring: rgba(120,160,255,.5);
  /* 与 JS 里的 C.neutral / C.good 同值，只用于文字状态色 */
  --neutral: #9a958c; --good: #3fbf7f;
}
#${HOST_ID}[data-theme="light"] {
  --fg: #1b1a17; --fg-dim: rgba(27,26,23,.58); --fg-faint: rgba(27,26,23,.36);
  --surface: rgba(255,255,255,.88); --surface-2: rgba(27,26,23,.05);
  --line: rgba(27,26,23,.13); --line-strong: rgba(27,26,23,.28); --line-soft: rgba(27,26,23,.08);
  --shadow: 0 8px 28px rgba(20,18,14,.13); --ring: rgba(60,100,200,.4);
}
#${HOST_ID} .crr-bar {
  pointer-events:auto; cursor:grab; user-select:none; touch-action:none;
  display:flex; align-items:center; gap:8px;
  padding:5px 8px 5px 10px; border-radius:999px;
  font:500 11.5px/1.45 var(--crr-ui); color:var(--fg);
  background:var(--surface); border:1px solid var(--line); box-shadow:var(--shadow);
  backdrop-filter:blur(12px) saturate(1.35); -webkit-backdrop-filter:blur(12px) saturate(1.35);
  transition:border-color .18s ease, box-shadow .18s ease, opacity .18s ease;
}
#${HOST_ID} .crr-bar:hover { border-color:var(--line-strong); }
#${HOST_ID} .crr-bar[data-drag="1"] { cursor:grabbing; }
#${HOST_ID} .crr-stat { display:flex;align-items:center;gap:6px;min-width:0; }
#${HOST_ID} .crr-dot { width:7px;height:7px;border-radius:50%;flex:0 0 auto;transition:background .25s ease,box-shadow .25s ease; }
#${HOST_ID} .crr-label { font-weight:600;letter-spacing:.01em;white-space:nowrap; }
#${HOST_ID} .crr-meter { font:600 11px var(--crr-mono);font-variant-numeric:tabular-nums;opacity:.92; }
#${HOST_ID} .crr-sub { font-size:10.5px;color:var(--fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
#${HOST_ID} .crr-meter:empty,#${HOST_ID} .crr-sub:empty { display:none; }
#${HOST_ID} .crr-div { width:1px;height:15px;flex:0 0 auto;background:var(--line); }
#${HOST_ID} .crr-acts { display:flex;align-items:center;gap:3px; }
#${HOST_ID} .crr-btn {
  pointer-events:auto;cursor:pointer;appearance:none;
  display:inline-flex;align-items:center;gap:5px;
  padding:3px 9px;border-radius:999px;
  font:600 11px/1.5 var(--crr-ui);
  color:var(--fg-dim);background:transparent;border:1px solid transparent;
  transition:color .15s ease,background .15s ease,border-color .15s ease,transform .08s ease;
}
#${HOST_ID} .crr-btn:hover { color:var(--fg);background:var(--surface-2);border-color:var(--line); }
#${HOST_ID} .crr-btn:active { transform:scale(.96); }
#${HOST_ID} .crr-btn[data-on="1"] { color:var(--fg);background:var(--surface-2);border-color:var(--line-strong); }
#${HOST_ID} .crr-btn[data-role="toggle"][data-on="1"] { color:var(--good); }
#${HOST_ID} .crr-btn[data-role="toggle"][data-on="0"] { color:var(--neutral); }
#${HOST_ID} .crr-btn .crr-dot { width:6px;height:6px; }
#${HOST_ID} .crr-caret { font-size:9px;color:var(--fg-faint);transition:transform .2s ease; }
#${HOST_ID} .crr-caret[data-open="1"] { transform:rotate(180deg); }
#${HOST_ID} .crr-panel {
  pointer-events:auto;user-select:none;
  width:274px;padding:11px 12px 10px;border-radius:14px;
  max-height:calc(100vh - 92px);overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;
  font:500 11.5px/1.5 var(--crr-ui);color:var(--fg);
  background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);
  backdrop-filter:blur(16px) saturate(1.35); -webkit-backdrop-filter:blur(16px) saturate(1.35);
}
#${HOST_ID} .crr-head { display:flex;align-items:center;justify-content:space-between;gap:8px; }
#${HOST_ID} .crr-title { font-size:12px;font-weight:700;letter-spacing:.02em; }
#${HOST_ID} .crr-group { font:600 9.5px var(--crr-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--fg-faint);margin:11px 0 1px; }
#${HOST_ID} .crr-group:first-of-type { margin-top:8px; }
#${HOST_ID} .crr-row { display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3.5px 0; }
#${HOST_ID} .crr-key { font-size:11px;color:var(--fg-dim);white-space:nowrap; }
#${HOST_ID} .crr-val { font:600 11px var(--crr-mono);font-variant-numeric:tabular-nums;text-align:right; }
#${HOST_ID} .crr-val[data-dim="1"] { color:var(--fg-faint);font-weight:500; }
#${HOST_ID} .crr-input {
  width:62px;padding:3px 6px;border-radius:7px;text-align:center;outline:none;
  font:600 11px var(--crr-mono);color:var(--fg);
  background:var(--surface-2);border:1px solid var(--line);
  transition:border-color .15s ease,box-shadow .15s ease;
}
#${HOST_ID} .crr-input:focus { border-color:var(--ring);box-shadow:0 0 0 2px var(--ring); }
#${HOST_ID} .crr-input[data-wide="1"] { width:118px;text-align:left;font:500 11px var(--crr-ui); }
#${HOST_ID} .crr-step {
  width:20px;height:20px;padding:0;border-radius:6px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  font-size:12px;line-height:1;color:var(--fg-dim);
  background:var(--surface-2);border:1px solid var(--line);
  transition:color .15s ease,border-color .15s ease;
}
#${HOST_ID} .crr-step:hover { color:var(--fg);border-color:var(--line-strong); }
#${HOST_ID} .crr-wide {
  flex:1;padding:5px 9px;border-radius:8px;cursor:pointer;
  font:600 11px var(--crr-ui);color:var(--fg);
  background:var(--surface-2);border:1px solid var(--line);
  transition:color .15s ease,border-color .15s ease;
}
#${HOST_ID} .crr-wide:hover { border-color:var(--line-strong); }
#${HOST_ID} .crr-foot { display:flex;gap:6px;margin-top:11px; }
/* 关着的自托管键整颗退到灰，不用看文案也知道没开 */
#${HOST_ID} #${SELF_HOST_ID}[data-on="0"] { color:var(--neutral); }
#${HOST_ID} .crr-log {
  margin-top:9px;padding-top:9px;border-top:1px solid var(--line-soft);
  font:400 10px/1.6 var(--crr-mono);color:var(--fg-dim);
  max-height:76px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;
  scrollbar-width:thin;
}
@media (prefers-reduced-motion: reduce) {
  #${HOST_ID} * { transition:none !important; animation:none !important; }
}
`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = UI_CSS;
    document.head.appendChild(tag);
  }

  /**
   * 明暗跟随 Codex 自己的界面底色，而不是系统的 prefers-color-scheme ——
   * 应用内主题可以和系统设置相反。取对话区往上第一个不透明背景算亮度。
   */
  function detectTheme() {
    try {
      for (let el = threadRoot() || document.body; el && el.nodeType === 1; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor || "";
        const m = bg.match(/[\d.]+/g);
        if (!m || m.length < 3) continue;
        if (m.length >= 4 && parseFloat(m[3]) === 0) continue;   // 全透明，继续往上找
        const [r, g, b] = m.map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? "light" : "dark";
      }
    } catch (_) { /* 拿不到样式就用深色兜底 */ }
    return "dark";
  }

  // ------------------------------------------------------ 容器与拖动
  const mk = (tag, cls, role) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (role) el.dataset.role = role;
    return el;
  };

  /**
   * 面板和工具条放在同一个容器里（面板在上、工具条在下，右对齐），
   * 这样拖动只需要移动容器，面板会自动跟着走，不用两处各算一遍坐标。
   */
  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;

    ensureStyle();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.dataset.theme = state.theme = detectTheme();
    host.style.cssText = [
      "position:fixed", "z-index:2147483600",
      "display:flex", "flex-direction:column", "align-items:flex-end", "gap:8px",
      "pointer-events:none",   // 容器本身不吃事件，只有子元素吃
    ].join(";");
    document.body.appendChild(host);
    state.themeAt = now();
    applyPos();
    return host;
  }

  /** Codex 可以运行中换主题，隔几秒重测一次底色；颜色全在样式表里，这里只翻 data-theme */
  function refreshTheme() {
    if (now() - state.themeAt < 4000) return;
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    state.themeAt = now();
    const t = detectTheme();
    if (t === state.theme) return;
    state.theme = t;
    host.dataset.theme = t;
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
   * 工具条兼作拖动手柄。难点是同一个元素既要能点（展开面板）又要能拖，
   * 所以用位移阈值区分：移动不超过 DRAG_SLOP 才算点击。
   * 条上的动作键必须排除在外，否则点「继续」会顺带把整条拖走。
   */
  const DRAG_SLOP = 4;

  function attachDrag(handle) {
    let dragging = false;
    let moved = 0;
    let startX = 0, startY = 0, startRight = 0, startBottom = 0;

    handle.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest("button")) return;
      dragging = true;
      moved = 0;
      startX = e.clientX; startY = e.clientY;
      startRight = CONFIG.pos.right; startBottom = CONFIG.pos.bottom;
      handle.setPointerCapture?.(e.pointerId);
      handle.dataset.drag = "1";
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
      delete handle.dataset.drag;
      handle.releasePointerCapture?.(e.pointerId);
      if (moved <= DRAG_SLOP) togglePanel();   // 没怎么动 = 这是一次点击
      else saveSettings();                      // 真拖了才落盘
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  // ---------------------------------------------------------------- 工具条
  /** 动作键：可选状态点 + 文案，样式全部交给样式表 */
  function mkAction(id, text, title, onClick, dotRole) {
    const el = document.createElement("button");
    el.id = id;
    el.type = "button";
    el.className = "crr-btn";
    el.title = title;
    if (dotRole) el.append(mk("span", "crr-dot", dotRole));
    el.append(mk("span", null, "btn-label"));
    el.lastChild.textContent = text;
    el.addEventListener("click", onClick);
    return el;
  }

  /**
   * 一条工具条：左边是状态（点它开关面板、拖它挪位置），右边是动作键。
   * 原来这四个是各吹各的胶囊，竖着摞成一摞互相挡，同一段玻璃样式还复制了四遍。
   */
  function ensureBar() {
    let el = document.getElementById(BAR_ID);
    if (el) return el;

    el = mk("div", "crr-bar");
    el.id = BAR_ID;
    el.title = "点击展开面板 · 拖动可移动位置";

    const stat = mk("span", "crr-stat");
    stat.append(
      mk("span", "crr-dot", "dot"),
      mk("span", "crr-label", "st-label"),
      mk("span", "crr-meter", "st-meter"),
      mk("span", "crr-sub", "st-sub"),
    );

    const acts = mk("span", "crr-acts");
    acts.append(
      mkAction(CONT_BTN_ID, "继续", "发送「继续」（Ctrl+Alt+C 亦可）", () => sendContinueNow()),
      mkAction(QUICK_BTN_ID, "接续", "新聊天并填入：读取{当前id}，继续（不自动发送）", () => quickNewChatResume()),
      mkAction(SELF_HOST_ID, "自托管 关", "仅开关当前对话的自托管（轮次结束后随机 30–300s 自动发「继续」）", () => {
        setSelfHost(!selfHostEnabled());
        paintBar();
      }, "sh-dot"),
    );

    const caret = mk("span", "crr-caret", "caret");
    caret.textContent = "▴";

    el.append(stat, mk("span", "crr-div"), acts, caret);
    attachDrag(el);
    ensureHost().appendChild(el);
    return el;
  }

  function paintBar() {
    const el = ensureBar();
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

    const on = selfHostEnabled();
    const left = state.selfHostAt ? Math.max(0, Math.round((state.selfHostAt - now()) / 1000)) : 0;
    const shText = on ? (state.selfHostTimer ? `${left}s` : "待命") : "关";
    const shColor = on ? (state.selfHostTimer ? C.good : C.wait) : C.neutral;

    const sig = `${state.status}|${meterText}|${subText}|${CONFIG.enabled}|${state.panelOpen}|${shText}|${shColor}`;
    if (sig === state.barSig) return;
    state.barSig = sig;

    const dot = el.querySelector('[data-role="dot"]');
    dot.style.background = meta.dot;
    dot.style.boxShadow = CONFIG.enabled ? `0 0 6px ${meta.dot}99` : "none";
    el.querySelector('[data-role="st-label"]').textContent = meta.label;
    el.querySelector('[data-role="st-meter"]').textContent = meterText;
    el.querySelector('[data-role="st-sub"]').textContent = subText;
    el.querySelector('[data-role="caret"]').dataset.open = state.panelOpen ? "1" : "0";
    el.style.opacity = CONFIG.enabled ? "1" : "0.5";

    const shBtn = document.getElementById(SELF_HOST_ID);
    const shDot = shBtn.querySelector('[data-role="sh-dot"]');
    shDot.style.background = shColor;
    shDot.style.boxShadow = on ? `0 0 6px ${shColor}99` : "none";
    shBtn.querySelector('[data-role="btn-label"]').textContent = `自托管 ${shText}`;
    shBtn.dataset.on = on ? "1" : "0";
  }

  // ---------------------------------------------------------------- 面板
  const mkGroup = text => {
    const g = mk("div", "crr-group");
    g.textContent = text;
    return g;
  };

  function mkRow(keyText, valueNode) {
    const row = mk("div", "crr-row");
    const k = mk("span", "crr-key");
    k.textContent = keyText;
    row.append(k, valueNode);
    return row;
  }

  function mkInfo(keyText, role, dim) {
    const v = mk("span", "crr-val", role);
    if (dim) v.dataset.dim = "1";
    return mkRow(keyText, v);
  }

  /** 数字步进器：减号 / 输入框 / 加号 */
  function mkStepper(keyText, role, { min, max, step, onSet }) {
    const wrap = mk("span", "crr-stat");

    const dec = mk("button", "crr-step");
    dec.type = "button";
    dec.textContent = "−";

    const input = mk("input", "crr-input", role);
    input.type = "text";
    input.inputMode = "numeric";

    const inc = mk("button", "crr-step");
    inc.type = "button";
    inc.textContent = "+";

    const apply = raw => {
      const v = clamp(parseInt(raw, 10) || min, min, max);
      onSet(v);
      input.value = String(v);
      saveSettings();
      paintPanel();
    };
    dec.addEventListener("click", () => apply(parseInt(input.value, 10) - step));
    inc.addEventListener("click", () => apply(parseInt(input.value, 10) + step));
    input.addEventListener("change", () => apply(input.value));
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(input.value); input.blur(); } });

    wrap.append(dec, input, inc);
    return mkRow(keyText, wrap);
  }

  function ensurePanel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;

    p = mk("div", "crr-panel");
    p.id = PANEL_ID;

    // ---- 头部：标题 + 启用开关 ----
    const head = mk("div", "crr-head");
    const title = mk("span", "crr-title");
    title.textContent = "重试救援";
    const toggle = mk("button", "crr-btn", "toggle");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      CONFIG.enabled = !CONFIG.enabled;
      saveSettings();
      note(CONFIG.enabled ? "已恢复" : "已暂停");
      paintBar(); paintPanel();
    });
    head.append(title, toggle);

    const info = mk("div");
    info.append(
      mkGroup("概览"),
      mkInfo("状态", "i-status"),
      mkInfo("重试", "i-retry"),
      mkInfo("已救轮数", "i-rounds"),
      mkInfo("会话", "i-armed"),
      mkInfo("内容", "i-flow"),
      mkInfo("自托管", "i-self"),
    );

    // ---- 参数区 ----
    const settings = mk("div");
    settings.append(
      mkGroup("参数"),
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
    const textIn = mk("input", "crr-input", "s-text");
    textIn.type = "text";
    textIn.dataset.wide = "1";
    const commitText = () => {
      const v = textIn.value.trim();
      if (v) { CONFIG.continueText = v; saveSettings(); }
      else textIn.value = CONFIG.continueText;
    };
    textIn.addEventListener("change", commitText);
    textIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); commitText(); textIn.blur(); } });
    settings.append(mkRow("续跑提示词", textIn));

    // 打断阈值只读展示：它是逻辑正确性的一部分，不开放修改
    settings.append(mkInfo("打断阈值", "i-threshold", true));

    const foot = mk("div", "crr-foot");
    const reset = mk("button", "crr-wide");
    reset.type = "button";
    reset.textContent = "重置轮数计数";
    reset.addEventListener("click", () => {
      state.round = 0;
      endRetrySession("手动重置");
      note("轮数计数已重置");
      paintBar(); paintPanel();
    });
    foot.append(reset);

    const logBox = mk("div", "crr-log", "log");

    p.append(head, info, settings, foot, logBox);
    ensureHost().prepend(p);   // 面板在工具条上方
    return p;
  }

  function paintPanel() {
    if (!state.panelOpen) return;
    const p = ensurePanel();
    const r = readRetry();
    const isFlowing = flowing(state, CONFIG);

    const on = selfHostEnabled();
    const left = state.selfHostAt ? Math.max(0, Math.round((state.selfHostAt - now()) / 1000)) : 0;
    const vals = {
      "i-status": (STATUS_META[state.status] || STATUS_META.idle).label,
      "i-retry": r ? `${r.n}/${r.max}` : "—",
      "i-rounds": `${state.round} / ${CONFIG.maxRounds}`,
      "i-armed": rateLimitVisible()
        ? "限流·不打断"
        : CONFIG.enablePreventiveRescue
          ? (state.retrySession ? (state.armed ? "活跃" : "跟踪中") : "残留/空闲")
          : "耗尽续跑",
      "i-flow": isFlowing ? "流动中" : "静默",
      "i-self": on ? (state.selfHostTimer ? `开 · ${left}s` : "开 · 待命") : "关",
      "i-threshold": `第 ${CONFIG.thresholds.join("/")} 次失败后`,
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
    toggle.dataset.on = CONFIG.enabled ? "1" : "0";

    // 输入框正在被编辑时不要覆盖，否则没法打字
    const setIfIdle = (role, value) => {
      const el = p.querySelector(`[data-role="${role}"]`);
      if (el && document.activeElement !== el) el.value = String(value);
    };
    setIfIdle("s-rounds", CONFIG.maxRounds);
    setIfIdle("s-quiet", CONFIG.quietMs);
    setIfIdle("s-idle", CONFIG.sessionIdleMs);
    setIfIdle("s-text", CONFIG.continueText);
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    const p = state.panelOpen ? ensurePanel() : document.getElementById(PANEL_ID);
    if (p) p.hidden = !state.panelOpen;
    if (state.panelOpen) paintPanel();
    paintBar();
    applyPos();   // 展开后容器变高，重新夹一次免得顶出屏幕
  }

  // ------------------------------------------------------------------ 启动
  state.lastGrowthAt = now();
  state.len = threadLen();
  // 启动时把已经躺在 transcript 里的重试行/错误全部打成残留 —— 否则「上次接管留下的
  // 8/10」或历史 400 会在第一拍就被当成新状况，误触发。
  markAllRetriesStale();
  markCurrentFatalsResidual();
  state.rateLimitBase = state.rlLeaves;   // 启动时就存在的限流框全是历史
  state.currentThreadId = readCurrentThreadId();
  CONFIG.selfHost = selfHostEnabled();

  const pulse = () => {
    try {
      tick();
      refreshTheme();
      paintBar();
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
  paintBar();

  // 只把「在输入框打字」当人工：滑动对话、点空白都不该碰自托管。
  // 取消后置 hold，避免下一拍 send 分支又 arm，看起来像读秒被重置。
  state.onComposerHuman = ev => {
    if (!ev.isTrusted) return;
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
    state.disposed = true;
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
    document.getElementById(HOST_ID)?.remove();   // 连带移除面板和工具条
    document.getElementById(STYLE_ID)?.remove();
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
    setSelfHost,
  };
})();
