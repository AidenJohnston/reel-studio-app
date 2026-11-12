// Where setting up an AI appears on the way to a first reel: in the note box's place, the first time a note needs one
// (screens/Reel.tsx). A first reel needs no AI (docs/architecture.md section 1), so nothing asks before then.
// The guided sign-in (`AiSetup`, with the same onDone and onSkip) takes ConnectAI's place here when it lands; until then
// this shows today's ways to connect, without the ones that need a key or a server (those stay in Settings).
import { useEffect, useRef } from 'react'
import type { ProviderInfo } from '../../../shared/api'
import { ConnectAI } from './connect'
import { Button } from './ui'

export function AiSetupSlot({ onDone, onSkip }: { onDone: (p: ProviderInfo) => void; onSkip: () => void }) {
  const box = useRef<HTMLDivElement>(null)
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
      <ConnectAI onConnected={onDone} advanced={false} />
      <Button kind="tertiary" size="small" onClick={onSkip} data-testid="ai-setup-skip">
        Not now
      </Button>
    </div>
  )
}
