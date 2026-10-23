type RemoveShortcutEvent = Pick<
  globalThis.KeyboardEvent,
  'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'getModifierState'
>

export function isAltRemoveShortcut(e: RemoveShortcutEvent): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.getModifierState('AltGraph')) {
    return false
  }
  // 仅为 Option+C 的 ç 兜底，不把其他布局的物理 KeyC 当成字符 c。
  const key = e.key.toLowerCase()
  return key === 'c' || (key === 'ç' && e.code === 'KeyC')
}
