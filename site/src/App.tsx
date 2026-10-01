import { useActiveSection, useIsNarrow } from "./hooks";
import { BACKOFF, META, STATS } from "./content";
import { Boundaries, Config, Faults, Guardrails, Install, KeepAlive, Path, Platform, SelfHost } from "./Sections";
import { Reveal, Wrap } from "./ui";

const NAV = [
  { id: "faults", label: "三类故障" },
  { id: "path", label: "判定路径" },
  { id: "guardrails", label: "护栏" },
  { id: "platform", label: "换服务商" },
  { id: "install", label: "安装" },
  { id: "config", label: "配置" },
];
const NAV_IDS = NAV.map(n => n.id);

const LOG_MIN = Math.log10(0.2);
const LOG_MAX = Math.log10(75600);
const barWidth = (s: number) => Math.max(2, ((Math.log10(s) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100);

function Wordmark() {
  return (
    <a href="#top" className="flex items-baseline gap-2.5 no-underline">
      <span className="font-display text-[1.35rem] leading-none text-ink">Retry Rescue</span>
      <span className="mono-label hidden sm:inline">codex++ userscript</span>
    </a>
  );
}

function GithubPill({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href={META.repo}
      className={`inline-flex shrink-0 items-center gap-2 border border-ink bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper no-underline transition-colors hover:border-rescue hover:bg-rescue ${compact ? "" : "px-4 py-2 text-[13px]"}`}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-[15px] fill-current">
        <path d="M8 .2a8 8 0 0 0-2.5 15.6c.4.07.55-.17.55-.38v-1.34c-2.23.5-2.7-1.08-2.7-1.08-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.84 1.23.84.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.9-3.65-3.98 0-.88.31-1.6.83-2.16-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.52-1.03 2.19-.82 2.19-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.28.83 2.16 0 3.09-1.88 3.78-3.67 3.97.29.25.55.74.55 1.49v2.21c0 .21.15.46.56.38A8 8 0 0 0 8 .2Z" />
      </svg>
      {compact ? "GitHub" : "源码 · MIT"}
    </a>
  );
}

function Nav() {
  const narrow = useIsNarrow(1023);
  const active = useActiveSection(NAV_IDS);
  const links = NAV.map(n => (
    <a
      key={n.id}
      href={`#${n.id}`}
      aria-current={active === n.id ? "true" : undefined}
      className={
        narrow
          ? "mono-label !normal-case !tracking-[0.04em] !text-[12px] shrink-0 whitespace-nowrap text-ink-3 no-underline aria-[current=true]:!text-rescue"
          : "mono-label !normal-case !tracking-[0.02em] !text-[13px] font-medium text-ink-2 no-underline transition-colors hover:text-rescue aria-[current=true]:!text-rescue"
      }
    >
      {n.label}
    </a>
  ));
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/92 backdrop-blur-[6px]">
      <Wrap className="flex items-center justify-between gap-4 py-3.5">
        <Wordmark />
        {!narrow ? (
          <nav className="flex items-center gap-6">
            {links}
            <GithubPill />
          </nav>
        ) : (
          <GithubPill compact />
        )}
      </Wrap>
      {narrow ? (
        <nav className="scrollbar-none -mb-px flex gap-4 overflow-x-auto border-t border-rule-soft px-5 py-2.5">
          {links}
        </nav>
      ) : null}
    </header>
  );
}

/** 指数退避时刻表：本页的核心数据物件，也是「为什么不能调大重试次数」的证据 */
function BackoffPanel() {
  return (
    <figure className="border border-rule bg-paper-2">
      <figcaption className="mono-label !normal-case flex flex-wrap items-center justify-between gap-2 border-b border-rule-soft px-4 py-2.5">
        <span>指数退避 · 约 0.2s × 2⁽ⁿ⁻¹⁾</span>
        <span className="text-ink-3">对数刻度</span>
      </figcaption>
      <div className="px-4 py-4 lg:px-5">
        <div className="mono-label grid grid-cols-[1.6rem_minmax(0,1fr)_3.9rem_3.2rem] gap-3 pb-2">
          <span>n</span>
          <span>退避曲线</span>
          <span className="text-right">这一次</span>
          <span className="text-right">累计</span>
        </div>
        <ul className="space-y-2.5">
          {BACKOFF.map(row => {
            const isCut = row.n >= 7 && row.n <= 9;
            const isLimit = row.n === 10;
            return (
              <li key={row.n} className="grid grid-cols-[1.6rem_minmax(0,1fr)_3.9rem_3.2rem] items-center gap-3">
                <span className={`font-mono text-[12.5px] ${isLimit ? "text-ink" : "text-ink-3"}`}>{row.n}</span>
                <span className="relative flex h-[10px] items-center bg-paper-3/70">
                  <span
                    className={`block h-full transition-[width] duration-1000 ${isCut ? "bg-rescue" : isLimit ? "bg-ink-3" : "bg-ink"}`}
                    style={{ width: `${barWidth(row.seconds)}%` }}
                  />
                  {isLimit ? (
                    <span className="mono-label absolute left-[3px] -top-[1px] flex h-[11px] items-center !text-[9px] !tracking-[0.08em] text-paper">
                      上限
                    </span>
                  ) : null}
                </span>
                <span className={`text-right font-mono text-[12px] ${isCut ? "font-medium text-rescue" : "text-ink"}`}>
                  {row.once}
                </span>
                <span className="text-right font-mono text-[12px] text-ink-3">{row.total}</span>
              </li>
            );
          })}
        </ul>
        <div className="mt-5 space-y-2 border-t border-rule-soft pt-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-[7px] inline-block size-2 shrink-0 bg-rescue" aria-hidden />
            <p className="text-[13px] leading-[1.6] text-ink-2">
              <b className="font-medium">脚本在这里动手</b>：第 7~9 次失败被证实后打断，把预算归零。
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="mt-[7px] inline-block h-[2px] w-2 shrink-0 bg-ink-3" aria-hidden />
            <p className="text-[13px] leading-[1.6] text-ink-3">第 10 次：Codex 放弃，整个 turn 作废。</p>
          </div>
        </div>
      </div>
    </figure>
  );
}

function Hero() {
  return (
    <section id="top" className="relative pt-14 pb-4 lg:pt-24">
      <Wrap>
        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
          <div className="animate-rise">
            <div className="mono-label">
              v{META.version} · MIT · 单文件用户脚本
            </div>
            <h1 className="mt-6 text-[2.55rem] leading-[0.95] sm:text-[3.3rem] lg:mt-7 lg:text-[4rem]">
              第 12 次重试，
              <br />
              <span className="text-rescue whitespace-nowrap">要等 6 分 48 秒。</span>
            </h1>
            <p className="mt-7 max-w-[47ch] text-[16.5px] leading-[1.8] text-ink-2 lg:text-[17.5px]">
              Codex 撞上上游抖动会指数退避地重试，到上限就把整个 turn 作废。而退避的尾部不是「多等一会儿」——第 20 次要等 21 小时。这个脚本在界面层替你盯着：该归零时归零，该换会话时换会话，不该动的时候一动不动。
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href="#install"
                className="inline-flex items-center gap-2 border border-ink bg-ink px-5 py-2.5 text-[14px] font-medium text-paper no-underline transition-colors hover:border-rescue hover:bg-rescue"
              >
                装上它 <span aria-hidden>→</span>
              </a>
              <a
                href="#path"
                className="inline-flex items-center gap-2 border border-rule px-5 py-2.5 text-[14px] font-medium text-ink no-underline transition-colors hover:border-ink"
              >
                看它怎么判
              </a>
            </div>
            <p className="mono-label mt-6 max-w-[44ch] leading-[1.7] !normal-case !tracking-[0.01em] !text-[12.5px]">
              注意：它会模拟点击你的界面按钮。先在不在乎的对话里试跑一轮。
            </p>
          </div>

          <Reveal delay={120}>
            <BackoffPanel />
          </Reveal>
        </div>

        {/* 数据条 */}
        <Reveal delay={80}>
          <dl className="mt-16 grid grid-cols-2 gap-x-8 gap-y-8 border-t border-rule pt-8 lg:mt-24 lg:grid-cols-4">
            {STATS.map(s => (
              <div key={s.label}>
                <dd className="m-0 flex items-baseline gap-1">
                  <span className="font-display text-[2.6rem] leading-none lg:text-[3.1rem]">{s.k}</span>
                  {s.u ? <span className="font-mono text-[13px] text-ink-3">{s.u}</span> : null}
                </dd>
                <dt className="mt-2 text-[14px] font-medium text-ink">{s.label}</dt>
                <p className="mt-1 text-[13px] leading-[1.6] text-ink-3">{s.note}</p>
              </div>
            ))}
          </dl>
        </Reveal>
      </Wrap>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-24 border-t border-rule py-12 lg:mt-32">
      <Wrap>
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div>
            <Wordmark />
            <p className="mt-4 max-w-[46ch] text-[14.5px] leading-[1.8] text-ink-2">
              为用不惯「等它自己好」的人写的。所有判定逻辑、踩过的坑和为什么，都在{" "}
              <a className="underline decoration-rule underline-offset-4 hover:decoration-rescue" href={META.designDoc}>
                docs/DESIGN.md
              </a>{" "}
              里。
            </p>
            <p className="mono-label mt-6">本页不加载任何外部资源 · 字体随包发布</p>
          </div>
          <nav className="grid grid-cols-2 gap-x-6 gap-y-2.5 self-start text-[14px]">
            {[
              { href: META.repo, label: "源码仓库" },
              { href: META.readme, label: "README" },
              { href: META.designDoc, label: "设计说明" },
              { href: META.issues, label: "提问题" },
              { href: META.scriptPath, label: "脚本原文" },
              { href: META.hub, label: "返回产品导航" },
            ].map(l => (
              <a
                key={l.label}
                href={l.href}
                className="text-ink-2 no-underline transition-colors hover:text-rescue"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="mono-label mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-rule-soft pt-6">
          <span>© 2026 vg188 · MIT</span>
          <span>本项目与 OpenAI / Codex 官方无关</span>
        </div>
      </Wrap>
    </footer>
  );
}

export default function App() {
  return (
    <div className="relative z-10">
      <Nav />
      <main>
        <Hero />
        <Faults />
        <Path />
        <Guardrails />
        <KeepAlive />
        <Platform />
        <Install />
        <Config />
        <SelfHost />
        <Boundaries />
      </main>
      <Footer />
    </div>
  );
}
