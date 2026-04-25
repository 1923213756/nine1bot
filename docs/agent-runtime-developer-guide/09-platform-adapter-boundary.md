# Platform Adapter 边界与 GitLab 样板

第三方平台深度适配必须作为独立平台包开发，不能直接写进 Nine1Bot Runtime / opencode core。Runtime core 只提供通用协议、registry、context pipeline 和 resource resolver。

## 目录约定

平台包放在 `packages/platform-*`：

- `packages/platform-gitlab`：GitLab 样板实现。
- `packages/platform-github`：未来 GitHub 深度适配应使用同样结构。
- `packages/platform-jira`：未来 Jira 深度适配应使用同样结构。

平台包应导出两类入口：

- `@nine1bot/platform-xxx/browser`：浏览器安全 helper，例如 URL parser、page payload builder、template id 推导。
- `@nine1bot/platform-xxx/runtime`：runtime adapter 描述，例如 page normalization、context blocks、template context、resource contribution。

## Runtime 边界

runtime core 可以依赖：

- `RuntimePlatformAdapterRegistry`
- `RuntimeContextEvents`
- `ControllerTemplateResolver`
- `RuntimeContextPipeline`
- `RuntimeResourceResolver`

runtime core 不应该依赖：

- `@nine1bot/platform-gitlab`
- `@nine1bot/platform-github`
- 任意具体第三方平台 SDK 或页面语义

具体平台 adapter 由 Nine1Bot 产品启动层注册。这样 opencode / runtime core 能保持轻量，平台深度适配可以独立演进、测试和替换。

## GitLab 样板

GitLab 的代码边界如下：

- `packages/platform-gitlab/src/shared.ts`：URL parser、page payload normalization。
- `packages/platform-gitlab/src/browser.ts`：browser extension / web 可直接使用的安全导出。
- `packages/platform-gitlab/src/runtime.ts`：GitLab runtime adapter 描述。
- `packages/nine1bot/src/platform/gitlab.ts`：产品层注册桥接，只负责把 GitLab adapter 注册进 runtime registry。
- `packages/browser-extension/src/content/index.ts`：只采集 DOM 信息，然后调用平台包构建 page payload。
- `web/src/api/client.ts`：使用平台包 helper 推导 GitLab template ids，不手写 GitLab 页面规则。

## 新增平台的步骤

1. 新建 `packages/platform-<name>`。
2. 在平台包内实现 parser、payload builder、template id 推导和 runtime adapter。
3. 在 Nine1Bot 产品层新增一个小的注册桥接文件。
4. 入口侧只采集原始上下文，不在入口里复制平台业务规则。
5. 为平台包补齐 parser、payload、template、resource 单测。
6. 确认 runtime core 中没有新增具体平台 import。

## 验收规则

新增平台适配时至少检查：

- `opencode/packages/opencode/src/runtime` 中没有直接 import 该平台包。
- 平台 page context 通过 `RuntimePlatformAdapterRegistry` 进入 context events。
- 平台场景模板通过 registry 进入 `ControllerTemplateResolver`。
- 平台资源贡献仍然遵守 profileSnapshot + live gate。
- Browser extension 不做后台页面同步，只在用户发送消息时采集页面态。
