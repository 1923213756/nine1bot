# Controller API 与 Runtime Event 协议

## 1. 目标

本文定义 Nine1Bot Controller 和 Nine1Bot Runtime 的对接 API，以及 runtime event 的统一 envelope。

目标是让 Web、Feishu、浏览器插件、GitLab adapter、外部 API 都使用同一套内部协议，而不是各入口继续直接调用历史 session 接口并各自解释事件。

## 2. 协议原则

- API 面向 Nine1Bot Controller，不直接暴露 Runtime 内部实现细节。
- 所有新入口都提交结构化请求，而不是拼接 system prompt。
- 所有 response 和 event 都带 protocol version。
- 客户端能力通过 capabilities 协商，不要求所有入口一次支持完整功能。
- runtime event 是用户可见状态和 debug 的来源，不能只写日志。
- 旧 API 过渡期保留，但内部走 adapter 转成新协议。

## 3. 能力协商

### 3.1 获取服务端能力

```http
GET /nine1bot/runtime/capabilities
```

返回：

```ts
type RuntimeCapabilitiesResponse = {
  version: 'agent-runtime/v1'
  server: {
    protocolVersions: string[]
    contextEvents: boolean
    resourceHealthEvents: boolean
    sessionPermissionGrants: boolean
    profileSnapshots: boolean
    debugAudit: boolean
  }
}
```

### 3.2 客户端能力

客户端在创建 session 或发送消息时带：

```ts
type ClientCapabilities = {
  agentSelection?: boolean
  modelOverride?: boolean
  pageContext?: boolean
  selectionContext?: boolean
  permissionAsk?: boolean
  debugPanel?: boolean
  orchestrationSelection?: boolean
  resourceFailureEvents?: boolean
}
```

服务端根据客户端能力决定：

- 是否发送 permission ask。
- 是否发送 resource failure event。
- 是否接收 page context。
- 是否返回 debug audit。
- 是否提示用户转到 Web 继续。

## 4. 模板解析 API

```http
POST /nine1bot/agent/templates/resolve
```

用途：

- 给入口展示可选 agent、推荐 agent、可选 orchestration。
- 展示用户当前默认配置会如何应用。
- 不创建 session，不冻结 profileSnapshot。

请求：

```ts
type ResolveTemplatesRequest = {
  version: 'agent-runtime/v1'
  entry: EntrySpec
  clientCapabilities?: ClientCapabilities
  page?: RequestPagePayload
}
```

返回：

```ts
type ResolveTemplatesResponse = {
  version: 'agent-runtime/v1'
  templateIds: string[]
  defaultAgent: AgentSpec
  recommendedAgent?: string
  defaultModel: ModelSpec
  availableAgents?: AgentSpec[]
  recommendedOrchestration?: OrchestrationSpec
  contextPreview?: Array<{ id: string; layer: string; enabled: boolean }>
  resourcesPreview?: {
    builtinTools?: string[]
    mcp?: string[]
    skills?: string[]
  }
}
```

注意：

- `recommendedAgent` 不等于最终 agent。
- 模板解析不能改变会话状态。
- 模板解析不能替用户选择模型。

## 5. 创建 session API

```http
POST /nine1bot/agent/sessions
```

请求：

```ts
type CreateAgentSessionRequest = {
  version: 'agent-runtime/v1'
  entry: EntrySpec
  clientCapabilities?: ClientCapabilities
  directory?: string
  projectId?: string
  sessionChoice?: {
    agent?: string
    model?: { providerID: string; modelID: string }
    orchestration?: OrchestrationSpec
    resources?: Partial<ResourceSpec>
    contextToggles?: Record<string, boolean>
  }
  page?: RequestPagePayload
  debug?: boolean
}
```

返回：

```ts
type CreateAgentSessionResponse = {
  version: 'agent-runtime/v1'
  sessionId: string
  profileSnapshotId: string
  agent: AgentSpec
  model: ModelSpec
  orchestration: OrchestrationSpec
  audit?: ProfileSnapshotAudit
}
```

创建 session 时冻结：

- agent
- default model
- session context blocks
- MCP / skills / builtin resources
- baseline permissions
- orchestration baseline

## 6. 发送消息 API

```http
POST /nine1bot/agent/sessions/:id/messages
```

请求：

```ts
type SendAgentMessageRequest = {
  version: 'agent-runtime/v1'
  clientCapabilities?: ClientCapabilities
  input: InputSpec
  page?: RequestPagePayload
  runtimeOverride?: {
    model?: { providerID: string; modelID: string }
    orchestration?: OrchestrationSpec
    debug?: boolean
    timing?: boolean
  }
}
```

返回：

```ts
type SendAgentMessageResponse = {
  version: 'agent-runtime/v1'
  sessionId: string
  turnSnapshotId: string
  streamId?: string
  accepted: boolean
  busy?: boolean
  audit?: TurnSnapshotAudit
}
```

busy 时返回：

```ts
type BusyRejectResponse = {
  version: 'agent-runtime/v1'
  accepted: false
  busy: true
  message: string
}
```

busy reject 必须发生在写 context event 和 user message 之前。

## 7. 模型切换 API

```http
POST /nine1bot/agent/sessions/:id/model
```

请求：

```ts
type ChangeSessionModelRequest = {
  version: 'agent-runtime/v1'
  model: {
    providerID: string
    modelID: string
  }
}
```

返回：

```ts
type ChangeSessionModelResponse = {
  version: 'agent-runtime/v1'
  sessionId: string
  model: ModelSpec
}
```

模型切换只更新当前 session model，不重编译 profileSnapshot。

## 8. 权限回答 API

```http
POST /nine1bot/agent/permissions/:requestId/answer
```

请求：

```ts
type PermissionAnswerRequest = {
  version: 'agent-runtime/v1'
  answer: 'allow-once' | 'allow-session' | 'deny'
}
```

规则：

- `allow-once` 只影响当前 tool call。
- `allow-session` 写入 `profileSnapshot.sessionPermissionGrants`。
- `deny` 不写入 grant。
- hard deny 不能被 allow 覆盖。

## 9. Debug API

```http
GET /nine1bot/agent/sessions/:id/debug?turnSnapshotId=...
```

返回：

```ts
type RuntimeDebugResponse = {
  version: 'agent-runtime/v1'
  sessionId: string
  profileSnapshot?: SessionProfileSnapshot
  turnSnapshot?: TurnRuntimeSnapshot
  contextAudit?: unknown
  resourceAudit?: ResourceAudit
  permissionAudit?: unknown
  events?: RuntimeEventEnvelope[]
}
```

不支持 debug panel 的客户端可以不调用该 API。

## 10. Runtime Event Envelope

所有 runtime event 使用统一 envelope：

```ts
type RuntimeEventEnvelope<T = unknown> = {
  version: 'agent-runtime/v1'
  id: string
  type: RuntimeEventType
  sessionId: string
  turnSnapshotId?: string
  createdAt: number
  data: T
}

type RuntimeEventType =
  | 'runtime.turn.started'
  | 'runtime.context.event'
  | 'runtime.context.compiled'
  | 'runtime.resources.resolved'
  | 'runtime.resource.failed'
  | 'runtime.permission.requested'
  | 'runtime.permission.answered'
  | 'runtime.model.changed'
  | 'runtime.message.delta'
  | 'runtime.message.completed'
  | 'runtime.turn.completed'
  | 'runtime.turn.failed'
```

## 11. 关键事件

### 11.1 resource failed

```ts
type ResourceFailedData = {
  resourceType: 'mcp' | 'skill'
  resourceID: string
  status: 'degraded' | 'unavailable' | 'auth-required'
  stage: 'resolve' | 'connect' | 'auth' | 'load' | 'execute'
  message: string
  recoverable: boolean
  action?: {
    type: 'open-settings' | 'start-auth' | 'retry' | 'continue-in-web'
    label: string
  }
}
```

Web 应通过 SSE 展示。Feishu 如果不支持完整交互，可以发简短提示或引导到 Web。

### 11.2 permission requested

```ts
type PermissionRequestedData = {
  requestId: string
  toolName: string
  permission: string
  reason?: string
  options: Array<'allow-once' | 'allow-session' | 'deny'>
  fallbackAction?: {
    type: 'continue-in-web'
    label: string
  }
}
```

如果客户端不支持 permission ask，服务端应发送 fallback action，不要静默失败。

### 11.3 context event

```ts
type ContextEventData = {
  contextEventId: string
  action: 'inserted' | 'deduped'
  eventType?: 'page-enter' | 'page-update' | 'selection-update'
  pageKey?: string
  digest?: string
  summary?: string
}
```

`deduped` 默认只进 debug，不需要作为显眼用户消息展示。

### 11.4 resources resolved

```ts
type ResourcesResolvedData = {
  builtinTools: string[]
  mcpTools: string[]
  skills: string[]
  unavailable?: Array<{ type: 'mcp' | 'skill'; id: string; status: string }>
}
```

用于 debug 面板，不建议普通 UI 每轮打扰用户。

## 12. SSE 通道

建议：

```http
GET /nine1bot/agent/sessions/:id/events
```

SSE event name 使用 envelope 的 `type`。

示例：

```text
event: runtime.resource.failed
data: {"version":"agent-runtime/v1","id":"...","sessionId":"...","data":{...}}
```

客户端如果断线：

- 可以通过 debug API 补拉 events。
- message stream 不应依赖 resource failure event 才能完成。

## 13. 入口能力差异

### Web

Web 应支持：

- agent selection
- model override
- permission ask
- resource failure events
- debug panel
- context/resource audit

### Feishu

Feishu 可先支持：

- 普通 message
- busy reject
- 简短 resource failure 文本
- permission fallback 到 Web

Feishu 不需要第一阶段展示完整 debug。

### 浏览器插件

浏览器插件应支持：

- page context
- selection context
- resource failure 简短提示
- 跳转 Web 处理权限或授权

### API

API 客户端通过 capabilities 自行声明支持能力。服务端按最小能力降级。

## 14. 兼容旧接口

旧接口保留期间：

- 旧 create session 转成 `CreateAgentSessionRequest`。
- 旧 send message 转成 `SendAgentMessageRequest`。
- 旧 stream event 转成 runtime event envelope。
- 旧 permission ask 转成 `runtime.permission.requested`。

旧接口不再新增新特性。新特性只进入 Controller API。

## 15. Web 既有 API 兼容边界

Web 端现有 API 不需要全部纳入 `AgentRunSpec` 协议。需要区分两类接口。

### 15.1 配置类 API

配置类 API 尽量保持原样，例如：

- MCP 配置读取和保存。
- skills 配置读取和保存。
- provider / model 配置读取和保存。
- auth 状态和认证流程。
- 用户偏好。
- 用户 instructions。
- 项目级配置。

这些接口仍然面向配置文件或配置存储。Web 配置页继续通过这些接口管理用户配置，不直接编辑 `profileSnapshot`，也不直接生成 `AgentRunSpec`。

runtime 协议通过 `default-user-template` compiler 消费这些配置：

```text
config APIs -> config files
config files -> default-user-template
default-user-template -> profileSnapshot at session create
profileSnapshot -> AgentRunSpec at message run
```

规则：

- 保存配置不自动修改已有 session 的 `profileSnapshot`。
- 保存配置只影响后续新建 session。
- 配置 API 不返回完整 runtime snapshot。
- 配置 API 不触发 resource resolver。
- 配置 API 不触发 legacy session migration。

这样用户配置操作和 agent 运行协议解耦，Web 配置页可以保持当前交互模型。

### 15.2 会话列表 API

会话列表可以兼容扩展，但必须保持轻量只读。

建议接口：

```http
GET /nine1bot/agent/sessions
```

也可以先复用现有会话列表接口，在 response item 中增加可选 `runtime` 字段。

```ts
type AgentSessionListItem = LegacySessionListItem & {
  runtime?: {
    protocolVersion?: 'agent-runtime/v1'
    hasProfileSnapshot: boolean
    profileSnapshotId?: string
    profileSource?: 'new-session' | 'legacy-resumed'
    agent?: string
    currentModel?: {
      providerID: string
      modelID: string
      source: 'profile-snapshot' | 'session-choice'
    }
    entry?: {
      source?: string
      platform?: string
    }
    status?: 'idle' | 'busy' | 'archived'
    lastPage?: {
      pageKey?: string
      summary?: string
    }
  }
}
```

会话列表只返回摘要，不返回完整 `profileSnapshot`。原因：

- profileSnapshot 可能较大。
- profileSnapshot 可能包含权限、路径、资源和上下文摘要。
- 列表页只需要展示 agent、模型、入口、busy、最近页面等轻量信息。

### 15.3 会话列表禁止触发迁移

`list sessions` 必须是只读操作，禁止产生运行时副作用：

- 不生成 `legacy-resumed` profileSnapshot。
- 不调用 `default-user-template` compiler。
- 不解析 MCP / skills availability。
- 不写 context event。
- 不更新 `lastInjectedPageState`。
- 不修复或补全旧 session metadata。

旧 session 没有 profileSnapshot 时，列表只返回：

```ts
runtime: {
  hasProfileSnapshot: false
}
```

真正的 legacy migration 只在用户继续发送消息时发生，并且必须在 busy reservation 成功后执行。

### 15.4 详情和 debug

如果 Web 需要查看某个 session 的完整 runtime 信息，应调用专门的 debug API：

```http
GET /nine1bot/agent/sessions/:id/debug?turnSnapshotId=...
```

不要把完整 profileSnapshot 塞进列表 API。

## 16. 验收用例

1. Web 可以通过新 API 创建 session 并得到 profileSnapshotId。
2. Web 发送消息得到 turnSnapshotId。
3. busy 时返回 accepted false，且不写 user message。
4. 模型切换 API 不改变 profileSnapshot。
5. permission allow-session 会写入 session grant。
6. resource failure 通过 SSE 到达 Web。
7. Feishu 不支持 permission ask 时收到 continue-in-web action。
8. 浏览器插件发送 page payload 后产生 context event。
9. 同一 page payload 重复发送时返回 deduped audit。
10. 旧 `/session/:id/message` 仍可工作，但 debug 显示 legacy adapter。
11. MCP / skills / auth / preferences 配置 API 保持配置文件语义，不生成 runtime snapshot。
12. 会话列表 API 对旧 session 只返回 `hasProfileSnapshot: false`，不触发 legacy migration。
13. 会话列表 API 不返回完整 profileSnapshot。
