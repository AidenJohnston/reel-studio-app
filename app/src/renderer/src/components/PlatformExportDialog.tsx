import { useEffect, useRef, useState } from 'react'
import type { PlatformExportResult, ProjectJson, VersionInfo } from '../../../shared/api'
import { PLATFORM_RULES, captionLength, checkPlatform, platformRule, type Platform } from '../../../shared/platforms'
import { clock } from '../../../shared/progress'
import { reel, userMessage } from '../api'
import { FOLDER_APP, Modal, Spinner } from './ui'
import { SendToPhone } from './SendToPhone'

type ExportState = { kind: 'choosing' } | { kind: 'saving' } | { kind: 'saved'; result: PlatformExportResult }

export function PlatformExportDialog({ slug, version, post, jobId, status, onClose }: {
  slug: string
  version: VersionInfo
  post: ProjectJson['post']
  jobId?: string
  /** What the export job is doing right now. */
  status?: string
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Platform[]>([])
  const [caption, setCaption] = useState(() => [post?.caption ?? '', (post?.hashtags ?? []).map((h) => h.startsWith('#') ? h : `#${h}`).join(' ')].filter(Boolean).join('\n\n'))
  const [seconds, setSeconds] = useState<number | null>(null)
  // null: the project's own cover. A number: the frame the person scrubbed to.
  const [coverSeconds, setCoverSeconds] = useState<number | null>(null)
  const [safeChecked, setSafeChecked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<ExportState>({ kind: 'choosing' })
  const [phoneFile, setPhoneFile] = useState<PlatformExportResult['files'][number] | null>(null)
  const [copied, setCopied] = useState<Platform | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const screen = phoneFile ? 'phone' : state.kind === 'saved' ? 'saved' : 'choose'
  // One dialog whose content changes: move focus into the new content, as the dialog does on open.
  useEffect(() => {
    if (screen !== 'choose') (body.current?.querySelector<HTMLElement>('[data-autofocus]') ?? body.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
  }, [screen])

  const toggle = (platform: Platform) => setSelected((current) => current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform])
  const checks = selected.flatMap((platform) => checkPlatform(platform, caption, seconds ?? 0).map((issue) => ({ ...issue, text: `${platformRule(platform).label}: ${issue.message}` })))
  const blocking = seconds === null ? [] : checks.filter((c) => c.blocking)
  const warnings = seconds === null ? [] : checks.filter((c) => !c.blocking)
  const ready = selected.length > 0 && seconds !== null && blocking.length === 0 && safeChecked
  const saving = state.kind === 'saving'

  const save = async () => {
    if (!ready) return
    setError(null)
    setState({ kind: 'saving' })
    try {
      setState({ kind: 'saved', result: await reel.projects.exportPlatforms(slug, version.n, { platforms: selected, caption, coverSeconds }) })
    } catch (e) {
      setError(userMessage(e))
      setState({ kind: 'choosing' })
    }
  }
  const useProjectCover = () => {
    setCoverSeconds(null)
    video.current?.load() // shows the cover picture again
  }

  return <Modal onClose={saving ? undefined : onClose} wide testid="platform-export-dialog">
    <div ref={body} className="platform-export">
      {phoneFile ? <>
        <h2>Send {platformRule(phoneFile.platform).label} to your phone</h2>
        <SendToPhone video={phoneFile.video} caption={phoneFile.caption} onBack={() => setPhoneFile(null)} />
      </> : state.kind === 'saved' ? <>
        <h2 data-testid="export-saved">Saved {state.result.files.length} platform {state.result.files.length === 1 ? 'file' : 'files'}</h2>
        <p className="muted">Your videos, covers and post captions are in Library › Finished videos. Upload them in each platform's own app.</p>
        <div className="platform-results">
          {state.result.files.map((file) => <div className="platform-result" key={file.platform}>
            <strong>{platformRule(file.platform).label}</strong>
            <p className="muted-sm selectable" data-testid="export-name">{file.video.split(/[\\/]/).pop()}</p>
            <div className="row wrap">
              <button className="btn small" onClick={() => void reel.app.openFolder(file.video)}>Show in {FOLDER_APP}</button>
              <button className="btn small" onClick={() => setPhoneFile(file)}>Send to my phone</button>
              <button className="btn small" onClick={() => void reel.app.copyText(file.caption).then(() => setCopied(file.platform))}>{copied === file.platform ? 'Copied' : 'Copy caption'}</button>
            </div>
          </div>)}
        </div>
        <button className="btn primary" onClick={onClose} data-autofocus>Done</button>
      </> : <>
        <h2>Export for other platforms</h2>
        <p className="muted">Choose where Version {version.n} is going. Each platform gets a named video, cover and caption file. Nothing is posted.</p>
        <fieldset className="platform-options" disabled={saving}>
          <legend>Platforms</legend>
          {PLATFORM_RULES.map((rule, i) => <label className="platform-option" key={rule.id}>
            <input type="checkbox" checked={selected.includes(rule.id)} onChange={() => toggle(rule.id)} data-autofocus={i === 0 || undefined} />
            <span><strong>{rule.label}</strong><small>Up to {rule.maxSeconds >= 60 ? `${rule.maxSeconds / 60} min` : `${rule.maxSeconds} s`}{rule.captionLimit !== null ? ` · caption ${rule.captionLimit}` : ''}</small></span>
          </label>)}
        </fieldset>
        {selected.length > 0 && <details className="muted-sm"><summary>Platform details</summary>{PLATFORM_RULES.filter((rule) => selected.includes(rule.id)).map((rule) => <p key={rule.id}>{rule.label}: {rule.width} × {rule.height}. {rule.note ?? 'The caption includes hashtags.'}</p>)}</details>}
        <label className="field-label" htmlFor="platform-caption">Post caption and hashtags</label>
        <textarea id="platform-caption" className="textarea" value={caption} onChange={(e) => setCaption(e.target.value)} disabled={saving} aria-describedby="platform-caption-counts" />
        <p className="muted-sm platform-counts" id="platform-caption-counts">
          {PLATFORM_RULES.map((rule) => {
            if (!selected.includes(rule.id) || rule.captionLimit === null) return null
            const count = captionLength(rule.id, caption)
            return <span key={rule.id} className={count > rule.captionLimit ? 'over' : undefined}>{rule.label} {count}/{rule.captionLimit}</span>
          })}
          <span>This caption does not replace your saved post caption.</span>
        </p>
        <div className="platform-cover">
          <video ref={video} src={version.video} poster={version.cover ?? undefined} muted controls preload="metadata"
            onLoadedMetadata={(e) => setSeconds(e.currentTarget.duration)}
            onSeeked={(e) => { if (!saving) setCoverSeconds(e.currentTarget.currentTime) }}
            onError={() => setError('The video could not load. Close this dialog and render the version again.')} />
          <div className="stack" style={{ gap: 6 }}>
            <span className="field-label">Cover</span>
            <p className="muted-sm" data-testid="platform-cover-choice">
              {coverSeconds !== null ? `The frame at ${clock(coverSeconds)}.` : version.cover ? 'Your reel’s cover.' : 'A frame from the first few seconds.'}
              {' '}Scrub the video to use a different frame.
            </p>
            {coverSeconds !== null && version.cover && <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={useProjectCover} disabled={saving}>Use my cover</button>}
          </div>
        </div>
        <label className="platform-option">
          <input type="checkbox" checked={safeChecked} onChange={(e) => setSafeChecked(e.target.checked)} disabled={saving} />
          <span>I checked subtitles and important details near the edges.<small>Platform buttons and captions can cover them. Exports fit inside a vertical frame without cropping or moving baked-in text.</small></span>
        </label>
        {blocking.length > 0 && <ul className="platform-errors" role="alert">{blocking.map((c) => <li key={c.text}>{c.text}</li>)}</ul>}
        {warnings.length > 0 && <ul className="muted-sm platform-warnings" aria-live="polite">{warnings.map((c) => <li key={c.text}>{c.text}</li>)}</ul>}
        {error && <p className="platform-errors" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {saving
            ? <button className="btn ghost" disabled={!jobId} onClick={() => jobId && void reel.jobs.cancel(jobId)}>Stop export</button>
            : <button className="btn ghost" onClick={onClose}>Cancel</button>}
          <button className="btn primary" onClick={() => void save()} disabled={saving || !ready} data-testid="export-selected">
            {saving ? <><Spinner /> {status ?? 'Saving files'}</> : selected.length ? `Export for ${selected.length} ${selected.length === 1 ? 'platform' : 'platforms'}` : 'Choose a platform'}
          </button>
        </div>
        {version.draft && <p className="muted-sm">This is a preview. I will make the full-quality version before saving the platform files.</p>}
      </>}
    </div>
  </Modal>
}
