import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { droppedPaths } from '../api'
import { Icon } from './icons'

export function Progress({ pct, done, label }: { pct: number; done?: boolean; label?: string }) {
  return (
    <div className={`progress${done ? ' done' : ''}`} role="progressbar" aria-label={label ?? 'Progress'} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
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
 * until it is closed or the screen changes (App clears toasts on every screen change).
 */
export function Toast({ text, kind, onClose }: { text: string; kind?: 'error' | 'info'; onClose: () => void }) {
  useEffect(() => {
    if (kind === 'error') return
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [text, kind, onClose])
  return (
    <div className={`toast${kind === 'error' ? ' error' : ''}`} role={kind === 'error' ? 'alert' : 'status'} data-testid="toast" data-over-dialogs>
      <span>{text}</span>
      {kind === 'error' && (
        <button className="icon-btn on-dark" onClick={onClose} aria-label="Close" title="Close">
          <Icon name="x" />
        </button>
      )}
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
 * Makes everything outside the newest open dialog inert: each sibling of its backdrop and of each
 * ancestor, except a toast (data-over-dialogs), which stays readable and closable. Undoes what no
 * longer applies, so the page comes back only when the last dialog closes, in whatever order.
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

/** A dialog. Esc and a click outside close it (when it can be closed); focus moves into it. */
export function Modal({ children, onClose, wide, testid, labelledBy }: { children: ReactNode; onClose?: () => void; wide?: boolean; testid?: string; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  // A layout effect: its cleanup runs before React removes the dialog, so holdBackground never sees a
  // detached dialog on top of the stack (and the page is inert before the first paint).
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const prev = document.activeElement as HTMLElement | null
    openDialogs.push(dialog)
    holdBackground()
    ;(dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>('button'))?.focus()
    return () => {
      openDialogs.splice(openDialogs.indexOf(dialog), 1)
      holdBackground() // before focusing: an inert element cannot take focus
      prev?.focus()
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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={`modal${wide ? ' wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'))
            .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0)
          const target = e.shiftKey ? controls.at(-1) : controls[0]
          if (e.target === (e.shiftKey ? controls[0] : controls.at(-1))) {
            e.preventDefault()
            target?.focus()
          }
        }}
        role="dialog" aria-modal aria-labelledby={labelledBy} data-testid={testid}
      >
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
        <button className="btn ghost" onClick={props.onNo} data-autofocus data-testid="confirm-no">
          {props.no}
        </button>
        <button className={`btn ${props.danger ? 'danger-solid' : 'primary'}`} onClick={props.onYes} data-testid="confirm-yes">
          {props.yes}
        </button>
      </div>
    </Modal>
  )
}

/** A small "more" menu for things that should not sit next to the main action (Delete). */
export function MoreMenu({ items, label = 'More' }: { items: { label: string; run: () => void; danger?: boolean; testid?: string; disabled?: boolean }[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
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
      <button className="icon-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="more">
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
export function PickFiles({ label, accept, onFiles, className, icon }: { label: string; accept?: string; onFiles: (p: string[]) => void; className?: string; icon?: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <button className={className ?? 'btn'} onClick={() => ref.current?.click()}>
        {icon}
        {label}
      </button>
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

export function Check({ done }: { done: boolean }) {
  return <span className={`check${done ? ' done' : ''}`}>{done ? <Icon name="check" size={14} stroke={2.5} /> : null}</span>
}

/** Platform words, switched once: Finder/Dock on a Mac, Explorer/taskbar on Windows. Getting a video to a phone is the "Send to my phone" button (components/SendToPhone.tsx), the same on both. */
export const IS_MAC = /Mac/i.test(navigator.platform)
export const FOLDER_APP: string = IS_MAC ? 'Finder' : 'Explorer'
export const TASKBAR: string = IS_MAC ? 'Dock' : 'taskbar'
export const MOD: string = IS_MAC ? '⌘' : 'Ctrl+'
