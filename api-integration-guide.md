# Agentry Dashboard API 对接指南

本文档介绍如何对接 Agentry Dashboard 提供的两个开放接口：

- **KYC 状态查询**：查询某钱包地址是否完成了 KYC 认证
- **KYT 风险检测**：对钱包地址进行链上风险评分

---

## 前置条件

调用以下接口均需要持有一个有效的 **API Key**。

API Key 在 Agentry Dashboard 中生成：

- **Payer（付款方）**：进入 Dashboard → Payer → 点击 "Generate API Key"
- **Payee（收款方）**：进入 Dashboard → Payee → 点击 "Generate API Key"

> API Key 仅在生成时展示一次，请妥善保存。

---

## 一、KYC 状态查询

### 接口信息

| 字段         | 值                   |
| ------------ | -------------------- |
| 请求方法     | `POST`               |
| 接口路径     | `/api/kyc/check`     |
| Content-Type | `application/json`   |
| 鉴权方式     | Body 中传入 `apiKey` |

### 请求 Body

| 参数名          | 类型   | 必填 | 说明                                     |
| --------------- | ------ | ---- | ---------------------------------------- |
| `apiKey`        | string | 是   | 你的 API Key（以 `agt_` 开头）           |
| `walletAddress` | string | 是   | 要查询的钱包地址（EVM 格式，支持大小写） |

### 请求示例

```bash
curl -X POST "https://your-domain.com/api/kyc/check" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "agt_xxxxxxxxxxxx",
    "walletAddress": "0x1234567890abcdef1234567890abcdef12345678"
  }'
```

```javascript
const res = await fetch("https://your-domain.com/api/kyc/check", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    apiKey: "agt_xxxxxxxxxxxx",
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
  }),
});
const data = await res.json();
```

### 返回格式

**成功（HTTP 200）**

```json
{
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "kycCompleted": true,
  "kycStatus": "approved"
}
```

| 字段            | 类型           | 说明                                                                   |
| --------------- | -------------- | ---------------------------------------------------------------------- |
| `walletAddress` | string         | 查询的钱包地址（已转为小写）                                           |
| `kycCompleted`  | boolean        | 是否已完成 KYC（`kycStatus === "approved"` 时为 `true`）               |
| `kycStatus`     | string \| null | KYC 状态：`"approved"` / `"pending"` / `"rejected"` / `null`（未注册） |

**kycStatus 说明**

| 值           | 含义                     |
| ------------ | ------------------------ |
| `"approved"` | KYC 已通过               |
| `"pending"`  | KYC 进行中               |
| `"rejected"` | KYC 未通过               |
| `null`       | 该钱包地址未在系统中注册 |

### 错误返回

| HTTP 状态码 | error 字段                     | 含义                    |
| ----------- | ------------------------------ | ----------------------- |
| `400`       | `"Invalid JSON body"`          | 请求体不是合法 JSON     |
| `400`       | `"walletAddress is required"`  | 未传 walletAddress 参数 |
| `403`       | `"API key is required"`        | 未传 apiKey 参数        |
| `403`       | `"Invalid API key"`            | API Key 无效或已失效    |
| `500`       | `"Failed to check KYC status"` | 服务器内部错误          |

**错误返回示例**

```json
{
  "error": "Invalid API key"
}
```

---

## 二、KYT 风险检测

### 接口信息

| 字段         | 值                          |
| ------------ | --------------------------- |
| 请求方法     | `POST`                      |
| 接口路径     | `/api/compliance/kyt/check` |
| Content-Type | `application/json`          |
| 鉴权方式     | Body 中传入 `apiKey`        |
| 数据提供方   | SlowMist MistTrack          |

### 请求 Body

| 参数名          | 类型   | 必填 | 说明                                                   |
| --------------- | ------ | ---- | ------------------------------------------------------ |
| `apiKey`        | string | 是   | 你的 API Key（以 `agt_` 开头）                         |
| `walletAddress` | string | 是   | 要检测的钱包地址（EVM 格式，`0x` 开头，40 位十六进制） |
| `chain`         | string | 否   | 链标识，目前支持：`"base"`，不传默认为 `"base"`        |

### 请求示例

```bash
curl -X POST "https://your-domain.com/api/compliance/kyt/check" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "agt_xxxxxxxxxxxx",
    "walletAddress": "0x1234567890abcdef1234567890abcdef12345678",
    "chain": "base"
  }'
```

```javascript
const res = await fetch("https://your-domain.com/api/compliance/kyt/check", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    apiKey: "agt_xxxxxxxxxxxx",
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    chain: "base", // 可选，默认 "base"
  }),
});
const data = await res.json();
```

### 返回格式

**成功（HTTP 200）**

```json
{
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "chain": "base",
  "riskLevel": "low",
  "riskScore": 10,
  "decision": "pass",
  "signals": [],
  "provider": "slowmist",
  "checkedAt": "2026-03-17T08:00:00.000Z",
  "cached": false,
  "reportUrl": "https://misttrack.io/..."
}
```

| 字段        | 类型                 | 说明                                                   |
| ----------- | -------------------- | ------------------------------------------------------ |
| `address`   | string               | 检测的钱包地址（已转为小写）                           |
| `chain`     | string               | 检测的链标识                                           |
| `riskLevel` | string               | 风险等级，见下方说明                                   |
| `riskScore` | number               | 风险分值（0–100）                                      |
| `decision`  | string               | 处置建议：`"pass"` 放行 / `"reject"` 拒绝              |
| `signals`   | string[]             | 风险信号列表（如涉及交易所黑名单、混币等）             |
| `provider`  | string               | 数据提供方，固定为 `"slowmist"`                        |
| `checkedAt` | string               | 检测时间（ISO 8601）                                   |
| `cached`    | boolean              | 是否为缓存结果（默认缓存 10 分钟）                     |
| `reportUrl` | string \| undefined  | MistTrack 详细风险报告链接（可能为空）                 |
| `degraded`  | boolean \| undefined | `true` 表示 KYT 服务降级，结果为保守值，不代表真实风险 |

**riskLevel 说明**

| 值           | riskScore 参考范围 | decision   | 含义                   |
| ------------ | ------------------ | ---------- | ---------------------- |
| `"low"`      | 0–30               | `"pass"`   | 低风险，建议放行       |
| `"moderate"` | 31–60              | `"pass"`   | 中等风险，建议人工审核 |
| `"high"`     | 61–85              | `"reject"` | 高风险，建议拒绝       |
| `"severe"`   | 86–100             | `"reject"` | 极高风险，建议拒绝     |

### 错误返回

| HTTP 状态码 | error 字段            | 含义                |
| ----------- | --------------------- | ------------------- |
| `400`       | `"INVALID_REQUEST"`   | 请求体不是合法 JSON |
| `400`       | `"INVALID_ADDRESS"`   | 钱包地址格式不合法  |
| `400`       | `"UNSUPPORTED_CHAIN"` | 不支持的链标识      |
| `401`       | `"UNAUTHORIZED"`      | API Key 未传或无效  |
| `500`       | `"INTERNAL_ERROR"`    | KYT 服务不可用      |

**错误返回示例**

```json
{
  "error": "UNAUTHORIZED",
  "message": "Invalid or expired API key"
}
```

.1 写入交易记录
字段
值
请求方法
POST
接口路径
/api/transactions
鉴权方式
无
请求 Body
参数名
类型
必填
说明
serviceName
string
是
被调用的服务/工具名称，如 "get_weather"
serviceResult
string
是
服务调用结果，如 "pass" / "reject" / "error"
chain
string
是
链标识，如 "eip155:84532"、"base"
txHash
string
否
链上交易哈希（0x 开头）
amount
string | number
否
转账金额（支持高精度小数）
tokenSymbol
string
否
Token 符号，如 "USDC"、"ETH"
payer
string
否
付款方钱包地址（自动转小写存储）
payee
string
否
收款方钱包地址（自动转小写存储）
payerKycResult
number
否
付款方 KYC 结果：1 = approved，0 = rejected
payerKytResult
number
否
付款方 KYT 结果：1 = pass，0 = reject
payerKytRiskLevel
number
否
付款方 KYT 风险等级：0 = low，1 = moderate，2 = high，3 = severe
payeeKycResult
number
否
收款方 KYC 结果：1 = approved，0 = rejected
payeeKytResult
number
否
收款方 KYT 结果：1 = pass，0 = reject
payeeKytRiskLevel
number
否
收款方 KYT 风险等级：0 = low，1 = moderate，2 = high，3 = severe
metadata
object
否
扩展信息（任意 JSON 对象），如 调用上下文等
返回格式（HTTP 201）
{
"id": 1,
"serviceName": "get_weather",
"serviceResult": "pass",
"chain": "eip155:84532",
"txHash": "0x1e599faf...",
"amount": "0.1",
"tokenSymbol": "USDC",
"payer": "0x8344...",
"payee": "0xb5ca...",
"payerKycResult": 1,
"payerKytResult": 1,
"payerKytRiskLevel": 0,
"payeeKycResult": 1,
"payeeKytResult": 1,
"payeeKytRiskLevel": 0,
"metadata": { },
"createdAt": "2026-03-19T07:02:41.292Z"
}

---

## 三、两个接口对比

|              | KYC 状态查询                | KYT 风险检测                         |
| ------------ | --------------------------- | ------------------------------------ |
| 接口路径     | `POST /api/kyc/check`       | `POST /api/compliance/kyt/check`     |
| 鉴权方式     | Body 传 `apiKey`            | Body 传 `apiKey`                     |
| 必填参数     | `apiKey`、`walletAddress`   | `apiKey`、`walletAddress`            |
| 可选参数     | 无                          | `chain`（默认 `"base"`）             |
| 返回核心字段 | `kycCompleted`、`kycStatus` | `riskLevel`、`decision`、`riskScore` |

---

## 四、常见问题

**Q：如何获取 API Key？**

> 登录 Dashboard 后进入 Payer 或 Payee 页面，点击 "Generate API Key" 生成。API Key 仅在生成时展示一次，请妥善保存。

**Q：KYT 结果会缓存多久？**

> 默认缓存 10 分钟（600 秒）。缓存期间返回的 `cached: true`，到期后重新请求 SlowMist 获取最新数据。

**Q：KYT 返回 `degraded: true` 是什么意思？**

> 表示 KYT 上游服务（SlowMist）暂时不可用，系统进入降级模式，返回保守的低风险结果，不代表地址真实风险状况。建议延迟处理或人工审核。

**Q：KYC 查询支持哪些链的地址？**

> KYC 查询的是账户体系内的钱包地址（EVM 地址，`0x` 开头），与具体链无关，只需提供地址字符串即可。

**Q：目前 KYT 支持哪些链？**

> 目前仅支持 `"base"`（Base 链）。不传 `chain` 时默认使用 `"base"`。后续将扩展更多链。
