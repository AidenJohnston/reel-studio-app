// "Send to my phone": the finished video is on the computer, Instagram is on the phone. A QR code opens
// the video on the phone (over the home Wi-Fi, from a temporary link only this video answers on), and
// if the phone cannot reach it (school, work and hotel Wi-Fi often block it), plain fallbacks, best first:
// AirDrop on a Mac, iCloud/Google Drive, email, a cable (order in shared/phone-help.ts).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PhoneShare } from '../../../shared/api'
import { fallbackOrder, PHONE_HELP, waitForPhone, type PhoneFallback } from '../../../shared/phone-help'
import { qrSvg } from '../../../shared/qr'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { FOLDER_APP, IS_MAC, Spinner } from './ui'
import './SendToPhone.css'

const ICLOUD_URL = 'https://www.icloud.com/iclouddrive/'
const GDRIVE_URL = 'https://drive.google.com/drive/my-drive'
const EMAIL_LIMIT = 20_000_000

// Lucide (ISC), like components/icons.tsx; kept here so the shared icon set stays as it is.
const G: Record<string, ReactNode> = {
  phone: (
    <>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </>
  ),
  mail: (
    <>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  cable: (
    <>
      <path d="M17 21v-2a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1" />
      <path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" />
      <path d="M21 21v-2h-4" />
      <path d="M3 5h4V3" />
      <path d="M7 5a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1V3" />
    </>
  ),
  wifi: (
    <>
      <path d="M12 20h.01" />
      <path d="M2 8.82a15 15 0 0 1 20 0" />
      <path d="M5 12.859a10 10 0 0 1 14 0" />
      <path d="M8.5 16.429a5 5 0 0 1 7 0" />
    </>
  )
}

function Glyph({ name, size = 18 }: { name: keyof typeof G; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {G[name]}
    </svg>
  )
}

function Qr({ url }: { url: string }) {
  const { path, side } = useMemo(() => qrSvg(url), [url])
  return (
    <svg className="phone-qr" viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" role="img" aria-label="QR code for your phone's camera" data-testid="phone-qr" data-url={url}>
      <rect width={side} height={side} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

const mb = (n: number): string => `${Math.max(1, Math.round(n / 1_000_000))} MB`

export function SendToPhone({ video, caption, onBack }: { video: string; caption: string; onBack: () => void }) {
  const [share, setShare] = useState<PhoneShare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [help, setHelp] = useState(false)
  const [emailed, setEmailed] = useState(false)
  const [address, setAddress] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const sentRef = useRef(false)
  const mounted = useRef(true)
  // macOS asks once whether Reel Studio may use the local network, when the first link opens. It has no API that
  // says what the person answered, so the only thing known is whether a link has opened before (settings
  // phoneNetworkAsked). Until then, say what is coming and wait for Continue. A "no" shows up as a phone that
  // cannot connect; the help below then says where to turn it on.
  const [explain, setExplain] = useState<boolean | null>(IS_MAC ? null : false)
  useEffect(() => {
    if (!IS_MAC) return
    reel.perm
      .status()
      .then((st) => setExplain(st.network === 'not-asked'))
      .catch(() => setExplain(false))
  }, [])
  // Keyboard focus follows: onto Continue when the note appears, onto Done once the code is showing.
  const continueRef = useRef<HTMLButtonElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const explained = useRef(false)
  useEffect(() => {
    if (explain) {
      explained.current = true
      continueRef.current?.focus()
    } else if (explain === false && explained.current) doneRef.current?.focus()
  }, [explain])

  // Open the link (again, on another network or after it ran out); always close it when the panel goes.
  useEffect(() => {
    if (explain !== false) return
    let live = true
    setShare(null)
    setError(null)
    setStopped(false)
    reel.phone
      .start(video, caption, address)
      .then((s) => {
        if (live) setShare(s)
        else if (!mounted.current) void reel.phone.stop() // closed while the link was opening
      })
      .catch((e) => {
        if (!live) return
        setError(userMessage(e))
        setHelp(true)
      })
    return () => {
      live = false
    }
  }, [video, address, attempt, explain]) // eslint-disable-line react-hooks/exhaustive-deps -- caption is read once per link
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void reel.phone.stop()
    }
  }, [])

  useEffect(
    () =>
      reel.phone.onEvent((e) => {
        if (e.kind === 'page' || e.kind === 'video') {
          sentRef.current = true
          setSent(true)
        } else if (e.kind === 'stopped' && e.reason === 'timeout') setStopped(true)
      }),
    []
  )

  // No visit ~20 seconds after the code appeared: the phone probably cannot reach this computer (school,
  // work and hotel Wi-Fi). Cancelled when the phone opens the page, the link stops, a new code is made
  // (share goes back to null) or the panel closes, so it never sets state after unmount.
  useEffect(() => {
    if (!share || sent || stopped) return
    return waitForPhone(share.waitMs, () => {
      if (!sentRef.current && mounted.current) setHelp(true)
    })
  }, [share, sent, stopped])

  const others = share?.addresses ?? []
  const big = (share?.size ?? 0) > EMAIL_LIMIT

  // The other ways, rendered in fallbackOrder(): AirDrop first on a Mac, a drive first on Windows.
  const ways: Record<PhoneFallback, ReactNode> = {
    airdrop: (
      <div className="phone-way">
        <Glyph name="phone" />
        <div>
          <b>AirDrop</b> (iPhone or iPad near this Mac)
          <p className="muted-sm">Click Share, choose AirDrop, then pick your phone. Tap Accept on the phone.</p>
        </div>
        <button className="btn small" onClick={() => void reel.phone.shareSheet(video)} data-testid="phone-airdrop">
          Share
        </button>
      </div>
    ),
    cloud: (
      <div className="phone-way">
        <Glyph name="cloud" />
        <div>
          <b>Put it in iCloud Drive or Google Drive</b>
          <p className="muted-sm">
            Upload the video at icloud.com/iclouddrive or drive.google.com (the buttons open them). Then open the Files app (iPhone) or Drive app (Android) on your phone and save it from there.
          </p>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <a className="btn small" href={ICLOUD_URL} target="_blank" rel="noreferrer" data-testid="phone-icloud">
            iCloud Drive
          </a>
          <a className="btn small" href={GDRIVE_URL} target="_blank" rel="noreferrer" data-testid="phone-gdrive">
            Google Drive
          </a>
        </div>
      </div>
    ),
    email: (
      <div className="phone-way">
        <Glyph name="mail" />
        <div>
          <b>Email it to yourself</b>
          <p className="muted-sm">
            I'll start an email and open {FOLDER_APP} with your video. Drag the video into the email, send it to yourself, then open it on your phone.
            {share && (big ? ` Your video is ${mb(share.size)}, which is probably too big for email (most allow about 20 MB). Use iCloud Drive or Google Drive instead.` : ` Your video is ${mb(share.size)}.`)}
          </p>
          {emailed && (
            <p className="muted-sm" data-testid="phone-emailed">
              Your email app should be open now.
            </p>
          )}
        </div>
        <button
          className="btn small"
          onClick={async () => {
            await reel.phone.emailSelf(video)
            setEmailed(true)
          }}
          data-testid="phone-email"
        >
          Email
        </button>
      </div>
    ),
    cable: (
      <div className="phone-way">
        <Glyph name="cable" />
        <div>
          <b>Use a cable</b>
          <p className="muted-sm">
            <b>Android:</b> plug the phone in, unlock it, choose "File transfer", then drag the video into its Movies folder.
            <br />
            <b>iPhone:</b> a cable is the hard way. iCloud Drive or email is quicker.
          </p>
        </div>
      </div>
    )
  }

  const head = (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <h2>Send to my phone</h2>
      <button className="btn ghost small" onClick={onBack} data-testid="phone-back">
        <Icon name="back" size={16} /> Back
      </button>
    </div>
  )

  if (explain !== false) {
    return (
      <div className="stack send-phone" data-testid="send-to-phone">
        {head}
        {explain && (
          <>
            <div className="phone-ask" data-testid="phone-network-note">
              <span className="phone-ask-icon" aria-hidden>
                <Glyph name="wifi" size={22} />
              </span>
              <div className="stack" style={{ gap: 6 }}>
                <h3>Your Mac will ask one question</h3>
                <p className="muted">
                  Your phone gets the video from this computer over your Wi-Fi. Your Mac will ask if Reel Studio may find devices on your local network.
                  Choose <b>Allow</b>.
                </p>
                <p className="muted-sm">Reel Studio only uses it while this screen is open.</p>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={onBack}>
                Not now
              </button>
              <button ref={continueRef} className="btn primary" onClick={() => setExplain(false)} data-testid="phone-network-continue">
                Continue
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="stack send-phone" data-testid="send-to-phone">
      {head}

      {!error && (
        <div className="phone-main">
          <div className="phone-qr-box">
            {share && !stopped ? (
              <Qr url={share.url} />
            ) : (
              <div className="phone-qr-wait">{stopped ? null : <Spinner />}</div>
            )}
          </div>
          <div className="stack" style={{ gap: 10, minWidth: 0 }}>
            <p className="phone-lead" data-testid="phone-lead">
              Point your phone's camera at this code. Your video opens on your phone; tap Share, then Save Video (or open Instagram).
            </p>
            <p className="muted-sm row" style={{ gap: 6 }}>
              <Glyph name="wifi" size={16} /> Your phone needs to be on the same Wi-Fi as this computer.
            </p>
            {!IS_MAC && !sent && (
              <p className="phone-note" data-testid="firewall-note">
                If Windows asks whether Reel Studio may use the network, click <b>Allow</b>. That lets your phone reach this computer.
              </p>
            )}
            {stopped ? (
              <div className="row wrap">
                <span className="muted">This code stopped working after 15 minutes, to keep your video private.</span>
                <button className="btn small" onClick={() => setAttempt((n) => n + 1)} data-testid="phone-renew">
                  Make a new code
                </button>
              </div>
            ) : sent ? (
              <p className="phone-sent" data-testid="phone-sent" role="status">
                <Icon name="check" size={18} /> Sent! Check your phone.
              </p>
            ) : (
              <p className="muted row" style={{ gap: 8 }} data-testid="phone-waiting" role="status">
                {share && <Spinner />} {share ? 'Waiting for your phone…' : 'Getting the code ready…'}
              </p>
            )}
          </div>
        </div>
      )}

      {!error && (
        // iPhone first; Android folded away so an iPhone owner reads only their steps (grandma3 #18).
        <div className="phone-steps" data-testid="phone-steps">
          <div>
            <h3>
              <Glyph name="phone" size={16} /> iPhone or iPad
            </h3>
            <ol>
              <li>Open the Camera and point it at the code.</li>
              <li>Tap the link that appears at the top of the camera.</li>
              <li>Your phone then shows you how to save the video to Photos.</li>
            </ol>
          </div>
          <details className="phone-more" data-testid="phone-android">
            <summary>Android phone?</summary>
            <ol>
              <li>Open the Camera (or Google Lens) and point it at the code.</li>
              <li>Tap the link that appears.</li>
              <li>Tap Save video. It goes to your Gallery.</li>
            </ol>
          </details>
        </div>
      )}

      {error && (
        <p className="phone-note" data-testid="phone-error">
          {error}
        </p>
      )}

      {others.length > 1 && (
        <details className="phone-more" data-testid="phone-networks">
          <summary>Use a different network</summary>
          <p className="muted-sm">If your phone can't open the code, this computer may have more than one network. Try another one:</p>
          <div className="stack" style={{ gap: 6 }}>
            {others.map((a) => (
              <label key={a.address} className="row phone-net">
                <input type="radio" name="phone-net" checked={a.address === share?.address} onChange={() => setAddress(a.address)} />
                <span>
                  {a.label}
                  {!a.likely && <span className="muted-sm"> (probably not your Wi-Fi)</span>}
                </span>
              </label>
            ))}
          </div>
        </details>
      )}

      {!help && !error && (
        <button className="link left" onClick={() => setHelp(true)} data-testid="phone-cant">
          Phone can't open it?
        </button>
      )}

      {help && (
        <div className="phone-fallbacks" data-testid="phone-fallbacks">
          {sent || error ? (
            <h3>{PHONE_HELP.other}</h3>
          ) : (
            // The Wi-Fi reason is only true while the page has not opened; once it has, only the heading stays.
            <div>
              <h3>{PHONE_HELP.title}</h3>
              <p className="muted-sm" data-testid="phone-why">
                {PHONE_HELP.why}
              </p>
            </div>
          )}
          {IS_MAC && !sent && !error && (
            <div className="phone-way" data-testid="phone-network-help">
              <Glyph name="wifi" />
              <div>
                <b>Check that your Mac allows it</b>
                <p className="muted-sm">
                  If you chose Don't Allow when your Mac asked about your local network, your phone can't reach this computer. Turn on Reel Studio in
                  System Settings, then scan the code again.
                </p>
              </div>
              <button className="btn small" onClick={() => void reel.perm.openSettings('network')} data-testid="phone-network-settings">
                Open System Settings
              </button>
            </div>
          )}
          {fallbackOrder(IS_MAC).map((way) => (
            <Fragment key={way}>{ways[way]}</Fragment>
          ))}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button ref={doneRef} className="btn ghost" onClick={onBack} data-autofocus data-testid="phone-done">
          Done
        </button>
      </div>
    </div>
  )
}
