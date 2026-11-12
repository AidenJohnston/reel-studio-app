// Where setting up an AI appears on the way to a first reel: in the note box's place, the first time a note needs one
// (screens/Reel.tsx). A first reel needs no AI (docs/architecture.md section 1), so nothing asks before then.
// With the Easier AI sign-in flag on, the guided AiSetup (one-button sign-ins) shows here. Off, today's ways to
// connect show, without the ones that need a key or a server of your own (those stay in Settings).
import { useEffect, useRef } from 'react'
import type { ProviderInfo } from '../../../shared/api'
import { AiSetup, useEasyAi } from './AiSetup'
import { ConnectAI } from './connect'
import { Button } from './ui'

export function AiSetupSlot({ onDone, onSkip }: { onDone: (p: ProviderInfo) => void; onSkip: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const easy = useEasyAi()
  // the note was just sent from the keyboard or a click: say why it didn't go, from the top of the box
  useEffect(() => box.current?.focus({ preventScroll: true }), [])
  return (
    <div
      ref={box}
      className="connect-cin"
      tabIndex={-1}
      role="group"
      aria-labelledby="ai-setup-why"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onSkip()
        }
      }}
      data-testid="composer-connect"
    >
      <p id="ai-setup-why">To make changes from a note, connect an AI once. Your note is kept.</p>
      {easy?.on ? (
        <AiSetup onDone={onDone} onSkip={onSkip} />
      ) : (
        <>
          <ConnectAI onConnected={onDone} advanced={false} />
          <Button kind="tertiary" size="small" onClick={onSkip} data-testid="ai-setup-skip">
            Not now
          </Button>
        </>
      )}
    </div>
  )
}
