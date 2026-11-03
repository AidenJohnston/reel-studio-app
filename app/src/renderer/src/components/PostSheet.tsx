// "Post to YouTube" inside the Export box: connect the channel once, fill in the title and who can see it, then
// watch it go. The upload runs in main (main/posting.ts), so leaving the reel page doesn't stop it; opening this
// sheet again for the same version picks the progress up. Which screen shows when is shared/posting.ts sheetState.
import { useEffect, useState } from 'react'
import type { PendingPost, PostPrivacy, PostProgress } from '../../../shared/api'
import {
  CONNECT_NOTES,
  DONE_PRIVACY,
  FIELD_ERRORS,
  POST_COPY,
  PRICING_URL,
  PRIVACY_CHOICES,
  SHORT_MAX_SEC,
  TERMS_URL,
  TITLE_MAX,
  defaultDescription,
  defaultTitle,
  descriptionProblem,
  megabytes,
  pct,
  privacyChanged,
  sheetState,
  titleProblem
} from '../../../shared/posting'
import { errorCode, reel, userMessage } from '../api'
import { usePostingStatus } from './PostButton'
import { Icon } from './icons'
import { Confirm, Progress, Spinner } from './ui'
import './PostSheet.css'

export function PostSheet({
  video,
  slug,
  version,
  title: reelTitle,
  caption,
  durationSec,
  onBack,
  onClose,
  onBusy
}: {
  video: string
  slug: string
  version: number
  title: string
  caption: string
  durationSec: number | null
  onBack: () => void
  onClose: () => void
  /** True while a post is being sent: the box can't be closed then (Stop is the way out). */
  onBusy?: (busy: boolean) => void
}) {
  const [status, setStatus] = usePostingStatus()
  const [progress, setProgress] = useState<PostProgress | null>(null)
  const [pending, setPending] = useState<PendingPost | null>(null)
  const [pendingChecked, setPendingChecked] = useState(false)
  const [connecting, setConnecting] = useState(false)
  // A line above the main button: how the last connect went, or what went wrong with a click.
  const [note, setNote] = useState<{ text: string; link?: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [working, setWorking] = useState(false)
  const [title, setTitle] = useState(() => defaultTitle(reelTitle))
  const [description, setDescription] = useState(() => defaultDescription(caption))
  const [privacy, setPrivacy] = useState<PostPrivacy>('private')
  const [kids, setKids] = useState(false)
  const [titleError, setTitleError] = useState<string | null>(null)
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const [asked, setAsked] = useState<PostPrivacy | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  const [copied, setCopied] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  // A post of this version that is running (started before this sheet opened), then every step as it comes.
  useEffect(() => {
    let live = true
    const mine = (p: PostProgress | null): p is PostProgress => !!p && p.slug === slug && p.version === version
    reel.posting
      .current()
      .then((p) => live && mine(p) && setProgress(p))
      .catch(() => {})
    const off = reel.posting.onProgress((p) => {
      if (mine(p)) setProgress(p)
    })
    return () => {
      live = false
      off()
    }
  }, [slug, version])

  // A post of this version that stopped part way: offer Finish posting.
  const ready = !!status?.signedIn && status.youtube?.state === 'connected'
  useEffect(() => {
    if (!ready) return
    let live = true
    reel.posting
      .pending(slug, version)
      .then((p) => live && setPending(p))
      .catch(() => {})
      .finally(() => live && setPendingChecked(true))
    return () => {
      live = false
    }
  }, [ready, slug, version])

  const state = sheetState(status, { progress, pending, connecting, editing })
  const sending = state === 'sending' || state === 'retrying'
  useEffect(() => onBusy?.(sending), [sending, onBusy])

  // "Trying again in 8 seconds…" counts down between the steps main sends.
  useEffect(() => {
    if (progress?.step !== 'retrying' || !progress.retryInSec) return setSecondsLeft(null)
    let left = progress.retryInSec
    setSecondsLeft(left)
    const t = setInterval(() => setSecondsLeft((left = Math.max(0, left - 1))), 1000)
    return () => clearInterval(t)
  }, [progress?.step, progress?.retryInSec, progress?.sent])

  const refresh = async () => setStatus(await reel.posting.status())
  const run = async (fn: () => Promise<void>) => {
    setWorking(true)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote({ text: userMessage(e), link: (e as { link?: string })?.link })
      await refresh().catch(() => {})
    } finally {
      setWorking(false)
    }
  }

  const pasteKey = () =>
    run(async () => {
      await reel.updateKey.paste()
      await refresh()
    })
  const signIn = () => run(async () => setStatus(await reel.posting.signIn()))
  const connect = async () => {
    setConnecting(true)
    setNote(null)
    try {
      const r = await reel.posting.connect('youtube')
      setStatus(r.status)
      const text = CONNECT_NOTES[r.outcome]
      if (text) setNote({ text })
    } catch (e) {
      setNote({ text: userMessage(e), link: (e as { link?: string })?.link })
      await refresh().catch(() => {})
    } finally {
      setConnecting(false)
    }
  }

  const post = async () => {
    const tp = titleProblem(title)
    const dp = descriptionProblem(description)
    setTitleError(tp)
    setDescriptionError(dp)
    if (tp || dp) return
    setNote(null)
    setAsked(privacy)
    setEditing(false)
    setCopied(false)
    setProgress({ uploadId: null, slug, version, step: 'starting', sent: 0, total: 0 })
    try {
      setProgress(await reel.posting.post({ video, slug, version, title: title.trim(), description, privacy, madeForKids: kids }))
    } catch (e) {
      // refused before anything was sent (a field, signed out, another post running)
      setProgress(null)
      if (errorCode(e) === 'BAD_FIELD' && userMessage(e) === FIELD_ERRORS.title) setTitleError(userMessage(e))
      else setNote({ text: userMessage(e), link: (e as { link?: string })?.link })
      await refresh().catch(() => {})
    }
  }

  const resume = async (uploadId: string) => {
    setNote(null)
    setEditing(false)
    setAsked(null) // asked in an earlier sheet: main's answer says what YouTube set
    setPending(null)
    try {
      setProgress(await reel.posting.resume(uploadId))
    } catch (e) {
      setProgress(null)
      setNote({ text: userMessage(e) })
      setPendingChecked(false)
      setPending(await reel.posting.pending(slug, version).catch(() => null))
      setPendingChecked(true)
    }
  }

  const startOver = () =>
    run(async () => {
      if (pending) await reel.posting.discard(pending.uploadId)
      setPending(null)
    })

  const head = (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <h2>{state === 'done' ? POST_COPY.doneHeading : POST_COPY.heading}</h2>
      {!sending && state !== 'done' && (
        <button className="btn ghost small" onClick={onBack} data-testid="post-back">
          <Icon name="back" size={16} /> Back
        </button>
      )}
    </div>
  )
  const noteLine = note && (
    <p className="post-note" role="status" data-testid="post-note">
      {note.text}{' '}
      {note.link && (
        <a href={note.link} target="_blank" rel="noreferrer">
          Subscribe again
        </a>
      )}
    </p>
  )

  let body: React.ReactNode
  if (state === 'loading' || (state === 'form' && !pendingChecked)) {
    body = (
      <div className="row">
        <Spinner />
      </div>
    )
  } else if (state === 'no_key') {
    body = (
      <>
        <p>{POST_COPY.noKey}</p>
        {noteLine}
        <div className="row">
          <button className="btn primary" onClick={() => void pasteKey()} disabled={working} data-testid="post-paste-key">
            Paste my download link
          </button>
        </div>
      </>
    )
  } else if (state === 'ended') {
    body = (
      <>
        <p>{POST_COPY.ended}</p>
        <div className="row">
          <a className="btn primary" href={PRICING_URL} target="_blank" rel="noreferrer" data-testid="post-subscribe">
            Subscribe again
          </a>
        </div>
      </>
    )
  } else if (state === 'signed_out') {
    body = (
      <>
        <p>{POST_COPY.signedOut}</p>
        {noteLine}
        <div className="row">
          <button className="btn primary" onClick={() => void signIn()} disabled={working} data-testid="post-sign-in">
            Sign in
          </button>
        </div>
      </>
    )
  } else if (state === 'not_connected' || state === 'reconnect') {
    body = (
      <>
        <p>{state === 'reconnect' ? POST_COPY.reconnect : POST_COPY.notConnected}</p>
        {noteLine}
        <div className="row">
          <button className="btn primary" onClick={() => void connect()} data-testid="post-connect">
            Connect YouTube
          </button>
        </div>
      </>
    )
  } else if (state === 'connecting') {
    body = (
      <>
        <p className="row" style={{ alignItems: 'flex-start' }}>
          <Spinner /> <span>{POST_COPY.connecting}</span>
        </p>
        <div className="row">
          <button className="btn" onClick={() => void reel.posting.reopenConnect().catch((e) => setNote({ text: userMessage(e) }))} data-testid="post-reopen">
            Open the page again
          </button>
          <button className="btn ghost" onClick={() => void reel.posting.cancelConnect()} data-testid="post-connect-cancel">
            Cancel
          </button>
        </div>
        {noteLine}
      </>
    )
  } else if (state === 'resume' && pending) {
    body = (
      <>
        <p>Your last post of this video stopped at {pct(pending.sent, pending.total)}%.</p>
        {noteLine}
        <div className="row">
          <button className="btn primary" onClick={() => void resume(pending.uploadId)} data-testid="post-finish">
            Finish posting
          </button>
          <button className="btn ghost" onClick={() => void startOver()} disabled={working} data-testid="post-start-over">
            Start over
          </button>
        </div>
      </>
    )
  } else if (state === 'sending' || state === 'retrying') {
    const p = progress!
    const percent = pct(p.sent, p.total)
    body = (
      <>
        <Progress pct={percent} label="Sending your video to YouTube" />
        {state === 'sending' ? (
          <p data-testid="post-sending">Sending your video to YouTube… {percent}%</p>
        ) : (
          <p data-testid="post-retrying">The connection dropped. Trying again in {secondsLeft ?? p.retryInSec ?? 0} seconds…</p>
        )}
        <p className="muted-sm">
          {p.total > 0 ? `${megabytes(p.sent)} of ${megabytes(p.total)} MB. ` : ''}
          {POST_COPY.keepOpen}
        </p>
        <div className="row">
          <button className="btn ghost" onClick={() => setConfirmStop(true)} data-testid="post-stop">
            Stop
          </button>
        </div>
      </>
    )
  } else if (state === 'failed') {
    const p = progress!
    body = (
      <>
        <p className="post-error" role="alert" data-testid="post-error">
          {p.error?.userMessage ?? userMessage(null)}{' '}
          {p.error?.link && (
            <a href={p.error.link} target="_blank" rel="noreferrer">
              Subscribe again
            </a>
          )}
        </p>
        <div className="row">
          {p.canResume && p.uploadId ? (
            <button className="btn primary" onClick={() => void resume(p.uploadId!)} data-testid="post-finish">
              Finish posting
            </button>
          ) : (
            <button className="btn primary" onClick={() => setEditing(true)} data-testid="post-try-again">
              Try again
            </button>
          )}
        </div>
      </>
    )
  } else if (state === 'done') {
    const r = progress!.result!
    const changed = asked ? privacyChanged(asked, r.privacy) : null
    body = (
      <>
        <p data-testid="post-done">{DONE_PRIVACY[r.privacy]}</p>
        {changed && (
          <p className="post-note" data-testid="post-privacy-changed">
            {changed}
          </p>
        )}
        <p className="muted-sm">{POST_COPY.getsReady}</p>
        <div className="row wrap">
          <button className="btn primary" onClick={() => void reel.posting.openLink(r.studioUrl)} data-autofocus data-testid="post-open-studio">
            <Icon name="external" size={16} /> Open in YouTube Studio
          </button>
          <button
            className="btn"
            onClick={async () => {
              await reel.app.copyText(r.videoUrl)
              setCopied(true)
            }}
            data-testid="post-copy-link"
          >
            <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copied' : 'Copy link'}
          </button>
          <button className="btn ghost" onClick={onClose} data-testid="post-done-close">
            Done
          </button>
        </div>
      </>
    )
  } else {
    // the form
    const channel = status?.youtube?.channelName
    body = (
      <form
        className="stack"
        style={{ gap: 14 }}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void post()
        }}
      >
        <div className="stack" style={{ gap: 2 }}>
          <p style={{ margin: 0 }} data-testid="post-channel">
            Posting to <strong>{channel ?? 'your YouTube channel'}</strong>
          </p>
          <p className="muted-sm" style={{ margin: 0 }}>
            {POST_COPY.notThisChannel}
          </p>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <label className="field-label" htmlFor="post-title">
            Title
          </label>
          <input
            id="post-title"
            className="input"
            maxLength={TITLE_MAX}
            value={title}
            aria-invalid={!!titleError}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleError(null)
            }}
            data-autofocus
            data-testid="post-title"
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted-sm field-error" role={titleError ? 'alert' : undefined}>
              {titleError}
            </span>
            {title.length >= 80 && <span className="muted-sm">{title.length}/100</span>}
          </div>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <label className="field-label" htmlFor="post-description">
            Description
          </label>
          <textarea
            id="post-description"
            className="textarea"
            style={{ minHeight: 84 }}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setDescriptionError(null)
            }}
            data-testid="post-description"
          />
          <p className={`muted-sm${descriptionError ? ' field-error' : ''}`} style={{ margin: 0 }} role={descriptionError ? 'alert' : undefined}>
            {descriptionError ?? POST_COPY.descriptionHelp}
          </p>
        </div>

        <fieldset className="post-privacy">
          <legend className="field-label">Who can see it</legend>
          {PRIVACY_CHOICES.map((c) => (
            <label key={c.value} className={`radio${privacy === c.value ? ' on' : ''}`}>
              <input type="radio" name="post-privacy" checked={privacy === c.value} onChange={() => setPrivacy(c.value)} data-testid={`post-privacy-${c.value}`} />
              {c.label}
            </label>
          ))}
        </fieldset>
        <p className="muted-sm" style={{ marginTop: -8 }}>
          {POST_COPY.privacyHelp}
        </p>

        <div className="stack" style={{ gap: 2 }}>
          <label className="toggle">
            <input type="checkbox" checked={kids} onChange={(e) => setKids(e.target.checked)} data-testid="post-kids" />
            Made for kids
          </label>
          <p className="muted-sm" style={{ margin: '0 0 0 30px' }}>
            {POST_COPY.kidsHelp}
          </p>
        </div>

        {durationSec !== null && durationSec > SHORT_MAX_SEC && (
          <p className="post-note" data-testid="post-not-short">
            {POST_COPY.notAShort}
          </p>
        )}
        {noteLine}

        <div className="row">
          <button type="submit" className="btn primary" data-testid="post-submit">
            <Icon name="upload" size={16} /> Post to YouTube
          </button>
        </div>
        <p className="muted-sm" style={{ margin: 0 }}>
          By posting, you agree to the{' '}
          <a href={TERMS_URL} target="_blank" rel="noreferrer">
            YouTube Terms of Service
          </a>
          .
        </p>
      </form>
    )
  }

  return (
    <div className="stack post-sheet" data-testid="post-sheet" data-state={state}>
      {head}
      {body}
      {confirmStop && (
        <Confirm
          title={POST_COPY.stopTitle}
          body={POST_COPY.stopBody}
          yes="Stop posting"
          no="Keep going"
          danger
          onNo={() => setConfirmStop(false)}
          onYes={() => {
            setConfirmStop(false)
            void reel.posting.cancel()
          }}
        />
      )}
    </div>
  )
}
