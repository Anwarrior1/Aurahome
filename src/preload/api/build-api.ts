import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type ChannelMap } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'

export type ApiMethod = (payload?: unknown) => Promise<IpcResult<unknown>>

/**
 * Turns the fixed channel map into an object of named methods, each
 * permanently bound to its own literal channel string.
 *
 * This is NOT a generic invoke bridge: the renderer receives only the
 * exact methods listed in IPC_CHANNELS and has no way to name a
 * channel of its own, so the privileged surface is still the closed,
 * reviewed list in src/shared/constants/channels.ts (Step 2 §4).
 */
export type ErpApi = {
  [Group in keyof ChannelMap]: {
    [Method in keyof ChannelMap[Group]]: ApiMethod
  }
}

export function buildApi(): ErpApi {
  const api = {} as Record<string, Record<string, ApiMethod>>
  for (const [group, methods] of Object.entries(IPC_CHANNELS)) {
    const groupApi: Record<string, ApiMethod> = {}
    for (const [method, channel] of Object.entries(methods as Record<string, string>)) {
      const boundChannel = channel // closed over; never taken from the caller
      groupApi[method] = (payload?: unknown) => ipcRenderer.invoke(boundChannel, payload)
    }
    api[group] = groupApi
  }
  return api as ErpApi
}
