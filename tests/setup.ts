import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

process.env.JIELONG_DATA_DIR = mkdtempSync(join(tmpdir(), 'jielong-tests-'))
