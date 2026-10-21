// The listening model stage, self-contained: it reads and shows the model's state itself and talks to the wizard
// (screens/FirstRun.tsx) only through its props, so what it checks can grow without touching the wizard.
// Order: use a matching copy already on this computer, else download it; then a short timing check picks how the
// listener runs on this computer (main/models.ts runCheck), which can be skipped.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModelStatus } from '../../../../shared/api'
import { MODEL_FOUND, ModelDownload } from '../../components/connect'
import { Icon } from '../../components/icons'
import { Spinner, Thinking } from '../../components/ui'
import { reel } from '../../api'
import { StageShell } from './StageShell'

export interface ListeningStageProps {
  /** Move on: the model is ready, or "Do this later". */
  onNext: () => void
}

export function ListeningStage({ onNext }: ListeningStageProps) {
  const [s, setS] = useState<ModelStatus | null>(null)
  const [skipped, setSkipped] = useState(false)
  // Look for a copy on this computer before saying anything, so nobody with one sees "One download" first.
  const [looked, setLooked] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  const next = useRef<HTMLButtonElement>(null)
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
  // The timing check starts by itself once the model is here (found, downloaded, or from before).
  const needsCheck = !!s?.installed && s.check === 'needed' && !skipped
  useEffect(() => {
    if (needsCheck) void reel.model.runCheck().catch(() => undefined)
  }, [needsCheck])
  const ready = !!s?.installed && (s.check === 'done' || skipped)
  // "Skip" goes away when the check ends; keyboard focus moves to what replaced it instead of the page.
  useEffect(() => {
    if (ready && (document.activeElement === document.body || !document.activeElement)) next.current?.focus()
  }, [ready])
  // Leaving the stage stops a check still running; it runs again later, quietly.
  useEffect(() => () => void reel.model.skipCheck().catch(() => undefined), [])

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
    if (s.installed) {
      const checking = !ready
      const skip = () => {
        setSkipped(true)
        void reel.model.skipCheck()
      }
      return (
        <StageShell
          testid="model-heading"
          title="Ready to listen"
          description={s.reused ? MODEL_FOUND : 'The listening model that understands what you say is already on this computer.'}
          footer={
            checking ? (
              <button className="link" onClick={skip} data-testid="skip-check">
                Skip
              </button>
            ) : (
              <button ref={next} className="btn primary" onClick={onNext} data-testid="model-next">
                Next
              </button>
            )
          }
        >
          <div className="listen-state" data-testid={checking ? 'speech-check' : 'speech-ready'}>
            {checking ? (
              <p className="listen-line">
                <Thinking />
                <span>Getting the listener ready for this computer</span>
              </p>
            ) : s.error ? (
              <p className="listen-note">{s.error}</p>
            ) : (
              !skipped && (
                <p className="listen-line done">
                  <Icon name="check" size={16} stroke={2.25} />
                  <span>Set up for this computer</span>
                </p>
              )
            )}
          </div>
        </StageShell>
      )
    }
    return (
      <StageShell
        testid="model-heading"
        title={s.checking ? 'Checking this computer' : 'One download, about 500 MB'}
        description={
          s.checking
            ? "Another app already downloaded the listener. I'm making sure it's the exact one I need."
            : 'I need a listening model to understand what you say. It only downloads once.'
        }
        footer={
          <>
            <span className="stage-note">You'll need it before your first video.</span>
            <button className="link" onClick={onNext} data-testid="later">
              Do this later
            </button>
          </>
        }
      >
        <ModelDownload />
      </StageShell>
    )
  })()

  return (
    <>
      {view}
      {/* Mounted empty from the start, so each phase is announced once (not every MB of a download). */}
      <span className="sr-only" role="status">
        {announcement(s, ready, skipped)}
      </span>
    </>
  )
}

function announcement(s: ModelStatus | null, ready: boolean, skipped: boolean): string {
  if (!s) return ''
  if (s.installed) {
    if (!ready) return 'Getting the listener ready for this computer'
    return s.error ?? (skipped ? 'Ready to listen' : 'Ready to listen. Set up for this computer.')
  }
  if (s.checking) return 'Checking the listener on this computer'
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
