# Context Pipeline 实现设计

## 1. 定位

本文描述 `Context Pipeline` 的实现方案。这里的 runtime 指 `Nine1Bot Runtime`：现有 `opencode/` 代码在重构后不再被视为外部上游依赖层，而是 Nine1Bot 自己的 agent runtime 组件。

Context Pipeline 的目标是把所有影响模型理解的上下文来源统一成结构化 `ContextBlock`，再由 runtime 在每轮开始 agent loop 前编译成稳定的 `TurnRuntimeSnapshot.context`。

它要替代的不是某一个 prompt 函数，而是过去散落在这些位置里的上下文拼接逻辑：

- 系统身份和底部规则。
- 用户 instructions。
- AGENTS.md / CLAUDE.md / 项目说明。
- 入口临时 system prompt。
- 平台页面信息。
- 当前 turn 的附件、选区和临时约束。
- 内部 summary / compaction / loop 状态。

## 2. 设计目标

Context Pipeline 第一阶段要做到：

- 统一表达：所有 instructions / context 都以 `ContextBlock` 进入 runtime。
- 生命周期清晰：区分 `session`、`active`、`turn`、`loop`。
- 请求绑定：page context 只在用户发送请求时采集或补全。
- 历史叠加：页面和选区变化以 context event 进入 history。
- 去重节省：同一页面连续对话不重复插入相同 page event。
- 可审计：debug 能解释本轮使用、裁剪、跳过了哪些 block。
- 兼容旧链路：第一阶段仍可编译成现有 `system: string[]`。

非目标：

- 第一阶段不做复杂的自动语义总结器。
- 第一阶段不做用户级可视化 block 编辑器。
- 第一阶段不要求所有 block 都能热更新。
- 第一阶段不在 agent loop 中途重新编译页面上下文。

## 3. 模块边界

### 3.1 Controller 侧

Nine1Bot Controller 负责把产品和平台语义转成 context 输入：

- 从 `default-user-template` 编译 session 级 blocks。
- 从项目配置和项目文件编译 project blocks。
- 从入口模板编译 business / platform blocks。
- 在用户发送请求时接收或采集 page / selection context。
- 判断 page context 是否需要写入 context event history。
- 将最终 context 输入放入 `AgentRunSpec.context`。

Controller 可以理解 GitLab、Feishu、浏览器插件，但不能直接拼最终系统 prompt。

### 3.2 Runtime 侧

Nine1Bot Runtime 负责执行 pipeline：

- 校验 `ContextBlock`。
- 调用 resolver 解析动态 block。
- 合并 session / active / turn / loop blocks。
- 排序、预算裁剪、渲染。
- 生成 `CompiledContext` 和 `TurnRuntimeSnapshot.context`。
- 输出 audit。
- 为 compaction 提供 context event 摘要。

Runtime 不理解具体平台页面 DOM，只处理平台 adapter 已经给出的结构化 block。

## 4. 核心类型

### 4.1 ContextBlock

```ts
type ContextBlock = {
  id: string
  layer: ContextLayer
  lifecycle: ContextLifecycle
  source: string
  enabled: boolean
  visibility: ContextVisibility
  priority: number
  mergeKey?: string
  digest?: string
  observedAt?: number
  staleAfterMs?: number
  budgetHint?: number
  content: ContextBlockContent
}

type ContextLayer =
  | 'base'
  | 'project'
  | 'user'
  | 'business'
  | 'platform'
  | 'page'
  | 'runtime'
  | 'turn'
  | 'loop'

type ContextLifecycle =
  | 'session'
  | 'active'
  | 'turn'
  | 'loop'

type ContextVisibility =
  | 'system-required'
  | 'developer-toggle'
  | 'user-toggle'

type ContextBlockContent =
  | { type: 'text'; text: string }
  | { type: 'structured'; data: Record<string, unknown> }
  | { type: 'resolver'; resolver: string; params?: Record<string, unknown> }
```

说明：

- `id` 是稳定标识，例如 `base:nine1bot-runtime`、`project:agents-md`、`page:gitlab-mr`。
- `source` 用于审计，例如 `default-user-template`、`gitlab-adapter`、`session-choice`。
- `mergeKey` 用于同类 block 合并，例如同一页面对象。
- `digest` 用于去重和判断是否变化。
- `budgetHint` 是软预算，不是强制长度。

### 4.2 ContextEvent

```ts
type ContextEvent = {
  id: string
  type: 'page-enter' | 'page-update' | 'selection-update'
  pageKey?: string
  digest: string
  observedAt: number
  source: string
  summary: string
  blocks: ContextBlock[]
}
```

Context event 是写入 session history 的环境事件。它不是用户消息，也不应该被 UI 当成用户输入展示。

### 4.3 PageContextState

```ts
type PageContextState = {
  pageKey: string
  digest: string
  selectionDigest?: string
  observedAt: number
}
```

`PageContextState` 与 session 一起持久化，用来避免同一页面连续对话时重复插入 context event。它只在请求通过 busy reservation 并成功进入写入阶段后更新。

### 4.4 CompiledContext

```ts
type CompiledContext = {
  blocks: ResolvedContextBlock[]
  rendered: string[]
  dropped: DroppedContextBlock[]
  events: ContextEventAudit[]
  tokenEstimate?: number
}

type ResolvedContextBlock = ContextBlock & {
  resolvedText: string
  tokenEstimate?: number
}

type DroppedContextBlock = {
  id: string
  reason: 'disabled' | 'stale' | 'budget' | 'resolver-error'
  message?: string
}
```

第一阶段 `rendered` 可以继续传给现有 prompt 编译流程。后续再把它升级成结构化 model messages。

## 5. 持久化位置

建议把 context 分成四类存储：

| 数据 | 持久化位置 | 生命周期 |
| --- | --- | --- |
| session blocks | `profileSnapshot.context.blocks` | 会话创建时冻结 |
| context events | session history / context event log | 多轮对话历史 |
| last page state | session metadata | 请求成功写入后更新 |
| compiled context | `TurnRuntimeSnapshot.context` | 本轮 agent loop |

注意：

- `TurnRuntimeSnapshot.context` 用于 debug 和复现，可以存 block metadata 和摘要，不一定要存完整敏感内容。
- 如果 block 来自文件、环境或外部服务，audit 中应保留来源和 digest，避免泄露完整内容。
- context event 的 summary 应该足够让 compaction 保留语义，但不要存过大的原始 DOM。

## 6. Pipeline 执行阶段

每轮用户消息的 context pipeline 按以下顺序执行。

### 6.1 Busy reservation

Controller 必须先取得 session 的 busy reservation。失败时直接 reject：

- 不写入 user message。
- 不采集或写入 page context event。
- 不更新 `lastPageContextState`。
- 不生成 `TurnRuntimeSnapshot`。

这保证页面态不会绕过对话运行状态写入 session。

### 6.2 收集 session blocks

从 `profileSnapshot.context.blocks` 读取会话级 blocks，包括：

- base identity。
- user instructions。
- project instructions。
- business capabilities。
- platform stable context。

这些 block 不因为用户修改配置而在旧 session 中自动变化。

### 6.3 解析请求 page context

用户发送请求时，入口可以携带 page payload：

```ts
type RequestPagePayload = {
  platform: 'gitlab' | 'generic-browser' | 'feishu'
  url?: string
  pageType?: string
  title?: string
  objectKey?: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}
```

Controller 调用 platform adapter，把 payload 转成 page / selection blocks：

- `platform:gitlab`
- `page:gitlab-repo`
- `page:gitlab-mr`
- `page:gitlab-issue`
- `page:browser-selection`

如果入口没有 page context 能力，则跳过，不影响普通对话。

### 6.4 Context event 去重

对于 page / selection blocks，Controller 计算：

- `pageKey`：平台、对象类型、对象 id 或 URL 的稳定组合。
- `digest`：标题、状态、摘要、选区等关键内容的 hash。
- `selectionDigest`：选区内容 hash。

规则：

- `pageKey` 变化：写入 `page-enter`。
- `pageKey` 相同但 `digest` 变化：写入 `page-update`。
- selection 变化：写入 `selection-update`。
- 都不变：不写 history，只在 audit 里记为 `deduped`。

context event 应写在本轮 user message 之前，让模型能自然理解“本轮用户是在这个页面上发问”。

### 6.5 合并 turn blocks

turn blocks 来自：

- 当前用户输入相关的附件说明。
- 本轮 runtime override。
- 本轮入口约束。
- permission ask 后的短期提醒。

turn blocks 不进入 `profileSnapshot`，只进入本轮 `TurnRuntimeSnapshot`。

### 6.6 Resolver 解析

如果 block content 是 resolver：

```ts
interface ContextBlockResolver {
  id: string
  resolve(input: {
    block: ContextBlock
    session: SessionRef
    profileSnapshot: SessionProfileSnapshot
    request: AgentRunSpec
  }): Promise<ResolvedContextBlock>
}
```

第一阶段建议提供这些 resolver：

- `static-text`：直接返回文本。
- `project-file`：读取 AGENTS.md / CLAUDE.md / 项目说明。
- `user-instructions`：读取用户配置编译结果。
- `platform-page`：渲染 adapter 生成的结构化 page data。
- `runtime-status`：渲染当前入口能力、权限和限制。

resolver 失败策略：

- `system-required` block 失败：本轮编译失败，返回明确错误。
- `developer-toggle` / `user-toggle` block 失败：跳过该 block，写 audit。
- page block 失败：降级为普通用户消息，不应阻断整个对话。

### 6.7 标准化与排序

排序规则建议固定为：

```ts
const layerOrder = [
  'base',
  'project',
  'user',
  'business',
  'platform',
  'page',
  'runtime',
  'turn',
  'loop',
]
```

同一 layer 内按：

1. `visibility === 'system-required'`
2. `priority` 从高到低
3. `id` 字典序

排序必须稳定，否则会影响 LLM 缓存命中和 debug 复现。

### 6.8 预算裁剪

第一阶段预算策略保持简单：

- `system-required` 不裁剪。
- `base`、`project`、`user` 优先级高于 `page` 和 `turn`。
- 超预算时先丢弃低 priority 的 `user-toggle` blocks。
- 再丢弃低 priority 的 `developer-toggle` blocks。
- page block 可以保留摘要，丢弃原始大字段。
- 所有 dropped blocks 必须进入 audit。

不建议第一阶段自动对长文本做复杂 summary，因为 summary 会引入新的模型调用和新的不稳定性。可以先依赖已有 compaction 机制，并在后续单独设计 context summarizer。

### 6.9 渲染

第一阶段渲染为稳定的文本段：

```text
<context_block id="project:agents-md" layer="project" source="project-file">
...
</context_block>
```

渲染要求：

- 保持 block id、layer、source 可见，方便 debug。
- 不把 page context 混入用户消息正文。
- 不把 disabled / dropped block 渲染给模型。
- 不在每轮输出相同的 page event 文本。

后续可以把 `CompiledContext.rendered` 改为结构化 model message parts，但第一阶段先兼容现有 prompt 输入。

## 7. 与 history 的关系

Context Pipeline 不替代 history。

history 负责记录：

- 用户消息。
- assistant 消息。
- tool result。
- context event。

pipeline 负责本轮编译：

- 从 profileSnapshot 取 session blocks。
- 从 context event history 取必要环境历史。
- 从本轮请求取 turn blocks。
- 输出本轮 agent loop 的 `CompiledContext`。

context event 不是每轮都重复注入的系统 prompt，而是当环境变化时进入历史的一条合成事件。这样多轮对话里模型可以看到用户从 repo 页面切到 MR 页面，但不会在同一页面上重复消耗 token。

## 8. 与 compaction 的关系

compaction 需要保留 context event 的语义，而不是只压缩用户和 assistant 对话。

压缩时至少保留：

- 最近一次有效 `pageKey`。
- 最近一次 page summary。
- 最近一次 selection summary。
- 页面迁移序列的简短摘要。
- 与当前任务强相关的平台对象，例如 MR id、repo path、issue id。

被压缩后的 context event 仍应能让模型理解：

- 用户之前在哪个页面。
- 当前在哪个页面。
- 页面变化和本轮问题之间的关系。

## 9. 与 Resource Resolver 的关系

Context Pipeline 不负责判断工具是否可用，但它可以消费 Resource Resolver 的结果生成 runtime block，例如：

- 当前可用 GitLab 只读能力。
- 某个 MCP auth-required。
- 某个 skill 加载失败。
- 当前入口不支持 permission ask，需要到 Web 继续。

这类信息应来自 `ResolvedResources.audit`，并作为 `runtime` layer block 注入本轮上下文或 debug 面板。不要让 context pipeline 自己连接 MCP 或加载 skill。

## 10. 兼容迁移计划

### 阶段 1：包住旧 prompt

- 新增 `ContextBlock` 类型和 compiler。
- 把现有 identity、instructions、project prompt 包成 session blocks。
- `CompiledContext.rendered` 输出给现有 `system: string[]`。
- debug 返回 block 列表。

### 阶段 2：接入 context event

- 增加 context event 存储。
- 增加 `lastPageContextState`。
- 浏览器插件和 GitLab adapter 先接入 page payload。
- 实现 `pageKey + digest` 去重。

### 阶段 3：预算与 audit

- 增加 token 粗估。
- 增加 dropped block audit。
- debug 面板展示 block 来源、生命周期和裁剪原因。

### 阶段 4：compaction 集成

- compaction 读取 context event history。
- 保留页面迁移摘要。
- 压缩后更新 context event summary，但不篡改原始 history。

## 11. 建议落点

逻辑模块名建议使用：

- `runtime/context/types`
- `runtime/context/pipeline`
- `runtime/context/resolvers`
- `runtime/context/events`
- `runtime/context/audit`

物理位置可以分两步：

- 第一阶段为了降低迁移成本，可以在现有 runtime 代码附近落实现，并通过 Nine1Bot Controller 调用。
- 第二阶段将其整理成独立 `Nine1Bot Runtime` 包或 `packages/nine1bot/src/runtime/context` 模块。

关键是对外命名和概念边界应统一为 `Nine1Bot Runtime`，不要再把它设计成可替换的上游 opencode 插件。

## 12. 验收用例

1. 用户配置的 instructions 会出现在 `user` layer block。
2. AGENTS.md 会出现在 `project` layer block。
3. Feishu 入口不再直接拼入口级 system prompt，而是提供 runtime / platform blocks。
4. GitLab repo 页面第一次发消息会写入 `page-enter` context event。
5. 同一 GitLab repo 页面连续发消息不会重复写入 page event。
6. 从 repo 页面切到 MR 页面会写入新的 `page-enter`。
7. 同一 MR 标题或 diff 摘要变化会写入 `page-update`。
8. 选区变化会写入 `selection-update`。
9. busy reject 时不会写入 user message、page event 或 last page state。
10. `TurnRuntimeSnapshot.context` 在 agent loop 内保持不变。
11. resolver 失败会进入 audit，非必需 block 不阻断普通对话。
12. debug 能展示所有 enabled、disabled、dropped blocks。
13. 超预算时低优先级 optional block 被裁剪，并记录原因。
14. compaction 后仍能看出用户最近所处的平台对象。
