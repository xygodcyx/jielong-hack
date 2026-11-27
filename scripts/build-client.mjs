import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export async function buildClient(minify = true) {
  await build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/client/app.ts'],
    outfile: 'public/assets/app.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    minify,
    logLevel: 'info',
  })
}
