import { buildClient } from './build-client.mjs'

await buildClient(false)
await import('../src/server.ts')
