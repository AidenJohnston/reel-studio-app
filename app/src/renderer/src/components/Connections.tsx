// "Your own AI server" (advanced): connections to an Anthropic- or OpenAI-compatible server the person runs or
// rents, such as a local proxy. Ported from T3 Code's provider instances (AddProviderInstanceDialog,
// ProviderInstanceCard, SecretInput, ProviderModelsSection): an add dialog in three steps, a card per saved
// connection, a key field that never shows the stored key, and "Add custom model".
// Not from T3 Code: saving makes one small request through the connection and, when it fails, says what to fix.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConnectionInfo, ConnectionKind, ProviderInfo, SaveConnectionResult } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Confirm, Modal, MoreMenu, Spinner } from './ui'
import { Icon } from './icons'

const KINDS: { kind: ConnectionKind; label: string; about: string }[] = [
  { kind: 'openai', label: 'OpenAI-compatible', about: "For servers that work like ChatGPT's. Most local AI servers and proxies work this way." },
  { kind: 'anthropic', label: 'Anthropic-compatible', about: "For servers that work like Claude's, such as a Claude proxy." }
]
const ADDRESS_EXAMPLE: Record<ConnectionKind, string> = { openai: 'http://127.0.0.1:4000/v1', anthropic: 'http://127.0.0.1:4000' }
const ADDRESS_HELP: Record<ConnectionKind, string> = {
  openai: 'Usually ends in /v1.',
  anthropic: 'Usually without /v1 at the end.'
}
const STEPS = ['Server', 'Name', 'Details'] as const
type Field = NonNullable<NonNullable<SaveConnectionResult['error']>['field']>

/** The saved connections and "Add a connection". `onConnected` runs when one is saved or picked. */
export function Connections({ onConnected }: { onConnected: (p: ProviderInfo) => void }) {
  const [list, setList] = useState<ConnectionInfo[] | null>(null)
  const [editing, setEditing] = useState<ConnectionInfo | 'new' | null>(null)
  const [removing, setRemoving] = useState<ConnectionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    reel.ai
      .connections()
      .then(setList)
      .catch(() => setList([]))
  useEffect(() => {
    void load()
  }, [])

  const use = async (c: ConnectionInfo) => {
    setError(null)
    try {
      await reel.ai.setActive('custom', c.id)
      await load()
      onConnected(await reel.ai.active())
    } catch (e) {
      setError(userMessage(e))
    }
  }
  const remove = async (c: ConnectionInfo) => {
    setRemoving(null)
    try {
      await reel.ai.removeConnection(c.id)
    } catch (e) {
      setError(userMessage(e))
    }
    await load()
  }

  return (
    <section className="conn-block" aria-labelledby="conn-title" data-testid="connections">
      <h3 id="conn-title">Your own AI server</h3>
      <p className="muted-sm">For people who run or rent an AI server that works like Claude's or ChatGPT's.</p>
      {!!list?.length && (
        <ul className="conn-list">
          {list.map((c) => (
            <li key={c.id} className={`conn-card${c.active ? ' active' : ''}`} data-testid="connection-card">
              <span className="conn-icon" aria-hidden>
                <Icon name="server" />
              </span>
              <div className="conn-main">
                <div className="conn-name">
                  <span className="conn-label">{c.label}</span>
                  {c.active && <span className="badge ready">In use</span>}
                </div>
                <div className="conn-model" title={c.model} data-testid="connection-card-model">
                  Model: {c.model}
                </div>
                <div className="conn-meta" title={c.baseURL}>
                  {KINDS.find((k) => k.kind === c.kind)?.label} · {c.baseURL}
                </div>
                <div className="conn-meta">{c.hasKey ? 'Key stored separately, encrypted on this computer.' : 'No key.'}</div>
              </div>
              {!c.active && (
                <button className="btn small" onClick={() => void use(c)} data-testid="connection-use">
                  Use this
                </button>
              )}
              <MoreMenu
                label={`More for ${c.label}`}
                items={[
                  { label: 'Edit…', run: () => setEditing(c), testid: 'connection-edit' },
                  { label: 'Remove…', run: () => setRemoving(c), danger: true, testid: 'connection-remove' }
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      <button className="btn small conn-add" onClick={() => setEditing('new')} data-testid="connection-add">
        <Icon name="plus" size={16} /> Add a connection
      </button>
      {error && <div className="banner error">{error}</div>}
      {editing && (
        <ConnectionDialog
          editing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(status) => {
            setEditing(null)
            void load()
            onConnected(status)
          }}
        />
      )}
      {removing && (
        <Confirm
          title={`Remove ${removing.label}?`}
          body={`Reel Studio forgets this server and its key.${removing.active ? ' Your videos are edited without AI until you connect one again.' : ''}`}
          yes="Remove"
          no="Keep it"
          danger
          onYes={() => void remove(removing)}
          onNo={() => setRemoving(null)}
        />
      )}
    </section>
  )
}

/** Add (three steps: Server, Name, Details) or edit (opens at Details) one connection. */
export function ConnectionDialog({ editing, onClose, onSaved }: { editing: ConnectionInfo | null; onClose: () => void; onSaved: (p: ProviderInfo) => void }) {
  const [step, setStep] = useState(editing ? 2 : 0)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const [kind, setKind] = useState<ConnectionKind>(editing?.kind ?? 'openai')
  const [label, setLabel] = useState(editing?.label ?? 'My server')
  const [baseURL, setBaseURL] = useState(editing?.baseURL ?? '')
  const [key, setKey] = useState('')
  const [model, setModel] = useState(editing?.model ?? '')
  const [models, setModels] = useState<string[] | null>(null)
  // the model Reel Studio prefers among the server's (ai/src/providers/connection.ts PREFERRED_MODELS), or null
  const [suggested, setSuggested] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  const [customModel, setCustomModel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field?: Field } | null>(null)
  const fields = useRef<Partial<Record<Field, HTMLInputElement | HTMLSelectElement | null>>>({})
  const lookedUp = useRef('')
  // the model as typed right now: a lookup that answers late must not replace it
  const modelNow = useRef(model)
  modelNow.current = model
  const panel = useRef<HTMLDivElement>(null)
  const storedKey = !!editing?.hasKey && sameOrigin(editing.baseURL, baseURL)

  // A new step: focus its first control (the Modal only focuses on open). The suggested name is selected, so typing
  // replaces it.
  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>('input:checked, input, select')
    first?.focus()
    if (first?.id === 'conn-label') (first as HTMLInputElement).select()
  }, [step])

  const lookForModels = async () => {
    const q = `${kind} ${baseURL.trim()} ${key.trim()}`
    if (!/^https?:\/\/\S+/.test(baseURL.trim()) || lookedUp.current === q) return
    lookedUp.current = q
    setLooking(true)
    try {
      const found = await reel.ai.connectionModels({ kind, baseURL: baseURL.trim(), key: key.trim() || undefined, id: editing?.id })
      if (lookedUp.current !== q) return
      setModels(found.models)
      setSuggested(found.suggested)
      // never the first one listed: server order says nothing about quality. No known model: the person picks.
      if (found.suggested && !modelNow.current.trim()) setModel(found.suggested)
    } catch {
      setModels([])
    } finally {
      setLooking(false)
    }
  }
  // editing: look up the saved address's models once, on open
  useEffect(() => {
    if (editing) void lookForModels()
  }, [])

  const showError = (text: string, field?: Field) => {
    setError({ text, field })
    if (field === 'label' && step !== 1) {
      setDir('back')
      setStep(1)
    } else if (field) requestAnimationFrame(() => fields.current[field]?.focus())
  }

  const go = (to: number) => {
    if (busy || to === step) return
    // forward past Name needs a name (T3 Code blocks moving past Identity the same way)
    if (to > 1 && step <= 1 && !label.trim()) {
      setDir('fwd')
      setStep(1)
      setError({ text: 'Enter a name for this connection.', field: 'label' })
      return
    }
    setError((e) => (e?.field === 'label' && label.trim() ? null : e))
    setDir(to > step ? 'fwd' : 'back')
    setStep(to)
  }

  const save = async () => {
    if (busy) return
    if (!baseURL.trim()) return showError('Enter the server address.', 'address')
    if (!model.trim()) return showError(models?.length && !customModel ? 'Pick a model from the list.' : 'Enter a model name.', 'model')
    setBusy(true)
    setError(null)
    try {
      const r = await reel.ai.saveConnection({ ...(editing ? { id: editing.id } : {}), label: label.trim(), kind, baseURL: baseURL.trim(), model: model.trim(), key: key.trim() })
      if (r.error) showError(r.error.userMessage, r.error.field)
      else onSaved(r.status)
    } catch (e) {
      showError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const invalid = (f: Field) => error?.field === f
  // editing the field that was wrong clears the error (T3 Code's custom model input does the same)
  const change = (f: Field, set: (v: string) => void) => (v: string) => {
    set(v)
    if (error?.field === f) setError(null)
  }
  const describedBy = (f: Field, help: string) => (invalid(f) ? `${help} conn-error` : help)
  const modelList = !customModel && !!models?.length

  const stepBody: ReactNode[] = [
    <fieldset key="server" className="conn-fieldset">
      <legend className="field-label">Kind of server</legend>
      {KINDS.map((k) => (
        <label key={k.kind} className={`radio conn-kind${kind === k.kind ? ' on' : ''}`}>
          <input
            type="radio"
            name="conn-kind"
            checked={kind === k.kind}
            onChange={() => {
              setKind(k.kind)
              setModels(null)
              lookedUp.current = ''
            }}
            data-testid={`connection-kind-${k.kind}`}
          />
          <span>
            <span className="conn-kind-title">{k.label}</span>
            <span className="muted-sm">{k.about}</span>
          </span>
        </label>
      ))}
    </fieldset>,
    <div key="name" className="field">
      <label className="field-label" htmlFor="conn-label">
        Name
      </label>
      <input
        id="conn-label"
        ref={(el) => {
          fields.current.label = el
        }}
        className="input"
        placeholder="e.g. Work"
        value={label}
        maxLength={60}
        aria-invalid={invalid('label')}
        aria-describedby={describedBy('label', 'conn-label-help')}
        onChange={(e) => change('label', setLabel)(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go(2)}
        data-testid="connection-label"
      />
      <p id="conn-label-help" className="muted-sm">
        Shown in Reel Studio while this server is your AI editor.
      </p>
    </div>,
    <div key="details" className="stack conn-details">
      <div className="field">
        <label className="field-label" htmlFor="conn-address">
          Server address
        </label>
        <input
          id="conn-address"
          ref={(el) => {
            fields.current.address = el
          }}
          className="input"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder={ADDRESS_EXAMPLE[kind]}
          value={baseURL}
          aria-invalid={invalid('address')}
          aria-describedby={describedBy('address', 'conn-address-help')}
          onChange={(e) => change('address', setBaseURL)(e.target.value)}
          onBlur={() => void lookForModels()}
          data-testid="connection-address"
        />
        <p id="conn-address-help" className="muted-sm">
          {ADDRESS_HELP[kind]}
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="conn-key">
          Key
        </label>
        <input
          id="conn-key"
          ref={(el) => {
            fields.current.key = el
          }}
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={storedKey ? 'Stored key. Enter a new one to replace it.' : kind === 'openai' ? 'Paste the key, if your server needs one' : 'Paste the key'}
          value={key}
          aria-invalid={invalid('key')}
          aria-describedby={describedBy('key', 'conn-key-help')}
          onChange={(e) => change('key', setKey)(e.target.value)}
          onBlur={() => void lookForModels()}
          data-testid="connection-key"
        />
        <p id="conn-key-help" className="muted-sm">
          Stored separately, encrypted on this computer, and never shown again.
        </p>
      </div>
      <div className="field">
        <div className="row conn-model-head">
          <label className="field-label" htmlFor="conn-model">
            Model
          </label>
          {looking && (
            <span className="muted-sm row conn-looking" role="status">
              <Spinner /> Looking for models…
            </span>
          )}
          <span className="spacer" />
          {modelList && (
            <button
              type="button"
              className="link inline"
              onClick={() => {
                setCustomModel(true)
                setModel('')
                requestAnimationFrame(() => fields.current.model?.focus())
              }}
              data-testid="connection-custom-model"
            >
              Add custom model
            </button>
          )}
        </div>
        {modelList ? (
          <select
            id="conn-model"
            ref={(el) => {
              fields.current.model = el
            }}
            className="input"
            value={models!.includes(model) ? model : ''}
            aria-invalid={invalid('model')}
            aria-describedby={describedBy('model', 'conn-model-help')}
            onChange={(e) => change('model', setModel)(e.target.value)}
            data-testid="connection-model-list"
          >
            {!models!.includes(model) && <option value="">Pick a model</option>}
            {models!.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            id="conn-model"
            ref={(el) => {
              fields.current.model = el
            }}
            className="input"
            spellCheck={false}
            autoComplete="off"
            placeholder="The model's name on your server"
            value={model}
            aria-invalid={invalid('model')}
            aria-describedby={describedBy('model', 'conn-model-help')}
            onChange={(e) => change('model', setModel)(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            data-testid="connection-model"
          />
        )}
        <p id="conn-model-help" className="muted-sm" data-testid="connection-model-help">
          {modelList
            ? model && model === suggested
              ? 'Suggested: the newest model Reel Studio knows on this server.'
              : "Pick the newest, largest model. The first one listed is often an old, small one."
            : models && !models.length
              ? "No models reported by this server yet. Type the model's name."
              : "Type the model's name, or fill in the address to pick from a list."}
        </p>
      </div>
    </div>
  ]

  const last = step === STEPS.length - 1
  return (
    <Modal wide onClose={busy ? undefined : onClose} testid="connection-dialog" labelledBy="conn-dialog-title">
      <div className="conn-dialog-head">
        <h2 id="conn-dialog-title">{editing ? `Edit ${editing.label}` : 'Add a connection'}</h2>
        <p className="muted">Connect Reel Studio's AI editor to your own AI server.</p>
      </div>
      <ol className="wizard-steps" aria-label="Steps">
        {STEPS.map((name, i) => (
          <li key={name}>
            <button
              type="button"
              className={`wizard-step${i < step ? ' done' : ''}`}
              aria-current={i === step ? 'step' : undefined}
              aria-label={`${name}, step ${i + 1} of ${STEPS.length}${i < step ? ', done' : ''}`}
              disabled={busy}
              onClick={() => go(i)}
              data-testid={`connection-step-${i}`}
            >
              <span className="wizard-num" aria-hidden>
                {i < step ? <Icon name="check" size={13} stroke={2.5} /> : i + 1}
              </span>
              {name}
            </button>
          </li>
        ))}
      </ol>
      <div ref={panel} key={step} className="wizard-panel" data-dir={dir}>
        {stepBody[step]}
      </div>
      {error && (
        <div className="banner error conn-error" id="conn-error" role="alert" data-testid="connection-error">
          <span>{error.text}</span>
        </div>
      )}
      <div className="row conn-foot">
        <button className="btn ghost" onClick={() => (step === 0 || editing ? onClose() : go(step - 1))} disabled={busy} data-testid="connection-back">
          {step === 0 || editing ? 'Cancel' : 'Back'}
        </button>
        <span className="spacer" />
        {busy && <span className="muted-sm">Sending one short message to check it works.</span>}
        {last ? (
          <button className="btn primary" onClick={() => void save()} disabled={busy} data-testid="connection-save">
            {busy ? (
              <>
                <Spinner /> Checking…
              </>
            ) : editing ? (
              'Save'
            ) : (
              'Add connection'
            )}
          </button>
        ) : (
          <button className="btn primary" onClick={() => go(step + 1)} data-testid="connection-next">
            Next
          </button>
        )}
      </div>
    </Modal>
  )
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b.trim()).origin
  } catch {
    return false
  }
}
