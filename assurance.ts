/**
 * assurance.ts — AP2 支付保障验证模块（Universal Assurance Service）
 *
 * 职责：
 * 1) 调用控制台 API 11.4 获取商户公钥，本地执行 EIP-191 商户签名验证。
 * 2) 调用控制台 API 11.5 获取买方 VC 凭证，本地执行 EIP-712 意图授权验签。
 * 3) 本地计算单笔限额与总预算水位，确保交易金额合规。
 * 4) 三重校验全部通过后返回 passed=true，任意失败立即短路返回 passed=false。
 *
 * 安全原则（来自 AP2 PRD）：
 * - 完全信任通过 API Key 从控制台获取的公钥与 VC 数据。
 * - 绝不信任 MCP 传来的任何未签名金额字段。
 * - 采用 fail-close 策略：配置缺失或接口异常时默认拒绝。
 *
 * @author kuangyp
 * @version 2026-03-26
 */

import { publicKeyToAddress } from "viem/accounts";
import { verifyMessage, verifyTypedData } from "viem";

// =====================================================================
// 配置类型
// =====================================================================

/**
 * AP2 验证服务配置。
 *
 * 与合规服务（KYC/KYT）共用同一个 Dashboard 的 baseUrl 和 apiKey。
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
 * 商户侧发票（CartMandate）。
 *
 * 由下游服务商在下发 HTTP 402 时，将其放入 x402 Challenge 的 extra 字段：
 * paymentRequired.accepts[0].extra = { merchant_id, merchant_address, merchant_signature, ... }
 *
 * 商户使用 EIP-191 对除 merchant_signature 之外的所有字段进行签名。
 */
export interface CartMandate {
  /** 商户业务 ID */
  merchant_id: string;
  /** 商户钱包地址（0x...） */
  merchant_address: string;
  /**
   * 本次交易金额（人类可读格式，如 "0.50"）。
   * 与 VC 中的 perTxLimit / remainingBudget 单位一致（USDC 面额，非最小单位）。
   */
  total_amount: string;
  /** 货币符号，如 "USDC" */
  currency?: string;
  /** 收款方地址（通常与 merchant_address 相同） */
  pay_to?: string;
  /** 商户 EIP-191 签名（0x...十六进制） */
  merchant_signature: string;
}

// =====================================================================
// 内部 API 响应类型（不对外导出）
// =====================================================================

/** API 11.4 数据体：账户公钥 */
interface PublicKeyData {
  walletAddress: string;
  /** 非压缩公钥，格式 0x04... (65 字节，130 字符) */
  publicKey: string;
}

/** API 11.4 完整响应 */
interface PublicKeyApiResponse {
  code: number;
  msg: string;
  data: PublicKeyData;
}

/** API 11.5 mandate 规则信息 */
interface MandateRule {
  id: string;
  /** 单笔限额（人类可读，如 "11"） */
  perTxLimit: string;
  /** 总预算（人类可读） */
  totalBudget: string;
  usedAmount: string;
  transactionCount: number;
  expiresAt: string;
  status: string;
}

/** EIP-712 类型字段定义（与 viem TypedDataParameter 兼容） */
interface Eip712TypeField {
  name: string;
  type: string;
}

/**
 * VC proof 结构。
 *
 * type = "EthereumEip712Signature2021"，包含完整的 EIP-712 参数和签名值。
 */
interface VcProof {
  type: string;
  eip712: {
    types: {
      /** EIP-712 结构化数据类型定义 */
      IntentMandate: Eip712TypeField[];
    };
    domain: {
      name: string;
      chainId: number;
      version: string;
    };
    primaryType: string;
  };
  created: string;
  /** EIP-712 签名值（0x...） */
  proofValue: string;
  proofPurpose: string;
  /**
   * 签名方 DID，格式："did:ethr:eip155:{chainId}:{address}#controller"
   * 用于提取签名方以太坊地址。
   */
  verificationMethod: string;
}

/** VC credentialSubject：买家意图授权的核心约束 */
interface VcCredentialSubject {
  id: string;
  type: string;
  payer: {
    /** 买家钱包地址 */
    address: string;
    agentryId?: string;
  };
  accountId: string;
  /** mandate ID，与 mandate.id 对应 */
  mandateId: string;
  userPrompt?: string;
  budgetConstraints: {
    totalBudget: { amount: string; currency: string };
    perTransactionLimit: { amount: string; currency: string };
  };
  chargeablePaymentMethods?: unknown[];
}

/** W3C Verifiable Credential 完整 JSON 结构 */
interface VcJson {
  id: string;
  type: string[];
  proof: VcProof;
  issuer: string;
  "@context": string[];
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: VcCredentialSubject;
}

/**
 * API 11.5 成功数据体。
 *
 * 实际接口返回的是 found: true（非 PRD 示例中的 allowed: true），
 * 以真实响应为准。
 */
interface VcData {
  found: true;
  mandate: MandateRule;
  /** 当前剩余预算（人类可读，如 "3.50"） */
  remainingBudget: string;
  usagePercent: number;
  vcJson: VcJson;
}

/**
 * AP2 内部统一拒绝结构（非接口原始返回）。
 *
 * 当 API 11.5 返回非成功码（code !== 80000000）时，
 * fetchPayerVcData 将其标准化为此结构，供 runAssuranceCheck 统一处理。
 */
interface VcDataRejected {
  found: false;
  /** 标准化的拒绝原因码 */
  reason: string;
}

/** API 11.5 完整响应（成功或拒绝） */
interface VcApiResponse {
  code: number;
  msg: string;
  data: (VcData | VcDataRejected) | null;
}

// =====================================================================
// 导出：AP2 错误码与校验结果
// =====================================================================

/** AP2 风控错误码枚举（与 PRD 定义对齐） */
export type AssuranceErrorCode =
  | "MERCHANT_SIGNATURE_INVALID" // 商户 EIP-191 签名无效
  | "VC_PROOF_INVALID" // 买家 VC EIP-712 签名无效
  | "MANDATE_NOT_FOUND" // 无有效意图授权
  | "MANDATE_EXPIRED" // 意图授权已过期
  | "PER_TX_LIMIT_EXCEEDED" // 单笔金额超出限额
  | "TOTAL_BUDGET_EXCEEDED" // 金额超出剩余总预算
  | "ASSURANCE_API_ERROR" // 控制台接口调用失败
  | "CART_MANDATE_MISSING"; // CartMandate 必要字段缺失

/**
 * AP2 三重风控校验结果。
 *
 * 设计与 ComplianceDecision 对齐：
 * - passed=true 时可直接放行支付。
 * - passed=false 时 errorCode + errorMessage 提供拒绝细节。
 */
export interface AssuranceResult {
  passed: boolean;
  errorCode?: AssuranceErrorCode;
  errorMessage?: string;
  /**
   * 买方 Intent Mandate ID（仅 passed=true 时存在）。
   * 来自 API 11.5 响应的 data.mandate.id，用于写入交易记录。
   */
  mandateId?: string;
  /** 检查执行时间（ISO 8601） */
  checkedAt: string;
}

// =====================================================================
// 内部工具函数
// =====================================================================

/**
 * 发起单次 JSON POST 请求，含 8 秒超时控制。
 *
 * AP2 两个接口（11.4 / 11.5）通过 Promise.all 并行调用，
 * 此处不做重试，由外层的 fail-close 策略兜底。
 * 调试模式下打印完整请求/响应，便于排查接口格式问题。
 */
async function postJsonOnce<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  // 打印请求信息（apiKey 脱敏，只保留前 8 位）
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

/**
 * 从 VC proof.verificationMethod 中提取以太坊签名方地址。
 *
 * DID 格式：did:ethr:eip155:{chainId}:{address}#controller
 * 提取规则：取最后一个冒号之后、"#" 之前的部分。
 *
 * 示例："did:ethr:eip155:84532:0xAbcd...#controller" → "0xAbcd..."
 */
function extractSignerFromVerificationMethod(verificationMethod: string): string | null {
  const colonParts = verificationMethod.split(":");
  if (colonParts.length < 5) return null;
  // "0xAddress#controller" → "0xAddress"
  const lastSegment = colonParts[colonParts.length - 1];
  const address = lastSegment.split("#")[0];
  // 校验是否为合法 EVM 地址格式
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return address;
}

/**
 * 构建商户签名的原始消息字符串。
 *
 * 商户通过 EIP-191 personal_sign 对以下 JSON 字符串签名：
 * - 字段顺序固定（确保序列化结果一致）
 * - 不含 merchant_signature 字段本身
 *
 * ⚠️ 此消息格式必须与商户端签名实现严格一致，否则验证将始终失败。
 */
function buildMandateSigningMessage(mandate: CartMandate): string {
  return JSON.stringify({
    merchant_id: mandate.merchant_id,
    merchant_address: mandate.merchant_address,
    total_amount: mandate.total_amount,
    currency: mandate.currency ?? "",
    pay_to: mandate.pay_to ?? mandate.merchant_address,
  });
}

// =====================================================================
// 控制台接口调用（API 11.4 / 11.5）
// =====================================================================

/**
 * 调用 API 11.4 获取商户账户公钥。
 *
 * @param config AP2 服务配置
 * @param merchantAddress 商户钱包地址
 * @returns 非压缩格式公钥字符串（0x04...）
 * @throws 接口返回非成功码或 data 缺失时抛错
 */
async function fetchMerchantPublicKey(config: AssuranceConfig, merchantAddress: string): Promise<string> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const response = await postJsonOnce<PublicKeyApiResponse>(
    `${baseUrl}/api/accounts/public-key`,
    { apiKey: config.apiKey, walletAddress: merchantAddress },
  );

  if (response.code !== 80000000 || !response.data?.publicKey) {
    throw new Error(
      `Merchant public key API (11.4) returned error: code=${response.code}, msg=${response.msg}`,
    );
  }

  return response.data.publicKey;
}

/**
 * 调用 API 11.5 验证买方意图授权并获取 VC 凭证。
 *
 * 注意：此接口不接受金额参数，金额校验由本模块本地执行。
 *
 * @param config AP2 服务配置
 * @param payerWalletAddress 买方（付款方）钱包地址
 * @returns 成功时返回 VcData（allowed=true），授权不存在/已过期时返回 VcDataRejected
 * @throws 接口网络错误时抛错
 */
async function fetchPayerVcData(
  config: AssuranceConfig,
  payerWalletAddress: string,
): Promise<VcData | VcDataRejected> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const response = await postJsonOnce<VcApiResponse>(
    `${baseUrl}/api/mandates/intent/vc`,
    { apiKey: config.apiKey, payerWalletAddress },
  );

  const dataObj = response.data as unknown as Record<string, unknown> | null;
  console.error(
    `🔍 AP2 11.5 解析结果: code=${response.code}, msg=${response.msg}, data.found=${String(dataObj?.found)}, data.allowed=${String(dataObj?.allowed)}`,
  );

  // 接口返回非成功码时，从 msg 中解析标准化拒绝原因
  if (response.code !== 80000000 || !response.data) {
    const reason = response.msg?.includes("MANDATE_EXPIRED")
      ? "MANDATE_EXPIRED"
      : "MANDATE_NOT_FOUND";
    console.error(`🔍 AP2 11.5 非成功码分支: code=${response.code}, msg=${response.msg}, 解析 reason=${reason}`);
    return { found: false, reason };
  }

  // 成功码且 data 存在，直接返回（found=true 的完整 VC 数据）
  return response.data as VcData | VcDataRejected;
}

// =====================================================================
// 本地密码学验签函数
// =====================================================================

/**
 * 使用商户公钥验证 CartMandate 上的 EIP-191 签名。
 *
 * 验证流程：
 * 1) 将控制台返回的非压缩公钥（0x04...）转换为以太坊地址
 * 2) 重建商户签名时使用的消息字符串（字段顺序固定）
 * 3) 使用 viem verifyMessage 校验签名是否由该地址发出
 *
 * @param mandate CartMandate（含 merchant_signature）
 * @param publicKey 从 API 11.4 获取的商户非压缩公钥
 * @returns 签名验证是否通过
 */
async function verifyMerchantEip191Signature(
  mandate: CartMandate,
  publicKey: string,
): Promise<boolean> {
  try {
    // 将非压缩公钥转换为以太坊地址，用于 verifyMessage
    const merchantAddress = publicKeyToAddress(publicKey as `0x${string}`);
    const message = buildMandateSigningMessage(mandate);

    return await verifyMessage({
      address: merchantAddress,
      message,
      signature: mandate.merchant_signature as `0x${string}`,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`🔐 AP2 商户签名验证异常: ${msg}`);
    return false;
  }
}

/**
 * 验证买方 VC 凭证中的 EIP-712 意图授权签名。
 *
 * 验证流程：
 * 1) 从 proof.verificationMethod 提取签名方以太坊地址
 * 2) 校验签名方与 payerWalletAddress 一致（防止跨账户凭证盗用）
 * 3) 从 credentialSubject 重建 EIP-712 结构化消息（字段与签名时一致）
 * 4) 使用 viem verifyTypedData 校验 proof.proofValue
 *
 * EIP-712 结构（来自 proof.eip712，动态读取）：
 * - Domain: { name: "Agentry Intent Mandate", version: "1", chainId: 84532 }
 * - PrimaryType: "IntentMandate"
 * - Message: { id, accountId, payerAddress, perTxLimit, totalBudget, expiresAt }
 *
 * @param vcJson 完整 W3C VC JSON（来自 API 11.5 响应）
 * @param payerWalletAddress 发起支付的钱包地址，用于防止凭证跨账户使用
 * @returns VC 签名验证是否通过
 */
async function verifyVcEip712Proof(vcJson: VcJson, payerWalletAddress: string): Promise<boolean> {
  try {
    const proof = vcJson.proof;
    const eip712 = proof.eip712;
    const subject = vcJson.credentialSubject;

    // 从 verificationMethod DID 提取签名方地址
    const signerAddress = extractSignerFromVerificationMethod(proof.verificationMethod);
    if (!signerAddress) {
      console.error(
        `🔐 AP2 VC 验签：无法从 verificationMethod 提取签名方地址，原始值=${proof.verificationMethod}`,
      );
      return false;
    }

    // 确保凭证归属于当前付款方（防止凭证被其他地址盗用）
    if (signerAddress.toLowerCase() !== payerWalletAddress.toLowerCase()) {
      console.error(
        `🔐 AP2 VC 验签：签名方地址不匹配，凭证归属=${signerAddress}，请求方=${payerWalletAddress}`,
      );
      return false;
    }

    // 按 EIP-712 types 定义重建结构化消息（字段顺序与类型必须与签名时严格一致）
    const message = {
      id: subject.mandateId,
      accountId: subject.accountId,
      payerAddress: subject.payer.address as `0x${string}`,
      perTxLimit: subject.budgetConstraints.perTransactionLimit.amount,
      totalBudget: subject.budgetConstraints.totalBudget.amount,
      expiresAt: vcJson.expirationDate,
    };

    // 使用动态读取的 eip712 参数进行验签（类型断言绕过 viem 的严格泛型推断）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (verifyTypedData as (params: any) => Promise<boolean>)({
      address: signerAddress as `0x${string}`,
      domain: {
        name: eip712.domain.name,
        version: eip712.domain.version,
        chainId: eip712.domain.chainId,
      },
      types: {
        IntentMandate: eip712.types.IntentMandate,
      },
      primaryType: eip712.primaryType,
      message,
      signature: proof.proofValue as `0x${string}`,
    });

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`🔐 AP2 VC 意图授权签名验证异常: ${msg}`);
    return false;
  }
}

// =====================================================================
// 主入口
// =====================================================================

/**
 * 执行 AP2 三重风控校验（商户验签 + VC 验签 + 预算规则）。
 *
 * 校验顺序（短路设计，失败立即返回，不继续执行后续步骤）：
 * 1) 并行拉取商户公钥（API 11.4）和买方 VC 数据（API 11.5）
 * 2) 检查 VC 数据中的 mandate 有效性（存在性 + 有效期）
 * 3) EIP-191 商户签名验证（基于 11.4 公钥）
 * 4) EIP-712 买家 VC 意图授权验签（基于 11.5 VC 数据）
 * 5) 本地预算规则计算（单笔限额 + 总预算水位）
 *
 * @param config AP2 服务配置（与合规服务共用 baseUrl/apiKey）
 * @param payerWalletAddress 发起支付的钱包地址（即网关的 EVM 钱包地址）
 * @param cartMandate 从 x402 paymentRequired.accepts[0].extra 提取的商户发票
 * @returns AP2 三重校验结果
 */
export async function runAssuranceCheck(
  config: AssuranceConfig,
  payerWalletAddress: string,
  cartMandate: CartMandate,
): Promise<AssuranceResult> {
  const checkedAt = new Date().toISOString();

  try {
    // 并行拉取商户公钥（11.4）和买方 VC 数据（11.5），减少等待时间
    const [publicKey, vcDataRaw] = await Promise.all([
      fetchMerchantPublicKey(config, cartMandate.merchant_address),
      fetchPayerVcData(config, payerWalletAddress),
    ]);

    // 检查 11.5 是否拒绝授权（无 mandate 或已撤销）
    // 实际接口使用 found: true 表示成功，found: false 表示拒绝
    if (vcDataRaw.found !== true) {
      const rejected = vcDataRaw as VcDataRejected;
      const errorCode: AssuranceErrorCode =
        rejected.reason === "MANDATE_EXPIRED" ? "MANDATE_EXPIRED" : "MANDATE_NOT_FOUND";
      return {
        passed: false,
        errorCode,
        errorMessage: `Intent mandate rejected by payer dashboard: ${rejected.reason}`,
        checkedAt,
      };
    }

    const vcData = vcDataRaw as VcData;
    const { mandate, remainingBudget, vcJson } = vcData;

    // 检查 mandate 有效期（本地时钟双重校验，防止缓存过期数据通过）
    const now = new Date();
    const expiresAt = new Date(mandate.expiresAt);
    if (now > expiresAt) {
      return {
        passed: false,
        errorCode: "MANDATE_EXPIRED",
        errorMessage: `Intent mandate has expired at ${mandate.expiresAt}`,
        checkedAt,
      };
    }

    // 商户 EIP-191 签名验证：确保发票未被篡改且由该商户签发
    const merchantSigValid = await verifyMerchantEip191Signature(cartMandate, publicKey);
    if (!merchantSigValid) {
      return {
        passed: false,
        errorCode: "MERCHANT_SIGNATURE_INVALID",
        errorMessage:
          "Merchant EIP-191 signature verification failed. The invoice may have been tampered with or signed by an unknown key.",
        checkedAt,
      };
    }

    // 买家 VC EIP-712 意图授权验签：确保凭证合法且归属当前付款方
    const vcProofValid = await verifyVcEip712Proof(vcJson, payerWalletAddress);
    if (!vcProofValid) {
      return {
        passed: false,
        errorCode: "VC_PROOF_INVALID",
        errorMessage:
          "Buyer intent VC proof (EIP-712) verification failed. The credential may be invalid, expired, or not belong to the payer.",
        checkedAt,
      };
    }

    // 本地预算规则计算：将金额字符串转换为浮点数进行比较
    const txAmount = parseFloat(cartMandate.total_amount);
    const perTxLimit = parseFloat(mandate.perTxLimit);
    const remaining = parseFloat(remainingBudget);

    if (isNaN(txAmount) || isNaN(perTxLimit) || isNaN(remaining)) {
      return {
        passed: false,
        errorCode: "ASSURANCE_API_ERROR",
        errorMessage: `Invalid numeric amount format: total_amount="${cartMandate.total_amount}", perTxLimit="${mandate.perTxLimit}", remainingBudget="${remainingBudget}"`,
        checkedAt,
      };
    }

    // 单笔限额校验：CartMandate.total_amount <= mandate.perTxLimit
    if (txAmount > perTxLimit) {
      return {
        passed: false,
        errorCode: "PER_TX_LIMIT_EXCEEDED",
        errorMessage: `Transaction amount ${cartMandate.total_amount} exceeds per-transaction limit of ${mandate.perTxLimit}.`,
        checkedAt,
      };
    }

    // 总预算水位校验：CartMandate.total_amount <= remainingBudget
    if (txAmount > remaining) {
      return {
        passed: false,
        errorCode: "TOTAL_BUDGET_EXCEEDED",
        errorMessage: `Transaction amount ${cartMandate.total_amount} exceeds remaining budget of ${remainingBudget}.`,
        checkedAt,
      };
    }

    // 三重校验全部通过
    console.error(
      `✅ AP2 验证通过：商户=${cartMandate.merchant_address}，金额=${cartMandate.total_amount} ${cartMandate.currency ?? ""}，买方=${payerWalletAddress}，剩余预算=${remainingBudget}，mandateId=${mandate.id}`,
    );

    return { passed: true, mandateId: mandate.id, checkedAt };
  } catch (error) {
    // fail-close：接口调用异常时默认拒绝，防止风控被绕过
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
