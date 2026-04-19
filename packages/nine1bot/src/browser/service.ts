import type { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { createServer } from 'net'
import { BridgeServer } from '../../../browser-mcp-server/src/bridge/server'
import type { BrowserConfig } from '../config/schema'

export interface BrowserServiceInstance {
  url: string
  app: Hono
  health(): Promise<boolean>
  stop(): Promise<void>
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(port)
      })
    })
  })
}

export async function startBrowserService(config: BrowserConfig): Promise<BrowserServiceInstance | undefined> {
  if (!config.enabled) {
    return undefined
  }

  const bridge = new BridgeServer({
    cdpPort: config.cdpPort,
    autoLaunch: config.autoLaunch,
    headless: config.headless,
  })
  await bridge.start()

  const app = bridge.getRoutes()
  const port = await findAvailablePort()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: app.fetch,
    websocket,
  })
  const url = server.url.toString().replace(/\/$/, '')

  return {
    url,
    app,
    async health() {
      try {
        const response = await fetch(`${url}/status`)
        return response.ok
      } catch {
        return false
      }
    },
    async stop() {
      server.stop(true)
      await bridge.stop()
    },
  }
}
