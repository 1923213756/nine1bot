# Nine1Bot Browser Control Extension

Chrome / Edge 扩展，为 Nine1Bot 提供用户浏览器自动化能力。当前版本只支持连接 Nine1Bot 主服务内置的 `/browser/*` relay；旧的 Chrome extension MCP 配置模式已经废弃。

## 安装

```bash
cd packages/browser-extension
bun install
bun run build
```

然后在浏览器中打开 `chrome://extensions/` 或 `edge://extensions/`，启用开发者模式，选择 `packages/browser-extension/dist` 作为未打包扩展目录。

## 使用

在 `nine1bot.config.jsonc` 中启用浏览器控制：

```jsonc
{
  "browser": {
    "enabled": true
  }
}
```

扩展默认连接 `http://127.0.0.1:4096/browser/extension`。如果 Nine1Bot 运行在其他端口，可在扩展 service worker 控制台执行：

```js
chrome.storage.sync.set({ serverOrigin: "http://127.0.0.1:4100" })
```

不要再配置 `mcp.browser` 或 `mcp.browser-control`；Nine1Bot 会对这些旧配置给出明确迁移报错。

## 架构

```text
Nine1Bot main server
  /browser/bootstrap
  /browser/extension  <---- WebSocket ---- Chrome Extension
  /browser/cdp

OpenCode browser tools -> BridgeServer -> Relay -> Extension tools/content script
```

扩展启动后会读取 `/browser/bootstrap`，通过 `/browser/extension` 建立 WebSocket，随后把页面读取、截图、点击、输入、表单填写和标签页管理等能力暴露给 Nine1Bot 的 browser tools。

## 安全说明

扩展需要 `debugger`、`scripting`、`tabs` 和 `<all_urls>` 等敏感权限，用于控制页面和读取页面上下文。只建议在可信环境使用；涉及支付、账号安全等敏感操作时应手动确认。
