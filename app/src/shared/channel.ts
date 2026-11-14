// Which build this is. The version string alone decides it: a nightly is `<x.y.z>-nightly.<YYYYMMDD>.<run>`
// (the fork's nightly workflow sets it), anything else is the stable app. packaging/make-config.js reads
// NIGHTLY_VERSION from this file so the build and the running app can never disagree.
import { NIGHTLY_RELEASES_REPO, RELEASES_REPO } from './config'

export type Channel = 'stable' | 'nightly'

export const NIGHTLY_VERSION = /-nightly\.\d{8}\.\d+$/

export const channelOf = (version: string): Channel => (NIGHTLY_VERSION.test(version) ? 'nightly' : 'stable')

/** The name people see, and the name Electron files the app's data under (its userData folder). */
export const PRODUCT_NAME: Record<Channel, string> = { stable: 'Reel Studio', nightly: 'Reel Studio (Nightly)' }

export const productName = (version: string): string => PRODUCT_NAME[channelOf(version)]

/** Where each channel's releases are published. The stable app never reads the nightly repo, and the other way round. */
export const RELEASES_REPOS: Record<Channel, string> = { stable: RELEASES_REPO, nightly: NIGHTLY_RELEASES_REPO }

export const releasesUrl = (version: string): string => `https://github.com/${RELEASES_REPOS[channelOf(version)]}/releases`

/** A build that updates from the staging server (RS_UPDATE_HOST=dl-staging.getreelstudio.com) carries this as its
 * description, which electron-builder writes into the Windows installer's FileDescription: a Windows copy then refuses
 * an installer built for the other server (main/updater-electron.ts installerRefusal). packaging/make-config.js reads
 * it from this file. */
export const STAGING_DESCRIPTION = 'Reel Studio staging build'
