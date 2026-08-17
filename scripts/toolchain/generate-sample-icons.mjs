#!/usr/bin/env node
/*
 * 生成 samples 与 create-extension 模板的示例图标（256×256 PNG）。
 * 图标是脚本产物：改设计改这里，然后 `node scripts/toolchain/generate-sample-icons.mjs` 重跑。
 * pngjs 借自 apps/editor 的依赖（与 mcp-bridge 的 rasterize-icon.mjs 同一借法）。
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(resolve(import.meta.dirname, '../../apps/editor/package.json'))
const { PNG } = require('pngjs')

const repoRoot = resolve(import.meta.dirname, '../..')
const SIZE = 256
const SCALE = 2 // 128 逻辑坐标 → 256 输出
const PURPLE = [107, 63, 160] // #6b3fa0 品牌紫（内置扩展 icon 同款底色）
const WHITE = [255, 255, 255]

// --- 距离场（128 逻辑坐标系） ---
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const alpha = (d) => clamp01(0.5 - d)

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r
const union = (x, y, parts) => Math.min(...parts.map((fn) => fn(x, y)))

const base = (x, y) => sdRoundRect(x, y, 64, 64, 40, 40, 24) // 全幅 rx24 圆角方块

// hello-world：白色对话气泡（「hello…」）+ 尾巴 + 三个紫点
const helloWhite = [
  (x, y) => sdRoundRect(x, y, 64, 55, 34, 23, 14),
  (x, y) => sdCircle(x, y, 45, 84, 7),
]
const helloDots = [48, 64, 80].map((cx) => (x, y) => sdCircle(x, y, cx, 55, 4))

// webview-panel：白色浏览器窗口 + 顶部三个控制点 + 两行内容条
const panelWhite = [(x, y) => sdRoundRect(x, y, 64, 64, 38, 36, 10)]
const panelDots = [40, 52, 64].map((cx) => (x, y) => sdCircle(x, y, cx, 38, 3.5))
const panelBars = [
  (x, y) => sdRoundRect(x, y, 64, 65, 28, 5, 5),
  (x, y) => sdRoundRect(x, y, 56, 83, 20, 5, 5),
]

/** 按层合成：紫底 → 白色图形 → 紫色细节（细节被白图形裁剪）。 */
function render(whiteShape, purpleDetails) {
  const png = new PNG({ width: SIZE, height: SIZE })
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      // 2×2 超采样抗锯齿
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const x = (px + ox) / SCALE
        const y = (py + oy) / SCALE
        const aBase = alpha(base(x, y))
        if (aBase <= 0) continue
        const aWhite = aBase * alpha(union(x, y, whiteShape))
        const aDetail = aWhite * alpha(union(x, y, purpleDetails))
        let cr = PURPLE[0] * (1 - aWhite) + WHITE[0] * aWhite
        let cg = PURPLE[1] * (1 - aWhite) + WHITE[1] * aWhite
        let cb = PURPLE[2] * (1 - aWhite) + WHITE[2] * aWhite
        cr = cr * (1 - aDetail) + PURPLE[0] * aDetail
        cg = cg * (1 - aDetail) + PURPLE[1] * aDetail
        cb = cb * (1 - aDetail) + PURPLE[2] * aDetail
        r += cr * aBase
        g += cg * aBase
        b += cb * aBase
        a += aBase
      }
      if (a <= 0) continue
      const idx = (py * SIZE + px) * 4
      png.data[idx] = Math.round(r / a)
      png.data[idx + 1] = Math.round(g / a)
      png.data[idx + 2] = Math.round(b / a)
      png.data[idx + 3] = Math.round((a / 4) * 255)
    }
  }
  return PNG.sync.write(png)
}

const targets = [
  [render(helloWhite, helloDots), 'samples/hello-world/icon.png'],
  [render(helloWhite, helloDots), 'packages/create-extension/templates/basic/icon.png'],
  [render(panelWhite, panelDots.concat(panelBars)), 'samples/webview-panel/icon.png'],
  [render(panelWhite, panelDots.concat(panelBars)), 'packages/create-extension/templates/webview/icon.png'],
]

for (const [buf, rel] of targets) {
  writeFileSync(resolve(repoRoot, rel), buf)
  console.log(`${rel}: ${buf.length} bytes`)
}
