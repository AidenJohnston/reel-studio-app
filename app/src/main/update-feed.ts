// Which download server this build updates from. A packaged build reads the `url` of its own app-update.yml
// (inside the signed bundle, written from packaging/electron-builder.yml `publish`). A build made with
// RS_UPDATE_HOST=dl-staging.getreelstudio.com (packaging/make-config.js) names the staging server there, so it can
// be proven end to end before users see a release. Any other or unreadable value means production.
import { readFileSync } from 'node:fs'
import { LATEST_URL } from './update-check'
import { UPDATE_FEED_URL } from './updater-electron'

export const STAGING_HOST = 'dl-staging.getreelstudio.com'

export interface UpdateFeed {
  latestUrl: string
  feedUrl: string
  staging: boolean
}

export const PRODUCTION_FEED: UpdateFeed = { latestUrl: LATEST_URL, feedUrl: UPDATE_FEED_URL, staging: false }

/** The feed named by app-update.yml's text: staging only for exactly `url: https://dl-staging.getreelstudio.com/u/`. */
export function feedFromConfig(text: string | null): UpdateFeed {
  const m = /^url:[ \t]*(\S+)[ \t]*$/m.exec(text ?? '')
  if (m && m[1] === `https://${STAGING_HOST}/u/`) {
    return { latestUrl: `https://${STAGING_HOST}/latest.json`, feedUrl: `https://${STAGING_HOST}/u/`, staging: true }
  }
  return PRODUCTION_FEED
}

export function feedFromFile(file: string | null): UpdateFeed {
  if (!file) return PRODUCTION_FEED
  try {
    return feedFromConfig(readFileSync(file, 'utf8'))
  } catch {
    return PRODUCTION_FEED
  }
}
