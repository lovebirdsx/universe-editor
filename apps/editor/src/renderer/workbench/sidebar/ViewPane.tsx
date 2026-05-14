import { useState, type ReactNode } from 'react'
import styles from './ViewPane.module.css'

interface ViewPaneProps {
  title: string
  children: ReactNode
  initiallyOpen?: boolean
}

export function ViewPane({ title, children, initiallyOpen = true }: ViewPaneProps) {
  const [open, setOpen] = useState(initiallyOpen)

  return (
    <section className={styles['viewPane']}>
      <button className={styles['header']} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`${styles['chevron']} ${open ? styles['open'] : ''}`}>›</span>
        {title}
      </button>
      <div className={`${styles['body']} ${open ? '' : styles['collapsed']}`}>{children}</div>
    </section>
  )
}
