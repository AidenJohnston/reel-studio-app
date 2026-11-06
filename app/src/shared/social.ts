// Posting to Instagram and TikTok through Reel Studio's sign-in service (docs/signin.md): what the app can tell the
// person about each platform, and every line Settings › Posting and the post sheets show for it. The platforms'
// own errors are worded in main/instagram-http.ts and main/tiktok-http.ts.
import type { InstagramSession } from './instagram'
import type { TikTokSession } from './tiktok'
import type { FacebookSession } from './facebook'
import type { ThreadsSession } from './threads'
import type { XSession } from './x'
import type { LinkedInSession } from './linkedin'

export type SigninPlatformId = 'instagram' | 'facebook' | 'tiktok' | 'threads' | 'x' | 'linkedin'

/**
 * Whether a platform can be connected now. Closed: the sign-in service couldn't be reached, or has no app for it.
 * Open, with where its approval stands: "testers" (Meta hasn't approved Reel Studio: only accounts added to the app
 * can connect), "private_only" (TikTok hasn't audited it: posts go up as Only me), "approved", or "own" (a
 * developer's own app, REELSTUDIO_DEV=1).
 */
export type PlatformAvailability =
  | { open: true; review: 'approved' | 'testers' | 'private_only' | 'own' }
  | { open: false; why: 'unreachable' | 'not_set_up' }

export interface SocialStatus {
  instagram: { availability: PlatformAvailability; session: InstagramSession }
  tiktok: { availability: PlatformAvailability; session: TikTokSession }
  facebook: { availability: PlatformAvailability; session: FacebookSession }
  threads: { availability: PlatformAvailability; session: ThreadsSession }
  x: { availability: PlatformAvailability; session: XSession }
  linkedin: { availability: PlatformAvailability; session: LinkedInSession }
}

export const PLATFORM_NAMES: Record<SigninPlatformId, string> = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', threads: 'Threads', x: 'X', linkedin: 'LinkedIn' }

/** The line under a platform that isn't connected: why it can't be yet, or what connecting needs. */
export function availabilityLine(id: SigninPlatformId, a: PlatformAvailability): string {
  const name = PLATFORM_NAMES[id]
  if (!a.open)
    return a.why === 'unreachable'
      ? `Connecting ${name} needs Reel Studio’s sign-in service, which can’t be reached. Check your connection; if you’re online, it isn’t open yet.`
      : `Reel Studio’s sign-in service isn’t set up for ${name} yet.`
  if (a.review === 'testers')
    return id === 'facebook'
      ? 'Meta hasn’t approved Reel Studio yet, so only people added to its app as testers can connect.'
      : 'Meta hasn’t approved Reel Studio yet, so only accounts added to its app as testers can connect.'
  if (a.review === 'private_only') return 'TikTok hasn’t reviewed Reel Studio yet, so posts go up as Only me until it does.'
  if (id === 'instagram') return 'Needs a Business or Creator account.'
  if (id === 'threads' || id === 'x' || id === 'linkedin') return ''
  return ''
}

/** "A, B and C" */
export const andList = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '')

/** One line for every platform that can't be connected now, so Settings says it once instead of once a row. */
export function closedLine(ids: SigninPlatformId[], unreachable: boolean): string {
  const names = andList(ids.map((id) => PLATFORM_NAMES[id]))
  return unreachable
    ? `${names} connect through Reel Studio’s sign-in service, which can’t be reached. Check your connection; if you’re online, it isn’t open yet.`
    : `Reel Studio’s sign-in service isn’t set up for ${names} yet.`
}

/** The connected account's line in Settings › Posting. */
export function connectedLine(id: SigninPlatformId, name: string): string {
  if (id === 'facebook') return `Posting to ${name}.`
  return `Connected as ${id === 'instagram' || id === 'threads' || id === 'x' ? `@${name}` : name}.`
}

export const SOCIAL_COPY = {
  connecting: (name: string) => `Finish signing in to ${name} in your browser. Reel Studio waits here.`,
  disconnectTitle: (name: string) => `Disconnect ${name}?`,
  disconnectBody: (name: string, account: string) =>
    name === 'TikTok'
      ? `Reel Studio forgets ${account} on this computer and asks TikTok to end its access. Posts already made stay on TikTok.`
      : `Reel Studio forgets ${account} on this computer. Posts already made stay on ${name}. To remove Reel Studio’s access completely, remove it in ${name}’s settings too.`,
  liHeading: 'Post to LinkedIn',
  liDoneHeading: 'Posted to LinkedIn',
  liDone: 'Your video is on LinkedIn.',
  liWait: 'LinkedIn processes the video before it posts, which can take a few minutes. Keep Reel Studio open.',
  xHeading: 'Post to X',
  xDoneHeading: 'Posted to X',
  xDone: 'Your video is on X.',
  xWait: 'X checks the video before it posts. Keep Reel Studio open.',
  thHeading: 'Post to Threads',
  thDoneHeading: 'Posted to Threads',
  thDone: 'Your video is on Threads.',
  thWait: 'Threads checks the video before it posts, usually for about half a minute. Keep Reel Studio open.',
  fbHeading: 'Post to Facebook',
  fbDoneHeading: 'Posted to Facebook',
  fbPage: 'Page',
  fbDone: (page: string) => `Your reel is on ${page}. Facebook may take a few minutes to show it.`,
  fbWait: 'Keep Reel Studio open until Facebook answers.',
  igHeading: 'Post to Instagram',
  igDoneHeading: 'Posted to Instagram',
  ttHeading: 'Post to TikTok',
  ttDoneHeading: 'Sent to TikTok',
  igWait: 'Instagram checks the video before it posts. This can take a few minutes; keep Reel Studio open.',
  igCover: 'Cover',
  igCoverFrame: 'The first frame',
  igCoverImage: 'The cover Reel Studio picked',
  igTrial: 'Post as a trial reel',
  igTrialHelp: 'Instagram shows a trial reel to people who don’t follow you first. Share it to your followers from Instagram once you see how it does.',
  igDone: 'Your reel is on Instagram.',
  pairPost: 'Post both to Instagram as trial reels',
  pairHelp: (who: string) => `Posts Try 1 and Try 2 to @${who} as trial reels, shown first to people who don’t follow you. Compare their views in Insights after a day, then share the better one with your followers from Instagram.`,
  pairSending: (n: 1 | 2) => `Posting Try ${n} to Instagram…`,
  pairDone: 'Both are on Instagram as trial reels.',
  igDoneTrial: 'Your trial reel is on Instagram. It goes to people who don’t follow you first.',
  ttPrivacy: 'Who can see it',
  ttPrivacyPick: 'Choose who can see it.',
  ttInteractions: 'Let people',
  ttDisclose: 'This video promotes a brand, product or service',
  ttYourBrand: 'Your own brand',
  ttBranded: 'Someone else’s brand (a paid partnership)',
  ttBrandedNote: 'It will be labeled “Paid partnership.”',
  ttOwnNote: 'It will be labeled “Promotional content.”',
  ttAigc: 'Label it as made with AI',
  ttTooLong: (max: number) => `TikTok lets this account post videos up to ${max} seconds long. Make this one shorter first.`,
  ttProcessing: 'TikTok is still working on it. Open TikTok to see it; posting this version again checks on it.',
  ttUnaudited: 'TikTok hasn’t reviewed Reel Studio yet, so it can post only as Only me, and TikTok may ask for a private account.',
  ttInbox: 'TikTok puts this video in your TikTok inbox. Open the notification in TikTok to finish posting it.',
  ttWait: 'Keep Reel Studio open until TikTok answers.',
  noDuration: 'Reel Studio couldn’t read this video’s length. Export it again, then post.',
  captionTooLong: (name: string, max: number) => `${name} takes up to ${max.toLocaleString('en-US')} characters. Shorten the caption above for this post.`,
  connectOnce: (name: string) => `Connect your ${name} account once. Reel Studio keeps the connection on this computer.`,
  sending: (name: string) => `Sending your video to ${name}…`
} as const

export const MUSIC_TERMS_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en'
export const BRANDED_TERMS_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en'

/** TikTok's privacy levels in its words, in the order its own app shows them. */
export const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  FOLLOWER_OF_CREATOR: 'Followers',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  SELF_ONLY: 'Only me'
} as const
