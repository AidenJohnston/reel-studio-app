import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { usePresence } from './motion'

const ITEMS = '[role=menuitem]:not([disabled]), [role=menuitemradio]:not([disabled]), [role=menuitemcheckbox]:not([disabled])'

/**
 * A menu that grows from its trigger (`origin`), takes focus on its checked or first item, moves with the
 * arrow keys, and closes on Escape, Tab or a click outside, giving focus back to the trigger.
 */
export function PopMenu({
  open,
  onClose,
  anchor,
  label,
  style,
  origin = 'top left',
  className = '',
  testid,
  children
}: {
  open: boolean
  onClose: () => void
  anchor: RefObject<HTMLElement | null>
  label: string
  style: CSSProperties
  origin?: string
  className?: string
  testid?: string
  children: ReactNode
}) {
  const { mounted, leaving } = usePresence(open, 120)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const box = ref.current
    const first = box?.querySelector<HTMLElement>('[aria-checked=true]:not([disabled])') ?? box?.querySelector<HTMLElement>(ITEMS)
    first?.focus({ preventScroll: true })
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (!box?.contains(t) && !anchor.current?.contains(t)) onClose()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [open, anchor, onClose])

  if (!mounted) return null

  const close = () => {
    onClose()
    anchor.current?.focus({ preventScroll: true })
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (j: number) => items[(j + items.length) % items.length]?.focus()
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Escape') close()
    else if (e.key === 'Tab') {
      onClose()
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      className={`pop${leaving ? ' leave' : ''}${className ? ` ${className}` : ''}`}
      role="menu"
      aria-label={label}
      style={{ ...style, '--o': origin } as CSSProperties}
      onKeyDown={onKeyDown}
      inert={leaving || undefined}
      data-testid={testid}
    >
      {children}
    </div>
  )
}
