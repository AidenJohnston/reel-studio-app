// The listening model stage, self-contained: it reads and shows the model's state itself and talks to the wizard
// (screens/FirstRun.tsx) only through its props, so what it checks can grow without touching the wizard.
import { useEffect, useState } from 'react'
import { ModelDownload } from '../../components/connect'
import { reel } from '../../api'
import { StageShell } from './StageShell'

export interface ListeningStageProps {
  /** Move on: the model is ready (it moves on by itself when a download finishes), or "Do this later". */
  onNext: () => void
}

export function ListeningStage({ onNext }: ListeningStageProps) {
  // A model already on this computer gets "Ready", not "One download" (grandma3 #1).
  const [modelReady, setModelReady] = useState(false)
  useEffect(() => {
    reel.model.status().then((m) => setModelReady(m.installed)).catch(() => undefined)
    return reel.model.onProgress((m) => setModelReady(m.installed))
  }, [])
  return (
    <StageShell
      testid="model-heading"
      title={modelReady ? 'Ready to listen' : 'One download, about 500 MB'}
      description={
        modelReady
          ? 'The listening model that understands what you say is already on this computer.'
          : 'I need a listening model to understand what you say. It only downloads once.'
      }
      footer={
        !modelReady && (
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
}
