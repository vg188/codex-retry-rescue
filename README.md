# Codex Retry Rescue

给 Codex 桌面版（经 **Codex++** 注入的用户脚本）用的自动救援工具：网关抖动、限流、以及「会话已经救不回来」这三类故障，它替你接管收尾，不用一直盯着屏幕点重试。

**产品站：<https://h.yourba.top/codex-retry-rescue/>**（源码在本仓库 `site/`，Vite + React + Tailwind，字体自托管，构建产物发布到 `vg188/h5-release`）

> ⚠️ 它的工作方式是**模拟点击你自己的界面按钮**（停止 / 继续 / 新聊天）并往输入框写字。请先在不在乎的对话里试跑，确认行为后再挂后台。所有能力都可以单独关掉。

## 它管哪几类故障

| 界面上看到的 | 性质 | 脚本做什么 |
|---|---|---|
| `正在重新连接 8/10`、high demand、上游地址失败 | 流断了，请求本身没问题 | **预防性打断**：确认这一发已经失败后点「停止」，等几秒点「继续」，把重试预算归零 |
| `rate limit exceeded … token rate limit`、429 | 限流 | **不打断**（打断等于继续加请求）；这一轮停下后**立刻**发「继续」，不排自托管读秒 |
| `bad response status code 400/413/422` 错误框 | 请求被拒，原地继续必然再失败 | **死会话迁移**：开新聊天 + 发 `读取{threadId}，继续` |
| 重试打满、本轮没产出 | 预算耗尽 | 同一个会话里发一句「继续」 |
| 正常收尾 / 模型长时间思考没有输出 | 没坏 | **不动** |

判定细节和踩过的坑写在 [docs/DESIGN.md](docs/DESIGN.md)。

## 快速开始

1. 把 `user_scripts/codex-retry-rescue.js` 放进 Codex++ 的用户脚本目录：
   - Windows：`%APPDATA%\Codex++\user_scripts\`
2. 在 Codex++ 管理工具里启用该脚本（等价于 `user_scripts.json` 里这一项为 `true`）：

   ```json
   {
     "enabled": true,
     "scripts": { "user:codex-retry-rescue.js": true }
   }
   ```

3. 热重载或重启 Codex++。右下角出现状态条（`已救 N · 迁移 N · 自托管 …`）就说明已经注入。
4. **换了自己的网关后，先去改 `CONFIG.platform` 那一节**（见下文「换服务商先改这里」），否则报错文案对不上，脚本会「认不出来」（这是安全的失败方向）。
5. 想让窗口最小化后还能救援，再看 [后台看门狗](#后台看门狗窗口最小化也能救)。

## 换服务商先改这里：`CONFIG.platform`

脚本里所有「报错长什么样」的匹配都集中在 `user_scripts/codex-retry-rescue.js` 顶部的 `CONFIG.platform` 一节。默认值是从作者自己那条链路上实测出来的，**换了网关/中转/模型 Basic 大概率要改**。

| 字段 | 认的是什么 | 默认值（就是脚本里的写法，含双反斜杠） |
|---|---|---|
| `retryText` | 重试行：`正在重新连接 8/10` | `正在重新连接\|重新连接\|Reconnecting\|Reconnect` |
| `rateLimitText` | 限流文案，命中就不做预防性打断 | `rate\\s*limit\|token\\s*rate\\s*limit\|\\b429\\b\|限流\|超出.{0,6}限` |
| `fatalText` | 「会话已死」的错误框文案，**第 1 个捕获组必须是 3 位状态码** | `bad response status code\\s*(\\d{3})` |
| `fatalRequestId` | 从同一句文案里取请求标识用于去重；没有就填 `""` | `request id:\\s*([^)\\s]+)` |
| `fatalContainers` | 错误框的 DOM 特征（逗号分隔 CSS 选择器），命中才算错误框 | `aside,.wrap-anywhere` |

改法：

1. 先制造/等到一次真实报错，把界面上的原文抄下来（整句，别只抄数字）。
2. 把 `fatalCodes` 换成你的网关真的会返回、且确实代表「这个会话救不回来」的状态码。
3. 按抄下来的文案改上面的正则。注意是**字符串里的正则**，反斜杠要写成 `\\s`。
4. 热重载，再制造一次报错，看状态条是否出现「待确认 → 迁移」。

写坏正则不会让脚本崩掉：编译失败会退化成「永不匹配」，也就是**不救**，而不是乱点。

## 界面上的控件

右下角一条工具条：左边是状态，右边是动作键。整条可以拖动，点状态那一段展开面板（可调项 + 滚动日志）。配色跟随 Codex 自身底色，亮色主题下自动换成浅色。

| 位置 | 行为 |
|---|---|
| 状态段（点=展开面板，拖=挪位置） | 圆点颜色只回答「要不要你操心」：灰=待命/暂停、蓝=正在跑、黄=在等、绿=成了、红=出事；后面跟 `n/max` 和 `已救 N · 迁移 N · 看门狗✗` 这类补充信息 |
| **继续** 按钮 / `Ctrl+Alt+C` | 往输入框写 `continueText`（默认「继续」）并发送；**你在打字时不覆盖草稿** |
| **接续** 按钮 | 取当前会话 id → 点「新聊天」→ 填好 `读取{id}，继续` → **停住不发送**，由你确认 |
| **自托管** 按钮 | 显示 `关` / `待命` / 倒计时秒数，点一下即开关 |

**自托管**：每轮正常结束进入待命后，随机等一段时间自动等价地点一次「继续」，用于无人值守长跑。

- 间隔 `selfHostDelayMs`（默认 30–300s），并按 `selfHostDelaySkew` 向小秒数加权（实测约 41% 落在 30–60s，中位数 ~77s）
- 你在输入框打字、切换会话、开启新一轮 → **取消本轮读秒**，等下一轮结束再排
- 滑动屏幕、点空白处**不会**打断读秒
- 撞到限流并停下**不走**这条：那种情况立刻续跑（`rateLimitImmediate`）

## 配置项（脚本里的 `CONFIG`）

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `enablePreventiveRescue` | `true` | 是否允许预防性打断（关掉就只等耗尽后续跑） |
| `skipPreventiveOnRateLimit` | `true` | 限流时跳过预防性打断，等它停下 |
| `rateLimitImmediate` | `true` | 本轮撞限流停下后立刻发「继续」，不等自托管读秒 |
| `thresholds` | `[7, 8, 9]` | 每轮随机抽一个临界次数（避免固定节奏被识别） |
| `confirmWindowMs` | `[3000, 4000]` | 跳号后给「这一发」证明自己能出字的窗口 |
| `settleMs` | `[200, 600]` | 确认失败后的落稳时间 |
| `resumeDelayMs` | `[2500, 7000]` | 打断后到点「继续」之间的等待 |
| `postRateLimitResumeMs` | `[1000, 3000]` | 限流时点「继续」前多躲一下 |
| `continueText` | `继续` | 耗尽续跑 / 快捷「继续」发的文本 |
| `sendContinueHotkey` | `{ctrl+alt+c}` | 快捷键 |
| `selfHost` / `selfHostDelayMs` / `selfHostDelaySkew` | `false` / `[30s, 300s]` / `2.5` | 自托管 |
| `sessionIdleMs` | `30000` | 重试次数停止爬升多久就认定会话结束 |
| `quietMs` / `growthEpsilon` | `4000` / `40` | 「正文在流动」的判定阈值 |
| `minRescueGapMs` | `15000` | 两次救援之间的最小间隔 |
| `maxRounds` | `30` | 单会话最多接管轮数，防跑飞 |
| `fatalCodes` | `[400, 413, 422]` | 哪些状态码算会话已死 |
| `fatalConfirmMs` | `8000` | 错误框要连续存在多久才允许迁移 |
| `maxMigrations` | `3` | 迁移次数熔断 |
| `migratePrompt` | `读取{threadId}，继续` | 迁移时发的文本，`{threadId}` 会被替换 |
| `pollMs` | `700` | 主循环间隔 |

面板里改过的值会写进 `localStorage`（重启后仍生效）；`platform` 和 `thresholds` 只认脚本里的值，改完要热重载。

## 后台看门狗（窗口最小化也能救）

用户脚本跑在 Electron 渲染进程里，窗口一最小化，`setInterval` / Worker 都会被 Chromium 掐住——这一层在页面内改不动。看门狗是**独立 Node 进程**，通过 Codex++ 打开的 CDP 调试端口从外部强制 `kick()`，所以窗口看不见也能继续救援。

前提：用 **Codex++** 启动 Codex（调试端口默认 `9229`），且 Node ≥ 22（用到全局 `WebSocket`）。

```powershell
node codex-retry-watchdog.mjs                 # 默认 CDP 9229，2s 一次
node codex-retry-watchdog.mjs --interval 1000 # 1s 一次
node codex-retry-watchdog.mjs --port 9329     # 调试端口不是 9229
node codex-retry-watchdog.mjs --no-focus-emulation
node codex-retry-watchdog.mjs --quiet         # 少打日志

start-retry-watchdog.cmd                      # 或者双击，最小化跑，不抢焦点
```

- 每拍输出 `kick#序号 status=…`，序号在涨就是活着
- 看门狗在 `127.0.0.1:57328/ping` 提供存活探测，脚本探不到就在状态条显示 `看门狗✗`。**脚本只探测，不会自动把它拉起来**；要开机自启就跑 `install-autostart.ps1`（注册登录计划任务，可选）
- `/ping` 同时是单实例锁：第二个看门狗会因端口占用自行退出

## 护栏（为什么不会乱点）

- **历史残留不算现役**：重试行和错误框会永久留在 transcript 里。只有本 turn 内次数真的爬升过、或本 turn 跑起来后新出现的错误，才会触发动作
- **跳号只证明上一发失败**：`8/10 → 9/10` 之后还要过 3–4s 验收窗，这一发若开始出字、或冒出限流，立刻取消打断
- **只正面识别按钮**：`停止 / 发送 / 继续` 之外的未知态（例如「排队」）一律不点
- **切会话即复位**：点开一条带 400 的旧会话不会被自动迁移；错误框还要连续存在 8s 才动手
- **草稿保护**：输入框有内容时不覆盖、不发送
- **熔断**：单会话最多接管 `maxRounds` 轮、最多迁移 `maxMigrations` 次

## 已知边界

- 界面大改版时选择器要对一次：`retryText` / `fatalContainers` / composer 按钮的 `aria-label`（脚本内注释标了实测形态）
- 英文界面只覆盖了 `Reconnecting / Stop / Send / Continue / Resume` 这类常见词
- thread id 依赖 `/state` 面板与侧栏 `data-app-action-sidebar-thread-id`；两者都没有时迁移会跳过而不是乱填 id
- 不做 anything-but-UI 的事：不改 `config.toml`，不碰网络层。想要「流断了代理自己续」那种终态，得走本地重试代理

## 调试

控制台里可以直接调脚本暴露的接口：

```js
window.__codexRetryRescue.config      // 改配置（内存生效，重启失效）
window.__codexRetryRescue.read()      // 当前读到的重试次数
window.__codexRetryRescue.button()    // composer 按钮状态
window.__codexRetryRescue.kick()      // 手动推进一拍
window.__codexRetryRescue.destroy()   // 拆掉 UI 和定时器
```

## 许可

MIT — 见 [LICENSE](LICENSE)。
