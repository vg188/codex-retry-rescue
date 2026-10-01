import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "climbing" | "confirm" | "rescued" | "success";

const TICK = 560;
const MAX = 10;
/** 演示用压缩节奏：真实退避是 0.2s × 2^(n-1)，这里只保留形状 */
const attemptSec = (n: number) => 0.2 * 2 ** (n - 1);

const fmt = (s: number) => (s >= 90 ? `${(s / 60).toFixed(1)}min` : `${s.toFixed(1)}s`);

export default function Demo() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [running, setRunning] = useState(false);
  const [n, setN] = useState(1);
  const [threshold, setThreshold] = useState(8);
  const [rescues, setRescues] = useState(0);
  const [succeedNext, setSucceedNext] = useState(false);
  const [log, setLog] = useState<string[]>(["待命中 · 按钮是「发送」。点「跑一轮」开始观察"]);
  const timer = useRef<number | undefined>(undefined);

  const say = useCallback((line: string) => {
    setLog(prev => [...prev.slice(-5), line]);
  }, []);

  const reset = useCallback(() => {
    setRunning(false);
    setPhase("idle");
    setN(1);
    setRescues(0);
    setThreshold(7 + Math.floor(Math.random() * 3));
    setLog(["已重置 · 本轮临界次数重新随机"]);
  }, []);

  // 主推进循环：一次 tick 只做一件事，状态迁移全在这里
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      if (phase === "climbing") {
        if (n > threshold) {
          setPhase("confirm");
          say(`跳号确认：第 ${n - 1} 次失败。给第 ${n} 次 ${ (3 + Math.random()).toFixed(1) }s 验收窗`);
          return;
        }
        setN(v => v + 1);
        say(`正在重新连接 ${n + 1}/${MAX} · 第 ${n} 次失败已证实`);
        return;
      }
      if (phase === "confirm") {
        if (succeedNext) {
          setPhase("success");
          setRunning(false);
          say(`这一发接上了，正文开始流动 → 撤销打断`);
          return;
        }
        say("验收窗结束：仍在重连、无正文 → 落稳 0.4s 点「停止」");
        setPhase("rescued");
        return;
      }
      if (phase === "rescued") {
        const next = rescues + 1;
        setRescues(next);
        say("已点「停止」→ 等 4.2s → 点「继续」，重试预算归零");
        if (next >= 2) {
          setRunning(false);
          setPhase("success");
          say("这一发真的连上了，正文开始输出 → 脱离接管");
          return;
        }
        setN(1);
        setThreshold(7 + Math.floor(Math.random() * 3));
        setPhase("climbing");
        say("新一轮重连开始，临界次数重新随机");
      }
    }, TICK);
    timer.current = id;
    return () => window.clearInterval(id);
  }, [running, phase, n, threshold, rescues, succeedNext, say]);

  const start = () => {
    if (phase === "success") reset();
    setRunning(true);
    setPhase(p => (p === "idle" ? "climbing" : p));
    say(succeedNext ? "开始观察：下一发其实能接上" : "开始观察：每一发都失败");
  };

  const waited = Array.from({ length: Math.min(n, MAX) }, (_, i) => attemptSec(i + 1)).reduce((a, b) => a + b, 0);
  const stateLabel =
    phase === "success" ? "已连上" : phase === "confirm" ? "验收窗" : phase === "rescued" ? "准备打断" : running ? "重连中" : "待命";

  return (
    <div className="border border-rule bg-paper">
      <div className="mono-label flex flex-wrap items-center justify-between gap-3 border-b border-rule-soft px-4 py-2.5">
        <span>演示 · 判定路径</span>
        <span className="text-ink-3">节奏已压缩，真实退避见上方时刻表</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* 读数 */}
        <div className="border-b border-rule-soft px-4 py-5 lg:border-b-0 lg:border-r lg:px-6 lg:py-7">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="mono-label">composer 按钮</div>
              <div className="mt-1 font-mono text-[13px] font-medium">
                {running || phase === "success" ? (phase === "success" ? "发送 / 继续" : "停止") : "发送"}
              </div>
            </div>
            <div className="text-right">
              <div className="mono-label">状态</div>
              <div
                className={`mt-1 font-mono text-[13px] font-medium ${
                  phase === "confirm" || phase === "rescued" ? "text-rescue" : phase === "success" ? "text-linked" : "text-ink"
                }`}
              >
                {stateLabel}
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-baseline gap-2">
            <span className="font-mono text-[30px] font-medium leading-none sm:text-[34px]">
              {Math.min(n, MAX)}
            </span>
            <span className="font-mono text-[15px] text-ink-3">/ {MAX}</span>
            <span className="ml-2 text-[14px] text-ink-2">{phase === "idle" ? "尚未进入重连" : "正在重新连接"}</span>
          </div>

          {/* 十格计数条：已过 = 墨，正在验收 = 橙 */}
          <div className="mt-4 flex gap-1" aria-hidden>
            {Array.from({ length: MAX }, (_, i) => {
              const idx = i + 1;
              const passed = idx < n;
              const at = idx === n;
              return (
                <span
                  key={idx}
                  className={`h-2.5 flex-1 transition-colors duration-300 ${
                    passed ? "bg-ink" : at ? (phase === "confirm" || phase === "rescued" ? "bg-rescue" : "bg-ink-3") : "bg-paper-3"
                  }`}
                />
              );
            })}
          </div>
          <div className="mono-label !normal-case mt-3 flex flex-wrap justify-between gap-x-4">
            <span>临界 T = {threshold}</span>
            <span>本轮已等 ≈ {fmt(waited)}</span>
            <span>已救 {rescues} 轮</span>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={start}
              disabled={running}
              className="border border-ink bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-rescue hover:border-rescue disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper-3 disabled:text-ink-3"
            >
              {running ? "正在观察…" : phase === "success" ? "再跑一次" : "跑一轮"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="border border-rule px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:border-ink hover:text-ink"
            >
              重置
            </button>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-[13px] text-ink-2 select-none">
              <input
                type="checkbox"
                checked={succeedNext}
                onChange={e => setSucceedNext(e.target.checked)}
                className="size-3.5 accent-[#d8451f]"
              />
              让这一发真的接上
            </label>
          </div>
        </div>

        {/* 日志 */}
        <div className="px-4 py-5 lg:px-6 lg:py-7">
          <div className="mono-label">脚本判断</div>
          <ul className="mt-3 space-y-2">
            {log.map((line, i) => (
              <li
                key={`${i}-${line.slice(0, 12)}`}
                className={`font-mono text-[12.5px] leading-[1.6] ${
                  i === log.length - 1 ? "text-ink" : "text-ink-3"
                }`}
              >
                <span className="mr-2 text-rule select-none">›</span>
                {line}
              </li>
            ))}
            <li className="font-mono text-[12.5px] text-ink-3">
              <span className="mr-2 text-rule select-none">›</span>
              <span className="inline-block size-2 translate-y-[1px] bg-rescue animate-blink" />
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
