# x402 MCP Gateway

`x402 MCP Gateway` 是一个 MCP 网关组件。  
它作为上游 Agent 的单一入口，将工具调用转发到下游 MCP，并在下游出现 x402 收费挑战时由网关钱包自动支付。

## 当前模式

当前示例仅支持 **Command（stdio）模式**，用于在本地运行并被 Cursor 等 Agent 通过命令拉起。  
不对外提供 HTTP endpoint（如 `/mcp`、`/sse`）。

## 当前能力

- 多下游注册（一个或多个 endpoint）
- 下游工具转发调用（`call_service_tool`）
- 自动支付重试（网关钱包代付）
- 下游连接支持两种 transport：
  - Streamable HTTP
  - SSE（仅用于连接下游）
- 自动连接策略：先 Streamable HTTP，失败回退 SSE
- 启动连接重试（默认 3 次，可配置）

## 对外工具

### `list_gateway_services`

列出当前已连接下游服务：

- `serviceId`
- `url`
- `transport`
- `tools`

### `call_service_tool`

通过网关调用下游工具：

- 输入：
  - `serviceId`（可选，默认 `service-1`）
  - `toolName`（必填）
  - `args`（可选）
- 输出：
  - `paymentMade`
  - `paymentResponse`
  - `content`

## 环境变量（推荐直接写在 Cursor MCP 配置）

你可以使用 `.env` 文件，也可以直接在 Cursor 的 `mcp.json` 里写 `env`。  
对于“私钥只保留在本机配置”的场景，推荐直接写在 `mcp.json` 的 `env` 中。

必填变量：

```bash
EVM_PRIVATE_KEY=0x...
DOWNSTREAM_MCP_URLS=https://vendor.example/mcp,http://localhost:4022/mcp
```

可选变量：

```bash
DOWNSTREAM_MCP_TRANSPORT=auto
DOWNSTREAM_CONNECT_RETRIES=3
```

字段说明：

- `EVM_PRIVATE_KEY`：网关支付钱包私钥
- `DOWNSTREAM_MCP_URLS`：多个下游地址（逗号分隔）
- `DOWNSTREAM_MCP_URL`：单下游地址（`URLS` 未配置时使用）
- `DOWNSTREAM_MCP_TRANSPORT`：
  - `auto`（默认，先 Streamable HTTP 再 SSE）
  - `streamable-http`
  - `sse`
- `DOWNSTREAM_CONNECT_RETRIES`：下游连接重试次数（默认 `3`，范围 `1-10`）

## 启动方式

1. 安装依赖（examples 根目录）：

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript
pnpm install --no-frozen-lockfile
```

2. 本地命令启动网关（stdio）：

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript/servers/mcp-gateway
pnpm dev
```

## Cursor 接入（Command + env）

在 Cursor MCP 配置中使用：

```json
{
  "mcpServers": {
    "gateway-mcp": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/Users/ppg/Desktop/agentry/x402/examples/typescript/servers/mcp-gateway",
        "dev"
      ],
      "env": {
        "EVM_PRIVATE_KEY": "0x你的私钥",
        "DOWNSTREAM_MCP_URLS": "https://vendor.example/mcp,http://localhost:4022/mcp",
        "DOWNSTREAM_MCP_TRANSPORT": "auto",
        "DOWNSTREAM_CONNECT_RETRIES": "3"
      }
    }
  }
}
```

说明：

- `command`/`args` 用于拉起本地网关进程。
- `env` 中的变量会注入该进程，等价于运行命令前设置环境变量。
- 这种方式与你示例里的 `ssh-mcp` 配置方式一致，非常适合本地私钥管理。

## 对外分发（npm 包方式）

如果你希望别人不依赖你的本地仓库路径，推荐发布为 npm CLI 包。

1. 在本目录执行打包自检：

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript/servers/mcp-gateway
pnpm install --no-frozen-lockfile
pnpm lint:check
pnpm exec tsc --noEmit
pnpm pack
```

2. 验证无误后发布：

```bash
npm publish
```

> 建议发布前把 `package.json` 中的 `name` 改成你自己的 npm scope（例如 `@your-scope/x402-mcp-gateway`），避免包名冲突。

## 发给别人什么

最少发这三项信息即可，不需要额外写大说明书：

- npm 包名（例如 `@your-scope/x402-mcp-gateway`）
- 可直接复制的 Cursor `mcp.json` 配置
- 必填环境变量说明（`EVM_PRIVATE_KEY`、`DOWNSTREAM_MCP_URLS`）

给别人可直接使用的 Cursor 配置模板（发布后）：

```json
{
  "mcpServers": {
    "gateway-mcp": {
      "command": "npx",
      "args": ["-y", "@your-scope/x402-mcp-gateway"],
      "env": {
        "EVM_PRIVATE_KEY": "0x你的私钥",
        "DOWNSTREAM_MCP_URLS": "https://vendor.example/mcp,http://localhost:4022/mcp",
        "DOWNSTREAM_MCP_TRANSPORT": "auto",
        "DOWNSTREAM_CONNECT_RETRIES": "3"
      }
    }
  }
}
```

## 常见问题

### 1) `tsx: command not found`

说明依赖未安装。先在 `examples/typescript` 根目录执行：

```bash
pnpm install --no-frozen-lockfile
```

### 2) 启动时报 `Failed to connect downstream`

通常是下游不可达或 transport 不匹配：

- 先验证下游 URL 是否可访问
- 使用 `DOWNSTREAM_MCP_TRANSPORT=auto`
- 适当提高 `DOWNSTREAM_CONNECT_RETRIES`

### 3) Cursor 里显示 MCP 连接失败

重点检查：

- `command` 是否可执行（先终端里手动跑一遍同样命令）
- `env.EVM_PRIVATE_KEY` 是否为 `0x` 开头私钥
- `env.DOWNSTREAM_MCP_URLS` 是否可访问
