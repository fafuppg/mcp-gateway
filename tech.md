技术规范文档：UAFG v2.0 重构实施指南
1. 架构目标与策略
本次重构的核心目标是**“控制流解耦”**。我们将废弃高度封装的 @x402/mcp Client，转而使用 @modelcontextprotocol/sdk 的原生 Client，由网关自主实现对 PaymentRequired 挑战的捕获、AP2/KYC 验证及 _meta 二次调用。

2. 实施计划 (三阶段)
阶段 1：脱离 SDK 控制流与 KYT 清理（核心高优）
本阶段只改变控制权的归属，不改变对外协议。

网络层重构：

在 index.ts 中移除 createx402MCPClient。

使用原生 MCP Client 建立连接。

挑战解析与处理引擎：

移植 x402 源码中的 extractPaymentRequiredFromResult 逻辑，识别 isError: true 中的支付挑战。

并发调度：在提取到挑战数据后，使用 Promise.all 并发触发 runAssuranceCheck (AP2) 和 runComplianceChecks (KYC)。

重新封装调用：

验证通过后，调用 @x402/evm 的 ExactEvmScheme 生成支付签名。

将签名注入 _meta["x402/payment"] 发起第二次 callTool。

KYT 彻底清理：

compliance.ts：删除所有 KYT 请求逻辑、接口定义及 KYT_REJECTED 等错误码。

transaction.ts：与 Dashboard 团队确认。若 API 已废弃 KYT 字段则删除；若契约需要则硬编码传 null/0 占位。移除 ComplianceConfig.chain。

阶段 2：支付驱动抽象层 (Payment Driver)
在阶段 1 跑通后，将硬编码的 @x402/evm 逻辑抽象化，为未来支持其他支付协议做准备。

修正后的驱动接口定义：
驱动的职责是“生成载荷”而非“执行交易”。

TypeScript
export interface IPaymentDriver {
  supportedNetworks: string[];
  supportedTokens: string[];
  createPaymentPayload(requirements: PaymentRequirements): Promise<PaymentPayload>;
}
实现默认驱动：编写 UsdcEvmDriver 类实现上述接口。

路由匹配：在网关内部实现简单的路由逻辑。遍历 PaymentRequired.accepts，寻找本地已注册且优先级最高的驱动进行实例化调用。

阶段 3：目录结构优化 (代码重构)
随着网关功能从单脚本演进为复杂中间件，将源码进行合理分层（建议在阶段 2 完成后进行）：

Plaintext
src/
├── core/
│   ├── assurance.ts        # AP2 三重验证核心
│   └── compliance.ts       # KYC 验证模块
├── drivers/
│   ├── payment-driver.interface.ts
│   └── usdc-evm.driver.ts  # x402 EVM 签名实现
├── engine/
│   ├── payment-engine.ts           # 驱动路由与匹配
│   └── payment-required-parser.ts  # MCP 结果解析器
├── transaction/
│   └── transaction.ts      # 异步记账上报
└── index.ts                # 原生 Client 连接与主流程编排
3. 关键交互代码防伪 (Pseudo-code Reference)
TypeScript
// 核心调用流伪代码示意 (阶段 1 实现参考)
async function callToolWithPaymentHandling(client, toolName, args) {
  // 1. 首次调用
  const result = await client.callTool({ name: toolName, arguments: args });
  
  // 2. 检查是否为支付挑战
  const paymentRequired = extractPaymentRequiredFromResult(result);
  if (!paymentRequired) return result; // 普通返回
  
  // 3. 并发执行 AP2 与 KYC (依赖提取出的 context)
  const cartMandate = extractCartMandate(paymentRequired.accepts[0].extra);
  const payeeAddress = extractCounterpartyAddress(paymentRequired.accepts[0].payTo);
  
  const [assuranceRes, complianceRes] = await Promise.all([
    runAssuranceCheck(config, gatewayWallet, cartMandate),
    runComplianceChecks(config, payeeAddress) // 仅剩 KYC
  ]);
  
  if (!assuranceRes.passed || !complianceRes.passed) {
     throw new Error("Payment rejected by gateway policies.");
  }
  
  // 4. 调用驱动生成签名 (阶段 2 抽象目标)
  const driver = matchPaymentDriver(paymentRequired.accepts);
  const paymentPayload = await driver.createPaymentPayload(paymentRequired);
  
  // 5. 携带凭证发起二次调用
  return await client.callTool({
     name: toolName, 
     arguments: args,
     _meta: { "x402/payment": paymentPayload } // MCP 协议标准拓展
  });
}