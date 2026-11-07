// The editor picker's parts (connect.tsx), shared with your own servers (Connections.tsx): T3 Code's provider row,
// a mark bare at 20 px, the name, one status line and one pill on the right.
import { useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { Icon } from './icons'
import type { SettingId } from './settings-index'
import { SearchHits, SettingLabel } from './settings-rows'

export type Tone = 'plain' | 'ok' | 'busy' | 'error'

export function ConnectedMark({ testid }: { testid?: string }) {
  return (
    <span className="pv-ok" data-testid={testid}>
      <Icon name="check" size={14} stroke={2.4} />
      Connected
    </span>
  )
}

/**
 * One editor or connection. The status line keeps one live region and swaps its words inside it, so a screen reader
 * hears "Checking Claude…" and then "Connected". `setting` labels the row from settings-index and lets a Settings
 * search hide it.
 */
export function ProviderRow({
  id,
  setting,
  name,
  mark,
  status,
  tone = 'plain',
  action,
  children
}: {
  id?: string
  setting?: SettingId
  name?: ReactNode
  mark: ReactNode
  status: ReactNode
  tone?: Tone
  action?: ReactNode
  children?: ReactNode
}) {
  const hits = useContext(SearchHits)
  // only a status that changes settles in; the one a row opens with is just there
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
  }, [])
  if (setting && hits && !hits.has(setting)) return null
  return (
    <div className="pv" data-provider={id} data-setting={setting}>
      <div className="pv-main">
        <span className="pv-mark">{mark}</span>
        <div className="pv-t">
          <b>{name ?? (setting ? <SettingLabel id={setting} /> : '')}</b>
          <span className="pv-live" role={tone === 'error' ? 'alert' : 'status'}>
            <span key={tone} className={`pv-status ${tone}${mounted.current ? ' enter' : ''}`}>
              {status}
            </span>
          </span>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

/** "Advanced" and the like: a quiet row with a chevron; the panel stays in the page, hidden, while closed. */
export function Disclosure({ label, hint, open, onToggle, testid, children }: { label: string; hint?: string; open: boolean; onToggle: () => void; testid: string; children: ReactNode }) {
  const panel = useId()
  return (
    <div className={`disc${open ? ' open' : ''}`}>
      <button className="disc-h" aria-expanded={open} aria-controls={panel} onClick={onToggle} data-testid={testid}>
        <Icon name="chevron-right" size={14} stroke={2} className="chev" />
        {label}
        {hint && <span className="disc-hint">{hint}</span>}
      </button>
      <div className="disc-body" id={panel} hidden={!open}>
        {children}
      </div>
    </div>
  )
}
