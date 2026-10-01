#!/usr/bin/env node
/**
 * Codex Retry Watchdog —— 进程外 CDP 看门狗
 *
 * 为什么需要它：
 *   Codex++ 用户脚本跑在 Electron 渲染进程里。窗口最小化/后台后 Chromium 会把
 *   setInterval / Worker 定时器掐到分钟级甚至暂停，脚本自己再怎么改也推不动。
 *   但 CDP 的 Runtime.evaluate 是从外部强制注入执行的，渲染进程只要还活着就能跑。
 *
 * 做什么：
 *   1. 连上 Codex++ 打开的调试端口（默认 9229）
 *   2. 可选：Emulation.setFocusEmulationEnabled(true)，让页面以为自己有焦点
 *   3. 每隔 intervalMs 调一次 window.__codexRetryRescue.kick()，把救援循环推着走
 *
 * 用法：
 *   node codex-retry-watchdog.mjs
 *   node codex-retry-watchdog.mjs --port 9229 --interval 2000
 *   node codex-retry-watchdog.mjs --no-focus-emulation
 *
 * 存活探测：
 *   本进程在 127.0.0.1:57328 提供 /ping。用户脚本加载后定期探测，
 *   探不到就在状态条显示「看门狗✗」——脚本只探测、不会把你拉起来，
 *   要不要开机自启由你决定（见 install-autostart.ps1）。
 *   /ping 同时充当单实例锁：第二个看门狗会因端口占用自行退出。
 */

import { parseArgs } from "node:util";
import { createServer } from "node:http";

const { values: argv } = parseArgs({
  options: {
    port: { type: "string", default: process.env.CODEX_CDP_PORT || "9229" },
    host: { type: "string", default: "127.0.0.1" },
    interval: { type: "string", default: "2000" },
    "ping-port": { type: "string", default: process.env.CODEX_WATCHDOG_PING_PORT || "57328" },
    "no-focus-emulation": { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
  strict: false,
});

const HOST = argv.host || "127.0.0.1";
const PORT = Number(argv.port) || 9229;
const INTERVAL = Math.max(500, Number(argv.interval) || 2000);
const USE_FOCUS_EMU = !argv["no-focus-emulation"];
const QUIET = !!argv.quiet;
const PING_PORT = Number(argv["ping-port"]) || 57328;

// ---- /ping：给用户脚本做存活探测（单实例也靠它发现已有人在跑）----
function startPingServer() {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith("/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, t: Date.now(), interval: INTERVAL }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  srv.on("error", e => {
    if (e.code === "EADDRINUSE") {
      log(`端口 ${PING_PORT} 已被占用（可能看门狗已在跑），本实例退出`);
      process.exit(0);
    }
    log("ping 服务错误：", e.message);
  });
  srv.listen(PING_PORT, "127.0.0.1", () => {
    log(`ping 服务 http://127.0.0.1:${PING_PORT}/ping`);
  });
}

const API = `window.__codexRetryRescue`;
const KICK_EXPR = `(() => {
  const api = ${API};
  if (!api || typeof api.kick !== "function") {
    return JSON.stringify({ ok: false, reason: "script-not-loaded" });
  }
  const r = api.kick("watchdog");
  return JSON.stringify({ ok: true, ...r, t: Date.now() });
})()`;

function log(...args) {
  if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...args);
}

async function listTargets() {
  const res = await fetch(`http://${HOST}:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list -> ${res.status}`);
  const list = await res.json();
  return list.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
}

function pickPage(targets) {
  // Codex 主窗口；排除 overlay / devtools
  return (
    targets.find(t => /codex|chatgpt|chat\.openai/i.test(t.url) && !/devtools|overlay/i.test(t.url)) ||
    targets.find(t => !/devtools|overlay/i.test(t.url)) ||
    targets[0] ||
    null
  );
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error("CDP WebSocket connect timeout")), 5000);
      ws.onopen = () => { clearTimeout(to); resolve(); };
      ws.onerror = e => { clearTimeout(to); reject(new Error("CDP WebSocket error")); };
      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || "CDP error"));
          else res(msg.result);
        }
      };
      ws.onclose = () => {
        for (const { reject: rej } of this.pending.values()) rej(new Error("CDP closed"));
        this.pending.clear();
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("CDP not connected"));
      }
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timeout`));
        }
      }, 15000);
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

let cdp = null;
let focusEmuDone = false;
let lastSummary = "";
let kickCount = 0;
let lastBeatAt = 0;

async function ensureConnected() {
  if (cdp?.ws && cdp.ws.readyState === WebSocket.OPEN) return cdp;

  cdp?.close();
  const targets = await listTargets();
  const page = pickPage(targets);
  if (!page) throw new Error("no Codex page target on CDP");

  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  // 让 Runtime.evaluate 始终可用（即使页面在后台）
  await cdp.send("Runtime.enable").catch(() => {});
  if (USE_FOCUS_EMU && !focusEmuDone) {
    try {
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      focusEmuDone = true;
      log("已开启 Focus Emulation（页面认为自己有焦点，减轻后台限流）");
    } catch (e) {
      log("Focus Emulation 不可用，仅靠 kick 推进：", e.message);
    }
  }
  log(`已连接 ${page.title || page.url}  ws=${page.webSocketDebuggerUrl.slice(0, 48)}…`);
  return cdp;
}

async function kickOnce() {
  const conn = await ensureConnected();
  const result = await conn.send("Runtime.evaluate", {
    expression: KICK_EXPR,
    returnByValue: true,
    awaitPromise: true,
  });
  const raw = result?.result?.value;
  let parsed = null;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { /* ignore */ }

  kickCount++;
  const nowMs = Date.now();
  // 心跳：状态没变也要定期报活，否则长时间 streaming 看起来像死掉了
  const beatDue = nowMs - lastBeatAt >= 10000;
  const oneLine = (text) => {
    if (text !== lastSummary || beatDue) {
      log(text);
      lastSummary = text;
      lastBeatAt = nowMs;
    }
  };

  if (!parsed?.ok) {
    oneLine(`kick#${kickCount} 失败: ${parsed?.reason || result?.exceptionDetails?.text || "kick-failed"}`);
    return;
  }

  // 每拍都带序号+状态，便于肉眼确认循环还在跑
  oneLine(
    `kick#${kickCount} status=${parsed.status} engaged=${parsed.engaged} `
    + `round=${parsed.round} enabled=${parsed.enabled} busy=${parsed.busy}`,
  );
}

async function loop() {
  for (;;) {
    try {
      await kickOnce();
    } catch (e) {
      focusEmuDone = false; // 重连后再试一次 focus emulation
      kickCount++;
      log(`kick#${kickCount} 连接/执行失败，稍后重试：`, e.message || String(e));
      lastSummary = "";
      lastBeatAt = Date.now();
      cdp?.close();
      cdp = null;
    }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

log(`Codex Retry Watchdog 启动  CDP=${HOST}:${PORT}  interval=${INTERVAL}ms  focusEmu=${USE_FOCUS_EMU}`);
log("脚本侧需要 v0.6+（提供 __codexRetryRescue.kick）。窗口最小化后本进程仍会推进救援。");
startPingServer();
loop();
