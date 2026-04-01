

# 产品需求文档 (PRD)：通用 Agent 支付验证服务 (Universal Assurance Service)

**产品定位：** 面向泛智能体生态（基于通用 MCP）的 AP2 核心风控、数字验签与额度核销中心。
**核心原则：**
1. 客户端（MCP）保管私钥并在本地签发转账指令；
2. 控制台仅提供数据查询（公钥与 VC 凭证），**验证服务独立进行本地密码学验签与业务规则计算**；
3. 商户端自费发起链上结算（Payee-Settled）。

---

## 1. 核心系统架构与角色边界

系统被精简并划分为以下五个独立模块，彻底实现权限与逻辑分离：

1. **控制台数据源 (Dashboard APIs)：**
   * **卖方服务：** 提供 `11.4 查询账户公钥` 接口，根据商户钱包地址返回真实的公钥（`0x04...`）。
   * **买方服务：** 提供 `11.5 获取 VC 凭证` 接口，根据买方钱包地址返回 W3C VC 格式的意图凭证及当前剩余预算。**（不负责金额校验，全权交由验证服务处理）**。
2. **支付验证服务（本 PRD 核心）：** 负责拉取上述数据，在本地执行三重风控：① 商户公钥验签；② 买家 VC 凭证验签（EIP-712）；③ 本地计算单笔与总预算规则。
3. **支付 MCP (客户端模块)：** 安装在 Agent 中，拦截 402 请求，携带商户发票及买方钱包地址向验证服务申请审批，审批通过后执行 EIP-3009 签名。
4. **下游服务商 (含 Facilitator)：** 提供付费资源。使用商户以太坊私钥进行 EIP-191 签名下发发票 (`Cart Mandate`)，并在最终上链提款。

---

## 2. 核心业务闭环 (Sequence Flow)

1. **触发交易：** Agent 通过 MCP 访问下游付费 API。
2. **开具发票：** 下游服务商返回 HTTP 402，并在 `payload` 中下发 `Cart Mandate`（含商户 EIP-191 签名）。
3. **申请审批：** MCP 拦截 402 响应，向验证模块runAssuranceCheck() 方法请求，携带解码后的 `Cart Mandate` 以及买方钱包地址 (`payer_wallet_address`)。
4. **验证服务向控制台获取数据：**
   * 并行发起 HTTP 请求至控制台：
     * 调用 `API 11.4` 传入 `merchant_address`，获取商户公钥 `publicKey`。
     * 调用 `API 11.5` 传入 `payer_wallet_address`，获取买方 `mandate` 规则、`remainingBudget` 及 `vcJson` 凭证。
5. **验证服务本地纯链下验签与风控（风控大脑）：**
   * **验签 1 (商户身份)：** 使用获取到的商户 `publicKey`，验证发票上的 `merchant_signature`，确保发票未篡改且由该商户签发。
   * **验签 2 (买家意图)：** 提取 `vcJson.proof.proofValue`，独立验证买家 EIP-712 意图授权签名的合法性。
   * **业务计算 (核心兜底)：** 验证服务本地执行金额判定逻辑：
     * 校验 `CartMandate.total_amount <= mandate.perTxLimit`（单笔限额）
     * 校验 `CartMandate.total_amount <= remainingBudget`（总预算水位）
6. **核销与下发指令：** 所有本地校验通过后，并返回 `APPROVED` 状态给 MCP。
7. **本地签名与换取服务：** MCP 继续执行 EIP-3009 签名。商户拿签名去 USDC 合约提款发货。

---

## 3. 核心 方法定义
核心方法： runAssuranceCheck(params)

入参定义 (Input Parameters):

TypeScript
interface AssuranceCheckParams {
  payerWalletAddress: string;  // MCP 本地读取的用户钱包地址
  cartMandate: {
    merchant_id: string;
    merchant_address: string;
    total_amount: string;
    currency: string;
    pay_to: string;
    merchant_signature: string; // 0x... EIP-191 Hex 签名
  };
  dashboardConfigs: {
    apiKey: string;             // 用于调用 11.4 和 11.5 的鉴权 Key
    payeeApiBaseUrl: string;    // 卖方控制台 API 地址
    payerApiBaseUrl: string;    // 买方控制台 API 地址
  };
}
出参定义 (Return Type):

TypeScript
interface AssuranceResult {
  passed: boolean;
  errorCode?: 
    | "MERCHANT_SIGNATURE_INVALID"
    | "VC_PROOF_INVALID"
    | "MANDATE_NOT_FOUND"
    | "MANDATE_EXPIRED"
    | "PER_TX_LIMIT_EXCEEDED"
    | "TOTAL_BUDGET_EXCEEDED"
  errorMessage?: string;
}
```

**Response Body (JSON) — 审批拒绝：**
```json
{
  "status": "REJECTED",
  "error": {
    "code": "PER_TX_LIMIT_EXCEEDED",
    "message": "Transaction amount 0.5 exceeds per-transaction limit of 0.1."
  }
}
```

**错误码体系（严格映射底层业务规则）：**

| 错误码 | 含义 | 对应验证环节 |
|---|---|---|
| `MERCHANT_SIGNATURE_INVALID` | 商户签名无法被查询到的 PublicKey 验证 | 本地验签 (基于 11.4 数据) |
| `VC_PROOF_INVALID` | 意图凭证 (vcJson) 签名验证失败 | 本地验签 (基于 11.5 数据) |
| `MANDATE_NOT_FOUND` | 无有效授权 | 11.5 接口直返 |
| `MANDATE_EXPIRED` | 授权已过期 | 11.5 接口直返 |
| `PER_TX_LIMIT_EXCEEDED` | **单笔金额超限** | 本地逻辑计算 (`amount > perTxLimit`) |
| `TOTAL_BUDGET_EXCEEDED` | **累计金额将超总预算** | 本地逻辑计算 (`amount > remainingBudget`) |



---

## 4. 安全与并发要求

- **数据依赖信任：** 验证服务完全信任通过内网 API Key 从 `11.4` 和 `11.5` 接口返回的公钥和 VC 数据，但绝不信任 MCP 传来的任何未签名金额字段。
---


啊，我完全理解了！是我上一步“跑题”去写代码了。你是希望我把你刚才发给我的 `11.4` 和 `11.5` 的原始接口信息，整理成**标准、美观、可以直接放入你们 API 接口文档库（如 Swagger / Apifox / 飞书文档）的规范文档格式**。

这就为你将这份极其关键的内部依赖接口，整理成标准的 API 接口文档规范：

---
附录

## 11.4 查询账户公钥 (卖方控制台提供)

**接口描述：** 通过商户的钱包地址查询其注册的账户公钥。供 MCP 客户端/验证服务进行密码学验签使用。
**请求方法：** `POST`
**接口路径：** `https://test-agentry-dashboard.zk.me/api/accounts/public-key`
**鉴权方式：** Request Body 中传入 `apiKey`

### 请求参数 (Request Body)
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `apiKey` | string | 是 | 验证服务专属的内部调用 API Key |
| `walletAddress` | string | 是 | 商户的以太坊钱包地址 (例如 `0xabcd...`) |

### 请求示例 (cURL)
```bash
curl -X POST "https://your-domain.com/api/accounts/public-key" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "agt_xxxxxxxxxxxx",
    "walletAddress": "0x834474017B9159aBF489303113bA45622804C3fe"
  }'
```

### 响应参数 (Response Body) - 成功 (HTTP 200)
```json
{
  "code": 80000000,
  "msg": "success",
  "data": {
    "walletAddress": "0x834474017B9159aBF489303113bA45622804C3fe",
    "publicKey": "0x04..." 
  }
}
```

---

## 11.5 验证意图授权并获取 VC 凭证 (买方控制台提供)

**接口描述：** 验证某付款方的意图授权状态，并获取包含 EIP-712 签名的 W3C VC (Verifiable Credential) 凭证。
**⚠️ 核心注意：** 此接口**不再接受** `amount` 参数，即控制台不进行金额验证。调用方 (MCP) 必须获取数据后，在本地自行计算 `amount <= perTxLimit` 和 `amount <= remainingBudget`。
**请求方法：** `POST`
**接口路径：** `https://test-agentry-dashboard.zk.me/api/mandates/intent/vc`
**鉴权方式：** Request Body 中传入 `apiKey`

### 请求参数 (Request Body)
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `apiKey` | string | 是 | 验证服务专属的内部调用 API Key |
| `payerWalletAddress` | string | 是 | 付款方 (买方) 的以太坊钱包地址 |

### 响应参数 (Response Body) - 成功 (HTTP 200)
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `allowed` | boolean | 意图是否有效 (`true`) |
| `mandate` | object | 意图的具体规则详情（含单笔限额、总预算等） |
| `remainingBudget`| string | 当前剩余预算金额 (需调用方进行比对) |
| `usagePercent` | number | 预算使用百分比 |
| `vcJson` | object | W3C VC 格式凭证，内含 EIP-712 签名 (`proof.proofValue`) |

**成功响应 JSON 示例：**
```json
{
  "code": 80000000,
  "msg": "success",
  "data": {
    "allowed": true,
    "mandate": {
      "id": "clxxx...",
      "perTxLimit": "2.00",
      "totalBudget": "5.00",
      "usedAmount": "1.50",
      "transactionCount": 3,
      "expiresAt": "2026-04-24T10:30:00.000Z",
      "status": "active"
    },
    "remainingBudget": "3.50",
    "usagePercent": 30.0,
    "vcJson": { 
      "// 完整 W3C Verifiable Credential //": "...",
      "proof": {
         "proofValue": "0x..."
      }
    }
  }
}
```

> 💡 **安全提示：** `vcJson` 包含底层的 EIP-712 签名 (`proof.proofValue`)，调用方可使用请求参数中的 `payerWalletAddress` 独立验证签名合法性。

### 响应参数 (Response Body) - 拒绝 (HTTP 200)
当买方控制台发现该钱包地址没有意图、或意图已被撤销/过期时，直接返回拒绝信息。

**拒绝响应 JSON 示例：**
```json
{
  "code": 80000053,
  "msg": "Mandate validation failed: MANDATE_NOT_FOUND",
  "data": {
    "allowed": false,
    "reason": "MANDATE_NOT_FOUND"
  }
}
```


