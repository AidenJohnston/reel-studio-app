// "Post to Instagram", "Post to TikTok" and "Post to Facebook" from Share: connect once, check what goes up, then wait for the platform.
// Laid out like the YouTube sheet (PostSheet.tsx) and sharing its styles. The work runs in main (main/instagram.ts,
// main/tiktok.ts): Instagram checks the video for a few minutes before it posts, so the sheet stays until it answers.
//
// TikTok's own rules for apps that post (its Content Sharing Guidelines) decide the TikTok form: the account's name,
// who can see it with nothing picked until the person picks, comments, duets and stitches off until turned on, the
// brand disclosure, and the consent line above Post.
import { useEffect, useState, type ReactNode } from 'react'
import type { FacebookPost } from '../../../shared/facebook'
import type { InstagramPost } from '../../../shared/instagram'
import type { ThreadsPost } from '../../../shared/threads'
import type { XPost } from '../../../shared/x'
import type { LinkedInPost } from '../../../shared/linkedin'
import { BRANDED_TERMS_URL, MUSIC_TERMS_URL, PLATFORM_NAMES, SOCIAL_COPY, TIKTOK_PRIVACY_LABELS, availabilityLine, type SocialStatus } from '../../../shared/social'
import type { TikTokCreator, TikTokPrivacy, TikTokPublishResult } from '../../../shared/tiktok'
import { errorCode, reel, userMessage } from '../api'
import { Icon } from './icons'
import { accountName, PagePicker } from './SocialSettings'
import { Spinner } from './ui'
import './PostSheet.css'

type Id = 'instagram' | 'tiktok' | 'facebook' | 'threads' | 'x' | 'linkedin'
type Phase = 'form' | 'sending' | { done: InstagramPost | TikTokPublishResult | FacebookPost | ThreadsPost | XPost | LinkedInPost } | { failed: string }

const HEADINGS: Record<Id, [string, string]> = {
  instagram: [SOCIAL_COPY.igHeading, SOCIAL_COPY.igDoneHeading],
  tiktok: [SOCIAL_COPY.ttHeading, SOCIAL_COPY.ttDoneHeading],
  facebook: [SOCIAL_COPY.fbHeading, SOCIAL_COPY.fbDoneHeading],
  threads: [SOCIAL_COPY.thHeading, SOCIAL_COPY.thDoneHeading],
  x: [SOCIAL_COPY.xHeading, SOCIAL_COPY.xDoneHeading],
  linkedin: [SOCIAL_COPY.liHeading, SOCIAL_COPY.liDoneHeading]
}
const WAIT: Record<Id, string> = { instagram: SOCIAL_COPY.igWait, tiktok: SOCIAL_COPY.ttWait, facebook: SOCIAL_COPY.fbWait, threads: SOCIAL_COPY.thWait, x: SOCIAL_COPY.xWait, linkedin: SOCIAL_COPY.liWait }
/** Each platform's caption limit: X 280, Threads 500, LinkedIn 3,000, the rest 2,200. */
const LIMIT: Record<Id, number> = { instagram: 2200, tiktok: 2200, facebook: 2200, threads: 500, x: 280, linkedin: 3000 }

const PRIVACY_ORDER: TikTokPrivacy[] = ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']

export function SocialPostSheet({
  platform,
  slug,
  version,
  caption: shared,
  hasCover,
  durationSec,
  status,
  reload,
  onBack,
  onClose,
  onBusy
}: {
  platform: Id
  slug: string
  version: number
  caption: string
  /** The version has the cover Reel Studio picked (export's cover.png). */
  hasCover: boolean
  durationSec: number | null
  status: SocialStatus
  reload: (fresh?: boolean) => Promise<void>
  onBack: () => void
  onClose: () => void
  onBusy: (busy: boolean) => void
}) {
  const name = PLATFORM_NAMES[platform]
  const account = accountName(status, platform)
  const a = status[platform].availability
  const [connecting, setConnecting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('form')
  const [caption, setCaption] = useState(shared)
  // Instagram
  const [cover, setCover] = useState<'image' | 'frame'>(hasCover ? 'image' : 'frame')
  const [trial, setTrial] = useState(false)
  // TikTok
  const [creator, setCreator] = useState<TikTokCreator | 'inbox' | null>(null)
  const [privacy, setPrivacy] = useState<TikTokPrivacy | null>(null)
  const [allow, setAllow] = useState({ comment: false, duet: false, stitch: false })
  const [disclose, setDisclose] = useState(false)
  const [own, setOwn] = useState(false)
  const [branded, setBranded] = useState(false)
  const [aigc, setAigc] = useState(false)

  const sending = phase === 'sending'
  useEffect(() => onBusy(sending), [sending, onBusy])

  // TikTok's current options for this account, asked each time the form opens. Without permission to post directly
  // (an app TikTok hasn't given it to), the video goes to the account's TikTok inbox to finish there.
  useEffect(() => {
    if (platform !== 'tiktok' || !account) return
    let live = true
    reel.tiktok
      .creator()
      .then((c) => live && setCreator(c))
      .catch((e) => {
        if (!live) return
        if (errorCode(e) === 'TT_PERMISSION') setCreator('inbox')
        else setNote(userMessage(e))
      })
    return () => {
      live = false
    }
  }, [platform, account])

  const connect = async () => {
    setConnecting(true)
    setNote(null)
    try {
      await reel[platform].connect()
    } catch (e) {
      if (!['IG_CANCELLED', 'TT_CANCELLED'].includes(errorCode(e) ?? '')) setNote(userMessage(e))
    } finally {
      setConnecting(false)
      await reload()
    }
  }

  const post = async () => {
    setNote(null)
    setPhase('sending')
    try {
      if (platform === 'instagram') {
        const done = await reel.instagram.publish({
          slug, version, caption, cover: cover === 'image' ? { kind: 'image' } : { kind: 'frame', offsetMs: 0 },
          ...(trial ? { trial: { graduation: 'MANUAL' as const } } : {})
        })
        setPhase({ done })
      } else if (platform === 'linkedin') {
        setPhase({ done: await reel.linkedin.publish({ slug, version, text: caption }) })
      } else if (platform === 'x') {
        setPhase({ done: await reel.x.publish({ slug, version, text: caption }) })
      } else if (platform === 'threads') {
        setPhase({ done: await reel.threads.publish({ slug, version, text: caption }) })
      } else if (platform === 'facebook') {
        setPhase({ done: await reel.facebook.publish({ slug, version, description: caption }) })
      } else {
        const direct = creator !== 'inbox' && creator !== null
        const done = await reel.tiktok.publish({
          slug, version, caption, consent: true, durationSec: durationSec!,
          mode: direct ? 'direct-or-inbox' : 'inbox',
          privacy: privacy ?? 'SELF_ONLY',
          disableComment: !allow.comment, disableDuet: !allow.duet, disableStitch: !allow.stitch,
          brandContent: disclose && branded, brandOrganic: disclose && own, isAigc: aigc
        })
        setPhase({ done })
      }
    } catch (e) {
      setPhase({ failed: userMessage(e) })
    }
  }

  const head = (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <h2>{HEADINGS[platform][typeof phase === 'object' && 'done' in phase ? 1 : 0]}</h2>
      {!sending && !(typeof phase === 'object' && 'done' in phase) && (
        <button className="btn ghost small" onClick={onBack} data-testid="social-back">
          <Icon name="back" size={16} /> Back
        </button>
      )}
    </div>
  )
  const noteLine = note && (
    <p className="post-note" role="status" data-testid="social-note">
      {note}
    </p>
  )

  let state: string
  let body: ReactNode
  if (!a.open) {
    state = 'closed'
    body = <p>{availabilityLine(platform, a)}</p>
  } else if (connecting) {
    state = 'connecting'
    body = (
      <>
        <p className="row" role="status" style={{ alignItems: 'flex-start' }}>
          <Spinner /> <span>{SOCIAL_COPY.connecting(name)}</span>
        </p>
        <div className="row">
          <button className="btn ghost" onClick={() => void reel[platform].cancelConnect()} data-testid="social-connect-cancel">
            Cancel
          </button>
        </div>
      </>
    )
  } else if (!account) {
    state = 'not_connected'
    const line = availabilityLine(platform, a)
    body = (
      <>
        <p>{SOCIAL_COPY.connectOnce(name)}</p>
        {line && <p className="muted-sm">{line}</p>}
        {noteLine}
        <div className="row">
          <button className="btn primary" onClick={() => void connect()} data-autofocus data-testid="social-connect">
            Connect {name}
          </button>
        </div>
      </>
    )
  } else if (sending) {
    state = 'sending'
    body = (
      <>
        <p className="row" role="status" data-testid="social-sending">
          <Spinner /> <span>{SOCIAL_COPY.sending(name)}</span>
        </p>
        <p className="muted-sm">{WAIT[platform]}</p>
      </>
    )
  } else if (typeof phase === 'object' && 'failed' in phase) {
    state = 'failed'
    body = (
      <>
        <p className="post-error" role="alert" data-testid="social-error">
          {phase.failed}
        </p>
        <div className="row">
          <button className="btn primary" onClick={() => setPhase('form')} data-testid="social-try-again">
            Try again
          </button>
        </div>
      </>
    )
  } else if (typeof phase === 'object' && 'done' in phase) {
    state = 'done'
    const r = phase.done
    body = (
      <>
        <p data-testid="social-done">
          {'message' in r ? r.message : platform === 'facebook' ? SOCIAL_COPY.fbDone(account ?? 'your Page') : platform === 'threads' ? SOCIAL_COPY.thDone : platform === 'x' ? SOCIAL_COPY.xDone : platform === 'linkedin' ? SOCIAL_COPY.liDone : trial ? SOCIAL_COPY.igDoneTrial : SOCIAL_COPY.igDone}
        </p>
        <div className="row">
          <button className="btn primary" onClick={onClose} data-autofocus data-testid="social-done-close">
            Done
          </button>
        </div>
      </>
    )
  } else if (platform === 'tiktok' && creator === null) {
    state = 'loading'
    body = (
      <>
        <div className="row">
          <Spinner />
        </div>
        {noteLine}
      </>
    )
  } else {
    state = 'form'
    const tt = platform === 'tiktok' ? creator : null
    const direct = tt !== null && tt !== 'inbox'
    const maxSec = direct ? tt.maxDurationSec : null
    const tooLong = maxSec !== null && durationSec !== null && durationSec > maxSec
    const noDuration = platform === 'tiktok' && durationSec === null
    // TikTok: Post waits for a privacy choice, and for a disclosure choice once disclosure is turned on
    const fits = [...caption].length <= LIMIT[platform]
    const ready = fits && (platform !== 'tiktok' || (!tooLong && !noDuration && (!direct || privacy !== null) && (!disclose || own || branded)))
    const choices = direct ? PRIVACY_ORDER.filter((p) => tt.privacyOptions.includes(p)) : []
    body = (
      <form
        className="stack"
        style={{ gap: 14 }}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) void post()
        }}
      >
        <p style={{ margin: 0 }} data-testid="social-account">
          Posting to <strong>{platform === 'instagram' || platform === 'threads' || platform === 'x' ? `@${account}` : direct ? tt.displayName : account}</strong>
        </p>
        {a.review !== 'approved' && a.review !== 'own' && <p className="muted-sm" style={{ margin: 0 }}>{availabilityLine(platform, a)}</p>}
        {platform === 'facebook' && status.facebook.session.connected && status.facebook.session.pages.length > 1 && (
          <PagePicker session={status.facebook.session} onPicked={() => void reload()} onError={setNote} />
        )}

        <div className="stack" style={{ gap: 6 }}>
          <label className="field-label" htmlFor="social-caption">
            Caption
          </label>
          <textarea id="social-caption" className="textarea" style={{ minHeight: 84 }} value={caption} maxLength={LIMIT[platform]} onChange={(e) => setCaption(e.target.value)} data-autofocus data-testid="social-caption" />
          <p className="muted-sm" style={{ margin: 0 }}>
            A change here is for this post only. {caption.length.toLocaleString()}/{LIMIT[platform].toLocaleString()}
          </p>
        </div>

        {platform === 'instagram' && (
          <>
            {hasCover && (
              <fieldset className="post-privacy">
                <legend className="field-label">{SOCIAL_COPY.igCover}</legend>
                {(['image', 'frame'] as const).map((c) => (
                  <label key={c} className={`radio${cover === c ? ' on' : ''}`}>
                    <input type="radio" name="social-cover" checked={cover === c} onChange={() => setCover(c)} data-testid={`social-cover-${c}`} />
                    {c === 'image' ? SOCIAL_COPY.igCoverImage : SOCIAL_COPY.igCoverFrame}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="stack" style={{ gap: 2 }}>
              <label className="toggle">
                <input type="checkbox" checked={trial} onChange={(e) => setTrial(e.target.checked)} data-testid="social-trial" />
                {SOCIAL_COPY.igTrial}
              </label>
              <p className="muted-sm" style={{ margin: '0 0 0 30px' }}>
                {SOCIAL_COPY.igTrialHelp}
              </p>
            </div>
          </>
        )}

        {platform === 'tiktok' && !direct && <p className="post-note">{SOCIAL_COPY.ttInbox}</p>}
        {platform === 'tiktok' && direct && (
          <>
            {tt.privateOnly && <p className="post-note">{SOCIAL_COPY.ttUnaudited}</p>}
            <fieldset className="post-privacy" style={{ gridTemplateColumns: `repeat(${Math.min(choices.length, 4)}, 1fr)` }}>
              <legend className="field-label">{SOCIAL_COPY.ttPrivacy}</legend>
              {choices.map((p) => (
                <label key={p} className={`radio${privacy === p ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="social-privacy"
                    checked={privacy === p}
                    disabled={disclose && branded && p === 'SELF_ONLY'}
                    onChange={() => setPrivacy(p)}
                    data-testid={`social-privacy-${p}`}
                  />
                  {TIKTOK_PRIVACY_LABELS[p]}
                </label>
              ))}
            </fieldset>
            {privacy === null && <p className="muted-sm" style={{ marginTop: -8 }}>{SOCIAL_COPY.ttPrivacyPick}</p>}
            <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">{SOCIAL_COPY.ttInteractions}</legend>
              {(['comment', 'duet', 'stitch'] as const).map((k) => {
                const off = k === 'comment' ? tt.commentDisabled : k === 'duet' ? tt.duetDisabled : tt.stitchDisabled
                return (
                  <label key={k} className="toggle">
                    <input type="checkbox" checked={allow[k] && !off} disabled={off} onChange={(e) => setAllow({ ...allow, [k]: e.target.checked })} data-testid={`social-allow-${k}`} />
                    {k === 'comment' ? 'Comment' : k === 'duet' ? 'Duet' : 'Stitch'}
                    {off && <span className="muted-sm"> (turned off in your TikTok settings)</span>}
                  </label>
                )
              })}
            </fieldset>
            <div className="stack" style={{ gap: 6 }}>
              <label className="toggle">
                <input type="checkbox" checked={disclose} onChange={(e) => setDisclose(e.target.checked)} data-testid="social-disclose" />
                {SOCIAL_COPY.ttDisclose}
              </label>
              {disclose && (
                <div className="stack" style={{ gap: 6, marginLeft: 30 }}>
                  <label className="toggle">
                    <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} data-testid="social-brand-own" />
                    {SOCIAL_COPY.ttYourBrand}
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={branded}
                      onChange={(e) => {
                        setBranded(e.target.checked)
                        // a paid partnership can't be Only me
                        if (e.target.checked && privacy === 'SELF_ONLY') setPrivacy(null)
                      }}
                      data-testid="social-brand-paid"
                    />
                    {SOCIAL_COPY.ttBranded}
                  </label>
                  {(own || branded) && <p className="muted-sm" style={{ margin: 0 }}>{branded ? SOCIAL_COPY.ttBrandedNote : SOCIAL_COPY.ttOwnNote}</p>}
                </div>
              )}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={aigc} onChange={(e) => setAigc(e.target.checked)} data-testid="social-aigc" />
              {SOCIAL_COPY.ttAigc}
            </label>
          </>
        )}
        {tooLong && <p className="post-note">{SOCIAL_COPY.ttTooLong(maxSec)}</p>}
        {noDuration && <p className="post-note">{SOCIAL_COPY.noDuration}</p>}
        {!fits && <p className="post-note" data-testid="social-too-long">{SOCIAL_COPY.captionTooLong(name, LIMIT[platform])}</p>}
        {noteLine}

        <div className="row">
          <button type="submit" className="btn primary" disabled={!ready} data-testid="social-submit">
            <Icon name="upload" size={16} /> Post to {name}
          </button>
        </div>
        {platform === 'tiktok' && (
          <p className="muted-sm" style={{ margin: 0 }}>
            {disclose && branded ? (
              <>
                By posting, you agree to TikTok’s{' '}
                <a href={BRANDED_TERMS_URL} target="_blank" rel="noreferrer">Branded Content Policy</a> and{' '}
                <a href={MUSIC_TERMS_URL} target="_blank" rel="noreferrer">Music Usage Confirmation</a>.
              </>
            ) : (
              <>
                By posting, you agree to TikTok’s <a href={MUSIC_TERMS_URL} target="_blank" rel="noreferrer">Music Usage Confirmation</a>.
              </>
            )}
          </p>
        )}
      </form>
    )
  }

  return (
    <div className="stack post-sheet" data-testid="social-sheet" data-platform={platform} data-state={state}>
      {head}
      {body}
    </div>
  )
}
