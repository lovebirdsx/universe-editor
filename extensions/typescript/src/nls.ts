/** Localization stub for the TypeScript extension. Keys + English defaults
 *  establish the translation contract; ZH_CN provides the Chinese surface.
 *  Mirrors the git extension's `nls.ts`. */

const ZH_CN: Readonly<Record<string, string>> = {
  'ts.status.starting.tooltip': '正在启动 TypeScript 语言服务…',
  'ts.status.error.text': 'TypeScript',
  'ts.status.error.tooltip': 'TypeScript 语言服务启动失败',
  'ts.oom.notification':
    'TypeScript 语言服务内存不足（上限 {limitMb} MB）。请在设置中调大 "typescript.tsserver.maxTsServerMemory"。',
}

const useZhCn = (process.env.UNIVERSE_DISPLAY_LOCALE ?? '').toLowerCase().startsWith('zh')

export function localize(
  key: string,
  defaultMessage: string,
  vars?: Record<string, unknown>,
): string {
  const template = (useZhCn ? ZH_CN[key] : undefined) ?? defaultMessage
  if (!vars) return template
  return template.replace(/\{([^}]+)\}/g, (match, rawKey) => {
    const k = String(rawKey).trim()
    const v = vars[k]
    return v === undefined ? match : String(v)
  })
}
