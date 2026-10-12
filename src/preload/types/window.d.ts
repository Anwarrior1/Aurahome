import type { ErpApi } from '../api/build-api'

declare global {
  interface Window {
    erp: ErpApi
  }
}

export {}
