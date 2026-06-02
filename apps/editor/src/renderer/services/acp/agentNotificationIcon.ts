/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Rasterizes a built-in agent's logo into a PNG data URL for OS desktop
 *  notifications (Electron `nativeImage` cannot consume SVG). The mark is drawn
 *  white on a rounded brand-color tile so it stays legible regardless of the OS
 *  notification theme.
 *
 *  Rasterization is async (needs an Image decode), but notifications fire on a
 *  synchronous observable edge — so callers `prime` the icon when a session
 *  appears and read the cached result synchronously via `getAgentNotificationIcon`
 *  when a notification fires. An agent without a known logo resolves to
 *  `undefined`, so the notification simply shows no icon.
 *--------------------------------------------------------------------------------------------*/

import { agentIconId } from './acpAgentRegistry.js'
import { AGENT_LOGO_BG, AGENT_LOGO_PATHS } from './agentIconData.js'

const SIZE = 64
const _resolved = new Map<string, string | undefined>()
const _pending = new Map<string, Promise<void>>()

/** Kick off (once per icon id) the async rasterization and cache its result. */
export function primeAgentNotificationIcon(agentId: string | undefined): void {
  const iconId = agentIconId(agentId)
  if (_resolved.has(iconId) || _pending.has(iconId)) return
  const path = AGENT_LOGO_PATHS[iconId]
  const bg = AGENT_LOGO_BG[iconId]
  if (path === undefined || bg === undefined) {
    _resolved.set(iconId, undefined)
    return
  }
  const job = _rasterize(path, bg)
    .then((url) => {
      _resolved.set(iconId, url)
    })
    .catch(() => {
      _resolved.set(iconId, undefined)
    })
    .finally(() => {
      _pending.delete(iconId)
    })
  _pending.set(iconId, job)
}

/** Synchronously read the cached PNG data URL for an agent, if rasterized yet. */
export function getAgentNotificationIcon(agentId: string | undefined): string | undefined {
  return _resolved.get(agentIconId(agentId))
}

function _rasterize(path: string, bg: string): Promise<string | undefined> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="14" fill="${bg}"/>` +
    `<g transform="translate(14 14) scale(1.5)" fill="#ffffff"><path d="${path}"/></g>` +
    `</svg>`
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(undefined)
        return
      }
      ctx.drawImage(img, 0, 0, SIZE, SIZE)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(undefined)
    img.src = url
  })
}
