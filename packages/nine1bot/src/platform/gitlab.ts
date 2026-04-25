import { createGitLabPlatformAdapter } from '@nine1bot/platform-gitlab/runtime'
import { RuntimePlatformAdapterRegistry } from '../../../../opencode/packages/opencode/src/runtime/platform/adapter'

let registered = false

export function registerGitLabPlatformAdapter() {
  if (registered) return
  RuntimePlatformAdapterRegistry.register(createGitLabPlatformAdapter())
  registered = true
}
