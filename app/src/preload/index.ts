// TikTok API v2: https://developers.tiktok.com/doc/login-kit-desktop/
// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// The only bridge between the page and the main process. The page never sees Node or ipcRenderer.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppCommand, DevicesStatus, JobEvent, ModelStatus, OutsideStatus, PhoneEvent, PostingStatus, PostProgress, ProviderInfo, ReelApi, UpdateKeyStatus, VendorInfo } from '../shared/api'
import type { UpdateState } from '../shared/update'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as
    | { ok: true; value: T }
    | { ok: false; error: { code: string; userMessage: string } }
  if (r.ok) return r.value
  throw r.error
}

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: unknown, v: T): void => cb(v)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

const api: ReelApi = {
  insights: {
    get: (options) => call('insights:get', options),
    status: () => call('insights:status'),
    refresh: (options) => call('insights:refresh', options),
    onChange: (cb) => on<void>('insights:changed', () => cb())
  },
  wrapped: { report: () => call('wrapped:report') },
  tiktok: {
    configure: (settings) => call('tiktok:configure', settings),
    session: () => call('tiktok:session'),
    connect: () => call('tiktok:connect'),
    cancelConnect: () => call('tiktok:cancelConnect'),
    disconnect: () => call('tiktok:disconnect'),
    creator: () => call('tiktok:creator'),
    publish: (input) => call('tiktok:publish', input),
    insights: (slug, version, postId) => call('tiktok:insights', slug, version, postId)
  },
  instagram: {
    configure: (settings) => call('instagram:configure', settings),
    session: () => call('instagram:session'),
    connect: () => call('instagram:connect'),
    cancelConnect: () => call('instagram:cancelConnect'),
    disconnect: () => call('instagram:disconnect'),
    publish: (input) => call('instagram:publish', input),
    insights: (slug, version, postId) => call('instagram:insights', slug, version, postId)
  },
  app: {
    info: () => call('app:info'),
    clipboardFiles: () => call('app:clipboardFiles'),
    takeOpenFiles: () => call('app:takeOpenFiles'),
    onFilesAvailable: (cb) => on('app:filesAvailable', cb),
    finishFirstRun: () => call('app:finishFirstRun'),
    openFolder: (p) => call('app:openFolder', p),
    copyText: (t) => call('app:copyText', t),
    dimTitleBar: (on) => call('app:dimTitleBar', on),
    titleBarOnStage: (on) => call('app:titleBarOnStage', on),
    pathForFile: (f) => webUtils.getPathForFile(f),
    chooseFolder: () => call('app:chooseFolder'),
    setRoot: (p) => call('app:setRoot', p),
    setFasterExports: (on) => call('app:setFasterExports', on),
    setModels: (models) => call('app:setModels', models),
    setSharing: (sharing) => call('app:setSharing', sharing),
    usage: () => call('app:usage'),
    setPhoneView: (view) => call('app:setPhoneView', view),
    setSoundEffects: (on) => call('app:setSoundEffects', on),
    setTimeline: (shown) => call('app:setTimeline', shown),
    engineCache: () => call('app:engineCache'),
    clearEngineCache: () => call('app:clearEngineCache'),
    showLogs: () => call('app:showLogs'),
    setFirstRunAgain: (on) => call('app:setFirstRunAgain', on),
    onCommand: (cb) => on<AppCommand>('app:command', cb),
    startDrag: (file) => ipcRenderer.send('app:startDrag', file),
    legal: (doc) => call('app:legal', doc),
    showLegal: (doc) => call('app:showLegal', doc)
  },
  model: {
    status: () => call('model:status'),
    download: () => call('model:download'),
    find: () => call('model:find'),
    cancel: () => call('model:cancel'),
    onProgress: (cb) => on<ModelStatus>('model:progress', cb)
  },
  ai: {
    providers: () => call('ai:providers'),
    active: () => call('ai:active'),
    setActive: (id, connectionId) => call('ai:setActive', id, connectionId),
    cancelCheck: () => call('ai:cancelCheck'),
    stockProviders: () => call('ai:stockProviders'),
    setStockKey: (provider, key) => call('ai:setStockKey', provider, key),
    setClaudeKey: (k) => call('ai:setClaudeKey', k),
    claudeCodeStatus: () => call('ai:claudeCodeStatus'),
    openClaudeSignIn: () => call('ai:openClaudeSignIn'),
    vendorStatus: (v) => call('ai:vendorStatus', v),
    vendorConnect: (v) => call('ai:vendorConnect', v),
    vendorCancel: (v) => call('ai:vendorCancel', v),
    vendorSignInAgain: (v) => call('ai:vendorSignInAgain', v),
    vendorSignIn: (v) => call('ai:vendorSignIn', v),
    vendorSignInWithCode: (v) => call('ai:vendorSignInWithCode', v),
    onVendor: (cb) => on<VendorInfo>('ai:vendor', cb),
    noteRunner: () => call('ai:noteRunner'),
    setNoteRunner: (runner) => call('ai:setNoteRunner', runner),
    checkEdits: () => call('ai:checkEdits'),
    setCheckEdits: (on) => call('ai:setCheckEdits', on),
    connections: () => call('ai:connections'),
    saveConnection: (input) => call('ai:saveConnection', input),
    removeConnection: (id) => call('ai:removeConnection', id),
    setConnectionImages: (id, on) => call('ai:setConnectionImages', id, on),
    connectionModels: (q) => call('ai:connectionModels', q),
    hubStatus: () => call('ai:hubStatus'),
    hubUse: (key) => call('ai:hubUse', key),
    setHubManagementKey: (key) => call('ai:setHubManagementKey', key),
    editorModels: () => call('ai:editorModels'),
    autoModels: () => call('ai:autoModels'),
    editorAccounts: () => call('ai:editorAccounts'),
    test: (role) => call('ai:test', role),
    onChange: (cb) => on<ProviderInfo>('ai:change', cb)
  },
  outside: {
    status: () => call('outside:status'),
    setEnabled: (on) => call('outside:setEnabled', on),
    reset: () => call('outside:reset'),
    onChange: (cb) => on<OutsideStatus>('outside:change', cb)
  },
  projects: {
    list: () => call('projects:list'),
    search: (query) => call('projects:search', query),
    get: (slug) => call('projects:get', slug),
    score: (slug, version) => call('projects:score', slug, version),
    create: (files) => call('projects:create', files),
    plan: () => call('projects:plan'),
    leave: (slug) => call('projects:leave', slug),
    addVideo: (slug, files) => call('projects:addVideo', slug, files),
    planSay: (slug, text) => call('projects:planSay', slug, text),
    setPlan: (slug, plan) => call('projects:setPlan', slug, plan),
    resume: (slug, basic) => call('projects:resume', slug, basic),
    note: (slug, text, attachments, moment, onVersion, base) => call('projects:note', slug, text, attachments, moment, onVersion, base),
    mergeVersions: (slug, request) => call('projects:mergeVersions', slug, request),
    timeline: (slug, n) => call('projects:timeline', slug, n),
    versionRows: (slug, n) => call('projects:versionRows', slug, n),
    update: (slug, patch) => call('projects:update', slug, patch),
    handEdit: (slug, edit, summary, changes, replace) => call('projects:handEdit', slug, edit, summary, changes, replace),
    exportVersion: (slug, n) => call('projects:export', slug, n),
    coverCandidates: (slug, moments, source) => call('projects:coverCandidates', slug, moments, source),
    stopCoverCandidates: (slug) => call('projects:stopCoverCandidates', slug),
    matchJoins: (slug, keep) => call('projects:matchJoins', slug, keep),
    pacePreview: (slug) => call('projects:pacePreview', slug),
    exportPlatforms: (slug, n, request) => call('projects:exportPlatforms', slug, n, request),
    proposeTry: (slug, n, ask) => call('projects:proposeTry', slug, n, ask),
    proposeReels: (slug) => call('projects:proposeReels', slug),
    makeReels: (slug, ids) => call('projects:makeReels', slug, ids),
    foldReels: (slug, folded) => call('projects:foldReels', slug, folded),
    remove: (slug) => call('projects:remove', slug)
  },
  notes: {
    attachFiles: (slug, paths) => call('notes:attachFiles', slug, paths),
    attachData: (slug, file) => call('notes:attachData', slug, file),
    attachClipboard: (slug) => call('notes:attachClipboard', slug),
    choose: (slug) => call('notes:chooseAttachment', slug),
    remove: (slug, asset) => call('notes:removeAttachment', slug, asset)
  },
  jobs: {
    cancel: (id, slug) => call('jobs:cancel', id, slug),
    onEvent: (cb) => on<JobEvent>('job:event', cb)
  },
  queue: {
    edit: (slug, id, text) => call('queue:edit', slug, id, text),
    cancel: (slug, id) => call('queue:cancel', slug, id),
    move: (slug, id, by) => call('queue:move', slug, id, by),
    runNext: (slug) => call('queue:runNext', slug),
    clear: (slug) => call('queue:clear', slug),
    onChange: (cb) => on<string>('queue:change', cb)
  },
  cloud: {
    drives: () => call('cloud:drives'),
    save: (video, folder, id) => call('cloud:save', video, folder, id),
    cancel: (id) => call('cloud:cancel', id),
    onProgress: (cb) => on<{ id: string; pct: number }>('cloud:progress', cb)
  },
  devices: {
    status: () => call('devices:status'),
    setOn: (on) => call('devices:setOn', on),
    pair: (kind, notes) => call('devices:pair', kind, notes),
    cancelPair: () => call('devices:cancelPair'),
    openInBrowser: (notes) => call('devices:openInBrowser', notes),
    remove: (id) => call('devices:remove', id),
    onChange: (cb) => on<DevicesStatus>('devices:change', cb)
  },
  phone: {
    start: (video, caption, address) => call('phone:start', video, caption, address),
    startPlan: (slug, address) => call('phone:startPlan', slug, address),
    stop: () => call('phone:stop'),
    onEvent: (cb) => on<PhoneEvent>('phone:event', cb),
    emailSelf: (video) => call('phone:emailSelf', video),
    shareSheet: (video) => call('phone:shareSheet', video)
  },
  library: {
    list: () => call('library:list'),
    add: (paths) => call('library:add', paths),
    choose: (kind) => call('library:choose', kind),
    preview: (path) => call('library:preview', path)
  },
  style: {
    rules: () => call('style:rules'),
    add: (text) => call('style:add', text),
    remove: (id) => call('style:remove', id),
    damaged: () => call('style:damaged'),
    restore: (id) => call('style:restore', id),
    find: () => call('style:find'),
    count: () => call('style:count'),
    learn: (ids) => call('style:learn', ids),
    onLearnProgress: (cb) => on<{ done: number; total: number }>('style:learnProgress', cb),
    appIcons: () => call('style:appIcons'),
    reveal: (id) => call('style:reveal', id),
    keepLearned: (rules, from) => call('style:keepLearned', rules, from),
    update: (id, patch) => call('style:update', id, patch),
    answer: (slug, messageId, yes) => call('style:answer', slug, messageId, yes),
    rememberLowercase: (slug) => call('style:rememberLowercase', slug),
    suggestions: () => call('style:suggestions'),
    keepSuggestion: (id, text) => call('style:keepSuggestion', id, text),
    dismissSuggestion: (id) => call('style:dismissSuggestion', id)
  },
  references: {
    list: () => call('refs:list'),
    add: (paths) => call('refs:add', paths),
    addLink: (url) => call('refs:addLink', url),
    attach: (id, path) => call('refs:attach', id, path),
    remove: (id) => call('refs:remove', id),
    openLink: (id) => call('refs:openLink', id),
    reveal: (id) => call('refs:reveal', id),
    onChange: (cb) => on<void>('refs:changed', () => cb())
  },
  niche: {
    get: () => call('niche:get'),
    save: (niche, from) => call('niche:save', niche, from),
    remove: () => call('niche:remove'),
    say: (turns, asked, draft) => call('niche:say', turns, asked, draft),
    stop: () => call('niche:stop'),
    onStatus: (cb) => on<{ message: string; waiting?: boolean }>('niche:status', cb)
  },
  sfx: {
    pack: () => call('sfx:pack')
  },
  dev: {
    renderTestAnimation: (out, full, template, params) => call('dev:renderTestAnimation', out, full, template, params)
  },
  perm: {
    status: () => call('perm:status'),
    allowFolder: () => call('perm:allowFolder'),
    setNotifications: (on) => call('perm:setNotifications', on),
    openSettings: (pane) => call('perm:openSettings', pane)
  },
  update: {
    state: () => call('update:state'),
    check: () => call('update:check'),
    download: () => call('update:download'),
    install: () => call('update:install'),
    openRelease: () => call('update:openRelease'),
    openAutoUpdatesPage: () => call('update:openAutoUpdatesPage'),
    busy: () => call('update:busy'),
    dismiss: (version) => call('update:dismiss', version),
    setEnabled: (on) => call('update:setEnabled', on),
    onState: (cb) => on<UpdateState>('update:state', cb)
  },
  updateKey: {
    status: () => call('updateKey:status'),
    paste: () => call('updateKey:paste'),
    clear: () => call('updateKey:clear'),
    onChange: (cb) => on<UpdateKeyStatus>('updateKey:change', cb)
  },
  posting: {
    status: () => call('posting:status'),
    signIn: () => call('posting:signIn'),
    signOut: () => call('posting:signOut'),
    signOutEverywhere: () => call('posting:signOutEverywhere'),
    connect: (platform) => call('posting:connect', platform),
    reopenConnect: () => call('posting:reopenConnect'),
    cancelConnect: () => call('posting:cancelConnect'),
    disconnect: (platform) => call('posting:disconnect', platform),
    post: (req) => call('posting:post', req),
    cancel: () => call('posting:cancel'),
    current: () => call('posting:current'),
    pending: (slug, version) => call('posting:pending', slug, version),
    resume: (uploadId) => call('posting:resume', uploadId),
    discard: (uploadId) => call('posting:discard', uploadId),
    openLink: (url) => call('posting:openLink', url),
    onChange: (cb) => on<PostingStatus>('posting:change', cb),
    onProgress: (cb) => on<PostProgress>('posting:progress', cb)
  }
}

contextBridge.exposeInMainWorld('reel', api)
