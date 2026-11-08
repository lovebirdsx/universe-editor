import { useFullscreen } from '../fullscreen.js'
import { strings } from '../strings.js'

export interface FullscreenButtonProps {
  readonly className?: string | undefined
  readonly testId?: string | undefined
  readonly onToggled?: (() => void) | undefined
}

export function FullscreenButton({ className, testId, onToggled }: FullscreenButtonProps) {
  const { supported, active, toggle } = useFullscreen()
  if (!supported) return null

  const label = active ? strings.fullscreenExit : strings.fullscreenEnter
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      aria-label={label}
      onClick={() => {
        toggle()
        onToggled?.()
      }}
    >
      {label}
    </button>
  )
}
