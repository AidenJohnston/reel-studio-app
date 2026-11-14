import { useEffect, useLayoutEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentPropsWithRef, type ReactNode } from 'react'
import { droppedPaths } from '../api'
import { Icon, type IconName } from './icons'

/**
 * The app's three text buttons (spec section 1): primary (green pill, at most one per view), secondary (hairline pill)
 * and tertiary (text, underlined on hover). `small` is for dense rows, `big` for onboarding. Styles: styles.css `.btn`.
 */
export function Button({
  kind = 'secondary',
  size,
  danger,
  className,
  ...rest
}: ComponentPropsWithRef<'button'> & { kind?: 'primary' | 'secondary' | 'tertiary'; size?: 'small' | 'big'; danger?: boolean }) {
  const cls = ['btn', kind === 'primary' && 'primary', kind === 'tertiary' && 'ghost', size, danger && 'danger', className].filter(Boolean).join(' ')
  return <button type="button" {...rest} className={cls} />
}

/** An icon button: bare, 28 px, a wash on hover. The label is its name for screen readers and, with its shortcut, its tooltip. */
export function IconButton({
  icon,
  label,
  shortcut,
  onDark,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & { icon: IconName; label: string; shortcut?: string; onDark?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={['icon-btn', onDark && 'on-dark', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <Icon name={icon} size={16} stroke={1.75} />
    </button>
  )
}

/** A radio group is one Tab stop; the arrow keys move the choice (WAI-ARIA radio group). */
export function arrowPick<K extends string>(e: React.KeyboardEvent<HTMLElement>, keys: readonly K[], value: string | null, onPick: (k: K) => void) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (!step) return
  e.preventDefault()
  // with nothing checked (a colour the AI picked that is neither option), arrows start from the first, as Tab does (#53)
  const from = value !== null && keys.some((k) => k === value) ? value : keys[0]
  const next = keys[(keys.findIndex((k) => k === from) + step + keys.length) % keys.length]
  onPick(next)
  e.currentTarget.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus()
}
/** The radio that holds the group's Tab stop: the chosen one, or the first when none of them is (a custom colour). */
export const tabStop = (key: string, value: string | null, keys: readonly string[]): number =>
  key === (value !== null && keys.includes(value) ? value : keys[0]) ? 0 : -1

/**
 * The app's one segmented control: two to four choices on a sunk pill track, the chosen one on a lifted thumb that
 * slides to it (180 ms; instant from the keyboard or with reduced motion). Segments share the widest one's width, so
 * the thumb is one size. `value` may match no option (a custom subtitle colour): then nothing is lifted.
 */
export function Segmented<K extends string>({
  label,
  value,
  options,
  onPick,
  testid,
  className
}: {
  label: string
  value: string | null
  options: readonly { key: K; label: ReactNode; title?: string; testid?: string }[]
  onPick: (k: K) => void
  /** The group's test id; each option is `${testid}-${key}` unless it names its own. */
  testid?: string
  className?: string
}) {
  const keys = options.map((o) => o.key)
  const at = keys.findIndex((k) => k === value)
  return (
    <div
      className={['segmented', className].filter(Boolean).join(' ')}
      role="radiogroup"
      aria-label={label}
      data-testid={testid}
      onKeyDown={(e) => arrowPick(e, keys, value, onPick)}
    >
      {at >= 0 && <i className="seg-thumb" aria-hidden style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${at * 100}%)` }} />}
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          tabIndex={tabStop(o.key, value, keys)}
          title={o.title}
          data-key={o.key}
          onClick={() => onPick(o.key)}
          data-testid={o.testid ?? (testid ? `${testid}-${o.key}` : undefined)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Progress({ pct, done, label }: { pct: number; done?: boolean; label?: string }) {
  return (
    <div className={`progress${done ? ' done' : ''}`} role="progressbar" aria-label={label ?? 'Progress'} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ transform: `translateX(${Math.max(3, Math.min(100, pct)) - 100}%)` }} />
    </div>
  )
}

/** A bounded scroll box that fades out at an edge its content continues past (styles.css .fades). Edge
 * sentinels and an IntersectionObserver set data-above / data-more, so scrolling reads no layout. */
export function FadeScroll({ className, testid, children }: { className: string; testid?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLSpanElement>(null)
  const end = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el || !top.current || !end.current) return
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) el.toggleAttribute(e.target === top.current ? 'data-above' : 'data-more', !e.isIntersecting)
      },
      { root: el }
    )
    seen.observe(top.current)
    seen.observe(end.current)
    return () => seen.disconnect()
  }, [])
  return (
    <div ref={box} className={`${className} fades`} data-testid={testid}>
      <span ref={top} className="fade-edge" aria-hidden />
      {children}
      <span ref={end} className="fade-edge" aria-hidden />
    </div>
  )
}

export function Spinner() {
  return <span className="spin" aria-hidden />
}

/** Waiting on the AI's answer: three slow breathing dots, calmer than a spinner (it is thinking, not stuck). */
export function Thinking() {
  return (
    <span className="thinking" role="img" aria-label="Thinking" data-testid="thinking">
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * Toasts: a success line goes away by itself after 4 s and has no button to press. An error stays
 * until it is closed or the screen changes (App clears toasts on every screen change). It is centred over the screen's
 * main column: the one marked data-toast-column (the stage beside a side panel), else the page, so it never covers a
 * panel's header. Without either (the first run) styles.css centres it on the window.
 */
export function Toast({ text, kind, onClose, action }: { text: string; kind?: 'error' | 'info'; onClose: () => void; action?: { label: string; run: () => void } }) {
  useEffect(() => {
    if (kind === 'error') return
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [text, kind, onClose])
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const column = document.querySelector('[data-toast-column]') ?? document.querySelector('main.main')
    if (!column) return
    const place = (): void => {
      const t = el.current
      if (!t) return
      const col = column.getBoundingClientRect()
      t.style.left = `${col.left + col.width / 2}px`
      t.style.maxWidth = `${Math.min(640, col.width - 48)}px`
    }
    place()
    // the column changes size with the window and when the sidebar folds
    const sizes = new ResizeObserver(place)
    sizes.observe(column)
    return () => sizes.disconnect()
  }, [])
  return (
    <div ref={el} className={`toast${kind === 'error' ? ' error' : ''}`} role={kind === 'error' ? 'alert' : 'status'} data-testid="toast" data-over-dialogs>
      <span>{text}</span>
      {action && (
        <button type="button" className="toast-action" onClick={action.run} data-testid="toast-action">
          {action.label}
        </button>
      )}
      {kind === 'error' && <IconButton icon="x" label="Close" onDark onClick={onClose} />}
    </div>
  )
}

/** Open dialogs in the order they opened. The newest one decides what is inert. */
const openDialogs: HTMLElement[] = []
/** Elements a dialog made inert. Inert set by anything else is never undone here. */
const madeInert = new Set<HTMLElement>()
/** A node added next to the page while a dialog is open (a toast, the drop overlay) gets the same rule. */
const added = new MutationObserver(holdBackground)

/**
 * Makes everything outside the newest open dialog inert: each sibling of its backdrop and of each ancestor, except a
 * toast (data-over-dialogs), which stays readable and closable. Undoes what no longer applies, so the page comes back
 * only when the last dialog closes, in whatever order.
 */
function holdBackground(): void {
  added.disconnect()
  const behind = new Set<HTMLElement>()
  for (let branch = openDialogs.at(-1)?.parentElement; branch?.parentElement; branch = branch.parentElement) {
    added.observe(branch.parentElement, { childList: true })
    for (const sibling of branch.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling !== branch && !sibling.hasAttribute('data-over-dialogs') && (madeInert.has(sibling) || !sibling.inert)) behind.add(sibling)
    }
  }
  for (const el of madeInert) {
    if (behind.has(el)) continue
    el.inert = false
    madeInert.delete(el)
  }
  for (const el of behind) {
    el.inert = true
    madeInert.add(el)
  }
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

/** A radio group is one Tab stop, as the browser tabs it: its checked radio, or its first when none is checked.
 * Counting every radio let Shift+Tab from a checked one leave the dialog (#118). */
function oneStopPerRadioGroup(items: HTMLElement[]): HTMLElement[] {
  const group = (name: string) => items.filter((r): r is HTMLInputElement => r instanceof HTMLInputElement && r.type === 'radio' && r.name === name)
  return items.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true
    const radios = group(el.name)
    return el.checked || (!radios.some((r) => r.checked) && radios[0] === el)
  })
}

/** A dialog. Esc and a click outside close it (when it can be closed); focus moves into it, and Tab cycles through it and
 * an error toast's buttons, never the page behind. */
export function Modal({
  children,
  onClose,
  backdropCloses = true,
  wide,
  testid,
  labelledBy
}: {
  children: ReactNode
  onClose?: () => void
  /** false: a click outside does nothing (a form with something typed in it); Esc still closes */
  backdropCloses?: boolean
  wide?: boolean
  testid?: string
  labelledBy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // A layout effect: its cleanup runs before React removes the dialog, so holdBackground never sees a detached dialog
  // on top of the stack, and the page is inert before the first paint.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const prev = document.activeElement as HTMLElement | null
    // A dialog with nothing to press ("Getting it ready…") takes focus itself.
    const first = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>('button') ?? dialog
    // everything behind the newest dialog is inert while it is open, a toast excepted
    openDialogs.push(dialog)
    holdBackground()
    first.focus()
    // aria-modal says the page behind is out of reach; without this, Tab walked into it.
    const trap = (e: KeyboardEvent) => {
      // only the newest dialog moves focus: a dialog under another (the Post sheet under its Stop question) would
      // take the same Tab a second time
      if (e.key !== 'Tab' || !ref.current || openDialogs.at(-1) !== ref.current) return
      // A toast over the dialogs is outside it and still has to be reachable: an error toast's buttons (Report a
      // problem, Close) follow the dialog's own controls in the cycle, and Tab from them comes back in (#118, f17e7887).
      const items = [ref.current, ...document.querySelectorAll<HTMLElement>('.toast[data-over-dialogs]')].flatMap((root) =>
        oneStopPerRadioGroup(Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null))
      )
      if (!items.length) {
        e.preventDefault()
        ref.current.focus()
        return
      }
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1
      e.preventDefault()
      items[next].focus()
    }
    window.addEventListener('keydown', trap)
    return () => {
      window.removeEventListener('keydown', trap)
      openDialogs.splice(openDialogs.indexOf(dialog), 1)
      holdBackground() // before focusing: an inert element cannot take focus
      prev?.focus?.()
    }
  }, [])
  useEffect(() => {
    if (!onClose) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  return (
    <div className="modal-backdrop" onClick={backdropCloses ? onClose : undefined}>
      <div ref={ref} tabIndex={-1} className={`modal${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-labelledby={labelledBy} data-testid={testid}>
        {children}
      </div>
    </div>
  )
}

/** "Are you sure?" with the safe choice in focus. */
export function Confirm(props: { title: string; body: string; yes: string; no: string; danger?: boolean; onYes: () => void; onNo: () => void }) {
  const titleId = useId()
  return (
    <Modal onClose={props.onNo} testid="confirm" labelledBy={titleId}>
      <h2 id={titleId}>{props.title}</h2>
      <p className="muted">{props.body}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button kind="tertiary" onClick={props.onNo} data-autofocus data-testid="confirm-no">
          {props.no}
        </Button>
        <Button kind="primary" danger={props.danger} onClick={props.onYes} data-testid="confirm-yes">
          {props.yes}
        </Button>
      </div>
    </Modal>
  )
}

/** A small "more" menu for things that should not sit next to the main action (Delete). */
export function MoreMenu({ items, label = 'More' }: { items: { label: string; run: () => void; danger?: boolean; testid?: string; disabled?: boolean }[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)') ?? [])
    items()[0]?.focus()
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    // The keys a menu answers to: arrows move, Esc closes and gives focus back to the ⋯ button, Tab leaves.
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const all = items()
        const at = all.indexOf(document.activeElement as HTMLElement)
        all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
      } else if (e.key === 'Tab') setOpen(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  return (
    <div className="more" ref={ref}>
      <button ref={trigger} className="icon-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="more">
        <Icon name="more" />
      </button>
      {open && (
        <div className="more-menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false)
                it.run()
              }}
              data-testid={it.testid}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A drop target that hands back real file paths. */
export function useFileDrop(onFiles: (paths: string[]) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  return {
    over,
    props: {
      onDragEnter: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        depth.current++
        setOver(true)
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setOver(false)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        // This zone handles it; the whole-window drop target in App must not handle it again.
        e.stopPropagation()
        depth.current = 0
        setOver(false)
        const paths = droppedPaths(e)
        if (paths.length) onFiles(paths)
      }
    }
  }
}

/** Hidden file picker behind a normal button. */
export function PickFiles({
  label,
  accept,
  onFiles,
  kind,
  size,
  icon,
  testid,
  className,
  disabled,
  'aria-label': ariaLabel
}: {
  label: string
  accept?: string
  onFiles: (p: string[]) => void
  kind?: 'primary' | 'secondary'
  size?: 'small' | 'big'
  icon?: ReactNode
  /** the button's test id */
  testid?: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button kind={kind} size={size} className={className} disabled={disabled} aria-label={ariaLabel} onClick={() => ref.current?.click()} data-testid={testid}>
        {icon}
        {label}
      </Button>
      <input
        ref={ref}
        type="file"
        multiple
        accept={accept}
        style={{ display: 'none' }}
        data-testid="file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).map((f) => window.reel.app.pathForFile(f))
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </>
  )
}


/** Platform words, switched once: Finder/Dock on a Mac, Explorer/taskbar on Windows. Getting a video to a phone is the "Send to my phone" button (components/SendToPhone.tsx), the same on both. */
export const IS_MAC = /Mac/i.test(navigator.platform)
export const FOLDER_APP: string = IS_MAC ? 'Finder' : 'Explorer'
export const TASKBAR: string = IS_MAC ? 'Dock' : 'taskbar'
export const MOD: string = IS_MAC ? '⌘' : 'Ctrl+'
