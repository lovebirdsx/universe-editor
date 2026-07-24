import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

// 扩展在 workspace 之外，从 apps/editor 借 @playwright/test 做栅格化；
// 本机 playwright 浏览器缓存可能与包版本错位，显式指向已下载的 chromium
const require = createRequire(resolve(import.meta.dirname, '../../../apps/editor/package.json'))
const { chromium } = require('@playwright/test')
const executablePath = join(
  process.env.LOCALAPPDATA,
  'ms-playwright/chromium-1181/chrome-win/chrome.exe',
)

const extRoot = resolve(import.meta.dirname, '..')
const svg = readFileSync(resolve(extRoot, 'icon.svg'), 'utf8')

const browser = await chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 256, height: 256 } })
await page.setContent(
  `<!doctype html><html><body style="margin:0">${svg.replace('width="128" height="128"', 'width="256" height="256"')}</body></html>`,
)
const buf = await page.locator('svg').screenshot({ omitBackground: true })
await browser.close()
writeFileSync(resolve(extRoot, 'icon.png'), buf)
console.log(`icon.png written, ${buf.length} bytes`)
