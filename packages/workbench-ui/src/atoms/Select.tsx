/*---------------------------------------------------------------------------------------------
 *  Select — a fully self-rendered dropdown replacing the native <select>. The
 *  popup is drawn by us (not the OS), so it follows the app theme instead of the
 *  platform color scheme — native <option> lists ignore CSS background and show
 *  white in dark mode, which this avoids. Floating UI handles positioning,
 *  keyboard navigation, typeahead and dismissal; the trigger mirrors Input.
 *--------------------------------------------------------------------------------------------*/

import { useRef, useState, type ReactNode } from 'react'
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  size,
  useClick,
  useDismiss,
  useRole,
  useListNavigation,
  useTypeahead,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
} from '@floating-ui/react'
import { cx } from './cx.js'
import styles from './Select.module.css'

export interface SelectOption<T extends string> {
  readonly value: T
  readonly label: ReactNode
  /** Text used for typeahead matching; falls back to `value`. */
  readonly text?: string
}

export interface SelectProps<T extends string> {
  readonly value: T
  readonly options: readonly SelectOption<T>[]
  readonly onChange: (value: T) => void
  readonly disabled?: boolean
  readonly invalid?: boolean
  readonly className?: string | undefined
  readonly 'aria-label'?: string
  readonly 'data-testid'?: string
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  invalid = false,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const { refs, floatingStyles, context } = useFloating<HTMLButtonElement>({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        apply({ rects, elements, availableHeight }) {
          Object.assign(elements.floating.style, {
            minWidth: `${rects.reference.width}px`,
            maxHeight: `${Math.min(availableHeight - 8, 280)}px`,
          })
        },
        padding: 8,
      }),
    ],
  })

  const listRef = useRef<Array<HTMLElement | null>>([])
  const labelsRef = useRef<Array<string>>(options.map((o) => o.text ?? o.value))
  labelsRef.current = options.map((o) => o.text ?? o.value)

  const click = useClick(context, { enabled: !disabled })
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'listbox' })
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    onNavigate: setActiveIndex,
    loop: true,
  })
  const typeahead = useTypeahead(context, {
    listRef: labelsRef,
    activeIndex,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    ...(open ? { onMatch: setActiveIndex } : {}),
  })

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNav,
    typeahead,
  ])

  const select = (index: number) => {
    const opt = options[index]
    if (!opt) return
    onChange(opt.value)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        className={cx(styles['trigger'], invalid && styles['invalid'], className)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        {...getReferenceProps()}
      >
        <span className={styles['value']}>{selected ? selected.label : ' '}</span>
        <svg
          className={styles['chevron']}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              className={styles['popover']}
              style={floatingStyles}
              {...getFloatingProps()}
            >
              {options.map((opt, index) => {
                const active = activeIndex === index
                const isSelected = opt.value === value
                return (
                  <div
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    data-active={active}
                    tabIndex={active ? 0 : -1}
                    ref={(node) => {
                      listRef.current[index] = node
                    }}
                    className={styles['item']}
                    {...getItemProps({
                      onClick: () => select(index),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          select(index)
                        }
                      },
                    })}
                  >
                    {opt.label}
                  </div>
                )
              })}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}
