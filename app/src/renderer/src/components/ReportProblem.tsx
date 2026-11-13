import { useState } from 'react'
import type { SupportDraft, SupportPreview } from '../../../shared/api'
import { SUPPORT_EMAIL } from '../../../shared/config'
import { errorCode, reel, userMessage } from '../api'
import { Modal, Spinner } from './ui'

/** Fired on window to open "Report a problem"; `detail.context` is an error message to start the report with. App
 * listens, takes the window's screenshot first (so it shows the problem, not the form), then opens the form. */
export const REPORT_PROBLEM_EVENT = 'reel:report-problem'

export function openReportProblem(context?: string): void {
  window.dispatchEvent(new CustomEvent(REPORT_PROBLEM_EVENT, { detail: { context } }))
}

/** The caps the server applies (main/support.ts SUPPORT_CAPS). */
const CAPS = { what: 5000, expected: 3000, email: 254 }

type Step = { name: 'write' } | { name: 'review'; preview: SupportPreview } | { name: 'sending'; preview: SupportPreview } | { name: 'sent'; id: string; email: string | null } | { name: 'failed'; preview: SupportPreview; message: string; code: string | null; field?: string }

/** Failures the same report would hit again: the person has to change it (a field the server refused, or too large). */
const NEEDS_EDIT = new Set(['SUPPORT_FIELD', 'SUPPORT_TOO_BIG'])

const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export function ReportProblem({ context, screenshotAvailable, hasKey, onClose }: { context?: string; screenshotAvailable: boolean; hasKey: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<SupportDraft>({
    what: context ? `\n\nThe app said: ${context}` : '',
    expected: '',
    email: '',
    // Nothing private is attached unless they tick it. The key names a purchase, not a person (main/support.ts).
    diagnostics: false,
    screenshot: false,
    key: hasKey
  })
  const [step, setStep] = useState<Step>({ name: 'write' })
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof SupportDraft>(k: K, v: SupportDraft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const close = () => {
    void reel.support.discard()
    onClose()
  }

  const review = async () => {
    setFieldError(null)
    setBusy(true)
    try {
      setStep({ name: 'review', preview: await reel.support.prepare(draft) })
    } catch (e) {
      setFieldError({ field: (e as { field?: string })?.field, message: userMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const send = async (preview: SupportPreview) => {
    setStep({ name: 'sending', preview })
    try {
      const sent = await reel.support.send(preview.id)
      setStep({ name: 'sent', id: sent.id, email: preview.email })
    } catch (e) {
      if (errorCode(e) === 'SUPPORT_STALE') return void setStep({ name: 'write' })
      setStep({ name: 'failed', preview, message: userMessage(e), code: errorCode(e), field: (e as { field?: string })?.field })
    }
  }

  /** Back to the form with the draft as typed. Sending again needs a fresh review: only prepare() makes a sendable
   * report, so the one that failed can't be resent from the form. A refused field is marked there. */
  const edit = (failed?: { message: string; field?: string }) => {
    setFieldError(failed ?? null)
    setStep({ name: 'write' })
  }

  const invalid = (f: string) => (fieldError?.field === f ? true : undefined)

  if (step.name === 'write') {
    return (
      <Modal onClose={close} wide testid="report-problem" labelledBy="report-title">
        <h2 id="report-title">Report a problem</h2>
        <p className="muted-sm" style={{ margin: 0 }}>
          This goes to the Reel Studio team. You'll see exactly what is sent before it goes. For billing, email{' '}
          <span className="selectable">{SUPPORT_EMAIL}</span>.
        </p>
        <label className="stack" style={{ gap: 6 }}>
          <strong>What happened?</strong>
          <textarea
            className="textarea"
            rows={5}
            maxLength={CAPS.what}
            value={draft.what}
            onChange={(e) => set('what', e.target.value)}
            placeholder="For example: I clicked Export and it stopped at 80%."
            aria-invalid={invalid('what')}
            data-autofocus
            data-testid="report-what"
          />
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <strong>
            What did you expect? <span className="muted-sm">(optional)</span>
          </strong>
          <textarea className="textarea" rows={3} maxLength={CAPS.expected} value={draft.expected} onChange={(e) => set('expected', e.target.value)} aria-invalid={invalid('expected')} data-testid="report-expected" />
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <strong>
            Your email <span className="muted-sm">(optional, so we can write back)</span>
          </strong>
          <input className="input" type="email" maxLength={CAPS.email} value={draft.email} onChange={(e) => set('email', e.target.value)} aria-invalid={invalid('email')} data-testid="report-email" />
        </label>
        <div className="stack" style={{ gap: 8 }}>
          <label className="toggle" style={{ fontWeight: 400, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={draft.diagnostics} onChange={(e) => set('diagnostics', e.target.checked)} data-testid="report-diagnostics" />
            <span>
              Attach diagnostics: the app version, your computer, how your AI editor answered and the app's recent log. Your
              user name, email addresses and keys are taken out; your videos' file names can still show.
            </span>
          </label>
          <label className="toggle" style={{ fontWeight: 400, alignItems: 'flex-start', opacity: screenshotAvailable ? 1 : 0.55 }}>
            <input type="checkbox" checked={draft.screenshot} disabled={!screenshotAvailable} onChange={(e) => set('screenshot', e.target.checked)} data-testid="report-screenshot" />
            <span>{screenshotAvailable ? 'Attach a screenshot of the Reel Studio window, as it was when you opened this form.' : 'No screenshot of the window could be taken.'}</span>
          </label>
          {hasKey && (
            <label className="toggle" style={{ fontWeight: 400, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={draft.key} onChange={(e) => set('key', e.target.checked)} data-testid="report-key" />
              <span>Include my download key, so the team can see which purchase this is. It names your purchase, not you.</span>
            </label>
          )}
        </div>
        {fieldError && (
          <p className="field-error" role="alert" style={{ margin: 0 }} data-testid="report-field-error">
            {fieldError.message}
          </p>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void review()} disabled={busy || !draft.what.trim()} data-testid="report-review">
            {busy ? 'Getting it ready…' : 'Review what will be sent'}
          </button>
        </div>
      </Modal>
    )
  }

  if (step.name === 'sent') {
    return (
      <Modal onClose={onClose} testid="report-sent" labelledBy="report-sent-title">
        <h2 id="report-sent-title">Thanks, your report is in</h2>
        <p style={{ margin: 0 }}>
          Its number is <strong className="selectable" data-testid="report-id">{step.id}</strong>. Quote it if you write to us about this.
        </p>
        <p className="muted-sm" style={{ margin: 0 }}>
          {step.email ? `If we need more, we'll write to ${step.email}.` : "You didn't leave an email, so we can't write back, but we read every report."}
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={onClose} data-autofocus data-testid="report-done">
            Done
          </button>
        </div>
      </Modal>
    )
  }

  const p = step.preview
  const sending = step.name === 'sending'
  return (
    <Modal onClose={sending ? undefined : close} wide testid="report-review-step" labelledBy="report-review-title">
      <h2 id="report-review-title">{step.name === 'failed' ? "The report wasn't sent" : 'This is what will be sent'}</h2>
      {step.name === 'failed' && (
        <div className="banner error" role="alert" data-testid="report-error">
          <span>
            {step.message} You can also email it to <span className="selectable">{SUPPORT_EMAIL}</span>.
          </span>
        </div>
      )}
      <p className="muted-sm" style={{ margin: 0 }}>
        To {p.server}, Reel Studio's server. Nothing else is sent.
      </p>
      <dl className="stack" style={{ gap: 10, margin: 0 }} data-testid="report-preview">
        <div>
          <dt className="muted-sm">What happened</dt>
          <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }} className="selectable">
            {p.what}
          </dd>
        </div>
        {p.expected && (
          <div>
            <dt className="muted-sm">What you expected</dt>
            <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }} className="selectable">
              {p.expected}
            </dd>
          </div>
        )}
        <div>
          <dt className="muted-sm">Your email</dt>
          <dd style={{ margin: 0 }}>{p.email ?? 'None'}</dd>
        </div>
        <div>
          <dt className="muted-sm">App and computer</dt>
          <dd style={{ margin: 0 }}>
            Reel Studio {p.appVersion}, {p.os}
          </dd>
        </div>
        <div>
          <dt className="muted-sm">Download key</dt>
          <dd style={{ margin: 0 }} data-testid="report-preview-key">
            {p.key ? 'Included (names your purchase, not you)' : 'Not included'}
          </dd>
        </div>
        <div>
          <dt className="muted-sm">Diagnostics</dt>
          <dd style={{ margin: 0 }} data-testid="report-preview-diagnostics">
            {p.diagnostics ? (
              <details>
                <summary>Included ({p.diagnostics.length.toLocaleString()} characters). Show them</summary>
                <pre className="selectable" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflow: 'auto', fontSize: 12 }}>
                  {p.diagnostics}
                </pre>
              </details>
            ) : (
              'Not included'
            )}
          </dd>
        </div>
        <div>
          <dt className="muted-sm">Screenshot</dt>
          <dd style={{ margin: 0 }} data-testid="report-preview-screenshot">
            {p.screenshot ? (
              <>
                <img src={p.screenshot.dataUrl} alt="The screenshot that will be sent" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--line, #ddd)', marginTop: 4 }} />
                <div className="muted-sm">
                  {p.screenshot.width} × {p.screenshot.height}, {kb(p.screenshot.bytes)}
                </div>
              </>
            ) : (
              'Not included'
            )}
          </dd>
        </div>
      </dl>
      <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {step.name === 'failed' ? (
          <>
            <button className="btn ghost" onClick={() => void reel.support.copy(p.id).catch(() => {})} data-testid="report-copy">
              Copy the report
            </button>
            <button className="btn ghost" onClick={() => void reel.support.email(p.id).catch(() => {})} data-testid="report-email-instead">
              Email {SUPPORT_EMAIL}
            </button>
            {/* Refused or too large: the same report would fail again, so Edit leads and there is no Try again. */}
            <button
              className={`btn ${NEEDS_EDIT.has(step.code ?? '') ? 'primary' : 'ghost'}`}
              onClick={() => edit(NEEDS_EDIT.has(step.code ?? '') ? { message: step.message, field: step.field } : undefined)}
              data-autofocus={NEEDS_EDIT.has(step.code ?? '') || undefined}
              data-testid="report-edit"
            >
              Edit the report
            </button>
            {!NEEDS_EDIT.has(step.code ?? '') && (
              <button className="btn primary" onClick={() => void send(p)} data-testid="report-retry">
                Try again
              </button>
            )}
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={() => edit()} disabled={sending} data-testid="report-back">
              Back
            </button>
            <button className="btn primary" onClick={() => void send(p)} disabled={sending} data-autofocus data-testid="report-send">
              {sending ? (
                <>
                  <Spinner /> Sending…
                </>
              ) : (
                'Send report'
              )}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
