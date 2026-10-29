import { useEffect, useRef, useState, type ReactNode } from 'react'
import { droppedPaths } from '../api'
import { Icon, type IconName } from './icons'

export function Progress({ pct, done, label }: { pct: number; done?: boolean; label?: string }) {
  return (
    <div className={`progress${done ? ' done' : ''}`} role="progressbar" aria-label={label ?? 'Progress'} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
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
    <div className={`toast${kind === 'error' ? ' error' : ''}`} role={kind === 'error' ? 'alert' : 'status'} data-testid="toast">
      <span>{text}</span>
      {kind === 'error' && (
        <button className="icon-btn on-dark" onClick={onClose} aria-label="Close" title="Close">
          <Icon name="x" />
        </button>
      )}
    </div>
  )
}

/** A dialog. Esc and a click outside close it (when it can be closed); focus moves into it. */
export function Modal({ children, onClose, wide, testid }: { children: ReactNode; onClose?: () => void; wide?: boolean; testid?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('button')
    first?.focus()
    return () => prev?.focus?.()
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
      <div ref={ref} className={`modal${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal data-testid={testid}>
        {children}
      </div>
    </div>
  )
}

/** "Are you sure?" with the safe choice in focus. */
export function Confirm(props: { title: string; body: string; yes: string; no: string; danger?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <Modal onClose={props.onNo} testid="confirm">
      <h2>{props.title}</h2>
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

/**
 * A small menu behind a button: "More" for things that should not sit next to the main action (Delete), or the
 * other half of a split button. Focus moves into the menu when it opens; arrow keys move between items.
 */
export function MoreMenu({ items, label = 'More', icon = 'more', triggerClassName = 'icon-btn', testid = 'more', disabled, up }: {
  items: { label: string; run: () => void; danger?: boolean; testid?: string; disabled?: boolean }[]
  label?: string
  icon?: IconName
  triggerClassName?: string
  testid?: string
  disabled?: boolean
  /** Open above the button, for a button near the bottom of the window. */
  up?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const enabled = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [])]
    enabled()[0]?.focus()
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const list = enabled()
        const at = list.indexOf(document.activeElement as HTMLButtonElement)
        list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus()
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
      <button ref={trigger} className={triggerClassName} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)} data-testid={testid}>
        <Icon name={icon} />
      </button>
      {open && (
        <div className={`more-menu${up ? ' up' : ''}`} role="menu" aria-label={label}>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onClick={() => {
                // Back on the button first, so a dialog the item opens returns focus there when it closes.
                trigger.current?.focus()
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
