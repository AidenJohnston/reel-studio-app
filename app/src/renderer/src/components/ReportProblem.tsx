import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SupportDraft, SupportPreview } from '../../../shared/api'
import { SUPPORT_EMAIL } from '../../../shared/config'
import { errorCode, reel, userMessage } from '../api'
import { Button, Modal, Spinner } from './ui'
import './report-problem.css'

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

type FormField = 'what' | 'expected' | 'email'
const isFormField = (f: unknown): f is FormField => f === 'what' || f === 'expected' || f === 'email'

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
  const start = useRef(draft)
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
      const field = (e as { field?: string })?.field
      setFieldError({ field, message: userMessage(e) })
      if (isFormField(field)) setFocusField(field)
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
    // The form comes back inside the same Modal, whose autofocus runs only when it opens, and the button that had
    // focus is gone: put the keyboard on the refused field, or on "What happened?".
    setFocusField(isFormField(failed?.field) ? failed.field : 'what')
  }

  const fieldRefs = {
    what: useRef<HTMLTextAreaElement>(null),
    expected: useRef<HTMLTextAreaElement>(null),
    email: useRef<HTMLInputElement>(null)
  }
  const [focusField, setFocusField] = useState<FormField | null>(null)
  useEffect(() => {
    if (step.name !== 'write' || !focusField) return
    fieldRefs[focusField].current?.focus()
    setFocusField(null)
    // fieldRefs is a new object each render but its refs are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, focusField])

  // The failed screen is the review dialog redrawn, so Modal's autofocus (on open only) doesn't run, and the Send
  // button that had focus is gone. Put focus on the way forward: Edit after a refusal, else Try again.
  const leadRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (step.name === 'failed') leadRef.current?.focus()
  }, [step])

  const invalid = (f: string) => (fieldError?.field === f ? true : undefined)

  const kind = step.name === 'write' ? 'write' : step.name === 'sent' ? 'sent' : 'review'
  // false until the first step change: the dialog's own entrance covers the first step
  const swapped = useRef(false)
  const shownKind = useRef(kind)
  if (shownKind.current !== kind) {
    shownKind.current = kind
    swapped.current = true
  }
  const stepBody = useRef<HTMLDivElement>(null)
  // Modal's autofocus runs once, when it opens; a new step's content takes focus here. Write and failed place their
  // own (focusField, leadRef).
  useEffect(() => {
    if (swapped.current && kind !== 'write' && step.name !== 'failed') stepBody.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])
  // a click outside closes the form only while nothing typed or ticked would be lost (Esc still cancels)
  const edited = JSON.stringify(draft) !== JSON.stringify(start.current)

  let body: ReactNode
  if (step.name === 'write') {
    body = (
      <>
        <h2 id="report-title">Report a problem</h2>
        <p className="muted-sm">
          This goes to the Reel Studio team. You'll see exactly what is sent before it goes. For billing, email{' '}
          <span className="selectable">{SUPPORT_EMAIL}</span>.
        </p>
        <label className="rp-field">
          <b>What happened?</b>
          <textarea
            className="textarea"
            rows={5}
            maxLength={CAPS.what}
            value={draft.what}
            onChange={(e) => set('what', e.target.value)}
            placeholder="For example: I clicked Export and it stopped at 80%."
            aria-invalid={invalid('what')}
            ref={fieldRefs.what}
            data-autofocus
            data-testid="report-what"
          />
        </label>
        <label className="rp-field">
          <b>
            What did you expect? <span className="muted-sm">(optional)</span>
          </b>
          <textarea className="textarea" rows={3} maxLength={CAPS.expected} value={draft.expected} onChange={(e) => set('expected', e.target.value)} aria-invalid={invalid('expected')} ref={fieldRefs.expected} data-testid="report-expected" />
        </label>
        <label className="rp-field">
          <b>
            Your email <span className="muted-sm">(optional, so we can write back)</span>
          </b>
          <input className="input" type="email" maxLength={CAPS.email} value={draft.email} onChange={(e) => set('email', e.target.value)} aria-invalid={invalid('email')} ref={fieldRefs.email} data-testid="report-email" />
        </label>
        <div className="rp-ticks">
          <label className="toggle">
            <input type="checkbox" checked={draft.diagnostics} onChange={(e) => set('diagnostics', e.target.checked)} data-testid="report-diagnostics" />
            <span>
              Attach diagnostics: the app version, your computer, how your AI editor answered and the app's recent log. Your
              user name, email addresses and keys are taken out; your videos' file names can still show.
            </span>
          </label>
          <label className="toggle" aria-disabled={!screenshotAvailable || undefined}>
            <input type="checkbox" checked={draft.screenshot} disabled={!screenshotAvailable} onChange={(e) => set('screenshot', e.target.checked)} data-testid="report-screenshot" />
            <span>{screenshotAvailable ? 'Attach a screenshot of the Reel Studio window, as it was when you opened this form.' : 'No screenshot of the window could be taken.'}</span>
          </label>
          {hasKey && (
            <label className="toggle">
              <input type="checkbox" checked={draft.key} onChange={(e) => set('key', e.target.checked)} data-testid="report-key" />
              <span>Include my download key, so the team can see which purchase this is. It names your purchase, not you.</span>
            </label>
          )}
        </div>
        {fieldError && (
          <p className="field-error" role="alert" data-testid="report-field-error">
            {fieldError.message}
          </p>
        )}
        <div className="rp-acts">
          <Button kind="tertiary" onClick={close}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void review()} disabled={busy || !draft.what.trim()} data-testid="report-review">
            {busy ? 'Getting it ready…' : 'Review what will be sent'}
          </Button>
        </div>
      </>
    )
  } else if (step.name === 'sent') {
    body = (
      <>
        <h2 id="report-title">Thanks, your report is in</h2>
        <p>
          Its number is <strong className="selectable" data-testid="report-id">{step.id}</strong>. Quote it if you write to us about this.
        </p>
        <p className="muted-sm">
          {step.email ? `If we need more, we'll write to ${step.email}.` : "You didn't leave an email, so we can't write back, but we read every report."}
        </p>
        <div className="rp-acts">
          <Button kind="primary" onClick={onClose} data-autofocus data-testid="report-done">
            Done
          </Button>
        </div>
      </>
    )
  } else {
    const p = step.preview
    const sending = step.name === 'sending'
    body = (
      <>
        <h2 id="report-title">{step.name === 'failed' ? "The report wasn't sent" : 'This is what will be sent'}</h2>
        {step.name === 'failed' && (
          <div className="banner error" role="alert" data-testid="report-error">
            <span>
              {step.message} You can also email it to <span className="selectable">{SUPPORT_EMAIL}</span>.
            </span>
          </div>
        )}
        <p className="muted-sm">
          It goes to Reel Studio at {p.server}. Nothing else is sent.
        </p>
        <dl className="rp-preview" data-testid="report-preview">
          <div>
            <dt>What happened</dt>
            <dd className="selectable pre">
              {p.what}
            </dd>
          </div>
          {p.expected && (
            <div>
              <dt>What you expected</dt>
              <dd className="selectable pre">
                {p.expected}
              </dd>
            </div>
          )}
          <div>
            <dt>Your email</dt>
            <dd>{p.email ?? 'None'}</dd>
          </div>
          <div>
            <dt>App and computer</dt>
            <dd>
              Reel Studio {p.appVersion}, {p.os}
            </dd>
          </div>
          <div>
            <dt>Download key</dt>
            <dd data-testid="report-preview-key">
              {p.key ? 'Included (names your purchase, not you)' : 'Not included'}
            </dd>
          </div>
          <div>
            <dt>Diagnostics</dt>
            <dd data-testid="report-preview-diagnostics">
              {p.diagnostics ? (
                <details>
                  <summary>Included ({p.diagnostics.length.toLocaleString()} characters). Show them</summary>
                  <pre className="selectable rp-diag">
                    {p.diagnostics}
                  </pre>
                </details>
              ) : (
                'Not included'
              )}
            </dd>
          </div>
          <div>
            <dt>Screenshot</dt>
            <dd data-testid="report-preview-screenshot">
              {p.screenshot ? (
                <>
                  <img className="rp-shot" src={p.screenshot.dataUrl} alt="The screenshot that will be sent" />
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
        <div className="rp-acts">
          {step.name === 'failed' ? (
            <>
              <Button kind="tertiary" onClick={() => void reel.support.copy(p.id).catch(() => {})} data-testid="report-copy">
                Copy the report
              </Button>
              {/* The way that works while sending fails: the address is in the error line above, so the button says what it
                  does. Refused or too large: the same report would fail again, so Edit leads and there is no Try again. */}
              <Button kind="secondary" onClick={() => void reel.support.email(p.id).catch(() => {})} data-testid="report-email-instead">
                Email it instead
              </Button>
              <Button
                kind={NEEDS_EDIT.has(step.code ?? '') ? 'primary' : 'tertiary'}
                onClick={() => edit(NEEDS_EDIT.has(step.code ?? '') ? { message: step.message, field: step.field } : undefined)}
                ref={NEEDS_EDIT.has(step.code ?? '') ? leadRef : undefined}
                data-testid="report-edit"
              >
                Edit the report
              </Button>
              {!NEEDS_EDIT.has(step.code ?? '') && (
                <Button kind="primary" onClick={() => void send(p)} ref={leadRef} data-testid="report-retry">
                  Try again
                </Button>
              )}
            </>
          ) : (
            <>
              <Button kind="tertiary" onClick={() => edit()} disabled={sending} data-testid="report-back">
                Back
              </Button>
              <Button kind="primary" onClick={() => void send(p)} disabled={sending} data-autofocus data-testid="report-send">
                {sending ? (
                  <>
                    <Spinner /> Sending…
                  </>
                ) : (
                  'Send report'
                )}
              </Button>
            </>
          )}
        </div>
      </>
    )
  }

  // One dialog for every step, so the page behind never comes back between them and the width holds; the step's
  // content swaps in with a fade (report-problem.css .rp-step.swap), except the first, which the dialog's own
  // entrance covers.
  return (
    <Modal
      onClose={step.name === 'sending' ? undefined : kind === 'sent' ? onClose : close}
      backdropCloses={kind === 'sent' || (kind === 'write' && !edited)}
      wide
      testid={kind === 'write' ? 'report-problem' : kind === 'sent' ? 'report-sent' : 'report-review-step'}
      labelledBy="report-title"
    >
      <div key={kind} ref={stepBody} className={`rp-step${swapped.current ? ' swap' : ''}`}>
        {body}
      </div>
    </Modal>
  )
}
