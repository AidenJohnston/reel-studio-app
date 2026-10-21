// The listening model stage, self-contained: it reads and shows the model's state itself and talks to the wizard
// (screens/FirstRun.tsx) only through its props, so what it checks can grow without touching the wizard.
// It uses a matching copy already on this computer when there is one, else offers the download. The thread-count
// timing check is not part of setup: main/models.ts runs it in the background once the model is here.
import { useEffect, useState, type ReactNode } from 'react'
import type { ModelStatus } from '../../../../shared/api'
import { MODEL_FOUND, ModelDownload } from '../../components/connect'
import { Spinner } from '../../components/ui'
import { reel } from '../../api'
import { StageShell } from './StageShell'

export interface ListeningStageProps {
  /** Move on: the model is ready (it moves on by itself when a download finishes), or "Do this later". */
  onNext: () => void
}

export function ListeningStage({ onNext }: ListeningStageProps) {
  const [s, setS] = useState<ModelStatus | null>(null)
  // Look for a copy on this computer before saying anything, so nobody with one sees "One download" first.
  const [looked, setLooked] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    let alive = true
    const off = reel.model.onProgress((m) => alive && setS(m))
    void (async () => {
      try {
        const m = await reel.model.status()
        if (alive) setS(m)
        const found = !m.installed && !m.downloading ? await reel.model.find() : null
        if (alive && found) setS(found)
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
  // A found copy usually checks in well under a second; only a slow check gets its own screen.
  const slowCheck = useAfter(!!s?.checking, 300)

  const view = ((): ReactNode => {
    if (failed && !s)
      return (
        <StageShell
          testid="model-heading"
          title="Listening"
          description="I couldn't check for the listening model. Try again, or do this later."
          footer={
            <>
              <button className="link" onClick={onNext} data-testid="later">
                Do this later
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setFailed(false)
                  setLooked(false)
                  setTries((n) => n + 1)
                }}
              >
                Try again
              </button>
            </>
          }
        />
      )
    if (!s || (!looked && !slowCheck))
      return (
        <div className="stage-loading">
          <Spinner />
        </div>
      )
    // One StageShell for every state, so ModelDownload stays mounted and sees the download finish (it moves on then).
    return (
      <StageShell
        testid="model-heading"
        title={s.installed ? 'Ready to listen' : s.checking ? 'Checking this computer' : 'One download, about 500 MB'}
        description={
          s.installed
            ? s.reused
              ? MODEL_FOUND
              : 'The listening model that understands what you say is already on this computer.'
            : s.checking
              ? "Another app already downloaded the listening model. I'm making sure it's the exact one I need."
              : 'I need a listening model to understand what you say. It only downloads once.'
        }
        footer={
          !s.installed && (
            <>
              <span className="stage-note">You'll need it before your first video.</span>
              <button className="link" onClick={onNext} data-testid="later">
                Do this later
              </button>
            </>
          )
        }
      >
        <ModelDownload onReady={onNext} />
      </StageShell>
    )
  })()

  return (
    <>
      {view}
      {/* Mounted empty from the start, so each phase is announced once (not every MB of a download). */}
      <span className="sr-only" role="status">
        {announcement(s)}
      </span>
    </>
  )
}

function announcement(s: ModelStatus | null): string {
  if (!s) return ''
  if (s.installed) return s.reused ? MODEL_FOUND : 'Ready to listen'
  if (s.checking) return 'Checking the listening model on this computer'
  if (s.downloading) return 'Downloading the listening model'
  if (s.error) return s.error
  return s.pct > 0 ? 'Download paused' : ''
}

/** True once `on` has stayed true for `ms`. */
function useAfter(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    setLate(false)
    if (!on) return
    const t = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return late
}
