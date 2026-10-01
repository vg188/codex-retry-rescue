// 站点文案与数据。数字都与仓库里的 docs/DESIGN.md、README.md 对齐，改一处要改两处。

export const META = {
  version: "0.11.0",
  repo: "https://github.com/vg188/codex-retry-rescue",
  issues: "https://github.com/vg188/codex-retry-rescue/issues",
  designDoc: "https://github.com/vg188/codex-retry-rescue/blob/main/docs/DESIGN.md",
  readme: "https://github.com/vg188/codex-retry-rescue/blob/main/README.md",
  hub: "https://h.yourba.top/",
  scriptPath: "https://raw.githubusercontent.com/vg188/codex-retry-rescue/main/user_scripts/codex-retry-rescue.js",
};

/** 指数退避：约 0.2s × 2^(n-1)。条宽按 log10 归一化。 */
export const BACKOFF = [
  { n: 1, once: "0.2s", total: "0.2s", seconds: 0.2 },
  { n: 5, once: "3.2s", total: "6s", seconds: 3.2 },
  { n: 8, once: "26s", total: "51s", seconds: 25.6 },
  { n: 10, once: "1.7min", total: "3.4min", seconds: 102 },
  { n: 12, once: "6.8min", total: "14min", seconds: 410 },
  { n: 15, once: "55min", total: "1.8h", seconds: 3300 },
  { n: 20, once: "21h", total: "43h", seconds: 75600 },
];

export const STATS = [
  { k: "3", u: "类", label: "故障分流", note: "断流 / 限流 / 会话死亡" },
  { k: "700", u: "ms", label: "主循环轮询", note: "后台由 Worker 与看门狗补拍" },
  { k: "8", u: "s", label: "迁移延迟确认", note: "防止一点开旧会话就误伤" },
  { k: "0", u: "", label: "外部请求", note: "不发分析、不加载境外 CDN" },
];

export const FAULTS = [
  {
    idx: "01",
    name: "通道满 · 上游断流",
    ui: "正在重新连接 8/10",
    verdict: "打断，把重试预算归零",
    body: "流断了，请求本身没问题，所以原地「继续」是有效的。脚本不在次数停住时动手——那可能只是刚连上正在思考；它要看到 8/10 跳到 9/10，也就是上一发确实失败了，才进下一步。",
    detail: "跳号后再给这一发 3~4 秒验收窗：开始出字、重连行消失、或冒出限流，立刻撤销打断。窗口结束仍卡在重连，才落稳 0.2~0.6 秒点停止，等 2.5~7 秒点继续。",
  },
  {
    idx: "02",
    name: "限流",
    ui: "rate limit exceeded … token rate limit",
    verdict: "不打断，等耗尽后再发一句",
    body: "限流和通道满是两回事。打断再继续等于在限流上又叠一次请求，只会让窗口更长。这类错误命中后，脚本一条都做不了——不点停止、不点继续、不开新聊天，只观察。",
    detail: "等 Codex 自己把 10 次跑完、按钮回到「发送」，再在同一会话里发一句「继续」。限流文案常常在验收窗中途才刷出来，所以它是一票否决：动手前还要再查一次。",
  },
  {
    idx: "03",
    name: "会话死亡",
    ui: "bad response status code 400 (request id: …)",
    verdict: "开新对话，把任务接过去",
    body: "400 是请求被拒，不是流断。同一个会话再打同一个包，结果必然还是 400，原地继续没有意义。这类只能迁移：点「新聊天」，发一句读取旧会话的指令。",
    detail: "代价最高，所以闸也最多：本 turn 没真正跑起来过就当历史残留；错误框要连续存在 8 秒；同一条会话最多迁 3 次；你正在打字就先不动。",
  },
];

export const GUARDRAILS = [
  { k: "残留不算现役", v: "历史重试行和旧错误框会永久留在 transcript 里。只有本 turn 内次数真的爬升过、或本 turn 跑起来后新出现的错误才会触发动作。" },
  { k: "跳号只证明上一发", v: "8/10 → 9/10 说明第 8 次失败了，不说明第 9 次也会失败。所以跳号之后还有验收窗，而不是立刻下手。" },
  { k: "限流一票否决", v: "验收窗内出现限流就撤销；点停止之前最后再查一次。宁可不救。" },
  { k: "只认正面识别的按钮", v: "停止 / 发送 / 继续 之外的未知态（例如「排队」）一律不点，也不改状态机。" },
  { k: "切会话即复位", v: "thread id 一变，接管状态清零、现存错误框全部登记为残留。点开一条带 400 的旧对话不会被自动迁移。" },
  { k: "草稿不覆盖 · 有熔断", v: "输入框有字就不写不发；单会话最多接管 30 轮、最多迁移 3 次，防止自己跑飞。" },
];

export const CONFIG_ROWS = [
  { k: "enabled", d: "true", v: "总开关" },
  { k: "enablePreventiveRescue", d: "true", v: "是否允许预防性打断；关掉就只等耗尽后续跑" },
  { k: "skipPreventiveOnRateLimit", d: "true", v: "限流时跳过打断" },
  { k: "thresholds", d: "[7, 8, 9]", v: "每轮随机抽临界次数，避免固定节奏" },
  { k: "confirmWindowMs", d: "[3000, 4000]", v: "跳号后给新一发证明自己的窗口" },
  { k: "settleMs", d: "[200, 600]", v: "确认失败后的落稳" },
  { k: "resumeDelayMs", d: "[2500, 7000]", v: "打断到点「继续」之间等多久" },
  { k: "postRateLimitResumeMs", d: "[1000, 3000]", v: "限流时点继续前多躲一下" },
  { k: "continueText", d: "继续", v: "耗尽续跑与快捷按钮发的文本" },
  { k: "selfHost · selfHostDelayMs", d: "false · [30s, 300s]", v: "无人值守：轮次结束后自动续跑" },
  { k: "selfHostDelaySkew", d: "2.5", v: "读秒向小秒数加权的强度" },
  { k: "sessionIdleMs", d: "30000", v: "次数停爬多久算会话结束" },
  { k: "minRescueGapMs", d: "15000", v: "两次救援之间的最小间隔" },
  { k: "maxRounds", d: "30", v: "单会话最多接管轮数" },
  { k: "fatalCodes", d: "[400, 413, 422]", v: "哪些状态码算会话已死" },
  { k: "fatalConfirmMs", d: "8000", v: "错误框要连续存在多久才迁移" },
  { k: "maxMigrations", d: "3", v: "迁移次数熔断" },
  { k: "migratePrompt", d: "读取{threadId}，继续", v: "迁移时发的文本" },
  { k: "pollMs", d: "700", v: "主循环间隔" },
];

export const PLATFORM_ROWS = [
  { k: "retryText", what: "重试行长什么样", d: "正在重新连接|重新连接|Reconnecting|Reconnect" },
  { k: "rateLimitText", what: "限流文案，命中就不打断", d: "rate\\s*limit|…|\\b429\\b|限流|超出.{0,6}限" },
  { k: "fatalText", what: "会话已死的文案；第 1 组必须是状态码", d: "bad response status code\\s*(\\d{3})" },
  { k: "fatalRequestId", what: "取请求标识做去重；没有就留空", d: "request id:\\s*([^)\\s]+)" },
  { k: "fatalContainers", what: "错误框的 DOM 特征，命中才算错误框", d: "aside,.wrap-anywhere" },
];

/** 自托管读秒的实测分布（skew=2.5，20 万次抽样） */
export const SELFHOST_BUCKETS = [
  { range: "30–60s", pct: 41.6 },
  { range: "60–90s", pct: 13.3 },
  { range: "90–120s", pct: 9.7 },
  { range: "120–180s", pct: 14.6 },
  { range: "180–240s", pct: 11.4 },
  { range: "240–300s", pct: 9.4 },
];

export type InstallStep = {
  idx: string;
  title: string;
  body: string;
  code: string | null;
  lang: string | null;
};

export const INSTALL_STEPS: InstallStep[] = [
  {
    idx: "01",
    title: "放进用户脚本目录",
    body: "Codex++ 从 %APPDATA%\\Codex++\\user_scripts\\ 读取脚本。",
    code: 'copy codex-retry-rescue.js "%APPDATA%\\Codex++\\user_scripts\\"',
    lang: "cmd",
  },
  {
    idx: "02",
    title: "启用",
    body: "在 Codex++ 管理工具里打开这个脚本，等价于清单里这一项为 true。",
    code: '{\n  "enabled": true,\n  "scripts": { "user:codex-retry-rescue.js": true }\n}',
    lang: "user_scripts.json",
  },
  {
    idx: "03",
    title: "热重载",
    body: "右下角出现状态条就算注入成功。它会开始记录每一拍的判定，日志在面板里。",
    code: null,
    lang: null,
  },
  {
    idx: "04",
    title: "先改平台文案",
    body: "换过网关的人第一步就该改 CONFIG.platform，否则报错文案对不上。认不出来是安全的失败方向——它不会乱点。",
    code: null,
    lang: null,
  },
];

export const WATCHDOG_CMD = `node codex-retry-watchdog.mjs

:: 可选参数
node codex-retry-watchdog.mjs --interval 1000
node codex-retry-watchdog.mjs --port 9329
node codex-retry-watchdog.mjs --no-focus-emulation
node codex-retry-watchdog.mjs --quiet`;

export const WATCHDOG_LOG = [
  "11:07:23  kick#412 status=retrying engaged=false round=3 enabled=true busy=false",
  "11:07:25  kick#413 status=retrying engaged=false round=3 enabled=true busy=false",
  "11:07:27  kick#414 status=retrying engaged=true  round=3 enabled=true busy=false",
  "11:07:29  kick#415 status=streaming engaged=true round=3 enabled=true busy=false",
];

export const BOUNDARIES = [
  { q: "它会点我正在用的界面？", a: "会。它的全部能力就是模拟点击停止 / 继续 / 新聊天，并往输入框写字。请先在不在乎的对话里试跑；不想让它动手就把 enablePreventiveRescue 关掉，或直接把总开关拨到暂停。" },
  { q: "窗口最小化还能救吗？", a: "能，但要额外跑那个独立 Node 看门狗。页面内的定时器会被 Chromium 掐紧，这一层在渲染进程里改不动；看门狗从进程外用 CDP 强制推进。前提是你用 Codex++ 启动 Codex。" },
  { q: "界面改版了怎么办？", a: "选择器和文案都要重新对一次：CONFIG.platform 里的五条，加上 composer 按钮的 aria-label。脚本内注释标了实测形态，改起来是定位问题不是考古问题。" },
  { q: "为什么不直接调大 stream_max_retries？", a: "退避是指数增长的。第 15 次要等 55 分钟，第 20 次要等 21 小时——次数越大，越是在干等。有效的是在退避还短时把预算归零。" },
];
