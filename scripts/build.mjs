import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'
import { promisify } from 'node:util'
import { buildClient, projectRoot } from './build-client.mjs'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
try {
  await execute(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '--project',
    'tsconfig.build.json',
  ], { cwd: projectRoot })
  await buildClient()
}
catch (error) {
  console.error(error.stdout || error.message)
  process.exitCode = 1
}
