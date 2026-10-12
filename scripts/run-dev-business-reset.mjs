import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const reset = join(fileURLToPath(new URL('.', import.meta.url)), 'reset-business-data.mjs')
const result = spawnSync(process.execPath, [reset, ...process.argv.slice(2)], {
  env: { ...process.env, AURA_DEV_BUSINESS_RESET: '1' },
  stdio: 'inherit'
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
