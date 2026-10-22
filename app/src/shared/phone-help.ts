// "Send to my phone" help, kept free of React and the DOM so it is unit-tested (test/phone-help.test.ts).
//
// The QR link only works when the phone can reach this computer. School, work, hotel and guest Wi-Fi
// usually stop devices from reaching each other, so on those networks the page never opens and the user
// is left staring at a code that does nothing. When the phone has not opened the page a little while after
// the code appeared, the panel says why in plain words and shows the other ways, best first.

/** How long the QR may sit unopened before the panel explains and shows the other ways. */
export const PHONE_WAIT_MS = 20_000

export const PHONE_HELP = {
  title: 'Not opening on your phone?',
  why: 'School, work and hotel Wi-Fi often block this. Use one of these instead:',
  /** First thing to check, on every computer: what actually stops the phone reaching it. */
  checkTitle: 'Check your Wi-Fi',
  check: 'Your phone and this computer need to be on the same Wi-Fi. A guest Wi-Fi, or a VPN on either one, also stops it. Fix that, then scan the code again.',
  /** After the phone did open the page, or when the link could not start at all. */
  other: 'Other ways to get it on your phone'
} as const

export type PhoneFallback = 'airdrop' | 'cloud' | 'email' | 'cable'

/**
 * The other ways, best first. AirDrop only exists on a Mac and is the quickest there. A drive comes before
 * email everywhere because a finished Reel is often over the ~20 MB most email allows. A cable is last.
 */
export function fallbackOrder(isMac: boolean): PhoneFallback[] {
  return isMac ? ['airdrop', 'cloud', 'email', 'cable'] : ['cloud', 'email', 'cable']
}

/**
 * Call `onNoVisit` once, `waitMs` after the code appears, unless cancelled first. Returns the cancel
 * function; the panel calls it when the phone opens the page, the link stops, a new code is made, or the
 * panel closes, so nothing fires after it is gone.
 */
export function waitForPhone(waitMs: number, onNoVisit: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    t = null
    onNoVisit()
  }, waitMs)
  return () => {
    if (t !== null) clearTimeout(t)
    t = null
  }
}
