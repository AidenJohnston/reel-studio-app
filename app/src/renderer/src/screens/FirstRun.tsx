// The shape of T3 Code's WelcomeWizard: a welcome, then named stages with one action each.
import { useCallback, useMemo, useState } from 'react'
import { Icon } from '../components/icons'
import { MacStage } from './setup/MacStage'
import { ListeningStage } from './setup/ListeningStage'
import { ConnectStage } from './setup/ConnectStage'

type SetupStage = 'mac' | 'listening' | 'ai'
const STAGE_LABELS: Record<SetupStage, string> = { mac: 'Your Mac', listening: 'Listening', ai: 'AI editor' }

export function FirstRun({ onDone, platform }: { onDone: () => void; platform: string }) {
  // Only macOS asks privacy questions. The folder comes first, because macOS asks about Documents when it is made.
  const stages = useMemo<SetupStage[]>(() => (platform === 'darwin' ? ['mac', 'listening', 'ai'] : ['listening', 'ai']), [platform])
  const [stage, setStage] = useState<SetupStage | null>(null) // null = the welcome
  // Forward slides in from the right, back from the left: the stage strip reads left to right.
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const next = useCallback(() => {
    setDir('fwd')
    setStage((s) => (s === null ? stages[0] : (stages[stages.indexOf(s) + 1] ?? s)))
  }, [stages])
  const back = (s: SetupStage) => {
    setDir('back')
    setStage(s)
  }

  if (stage === null) {
    return (
      <main className="first">
        <div className="first-card">
          <div className="hero-mark">
            <Icon name="play" size={32} stroke={1.75} />
          </div>
          <h1>Welcome to Reel Studio</h1>
          <p className="muted" style={{ fontSize: 17, maxWidth: 440 }}>
            Drop in a video of you talking. I cut it, add captions, music and a cover, and get it ready for Instagram.
          </p>
          <button className="btn primary big" onClick={next} data-testid="get-started">
            Get started
          </button>
        </div>
      </main>
    )
  }

  const at = stages.indexOf(stage)
  return (
    <main className="first setup-view">
      <div className="setup" role="group" aria-labelledby="setup-title">
        <div className="setup-head">
          <span className="brand-mark" aria-hidden>
            <Icon name="play" size={12} stroke={2} />
          </span>
          <span id="setup-title">Set up Reel Studio</span>
        </div>
        <ol className="setup-steps" aria-label="Setup progress" data-testid="setup-steps">
          {stages.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className="setup-step"
                data-state={i < at ? 'done' : i === at ? 'current' : 'todo'}
                aria-current={i === at ? 'step' : undefined}
                aria-label={`${STAGE_LABELS[s]}, step ${i + 1} of ${stages.length}${i < at ? ', done' : ''}`}
                // Earlier stages can be opened again; later ones are reached by finishing this one.
                disabled={i >= at}
                onClick={() => back(s)}
                data-testid={`setup-step-${s}`}
              >
                <span className="setup-step-mark" aria-hidden>
                  {i < at ? <Icon name="check" size={13} stroke={2.5} /> : i + 1}
                </span>
                <span className="setup-step-label">{STAGE_LABELS[s]}</span>
              </button>
            </li>
          ))}
        </ol>
        <section className="setup-panel">
          <div className="setup-stage" key={stage} data-dir={dir}>
            {stage === 'mac' && <MacStage onNext={next} />}
            {stage === 'listening' && <ListeningStage onNext={next} />}
            {stage === 'ai' && <ConnectStage onDone={onDone} />}
          </div>
        </section>
      </div>
    </main>
  )
}
