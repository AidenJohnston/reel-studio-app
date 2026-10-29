import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { updateAction, type UpdateState } from '../../../shared/update'
import { installQuestion, type InstallQuestion } from './update-copy'
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

export function useUpdateActions(): { act: (s: UpdateState) => Promise<void>; pending: boolean; dialog: ReactNode } {
  const notify = useNotify()
  const titleId = useId()
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
    if (a === 'download') return run(async () => {
      if (!(await reel.update.download()).accepted) notify('The update changed while checking. Choose its action again.', 'info')
    })
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
      if (!r.accepted && !r.refused) notify('The update changed while checking. Choose its action again.', 'info')
      else if (r.refused === 'exporting') notify('Your export is still saving. Restart to update when it is done.', 'error')
      else if (r.accepted && r.state.status !== 'error') notify('Installing the update. Reel Studio closes and opens again in a moment.')
    })
  }

  const dialog =
    question &&
    (question.canInstall ? (
      <Confirm title={question.title} body={question.body} yes="Restart and update" no="Not now" onYes={install} onNo={() => setQuestion(null)} />
    ) : (
      <Modal onClose={() => setQuestion(null)} testid="confirm" labelledBy={titleId}>
        <h2 id={titleId}>{question.title}</h2>
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
