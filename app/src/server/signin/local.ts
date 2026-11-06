// `npm run signin` (app/package.json): the sign-in service on this computer, with settings from the environment.
// Point the app at it with REELSTUDIO_SIGNIN_URL=http://127.0.0.1:8787 (docs/signin.md).
import { configFromEnv } from './config.ts'
import { createSigninHandler } from './handler.ts'
import { serveNode } from './node.ts'

const port = Number(process.env.PORT ?? 8787)
const env = { SIGNIN_PUBLIC_URL: `http://127.0.0.1:${port}`, ...process.env }
const handler = createSigninHandler(configFromEnv(env, (url, init) => fetch(url, init)))
const { url } = await serveNode(handler, port)
console.log(`Reel Studio sign-in service on ${url}`)
