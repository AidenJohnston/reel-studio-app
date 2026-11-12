import { useEffect, useRef, useState } from 'react'
import type { ModelStatus } from '../../../../shared/api'
import { reel, userMessage } from '../../api'
import { useModelStatus } from '../connect'

const mb = (b: number) => Math.round(b / 1e6)

/** "About a minute left", from a smoothed download rate. null until there is enough to go on. */
export function etaWords(left: number, rate: number): string | null {
  if (rate <= 0) return null
  const sec = left / rate
  if (sec > 90) return `About ${Math.ceil(sec / 60)} minutes left`
  if (sec > 52) return 'About a minute left'
  if (sec > 12) return `About ${Math.ceil(sec / 10) * 10} seconds left`
  return 'A few seconds left'
}

/**
 * The listening model, started on Get started (`active`): a copy already on this computer is used, else it
 * downloads. It never holds up a step.
 */
function useListeningModel(active: boolean): { s: ModelStatus | null; eta: string | null; error: string | null; retry: () => void } {
  const { s, looked, failed, retry } = useModelStatus()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const sample = useRef<{ t: number; b: number } | null>(null)
  const [rate, setRate] = useState(0)

  useEffect(() => {
    if (!active || !looked || !s || started.current || s.installed || s.downloading || s.checking) return
    started.current = true
    reel.model.download().catch((e) => setError(userMessage(e)))
  }, [active, looked, s])

  useEffect(() => {
    if (!s?.downloading) return
    const now = performance.now()
    const last = sample.current
    if (last && now - last.t > 400) {
      const r = ((s.bytes - last.b) * 1000) / (now - last.t)
      setRate((old) => (old ? old * 0.85 + r * 0.15 : r))
      sample.current = { t: now, b: s.bytes }
    } else if (!last) sample.current = { t: now, b: s.bytes }
  }, [s])

  return {
    s,
    eta: s?.downloading && s.total > 0 ? etaWords(s.total - s.bytes, rate) : null,
    error: error ?? s?.error ?? (failed ? "Couldn't check the listening download, so try again." : null),
    retry: () => {
      setError(null)
      started.current = false
      sample.current = null
      setRate(0)
      retry()
    }
  }
}

/**
 * The listening model's line in the first run's footer, only while it is on its way or stuck. Once it is here the
 * line goes: nothing is waiting on it, so nothing needs saying. Its progress renders only this line.
 */
export function ModelLine({ active, computer }: { active: boolean; computer: string }) {
  const { s, eta, error, retry } = useListeningModel(active)
  if (!active) return null
  if (error)
    return (
      <div className="fr-dl" role="alert" data-testid="model-line">
        <span className="fr-dl-1">
          <b>Couldn't get ready to listen</b>
          <button className="lk" onClick={retry} data-testid="model-retry">
            Try again
          </button>
        </span>
        <span className="fr-dl-2" data-testid="model-error" title={error}>
          {error}
        </span>
      </div>
    )
  if (!s || s.installed) return null
  const pct = Math.min(1, s.total > 0 ? s.bytes / s.total : s.pct / 100)
  return (
    <div
      className="fr-dl"
      role="progressbar"
      aria-label="Getting ready to listen"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      data-testid="model-line"
    >
      <span className="fr-dl-1">
        <b>{s.checking ? 'Checking the listening download' : 'Getting ready to listen'}</b>
        {!s.checking && <span className="n">{s.total > 0 ? `${mb(s.bytes)} of ${mb(s.total)} MB` : `${s.pct}%`}</span>}
      </span>
      <span className="fr-dl-2">
        {eta ? `${eta}. ` : ''}It writes down what you say, on this {computer}.
      </span>
    </div>
  )
}
