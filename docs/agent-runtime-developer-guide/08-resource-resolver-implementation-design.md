# Resource Resolver 实现设计

## 1. 定位

本文描述 `Resource Resolver` 的实现方案。这里的 runtime 指 `Nine1Bot Runtime`，即现有 `opencode/` 代码经过重构后形成的 Nine1Bot 自有 agent runtime 组件。

Resource Resolver 的职责是把会话声明的资源 profile 转换成本轮 agent loop 实际可用的能力集合，并清楚解释：

- 哪些 builtin tools 可用。
- 哪些 MCP server / MCP tools 被声明。
- 哪些 MCP server / MCP tools 实际可用。
- 哪些 skills 被声明。
- 哪些 skills 实际可用。
- 哪些权限规则生效。
- 哪些资源失败需要通知用户。

它不是产品模板系统，也不是平台 adapter。模板和 adapter 只声明资源需求；resolver 负责把声明变成 runtime 可执行对象。

## 2. 设计目标

第一阶段要做到：

- 会话开始时冻结声明资源。
- MCP / skills 只做增量合并，不做排除或减少。
- 不允许每轮切换 MCP / skills。
- 区分 declared resources 和 actual availability。
- 避免 MCP preflight 阻塞每次对话关键路径。
- 权限包装在 tool 暴露给 agent loop 前完成。
- MCP / skill 实际失败时发送 resource failure event。
- audit 能解释资源来源、缺失原因和权限收紧原因。

非目标：

- 第一阶段不做模板级 resource exclude。
- 第一阶段不做复杂资源市场或自动安装。
- 第一阶段不让平台 adapter 直接创建 runtime tool。
- 第一阶段不在 agent loop 中途重编译资源集合。

## 3. 模块边界

### 3.1 Controller Resource Policy Builder

Controller 侧负责把用户配置、项目配置、模板和 session choice 合并成 `profileSnapshot.resources`：

- 读取默认用户配置中的 tools / MCP / skills。
- 应用项目和入口模板的增量资源需求。
- 应用用户在创建 session 时显式选择的资源。
- 尊重用户关闭的继承来源。
- 把结果持久化进 `profileSnapshot`。

Controller 不负责连接 MCP、加载 skill、包装权限。

### 3.2 Runtime Resource Resolver

Runtime 侧负责把 `profileSnapshot.resources` 解析为 `ResolvedResources`：

- 查找 builtin tool registry。
- 查找 MCP server registry。
- 查找 skill registry。
- 判断实际 availability。
- 生成可调用 tool 列表。
- 应用 permission runtime。
- 输出 resource audit。
- 发出 resource failure event。

### 3.3 Permission Runtime

Permission Runtime 是 resolver 的下游保护层：

- 用户 deny 永远优先。
- 模板只能收紧权限。
- session grant 只影响当前 session。
- “只允许本次”只影响当前 tool call。
- tool 暴露给 LLM 前必须先包装 permission gate。

## 4. 核心类型

### 4.1 ResourceSpec

```ts
type ResourceSpec = {
  builtinTools: BuiltinToolSpec
  mcp: McpResourceSpec
  skills: SkillResourceSpec
}

type BuiltinToolSpec = {
  enabledGroups?: string[]
  enabledTools?: string[]
}

type McpResourceSpec = {
  servers: string[]
  tools?: Record<string, string[]>
  lifecycle: 'session'
  mergeMode: 'additive-only'
  availability?: Record<string, ResourceAvailability>
}

type SkillResourceSpec = {
  skills: string[]
  lifecycle: 'session'
  mergeMode: 'additive-only'
  availability?: Record<string, ResourceAvailability>
}
```

`ResourceSpec` 是声明，不代表资源已经连接成功或可以调用。

### 4.2 ResolvedResources

```ts
type ResolvedResources = {
  builtinTools: Record<string, ResolvedTool>
  mcpTools: Record<string, ResolvedTool>
  skills: Record<string, ResolvedSkill>
  permissions: EffectivePermissionProfile
  availability: Record<ResourceKey, ResourceAvailability>
  failures: ResourceFailureEvent[]
  audit: ResourceAudit
}

type ResourceKey = `${'builtin' | 'mcp' | 'skill'}:${string}`

type ResolvedTool = {
  id: string
  source: 'builtin' | 'mcp'
  displayName: string
  callable: unknown
  permission: ToolPermissionRequirement
  availability: ResourceAvailability
}

type ResolvedSkill = {
  id: string
  source: string
  instructions?: string
  contextBlocks?: string[]
  availability: ResourceAvailability
}
```

`ResolvedResources` 是本轮 `TurnRuntimeSnapshot` 引用的资源解析结果。agent loop 内复用同一份结果，不在 step 之间自动重新解析。

### 4.3 ResourceAvailability

```ts
type ResourceAvailability = {
  declared: boolean
  status: 'unknown' | 'available' | 'degraded' | 'unavailable' | 'auth-required'
  checkedAt?: number
  error?: string
}
```

语义：

- `declared` 表示 profileSnapshot 中声明了该资源。
- `unknown` 表示尚未检查或采用 lazy check。
- `available` 表示可正常使用。
- `degraded` 表示部分能力可用。
- `unavailable` 表示不可用。
- `auth-required` 表示需要用户授权或重新认证。

### 4.4 ResourceFailureEvent

```ts
type ResourceFailureEvent = {
  type: 'runtime.resource.failed'
  properties: {
    sessionID: string
    turnSnapshotId?: string
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
}
```

该事件通过 runtime event bus 发出。Web 用 SSE 展示，Feishu 可以转成简短文本，浏览器插件可以显示浮层或调试提示。

## 5. 会话创建时的资源合并

资源合并发生在创建 session 并生成 `profileSnapshot` 时。

### 5.1 合并顺序

```ts
profileResources =
  compile(defaultUserTemplate.resources)
  |> add(projectTemplate.resources)
  |> add(entryTemplate.resources)
  |> add(sessionChoice.resources)
  |> freezeAtSessionCreate()
```

### 5.2 MCP 合并

```ts
effectiveMcpServers = union([
  ...defaultUserTemplate.mcp.servers,
  ...projectTemplate.mcp.addServers,
  ...entryTemplate.mcp.addServers,
  ...sessionChoice.mcp.addServers,
])
```

规则：

- 只做 union。
- 不做 exclude。
- 不做 per-turn add。
- 用户关闭的继承来源不能被模板重新打开。
- 用户显式禁用的 MCP server 不能被模板静默重新启用。

### 5.3 skills 合并

```ts
effectiveSkills = union([
  ...defaultUserTemplate.skills,
  ...projectTemplate.skills.add,
  ...entryTemplate.skills.add,
  ...sessionChoice.skills.add,
])
```

规则同 MCP：

- 只做 union。
- 不做 exclude。
- 不做 per-turn add。
- 尊重用户关闭的继承来源。

### 5.4 builtin tools 合并

builtin tools 第一阶段也尽量 session 级固定：

- 用户默认配置形成 baseline。
- 模板可以增加 tool group。
- 安全限制通过 permissions 收紧。
- 不建议入口每轮改变 tool 集合。

## 6. 每轮资源解析流程

每轮开始 agent loop 前，runtime 根据 `profileSnapshot.resources` 解析资源。

### 6.1 读取声明资源

输入：

- `profileSnapshot.resources`
- `profileSnapshot.permissions`
- `profileSnapshot.sessionPermissionGrants`
- 本轮 runtime options
- 客户端 capability

此阶段不读取新的用户全局配置，避免旧 session 漂移。

### 6.2 解析 builtin tools

步骤：

1. 从 builtin tool registry 读取所有可注册工具。
2. 根据 `enabledGroups` 和 `enabledTools` 取并集。
3. 应用 permission profile。
4. 输出 wrapped tools。

如果某个 builtin tool 不存在：

- 标为 `unavailable`。
- 写入 audit。
- 一般不阻断对话。

### 6.3 解析 MCP 声明

MCP 解析分两层：

- declaration resolve：确认 server 配置是否存在。
- availability check：确认当前是否能连接、认证和列工具。

为了避免每次对话在关键路径上被 MCP preflight 卡住，第一阶段建议：

- 不在每次 message 前做全量阻塞 preflight。
- 对已知 server 使用短 TTL health cache。
- 对未知状态先标为 `unknown`，在首次需要工具或后台 health check 时确认。
- 对模板强依赖的 server 可以做短超时检查，但失败后降级而不是长时间阻塞。
- 业务平台专项 preflight 不应放在 runtime core 里。

MCP server 状态处理：

| 情况 | availability | 行为 |
| --- | --- | --- |
| 配置不存在 | `unavailable` | audit + resource failure |
| 进程启动失败 | `unavailable` | audit + resource failure |
| OAuth 过期 | `auth-required` | event action 指向授权 |
| list tools 失败 | `degraded` 或 `unavailable` | 视是否有部分工具可用 |
| tool call 执行失败 | 更新状态 | 发送 execute 阶段 failure event |

### 6.4 解析 skills 声明

skills 解析步骤：

1. 从 skill registry 查找 skill。
2. 读取 skill metadata。
3. 检查入口文件和必要资源是否存在。
4. 将 skill instructions 或 context refs 暴露给 Context Pipeline。
5. 将 skill runtime capability 暴露给 agent loop。

如果 skill 加载失败：

- 标为 `unavailable`。
- 发送 resource failure event。
- 继续普通对话。

skills 不能在本轮运行中临时新增。需要新增 skill 时，应创建新 session 或显式重开运行上下文。

### 6.5 应用 Permission Runtime

权限处理顺序：

1. runtime hard deny。
2. 用户配置 deny。
3. 模板 restrict。
4. session grants。
5. 本次 permission ask 的 once grant。
6. 默认 ask / allow 策略。

规则：

- hard deny 永远不能被 grant 覆盖。
- 用户 deny 不能被模板放宽。
- session grant 只属于当前 session。
- once grant 不写入 `profileSnapshot`。
- permission gate 必须包在最终 callable 外层。

输出：

- 可直接调用的 tools。
- 需要 ask 的 tools。
- 被 deny 或隐藏的 tools。
- permission audit。

### 6.6 生成 TurnRuntimeSnapshot 引用

资源解析结果写入本轮 snapshot：

```ts
type TurnRuntimeSnapshotResources = {
  resolvedResourceId: string
  builtinToolIds: string[]
  mcpToolIds: string[]
  skillIds: string[]
  availability: Record<ResourceKey, ResourceAvailability>
  permissionProfileId: string
}
```

agent loop 只引用该结果，不在 step 之间重新解析。

## 7. 失败与降级策略

Resource Resolver 的默认策略是“资源失败不等于对话失败”。

除非用户请求本身必须依赖某个资源，否则普通 LLM 对话应继续运行，并把失败明确告诉用户。

降级规则：

- MCP 不可用：移除对应 MCP tools，发送 resource failure event。
- MCP auth-required：移除对应 tools，提示用户授权。
- skill 不可用：不注入该 skill instructions，发送 resource failure event。
- builtin tool 不存在：移除该 tool，写 audit。
- permission deny：不暴露或包装为 deny，必要时向用户解释。
- permission ask 入口不支持：发送继续到 Web 的 action。

事件去重：

- 同一个 resource 在同一 turn 内相同 status 只发一次。
- status 变化时可以再次发送。
- tool call execute 阶段失败可以再次发送，因为它和 resolve 阶段不同。

## 8. 与 Context Pipeline 的关系

Resource Resolver 不直接拼 prompt，但它会提供 context pipeline 可消费的 runtime blocks：

- 当前缺失的 MCP。
- 当前 auth-required 的资源。
- 当前入口不支持 permission ask。
- 当前可用的关键平台能力。

Context Pipeline 负责把这些信息渲染给模型或 debug UI。Resource Resolver 只输出结构化 audit 和 availability。

skills 的 instructions 也不应该由 resolver 直接拼到 system prompt。resolver 只确认 skill 可用，并提供 skill context refs；最终是否注入、如何排序和预算裁剪由 Context Pipeline 决定。

## 9. 与 agent loop 的关系

agent loop 使用 resolver 产出的 wrapped tools：

1. 模型提出 tool call。
2. permission gate 判断 allow / ask / deny。
3. 如果 ask，runtime 发 permission ask event。
4. 用户选择 once allow，则本次 tool call 继续。
5. 用户选择 session allow，则写入 `profileSnapshot.sessionPermissionGrants`，本次和后续 tool call 可复用。
6. tool 执行失败时，resolver 或 tool wrapper 更新 availability 并发送 resource failure event。

注意：

- tool 执行失败不触发本轮重新解析全部 resources。
- session allow 写入 profileSnapshot 后，只影响权限判断，不改变 resource declaration。
- 如果工具失败后同一 loop 再次调用同一资源，可以直接使用 updated availability 判断是否短路。

## 10. Audit 输出

Resource audit 建议包含：

```ts
type ResourceAudit = {
  profileSnapshotId: string
  turnSnapshotId?: string
  builtinTools: Array<{
    id: string
    source: string
    permission: 'allow' | 'ask' | 'deny'
    available: boolean
  }>
  mcp: Array<{
    server: string
    declared: boolean
    status: ResourceAvailability['status']
    toolCount?: number
    source: string[]
    error?: string
  }>
  skills: Array<{
    id: string
    declared: boolean
    status: ResourceAvailability['status']
    source: string[]
    error?: string
  }>
  permissions: {
    sources: string[]
    sessionGrants: string[]
    denied: string[]
    ask: string[]
  }
  failures: ResourceFailureEvent[]
}
```

audit 是 debug 面板、回归测试和用户解释的基础。即使客户端不支持 resource failure event，也应能在 audit 或 history 中看到失败原因。

## 11. 缓存策略

建议分三类缓存：

- declaration cache：session 级，来自 `profileSnapshot.resources`。
- registry cache：runtime 级，记录 builtin tools、MCP server 配置、skill metadata。
- health cache：短 TTL，记录 MCP server 可用性、auth 状态、skill 加载状态。

原则：

- declaration cache 不随用户全局配置热更新。
- health cache 可以漂移，但不能修改 profileSnapshot。
- health cache 过期不应长时间阻塞 message 关键路径。
- execute 阶段真实失败优先于 cache，必须更新本轮 availability。

## 12. 兼容迁移计划

### 阶段 1：包住现有工具解析

- 新增 `ResourceSpec`、`ResolvedResources`、`ResourceAudit` 类型。
- 在现有 tool 解析入口外包一层 resolver。
- 保持旧工具注册和调用路径不变。
- audit 先输出 JSON，不急着做完整 UI。

### 阶段 2：拆分 MCP preflight

- 去掉 runtime core 中的平台专项 preflight。
- 将 MCP 连接检查改成 resolver 的 availability check。
- 引入短超时和 lazy check。
- 失败发 resource failure event。

### 阶段 3：接入 skills availability

- skill registry 返回 declared / available / error。
- skill instructions 改为 context refs 交给 Context Pipeline。
- skill 加载失败进入 event 和 audit。

### 阶段 4：完善 permission runtime

- session grant 写入 `profileSnapshot.sessionPermissionGrants`。
- once grant 只在当前 tool call 生效。
- 不支持 permission ask 的入口返回 `continue-in-web` action。

### 阶段 5：debug 面板和回归测试

- Web debug 展示 resolved resources。
- 展示 unavailable / auth-required 原因。
- 增加字段级合并策略测试和 tool 可见性测试。

## 13. 建议落点

逻辑模块名建议使用：

- `runtime/resources/types`
- `runtime/resources/resolver`
- `runtime/resources/mcp`
- `runtime/resources/skills`
- `runtime/resources/permissions`
- `runtime/resources/audit`
- `runtime/events/resource-failure`

第一阶段物理落点可以靠近现有 tool / session 代码，降低改动风险。对外概念和新类型应统一使用 `Nine1Bot Runtime`，后续再把历史代码整理成独立 runtime 包。

## 14. 验收用例

1. 用户默认 MCP 会进入新 session 的 `profileSnapshot.resources`。
2. 用户默认 skills 会进入新 session 的 `profileSnapshot.resources`。
3. 平台模板只能增加 MCP，不能排除用户默认 MCP。
4. 平台模板只能增加 skills，不能排除用户默认 skills。
5. 用户关闭的继承来源不会被模板重新打开。
6. 同一 session 内每轮不会重新增减 MCP / skills。
7. 模型切换不会触发 resource profile 重编译。
8. MCP 配置不存在时对话继续，并发送 resource failure event。
9. MCP OAuth 过期时发送 `auth-required` event。
10. skill 文件缺失时对话继续，并发送 resource failure event。
11. resource failure event 能被 Web SSE 展示。
12. 不支持 resource failure event 的客户端仍能在 audit/history 中看到失败。
13. 权限选择“一次允许”不会写入 profileSnapshot。
14. 权限选择“本 session 都允许”会写入当前 `profileSnapshot.sessionPermissionGrants`。
15. hard deny 不能被 session grant 覆盖。
16. agent loop 内多个 tool step 复用同一份 resolved resources。
17. tool execute 阶段失败会更新本轮 availability，但不触发全量重编译。
18. audit 能解释每个工具为什么可用、不可用、ask 或 deny。
