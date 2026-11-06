// The companion page's root: not paired, pairing, or paired (Shell). A pairing link's fragment pairs at once, on
// first load or when a new code is scanned into an open page (only the fragment changes, so the page doesn't reload).
import { useCallback, useEffect, useState } from 'react'
import { parsePairingFragment } from '../../../shared/contract'
import { Logo } from '../components/brand'
import { useInputMode } from '../components/motion'
import { Button, Spinner } from '../components/ui'
import { CompanionError, onPairing, pair, pairing } from './client'
import { noun } from './device'
import { Shell } from './Shell'

type Stage = { kind: 'pairing' } | { kind: 'paired' } | { kind: 'unpaired'; why: string | null; retry: boolean }

const linkInAddressBar = (): boolean => parsePairingFragment(location.hash) !== null

export function Companion() {
  useInputMode()
  const [stage, setStage] = useState<Stage>(() =>
    linkInAddressBar() ? { kind: 'pairing' } : pairing() ? { kind: 'paired' } : { kind: 'unpaired', why: null, retry: false }
  )

  const pairFromLink = useCallback(async () => {
    setStage({ kind: 'pairing' })
    try {
      await pair(location.hash)
      setStage({ kind: 'paired' })
    } catch (e) {
      const why = e instanceof CompanionError ? e.userMessage : 'Something went wrong while pairing. Scan the code in Reel Studio again.'
      // the fragment is still there only when the same code could work on a retry
      setStage({ kind: 'unpaired', why, retry: linkInAddressBar() })
    }
  }, [])

  useEffect(() => {
    if (linkInAddressBar()) void pairFromLink()
    const scanned = () => {
      if (linkInAddressBar()) void pairFromLink()
    }
    window.addEventListener('hashchange', scanned)
    return () => window.removeEventListener('hashchange', scanned)
  }, [pairFromLink])

  // Forgotten here or on the computer: back to the start, with the reason when there is one.
  useEffect(
    () =>
      onPairing((p, why) => {
        if (!p) setStage({ kind: 'unpaired', why, retry: false })
      }),
    []
  )

  if (stage.kind === 'paired') return <Shell />
  return (
    <main className="cp-col cp-intro">
      <div className="cp-brand">
        <Logo size={22} />
        <span>Reel Studio</span>
      </div>
      {stage.kind === 'pairing' ? (
        <div className="cp-pairing" role="status" data-testid="cp-pairing">
          <Spinner />
          <span>Pairing with your computer…</span>
        </div>
      ) : (
        <NotPaired why={stage.why} onRetry={stage.retry ? () => void pairFromLink() : null} />
      )}
    </main>
  )
}

function NotPaired({ why, onRetry }: { why: string | null; onRetry: (() => void) | null }) {
  const where = noun() === 'browser' ? 'in this browser' : `on this ${noun()}`
  return (
    <div className="cp-intro-body" data-testid="cp-not-paired">
      <div className="cp-intro-text">
        <h1>Your reels, {where}</h1>
        <p className="cp-lede">Watch every version of a reel, save the one you like, and leave a note that starts an edit on your computer.</p>
      </div>
      {why && (
        <p className="banner error" role="alert">
          <span>{why}</span>
        </p>
      )}
      {onRetry && (
        <Button kind="primary" size="big" className="cp-wide" onClick={onRetry}>
          Try again
        </Button>
      )}
      <section className="cp-how" aria-labelledby="cp-how-h">
        <h2 id="cp-how-h">Connect to your computer</h2>
        <p>Open Reel Studio on your computer, go to Settings &gt; Phone and browser, click Pair a phone, and scan the code.</p>
        <p className="faint">This works on your home Wi-Fi, with this {noun()} and the computer on the same network.</p>
      </section>
    </div>
  )
}
