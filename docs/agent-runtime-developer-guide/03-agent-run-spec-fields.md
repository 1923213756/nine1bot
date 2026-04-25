# AgentRunSpec 字段详细说明

## 1. 字段设计目标

`AgentRunSpec` 是 Nine1Bot Controller 和 Nine1Bot Runtime 之间的内部运行协议。它不应该只是现有 `/session/:id/message` 请求体的别名，而应该表达一次 agent 运行需要的关键事实：

- 这次运行来自哪个入口。
- 使用哪个会话、目录和项目。
- 用户输入是什么。
- 模型和 agent 如何确定。
- 本次会话拥有哪些 context blocks。
- 本次会话拥有哪些 tools / MCP / skills。
- 权限边界是什么。
- 是否启用多 agent 编排。
- 哪些字段是用户显式选择，哪些字段来自模板默认值。

字段必须有清晰所有权和生命周期。否则后续模板越多，越容易出现某个场景模板无意覆盖用户配置的情况。

## 2. 建议结构

```ts
type AgentRunSpec = {
  version: string
  capabilities?: CapabilitySpec
  session: SessionSpec
  entry: EntrySpec
  input: InputSpec
  model: ModelSpec
  agent: AgentSpec
  context: ContextSpec
  resources: ResourceSpec
  permissions: PermissionSpec
  orchestration: OrchestrationSpec
  runtime: RuntimeSpec
  audit?: AuditSpec
}

type CapabilitySpec = {
  client?: {
    agentSelection?: boolean
    modelOverride?: boolean
    pageContext?: boolean
    selectionContext?: boolean
    permissionAsk?: boolean
    debugPanel?: boolean
    orchestrationSelection?: boolean
    resourceFailureEvents?: boolean
  }
  server?: {
    protocolVersions: string[]
    contextEvents?: boolean
    resourceHealthEvents?: boolean
    sessionPermissionGrants?: boolean
    profileSnapshots?: boolean
  }
}
```

第一阶段可以不一次性全部落库，但字段语义应先固定。

一次用户消息真正执行时，还会从 `AgentRunSpec` 编译出 `TurnRuntimeSnapshot`。它不是新的对话历史，而是本轮 agent loop 开始前固定的运行输入快照，用来保证 loop 内 system/context/resource/permission 不漂移。完整流程见 [对话运行流程与上下文历史](./05-conversation-runtime-flow.md)。

协议必须带 `version`，入口和后端通过 `capabilities` 做能力协商。旧客户端可以继续按旧能力运行，新客户端再逐步启用 page context、selection context、debug panel 和资源失败事件。稳定性细节见 [运行时稳定性、能力协商与资源漂移](./06-runtime-stability-capability-drift.md)。

## 3. session

```ts
type SessionSpec = {
  id?: string
  directory?: string
  projectId?: string
  createIfMissing?: boolean
  lifecycle?: 'new' | 'existing'
  profileSnapshot?: SessionProfileSnapshot
}

type SessionProfileSnapshot = {
  id: string
  createdAt: number
  sourceTemplateIds: string[]
  agent: AgentSpec
  defaultModel: {
    providerID: string
    modelID: string
    source: 'default-user-template'
  }
  context: Pick<ContextSpec, 'blocks' | 'policy'>
  resources: ResourceSpec
  permissions: PermissionSpec
  sessionPermissionGrants?: SessionPermissionGrant[]
  orchestration?: OrchestrationSpec
}

type SessionPermissionGrant = {
  id: string
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  grantedAt: number
  expiresAt?: number
  source: 'permission-ask'
}
```

语义：

- `id` 指向现有 session。
- `directory` 是当前工作目录。
- `projectId` 是 Nine1Bot Runtime 识别出的项目。
- `createIfMissing` 表示 controller 可以创建新 session。
- `lifecycle` 用于审计这次请求是新会话还是旧会话继续。
- `profileSnapshot` 是会话创建时固化的运行档案快照，和会话记录一起持久化。
- `sessionPermissionGrants` 记录用户在权限请求中选择“本 session 都允许”的授权。

生命周期：

- 会话级字段。
- 不应该在同一 session 中频繁改变 `directory` 或 `projectId`。
- 如果入口需要切换项目，优先新建 session。
- 除模型选择外，后续继续对话默认使用创建 session 时的 `profileSnapshot`。
- 用户修改全局配置后，已有 session 不自动重编译 `profileSnapshot`。
- 用户选择“一次允许”的权限只影响当前 tool call；选择“本 session 都允许”的权限写入 `profileSnapshot.sessionPermissionGrants`，后续权限判断时放行。

## 4. entry

```ts
type EntrySpec = {
  source: 'web' | 'feishu' | 'browser-extension' | 'api'
  platform?: 'gitlab' | 'generic-browser' | 'feishu'
  mode?: string
  templateIds: string[]
  traceId?: string
}
```

语义：

- `source` 是接入入口。
- `platform` 是当前入口正在适配的平台。
- `mode` 是入口自己的模式，例如 `chat`、`agent`、`mr-review`。
- `templateIds` 记录参与本次编译的模板。
- `traceId` 用于 debug 和 timing trace。

限制：

- entry 只描述来源，不拥有 model。
- entry 可以带来上下文和资源需求，但不能偷偷覆盖用户模型或 agent。

## 5. input

```ts
type InputSpec = {
  parts: Array<TextInputPart | FileInputPart>
}
```

语义：

- 用户当前输入。
- 附件、图片、文件等也进入 `parts`。

生命周期：

- turn 级字段。
- 每轮都可能不同。

限制：

- input 只表达用户输入，不承担系统上下文。
- 平台采集到的页面信息不应塞进用户 text，而应变成 context block。

## 6. model

```ts
type ModelSpec = {
  providerID: string
  modelID: string
  source: 'profile-snapshot' | 'session-choice' | 'runtime-override'
}
```

所有权：

- 默认模型来自会话创建时的 `profileSnapshot`。
- 会话中的当前模型可以来自用户显式 `session-choice`。
- 单次运行的临时模型可以来自显式 runtime override，例如用户在某个接入点临时选择的模型。

明确禁止：

- product template 不选择模型。
- platform template 不选择模型。
- adapter 不根据平台偷偷改模型。

生命周期：

- 默认值在 session 创建时进入 `profileSnapshot`。
- 模型是少数允许在同一个 session 中切换的字段。
- 如果 UI 支持会话内模型切换，它必须作为显式 `session-choice` 被记录和审计。
- 如果入口只支持单次临时模型选择，它必须作为显式 runtime override 被记录和审计。
- 模型切换不重编译 agent、MCP、skills、permissions 等 session profile 字段。

说明：

模型切换本身不一定改变底部提示词，但它会影响成本、能力和 provider 行为，所以也必须来源清晰。

## 7. agent

```ts
type AgentSpec = {
  name: string
  source: 'default-user-template' | 'session-choice' | 'internal-runtime'
  recommendedAgent?: string
}
```

所有权：

- 默认 agent 来自用户配置的 `default_agent`。
- 条件允许的入口应显式展示当前 agent。
- 用户在会话开始时选择的 agent 是 `session-choice`，优先级高于默认 agent。
- `recommendedAgent` 只用于 UI 推荐，不自动覆盖当前 agent。
- `internal-runtime` 仅用于 summary、title、compaction 等内部任务。

生命周期：

- agent 是会话级字段。
- 不允许每轮切换。

原因：

- agent 可能改变底部提示词、权限、工具集和行为模式。
- 每轮切换 agent 会破坏上下文一致性，也会降低 LLM 推理缓存利用率。
- 如果用户确实要换 agent，应新建 session，或显式重开一段运行上下文。

## 8. context

```ts
type ContextSpec = {
  blocks: ContextBlock[]
  policy?: {
    tokenBudget?: number
    debug?: boolean
  }
}

type ContextBlock = {
  id: string
  layer: 'base' | 'project' | 'user' | 'business' | 'platform' | 'page' | 'runtime' | 'turn'
  source: string
  enabled: boolean
  priority: number
  lifecycle: 'session' | 'active' | 'turn' | 'loop'
  visibility: 'system-required' | 'developer-toggle' | 'user-toggle'
  mergeKey?: string
  digest?: string
  observedAt?: number
  staleAfterMs?: number
  content: string | {
    resolver: string
    params?: Record<string, unknown>
  }
}
```

所有权：

- 用户配置的 `instructions` 应编译为 `user` layer block。
- AGENTS.md / CLAUDE.md / 项目信息应编译为 `project` layer block。
- 用户偏好应编译为 `user` layer block。
- 平台信息应编译为 `platform` 或 `page` layer block。
- 入口约束应编译为 `runtime` layer block。

生命周期：

- `base`、`project`、`user`、`business` 多数是 session 级。
- `platform` 和当前页面对象可以是 active 级，表示它会跨多轮保留，直到用户切换到新的平台对象。
- `page`、`turn` 多数是 turn 级。
- loop 级 block 只用于本轮 agent loop 内的运行约束和审计，不应该写成长期历史。
- 动态页面状态可以作为 context event 写入历史，但不能混进用户 text。
- `mergeKey` / `digest` 用于判断同一页面状态是否重复，避免连续对话时反复插入相同页面上下文。

实现要求：

- instructions / context 应尽早重构为 pipeline。
- 第一阶段可以保留兼容编译输出到现有 `system: string[]`。
- 但 debug 层必须能看到每个 block 的来源、layer、enabled 状态。
- page / selection / platform object 这类上下文应通过 synthetic context event 进入 history，并通过 page key / digest 去重。
- page context 不应由客户端后台实时推送并写入 history；它应在发送用户请求时携带或由后端按请求触发采集。

## 9. resources

```ts
type ResourceSpec = {
  builtinTools: BuiltinToolSpec
  mcp: McpResourceSpec
  skills: SkillResourceSpec
}
```

resources 是本次会话可用能力的集合。第一阶段建议在会话开始时固定，避免每轮变化。

## 10. builtinTools

```ts
type BuiltinToolSpec = {
  enabledGroups?: string[]
  enabledTools?: string[]
}
```

语义：

- Runtime 内置工具能力，例如 read、grep、bash、edit、browser、terminal 等。
- 第一阶段可以先以现有 agent permission 和 tool registry 为准。

限制：

- 不建议让入口每轮动态切工具。
- 如果需要安全限制，优先通过 permissions 收紧。

## 11. mcp

```ts
type McpResourceSpec = {
  servers: string[]
  tools?: Record<string, string[]>
  lifecycle: 'session'
  mergeMode: 'additive-only'
  availability?: Record<string, ResourceAvailability>
}

type ResourceAvailability = {
  declared: boolean
  status: 'unknown' | 'available' | 'degraded' | 'unavailable' | 'auth-required'
  checkedAt?: number
  error?: string
}
```

所有权：

- 用户配置和继承配置形成默认 MCP 池。
- 产品模板和平台模板只能增加 MCP 需求。
- 用户在会话开始时可以显式增加可用 MCP。

第一阶段限制：

- 只支持合并增加。
- 不支持模板排除 MCP。
- 不支持模板减少 MCP tools。
- 不支持每轮切换 MCP。

重要边界：

- 用户持久配置中明确关闭的继承来源不能被模板静默重新启用。
- 如果模板需要某个 MCP，但用户没有配置或授权，应降级运行并在 debug 中说明缺失原因。
- `profileSnapshot` 只表示 MCP 被声明为本 session 可用；实际连接、OAuth、健康检查和 tool call 可能漂移。
- 当 MCP 实际失败时，服务端应通过 runtime/SSE 事件通知客户端，并在 UI 中展示给用户。

## 12. skills

```ts
type SkillResourceSpec = {
  skills: string[]
  lifecycle: 'session'
  mergeMode: 'additive-only'
  availability?: Record<string, ResourceAvailability>
}
```

所有权：

- 用户配置和继承策略形成默认 skills 池。
- 产品模板和平台模板只能增加推荐或需要的 skills。
- 用户在会话开始时可以显式增加 skills。

第一阶段限制：

- 只支持合并增加。
- 不支持模板排除 skills。
- 不支持每轮切换 skills。

说明：

后续可以加入 `exclude` 或按场景关闭能力，但第一阶段先保持兼容和可预测。

skills 和 MCP 一样，需要区分“被 session profile 声明可用”和“当前实际可用”。缺失文件、加载失败、运行时依赖缺失等情况应进入 availability，并通过事件通知客户端。

## 13. permissions

```ts
type PermissionSpec = {
  rules: Record<string, unknown>
  source: string[]
  mergeMode: 'strict'
  sessionGrants?: SessionPermissionGrant[]
}
```

语义：

- 权限控制工具能否读、写、执行、访问外部目录、提问等。

原则：

- 用户配置是基础权限。
- 场景模板可以收紧权限。
- 场景模板不能静默放宽用户 deny。
- 放宽权限必须来自用户显式选择。

生命周期：

- 基础权限建议在 session 开始时确定。
- 单次 tool call 的 permission ask 是 runtime 交互，不等同于修改 profile。
- 如果用户在 permission ask 中选择“本 session 都允许”，则把授权写入 `profileSnapshot.sessionPermissionGrants`，并合并到后续权限判断。
- 如果用户选择“一次允许”，只对当前 tool call 生效，不写入 profile。

## 14. orchestration

```ts
type OrchestrationSpec =
  | { mode: 'single' }
  | { mode: 'plan-then-act'; planner?: string; executor?: string }
  | { mode: 'parallel-review'; reviewers?: WorkerSpec[] }
  | { mode: 'supervisor-workers'; workers?: WorkerSpec[] }
```

所有权：

- 用户可以在支持的入口选择模式。
- 产品模板和平台模板可以提供推荐模式。
- 推荐模式不应无提示覆盖用户选择。

生命周期：

- run/session 级字段。
- 不建议作为每轮隐藏变化。

## 15. runtime

```ts
type RuntimeSpec = {
  streaming?: boolean
  noReply?: boolean
  debug?: boolean
  timing?: boolean
  timeoutMs?: number
  turnSnapshotId?: string
}
```

语义：

- 控制本次运行的执行方式和观测方式。
- `turnSnapshotId` 用于关联本轮编译出的 `TurnRuntimeSnapshot`，便于 debug 和复现。

所有权：

- 入口可以要求 streaming 或 noReply。
- 用户或开发者可以开启 debug / timing。

限制：

- runtime 字段不应承载业务上下文。
- runtime override 必须被 audit 记录。

## 16. audit

```ts
type AuditSpec = {
  protocolVersion?: string
  capabilityNegotiation?: CapabilitySpec
  templates: string[]
  modelSource: string
  agentSource: string
  profileSnapshotId?: string
  turnSnapshotId?: string
  contextBlocks: Array<{ id: string; source: string; enabled: boolean }>
  resources: {
    mcp: string[]
    skills: string[]
    builtinTools?: string[]
  }
  permissionSources: string[]
  resourceFailures?: Array<{ type: 'mcp' | 'skill'; id: string; status: string; error?: string }>
}
```

目标：

- 让用户和开发者知道本轮 agent 为什么拥有这些上下文和能力。
- 支持 debug 面板。
- 支持兼容性回归测试。

第一阶段可以先返回 JSON debug 信息，不必立刻做完整 UI。
