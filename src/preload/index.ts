import { contextBridge } from 'electron'
import { buildApi, type ErpApi } from './api/build-api'

/**
 * The ONLY door between the renderer and privileged code (Step 2 §4).
 * Exposes one named, channel-bound method per entry in IPC_CHANNELS —
 * no generic invoke(channel, ...args), no Node APIs, no filesystem, no
 * database handle. Everything the renderer can do is enumerable here.
 */
const api: ErpApi = buildApi()

contextBridge.exposeInMainWorld('erp', api)

export type { ErpApi }
