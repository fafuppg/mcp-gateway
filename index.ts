#!/usr/bin/env node
/**
 * UAFG v2.0 — Universal Agent Financial Gateway（付款侧网关）
 *
 * 角色定位：
 * 1) 对上游 Agent（如 Cursor）暴露一个统一的 MCP 服务入口（stdio）。
 * 2) 将工具调用转发给一个或多个下游 MCP 服务。
 * 3) 当下游返回支付挑战（PaymentRequired）时，网关自主执行合规校验和 AP2 风控。
 * 4) 校验通过后，生成支付签名并携带凭证发起二次调用完成支付。
 * 5) 支付完成后，异步写入交易记录到 Dashboard。
 *
 * v2.0 核心变更：
 * - 脱离 @x402/mcp SDK 的黑盒回调，使用原生 MCP Client 自主控制支付流程。
 * - 使用 @x402/core 的 x402Client 独立生成 PaymentPayload（签名授权）。
 * - 移除 KYT 流程，仅保留 KYC 闸门。
 * - KYC 与 AP2 验证并发执行，降低支付延迟。
 *
 * 核心链路（简化）：
 * Agent -> gateway.call_service_tool -> 首次 callTool
 *       -> 解析 PaymentRequired -> 并发 KYC + AP2
 *       -> 生成 PaymentPayload -> 二次 callTool（含 _meta）
 *       -> 提取回执 -> 异步 recordTransaction
 *
 * @author kuangyp
 * @version 2026-04-02
 */
import { config } from "dotenv";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { isPaymentRequired, type PaymentRequired } from "@x402/core/schemas";

import {
  sleep,
  runComplianceChecks,
  extractPayeeCompliance,
  type ComplianceConfig,
  type ComplianceDecision,
  type PayeeComplianceDecision,
} from "./compliance.js";

import {
  extractPaymentResponseData,
  buildTransactionPayload,
  recordTransaction,
  type TransactionConfig,
  type PaymentContext,
} from "./transaction.js";

import {
  runAssuranceCheck,
  type AssuranceConfig,
  type AssuranceResult,
  type CartMandate,
} from "./assurance.js";

config(); // 加载环境变量

// =====================================================================
// 类型定义
// =====================================================================

type JsonObject = Record<string, unknown>;
type DownstreamTransportMode = "auto" | "sse" | "streamable-http";

/**
 * 原生 MCP Client callTool 的返回结构（简化类型，保留网关所需字段）。
 *
 * 原始类型是复杂的联合类型（含 toolResult 分支等），
 * 此处仅关注网关实际使用的字段，通过索引签名兼容其他未知字段。
 */
interface McpCallToolResult {
  [key: string]: unknown;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * 网关内部工具调用结果。
 *
 * 在原生 MCP callTool 返回的基础上，附加支付相关的元数据。
 */
interface GatewayToolCallResult {
  content: McpCallToolResult["content"];
  isError?: boolean;
  /** 本次调用是否发生了支付 */
  paymentMade: boolean;
  /** 支付回执（来自 _meta["x402/payment-response"]），仅 paymentMade=true 时有值 */
  paymentResponse: unknown;
  /** 合规检查决策（仅发生支付挑战时有值） */
  complianceDecision: ComplianceDecision | null;
  /** AP2 保障验证结果（仅发生支付挑战且含 CartMandate 时有值） */
  assuranceResult: AssuranceResult | null;
  /** 支付上下文（金额/收款方/网络等） */
  paymentContext: PaymentContext | null;
}

/**
 * 下游服务注册表记录。
 *
 * 字段说明：
 * - serviceId: 网关内部编号，便于在调用时指定目标下游。
 * - url: 下游 MCP 地址。
 * - transport: 实际连接成功使用的传输协议（streamable-http 或 sse）。
 * - client: 原生 MCP 客户端实例。
 * - tools: 下游已发现的工具清单。
 */
interface DownstreamServiceRecord {
  serviceId: string;
  url: string;
  transport: Exclude<DownstreamTransportMode, "auto">;
  client: Client;
  tools: Array<{ name: string; description?: string }>;
}

/**
 * 网关统一结果信封（成功/失败都使用同一结构）。
 *
 * 这样 AI 不需要猜测字符串语义，直接按字段解释即可。
 */
interface GatewayEnvelope<TDetail = JsonObject> {
  ok: boolean;
  stage:
  | "request_received"
  | "service_selected"
  | "tool_execution"
  | "payment_requested"
  | "compliance_check"
  | "assurance_check";
  code: string;
  message: string;
  traceId: string;
  timestamp: string;
  detail: TDetail;
}

// =====================================================================
// x402 协议常量
// =====================================================================

/** 二次调用时携带支付签名的 _meta key（x402 协议标准） */
const MCP_PAYMENT_META_KEY = "x402/payment";
/** 二次调用返回时服务端附带结算回执的 _meta key */
const MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

// =====================================================================
// 配置读取
// =====================================================================

/**
 * Dashboard / 合规与 AP2 服务根地址（硬编码）。
 * 切换环境时只需修改本常量，无需再配置环境变量 COMPLIANCE_BASE_URL。
 * 请勿留空；末尾斜杠可有可无，下游模块会自行规范化。
 */
const COMPLIANCE_BASE_URL = "https://test-agentry-dashboard.zk.me";

const evmPrivateKey = requireHexPrivateKey("EVM_PRIVATE_KEY");

/**
 * 模块级 EVM 账户实例。
 *
 * 所有下游连接共用同一个钱包，同时将地址暴露给 AP2 验证作为 payerWalletAddress。
 */
const gatewayAccount = privateKeyToAccount(evmPrivateKey);
const gatewayWalletAddress = gatewayAccount.address;

/**
 * 模块级 x402 支付客户端（独立于 MCP，专门负责生成支付签名）。
 *
 * 内部注册了 ExactEvmScheme，调用 createPaymentPayload 时自动完成：
 * 1) 从 PaymentRequired.accepts 中按已注册 scheme 过滤
 * 2) 选择最优的 PaymentRequirements
 * 3) 调用 ExactEvmScheme 生成 EIP-3009 / Permit2 签名
 * 4) 包装为完整的 PaymentPayload（含 x402Version / resource / accepted）
 */
const paymentClient = new x402Client();
paymentClient.register("eip155:84532", new ExactEvmScheme(gatewayAccount));

/** 合规服务配置（仅 KYC）；baseUrl 来自上方常量，apiKey 仍从环境变量读取 */
const complianceConfig: ComplianceConfig | null = (() => {
  const baseUrl = COMPLIANCE_BASE_URL.trim();
  const apiKey = process.env.COMPLIANCE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error(
      "⚠️ 合规配置不完整（COMPLIANCE_BASE_URL 常量为空或 COMPLIANCE_API_KEY 环境变量缺失），合规检查将拒绝所有支付",
    );
    return null;
  }
  return { baseUrl, apiKey, maxRetries: 5 };
})();

/** 交易记录服务配置（与合规服务共享域名和 API Key） */
const transactionConfig: TransactionConfig | null = complianceConfig
  ? { baseUrl: complianceConfig.baseUrl, apiKey: complianceConfig.apiKey }
  : null;

/**
 * AP2 验证服务配置。
 *
 * 与合规服务共用同一个 Dashboard 的 baseUrl 和 apiKey，
 * 无需额外配置新的环境变量。
 */
const assuranceConfig: AssuranceConfig | null = complianceConfig
  ? { baseUrl: complianceConfig.baseUrl, apiKey: complianceConfig.apiKey }
  : null;

const rawDownstreamUrls = process.env.DOWNSTREAM_MCP_URLS ?? process.env.DOWNSTREAM_MCP_URL;
if (!rawDownstreamUrls) {
  console.error("❌ 缺少环境变量 DOWNSTREAM_MCP_URL 或 DOWNSTREAM_MCP_URLS，无法确定下游服务地址");
  process.exit(1);
}

const downstreamUrls = rawDownstreamUrls
  .split(",")
  .map((url: string) => url.trim())
  .filter(Boolean);

if (downstreamUrls.length === 0) {
  console.error("❌ 至少需要配置一个下游 MCP 地址");
  process.exit(1);
}

const transportMode = parseTransportMode(process.env.DOWNSTREAM_MCP_TRANSPORT);
const connectRetries = parseConnectRetries(process.env.DOWNSTREAM_CONNECT_RETRIES);

// =====================================================================
// 配置解析工具
// =====================================================================

/**
 * 从环境变量读取十六进制私钥。
 * 必须存在且以 0x 开头，否则启动失败。
 */
function requireHexPrivateKey(envName: string): `0x${string}` {
  const value = process.env[envName];
  if (!value) {
    console.error(`❌ 缺少环境变量 ${envName}，网关无法启动`);
    process.exit(1);
  }
  if (!value.startsWith("0x")) {
    throw new Error(`${envName} must start with 0x.`);
  }
  return value as `0x${string}`;
}

/** 解析下游传输模式：auto / sse / streamable-http */
function parseTransportMode(value?: string): DownstreamTransportMode {
  if (!value) return "auto";
  if (value === "auto" || value === "sse" || value === "streamable-http") return value;
  throw new Error(`Invalid DOWNSTREAM_MCP_TRANSPORT: ${value}. Expected one of auto|sse|streamable-http.`);
}

/** 解析下游连接重试次数，限制在 [1, 10] */
function parseConnectRetries(value?: string): number {
  if (!value) return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`Invalid DOWNSTREAM_CONNECT_RETRIES: ${value}. Expected integer in [1,10].`);
  }
  return parsed;
}

// =====================================================================
// EVM 地址工具
// =====================================================================

/** 校验地址是否为合法 EVM 地址（0x + 40位十六进制） */
function isValidEvmAddress(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

/**
 * 从 paymentRequired.accepts[0].extra 中提取 CartMandate。
 *
 * 下游服务器将 CartMandate 对象嵌套放在 extra.cartMandate 字段中，
 * 保留 extra 顶层的 name/version（EIP-712 domain 参数）不受干扰：
 *   extra = { name: "USDC", version: "2", cartMandate: { merchant_id, ... } }
 *
 * 提取策略：
 * 1) 优先尝试 extra.cartMandate（嵌套格式，下游标准格式）
 * 2) 回退到 extra 顶层字段（兼容直接平铺格式）
 *
 * 若最终找不到三个必填字段（merchant_id / merchant_address / merchant_signature），
 * 则说明本次不是 AP2 场景，返回 null 跳过 AP2 校验（向后兼容非 AP2 下游）。
 */
function extractCartMandate(extra: unknown): CartMandate | null {
  if (!extra || typeof extra !== "object") return null;
  const obj = extra as Record<string, unknown>;

  // 优先从嵌套的 cartMandate 字段提取（下游标准输出格式）
  const nested = obj.cartMandate;
  const source: Record<string, unknown> =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : obj;

  // 三个必填字段不完整时视为非 AP2 支付，跳过校验
  if (
    typeof source.merchant_id !== "string" ||
    typeof source.merchant_address !== "string" ||
    typeof source.merchant_signature !== "string"
  ) {
    return null;
  }

  return {
    merchant_id: source.merchant_id,
    merchant_address: source.merchant_address,
    total_amount: typeof source.total_amount === "string" ? source.total_amount : String(source.total_amount ?? "0"),
    currency: typeof source.currency === "string" ? source.currency : undefined,
    pay_to: typeof source.pay_to === "string" ? source.pay_to : undefined,
    merchant_signature: source.merchant_signature,
  };
}

/** 从下游 paymentRequired 中提取并标准化收款方地址 */
function extractCounterpartyAddress(payTo: unknown): `0x${string}` | null {
  if (typeof payTo !== "string") return null;
  const normalized = payTo.trim();
  if (!isValidEvmAddress(normalized)) return null;
  return normalized.toLowerCase() as `0x${string}`;
}

// =====================================================================
// 支付挑战解析（从 x402 SDK 移植的核心逻辑）
// =====================================================================

/**
 * 从 MCP callTool 返回结果中解析 PaymentRequired 支付挑战。
 *
 * 检测逻辑（与 x402 SDK 的 extractPaymentRequiredFromResult 一致）：
 * 1) 结果必须是 isError: true（支付挑战以错误形式返回）
 * 2) 优先检查 structuredContent 中是否直接包含 PaymentRequired 对象
 * 3) 回退检查 content[0].text 中的 JSON 字符串
 * 4) 通过 @x402/core/schemas 的 isPaymentRequired 进行结构验证
 *
 * 若不是支付挑战（普通工具结果或普通错误），返回 null。
 *
 * @param result 原生 MCP Client callTool 的返回值。
 * @returns PaymentRequired 对象（若为支付挑战），或 null。
 */
function extractPaymentRequiredFromResult(result: McpCallToolResult): PaymentRequired | null {
  if (!result.isError) return null;

  // 优先检查 structuredContent（x402 MCP transport 首选格式）
  if (result.structuredContent && isPaymentRequired(result.structuredContent)) {
    return result.structuredContent;
  }

  // 回退检查 content[0].text 中的 JSON
  if (!result.content || result.content.length === 0) return null;
  const firstItem = result.content[0];
  if (firstItem.type !== "text" || typeof firstItem.text !== "string") return null;

  try {
    const parsed = JSON.parse(firstItem.text);
    if (typeof parsed === "object" && parsed !== null && isPaymentRequired(parsed)) {
      return parsed as PaymentRequired;
    }
  } catch {
    // 非 JSON 文本，不是支付挑战
  }
  return null;
}

// =====================================================================
// 网关内部工具
// =====================================================================

/** 生成本次调用的追踪 ID */
function createTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// =====================================================================
// 核心支付处理管线
// =====================================================================

/**
 * 带支付处理的工具调用（网关控制流核心）。
 *
 * 完整流程：
 * 1) 通过原生 MCP Client 发起首次 callTool
 * 2) 解析返回结果，判断是否为支付挑战（PaymentRequired）
 * 3) 若非支付挑战，直接返回结果
 * 4) 若为支付挑战：
 *    a) 提取收款方地址和 CartMandate
 *    b) 并发执行 KYC 合规检查 + AP2 三重验签
 *    c) 双重校验通过后，调用 x402Client 生成 PaymentPayload（签名授权）
 *    d) 携带签名在 _meta["x402/payment"] 中发起二次 callTool
 *    e) 从二次调用结果的 _meta["x402/payment-response"] 中提取支付回执
 * 5) 异步写入交易记录
 *
 * @param client 原生 MCP Client（已连接到下游）。
 * @param serviceId 下游服务标识符。
 * @param toolName 要调用的下游工具名。
 * @param args 传递给下游工具的参数。
 * @returns 网关工具调用结果（含支付元数据）。
 */
async function callToolWithPaymentHandling(
  client: Client,
  serviceId: string,
  toolName: string,
  args: JsonObject,
): Promise<GatewayToolCallResult> {
  // ── Step 1: 首次调用 ──────────────────────────────────────────────
  const firstResult = await client.callTool({ name: toolName, arguments: args }) as McpCallToolResult;

  // ── Step 2: 解析支付挑战 ──────────────────────────────────────────
  const paymentRequired = extractPaymentRequiredFromResult(firstResult);
  if (!paymentRequired) {
    // 非支付挑战：普通成功或普通错误，直接返回
    return {
      content: firstResult.content,
      isError: firstResult.isError,
      paymentMade: false,
      paymentResponse: null,
      complianceDecision: null,
      assuranceResult: null,
      paymentContext: null,
    };
  }

  console.error(`💳 检测到支付挑战：服务=${serviceId}，工具=${toolName}，accepts数量=${paymentRequired.accepts.length}`);

  // ── Step 3: 提取支付上下文 ────────────────────────────────────────
  const accepted = paymentRequired.accepts[0];
  if (!accepted) {
    throw new Error("PaymentRequired.accepts is empty, cannot proceed with payment.");
  }

  const counterparty = extractCounterpartyAddress(accepted.payTo);
  if (!counterparty) {
    throw new Error(`Invalid counterparty address in PaymentRequired: payTo=${String(accepted.payTo)}`);
  }

  const acceptedAny = accepted as Record<string, unknown>;
  const extra = acceptedAny.extra as Record<string, unknown> | undefined;
  const cartMandate = extractCartMandate(extra);

  // V1 uses maxAmountRequired, V2 uses amount
  const rawAmount = String(acceptedAny.maxAmountRequired ?? acceptedAny.amount ?? "0");

  const paymentCtx: PaymentContext = {
    amount: rawAmount,
    payTo: counterparty,
    network: accepted.network,
    tokenSymbol: (extra?.["name"] as string | undefined) ?? "UNKNOWN",
  };

  // ── Step 4: 并发执行 KYC + AP2 ───────────────────────────────────
  // 合规配置缺失时直接拒绝（fail-close）
  if (!complianceConfig) {
    const decision: ComplianceDecision = {
      serviceId, toolName, counterparty, passed: false,
      reasonCode: "COMPLIANCE_CONFIG_MISSING",
      message: "Compliance configuration is missing.",
      checkedAt: new Date().toISOString(),
    };
    throw new PaymentRejectedError("compliance_check", decision, null, paymentCtx);
  }

  // KYC 和 AP2 并发调度
  const compliancePromise = runComplianceChecks(complianceConfig, serviceId, toolName, counterparty);

  let assurancePromise: Promise<AssuranceResult | null>;
  if (cartMandate && assuranceConfig) {
    assurancePromise = runAssuranceCheck(assuranceConfig, gatewayWalletAddress, cartMandate);
  } else if (cartMandate && !assuranceConfig) {
    // 含 CartMandate 但缺少 AP2 配置，fail-close 拒绝
    const failResult: AssuranceResult = {
      passed: false,
      errorCode: "CART_MANDATE_MISSING",
      errorMessage: "Assurance configuration is missing but CartMandate is present.",
      checkedAt: new Date().toISOString(),
    };
    assurancePromise = Promise.resolve(failResult);
  } else {
    // 非 AP2 场景（无 CartMandate），跳过 AP2 校验
    assurancePromise = Promise.resolve(null);
  }

  const [complianceDecision, assuranceResult] = await Promise.all([compliancePromise, assurancePromise]);

  // 校验合规结果
  if (!complianceDecision.passed) {
    console.error(
      `🚫 支付拒绝（KYC）：服务=${serviceId}，工具=${toolName}，原因=${complianceDecision.reasonCode}，对手方=${counterparty}`,
    );
    throw new PaymentRejectedError("compliance_check", complianceDecision, assuranceResult, paymentCtx);
  }

  // 校验 AP2 结果（仅当 AP2 校验实际执行时检查）
  if (assuranceResult !== null && !assuranceResult.passed) {
    console.error(
      `🚫 支付拒绝（AP2）：服务=${serviceId}，工具=${toolName}，原因=${assuranceResult.errorCode}，详情=${assuranceResult.errorMessage}`,
    );
    throw new PaymentRejectedError("assurance_check", complianceDecision, assuranceResult, paymentCtx);
  }

  console.error(
    `💰 支付放行：服务=${serviceId}，工具=${toolName}，金额=${paymentCtx.amount}，网络=${paymentCtx.network}，收款方=${counterparty}`,
  );

  // ── Step 5: 生成 PaymentPayload（签名授权） ───────────────────────
  // schemas 与 client 子模块对 PaymentRequired 的 TS 类型定义有细微差异（联合 vs 扁平）
  // 运行时已通过 isPaymentRequired 校验，此处安全断言
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentPayload = await paymentClient.createPaymentPayload(paymentRequired as any);

  // ── Step 6: 二次调用（携带支付签名） ──────────────────────────────
  const paidResult = await client.callTool({
    name: toolName,
    arguments: args,
    _meta: { [MCP_PAYMENT_META_KEY]: paymentPayload },
  }) as McpCallToolResult;

  // ── Step 7: 提取支付回执 ──────────────────────────────────────────
  const paymentResponse = paidResult._meta?.[MCP_PAYMENT_RESPONSE_META_KEY] ?? null;

  return {
    content: paidResult.content,
    isError: paidResult.isError,
    paymentMade: true,
    paymentResponse,
    complianceDecision,
    assuranceResult,
    paymentContext: paymentCtx,
  };
}

// =====================================================================
// 支付拒绝异常（结构化，便于 catch 中提取上下文）
// =====================================================================

/**
 * 支付被网关策略拒绝时抛出的结构化异常。
 *
 * 携带完整的拒绝上下文（阶段、合规决策、AP2 结果、支付上下文），
 * 供 catch 块构建结构化的 GatewayEnvelope 响应。
 */
class PaymentRejectedError extends Error {
  constructor(
    public readonly stage: "compliance_check" | "assurance_check",
    public readonly complianceDecision: ComplianceDecision,
    public readonly assuranceResult: AssuranceResult | null,
    public readonly paymentContext: PaymentContext | null,
  ) {
    const isAssurance = stage === "assurance_check" && assuranceResult && !assuranceResult.passed;
    const code = isAssurance
      ? (assuranceResult!.errorCode ?? "ASSURANCE_FAILED")
      : complianceDecision.reasonCode;
    const msg = isAssurance
      ? (assuranceResult!.errorMessage ?? "AP2 assurance check failed.")
      : complianceDecision.message;
    super(`Payment rejected: [${code}] ${msg}`);
    this.name = "PaymentRejectedError";
  }
}

// =====================================================================
// 下游连接管理
// =====================================================================

/** 根据传输模式返回候选协议顺序 */
function getTransportCandidates(
  mode: DownstreamTransportMode,
): Array<Exclude<DownstreamTransportMode, "auto">> {
  if (mode === "sse") return ["sse"];
  if (mode === "streamable-http") return ["streamable-http"];
  return ["streamable-http", "sse"]; // auto：HTTP 优先，SSE 兜底
}

/**
 * 连接单个下游原生 MCP 客户端（带协议回退 + 重试）。
 *
 * 按候选协议逐个尝试，每种协议按 connectRetries 次重试，
 * 失败后短暂退避，记录所有失败原因最终一次性抛出。
 */
async function connectWithTransportFallback(
  client: Client,
  url: string,
  mode: DownstreamTransportMode,
): Promise<Exclude<DownstreamTransportMode, "auto">> {
  const candidates = getTransportCandidates(mode);
  const errors: string[] = [];

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
      try {
        const transport =
          candidate === "sse"
            ? new SSEClientTransport(new globalThis.URL(url))
            : new StreamableHTTPClientTransport(new globalThis.URL(url), {
              requestInit: {
                headers: { Accept: "application/json, text/event-stream" },
              },
            });
        await client.connect(transport);
        return candidate;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cause = extractErrorCause(error);
        errors.push(`${candidate}#${attempt}: ${message}${cause}`);
        if (attempt < connectRetries) {
          await sleep(300 * attempt);
        }
      }
    }
  }

  throw new Error(`Failed to connect downstream MCP at ${url}. Attempts => ${errors.join(" | ")}`);
}

/** 从异常中提取可读的 cause 信息 */
function extractErrorCause(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const maybeCause = (error as { cause?: unknown }).cause;
  if (maybeCause instanceof Error) return ` (cause: ${maybeCause.message})`;
  if (typeof maybeCause === "string" && maybeCause.length > 0) return ` (cause: ${maybeCause})`;
  return "";
}

// =====================================================================
// 下游客户端创建与注册
// =====================================================================

/**
 * 为单个下游创建原生 MCP 客户端并完成连接。
 *
 * v2.0 变更：使用原生 @modelcontextprotocol/sdk Client，
 * 不再通过 @x402/mcp 的 createx402MCPClient 包装。
 * 支付逻辑完全由网关的 callToolWithPaymentHandling 自主控制。
 */
async function createAndConnectDownstreamClient(
  serviceId: string,
  url: string,
  mode: DownstreamTransportMode,
): Promise<{
  client: Client;
  transport: Exclude<DownstreamTransportMode, "auto">;
}> {
  const client = new Client({ name: `gateway-${serviceId}`, version: "2.0.0" });
  const selectedTransport = await connectWithTransportFallback(client, url, mode);
  return { client, transport: selectedTransport };
}

/**
 * 根据配置的多个下游 URL 初始化网关注册表。
 *
 * 为每个 URL 建立连接、拉取工具列表、生成 service-1/service-2... 映射。
 */
async function initializeDownstreamRegistry(
  urls: string[],
  mode: DownstreamTransportMode,
): Promise<DownstreamServiceRecord[]> {
  const records: DownstreamServiceRecord[] = [];

  for (let index = 0; index < urls.length; index += 1) {
    const serviceId = `service-${index + 1}`;
    const url = urls[index];
    const { client, transport } = await createAndConnectDownstreamClient(serviceId, url, mode);
    const toolResult = await client.listTools();
    const tools = toolResult.tools.map((tool: { name: string; description?: string }) => ({
      name: tool.name,
      description: tool.description,
    }));
    records.push({ serviceId, url, transport, client, tools });

    console.error(`📡 注册下游：${serviceId} 已连接 → ${url}`);
    console.error(`📡 传输协议：${serviceId} → ${transport}`);
    console.error(`📡 可用工具：${serviceId} → ${tools.map((t: { name: string }) => t.name).join(", ") || "（无）"}`);
  }

  return records;
}

/** 根据 serviceId 选择下游服务（默认 service-1） */
function selectService(
  registry: DownstreamServiceRecord[],
  serviceId?: string,
): DownstreamServiceRecord {
  if (!serviceId) return registry[0];
  const service = registry.find(item => item.serviceId === serviceId);
  if (!service) throw new Error(`Unknown serviceId: ${serviceId}`);
  return service;
}

// =====================================================================
// 网关工具注册
// =====================================================================

/**
 * 注册网关对外工具。
 *
 * 对上游 Agent 暴露两个能力：
 * 1) list_gateway_services：查看当前可用下游和工具清单。
 * 2) call_service_tool：调用下游工具（内部自动处理支付、合规、交易记录）。
 */
function registerGatewayTools(mcpServer: McpServer, registry: DownstreamServiceRecord[]): void {
  mcpServer.tool(
    "list_gateway_services",
    "List downstream services and their tools.",
    {},
    async () => {
      const result = registry.map(service => ({
        serviceId: service.serviceId,
        url: service.url,
        transport: service.transport,
        tools: service.tools,
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcpServer.tool(
    "call_service_tool",
    "Call a downstream MCP tool via gateway. Payment is handled by gateway wallet.",
    {
      serviceId: z.string().optional().describe("Optional service id, default is service-1"),
      toolName: z.string().describe("Downstream tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments passed to downstream tool"),
    },
    async (args: { serviceId?: string; toolName: string; args?: JsonObject }) => {
      const traceId = createTraceId();
      const service = selectService(registry, args.serviceId);

      try {
        const result = await callToolWithPaymentHandling(
          service.client, service.serviceId, args.toolName, args.args ?? {},
        );

        const payeeCompliance = extractPayeeCompliance(result.content);
        const paymentResponseData = extractPaymentResponseData(result.paymentResponse);

        // 异步写入交易记录（fire-and-forget），仅在实际发生支付时记录
        if (result.paymentMade && transactionConfig) {
          recordTransaction(transactionConfig, buildTransactionPayload(transactionConfig, {
            toolName: args.toolName,
            serviceResult: "pass",
            paymentCtx: result.paymentContext,
            paymentResponseData,
            payerCompliance: result.complianceDecision,
            payeeCompliance,
            intentMandateId: result.assuranceResult?.mandateId ?? "",
          }));
        }

        const response: GatewayEnvelope<{
          serviceId: string;
          toolName: string;
          paymentMade: boolean;
          paymentResponse: unknown;
          complianceDecision: ComplianceDecision | null;
          assuranceResult: AssuranceResult | null;
          payeeComplianceDecision: PayeeComplianceDecision | null;
          paymentContext: PaymentContext | null;
          downstreamContent: unknown;
        }> = {
          ok: true,
          stage: "tool_execution",
          code: "TOOL_CALL_SUCCEEDED",
          message: "Downstream tool call succeeded.",
          traceId,
          timestamp: new Date().toISOString(),
          detail: {
            serviceId: service.serviceId,
            toolName: args.toolName,
            paymentMade: result.paymentMade,
            paymentResponse: result.paymentResponse,
            complianceDecision: result.complianceDecision,
            assuranceResult: result.assuranceResult,
            payeeComplianceDecision: payeeCompliance,
            paymentContext: result.paymentMade ? result.paymentContext : null,
            downstreamContent: result.content,
          },
        };

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        // 支付被网关策略拒绝（结构化异常）
        if (error instanceof PaymentRejectedError) {
          // 异步写入交易记录：合规/AP2 拒绝 → "reject"
          if (transactionConfig) {
            recordTransaction(transactionConfig, buildTransactionPayload(transactionConfig, {
              toolName: args.toolName,
              serviceResult: "reject",
              paymentCtx: error.paymentContext,
              paymentResponseData: null,
              payerCompliance: error.complianceDecision,
              payeeCompliance: null,
              intentMandateId: "",
            }));
          }

          const isAssurance = error.stage === "assurance_check" && error.assuranceResult && !error.assuranceResult.passed;
          const failCode = isAssurance
            ? (error.assuranceResult!.errorCode ?? "ASSURANCE_FAILED")
            : error.complianceDecision.reasonCode;
          const failMessage = isAssurance
            ? (error.assuranceResult!.errorMessage ?? "AP2 assurance check failed.")
            : error.complianceDecision.message;

          const response: GatewayEnvelope<{
            serviceId: string;
            toolName: string;
            complianceDecision: ComplianceDecision | null;
            assuranceResult: AssuranceResult | null;
            payeeComplianceDecision: null;
            paymentContext: PaymentContext | null;
            downstreamError: string;
          }> = {
            ok: false,
            stage: error.stage,
            code: failCode,
            message: failMessage,
            traceId,
            timestamp: new Date().toISOString(),
            detail: {
              serviceId: service.serviceId,
              toolName: args.toolName,
              complianceDecision: error.complianceDecision,
              assuranceResult: error.assuranceResult,
              payeeComplianceDecision: null,
              paymentContext: error.paymentContext,
              downstreamError: error.message,
            },
          };

          return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        }

        // 其他异常（下游不可达、签名生成失败等）
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (transactionConfig) {
          recordTransaction(transactionConfig, buildTransactionPayload(transactionConfig, {
            toolName: args.toolName,
            serviceResult: "error",
            paymentCtx: null,
            paymentResponseData: null,
            payerCompliance: null,
            payeeCompliance: null,
            intentMandateId: "",
          }));
        }

        const response: GatewayEnvelope<{
          serviceId: string;
          toolName: string;
          complianceDecision: null;
          assuranceResult: null;
          payeeComplianceDecision: null;
          paymentContext: null;
          downstreamError: string;
        }> = {
          ok: false,
          stage: "tool_execution",
          code: "TOOL_CALL_FAILED",
          message: "Downstream tool call failed.",
          traceId,
          timestamp: new Date().toISOString(),
          detail: {
            serviceId: service.serviceId,
            toolName: args.toolName,
            complianceDecision: null,
            assuranceResult: null,
            payeeComplianceDecision: null,
            paymentContext: null,
            downstreamError: errorMessage,
          },
        };

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }
    },
  );
}

// =====================================================================
// 启动与关闭
// =====================================================================

function buildGatewayMcpServer(registry: DownstreamServiceRecord[]): McpServer {
  const mcpServer = new McpServer({ name: "UAFG Gateway MCP", version: "2.0.0" });
  registerGatewayTools(mcpServer, registry);
  return mcpServer;
}

async function startGatewayServer(registry: DownstreamServiceRecord[]): Promise<void> {
  const mcpServer = buildGatewayMcpServer(registry);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error("🚀 网关 MCP 服务已启动（stdio 传输层）");
  console.error(`📡 已注册下游服务：${registry.map(item => item.serviceId).join(", ")}`);
}

async function closeDownstreamClients(registry: DownstreamServiceRecord[]): Promise<void> {
  await Promise.all(registry.map(service => service.client.close()));
}

/**
 * 主入口函数。
 *
 * 启动顺序：
 * 1) 读取配置并初始化所有下游连接。
 * 2) 启动本地 stdio MCP 服务。
 * 3) 监听 SIGINT，优雅释放下游连接。
 */
export async function main(): Promise<void> {
  const registry = await initializeDownstreamRegistry(downstreamUrls, transportMode);
  await startGatewayServer(registry);

  process.on("SIGINT", async () => {
    console.error("\n🛑 正在关闭网关...");
    await closeDownstreamClients(registry);
    process.exit(0);
  });
}

main().catch(async error => {
  console.error("💀 致命错误：", error);
  process.exit(1);
});
