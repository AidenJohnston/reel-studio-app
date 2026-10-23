import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PlatformExportResult, ProjectJson, VersionInfo } from '../../../shared/api'
import { PLATFORM_RULES, captionLength, checkPlatform, platformRule, fallbackCoverSeconds, secondTryPlatforms, secondTryProblem, tryChanges, type Platform, type PlatformTry } from '../../../shared/platforms'
import { clock } from '../../../shared/progress'
import { errorCode, reel, userMessage } from '../api'
import { FOLDER_APP, Modal, Spinner } from './ui'
import { SendToPhone } from './SendToPhone'

type ExportState = { kind: 'choosing' } | { kind: 'saving' } | { kind: 'saved'; result: PlatformExportResult }
type PlatformFile = PlatformExportResult['files'][number]

const andList = (names: string[]): string => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
const fileName = (path: string): string | undefined => path.split(/[\\/]/).pop()

export function PlatformExportDialog({ slug, version, versions, fps, post, jobId, status, onClose }: {
  slug: string
  version: VersionInfo
  versions: VersionInfo[]
  /** The render's frame rate, to tell whether two cover times are the same frame. */
  fps: number
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
  // Try 2: null while Try two versions is off.
  const [second, setSecond] = useState<PlatformTry | null>(null)
  const [secondSeconds, setSecondSeconds] = useState<number | null>(null)
  const [phoneFile, setPhoneFile] = useState<PlatformFile | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const saving = state.kind === 'saving'
  const video = useRef<HTMLVideoElement>(null)
  const secondVideo = useRef<HTMLVideoElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const stopButton = useRef<HTMLButtonElement>(null)
  const screen = phoneFile ? 'phone' : state.kind === 'saved' ? 'saved' : 'choose'
  // One dialog whose content changes: move focus into the new content, as the dialog does on open.
  useEffect(() => {
    if (screen !== 'choose') (body.current?.querySelector<HTMLElement>('[data-autofocus]') ?? body.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
  }, [screen])

  const toggle = (platform: Platform) => setSelected((current) => current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform])
  const first: PlatformTry = { version: version.n, caption, coverSeconds }
  const secondVersion = second && versions.find((v) => v.n === second.version)
  const secondPlatforms = second ? secondTryPlatforms(selected, second.version === version.n) : []
  const secondDuration = second?.version === version.n ? seconds : secondSeconds
  // Covers are compared only on one video, Try 1's; Export waits for its duration anyway.
  const coverClock = { fps, end: seconds ?? Infinity, fallback: version.cover || seconds === null ? null : fallbackCoverSeconds(seconds) }
  const secondProblem = second && selected.length ? secondTryProblem(selected, first, second, coverClock) : null
  // Limits change and vary by account, so they warn next to each platform and never stop the export.
  const warningsFor = (platform: Platform): string[] => {
    if (!selected.includes(platform)) return []
    const firstWarnings = seconds === null ? [] : checkPlatform(platform, caption, seconds).map((issue) => `${second ? 'Try 1: ' : ''}${issue.message}`)
    if (!second || !secondPlatforms.includes(platform) || secondDuration === null) return firstWarnings
    // A Try 2 on Try 1's video would only repeat Try 1's duration warnings.
    const secondWarnings = checkPlatform(platform, second.caption, secondDuration).filter((issue) => issue.kind !== 'duration' || second.version !== version.n)
    return [...firstWarnings, ...secondWarnings.map((issue) => `Try 2: ${issue.message}`)]
  }
  // The ids of the warning lines shown under these platforms, so a caption box is described by them.
  const warned = (platforms: Platform[]) => platforms.filter((p) => warningsFor(p).length).map((p) => `platform-warnings-${p}`)
  // The Export button turns into progress, so focus moves to Stop once the job can be stopped.
  useEffect(() => {
    if (saving && jobId) stopButton.current?.focus()
  }, [saving, jobId])
  const ready = selected.length > 0 && seconds !== null && (!second || (secondDuration !== null && !secondProblem))
  const editSecond = (change: Partial<PlatformTry>) => setSecond((current) => current && { ...current, ...change })

  const save = async () => {
    if (!ready) return
    setError(null)
    setState({ kind: 'saving' })
    try {
      setState({ kind: 'saved', result: await reel.projects.exportPlatforms(slug, version.n, { platforms: selected, caption, coverSeconds, second }) })
    } catch (e) {
      if (errorCode(e) !== 'CANCELLED') setError(userMessage(e))
      setState({ kind: 'choosing' })
    }
  }
  // Pressing play after the end also seeks (to 0); only a scrub while paused picks the cover.
  const pickCover = (v: HTMLVideoElement, set: (seconds: number) => void) => {
    if (!saving && v.paused) set(v.currentTime)
  }
  const useProjectCover = () => {
    setCoverSeconds(null)
    video.current?.load() // shows the cover picture again
  }
  // A frame picked on one video means nothing on another, so a new version starts from its own cover.
  const pickVersion = (n: number) => {
    // The same chip again: its video does not reload, so clearing its duration would leave Export disabled.
    if (n === second?.version) return
    setSecondSeconds(null)
    editSecond({ version: n, coverSeconds: null })
  }
  const moveVersion = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step || !second) return
    e.preventDefault()
    const index = (versions.findIndex((v) => v.n === second.version) + step + versions.length) % versions.length
    pickVersion(versions[index].n)
    e.currentTarget.querySelectorAll<HTMLElement>('[role=radio]')[index]?.focus()
  }
  const useSecondProjectCover = () => {
    editSecond({ coverSeconds: null })
    secondVideo.current?.load()
  }

  return <Modal onClose={saving ? undefined : onClose} wide testid="platform-export-dialog">
    <div ref={body} className="platform-export">
      {phoneFile ? <>
        <h2>Send {platformRule(phoneFile.platform).label}{phoneFile.try ? ` Try ${phoneFile.try}` : ''} to your phone</h2>
        <SendToPhone video={phoneFile.video} caption={phoneFile.caption} onBack={() => setPhoneFile(null)} />
      </> : state.kind === 'saved' ? <>
        <h2 data-testid="export-saved">Saved {state.result.files.length} platform {state.result.files.length === 1 ? 'file' : 'files'}</h2>
        <p className="muted">Your videos, covers and post captions are in Library › Finished videos. Upload them in each platform's own app.</p>
        <SavedFiles files={state.result.files} copied={copied} onCopy={(file) => void reel.app.copyText(file.caption).then(() => setCopied(file.captionFile))} onPhone={setPhoneFile} />
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
                  {warnings.map((w) => <span key={w}>{w}</span>)}
                </span>}
              </span>
            </label>
          })}
        </fieldset>
        {selected.length > 0 && <details className="muted-sm"><summary>Platform details</summary>{PLATFORM_RULES.filter((rule) => selected.includes(rule.id)).map((rule) => <p key={rule.id}>{rule.label}: {rule.note ?? 'The caption includes hashtags.'}</p>)}</details>}
        <label className="field-label" htmlFor="platform-caption">{second ? 'Try 1 post caption and hashtags' : 'Post caption and hashtags'}</label>
        <textarea id="platform-caption" className="textarea" value={caption} onChange={(e) => setCaption(e.target.value)} disabled={saving} aria-describedby={['platform-caption-counts', ...warned(selected)].join(' ')} />
        <p className="muted-sm platform-counts" id="platform-caption-counts">
          {PLATFORM_RULES.map((rule) => {
            if (!selected.includes(rule.id) || rule.captionLimit === null) return null
            const count = captionLength(rule.id, caption)
            return <span key={rule.id} className={count > rule.captionLimit ? 'over' : undefined}>{rule.label} {count}/{rule.captionLimit}</span>
          })}
          <span>This caption does not replace your saved post caption.</span>
        </p>
        <div className="platform-cover">
          <video ref={video} aria-label={second ? 'Try 1 cover frame' : 'Cover frame'} src={version.video} poster={version.cover ?? undefined} muted controls preload="metadata"
            onLoadedMetadata={(e) => setSeconds(e.currentTarget.duration)}
            onSeeked={(e) => pickCover(e.currentTarget, setCoverSeconds)}
            onError={() => setError('The video could not load. Close this dialog and render the version again.')} />
          <div className="stack" style={{ gap: 6 }}>
            <span className="field-label">{second ? 'Try 1 cover' : 'Cover'}</span>
            <p className="muted-sm" data-testid="platform-cover-choice">
              {coverSeconds !== null ? `The frame at ${clock(coverSeconds)}.` : version.cover ? "Your reel's cover." : 'A frame from the first few seconds.'}
              {' '}Move the video's slider to pick a different frame.
            </p>
            {coverSeconds !== null && version.cover && <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={useProjectCover} disabled={saving}>Use my cover</button>}
          </div>
        </div>
        <label className="platform-option">
          <input type="checkbox" checked={second !== null} disabled={saving} data-testid="try-two" aria-describedby={second ? 'try-two-status' : undefined}
            onChange={(e) => setSecond(e.target.checked ? { ...first } : null)} />
          <span>Try two versions<small>Post two versions and keep the one people like. Instagram and Facebook can run the test for you.</small></span>
        </label>
        {second && secondVersion && <fieldset className="platform-try" disabled={saving} data-testid="try-two-panel">
          <legend>Try 2</legend>
          {versions.length > 1
            ? <div className="chips" role="radiogroup" aria-label="Try 2 version" onKeyDown={moveVersion}>
              {versions.map((v) => <button key={v.n} role="radio" aria-checked={v.n === second.version} tabIndex={v.n === second.version ? 0 : -1}
                className={`chip${v.n === second.version ? ' active' : ''}`} onClick={() => pickVersion(v.n)}>Version {v.n}</button>)}
            </div>
            : <p className="muted-sm">To try a different video, first leave a note to make another version.</p>}
          <div className="platform-cover">
            <video ref={secondVideo} aria-label="Try 2 cover frame" src={secondVersion.video} poster={secondVersion.cover ?? undefined} muted controls preload="metadata"
              onLoadedMetadata={(e) => setSecondSeconds(e.currentTarget.duration)}
              onSeeked={(e) => pickCover(e.currentTarget, (at) => editSecond({ coverSeconds: at }))}
              onError={() => setError('The video could not load. Close this dialog and render the version again.')} />
            <div className="stack" style={{ gap: 6 }}>
              <span className="field-label">Cover</span>
              <p className="muted-sm" data-testid="try-two-cover-choice">
                {second.coverSeconds !== null ? `The frame at ${clock(second.coverSeconds)}.` : secondVersion.cover ? "Your reel's cover." : 'A frame from the first few seconds.'}
                {' '}Move the video's slider to pick a different frame.
              </p>
              {second.coverSeconds !== null && secondVersion.cover && <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={useSecondProjectCover}>Use my cover</button>}
            </div>
          </div>
          <label className="field-label" htmlFor="platform-caption-2">Post caption and hashtags</label>
          <textarea id="platform-caption-2" className="textarea" value={second.caption} onChange={(e) => editSecond({ caption: e.target.value })} aria-describedby={['platform-caption-2-counts', 'try-two-status', ...warned(secondPlatforms)].join(' ')} />
          <p className="muted-sm platform-counts" id="platform-caption-2-counts">
            {secondPlatforms.map((platform) => {
              const rule = platformRule(platform)
              if (rule.captionLimit === null) return null
              const count = captionLength(platform, second.caption)
              return <span key={platform} className={count > rule.captionLimit ? 'over' : undefined}>{rule.label} {count}/{rule.captionLimit}</span>
            })}
          </p>
          <p id="try-two-status" role="status" className={secondProblem ? 'platform-errors' : 'muted-sm'} data-testid="try-two-status">
            {secondProblem ?? (tryChanges(first, second, coverClock).length > 1 ? "You changed more than one thing. If Try 2 wins, you won't know which change helped." : null)}
          </p>
        </fieldset>}
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

/** Each platform's files, with its own steps when two versions were exported. */
function SavedFiles({ files, copied, onCopy, onPhone }: {
  files: PlatformFile[]
  copied: string | null
  onCopy: (file: PlatformFile) => void
  onPhone: (file: PlatformFile) => void
}) {
  const two = files.some((f) => f.try)
  const platforms = [...new Set(files.map((f) => f.platform))]
  const firstOnly = platforms.filter((p) => !platformRule(p).tryTwo).map((p) => platformRule(p).label)
  return <>
    <div className="platform-results">
      {platforms.map((platform) => {
        const own = files.filter((f) => f.platform === platform)
        const test = platformRule(platform).tryTwo
        const sharedVideo = own.length === 2 && own[0].video === own[1].video
        return <div className="platform-result" key={platform} data-testid="export-platform">
          <strong>{platformRule(platform).label}</strong>
          {two && test && <p className="muted-sm">
            {own.length === 2 ? `${test.steps}${sharedVideo && test.tests === 'video' ? ' Both use the same video.' : ''}`
              : `${platformRule(platform).label} can test a cover or caption, not a different video, so it gets Try 1 only.`}
          </p>}
          {own.map((file) => {
            const coverOnly = file.try === 2 && sharedVideo
            return <Fragment key={file.captionFile}>
              <p className="muted-sm selectable" data-testid="export-name">{fileName(coverOnly ? file.cover : file.video)}</p>
              <div className="row wrap">
                <button className="btn small" onClick={() => void reel.app.openFolder(coverOnly ? file.cover : file.video)}>Show in {FOLDER_APP}</button>
                {!coverOnly && <button className="btn small" onClick={() => onPhone(file)}>Send to my phone</button>}
                <button className="btn small" onClick={() => onCopy(file)}>{copied === file.captionFile ? 'Copied' : 'Copy caption'}</button>
              </div>
            </Fragment>
          })}
        </div>
      })}
    </div>
    {two && firstOnly.length > 0 && <p className="muted-sm" data-testid="export-first-only">
      {andList(firstOnly)} {firstOnly.length === 1 ? "gets Try 1 only. It can't" : "get Try 1 only. They can't"} test two versions of a post yet, and posting both would show your followers the same reel twice.
    </p>}
  </>
}
