import { type ReactNode } from 'react'
import styles from './ViewPane.module.css'

interface ViewPaneProps {
  title: string
  children: ReactNode
  open: boolean
  onToggle: () => void
}

export function ViewPane({ title, children, open, onToggle }: ViewPaneProps) {
  return (
    <section className={styles['viewPane']}>
      <button className={styles['header']} onClick={onToggle} aria-expanded={open}>
        <span className={`${styles['chevron']} ${open ? styles['open'] : ''}`}>›</span>
        {title}
      </button>
      <div className={`${styles['body']} ${open ? '' : styles['collapsed']}`}>{children}</div>
    </section>
  )
}
