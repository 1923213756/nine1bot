# 模板覆盖与叠加策略

## 1. 为什么需要单独定义策略

当 `default-user-template`、产品模板、平台模板、session choice 和 runtime override 都能影响一次 agent 运行时，必须避免“后来的模板直接覆盖前面的模板”这种粗暴模型。

不同字段的所有权不同：

- model 默认来自 `profileSnapshot`，允许用户显式 session-level 切换或单次 runtime override。
- agent 以会话级用户选择为主，不能每轮切换。
- context 可以分层追加，并允许动态 page / turn block。
- MCP / skills 第一阶段只允许增加，不允许排除或减少。
- permissions 可以收紧，但不能静默放宽。

因此合并策略必须是字段级的。

## 2. 输入来源顺序

逻辑上的来源顺序是：

1. runtime defaults
2. existing user config
3. `default-user-template`
4. built-in product template
5. platform / entry template
6. session choice
7. explicit runtime override
8. turn dynamic context

但这个顺序只表示“谁参与编译”，不表示后者能覆盖前者。真正行为由字段策略决定。

## 3. 字段策略矩阵

| 字段 | default-user-template | product template | platform / entry template | session choice | runtime override | turn dynamic |
| --- | --- | --- | --- | --- | --- | --- |
| model | set | no-op | no-op | explicit set | explicit set | no-op |
| agent | default | recommend only | recommend only | explicit set | internal only | no-op |
| context | add blocks | add blocks | add blocks | toggle allowed blocks | explicit debug/runtime blocks | add page/turn blocks |
| builtin tools | baseline | add groups | add groups | add groups | no-op | no-op |
| MCP | baseline | add only | add only | add only at session start | no-op | no-op |
| skills | baseline | add only | add only | add only at session start | no-op | no-op |
| permissions | baseline | restrict only | restrict only | explicit grant/restrict | explicit grant/restrict | permission ask only |
| orchestration | default single | recommend | recommend | explicit set | explicit set | no-op |

说明：

- `no-op` 表示该来源不允许改这个字段。
- `recommend only` 表示只影响 UI 推荐，不影响最终运行值。
- `add only` 表示只能做并集，不能删除已有项。
- `restrict only` 表示只能收紧权限。

## 4. model 策略

模型选择来源只有三类：

1. 会话创建时由 `default-user-template` 固化进 `profileSnapshot`
2. 用户在 session 中显式选择的 `sessionChoice.model`
3. 用户在入口处单次临时选择的 `runtimeOverride.model`

规则：

```ts
effectiveModel =
  runtimeOverride.model
  ?? sessionChoice.model
  ?? profileSnapshot.model
```

禁止：

- 产品模板选择模型。
- 平台模板选择模型。
- GitLab / Feishu / browser adapter 根据场景偷偷换模型。

允许：

- 用户在某个入口临时选择模型。
- 用户在同一个 session 中显式切换当前模型。
- controller 把会话级切换记录为 `sessionChoice.model`，把单次临时选择记录为 `runtimeOverride.model`。
- audit 中记录模型来源。

原因：

- 模型选择是用户级偏好和成本控制的一部分。
- 场景模板如果能偷偷换模型，会破坏用户对成本、速度和能力边界的预期。
- 模型切换不能触发 agent、MCP、skills、permissions 的隐式重编译。

## 5. agent 策略

agent 是会话级选择，不允许每轮切换。

规则：

```ts
effectiveAgent =
  sessionChoice.agent
  ?? profileSnapshot.agent
  ?? runtimeDefaultAgent
```

`recommendedAgent` 不参与这个表达式。它只能用于 UI：

- 新建会话时推荐某个 agent。
- 在模板说明中提示某个场景更适合某 agent。
- 用户仍然需要显式确认或选择。

内部任务例外：

- summary、title、compaction 等 runtime 内部任务可以使用 internal agent。
- internal agent 不改变主 session 的当前 agent。

原因：

- agent 可能改变底部提示词、权限、工具集和行为方式。
- 每轮切换 agent 会降低 LLM 推理缓存利用率。
- 会话内 agent 反复变化也会让用户难以理解当前 agent 身份。

## 6. context 策略

context 采用分层追加策略，但要区分两种东西：

- runtime context blocks：本轮运行时要编译进 system/context 的结构化块。
- context event history：页面、选区、平台对象变化等需要让 LLM 在多轮对话中看到的环境历史。

```ts
effectiveContextBlocks = sortByLayerAndPriority([
  ...defaultUserTemplate.contextBlocks,
  ...productTemplate.contextBlocks,
  ...platformTemplate.contextBlocks,
  ...sessionChoice.enabledContextBlocks,
  ...runtimeOverride.contextBlocks,
  ...turnDynamicContextBlocks,
])
```

关键规则：

- instructions / AGENTS.md / CLAUDE.md / 用户偏好 / 项目信息都要尽早变成 context block。
- 平台页面信息必须作为 `platform` 或 `page` block，不要混进用户输入。
- 如果页面状态变化对多轮追问有意义，应生成 synthetic context event 写入 history。
- 同一个页面连续对话时，必须用 page key / digest 去重，避免重复插入相同 page event。
- `page` 和 `turn` block 可以每轮更新。
- `base`、`project`、`user`、`business` block 默认更接近 session 级。
- block 的关闭能力可以后续逐步做；第一阶段优先保证 block 来源可审计。

第一阶段实现：

- 可以把 pipeline 输出编译成现有 `system: string[]`。
- 但 debug 里必须保留 block 列表。

## 7. MCP 策略

MCP 第一阶段采用只增不减策略。

```ts
effectiveMcpServers = union([
  ...defaultUserTemplate.mcp.servers,
  ...productTemplate.mcp.addServers,
  ...platformTemplate.mcp.addServers,
  ...sessionChoice.mcp.addServers,
])
```

规则：

- 产品模板只能增加 MCP 需求。
- 平台模板只能增加 MCP 需求。
- session choice 只能在会话开始时增加 MCP。
- 不支持 per-turn MCP 切换。
- 不支持模板排除 MCP。
- 不支持模板减少 MCP tools。

用户配置优先：

- 用户持久配置关闭某个继承来源时，模板不能静默重新启用。
- 用户显式禁用某个 MCP server 时，模板不能静默重新启用。
- 如果场景需要某 MCP 但不可用，应降级并写入 audit。
- MCP 的声明可用和实际可用要分开。`profileSnapshot` 固定的是声明集合，运行时健康状态可以变成 degraded / unavailable / auth-required。
- 当 MCP 实际失败时，服务端要发送 resource failure 事件，客户端应展示给用户，而不是只静默降级。

为什么第一阶段不做 exclude：

- 排除规则会让“为什么这个工具不可用”变复杂。
- 场景模板太早拥有减法能力，容易破坏用户已有工作流。
- 先做加法能更好地验证 runtime/controller 主链路。

## 8. skills 策略

skills 第一阶段也采用只增不减策略。

```ts
effectiveSkills = union([
  ...defaultUserTemplate.skills,
  ...productTemplate.skills.add,
  ...platformTemplate.skills.add,
  ...sessionChoice.skills.add,
])
```

规则：

- 产品模板只能增加推荐或需要的 skills。
- 平台模板只能增加推荐或需要的 skills。
- session choice 只能在会话开始时增加 skills。
- 不支持 per-turn skills 切换。
- 不支持模板排除 skills。

继承策略：

- `skills.inheritOpencode` 和 `skills.inheritClaudeCode` 决定默认 skills 池。
- 模板不能绕过用户关闭的继承来源。
- skills 的声明可用和实际可用也要分开。加载失败、依赖缺失、文件缺失等都应进入 availability 和 audit。
- 当 skill 实际不可用时，服务端要发送 resource failure 事件，客户端应展示给用户。

## 9. builtin tools 策略

内置工具第一阶段可以比 MCP / skills 稍微保守：

- 默认仍由 agent permission 和 runtime tool registry 决定。
- 产品模板和平台模板可以增加工具组需求。
- 安全限制优先通过 permissions 表达。
- 不建议每轮切换内置工具集合。

后续如果要支持工具排除，应该和 MCP / skills 的 exclude 设计一起做。

## 10. permissions 策略

权限策略采用严格合并：

```ts
effectivePermissions = mergeStrict([
  runtimeDefaults.permissions,
  defaultUserTemplate.permissions,
  productTemplate.permissionRestrictions,
  platformTemplate.permissionRestrictions,
  sessionChoice.permissionOverrides,
  runtimeOverride.permissionOverrides,
])
```

规则：

- 用户 deny 不能被模板静默放宽。
- 产品模板和平台模板默认只能收紧。
- 放宽权限必须来自用户显式选择。
- 单次 permission ask 如果选择“一次允许”，只影响当前 tool call。
- 单次 permission ask 如果选择“本 session 都允许”，应写入 `profileSnapshot.sessionPermissionGrants`，后续判断时作为 session 级授权放行。
- session grant 不写回全局配置，不影响其他 session。

Feishu 这类入口可以默认收紧：

- 禁止 question。
- 权限请求需要提示用户到 Web 端继续。

但 Feishu 不应该因此丢失用户的基础 model、agent 和上下文配置。

## 11. orchestration 策略

编排策略分为推荐和实际选择：

```ts
effectiveOrchestration =
  runtimeOverride.orchestration
  ?? sessionChoice.orchestration
  ?? defaultUserTemplate.orchestration
  ?? { mode: 'single' }
```

产品模板和平台模板只提供推荐：

- `gitlab-mr-review` 可以推荐 `parallel-review`。
- `web-default` 可以推荐 `single`。
- `browser-generic` 可以推荐 `single` 或 `supervisor-workers`。

是否采用推荐，需要入口 UI 或 controller 策略明确处理，不能隐藏切换。

## 12. freeze points

为了提高可预测性，需要明确哪些字段在何时固定。

### 会话开始时固定

- `profileSnapshot`
- agent
- MCP 可用集合
- skills 可用集合
- 主要内置工具 profile
- 基础 permissions profile
- session 级 context blocks

配置热更新默认不改变已有 session 的这些字段。已有 session 继续使用创建时持久化的 `profileSnapshot`。如果用户需要应用新配置，应新建 session 或显式重开运行上下文。

模型是例外：用户可以在同一 session 中显式切换模型，但这只改变本轮或后续轮次的 model，不重编译其他 profile 字段。会话级模型切换记录为 `sessionChoice.model`；单次入口临时选择记录为 `runtimeOverride.model`。

### 每轮 agent loop 开始时固定

- `TurnRuntimeSnapshot`
- 本轮编译后的 system/context blocks
- 本轮 resource resolver 结果引用
- 本轮权限 profile 引用
- 本轮是否注入了新的 context event
- 本轮 audit / debug 关联信息

这些内容固定后，loop 内每个 step 复用同一个快照。agent loop 内的语义推进主要依赖 message history 和 tool result history，不应在 step 之间自动重新编译页面上下文或资源集合。

### 每轮可更新

- user input
- request 携带或触发采集的 page context block
- turn context block
- runtime debug / trace 信息
- permission ask 的单次回答

### 显式 runtime override

- model 可以由用户在入口处显式临时选择。
- model 可以由用户在 session 中显式切换。
- orchestration 可以由用户或入口显式选择。
- 这些 override 必须出现在 audit 中。

## 13. context event history 与去重

页面、选区、平台对象这类上下文建议以 synthetic message 进入 history，而不是只作为瞬时 system prompt。这样 LLM 可以理解用户在多轮对话中的环境迁移。

但 page state 的发现时机应该绑定用户请求：客户端入口在发送消息时携带当前页面状态，或后端在处理这次请求时按入口信息主动采集。客户端页面发生变化本身不应该后台写入 session history。

这样可以自然复用严格 busy reject：只有成功进入本轮请求处理的消息，才可能写入新的 page context event。busy 时不会出现后台 page state 抢先改写当前 session 的问题。

推荐事件类型：

- `page-enter`：用户进入新的页面对象。
- `page-update`：同一页面对象的关键状态发生变化。
- `selection-update`：用户在当前页面选中了新的文本或区域。
- `page-unchanged`：默认不写入 history，只在 debug 中记录。

每个 page event 至少需要：

```ts
type PageContextEvent = {
  type: 'page-enter' | 'page-update' | 'selection-update'
  pageKey: string
  digest: string
  observedAt: number
  summary: string
}
```

去重规则：

- `pageKey` 没变且 `digest` 没变：不插入新 history message。
- `pageKey` 没变但 `digest` 变了：插入 `page-update`。
- `pageKey` 变了：插入 `page-enter`。
- selection 变化单独按 selection digest 去重。

去重状态可以和 session 一起持久化为“最近一次成功注入的 page context state”。它只在请求处理成功进入写入阶段后更新，不接受后台页面变化直接更新。

这样可以保留“用户从 repo 页到了 MR 页”的重要历史，同时避免同一页面连续对话时反复注入同样上下文。

## 14. audit 输出

每次编译 `AgentRunSpec` 后，应该能输出：

```ts
type TemplateAudit = {
  protocolVersion?: string
  templates: string[]
  profileSnapshotId?: string
  turnSnapshotId?: string
  model: { value: string; source: string }
  agent: { value: string; source: string }
  contextBlocks: Array<{ id: string; layer: string; source: string; lifecycle: string }>
  contextEvents?: Array<{ type: string; pageKey?: string; digest?: string; action: 'inserted' | 'deduped' }>
  mcp: { servers: string[]; mergeMode: 'additive-only'; missing?: string[] }
  skills: { skills: string[]; mergeMode: 'additive-only'; missing?: string[] }
  permissions: { sources: string[]; restrictions: string[]; sessionGrants?: string[] }
  resourceFailures?: Array<{ type: 'mcp' | 'skill'; id: string; status: string; error?: string }>
  orchestration: { mode: string; source: string; recommended?: string }
}
```

这个 audit 是后续 debug 面板、兼容性测试和用户解释的基础。

## 15. 兼容性测试重点

1. product template 不能覆盖用户模型。
2. platform template 不能覆盖用户模型。
3. recommendedAgent 不会自动改变当前 agent。
4. agent 在同一 session 内不能每轮切换。
5. MCP 合并只增加，不排除默认 MCP。
6. skills 合并只增加，不排除默认 skills。
7. 用户关闭的继承来源不会被模板重新打开。
8. turn dynamic context 能更新 page 信息，但不改变 session-level resources。
9. 权限模板可以收紧，但不能静默放宽 deny。
10. audit 能解释每个最终字段来自哪里。
11. 同一页面连续对话不会重复插入相同 page event。
12. 切换到新页面会插入新的 page-enter event，并保留历史迁移信息。
13. 同一个 agent loop 内多个 step 复用同一个 TurnRuntimeSnapshot。
14. “本 session 都允许”的权限会写入 profileSnapshot，并只影响当前 session。
15. MCP/skills 实际失败时会产生 resource failure 事件，客户端能展示。
