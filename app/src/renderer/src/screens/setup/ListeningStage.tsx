import { useEffect, useState, type ReactNode } from 'react'
import type { ModelStatus } from '../../../../shared/api'
import { MODEL_FOUND, ModelPanel, useModelStatus } from '../../components/connect'
import { Spinner } from '../../components/ui'
import { StageShell } from './StageShell'

export interface ListeningStageProps {
  /** The model is ready (a finished download moves on by itself), or "Do this later". */
  onNext: () => void
}

export function ListeningStage({ onNext }: ListeningStageProps) {
  const { s, looked, failed, retry } = useModelStatus(onNext)
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
              <button className="btn primary" onClick={retry}>
                Try again
              </button>
            </>
          }
        />
      )
    // Wait for the lookup, so nobody who already has the model sees "One download" first.
    if (!s || (!looked && !slowCheck))
      return (
        <div className="stage-loading">
          <Spinner />
        </div>
      )
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
        <ModelPanel s={s} onNext={onNext} />
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
