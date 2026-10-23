import { useEffect, useRef, useState } from 'react'
import type { PlatformExportResult, ProjectJson, VersionInfo } from '../../../shared/api'
import { PLATFORM_RULES, captionLength, checkPlatform, platformRule, type Platform } from '../../../shared/platforms'
import { clock } from '../../../shared/progress'
import { errorCode, reel, userMessage } from '../api'
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
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<ExportState>({ kind: 'choosing' })
  const [phoneFile, setPhoneFile] = useState<PlatformExportResult['files'][number] | null>(null)
  const [copied, setCopied] = useState<Platform | null>(null)
  const saving = state.kind === 'saving'
  const video = useRef<HTMLVideoElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const stopButton = useRef<HTMLButtonElement>(null)
  const screen = phoneFile ? 'phone' : state.kind === 'saved' ? 'saved' : 'choose'
  // One dialog whose content changes: move focus into the new content, as the dialog does on open.
  useEffect(() => {
    if (screen !== 'choose') (body.current?.querySelector<HTMLElement>('[data-autofocus]') ?? body.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
  }, [screen])

  const toggle = (platform: Platform) => setSelected((current) => current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform])
  // Limits change and vary by account, so they warn next to each platform and never stop the export.
  const warningsFor = (platform: Platform) => seconds === null || !selected.includes(platform) ? [] : checkPlatform(platform, caption, seconds)
  // The Export button turns into progress, so focus moves to Stop once the job can be stopped.
  useEffect(() => {
    if (saving && jobId) stopButton.current?.focus()
  }, [saving, jobId])
  const ready = selected.length > 0 && seconds !== null

  const save = async () => {
    if (!ready) return
    setError(null)
    setState({ kind: 'saving' })
    try {
      setState({ kind: 'saved', result: await reel.projects.exportPlatforms(slug, version.n, { platforms: selected, caption, coverSeconds }) })
    } catch (e) {
      if (errorCode(e) !== 'CANCELLED') setError(userMessage(e))
      setState({ kind: 'choosing' })
    }
  }
  // Pressing play after the end also seeks (to 0); only a scrub while paused picks the cover.
  const pickCover = (v: HTMLVideoElement) => {
    if (!saving && v.paused) setCoverSeconds(v.currentTime)
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
          {PLATFORM_RULES.map((rule, i) => {
            const warnings = warningsFor(rule.id)
            return <label className="platform-option" key={rule.id}>
              <input type="checkbox" checked={selected.includes(rule.id)} onChange={() => toggle(rule.id)} data-autofocus={i === 0 || undefined}
                aria-describedby={warnings.length ? `platform-warnings-${rule.id}` : undefined} />
              <span>
                <strong>{rule.label}</strong>
                <small>Up to {rule.maxSeconds >= 60 ? `${rule.maxSeconds / 60} min` : `${rule.maxSeconds} s`}{rule.captionLimit !== null ? ` · caption ${rule.captionLimit}` : ''}</small>
                {warnings.length > 0 && <span className="platform-warnings" id={`platform-warnings-${rule.id}`} data-testid={`platform-warnings-${rule.id}`}>
                  {warnings.map((w) => <span key={w.message}>{w.message}</span>)}
                </span>}
              </span>
            </label>
          })}
        </fieldset>
        {selected.length > 0 && <details className="muted-sm"><summary>Platform details</summary>{PLATFORM_RULES.filter((rule) => selected.includes(rule.id)).map((rule) => <p key={rule.id}>{rule.label}: {rule.note ?? 'The caption includes hashtags.'}</p>)}</details>}
        <label className="field-label" htmlFor="platform-caption">Post caption and hashtags</label>
        <textarea id="platform-caption" className="textarea" value={caption} onChange={(e) => setCaption(e.target.value)} disabled={saving} aria-describedby={['platform-caption-counts', ...selected.filter((p) => warningsFor(p).length).map((p) => `platform-warnings-${p}`)].join(' ')} />
        <p className="muted-sm platform-counts" id="platform-caption-counts">
          {PLATFORM_RULES.map((rule) => {
            if (!selected.includes(rule.id) || rule.captionLimit === null) return null
            const count = captionLength(rule.id, caption)
            return <span key={rule.id} className={count > rule.captionLimit ? 'over' : undefined}>{rule.label} {count}/{rule.captionLimit}</span>
          })}
          <span>This caption does not replace your saved post caption.</span>
        </p>
        <div className="platform-cover">
          <video ref={video} aria-label="Cover frame" src={version.video} poster={version.cover ?? undefined} muted controls preload="metadata"
            onLoadedMetadata={(e) => setSeconds(e.currentTarget.duration)}
            onSeeked={(e) => pickCover(e.currentTarget)}
            onError={() => setError('The video could not load. Close this dialog and render the version again.')} />
          <div className="stack" style={{ gap: 6 }}>
            <span className="field-label">Cover</span>
            <p className="muted-sm" data-testid="platform-cover-choice">
              {coverSeconds !== null ? `The frame at ${clock(coverSeconds)}.` : version.cover ? "Your reel's cover." : 'A frame from the first few seconds.'}
              {' '}Scrub the video to use a different frame.
            </p>
            {coverSeconds !== null && version.cover && <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={useProjectCover} disabled={saving}>Use my cover</button>}
          </div>
        </div>
        {error && <p className="platform-errors" role="alert">{error}</p>}
        <div className="platform-actions">
          <p className="muted-sm" data-testid="platform-edges">Each app puts its buttons and the caption over the edges of the video. Check that your subtitles and other details stay clear.</p>
          <div className="row">
            {saving
              ? <button ref={stopButton} className="btn ghost" disabled={!jobId} onClick={() => jobId && void reel.jobs.cancel(jobId)}>Stop export</button>
              : <button className="btn ghost" onClick={onClose}>Cancel</button>}
            <button className="btn primary" onClick={() => void save()} disabled={saving || !ready} data-testid="export-selected">
              {saving ? <><Spinner /> <span role="status">{status ?? 'Saving files'}</span></> : selected.length ? `Export for ${selected.length} ${selected.length === 1 ? 'platform' : 'platforms'}` : 'Choose a platform'}
            </button>
          </div>
        </div>
        {version.draft && <p className="muted-sm">This is a preview. I will make the full-quality version before saving the platform files.</p>}
      </>}
    </div>
  </Modal>
}
