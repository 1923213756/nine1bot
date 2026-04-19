import { resolve, dirname, basename } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import type { ServerConfig, AuthConfig, Nine1BotConfig, CustomProvider } from '../config/schema'
import { getInstallDir, getGlobalSkillsDir, getAuthPath, getGlobalConfigDir, getProjectEnvDir } from '../config/loader'
import { getGlobalPreferencesPath } from '../preferences'
// 静态导入 OpenCode 服务器（编译时打包）
import { Server as OpencodeServer } from '../../../../opencode/packages/opencode/src/server/server'
import { BridgeServer } from '../../../browser-mcp-server/src/bridge/server'
import { setBridgeServer } from '../../../../opencode/packages/opencode/src/browser/bridge'

/**
 * 判断是否是发行版模式
 */
function isReleaseMode(): boolean {
  const dirName = basename(dirname(process.execPath))
  return dirName.startsWith('nine1bot-')
}

/**
 * 获取内置 skills 目录路径
 * - 发行版模式：installDir/skills
 * - 开发模式：installDir/packages/nine1bot/skills
 */
function getBuiltinSkillsDir(): string {
  const installDir = getInstallDir()
  return resolve(installDir, isReleaseMode() ? 'skills' : 'packages/nine1bot/skills')
}

/**
 * 获取 web 资源目录路径
 * - 发行版模式：installDir/web/dist
 * - 开发模式：installDir/web/dist
 */
function getWebDistDir(): string {
  const installDir = getInstallDir()
  return resolve(installDir, 'web/dist')
}

export interface ServerInstance {
  url: string
  hostname: string
  port: number
  stop: () => Promise<void>
}

export interface StartServerOptions {
  server: ServerConfig
  auth: AuthConfig
  configPath: string
  fullConfig: Nine1BotConfig
}

/**
 * Nine1Bot 特有的配置字段（需要从 opencode 配置中过滤掉）
 */
const NINE1BOT_ONLY_FIELDS = ['server', 'auth', 'tunnel', 'isolation', 'skills', 'sandbox', 'browser', 'customProviders']
const LEGACY_BROWSER_MCP_MARKER = 'browser-mcp-server'
const LEGACY_BROWSER_BRIDGE_URL_MARKERS = ['127.0.0.1:18793', 'localhost:18793']

interface LegacyBrowserMcpEntry {
  name: string
  command: string[]
  bridgeUrl?: string
}

interface OpencodeConfigBuildResult {
  path: string
  ignoredLegacyBrowserMcp: LegacyBrowserMcpEntry[]
}

function protocolToNpm(protocol: CustomProvider['protocol']): string {
  return protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible'
}

function mapCustomProvidersToOpencode(customProviders: Nine1BotConfig['customProviders']) {
  const mapped: Record<string, any> = {}
  for (const [providerId, provider] of Object.entries(customProviders || {})) {
    mapped[providerId] = {
      name: provider.name,
      npm: protocolToNpm(provider.protocol),
      api: provider.baseURL,
      options: {
        baseURL: provider.baseURL,
        ...(provider.options || {}),
      },
      models: Object.fromEntries(
        provider.models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name || model.id,
            provider: {
              npm: protocolToNpm(provider.protocol),
            },
          },
        ]),
      ),
    }
  }
  return mapped
}

function getCommandParts(entry: unknown): string[] {
  const command = (entry as { command?: unknown })?.command
  if (!Array.isArray(command)) return []
  return command.filter((part): part is string => typeof part === 'string')
}

function isLegacyBrowserMcpEntry(name: string, entry: unknown): LegacyBrowserMcpEntry | null {
  if (!entry || typeof entry !== 'object') return null
  if ((entry as { type?: unknown }).type !== 'local') return null

  const command = getCommandParts(entry)
  if (!command.some((part) => part.includes(LEGACY_BROWSER_MCP_MARKER))) {
    return null
  }

  const bridgeUrl = typeof (entry as { environment?: Record<string, unknown> }).environment?.BRIDGE_URL === 'string'
    ? (entry as { environment?: Record<string, string> }).environment?.BRIDGE_URL
    : undefined

  return { name, command, bridgeUrl }
}

function isDeprecatedBrowserBridgeUrl(url: string): boolean {
  return LEGACY_BROWSER_BRIDGE_URL_MARKERS.some((marker) => url.includes(marker))
}

function warnAboutLegacyBrowserConfig(
  browserConfig: Nine1BotConfig['browser'] | undefined,
  ignoredLegacyBrowserMcp: LegacyBrowserMcpEntry[],
): void {
  if (browserConfig?.bridgePort !== undefined) {
    console.warn(
      '[Nine1Bot] browser.bridgePort is deprecated and ignored. Browser control is now built in at /browser on the main server.',
    )
  }

  for (const entry of ignoredLegacyBrowserMcp) {
    console.warn(
      `[Nine1Bot] Ignoring legacy browser MCP "${entry.name}" because browser control is built in. Use the built-in browser_* tools instead of browser_browser_*.`,
    )
    if (entry.bridgeUrl && isDeprecatedBrowserBridgeUrl(entry.bridgeUrl)) {
      console.warn(
        `[Nine1Bot] Legacy browser MCP "${entry.name}" uses BRIDGE_URL=${entry.bridgeUrl}, which is deprecated. The built-in browser bridge is now served from /browser on the main server.`,
      )
    }
  }

  if (ignoredLegacyBrowserMcp.length > 0 && browserConfig?.enabled !== true) {
    console.warn('[Nine1Bot] To keep browser control enabled, set "browser.enabled": true in your Nine1Bot config.')
  }
}

/**
 * 生成 opencode 兼容的配置文件
 * 过滤掉 nine1bot 特有的字段
 */
async function generateOpencodeConfig(config: Nine1BotConfig): Promise<OpencodeConfigBuildResult> {
  const opencodeConfig: Record<string, any> = {}
  const customProviders = mapCustomProvidersToOpencode(config.customProviders || {})
  const ignoredLegacyBrowserMcp: LegacyBrowserMcpEntry[] = []

  for (const [key, value] of Object.entries(config)) {
    if (!NINE1BOT_ONLY_FIELDS.includes(key)) {
      // 特殊处理 server 字段：只保留 opencode 认识的字段
      if (key === 'server') {
        const { openBrowser, ...rest } = value as any
        if (Object.keys(rest).length > 0) {
          opencodeConfig[key] = rest
        }
      }
      // 特殊处理 mcp 字段：过滤掉 nine1bot 特有的继承控制字段
      else if (key === 'mcp' && typeof value === 'object' && value !== null) {
        const { inheritOpencode, inheritClaudeCode, ...mcpServers } = value as any
        const filteredMcpServers = Object.fromEntries(
          Object.entries(mcpServers).filter(([name, entry]) => {
            const legacyEntry = isLegacyBrowserMcpEntry(name, entry)
            if (!legacyEntry) return true
            ignoredLegacyBrowserMcp.push(legacyEntry)
            return false
          }),
        )
        if (Object.keys(filteredMcpServers).length > 0) {
          opencodeConfig[key] = filteredMcpServers
        }
      }
      // 特殊处理 provider 字段：过滤掉 nine1bot 特有的继承控制字段
      else if (key === 'provider' && typeof value === 'object' && value !== null) {
        const { inheritOpencode, ...providers } = value as any
        const sanitizedProviders = Object.fromEntries(
          Object.entries(providers).map(([providerId, providerConfig]) => {
            if (!providerConfig || typeof providerConfig !== 'object') {
              return [providerId, providerConfig]
            }

            const { inheritOpencode: _ignored, ...rest } = providerConfig as Record<string, any>
            return [providerId, rest]
          }),
        )

        opencodeConfig[key] = { ...sanitizedProviders, ...customProviders }
      }
      else {
        opencodeConfig[key] = value
      }
    }
  }

  if (!opencodeConfig.provider && Object.keys(customProviders).length > 0) {
    opencodeConfig.provider = customProviders
  }

  // 写入临时文件（设置安全权限，仅当前用户可读写）
  const tempDir = resolve(tmpdir(), 'nine1bot')
  await mkdir(tempDir, { recursive: true, mode: 0o700 })
  const tempConfigPath = resolve(tempDir, 'opencode.config.json')
  await writeFile(tempConfigPath, JSON.stringify(opencodeConfig, null, 2), { mode: 0o600 })

  return {
    path: tempConfigPath,
    ignoredLegacyBrowserMcp,
  }
}

/**
 * 启动 OpenCode 服务器
 */
export async function startServer(options: StartServerOptions): Promise<ServerInstance> {
  const { server, auth, fullConfig } = options
  const installDir = getInstallDir()

  // 生成 opencode 兼容的配置文件（过滤掉 nine1bot 特有字段）
  const opencodeConfig = await generateOpencodeConfig(fullConfig)
  const opencodeConfigPath = opencodeConfig.path

  // 设置环境变量
  process.env.OPENCODE_CONFIG = opencodeConfigPath

  // 配置隔离：禁用全局或项目配置
  const isolation = fullConfig.isolation || {}
  if (isolation.disableGlobalConfig) {
    process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = 'true'
  }
  if (isolation.disableProjectConfig) {
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
  }
  // 如果不继承 opencode 配置，禁用 opencode 的全局和项目配置
  if (isolation.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = 'true'
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
  }

  // 如果启用了认证，设置密码
  if (auth.enabled && auth.password) {
    process.env.OPENCODE_SERVER_PASSWORD = auth.password
    process.env.OPENCODE_SERVER_USERNAME = 'nine1bot'
  }

  // Skills 配置：设置 Nine1Bot skills 目录
  process.env.NINE1BOT_SKILLS_DIR = getGlobalSkillsDir()
  // 设置内置 skills 目录（包含 /remember 等内置技能）
  process.env.NINE1BOT_BUILTIN_SKILLS_DIR = getBuiltinSkillsDir()
  const skills = fullConfig.skills || {}
  if (skills.inheritClaudeCode === false) {
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'true'
  }
  if (skills.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_OPENCODE_SKILLS = 'true'
  }

  // MCP 配置：继承控制
  const mcpConfig = fullConfig.mcp as any || {}
  if (mcpConfig.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_OPENCODE_MCP = 'true'
  }
  if (mcpConfig.inheritClaudeCode === false) {
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_MCP = 'true'
  }

  // 设置配置文件路径，供 MCP 热更新使用
  process.env.NINE1BOT_CONFIG_PATH = options.configPath

  // Provider 认证配置：继承控制
  const providerConfig = fullConfig.provider as any || {}
  if (providerConfig.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_OPENCODE_AUTH = 'true'
  }

  // 设置 Nine1Bot 独立的认证存储路径
  await mkdir(getGlobalConfigDir(), { recursive: true })
  process.env.NINE1BOT_AUTH_PATH = getAuthPath()
  await mkdir(getProjectEnvDir(), { recursive: true })
  process.env.NINE1BOT_PROJECT_ENV_DIR = getProjectEnvDir()

  // 设置偏好模块路径标志（仅用于检测 Nine1Bot 环境）
  process.env.NINE1BOT_PREFERENCES_MODULE = 'nine1bot'

  // 设置偏好文件路径（由 instruction.ts 定时读取）
  process.env.NINE1BOT_PREFERENCES_PATH = getGlobalPreferencesPath()

  // 设置项目目录（用于 opencode 的默认工作目录）
  // 注意：NINE1BOT_PROJECT_DIR 应该在 index.ts 入口处就设置好了
  // 这里只是一个后备方案
  if (!process.env.NINE1BOT_PROJECT_DIR) {
    process.env.NINE1BOT_PROJECT_DIR = process.cwd()
  }

  // 设置 web 资源目录（供 OpenCode server 提供静态文件）
  process.env.NINE1BOT_WEB_DIR = getWebDistDir()

  // 设置捆绑的 ripgrep 路径（发行版中 bin/rg）
  const rgPath = resolve(installDir, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
  process.env.OPENCODE_RIPGREP_PATH = rgPath

  warnAboutLegacyBrowserConfig(fullConfig.browser, opencodeConfig.ignoredLegacyBrowserMcp)

  // 初始化浏览器 Bridge（如果启用）
  // 必须在 OpencodeServer.listen() 之前完成，因为路由在 listen 时挂载
  let bridgeServer: BridgeServer | undefined
  const browserConfig = (fullConfig as any).browser
  if (browserConfig?.enabled) {
    try {
      bridgeServer = new BridgeServer({
        cdpPort: browserConfig.cdpPort ?? 9222,
        autoLaunch: browserConfig.autoLaunch ?? true,
        headless: browserConfig.headless ?? false,
      })
      await bridgeServer.start()
      setBridgeServer(bridgeServer)
      console.log('[Nine1Bot] Browser control enabled at /browser/')
    } catch (error: any) {
      console.warn(`[Nine1Bot] Failed to initialize browser bridge: ${error.message}`)
    }
  }

  // 使用静态导入的 OpenCode 服务器启动
  const serverInstance = await OpencodeServer.listen({
    port: server.port,
    hostname: server.hostname,
    cors: [],
  })

  return {
    url: serverInstance.url.toString(),
    hostname: serverInstance.hostname ?? server.hostname,
    port: serverInstance.port ?? server.port,
    stop: async () => {
      if (bridgeServer) {
        try { await bridgeServer.stop() } catch { /* ignore */ }
      }
      (serverInstance as any).server?.stop?.()
    },
  }
}
