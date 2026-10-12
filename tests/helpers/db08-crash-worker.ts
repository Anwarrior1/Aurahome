import { getDatabase, setDatabasePath } from '../../src/main/db/connection'
import { restoreFromBackup } from '../../src/main/restore/restore.service'

const databasePath = process.argv[2]
const backupFilePath = process.argv[3]
if (!databasePath || !backupFilePath) process.exit(85)

setDatabasePath(databasePath)
getDatabase()
await restoreFromBackup({ backupFilePath }, {
  session: {
    sessionId: 'db08-crash-worker',
    user: { id: 1, username: 'crash-worker' }
  } as never
}, {
  afterAtomicInstall: () => process.exit(86)
})
process.exit(87)
