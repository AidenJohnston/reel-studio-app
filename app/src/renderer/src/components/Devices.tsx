// Settings > Phone and browser: the switch, pairing a phone by its camera, and the paired list (main/companion-ipc.ts).
import { useEffect, useMemo, useState } from 'react'
import type { DevicesStatus, PairedDevice } from '../../../shared/api'
import { qrSvg } from '../../../shared/qr'
import { niceDate, reel, userMessage } from '../api'
import { useNotify } from '../App'
import { Button, Confirm, Modal, Spinner } from './ui'
import { SettingRow, Switch, useShown } from './settings-rows'
import './SendToPhone.css'
import './devices.css'

export function useDevices(): [DevicesStatus | null, (s: DevicesStatus) => void] {
  const [s, setS] = useState<DevicesStatus | null>(null)
  useEffect(() => {
    let live = true
    reel.devices.status().then((v) => live && setS(v), () => {})
    const off = reel.devices.onChange((v) => live && setS(v))
    return () => {
      live = false
      off()
    }
  }, [])
  return [s, setS]
}

const what = (d: PairedDevice): string => (d.scopes.includes('note') ? 'watches and sends notes' : 'watches only')

export function DevicesRows() {
  const notify = useNotify()
  const [s, setS] = useDevices()
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [removing, setRemoving] = useState<PairedDevice | null>(null)
  const shownList = useShown('paired-devices')

  const run = async (fn: () => Promise<DevicesStatus>): Promise<void> => {
    setBusy(true)
    try {
      setS(await fn())
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!s) return <SettingRow id="phone-browser" control={<Spinner />} />
  return (
    <>
      <SettingRow
        id="phone-browser"
        line="Watch versions, save them and leave notes from a phone or browser on the same Wi-Fi, while this computer is awake and Reel Studio is open."
        control={<Switch on={s.on} disabled={busy} labelledBy="set-phone-browser" onToggle={() => void run(() => reel.devices.setOn(!s.on))} testid="devices-on" />}
      >
        {s.on && s.problem && (
          <p className="pv-note error srow-more" role="alert" data-testid="devices-problem">
            {s.problem}
          </p>
        )}
        <div className="srow-more row devices-actions">
          <Button size="small" disabled={busy} onClick={() => void run(() => reel.devices.pair('phone', true)).then(() => setPairing(true))} data-testid="devices-pair">
            Pair a phone
          </Button>
          <Button size="small" kind="tertiary" disabled={busy} onClick={() => void run(() => reel.devices.openInBrowser(true))} data-testid="devices-browser">
            Open in a browser here
          </Button>
          {s.address && (
            <span className="muted-sm" data-testid="devices-address">
              At {s.address}
            </span>
          )}
        </div>
      </SettingRow>
      {shownList && (
        <SettingRow id="paired-devices" line={s.devices.length ? undefined : 'No phones or browsers yet.'}>
          {s.devices.length > 0 && (
            <ul className="devices-list" data-testid="devices-list">
              {s.devices.map((d) => (
                <li key={d.id} data-testid="device-row">
                  <div>
                    <b>{d.name}</b>
                    <span className="muted-sm">
                      {d.kind === 'phone' ? 'Phone' : 'Browser'}, {what(d)}. Last used {niceDate(new Date(d.lastSeenAt).toISOString())}.
                    </span>
                  </div>
                  <Button size="small" kind="tertiary" onClick={() => setRemoving(d)} data-testid="device-remove">
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingRow>
      )}
      {pairing && <PairSheet status={s} onStatus={setS} onClose={() => setPairing(false)} />}
      {removing && (
        <Confirm
          title={`Remove ${removing.name}?`}
          body="It stops working at once. Videos it already saved stay on it. To use it again, pair it again."
          yes="Remove"
          no="Keep"
          danger
          onYes={() => {
            const id = removing.id
            setRemoving(null)
            void run(() => reel.devices.remove(id))
          }}
          onNo={() => setRemoving(null)}
        />
      )}
    </>
  )
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The pairing sheet: the code to scan, what the phone will be able to do, and when the code stops working. */
function PairSheet({ status, onStatus, onClose }: { status: DevicesStatus; onStatus: (s: DevicesStatus) => void; onClose: () => void }) {
  const notify = useNotify()
  const [notes, setNotes] = useState(status.pairing?.notes ?? true)
  const [now, setNow] = useState(Date.now())
  // The devices there were when the sheet opened: a new one means this code was used.
  const [before] = useState(() => new Set(status.devices.map((d) => d.id)))
  const paired = status.devices.find((d) => !before.has(d.id)) ?? null
  const url = status.pairing?.kind === 'phone' ? status.pairing.url : null
  const qr = useMemo(() => (url ? qrSvg(url) : null), [url])
  const left = status.pairing ? status.pairing.expiresAt - now : 0

  useEffect(() => {
    if (!url) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [url])

  const renew = async (withNotes: boolean): Promise<void> => {
    try {
      onStatus(await reel.devices.pair('phone', withNotes))
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }
  const close = (): void => {
    if (!paired) void reel.devices.cancelPair().then(onStatus, () => {})
    onClose()
  }

  return (
    <Modal onClose={close} labelledBy="pair-h" testid="pair-sheet">
      <div className="send-phone pair-sheet">
        <h3 id="pair-h">{paired ? `${paired.name} is paired` : 'Pair a phone'}</h3>
        {paired ? (
          <p className="phone-sent" role="status" data-testid="pair-done">
            Open the page on {paired.name} any time this computer is awake and Reel Studio is open. Bookmark it or add it to the Home Screen.
          </p>
        ) : status.problem ? (
          <p className="pv-note error" role="alert">
            {status.problem}
          </p>
        ) : (
          <div className="phone-main">
            <div className="phone-qr-box">
              {qr && left > 0 ? (
                <svg className="phone-qr" viewBox={`0 0 ${qr.side} ${qr.side}`} shapeRendering="crispEdges" role="img" aria-label="Pairing code for your phone's camera" data-testid="pair-qr" data-url={url}>
                  <path d={qr.path} fill="#000" />
                </svg>
              ) : (
                <Button size="small" onClick={() => void renew(notes)} data-testid="pair-renew">
                  Make a new code
                </Button>
              )}
            </div>
            <div className="pair-text">
              <p className="phone-lead">Scan this with your phone's camera, on the same Wi-Fi as this computer.</p>
              <p className="muted-sm">
                Your phone can watch every version, save one to Photos{notes ? ', and leave notes that start edits here' : ''}. It works while this computer is
                awake and Reel Studio is open.
              </p>
              <label className="row pair-notes">
                <input
                  type="checkbox"
                  checked={notes}
                  onChange={(e) => {
                    setNotes(e.target.checked)
                    void renew(e.target.checked)
                  }}
                  data-testid="pair-notes"
                />
                Let it send notes (a note can use your AI editor's plan)
              </label>
              <p className="muted-sm" aria-live="off" data-testid="pair-left">
                {left > 0 ? `The code works once, for ${clock(left)}.` : 'The code has stopped working.'}
              </p>
            </div>
          </div>
        )}
        {!paired && (
          <p className="muted-sm pair-privacy">
            Your phone and this computer talk over your Wi-Fi without encryption, like Send to my phone. On home Wi-Fi that means people in your home could see
            what's sent; on shared Wi-Fi, turn Phone and browser off.
          </p>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button kind={paired ? 'primary' : 'tertiary'} onClick={close} data-autofocus data-testid="pair-close">
            {paired ? 'Done' : 'Cancel'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
