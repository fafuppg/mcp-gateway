产品需求文档 (PRD)：通用智能体财务与合规验证网关 v2.0 (修正版)
1. 产品概述
产品名称：Universal Agent Financial Gateway (UAFG)

核心目标：构建一个以 AP2 协议为风控核心的财务侧车，为 AI Agent 的自动化交易提供身份验签 (Merchant/User)、意图核销 (Intent) 及预算控制 (Budget)。

核心变更 (v2.0)：解耦 @x402/mcp SDK 的黑盒回调机制，夺回网关对调用流的主动控制权；移除 KYT 流程；抽象签名生成驱动；保留 x402 协议层的兼容性。

2. 核心架构设计
2.1 支付挑战主动拦截 (MCP Tool Result Interception)
网关不再作为 x402 SDK 的“附属回调”运行，而是通过原生 MCP Client 掌控全局。

主动解析：网关在执行原生的 callTool 后，主动解析返回的工具结果。当发现 isError: true 且内容中包含 PaymentRequired 数据结构时，准确识别为支付挑战。

控制权反转：由网关自主决定何时解析发票 (CartMandate)，何时触发合规校验，以及何时发起二次带有支付凭证的工具调用。

2.2 支付驱动层 (Payment Driver Abstraction)
遵循 AP2 的 Payee-Settled（收款方结算）原则，网关不直接消耗 Gas 发送链上交易。

决策层：AP2 模块输出 APPROVED（准予支付）或 REJECTED（拒绝）。

执行层（驱动插件）：

职责：驱动不直接“付款”，而是根据商户要求生成加密授权签名（如 EIP-3009 PaymentPayload）。

现阶段支持：首选支持 UsdcEvmDriver（底层封装 @x402/evm），专门负责生成签名。

3. 功能需求
3.1 独立 AP2 校验流程 (Strict Google AP2 Logic)
在成功解析出商户的 PaymentRequired 挑战并提取出 CartMandate 后，网关执行 AP2 的三重验证逻辑：

商户保障 (Merchant Assurance)：调用 API 11.4 获取商户非压缩公钥，执行 EIP-191 商户签名验证。

用户意图保障 (User Intent Assurance)：调用 API 11.5 获取买方 VC 凭证，执行 EIP-712 用户意图授权验证。

预算保障 (Budget Assurance)：本地校验 amount <= perTxLimit（单笔限额）且 amount <= remainingBudget（剩余总预算）。

3.2 模块化合规检查 (KYC Only)
全面下线 KYT 流程（包括从 Dashboard 记录中移除或清空对应字段），仅保留 KYC 闸门。

KYC 验证：调用 /api/kyc/check。

准入原则：仅当 kycCompleted === true 且 kycStatus === "approved" 时，方可放行。

并发优化：在解析出支付挑战（获取到对手方地址和发票数据）后，KYC 验证与 AP2 验证须并发执行，以降低支付延迟。

4. 标准交互时序
初始调用：Agent 通过网关发起第一次原生 MCP callTool 请求。

触发挑战：下游商户返回普通工具结果（包含 isError: true 和 PaymentRequired 结构及带签名的 CartMandate）。

网关拦截与并发验证：

网关解析该挑战。

并发执行：runAssuranceCheck (AP2风控) 与 checkKYC (合规闸门)。

生成签名：双重验证通过后，调用 Payment Driver 生成支付授权签名 (PaymentPayload)。

二次调用：网关携带该签名（放入 _meta["x402/payment"]），发起第二次 callTool 请求。

结算与反馈：商户在链上结算，并向网关交付最终真实的工具执行结果。

5. 异常处理
验签失败：拦截二次调用，返回 MERCHANT_SIGNATURE_INVALID 或 VC_PROOF_INVALID。

预算超限：拦截二次调用，返回 PER_TX_LIMIT_EXCEEDED 或 TOTAL_BUDGET_EXCEEDED。

驱动缺失：若网关缺少对应网络/币种的驱动，返回 PAYMENT_METHOD_UNSUPPORTED。