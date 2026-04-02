# x402 MCP Gateway

`x402 MCP Gateway` 是一个 MCP 网关组件。  
它作为上游 Agent 的单一入口，将工具调用转发到下游 MCP，并在下游出现 x402 收费挑战时由网关钱包自动支付。  
若配置了 Agentry Dashboard 合规接口，还会在支付前执行 **KYC/KYT**；若下游在挑战中携带 **AP2 CartMandate**，会额外走 **保障验签与预算校验**。

## 当前模式

当前示例仅支持 **Command（stdio）模式**，用于在本地运行并被 Cursor 等 Agent 通过命令拉起。  
不对外提供 HTTP endpoint（如 `/mcp`、`/sse`）。

## 当前能力

- 多下游注册（一个或多个 endpoint）
- 下游工具转发调用（`call_service_tool`）
- 自动支付重试（网关钱包代付）
- 支付前合规闸门（KYC/KYT，需配置 Dashboard；未配置时默认拒绝支付）
- 可选 AP2 保障链（`extra.cartMandate` 存在时启用）
- 支付相关结果可异步上报 Dashboard 交易记录
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
- 返回为 JSON 信封（`ok`、`stage`、`code`、`message`、`traceId`、`detail`），`detail` 中除下游内容外还包含例如 `paymentMade`、`paymentResponse`、`complianceDecision`、`assuranceResult`、`paymentContext` 等字段，便于 Agent 结构化解析。

## 环境变量（推荐直接写在 Cursor MCP 配置）

你可以使用本仓库根目录的 `.env` 文件，也可以直接在 Cursor 的 `mcp.json` 里写 `env`。  
对于「私钥只保留在本机配置」的场景，推荐直接写在 `mcp.json` 的 `env` 中。

### 必填

```bash
EVM_PRIVATE_KEY=0x...
DOWNSTREAM_MCP_URLS=https://vendor.example/mcp,http://localhost:4022/mcp
```

或使用单地址：

```bash
DOWNSTREAM_MCP_URL=https://vendor.example/mcp
```

### 下游连接（可选）

```bash
DOWNSTREAM_MCP_TRANSPORT=auto
DOWNSTREAM_CONNECT_RETRIES=3
```

### Dashboard 合规与记账（可选但强烈建议生产开启）

未同时配置 `COMPLIANCE_BASE_URL` 与 `COMPLIANCE_API_KEY` 时，网关会对所有支付请求 **直接拒绝**（fail-close）。

```bash
COMPLIANCE_BASE_URL=https://your-dashboard.example.com
COMPLIANCE_API_KEY=agt_...
COMPLIANCE_CHAIN=base
```

- `COMPLIANCE_CHAIN`：KYT 等接口使用的链标识，默认 `base`。
- 交易异步上报与 AP2 验签与上述两项共用同一 `baseUrl` / `apiKey`，无需额外变量。

### 字段说明汇总

- `EVM_PRIVATE_KEY`：网关支付钱包私钥（须 `0x` 前缀）
- `DOWNSTREAM_MCP_URLS`：多个下游地址（逗号分隔）
- `DOWNSTREAM_MCP_URL`：单下游地址（`URLS` 未配置时使用）
- `DOWNSTREAM_MCP_TRANSPORT`：
  - `auto`（默认，先 Streamable HTTP 再 SSE）
  - `streamable-http`
  - `sse`
- `DOWNSTREAM_CONNECT_RETRIES`：下游连接重试次数（默认 `3`，范围 `1-10`）

HTTP 接口字段与示例见仓库内 [`api-integration-guide.md`](./api-integration-guide.md)。

## 启动方式

在本仓库根目录执行（请将 `cd` 路径换为你本机克隆位置）：

```bash
cd /path/to/mcp-gateway
pnpm install
pnpm dev
```

生产或本地验证构建产物：

```bash
pnpm run build
pnpm start
```

## Cursor 接入（Command + env）

在 Cursor MCP 配置中，将 `--dir` 后的路径改为 **本仓库根目录的绝对路径**：

```json
{
  "mcpServers": {
    "gateway-mcp": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/mcp-gateway", "dev"],
      "env": {
        "EVM_PRIVATE_KEY": "0x你的私钥",
        "DOWNSTREAM_MCP_URLS": "https://vendor.example/mcp,http://localhost:4022/mcp",
        "DOWNSTREAM_MCP_TRANSPORT": "auto",
        "DOWNSTREAM_CONNECT_RETRIES": "3",
        "COMPLIANCE_BASE_URL": "https://your-dashboard.example.com",
        "COMPLIANCE_API_KEY": "agt_你的密钥"
      }
    }
  }
}
```

说明：

- `command` / `args` 用于拉起本地网关进程。
- `env` 中的变量会注入该进程，等价于运行命令前设置环境变量。
- 适合在本机 `mcp.json` 中管理私钥与 Dashboard API Key。

## 对外分发（npm 包方式）

若希望他人不依赖你的本地仓库路径，可发布为 npm CLI 包（`package.json` 中已配置 `bin`：`x402-mcp-gateway`）。

1. 在本仓库根目录执行打包自检：

```bash
cd /path/to/mcp-gateway
pnpm install
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

最少发这三项信息即可：

- npm 包名（例如 `@your-scope/x402-mcp-gateway`）
- 可直接复制的 Cursor `mcp.json` 配置
- 必填环境变量说明（`EVM_PRIVATE_KEY`、`DOWNSTREAM_MCP_URL` 或 `DOWNSTREAM_MCP_URLS`；若需自动支付通过合规闸门，还需 Dashboard 两项）

发布后 Cursor 配置模板示例：

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

说明依赖未安装。在本仓库根目录执行：

```bash
pnpm install
```

### 2) 启动时报 `Failed to connect downstream`

通常是下游不可达或 transport 不匹配：

- 先验证下游 URL 是否可访问
- 使用 `DOWNSTREAM_MCP_TRANSPORT=auto`
- 适当提高 `DOWNSTREAM_CONNECT_RETRIES`

### 3) Cursor 里显示 MCP 连接失败

重点检查：

- `command` 是否可执行（先在终端里手动跑一遍同样命令）
- `args` 里 `--dir` 是否指向本仓库根目录
- `env.EVM_PRIVATE_KEY` 是否为 `0x` 开头私钥
- `env.DOWNSTREAM_MCP_URLS`（或 `DOWNSTREAM_MCP_URL`）是否可访问

### 4) 日志提示合规配置不完整、支付全部被拒绝

需要同时配置 `COMPLIANCE_BASE_URL` 与 `COMPLIANCE_API_KEY`，且 Dashboard 可访问；否则网关按设计拒绝代付。
