// Settings › Posting › Instagram, TikTok and Facebook: connect, see who is connected, disconnect. Each connects through Reel
// Studio's sign-in service (docs/signin.md); when it can't yet, the row says why (shared/social.ts) and offers a
// fresh check. Same rows and controls as YouTube's (PostingSettings.tsx).
import { useState } from 'react'
import type { FacebookSession } from '../../../shared/facebook'
import { PLATFORM_NAMES, SOCIAL_COPY, availabilityLine, connectedLine, type SocialStatus } from '../../../shared/social'
import { reel, userMessage } from '../api'
import { SettingRow } from './settings-rows'
import { useSocialStatus } from './social'
import { Button, Confirm, Spinner } from './ui'

type Id = 'instagram' | 'tiktok' | 'facebook' | 'threads' | 'x' | 'linkedin'

/** The account a platform's row names, or null when nothing is connected. */
export function accountName(s: SocialStatus, id: Id): string | null {
  const x = s[id].session
  if (!x.connected) return null
  return 'username' in x ? x.username : 'displayName' in x ? x.displayName : 'name' in x ? x.name : x.page.name
}

export function SocialRows() {
  const [s, reload] = useSocialStatus()
  if (!s) return null
  return (
    <>
      <PlatformRow id="instagram" s={s} reload={reload} />
      <PlatformRow id="tiktok" s={s} reload={reload} />
      <PlatformRow id="facebook" s={s} reload={reload} />
      <PlatformRow id="threads" s={s} reload={reload} />
      <PlatformRow id="x" s={s} reload={reload} />
      <PlatformRow id="linkedin" s={s} reload={reload} />
    </>
  )
}

function PlatformRow({ id, s, reload }: { id: Id; s: SocialStatus; reload: (fresh?: boolean) => Promise<void> }) {
  const [connecting, setConnecting] = useState(false)
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const name = PLATFORM_NAMES[id]
  const api = reel[id]
  const account = accountName(s, id)
  const a = s[id].availability

  const connect = async () => {
    setConnecting(true)
    setNote(null)
    try {
      await api.connect()
    } catch (e) {
      // Cancel is the person's own choice: nothing to explain
      const code = (e as { code?: string } | null)?.code
      if (code !== 'IG_CANCELLED' && code !== 'TT_CANCELLED') setNote(userMessage(e))
    } finally {
      setConnecting(false)
      await reload()
    }
  }
  const check = async () => {
    setWorking(true)
    setNote(null)
    await reload(true)
    setWorking(false)
  }

  const line = connecting ? SOCIAL_COPY.connecting(name) : account ? connectedLine(id, account) : availabilityLine(id, a) || 'Not connected.'
  const control = connecting ? (
    <span className="sctl">
      <Spinner />
      <Button size="small" kind="tertiary" onClick={() => void api.cancelConnect()} data-testid={`${id}-connect-cancel`}>
        Cancel
      </Button>
    </span>
  ) : account ? (
    <Button size="small" onClick={() => setConfirm(true)} disabled={working} data-testid={`${id}-disconnect`}>
      Disconnect
    </Button>
  ) : a.open ? (
    <Button size="small" onClick={() => void connect()} data-testid={`${id}-connect`}>
      Connect {name}
    </Button>
  ) : (
    <Button size="small" kind="tertiary" onClick={() => void check()} disabled={working} data-testid={`${id}-check`}>
      Check again
    </Button>
  )

  return (
    <SettingRow id={id} line={line} control={control}>
      {account && a.open && a.review !== 'approved' && a.review !== 'own' && (
        <p className="srow-more muted-sm" data-testid={`${id}-review`}>
          {availabilityLine(id, a)}
        </p>
      )}
      {id === 'facebook' && s.facebook.session.connected && s.facebook.session.pages.length > 1 && (
        <PagePicker session={s.facebook.session} onPicked={() => void reload()} onError={setNote} />
      )}
      {note && (
        <p className="srow-more muted-sm" role="status" data-testid={`${id}-note`}>
          {note}
        </p>
      )}
      {confirm && account && (
        <Confirm
          title={SOCIAL_COPY.disconnectTitle(name)}
          body={SOCIAL_COPY.disconnectBody(name, id === 'instagram' || id === 'threads' || id === 'x' ? `@${account}` : id === 'facebook' && s.facebook.session.connected ? s.facebook.session.userName : account)}
          yes="Disconnect"
          no="Keep it"
          danger
          onNo={() => setConfirm(false)}
          onYes={() => {
            setConfirm(false)
            setWorking(true)
            void api
              .disconnect()
              .catch((e) => setNote(userMessage(e)))
              .finally(() => {
                setWorking(false)
                void reload()
              })
          }}
        />
      )}
    </SettingRow>
  )
}

/** Which Page posts go to, for an account that can post to more than one. */
export function PagePicker({ session, onPicked, onError }: { session: Extract<FacebookSession, { connected: true }>; onPicked: () => void; onError: (m: string) => void }) {
  return (
    <label className="srow-more muted-sm row" style={{ gap: 8 }}>
      Post to
      <select
        className="input"
        style={{ width: 'auto' }}
        value={session.page.id}
        onChange={(e) => void reel.facebook.choosePage(e.target.value).then(onPicked, (err) => onError(userMessage(err)))}
        data-testid="facebook-page"
      >
        {session.pages.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )
}
