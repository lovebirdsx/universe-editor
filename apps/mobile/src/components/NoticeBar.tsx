import { strings } from '../strings.js'

export interface NoticeBarProps {
  readonly text: string
  readonly onDismiss: () => void
}

export function NoticeBar({ text, onDismiss }: NoticeBarProps) {
  return (
    <div className="notice" role="status">
      <span>{text}</span>
      <button type="button" className="notice__dismiss" onClick={onDismiss}>
        {strings.noticeDismiss}
      </button>
    </div>
  )
}
