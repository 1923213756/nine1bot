import { Hono } from 'hono'
import type { EngineManager } from '../../engine'
import { readRawConfig, writeRawConfig } from '../../config/raw'

const CUSTOM_PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9-_]{1,63}$/

interface ConfigRoutesOptions {
  configPath: string
  engineManager: EngineManager
}

export function createShellConfigRoutes(options: ConfigRoutesOptions) {
  return new Hono()
    .get('/nine1bot', async (c) => {
      const config = await readRawConfig(options.configPath)
      return c.json({
        model: config.model,
        small_model: config.small_model,
        customProviders: config.customProviders || {},
        configPath: options.configPath,
      })
    })
    .patch('/nine1bot', async (c) => {
      const body = await c.req.json().catch(() => ({})) as Record<string, any>
      const existing = await readRawConfig(options.configPath)
      const merged = {
        ...existing,
        ...body,
      }
      await writeRawConfig(options.configPath, merged)
      const runtime = await options.engineManager.applyRuntimeChange('config/nine1bot')
      return c.json({ success: true, runtime })
    })
    .get('/nine1bot/custom-providers', async (c) => {
      const config = await readRawConfig(options.configPath)
      return c.json(config.customProviders || {})
    })
    .put('/nine1bot/custom-providers/:id', async (c) => {
      const { id } = c.req.param()
      if (!CUSTOM_PROVIDER_ID_REGEX.test(id)) {
        return c.json({ error: 'Invalid provider id' }, 400)
      }

      const provider = await c.req.json().catch(() => undefined)
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        return c.json({ error: 'Invalid custom provider payload' }, 400)
      }

      const existing = await readRawConfig(options.configPath)
      const customProviders = {
        ...(existing.customProviders || {}),
        [id]: provider,
      }
      await writeRawConfig(options.configPath, {
        ...existing,
        customProviders,
      })
      const runtime = await options.engineManager.applyRuntimeChange(`custom-provider:${id}`)
      return c.json({ success: true, runtime })
    })
    .delete('/nine1bot/custom-providers/:id', async (c) => {
      const { id } = c.req.param()
      const existing = await readRawConfig(options.configPath)
      const customProviders = { ...(existing.customProviders || {}) }
      delete customProviders[id]
      await writeRawConfig(options.configPath, {
        ...existing,
        customProviders,
      })
      const runtime = await options.engineManager.applyRuntimeChange(`custom-provider:${id}:delete`)
      return c.json({ success: true, runtime })
    })
}
