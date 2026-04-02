/**
 * transaction.ts — 交易记录模块
 *
 * 职责：
 * 1) 在工具调用完成后，将支付和合规信息异步写入 Dashboard。
 * 2) 提供结构化的载荷组装函数，将分散的上下文统一映射为 API 请求体。
 * 3) 采用 fire-and-forget 模式，不阻塞主链路响应。
 *
 * v2.0 变更：移除 KYT 相关字段（payerKytResult/payeeKytResult/payerKytRiskLevel/payeeKytRiskLevel）。
 *
 * @author kuangyp
 * @version 2026-04-02
 */

import type { ComplianceDecision, PayeeComplianceDecision } from "./compliance.js";

// =====================================================================
// 交易记录模块配置
// =====================================================================

/**
 * 交易记录服务配置。
 *
 * 由主模块从环境变量中读取后注入。
 */
export interface TransactionConfig {
  baseUrl: string;      // Dashboard 域名（如 https://your-domain.com）
  apiKey: string;       // API Key
}

// =====================================================================
// 类型定义
// =====================================================================

/**
 * 支付上下文信息。
 *
 * 从支付挑战（PaymentRequired）中提取，
 * 在 call_service_tool 响应中透传给上游 Agent，
 * 同时作为交易记录的数据源。
 */
export interface PaymentContext {
  amount: string;        // 支付金额（来自 paymentRequired.accepts[0].amount）
  payTo: string;         // 收款方地址（来自 paymentRequired.accepts[0].payTo）
  network: string;       // 支付网络（如 eip155:84532）
  tokenSymbol: string;   // Token 符号（来自 paymentRequired.accepts[0].extra.name，如 "USDC"）
}

/**
 * 链上支付回执结构（从二次调用结果的 _meta["x402/payment-response"] 中提取）。
 *
 * 字段含义：
 * - success: 支付链上是否确认成功。
 * - transaction: 链上交易哈希（txHash）。
 * - network: 支付所在链（如 eip155:84532）。
 * - payer: 付款方钱包地址。
 */
export interface PaymentResponseData {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}

/**
 * 交易记录写入 API 的请求体结构（对应 POST /api/transactions）。
 */
export interface TransactionRecordPayload {
  serviceName: string;
  serviceResult: "pass" | "reject" | "error";
  chain: string;
  txHash?: string;
  /** 转账金额（人类可读格式，如 "0.10"），API 要求必填，无支付时传 "0" */
  amount: string;
  /**
   * AP2 Intent Mandate ID（来自 /api/mandates/intent/vc 的 data.mandate.id）。
   * AP2 校验通过时必填；非 AP2 场景或支付被拒绝时传空字符串。
   */
  intentMandateId: string;
  tokenSymbol?: string;
  payer?: string;
  payee?: string;
  payerKycResult?: number;
  payeeKycResult?: number;
  createdAt?: string;  // 客户端生成的中国时区时间戳，精确到秒
}

// =====================================================================
// 内部映射函数
// =====================================================================

/**
 * 将 KYC 结果映射为数字：approved → 1，其余 → 0。
 */
function mapKycToNumber(kycCompleted?: boolean, kycStatus?: string | null): number | undefined {
  if (kycCompleted === undefined && kycStatus === undefined) {
    return undefined;
  }
  return kycCompleted === true && kycStatus === "approved" ? 1 : 0;
}

// =====================================================================
// 导出函数
// =====================================================================

/**
 * 安全地从 paymentResponse 中提取结构化数据。
 *
 * paymentResponse 来自二次调用结果的 _meta["x402/payment-response"]，类型为 unknown。
 * 此函数做防御性解析，确保即使结构变化也不会抛错。
 *
 * @param raw paymentResponse 原始值。
 * @returns 结构化支付回执，或 null。
 */
export function extractPaymentResponseData(raw: unknown): PaymentResponseData | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  return {
    success: obj.success === true,
    transaction: typeof obj.transaction === "string" ? obj.transaction : undefined,
    network: typeof obj.network === "string" ? obj.network : undefined,
    payer: typeof obj.payer === "string" ? obj.payer : undefined,
  };
}

/**
 * 组装交易记录请求体。
 *
 * 从工具调用的各个上下文中提取字段，映射为 Dashboard API 要求的格式。
 * 对于缺失的可选字段，不写入（undefined 在 JSON.stringify 时自动忽略）。
 *
 * @param config 交易记录服务配置。
 * @param params 组装所需的所有上下文数据。
 * @returns 可直接 POST 到 /api/transactions 的请求体。
 */
export function buildTransactionPayload(
  config: TransactionConfig,
  params: {
    toolName: string;
    serviceResult: "pass" | "reject" | "error";
    paymentCtx: PaymentContext | null;
    paymentResponseData: PaymentResponseData | null;
    payerCompliance: ComplianceDecision | null;
    payeeCompliance: PayeeComplianceDecision | null;
    /** AP2 Intent Mandate ID，校验通过时由 AssuranceResult.mandateId 提供 */
    intentMandateId: string;
  },
): TransactionRecordPayload {
  const { toolName, serviceResult, paymentCtx, paymentResponseData, payerCompliance, payeeCompliance, intentMandateId } = params;

  return {
    serviceName: toolName,
    serviceResult,
    chain: paymentCtx?.network ?? paymentResponseData?.network ?? "unknown",
    txHash: paymentResponseData?.transaction,
    // amount 为 API 必填字段：有支付则转换原始精度，无支付兜底传 "0"
    amount: formatUsdcAmount(paymentCtx?.amount) ?? "0",
    intentMandateId,
    tokenSymbol: paymentCtx?.tokenSymbol,
    payer: paymentResponseData?.payer,
    payee: paymentCtx?.payTo,
    // 收款方对付款方的 KYC 结果（payee 视角检查 payer）
    payerKycResult: mapKycToNumber(payeeCompliance?.kycCompleted, payeeCompliance?.kycStatus),
    // 付款方对收款方的 KYC 结果（payer 视角检查 payee）
    payeeKycResult: mapKycToNumber(payerCompliance?.kycCompleted, payerCompliance?.kycStatus as string | null | undefined),
    createdAt: toChinaTimeString(),
  };
}

/**
 * 生成中国时区（UTC+8）的时间字符串，精确到秒。
 *
 * 格式：yyyy-MM-dd HH:mm:ss
 * 例如："2026-03-20 10:22:31"
 */
function toChinaTimeString(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}

/**
 * 将 USDC 原始精度金额（6 位小数）转换为人类可读格式，保留两位小数。
 *
 * 例如：
 * - "100000"  → "0.10"
 * - "1000000" → "1.00"
 * - "1500000" → "1.50"
 * - undefined → undefined
 *
 * @param rawAmount 原始金额字符串（最小单位，如 USDC 的 10^6）。
 * @returns 格式化后的金额字符串，或 undefined。
 */
function formatUsdcAmount(rawAmount?: string): string | undefined {
  if (!rawAmount) return undefined;
  const USDC_DECIMALS = 6;
  const value = Number(rawAmount) / Math.pow(10, USDC_DECIMALS);
  return value.toFixed(2);
}

/** 交易记录写入最大重试次数 */
const RECORD_MAX_RETRIES = 5;
/** 单次请求超时（毫秒） */
const RECORD_TIMEOUT_MS = 5000;

/**
 * 发送单次交易记录请求。
 *
 * @param url 接口地址。
 * @param body 请求体（含 apiKey）。
 * @returns 成功返回 true，可重试的失败抛错。
 */
async function postTransactionOnce(url: string, body: Record<string, unknown>): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RECORD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 异步写入交易记录到 Dashboard（fire-and-forget + 重试）。
 *
 * 设计原则：
 * - 交易记录为旁路操作，不阻塞主链路响应。
 * - 失败最多重试 5 次，采用线性退避（500ms, 1000ms, 1500ms...）。
 * - 所有重试耗尽后仅记日志，不影响工具调用结果返回给上游 Agent。
 *
 * @param config 交易记录服务配置。
 * @param payload 交易记录请求体。
 */
export function recordTransaction(config: TransactionConfig, payload: TransactionRecordPayload): void {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/api/transactions`;
  const body = { ...payload, apiKey: config.apiKey };

  (async () => {
    for (let attempt = 1; attempt <= RECORD_MAX_RETRIES; attempt += 1) {
      try {
        await postTransactionOnce(url, body);
        console.error(
          `📝 交易记录写入成功：服务=${payload.serviceName}，结果=${payload.serviceResult}，txHash=${payload.txHash ?? "无"}`,
        );
        return; // 成功则退出
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `📝 交易记录写入重试：第 ${attempt}/${RECORD_MAX_RETRIES} 次，错误=${message}`,
        );
        if (attempt < RECORD_MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // 线性退避
        }
      }
    }
    console.error(`📝 交易记录写入最终失败：服务=${payload.serviceName}，已重试 ${RECORD_MAX_RETRIES} 次`);
  })();
}
