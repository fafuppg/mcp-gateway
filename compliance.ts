/**
 * compliance.ts — KYC/KYT 合规检查模块
 *
 * 职责：
 * 1) 对交易对手方执行 KYC（了解客户）和 KYT（了解交易）双重检查。
 * 2) 返回结构化的合规决策（ComplianceDecision），供网关主流程判断是否放行支付。
 * 3) 从收款方响应中提取其对付款方的合规检查结果（PayeeComplianceDecision）。
 */

// =====================================================================
// 合规模块配置
// =====================================================================

/**
 * 合规服务配置。
 *
 * 由主模块从环境变量中读取后注入，避免本模块直接耦合 process.env。
 */
export interface ComplianceConfig {
  baseUrl: string;     // KYC/KYT 接口域名（如 https://your-domain.com）
  apiKey: string;      // API Key（以 agt_ 开头）
  chain: string;       // KYT 查询链，如 "base"
  maxRetries: number;  // 接口最大重试次数（含首次）
}

// =====================================================================
// KYC/KYT 接口返回结构（内部类型，不导出）
// =====================================================================

/**
 * KYC 接口返回结构（data 字段内容）。
 *
 * 仅当 kycCompleted = true 且 kycStatus = approved 才视为 KYC 通过。
 */
interface KycCheckData {
  walletAddress: string;
  kycCompleted: boolean;
  kycStatus: "approved" | "pending" | "rejected" | null;
}

/**
 * KYC 接口完整响应（含 code、msg、data 信封）。
 *
 * 成功时 code=80000000，业务数据在 data 中。
 */
interface KycApiResponse {
  code: number;
  msg: string;
  data: KycCheckData;
}

/**
 * KYT 接口返回结构（data 字段内容）。
 *
 * 业务放行关键字段：
 * - decision: pass / reject
 * - degraded: 如果为 true，表示上游服务降级，当前结果不可靠。
 */
interface KytCheckData {
  address: string;
  chain: string;
  riskLevel: string;
  riskScore: number;
  decision: "pass" | "reject";
  signals: string[];
  provider: string;
  checkedAt: string;
  cached: boolean;
  reportUrl?: string;
  degraded?: boolean;
}

/**
 * KYT 接口完整响应（含 code、msg、data 信封）。
 *
 * 成功时 code=80000000，业务数据在 data 中。
 */
interface KytApiResponse {
  code: number;
  msg: string;
  data: KytCheckData;
}

// =====================================================================
// 导出的合规决策类型
// =====================================================================

/**
 * 合规检查决策对象。
 *
 * 设计目标：
 * - 不仅告诉"是否通过"，还告诉"为什么通过/不通过"；
 * - 让上游 Agent 可以把决策细节完整反馈给最终用户。
 */
export interface ComplianceDecision {
  serviceId: string;
  toolName: string;
  counterparty: `0x${string}`;
  passed: boolean;
  reasonCode:
    | "COMPLIANCE_PASSED"
    | "KYC_NOT_APPROVED"
    | "KYT_REJECTED"
    | "KYT_DEGRADED"
    | "COMPLIANCE_CONFIG_MISSING"
    | "COMPLIANCE_API_ERROR";
  message: string;
  kycStatus?: KycCheckData["kycStatus"];
  kycCompleted?: boolean;
  kytDecision?: KytCheckData["decision"];
  riskLevel?: string;
  riskScore?: number;
  degraded?: boolean;
  checkedAt: string;
}

/**
 * 收款方对付款方的合规检查结果（从收款方响应中提取）。
 *
 * 收款方在工具响应中将 payeeComplianceDecision 嵌入 JSON，
 * 网关从 downstreamContent 中解析出来，透传给上游 Agent，
 * 用于展示双向合规信息。
 */
export interface PayeeComplianceDecision {
  payerAddress: string;
  kycCompleted: boolean;
  kycStatus: string | null;
  kytDecision: string;
  riskLevel: string;
  riskScore: number;
  degraded: boolean;
  checkedAt: string;
  passed: boolean;
  reasonCode: string;
  message: string;
}

// =====================================================================
// 内部工具函数
// =====================================================================

/**
 * 简单延时，用于请求重试时做退避等待。
 *
 * 同时导出供网关主模块的连接重试逻辑复用。
 *
 * @param ms 等待毫秒数。
 */
export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 统一发起 JSON POST 请求，并做超时控制 + 重试。
 *
 * @param url 请求地址。
 * @param body JSON 请求体。
 * @param maxRetries 最大重试次数。
 * @returns 解析后的 JSON 对象。
 */
async function postJson<T>(url: string, body: Record<string, unknown>, maxRetries: number): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 单次 8 秒超时

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Compliance API request failed: ${response.status} ${response.statusText}. ${text}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `🔄 合规请求重试：第 ${attempt}/${maxRetries} 次，地址=${url}，错误=${lastError.message}`,
      );
      if (attempt < maxRetries) {
        await sleep(300 * attempt); // 线性退避：300ms, 600ms, 900ms...
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Compliance API request failed after retries.");
}

// =====================================================================
// 核心导出函数
// =====================================================================

/**
 * 执行 KYC + KYT 双重校验。
 *
 * 返回结构化决策，便于上游清晰解释"通过/失败原因"。
 * 采用 fail-close 策略：配置缺失或接口异常时默认拒绝。
 *
 * @param config 合规服务配置。
 * @param serviceId 下游服务 ID。
 * @param toolName 当前工具名。
 * @param counterparty 对手方钱包地址。
 * @returns 合规决策对象（包含结果与原因码）。
 */
export async function runComplianceChecks(
  config: ComplianceConfig,
  serviceId: string,
  toolName: string,
  counterparty: `0x${string}`,
): Promise<ComplianceDecision> {
  const checkedAt = new Date().toISOString();

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const successCode = 80000000;

  try {
    const [kycRaw, kytRaw] = await Promise.all([
      postJson<KycApiResponse>(`${baseUrl}/api/kyc/check`, {
        apiKey: config.apiKey,
        walletAddress: counterparty,
      }, config.maxRetries),
      postJson<KytApiResponse>(`${baseUrl}/api/compliance/kyt/check`, {
        apiKey: config.apiKey,
        walletAddress: counterparty,
        chain: config.chain,
      }, config.maxRetries),
    ]);

    // 校验接口返回信封：code 非成功码或 data 缺失时视为 API 错误
    if (kycRaw.code !== successCode || !kycRaw.data) {
      return {
        serviceId, toolName, counterparty, passed: false,
        reasonCode: "COMPLIANCE_API_ERROR",
        message: `KYC API returned unexpected response: code=${kycRaw.code}, msg=${kycRaw.msg}`,
        checkedAt,
      };
    }
    if (kytRaw.code !== successCode || !kytRaw.data) {
      return {
        serviceId, toolName, counterparty, passed: false,
        reasonCode: "COMPLIANCE_API_ERROR",
        message: `KYT API returned unexpected response: code=${kytRaw.code}, msg=${kytRaw.msg}`,
        checkedAt,
      };
    }

    const kycResult = kycRaw.data;
    const kytResult = kytRaw.data;

    console.error(
      `🛡️ 合规结果：对手方=${counterparty}，KYC状态=${String(kycResult.kycStatus)}（已完成=${String(kycResult.kycCompleted)}），KYT决策=${kytResult.decision}，风险等级=${kytResult.riskLevel}，风险评分=${kytResult.riskScore}，降级=${String(kytResult.degraded === true)}`,
    );

    const decisionBase = {
      serviceId,
      toolName,
      counterparty,
      kycStatus: kycResult.kycStatus,
      kycCompleted: kycResult.kycCompleted,
      kytDecision: kytResult.decision,
      riskLevel: kytResult.riskLevel,
      riskScore: kytResult.riskScore,
      degraded: kytResult.degraded === true,
      checkedAt,
    };

    // KYC 必须 completed 且 approved 才可放行
    if (!(kycResult.kycCompleted === true && kycResult.kycStatus === "approved")) {
      return {
        ...decisionBase,
        passed: false,
        reasonCode: "KYC_NOT_APPROVED",
        message: `KYC is not approved. Current status: ${String(kycResult.kycStatus)}`,
      };
    }

    // KYT decision 必须为 pass
    if (kytResult.decision !== "pass") {
      return {
        ...decisionBase,
        passed: false,
        reasonCode: "KYT_REJECTED",
        message: `KYT decision is ${kytResult.decision}.`,
      };
    }

    // KYC + KYT 全部通过，允许支付
    return {
      ...decisionBase,
      passed: true,
      reasonCode: "COMPLIANCE_PASSED",
      message: "Compliance checks passed.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      serviceId, toolName, counterparty, passed: false,
      reasonCode: "COMPLIANCE_API_ERROR",
      message: `Compliance API error: ${message}`,
      checkedAt,
    };
  }
}

/**
 * 从收款方返回的 content 中提取 payeeComplianceDecision。
 *
 * 收款方工具响应格式为 { data: <业务数据>, payeeComplianceDecision: <合规结果> }。
 * 本函数解析第一个 text 类型 content item 的 JSON，提取 payeeComplianceDecision 字段。
 * 向后兼容：若字段不存在或解析失败，返回 null。
 *
 * @param content 收款方返回的 MCP content 数组。
 * @returns 收款方的合规决策，或 null。
 */
export function extractPayeeCompliance(content: unknown): PayeeComplianceDecision | null {
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const firstItem = content[0];
  if (typeof firstItem !== "object" || firstItem === null) {
    return null;
  }
  const textItem = firstItem as { type?: string; text?: string };
  if (textItem.type !== "text" || typeof textItem.text !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(textItem.text) as Record<string, unknown>;
    if (parsed.payeeComplianceDecision && typeof parsed.payeeComplianceDecision === "object") {
      return parsed.payeeComplianceDecision as PayeeComplianceDecision;
    }
  } catch {
    // JSON 解析失败，向后兼容返回 null
  }
  return null;
}
