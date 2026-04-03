/**
 * assurance.ts — AP2 支付保障验证模块（v3.0 — verify-batch 模式）
 *
 * 职责：
 * 1) 调用 /api/mandates/intent/vc 获取买方意图授权 VC 凭证。
 * 2) 调用 /api/mandates/verify-batch 统一验证意图 VC 和购物车 VC，并做兼容性匹配。
 * 3) 全部校验通过后返回 passed=true，任意失败立即返回 passed=false。
 *
 * v3.0 核心变更：
 * - 移除所有本地密码学验证（EIP-191 商户验签、EIP-712 意图验签），改为 Dashboard verify-batch API。
 * - CartMandate 结构从含 merchant_signature 的扁平对象改为含 W3C VC（vcJson）的完整结构。
 * - 身份标识从 EVM 钱包地址改为 Agentry ID。
 * - 预算/限额校验由 verify-batch 的 compatibility 字段完成，不再本地计算。
 *
 * 安全原则：
 * - 完全信任 Dashboard API 的验证结果（签名验证由 Dashboard 服务端执行）。
 * - 采用 fail-close 策略：配置缺失或接口异常时默认拒绝。
 *
 * @author kuangyp
 * @version 2026-04-03
 */

// =====================================================================
// 配置类型
// =====================================================================

/**
 * AP2 验证服务配置。
 * 与合规服务（KYC）共用同一个 Dashboard 的 baseUrl 和 apiKey。
 */
export interface AssuranceConfig {
  /** Dashboard 域名，如 https://test-agentry-dashboard.zk.me */
  baseUrl: string;
  /** API Key，以 agt_ 开头 */
  apiKey: string;
}

// =====================================================================
// CartMandate 类型（从 x402 paymentRequired.accepts[0].extra 提取）
// =====================================================================

/**
 * 商户侧购物车授权（CartMandate）。
 *
 * v3.0 变更：
 * - 移除 merchant_signature（不再使用 EIP-191 签名）。
 * - 新增 vcJson（W3C Verifiable Credential，由 Dashboard /api/mandates/cart/create 签发）。
 * - merchant_address 和 pay_to 改为可选（仅 crypto 支付方式需要）。
 *
 * 由下游 MCP Hub 调用 /api/mandates/cart/create 后，
 * 将完整响应放入 x402 Challenge 的 extra.cartMandate 字段。
 */
export interface CartMandate {
  /** 购物车授权 ID */
  mandateId: string;
  /** 商户 Agentry ID（如 AGT-M001），用于 KYC 查询 */
  merchant_id: string;
  /** 商户 EVM 地址（仅 crypto 支付方式有值） */
  merchant_address?: string;
  /** 购物车总金额（人类可读格式，如 "45.00"） */
  total_amount: string;
  /** 币种符号，如 "USDC" */
  currency: string;
  /** 收款地址（仅 crypto 支付方式有值） */
  pay_to?: string;
  /** 已签名的 W3C VC（AP2CartMandate 类型，含 ecdsa-jcs-2019 proof） */
  vcJson: Record<string, unknown>;
  /** 授权过期时间（ISO 8601） */
  expiresAt: string;
}

// =====================================================================
// 内部 API 响应类型（不对外导出）
// =====================================================================

/** /api/mandates/intent/vc 成功时的 mandate 信息 */
interface IntentMandateInfo {
  id: string;
  perTxLimit: string;
  totalBudget: string;
  usedAmount: string;
  transactionCount: number;
  expiresAt: string;
  status: string;
}

/** /api/mandates/intent/vc 成功响应 data（found=true） */
interface IntentVcDataFound {
  found: true;
  mandate: IntentMandateInfo;
  remainingBudget: string;
  usagePercent: number;
  paymentMethod: string;
  vcJson: Record<string, unknown>;
}

/** /api/mandates/intent/vc 未找到响应 data（found=false） */
interface IntentVcDataNotFound {
  found: false;
  mandate: null;
  remainingBudget: null;
  usagePercent: null;
  vcJson: null;
}

/** /api/mandates/intent/vc 完整响应 */
interface IntentVcApiResponse {
  code: number;
  msg: string;
  data: IntentVcDataFound | IntentVcDataNotFound | null;
}

/** verify-batch 单个 VC 的验证结果 */
interface VerifyBatchResultItem {
  index: number;
  valid: boolean;
  mandateType: string;
  proofType: string;
  cryptosuite: string;
  issuer: string;
  isExpired: boolean;
  signer: string | null;
  reason?: string;
}

/** verify-batch 兼容性检查结果 */
interface VerifyBatchCompatibility {
  compatible: boolean;
  currencyMatch: boolean;
  withinPerTxLimit: boolean;
  withinTotalBudget: boolean;
  paymentMethodMatch: boolean;
  cartAmount: string;
  perTxLimit: string;
  totalBudget: string;
  remainingBudget: string | null;
  currency: string;
  reason?: string;
}

/** verify-batch 响应 data */
interface VerifyBatchData {
  allValid: boolean;
  results: VerifyBatchResultItem[];
  compatibility?: VerifyBatchCompatibility;
}

/** verify-batch 完整响应 */
interface VerifyBatchApiResponse {
  code: number;
  msg: string;
  data: VerifyBatchData;
}

// =====================================================================
// 导出：AP2 错误码与校验结果
// =====================================================================

/** AP2 风控错误码枚举 */
export type AssuranceErrorCode =
  | "MANDATE_NOT_FOUND"       // 无有效意图授权
  | "MANDATE_EXPIRED"         // 意图授权已过期
  | "VC_VERIFICATION_FAILED"  // VC 签名验证失败（verify-batch 返回 valid=false）
  | "PER_TX_LIMIT_EXCEEDED"   // 单笔金额超出限额
  | "TOTAL_BUDGET_EXCEEDED"   // 金额超出剩余总预算
  | "COMPATIBILITY_FAILED"    // 兼容性检查不通过（币种/支付方式不匹配等）
  | "ASSURANCE_API_ERROR"     // Dashboard 接口调用失败
  | "CART_MANDATE_MISSING";   // CartMandate 必要字段缺失

/**
 * AP2 校验结果。
 *
 * passed=true 时可直接放行支付。
 * passed=false 时 errorCode + errorMessage 提供拒绝细节。
 */
export interface AssuranceResult {
  passed: boolean;
  errorCode?: AssuranceErrorCode;
  errorMessage?: string;
  /** 买方 Intent Mandate ID（仅 passed=true 时存在），用于写入交易记录 */
  mandateId?: string;
  /** 剩余预算（仅 passed=true 且兼容性检查有值时存在） */
  remainingBudget?: string;
  /** 检查执行时间（ISO 8601） */
  checkedAt: string;
}

// =====================================================================
// 内部工具函数
// =====================================================================

/**
 * 发起单次 JSON POST 请求，含 8 秒超时控制。
 * AP2 接口通过此函数调用，不做重试，由外层的 fail-close 策略兜底。
 */
async function postJsonOnce<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const loggableBody = { ...body };
  if (typeof loggableBody.apiKey === "string") {
    loggableBody.apiKey = loggableBody.apiKey.slice(0, 8) + "...";
  }
  console.error(`🔍 AP2 请求: POST ${url} body=${JSON.stringify(loggableBody)}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(
        `AP2 API request failed: ${response.status} ${response.statusText}. Body: ${rawText}`,
      );
    }

    return JSON.parse(rawText) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// =====================================================================
// Dashboard API 调用
// =====================================================================

/**
 * 调用 /api/mandates/intent/vc 获取买方意图授权 VC。
 *
 * @param config AP2 服务配置
 * @param agentryId 买方 Agentry ID
 * @returns 成功时返回 IntentVcDataFound（含 vcJson），未找到时返回 IntentVcDataNotFound
 */
async function fetchIntentVc(
  config: AssuranceConfig,
  agentryId: string,
): Promise<IntentVcDataFound | IntentVcDataNotFound> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const response = await postJsonOnce<IntentVcApiResponse>(
    `${baseUrl}/api/mandates/intent/vc`,
    { apiKey: config.apiKey, agentryId },
  );

  console.error(
    `🔍 AP2 意图 VC 查询: code=${response.code}, msg=${response.msg}, found=${String(response.data?.found)}`,
  );

  if (response.code !== 80000000 || !response.data) {
    return { found: false, mandate: null, remainingBudget: null, usagePercent: null, vcJson: null };
  }

  return response.data;
}

/**
 * 调用 /api/mandates/verify-batch 批量验证 VC 并做兼容性检查。
 *
 * 传入 intentVcJson 和 cartVcJson，启用 checkCompatibility
 * 一次完成签名验证 + 兼容性匹配（币种、限额、预算、支付方式）。
 *
 * @param config AP2 服务配置
 * @param intentVcJson 买方意图授权 VC
 * @param cartVcJson 商户购物车授权 VC
 * @returns verify-batch 响应数据
 */
async function verifyBatch(
  config: AssuranceConfig,
  intentVcJson: Record<string, unknown>,
  cartVcJson: Record<string, unknown>,
): Promise<VerifyBatchData> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const response = await postJsonOnce<VerifyBatchApiResponse>(
    `${baseUrl}/api/mandates/verify-batch`,
    {
      apiKey: config.apiKey,
      checkCompatibility: true,
      vcs: [intentVcJson, cartVcJson],
    },
  );

  if (response.code !== 80000000 || !response.data) {
    throw new Error(
      `Verify-batch API returned error: code=${response.code}, msg=${response.msg}`,
    );
  }

  return response.data;
}

// =====================================================================
// 主入口
// =====================================================================

/**
 * 执行 AP2 支付保障校验（意图 VC 获取 + verify-batch 统一验证）。
 *
 * 校验流程：
 * 1) 调用 /api/mandates/intent/vc 获取买方意图 VC
 * 2) 检查意图 VC 是否存在（found=true）
 * 3) 调用 /api/mandates/verify-batch 验证两个 VC 的签名 + 兼容性
 * 4) 根据 allValid + compatibility.compatible 判断最终结果
 *
 * @param config AP2 服务配置（与合规服务共用 baseUrl/apiKey）
 * @param payerAgentryId 买方 Agentry ID（从环境变量 AGENTRY_ID 获取）
 * @param cartMandate 从 x402 paymentRequired.accepts[0].extra.cartMandate 提取的购物车授权
 * @returns AP2 校验结果
 */
export async function runAssuranceCheck(
  config: AssuranceConfig,
  payerAgentryId: string,
  cartMandate: CartMandate,
): Promise<AssuranceResult> {
  const checkedAt = new Date().toISOString();

  try {
    // 获取买方意图 VC
    const intentVcData = await fetchIntentVc(config, payerAgentryId);

    if (!intentVcData.found) {
      return {
        passed: false,
        errorCode: "MANDATE_NOT_FOUND",
        errorMessage: "No active intent mandate found for the payer.",
        checkedAt,
      };
    }

    const { mandate, vcJson: intentVcJson } = intentVcData;

    // 本地时钟双重校验意图授权有效期（防止缓存过期数据通过）
    if (new Date() > new Date(mandate.expiresAt)) {
      return {
        passed: false,
        errorCode: "MANDATE_EXPIRED",
        errorMessage: `Intent mandate has expired at ${mandate.expiresAt}`,
        checkedAt,
      };
    }

    // 调用 verify-batch 统一验证意图 VC + 购物车 VC
    const batchResult = await verifyBatch(config, intentVcJson, cartMandate.vcJson);

    // 检查签名验证结果
    if (!batchResult.allValid) {
      const failedItem = batchResult.results.find(r => !r.valid);
      const failedType = failedItem?.mandateType ?? "Unknown";
      const failReason = failedItem?.reason ?? "Signature verification failed";

      if (failedItem?.isExpired) {
        return {
          passed: false,
          errorCode: "MANDATE_EXPIRED",
          errorMessage: `${failedType} VC has expired: ${failReason}`,
          checkedAt,
        };
      }

      return {
        passed: false,
        errorCode: "VC_VERIFICATION_FAILED",
        errorMessage: `${failedType} VC verification failed: ${failReason}`,
        checkedAt,
      };
    }

    // 检查兼容性（仅当 allValid=true 且同时包含 Intent + Cart VC 时返回）
    if (batchResult.compatibility) {
      const compat = batchResult.compatibility;

      if (!compat.compatible) {
        let errorCode: AssuranceErrorCode = "COMPATIBILITY_FAILED";
        if (!compat.withinPerTxLimit) {
          errorCode = "PER_TX_LIMIT_EXCEEDED";
        } else if (!compat.withinTotalBudget) {
          errorCode = "TOTAL_BUDGET_EXCEEDED";
        }

        return {
          passed: false,
          errorCode,
          errorMessage: compat.reason
            ?? `Compatibility check failed: cart amount ${compat.cartAmount} ${compat.currency}`,
          checkedAt,
        };
      }

      console.error(
        `✅ AP2 验证通过：商户=${cartMandate.merchant_id}，金额=${compat.cartAmount} ${compat.currency}，` +
        `剩余预算=${compat.remainingBudget ?? "N/A"}，mandateId=${mandate.id}`,
      );

      return {
        passed: true,
        mandateId: mandate.id,
        remainingBudget: compat.remainingBudget ?? undefined,
        checkedAt,
      };
    }

    // 签名都通过但无兼容性数据（理论上不应发生，因为 checkCompatibility=true）
    console.error(
      `✅ AP2 验证通过（无兼容性数据）：商户=${cartMandate.merchant_id}，mandateId=${mandate.id}`,
    );

    return { passed: true, mandateId: mandate.id, checkedAt };
  } catch (error) {
    // fail-close：接口调用异常时默认拒绝
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ AP2 验证调用异常: ${message}`);
    return {
      passed: false,
      errorCode: "ASSURANCE_API_ERROR",
      errorMessage: `Assurance check failed due to API error: ${message}`,
      checkedAt,
    };
  }
}
