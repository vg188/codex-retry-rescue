import { BOUNDARIES, CONFIG_ROWS, FAULTS, GUARDRAILS, INSTALL_STEPS, META, PLATFORM_ROWS, SELFHOST_BUCKETS, WATCHDOG_CMD, WATCHDOG_LOG } from "./content";
import Demo from "./Demo";
import { CodeBlock, DefRow, Mark, Reveal, SectionHead, Wrap } from "./ui";

/* 01 · 三类故障 */
export function Faults() {
  return (
    <section id="faults" className="pt-20 lg:pt-28">
      <Wrap>
        <SectionHead
          num="01"
          en="what it fixes"
          title={<>三种坏法，<br className="sm:hidden" />三套动作</>}
          lead="把它们混成一条逻辑是这个脚本最早犯的错：限流时打断等于继续加请求，会话已死时原地继续必然再吃一次 400。现在它们各走各的分支。"
        />
        <div className="mt-12 lg:mt-16">
          {FAULTS.map((f, i) => (
            <Reveal key={f.idx} delay={i * 60}>
              <article className="grid grid-cols-1 gap-x-10 gap-y-3 border-t border-rule py-8 lg:grid-cols-[7rem_minmax(0,20rem)_minmax(0,1fr)] lg:py-10">
                <div className="flex items-baseline gap-4 lg:block">
                  <span className="font-display text-[2.4rem] leading-none text-rule lg:text-[3.6rem]">{f.idx}</span>
                </div>
                <div>
                  <h3 className="text-[1.55rem] lg:text-[1.75rem]">{f.name}</h3>
                  <p className="mt-3 break-all font-mono text-[12px] leading-[1.65] text-ink-3 lg:text-[12.5px]">
                    「{f.ui}」
                  </p>
                  <p className="mt-4 text-[14px] font-medium text-rescue">{f.verdict}</p>
                </div>
                <div className="space-y-3 text-[15.5px] leading-[1.8] text-ink-2">
                  <p>{f.body}</p>
                  <p className="border-l border-rule pl-4 text-[14.5px] text-ink-3">{f.detail}</p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

/* 02 · 判定路径 */
export function Path() {
  return (
    <section id="path" className="pt-20 lg:pt-28">
      <Wrap>
        <SectionHead
          num="02"
          en="decision path"
          title={<>它每一拍只问一句：<br className="hidden lg:block" />现在按钮是什么？</>}
          lead="不靠观察器、不靠事件流，700 毫秒读一次界面状态再决定。下面是全部规则，没有隐藏分支。"
        />

        <Reveal className="mt-12 lg:mt-16">
          <div className="grid grid-cols-1 gap-px bg-rule lg:grid-cols-2">
            <Branch
              cond="按钮 = 停止（turn 在跑）"
              rows={[
                { t: "重连次数跳号（8/10 → 9/10）", d: "上一发失败已证实" },
                { t: "且失败那发 ≥ 本轮随机临界 T", d: "T 每轮在 7 / 8 / 9 里重新抽" },
                { t: "进 3~4 秒验收窗", d: "出字 / 重连行消失 / 冒出限流 → 撤销" },
                { t: "落稳 0.2~0.6 秒 → 点停止", d: "等 2.5~7 秒 → 点继续" },
              ]}
              action="预算归零，重新开始快节奏重试"
            />
            <Branch
              cond="按钮 = 发送（turn 已停）"
              rows={[
                { t: "新出现的错误框 + 本 turn 跑起来过", d: "历史残留一律忽略" },
                { t: "错误框连续存在 8 秒", d: "期间打字或切会话立刻取消" },
                { t: "本轮重试打满且没产出", d: "同会话发一句「继续」" },
                { t: "有产出后正常收尾", d: "脱离接管，排自托管读秒" },
              ]}
              action="会话死亡 → 开新聊天接续；否则不动"
            />
          </div>
          <p className="mono-label mt-4">
            未知态（例如「排队」）<Mark>不点、不改状态机</Mark> —— 这条是 0.7.1 补的
          </p>
        </Reveal>

        <Reveal className="mt-10 lg:mt-14">
          <Demo />
        </Reveal>
      </Wrap>
    </section>
  );
}

function Branch({
  cond,
  rows,
  action,
}: {
  cond: string;
  rows: { t: string; d: string }[];
  action: string;
}) {
  return (
    <div className="bg-paper p-5 lg:p-7">
      <div className="font-mono text-[13px] font-medium text-ink">{cond}</div>
      <ol className="mt-5 space-y-4 border-l border-rule pl-5">
        {rows.map(r => (
          <li key={r.t} className="relative">
            <span className="absolute top-2 -left-[calc(1.25rem+1px)] h-px w-[1.25rem] bg-rule" aria-hidden />
            <div className="text-[14.5px] leading-[1.6] text-ink">{r.t}</div>
            <div className="mt-0.5 text-[13px] leading-[1.6] text-ink-3">{r.d}</div>
          </li>
        ))}
      </ol>
      <div className="mt-6 border-t border-rule-soft pt-3 text-[13.5px] font-medium text-rescue">{action}</div>
    </div>
  );
}

/* 03 · 护栏 */
export function Guardrails() {
  return (
    <section id="guardrails" className="pt-20 lg:pt-28">
      <Wrap>
        <SectionHead
          num="03"
          en="guard rails"
          title="误伤比不救更糟"
          lead="每一条都来自一次真实的误伤：砍掉刚连上的那一发、点开旧对话就自动迁移、把模型长考当成卡死。"
        />
        <dl className="mt-12 grid grid-cols-1 gap-x-12 lg:mt-16 lg:grid-cols-2">
          {GUARDRAILS.map((g, i) => (
            <Reveal key={g.k} delay={(i % 2) * 60}>
              <div className="border-t border-rule py-5">
                <dt className="text-[1.15rem] leading-[1.3] font-medium">
                  <span className="mono-label mr-3 align-[3px]">{String(i + 1).padStart(2, "0")}</span>
                  {g.k}
                </dt>
                <dd className="m-0 mt-2 pl-0 text-[15px] leading-[1.75] text-ink-2 lg:pl-[3.4rem]">{g.v}</dd>
              </div>
            </Reveal>
          ))}
        </dl>
      </Wrap>
    </section>
  );
}

/* 04 · 后台保活 */
export function KeepAlive() {
  return (
    <section id="keepalive" className="pt-20 lg:pt-28">
      <Wrap>
        <SectionHead
          num="04"
          en="stay alive"
          title="窗口最小化了，谁来踹一脚"
          lead="渲染进程里的 setInterval 和 Worker 都会被 Chromium 掐住，这一层在页面内改不动。所以心跳分两层：页面内自己维持，进程外从 CDP 强制注入。"
        />
        <div className="mt-12 grid grid-cols-1 gap-10 lg:mt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14">
          <div>
            <DefRow term="setInterval + Worker" desc="主循环 700ms 一拍；页面 hidden 时才让 Worker 补拍，避免前台双打。" />
            <DefRow term="visibilitychange" desc="回到前台立刻补一拍，并重算状态条位置（最小化时几何会塌成 0×0）。" />
            <DefRow term="codex-retry-watchdog.mjs" desc="独立 Node 进程，连 Codex++ 开的调试端口，每 2 秒 Runtime.evaluate 推一次 kick()。顺带开 Focus Emulation 减轻限流。" />
            <DefRow term="/ping 探活" desc="看门狗在 127.0.0.1:57328 报活；脚本只探测、不自动拉起，探不到就在状态条显示「看门狗✗」。" />
            <div className="mt-8">
              <CodeBlock label="开一个最小化的看门狗" code={WATCHDOG_CMD} />
            </div>
          </div>
          <Reveal>
            <div className="border border-rule bg-ink">
              <div className="mono-label flex items-center gap-3 border-b border-white/10 px-4 py-2.5 !text-white/45">
                <span className="inline-block size-1.5 rounded-full bg-[#3fbf7f]" />
                watchdog · terminal
              </div>
              <pre className="overflow-x-auto px-4 py-4 font-mono text-[11.5px] leading-[1.85] text-white/70 lg:text-[12px]">
                {WATCHDOG_LOG.map(l => l).join("\n")}
                {"\n"}
                <span className="text-white">11:07:31  kick#416 status=streaming engaged=true round=3</span>
                {"\n"}
                <span className="inline-block size-2 translate-y-[2px] bg-[#3fbf7f] animate-blink" />
              </pre>
              <p className="mono-label border-t border-white/10 px-4 py-2.5 !text-white/40">
                序号在涨就是活着 · 状态没变也每 10 秒报一次心跳
              </p>
            </div>
          </Reveal>
        </div>
      </Wrap>
    </section>
  );
}

/* 05 · 平台适配 */
export function Platform() {
  return (
    <section id="platform" className="pt-20 lg:pt-28">
      <Wrap>
        <div className="border-2 border-rescue p-6 lg:p-10">
          <div className="mono-label !text-rescue">05 <span className="mx-1 text-rule">/</span> bring your own wording</div>
          <h2 className="mt-5 max-w-[30ch] text-[2.1rem] leading-[0.98] sm:text-[2.7rem] lg:text-[3.4rem]">
            换了服务商，先改这五条
          </h2>
          <p className="mt-5 max-w-[54ch] text-[16.5px] text-ink-2">
            所有「报错长什么样」的正则集中在 <code className="font-mono text-[15px]">CONFIG.platform</code>。默认值是从作者自己那条链路上实测出来的，别的网关大概率不认。
          </p>

          {/* 桌面：三列表格；移动：竖排卡片。不是同一套东西换个宽度 */}
          <div className="mt-9 hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[42rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  <th className="mono-label py-2 pr-4 font-medium">字段</th>
                  <th className="mono-label py-2 pr-4 font-medium">作用</th>
                  <th className="mono-label py-2 font-medium">默认值（脚本里的写法）</th>
                </tr>
              </thead>
              <tbody>
                {PLATFORM_ROWS.map(r => (
                  <tr key={r.k} className="border-b border-rule-soft align-top">
                    <td className="py-3 pr-4 font-mono text-[13px] font-medium whitespace-nowrap">{r.k}</td>
                    <td className="py-3 pr-4 text-[14px] text-ink-2">{r.what}</td>
                    <td className="py-3 font-mono text-[12.5px] break-all text-ink-3">{r.d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-8 space-y-5 lg:hidden">
            {PLATFORM_ROWS.map(r => (
              <li key={r.k} className="border-t border-rule pt-3">
                <div className="font-mono text-[13px] font-medium">{r.k}</div>
                <div className="mt-1 text-[14px] leading-[1.6] text-ink-2">{r.what}</div>
                <div className="mt-2 font-mono text-[12px] leading-[1.6] break-all text-ink-3">{r.d}</div>
              </li>
            ))}
          </ul>

          <p className="mt-8 max-w-[60ch] text-[15px] leading-[1.8] text-ink-2">
            改错了不会把脚本弄崩：正则编译失败会退化成永不匹配。方向是故意的 —— <Mark>认不出来 = 不救</Mark>，比认错 = 乱点你的界面安全得多。另外别忘了把{" "}
            <code className="font-mono text-[14px]">fatalCodes</code> 换成你的网关真会返回、且确实代表会话救不回来的状态码。
          </p>
          <a
            href={`${META.repo}/blob/main/user_scripts/codex-retry-rescue.js`}
            className="mt-8 inline-flex items-center gap-2 border border-ink px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:border-rescue hover:text-rescue"
          >
            去源码里改这几行 <span aria-hidden>→</span>
          </a>
        </div>
      </Wrap>
    </section>
  );
}

/* 06 · 安装 */
export function Install() {
  return (
    <section id="install" className="pt-20 lg:pt-28">
      <Wrap>
        <SectionHead
          num="06"
          en="install"
          title="四步"
          lead={<>脚本本身就是一个文件，没有构建、没有依赖。源码在 <a className="underline decoration-rule decoration-1 underline-offset-4 hover:decoration-rescue" href={META.repo}>vg188/codex-retry-rescue</a>，MIT。</>}
        />
        <div className="mt-12 space-y-8 lg:mt-16">
          {INSTALL_STEPS.map((s, i) => (
            <Reveal key={s.idx} delay={i * 50}>
              <div className="grid grid-cols-1 gap-x-10 gap-y-4 border-t border-rule pt-6 lg:grid-cols-[7rem_minmax(0,22rem)_minmax(0,1fr)]">
                <div className="font-display text-[2.4rem] leading-none text-rule lg:text-[3.2rem]">{s.idx}</div>
                <div>
                  <h3 className="text-[1.4rem]">{s.title}</h3>
                  <p className="mt-2 text-[15px] leading-[1.75] text-ink-2">{s.body}</p>
                </div>
                <div>{s.code ? <CodeBlock label={s.lang ?? undefined} code={s.code} /> : null}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

/* 07 · 配置 */
export function Config() {
  return (
    <section id="config" className="pt-20 lg:pt-28">
      <Wrap>
        <SectionHead
          num="07"
          en="configuration"
          title="全部可调项"
          lead="面板里改过的值会写进 localStorage，重启仍在；thresholds 与 platform 只认脚本里的值，改完要热重载。"
        />
        {/* 桌面：真表格；移动：定义列表。两种排布各自设计过，不是同一套东西换个宽度 */}
        <div className="mt-12 hidden border-t border-rule lg:mt-16 lg:block">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-rule bg-paper-2">
                <th className="mono-label py-2.5 pl-1 font-medium">键</th>
                <th className="mono-label py-2.5 font-medium">默认</th>
                <th className="mono-label py-2.5 pr-1 text-right font-medium">作用</th>
              </tr>
            </thead>
            <tbody>
              {CONFIG_ROWS.map(r => (
                <tr key={r.k} className="border-b border-rule-soft transition-colors hover:bg-paper-2">
                  <td className="w-[19rem] py-2.5 pl-1 font-mono text-[13px] font-medium">{r.k}</td>
                  <td className="py-2.5 font-mono text-[12.5px] text-ink-3">{r.d}</td>
                  <td className="py-2.5 pr-1 text-right text-[14.5px] text-ink-2">{r.v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="mt-10 lg:hidden">
          {CONFIG_ROWS.map(r => (
            <div key={r.k} className="border-t border-rule-soft py-4">
              <dt className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="font-mono text-[13px] font-medium">{r.k}</span>
                <span className="font-mono text-[12px] text-ink-3">{r.d}</span>
              </dt>
              <dd className="m-0 mt-1.5 text-[14.5px] leading-[1.65] text-ink-2">{r.v}</dd>
            </div>
          ))}
        </dl>
      </Wrap>
    </section>
  );
}

/* 08 · 自托管 */
export function SelfHost() {
  const max = Math.max(...SELFHOST_BUCKETS.map(b => b.pct));
  return (
    <section id="selfhost" className="pt-20 lg:pt-28">
      <Wrap>
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <SectionHead
            num="08"
            en="unattended"
            title="无人值守：让它自己接下一轮"
            lead="开启后，每轮正常结束进入待命就开始读秒；到点等价于替你点一次「继续」。你在输入框打字、切会话、开新一轮 → 取消本轮，等下一轮结束再排。滑动屏幕和点空白不算干预。"
          />
          <Reveal>
            <figure className="border border-rule bg-paper-2 p-5 lg:p-7">
              <figcaption className="mono-label !normal-case">读秒间隔分布 · 30–300s 加权抽样</figcaption>
              <div className="mt-5 space-y-3">
                {SELFHOST_BUCKETS.map(b => (
                  <div key={b.range} className="flex items-center gap-3">
                    <span className="w-[6.5rem] shrink-0 font-mono text-[12px] text-ink-2">{b.range}</span>
                    <span className="h-3 flex-1 bg-paper-3">
                      <span
                        className="block h-full bg-ink transition-[width] duration-700"
                        style={{ width: `${(b.pct / max) * 100}%` }}
                      />
                    </span>
                    <span className="w-[3.2rem] shrink-0 text-right font-mono text-[12px] text-ink-3">
                      {b.pct.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
              <p className="mono-label !normal-case mt-5 border-t border-rule-soft pt-3">
                中位 77s · 均值 107s · p90 237s —— 对小秒数加权，避免固定节奏
              </p>
            </figure>
          </Reveal>
        </div>
      </Wrap>
    </section>
  );
}

/* 09 · 边界 */
export function Boundaries() {
  return (
    <section id="faq" className="pt-20 lg:pt-28">
      <Wrap>
        <SectionHead num="09" en="boundaries" title="它不做什么，以及会错在哪" />
        <div className="mt-10 lg:mt-14">
          {BOUNDARIES.map((b, i) => (
            <Reveal key={b.q} delay={i * 40}>
              <div className="grid grid-cols-1 gap-x-10 gap-y-2 border-t border-rule py-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:py-7">
                <h3 className="text-[1.25rem] leading-[1.35]">{b.q}</h3>
                <p className="m-0 text-[15px] leading-[1.8] text-ink-2">{b.a}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Wrap>
    </section>
  );
}
