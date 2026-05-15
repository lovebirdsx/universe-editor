import * as React from 'react'
import { cn } from '@universe-editor/shared'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

type VariantStyle = {
  background: string
  color: string
  hoverBackground: string
  border?: string
}

const VARIANT_STYLES: Record<NonNullable<ButtonProps['variant']>, VariantStyle> = {
  primary: {
    background: 'var(--color-accent, #0070e0)',
    color: '#ffffff',
    hoverBackground: '#1f87e6',
  },
  secondary: {
    background: 'var(--color-dropdown-bg, #2f2f35)',
    color: 'var(--color-foreground, #c8c8c8)',
    hoverBackground: 'var(--color-sidebar-section-header-hover, #3a3a40)',
    border: '1px solid var(--color-border, #0f0f11)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-foreground, #c8c8c8)',
    hoverBackground: 'var(--color-toolbar-hover-bg, rgba(255,255,255,0.06))',
  },
}

const SIZE_STYLES: Record<NonNullable<ButtonProps['size']>, React.CSSProperties> = {
  sm: { padding: '4px 10px', fontSize: 12 },
  md: { padding: '6px 14px', fontSize: 13 },
  lg: { padding: '8px 18px', fontSize: 14 },
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  style,
  children,
  ...props
}: ButtonProps) {
  const [hover, setHover] = React.useState(false)
  const v = VARIANT_STYLES[variant]
  const s = SIZE_STYLES[size]

  const merged: React.CSSProperties = {
    background: hover ? v.hoverBackground : v.background,
    color: v.color,
    border: v.border ?? 'none',
    borderRadius: 3,
    fontFamily: 'var(--font-ui, system-ui)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 0.1s, color 0.1s',
    ...s,
    ...style,
  }

  return (
    <button
      className={cn('ue-btn', `ue-btn--${variant}`, `ue-btn--${size}`, className)}
      style={merged}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...props}
    >
      {children}
    </button>
  )
}
