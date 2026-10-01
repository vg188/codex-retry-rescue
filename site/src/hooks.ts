import { useCallback, useEffect, useRef, useState } from "react";

/** 进入视口时加 is-in。只观察一次，进场后立刻 unobserve。 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/** 当前视口里的是哪个区块，用来点亮导航。都不在视口里时清空，避免回到顶部还亮着最后一屏。 */
export function useActiveSection(ids: string[]) {
  const [active, setActive] = useState("");
  useEffect(() => {
    const els = ids.map(id => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add((e.target as HTMLElement).id);
          else visible.delete((e.target as HTMLElement).id);
        }
        // 中间那条带里同时有多个区块时，取占比最大的
        const top = ids.find(id => visible.has(id));
        setActive(top ?? "");
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.25, 0.6] },
    );
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 没有剪贴板权限（http 上下文、旧浏览器）时退回选中文本，至少能手动复制
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { copied, copy };
}

/** 是否窄屏。移动与桌面是两套排布，不只是断点样式不同时需要。 */
export function useIsNarrow(maxWidth = 1023) {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}
