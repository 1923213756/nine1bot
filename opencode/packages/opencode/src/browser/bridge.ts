import type { BridgeServer } from '../../../../packages/browser-mcp-server/src/bridge/server'
import { BrowserServiceClient } from './service-client'

let instance: BridgeServer | null = null
let serviceClient: BrowserServiceClient | null = null

export function setBridgeServer(bridge: BridgeServer): void {
  instance = bridge
}

export function getBridgeServer(): BridgeServer | BrowserServiceClient | null {
  if (instance) {
    return instance
  }

  const serviceUrl = process.env.BROWSER_SERVICE_URL
  if (!serviceUrl) {
    return null
  }

  if (!serviceClient || serviceClient.baseUrl !== serviceUrl) {
    serviceClient = new BrowserServiceClient(serviceUrl)
  }

  return serviceClient
}
