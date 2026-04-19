import { readFile, unlink, writeFile } from 'fs/promises'
import { Hono } from 'hono'
import type { EngineManager } from '../../engine'
import { validateConfig } from '../../config/loader'
import { readRawConfig, writeRawConfig } from '../../config/raw'

const CUSTOM_PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9-_]{1,63}$/

interface ConfigRoutesOptions {
  configPath: string
  engineManager: EngineManager
}

function formatError(error: unknown): { message: string; status: 400 | 500 } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    message,
    status: message.startsWith('Invalid config:') ? 400 : 500,
  }
}

async function snapshotConfig(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function restoreConfig(path: string, snapshot: string | null): Promise<void> {
  if (snapshot === null) {
    await unlink(path).catch(() => undefined)
    return
  }
  await writeFile(path, snapshot, 'utf-8')
}

async function persistConfigUpdate(
  options: ConfigRoutesOptions,
  nextConfig: Record<string, any>,
  reason: string,
) {
  validateConfig(nextConfig)
  const previous = await snapshotConfig(options.configPath)
  await writeRawConfig(options.configPath, nextConfig)

  try {
    return await options.engineManager.applyRuntimeChange(reason)
  } catch (error) {
    await restoreConfig(options.configPath, previous)
    throw error
  }
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
      try {
        const body = await c.req.json().catch(() => ({})) as Record<string, any>
        const existing = await readRawConfig(options.configPath)
        const merged = {
          ...existing,
          ...body,
        }
        const runtime = await persistConfigUpdate(options, merged, 'config/nine1bot')
        return c.json({ success: true, runtime })
      } catch (error) {
        const failure = formatError(error)
        return c.json({ error: failure.message }, failure.status)
      }
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

      try {
        const existing = await readRawConfig(options.configPath)
        const customProviders = {
          ...(existing.customProviders || {}),
          [id]: provider,
        }
        const runtime = await persistConfigUpdate(options, {
          ...existing,
          customProviders,
        }, `custom-provider:${id}`)
        return c.json({ success: true, runtime })
      } catch (error) {
        const failure = formatError(error)
        return c.json({ error: failure.message }, failure.status)
      }
    })
    .delete('/nine1bot/custom-providers/:id', async (c) => {
      try {
        const { id } = c.req.param()
        const existing = await readRawConfig(options.configPath)
        const customProviders = { ...(existing.customProviders || {}) }
        delete customProviders[id]
        const runtime = await persistConfigUpdate(options, {
          ...existing,
          customProviders,
        }, `custom-provider:${id}:delete`)
        return c.json({ success: true, runtime })
      } catch (error) {
        const failure = formatError(error)
        return c.json({ error: failure.message }, failure.status)
      }
    })
}
