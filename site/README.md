# 产品站

`codex-retry-rescue` 的官网源码。Vite 8 + React 19 + Tailwind 4，纯静态、无后端、无第三方脚本。

```bash
npm install
npm run dev        # http://localhost:5173/codex-retry-rescue/
npm run build      # 产物在 dist/
npm run preview    # 本地预览构建产物
```

## 发布

产物不放在本仓库，而是拷到 [`vg188/h5-release`](https://github.com/vg188/h5-release) 的 `/codex-retry-rescue/`，由那边统一走 Cloudflare Pages 部署：

```bash
npm run build
rm -rf ../../h5-release/codex-retry-rescue
mkdir -p ../../h5-release/codex-retry-rescue
cp -r dist/* ../../h5-release/codex-retry-rescue/
touch ../../h5-release/codex-retry-rescue/.nojekyll
```

`vite.config.ts` 里的 `base: "/codex-retry-rescue/"` 必须和挂载路径一致，改了路径要同步改它，否则资源 404。

## 两条约束

- **字体自托管**：`src/fonts/` 里的 woff2 来自 `@fontsource/*`，构建时打进 `assets/`。不要换成 Google Fonts / jsDelivr 链接——国内访问不稳，这是硬要求。中文不下载字体，落本机衬线（思源宋体/宋体）与无衬线（苹方/微软雅黑）。
- **两套断点各自排版**：`lg`（1024px）以上是横构图，以下是竖排。配置表与平台适配表在窄屏换成定义列表/卡片，不是同一张表硬缩。移动端的锚点条是横向滚动的，所以整页不应出现横向溢出。
