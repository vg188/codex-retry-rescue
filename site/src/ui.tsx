import type { ReactNode } from "react";
import { useCopy, useReveal } from "./hooks";

export function Wrap({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1180px] px-5 sm:px-7 lg:px-10 ${className}`}>{children}</div>;
}

export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`reveal ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/** 区块头：等宽编号 + 衬线大标题 + 一句导语 */
export function SectionHead({
  num,
  en,
  title,
  lead,
}: {
  num: string;
  en: string;
  title: ReactNode;
  lead?: ReactNode;
}) {
  return (
    <header className="border-t border-rule pt-5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="mono-label">
          {num} <span className="mx-1 text-rule">/</span> {en}
        </span>
      </div>
      <h2 className="mt-5 max-w-[26ch] text-[2.1rem] leading-[0.98] sm:text-[2.7rem] lg:mt-6 lg:text-[3.4rem]">
        {title}
      </h2>
      {lead ? <p className="mt-5 max-w-[52ch] text-[16.5px] text-ink-2 lg:mt-6">{lead}</p> : null}
    </header>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="group relative border border-rule bg-paper-2">
      {label ? (
        <div className="mono-label flex items-center justify-between border-b border-rule-soft px-3 py-1.5 lg:px-4">
          <span>{label}</span>
          <button
            type="button"
            onClick={() => void copy(code)}
            className="mono-label !tracking-[0.1em] text-ink-3 transition-colors hover:text-rescue"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      ) : null}
      <pre className="overflow-x-auto px-3 py-3 text-[12.5px] leading-[1.7] lg:px-4 lg:text-[13px]">
        <code className="font-mono text-ink">{code}</code>
      </pre>
    </div>
  );
}

/** 一行「术语 + 说明」的编辑式列表项 */
export function DefRow({ term, desc }: { term: ReactNode; desc: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-t border-rule-soft py-4 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:gap-6 sm:py-5">
      <dt className="font-mono text-[13px] font-medium text-ink">{term}</dt>
      <dd className="m-0 text-[15px] leading-[1.7] text-ink-2">{desc}</dd>
    </div>
  );
}

export function Mark({ children }: { children: ReactNode }) {
  return <span className="text-rescue">{children}</span>;
}
