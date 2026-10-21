// The only bridge between the page and the main process. The page never sees Node or ipcRenderer.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppCommand, JobEvent, ModelStatus, PhoneEvent, ReelApi, UpdateNotice } from '../shared/api'

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
  app: {
    info: () => call('app:info'),
    finishFirstRun: () => call('app:finishFirstRun'),
    openFolder: (p) => call('app:openFolder', p),
    copyText: (t) => call('app:copyText', t),
    pathForFile: (f) => webUtils.getPathForFile(f),
    chooseFolder: () => call('app:chooseFolder'),
    setRoot: (p) => call('app:setRoot', p),
    onCommand: (cb) => on<AppCommand>('app:command', cb),
    startDrag: (file) => ipcRenderer.send('app:startDrag', file)
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
    setActive: (id) => call('ai:setActive', id),
    signInChatGPT: () => call('ai:signInChatGPT'),
    cancelSignIn: () => call('ai:cancelSignIn'),
    signOutChatGPT: () => call('ai:signOutChatGPT'),
    setClaudeKey: (k) => call('ai:setClaudeKey', k),
    claudeCodeStatus: () => call('ai:claudeCodeStatus'),
    openClaudeSignIn: () => call('ai:openClaudeSignIn')
  },
  projects: {
    list: () => call('projects:list'),
    get: (slug) => call('projects:get', slug),
    create: (files) => call('projects:create', files),
    resume: (slug) => call('projects:resume', slug),
    note: (slug, text, attachments) => call('projects:note', slug, text, attachments),
    update: (slug, patch) => call('projects:update', slug, patch),
    rerender: (slug, change, label) => call('projects:rerender', slug, change, label),
    exportVersion: (slug, n) => call('projects:export', slug, n),
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
    cancel: (id) => call('jobs:cancel', id),
    onEvent: (cb) => on<JobEvent>('job:event', cb)
  },
  phone: {
    start: (video, caption, address) => call('phone:start', video, caption, address),
    stop: () => call('phone:stop'),
    onEvent: (cb) => on<PhoneEvent>('phone:event', cb),
    emailSelf: (video) => call('phone:emailSelf', video),
    shareSheet: (video) => call('phone:shareSheet', video)
  },
  library: {
    list: () => call('library:list'),
    add: (paths) => call('library:add', paths),
    choose: (kind) => call('library:choose', kind)
  },
  style: {
    rules: () => call('style:rules'),
    remove: (id) => call('style:remove', id),
    answer: (slug, messageId, yes) => call('style:answer', slug, messageId, yes)
  },
  script: {
    write: (idea) => call('script:write', idea)
  },
  dev: {
    renderTestAnimation: (out, full, template, params) => call('dev:renderTestAnimation', out, full, template, params)
  },
  perm: {
    status: () => call('perm:status'),
    allowFolder: () => call('perm:allowFolder'),
    setNotifications: (on) => call('perm:setNotifications', on)
  },
  update: {
    status: () => call('update:status'),
    setEnabled: (on) => call('update:setEnabled', on),
    open: (url) => call('update:open', url),
    dismiss: (version) => call('update:dismiss', version),
    onChange: (cb) => on<UpdateNotice | null>('update:change', cb)
  }
}

contextBridge.exposeInMainWorld('reel', api)
