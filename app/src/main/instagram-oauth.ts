// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// The sign-in service redirects a sealed handoff to this loopback listener, never a token (docs/signin.md).
import { InstagramError } from './instagram-http'
import { signinCallback } from './signin-callback'

export function instagramCallback(state: string, signal: AbortSignal) {
  return signinCallback('Instagram', '/instagram/callback', state, signal, {
    declined: () => new InstagramError('IG_DECLINED', 'Instagram was not connected. You can try again in Settings.'),
    cancelled: () => new InstagramError('IG_CANCELLED', 'Instagram connection was cancelled.'),
    failed: () => new InstagramError('IG_CALLBACK', 'Could not open the Instagram callback. Try again.')
  })
}
