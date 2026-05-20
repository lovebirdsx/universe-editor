import { SquareTerminal, type LucideIcon } from 'lucide-react'

const ICON_MAP: Record<string, LucideIcon> = {
  output: SquareTerminal,
}

export function resolvePanelIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? SquareTerminal
}
