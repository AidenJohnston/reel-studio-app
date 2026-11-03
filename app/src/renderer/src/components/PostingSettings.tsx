// Settings > Posting: which channel is connected, Disconnect, and this computer's sign-in (Sign out, Sign out
// everywhere). Renders nothing unless posting is turned on (REELSTUDIO_POSTING=1). main/posting.ts does the work.
import { useState } from 'react'
import { CONNECT_NOTES, POST_COPY, PRICING_URL, SETTINGS_COPY, disconnectBody, signedInLine } from '../../../shared/posting'
import { reel, userMessage } from '../api'
import { usePostingStatus } from './PostButton'
import { Confirm, Spinner } from './ui'

export function PostingSettings() {
  const [s, setS] = usePostingStatus()
  const [working, setWorking] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'disconnect' | 'everywhere' | null>(null)
  if (!s?.enabled) return null

  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote(userMessage(e))
      setS(await reel.posting.status().catch(() => s))
    } finally {
      setWorking(false)
    }
  }
  const connect = async () => {
    setConnecting(true)
    setNote(null)
    try {
      const r = await reel.posting.connect('youtube')
      setS(r.status)
      setNote(CONNECT_NOTES[r.outcome])
    } catch (e) {
      setNote(userMessage(e))
    } finally {
      setConnecting(false)
    }
  }
  const signIn = () => run(async () => setS(await reel.posting.signIn()))
  const pasteThenSignIn = () =>
    run(async () => {
      await reel.updateKey.paste()
      setS(await reel.posting.signIn())
    })

  const yt = s.youtube
  const waiting = connecting || s.connecting
  return (
    <section className="panel" data-testid="posting-settings">
      <h2>{SETTINGS_COPY.heading}</h2>
      <p className="muted" style={{ margin: '6px 0 14px' }}>
        {SETTINGS_COPY.intro}
      </p>

      {s.ended ? (
        <div className="stack" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>{POST_COPY.ended}</p>
          <div className="row">
            <a className="btn" href={PRICING_URL} target="_blank" rel="noreferrer">
              Subscribe again
            </a>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 6 }} data-testid="posting-youtube">
            <p style={{ margin: 0 }}>
              <strong>YouTube:</strong> {yt ? (yt.state === 'reconnect' ? 'needs connecting again' : yt.channelName ?? 'connected') : 'not connected'}
            </p>
            {waiting ? (
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <Spinner /> <span className="muted-sm">{POST_COPY.connecting}</span>
                <button className="btn ghost small" onClick={() => void reel.posting.cancelConnect()} data-testid="posting-connect-cancel">
                  Cancel
                </button>
              </div>
            ) : (
              <div className="row">
                {yt?.state === 'connected' ? (
                  <button className="btn ghost" onClick={() => setConfirm('disconnect')} disabled={working} data-testid="posting-disconnect">
                    Disconnect
                  </button>
                ) : (
                  <button className="btn" onClick={() => void connect()} disabled={working} data-testid="posting-connect">
                    {yt ? 'Connect again' : 'Connect YouTube'}
                  </button>
                )}
              </div>
            )}
            <p className="muted-sm" style={{ margin: 0 }}>
              {SETTINGS_COPY.coming}
            </p>
          </div>

          <div className="stack" style={{ gap: 6 }} data-testid="posting-sign-in">
            {s.signedIn ? (
              <>
                <p style={{ margin: 0 }}>{signedInLine(s.otherComputers)}</p>
                <div className="row">
                  <button className="btn ghost" onClick={() => void run(async () => setS(await reel.posting.signOut()))} disabled={working} data-testid="posting-sign-out">
                    Sign out
                  </button>
                  <button className="btn ghost" onClick={() => setConfirm('everywhere')} disabled={working} data-testid="posting-sign-out-everywhere">
                    Sign out everywhere
                  </button>
                </div>
              </>
            ) : s.hasKey ? (
              <>
                <p style={{ margin: 0 }}>Not signed in.</p>
                <div className="row">
                  <button className="btn" onClick={() => void signIn()} disabled={working} data-testid="posting-sign-in-button">
                    Sign in
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>{SETTINGS_COPY.noKey}</p>
                <div className="row">
                  <button className="btn" onClick={() => void pasteThenSignIn()} disabled={working} data-testid="posting-paste-key">
                    Paste my download link
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {note && (
        <p className="muted-sm" role="status" style={{ marginTop: 10 }} data-testid="posting-note">
          {note}
        </p>
      )}
      <p className="muted-sm" style={{ marginTop: 14 }}>
        {SETTINGS_COPY.privacy}
      </p>

      {confirm === 'disconnect' && (
        <Confirm
          title={SETTINGS_COPY.disconnectTitle}
          body={disconnectBody(yt?.channelName ?? null)}
          yes="Disconnect"
          no="Keep it"
          danger
          onNo={() => setConfirm(null)}
          onYes={() => {
            setConfirm(null)
            void run(async () => setS(await reel.posting.disconnect('youtube')))
          }}
        />
      )}
      {confirm === 'everywhere' && (
        <Confirm
          title={SETTINGS_COPY.everywhereTitle}
          body={SETTINGS_COPY.everywhereBody}
          yes="Sign out everywhere"
          no="Cancel"
          danger
          onNo={() => setConfirm(null)}
          onYes={() => {
            setConfirm(null)
            void run(async () => setS(await reel.posting.signOutEverywhere()))
          }}
        />
      )}
    </section>
  )
}
