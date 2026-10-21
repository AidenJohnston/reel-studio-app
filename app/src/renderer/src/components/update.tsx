// The update state as the window sees it (one subscription for the sidebar button and Settings), and the
// one place that turns a click into download, open page, install or check. Main owns the state
// (main/updater.ts); the words are shared/update.ts.
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { installQuestion, updateAction, type InstallQuestion, type UpdateState } from '../../../shared/update'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'
import { Confirm, Modal } from './ui'

let current: UpdateState | null = null
const listeners = new Set<() => void>()
let wired = false

function subscribe(cb: () => void): () => void {
  if (!wired) {
    wired = true
    reel.update.onState((s) => {
      current = s
      listeners.forEach((l) => l())
    })
    // A push that lands first is newer than this answer.
    void reel.update
      .state()
      .then((s) => {
        if (current) return
        current = s
        listeners.forEach((l) => l())
      })
      .catch(() => {})
  }
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useUpdateState(): UpdateState | null {
  return useSyncExternalStore(subscribe, () => current)
}

const COULD_NOT_OPEN = 'I could not open the download page. Try again in a moment.'

/** `act` does what the update button says; `dialog` is the install question to render next to it. */
export function useUpdateActions(): { act: (s: UpdateState) => Promise<void>; pending: boolean; dialog: ReactNode } {
  const notify = useNotify()
  const [question, setQuestion] = useState<InstallQuestion | null>(null)
  const [pending, setPending] = useState(false)

  const run = async (f: () => Promise<void>): Promise<void> => {
    setPending(true)
    try {
      await f()
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setPending(false)
    }
  }

  const act = async (s: UpdateState): Promise<void> => {
    if (pending) return
    const a = updateAction(s)
    if (a === 'open-page') return openReleasePage(notify)
    // the result arrives as state (downloading, then downloaded or a stopped download)
    if (a === 'download') return run(async () => void (await reel.update.download()))
    if (a === 'install') {
      const busy = await reel.update.busy().catch(() => ({ exporting: false, working: 0 }))
      setQuestion(installQuestion(s, busy))
      return
    }
    return run(async () => {
      const r = await reel.update.check()
      if (!r.checked) notify(r.state.message ?? 'I could not check for updates right now. Try again in a moment.', 'error')
    })
  }

  const install = (): void => {
    setQuestion(null)
    void run(async () => {
      const r = await reel.update.install()
      if (r.refused === 'exporting') notify('Your export is still saving. Restart to update when it is done.', 'error')
      // macOS unpacks and checks the new version before it quits, which can take a little while
      else if (r.accepted && r.state.status !== 'error') notify('Installing the update. Reel Studio closes and opens again in a moment.')
    })
  }

  const dialog =
    question &&
    (question.canInstall ? (
      <Confirm title={question.title} body={question.body} yes="Restart and update" no="Not now" onYes={install} onNo={() => setQuestion(null)} />
    ) : (
      <Modal onClose={() => setQuestion(null)} testid="confirm">
        <h2>{question.title}</h2>
        <p className="muted">{question.body}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={() => setQuestion(null)} data-autofocus data-testid="confirm-no">
            OK
          </button>
        </div>
      </Modal>
    ))

  return { act, pending, dialog }
}

export const openReleasePage = (notify: (t: string, k?: 'error' | 'info') => void): void =>
  void reel.update.openRelease().catch(() => notify(COULD_NOT_OPEN, 'error'))
