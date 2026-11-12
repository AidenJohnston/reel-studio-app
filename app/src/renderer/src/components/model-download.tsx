// The one-time listening download: its state, and the panel that shows it where a reel waits for it (Reel.tsx after
// MODEL_MISSING) and in Settings. Out of connect.tsx, which is the AI sign-in, so the plain-words check covers it.
import { useEffect, useRef, useState } from 'react'
import type { ModelStatus } from '../../../shared/api'
import { reel } from '../api'
import { Button, Progress, Spinner } from './ui'

export const MODEL_FOUND = "Reel Studio found what it needs to listen on this computer, so there's nothing to download."

const mb = (bytes: number): number => Math.round(bytes / 1e6)

export function downloadLine(s: ModelStatus, verb: 'Downloading' | 'Paused at'): string {
  return s.total > 0 ? `${verb} ${mb(s.bytes)} of ${mb(s.total)} MB` : `${verb} ${s.pct}%`
}

/**
 * The listening download's state, after looking for a matching copy already on this computer. `onDownloaded` fires only
 * the moment a download finishes, not for a model that was already here or a copy found here.
 */
export function useModelStatus(onDownloaded?: () => void) {
  const [s, setS] = useState<ModelStatus | null>(null)
  const [looked, setLooked] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  const wasInstalled = useRef<boolean | null>(null)
  const downloaded = useRef(onDownloaded)
  downloaded.current = onDownloaded
  useEffect(() => {
    let alive = true
    const show = (m: ModelStatus) => {
      if (!alive) return
      setS(m)
      if (wasInstalled.current === false && m.installed && !m.reused) downloaded.current?.()
      wasInstalled.current = m.installed
    }
    const off = reel.model.onProgress(show)
    void (async () => {
      try {
        const m = await reel.model.status()
        show(m)
        if (!m.installed && !m.downloading) show(await reel.model.find())
      } catch {
        if (alive) setFailed(true)
      } finally {
        if (alive) setLooked(true)
      }
    })()
    return () => {
      alive = false
      off()
    }
  }, [tries])
  const retry = (): void => {
    setFailed(false)
    setLooked(false)
    setTries((n) => n + 1)
  }
  return { s, looked, failed, retry }
}

/** The one-time listening download, for Settings and the "model missing" screen. */
/** `secondary` on Settings, where the AI editor is the main action (custom-server). */
export function ModelDownload({ secondary }: { secondary?: boolean } = {}) {
  const { s } = useModelStatus()
  return s ? <ModelPanel s={s} secondary={secondary} /> : <Spinner />
}

/** With `onNext`, a model that is here shows Next. */
export function ModelPanel({ s, onNext, secondary }: { s: ModelStatus; onNext?: () => void; secondary?: boolean }) {
  if (s.installed)
    return (
      <div className="stack">
        <div className="banner good">Reel Studio is ready to listen.</div>
        {s.checkFailed && (
          <p className="muted-sm" data-testid="model-check-failed">
            Reel Studio couldn't work out the fastest settings for this computer, so it listens with its usual ones.
            Everything still works.
          </p>
        )}
        {onNext && (
          <Button kind="primary" size="big" onClick={onNext} data-testid="model-next">
            Next
          </Button>
        )}
      </div>
    )
  if (s.checking)
    return (
      <div className="stack" data-testid="model-checking">
        <Progress pct={s.pct} label="Checking the listening download" />
        <span className="muted">Looking on this computer for what Reel Studio needs to listen</span>
      </div>
    )
  const paused = !s.downloading && s.pct > 0 && s.pct < 100
  return (
    <div className="stack">
      {s.downloading || paused ? (
        <>
          <Progress pct={s.pct} label="Getting ready to listen" />
          <div className="row">
            <span className="muted" data-testid="model-progress">
              {downloadLine(s, s.downloading ? 'Downloading' : 'Paused at')}
            </span>
            <span className="spacer" />
            {s.downloading ? (
              <Button size="small" kind="tertiary" onClick={() => reel.model.cancel()} data-testid="pause-model">
                Pause
              </Button>
            ) : (
              <Button size="small" onClick={() => void reel.model.download()} data-testid="download-model">
                Keep downloading
              </Button>
            )}
          </div>
        </>
      ) : (
        <Button size="big" kind={secondary ? 'secondary' : 'primary'} onClick={() => void reel.model.download()} data-testid="download-model">
          Download
        </Button>
      )}
      {s.error && (
        <div className="banner error" role="alert" data-testid="model-error">
          {s.error}
        </div>
      )}
    </div>
  )
}
