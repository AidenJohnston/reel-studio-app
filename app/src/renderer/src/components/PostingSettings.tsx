// Settings › Posting › YouTube: the connected channel with Disconnect, and this computer's sign-in to the posting
// server (Sign out, Sign out everywhere). Rendered only while posting is on (REELSTUDIO_POSTING=1); main/posting.ts
// does the work and shared/posting.ts holds every line of copy.
import { useState } from 'react'
import { CONNECT_NOTES, POST_COPY, PRICING_URL, SETTINGS_COPY, disconnectBody, signedInLine, youtubeLine } from '../../../shared/posting'
import { reel, userMessage } from '../api'
import { usePostingStatus } from './posting'
import { SettingRow } from './settings-rows'
import { Button, Confirm, Spinner } from './ui'

const sentence = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}.`

export function PostingRows() {
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

  const yt = s.youtube
  const waiting = connecting || s.connecting
  const channel = s.ended ? POST_COPY.ended : sentence(youtubeLine(s))
  const control = s.ended ? (
    <a className="btn small" href={PRICING_URL} target="_blank" rel="noreferrer" data-testid="posting-subscribe">
      Subscribe again
    </a>
  ) : waiting ? (
    <span className="sctl">
      <Spinner />
      <Button size="small" kind="tertiary" onClick={() => void reel.posting.cancelConnect()} data-testid="posting-connect-cancel">
        Cancel
      </Button>
    </span>
  ) : !s.signedIn ? null /* Sign in, just below, comes first: the channel can't be seen until then */ : yt?.state === 'connected' ? (
    <Button size="small" onClick={() => setConfirm('disconnect')} disabled={working} data-testid="posting-disconnect">
      Disconnect
    </Button>
  ) : (
    <Button size="small" onClick={() => void connect()} disabled={working} data-testid="posting-connect">
      {yt ? 'Connect again' : 'Connect YouTube'}
    </Button>
  )

  const signIn = s.signedIn ? (
    <span className="sctl">
      <Button size="small" kind="tertiary" onClick={() => void run(async () => setS(await reel.posting.signOut()))} disabled={working} data-testid="posting-sign-out">
        Sign out
      </Button>
      <Button size="small" kind="tertiary" onClick={() => setConfirm('everywhere')} disabled={working} data-testid="posting-sign-out-everywhere">
        Sign out everywhere
      </Button>
    </span>
  ) : s.hasKey ? (
    <Button size="small" onClick={() => void run(async () => setS(await reel.posting.signIn()))} disabled={working} data-testid="posting-sign-in-button">
      Sign in
    </Button>
  ) : (
    <Button
      size="small"
      onClick={() =>
        void run(async () => {
          await reel.updateKey.paste()
          setS(await reel.posting.signIn())
        })
      }
      disabled={working}
      data-testid="posting-paste-key"
    >
      Paste link
    </Button>
  )

  return (
    <>
      <SettingRow id="youtube" line={waiting ? POST_COPY.connecting : channel} control={control}>
        <p className="srow-more muted-sm">{SETTINGS_COPY.intro}</p>
        {note && (
          <p className="srow-more muted-sm" role="status" data-testid="posting-note">
            {note}
          </p>
        )}
      </SettingRow>
      {!s.ended && (
        <SettingRow
          id="posting-sign-in"
          sub
          line={s.signedIn ? signedInLine(s.otherComputers) : s.hasKey ? 'Not signed in.' : SETTINGS_COPY.noKey}
          control={signIn}
        >
          <p className="srow-more muted-sm">{SETTINGS_COPY.privacy}</p>
        </SettingRow>
      )}
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
    </>
  )
}

/** The Instagram row's line: what Share does for it, and, while posting is on, that the other platforms are coming. */
export function useInstagramLine(): string {
  const [s] = usePostingStatus()
  return s?.enabled
    ? `Not connected yet: Share saves your reel and copies its caption. ${SETTINGS_COPY.coming}`
    : 'Posting from Reel Studio isn’t ready yet. Share saves your reel and sends it to your phone.'
}
