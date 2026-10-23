/**
 * MCP 审批三档 — allowlist 寻址 + 档位计算（方案 §4.3 / §9 切片 2）
 *
 * 三档形态（业界通行，S3）：逐次确认（默认）/ allowlist 免确认 / server 停用。
 * 前两档在本模块计算，**注册时定格**进 `ToolDefinition.confirmPolicy`（内核只有
 * `'always' | 'audit'` 两值，见 builtinTools.ts）；第三档 = `enabled: false`
 * 不注册，工具对模型不存在（runtime.ts 的事，与本模块无关）。
 *
 * 两条硬约束：
 *   1. **寻址用原名**：键 = `mcp__<server 原名>__<tool 原名>`。派生名
 *      （`toolRegistry.deriveToolName`）会做字符清洗 + 撞名加 `_2` 后缀，
 *      按派生名写规则会在撞名/清洗时**静默失效** ⇒ 这里刻意不认派生名。
 *   2. **fail-closed**：allowlist 读不到合法值（非数组 / 项非字符串 / 空串）
 *      ⇒ 空集 ⇒ 全部落 `'always'`。宁多弹窗，不静默放行。
 *
 * 红线（D3）：本模块只回答「这个工具要不要问」，且答案只经 confirmPolicy
 * 表达；**不**调用任何内核安全方法自拼判据（那会造出第二套审批实现）。
 */
import type { ToolDefinition } from '@zooique/memora';

/**
 * allowlist 寻址键前缀
 *
 * 与派生工具名前缀（toolRegistry.MCP_TOOL_NAME_PREFIX）**同形不同源**：
 * 用户照模型可见的工具名形状写规则，但寻址按原名。两者刻意各持一份字面量——
 * 合成一个公共模块会为个字符串建文件，互相 import 又会成环；若哪天要统一，
 * 抽 `mcp/naming.ts`，勿在两地加第二个引用点。
 */
const ALLOWLIST_KEY_PREFIX = 'mcp__';

/** 审批档位（内核 confirmPolicy 的两值；undefined = 不过闸，宿主永不使用） */
export type McpConfirmPolicy = NonNullable<ToolDefinition['confirmPolicy']>;

/** 解析后的 allowlist（寻址键集合；空集 = 全部逐次确认） */
export type McpToolAllowlist = ReadonlySet<string>;

/**
 * 构造 allowlist 寻址键（server 原名 + tool 原名）
 *
 * 刻意不做任何清洗/截断：配置里写什么就按什么寻址。代价诚实登记——原名含
 * `__` 时键有理论撞解（`a__b` + `c` 与 `a` + `b__c` 同串），后果是某把被
 * 显式写进 allowlist 的同形工具一并免确认；不按拆分解析处理，因为拆分本身
 * 在此场景不可靠（用户无法从键反推拆分方式），宁留可解释的简单形态。
 *
 * @param serverName server 原名（配置里的 name）
 * @param toolName 工具原名（server 的 tools/list 返回值）
 */
export function allowlistKey(serverName: string, toolName: string): string {
  return `${ALLOWLIST_KEY_PREFIX}${serverName}__${toolName}`;
}

/**
 * 解析 allowlist 配置（fail-closed）
 *
 * 输入是用户设置原值（VS Code 配置可被 settings.json 绕过 schema），故按
 * 未知值收窄：非数组、非字符串项、空串一律忽略。读不到合法值 = 空集 =
 * 全部 `'always'`，不存在「解析失败 → 放行」的路径。
 *
 * @param raw `memora.mcpToolAllowlist` 原值
 * @returns 寻址键集合（去重）
 */
export function parseAllowlist(raw: unknown): McpToolAllowlist {
  if (!Array.isArray(raw)) return new Set<string>();
  const keys = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (key.length > 0) keys.add(key);
  }
  return keys;
}

/**
 * 计算某工具的确认档位（注册时定格）
 *
 * 命中 allowlist ⇒ `'audit'`（过闸自动放行，仍落 write-auto 审计——免弹窗
 * 不免审计）；未命中 ⇒ `'always'`（每次调用都弹确认）。无「全部放行」档：
 * allowlist 必须逐条显式书写（反「自动化默认」，方案 §4.3）。
 *
 * @param serverName server 原名
 * @param toolName 工具原名
 * @param allowlist 已解析的 allowlist（空集 = 全部逐次确认）
 */
export function resolveConfirmPolicy(
  serverName: string,
  toolName: string,
  allowlist: McpToolAllowlist,
): McpConfirmPolicy {
  return allowlist.has(allowlistKey(serverName, toolName)) ? 'audit' : 'always';
}
