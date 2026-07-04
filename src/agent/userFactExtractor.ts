/**
 * 用户事实提取器 — 从对话输入中提取结构化用户画像
 *
 * 职责：
 *   - 正则 + 关键词规则提取用户身份、偏好、专长等事实
 *   - 输出结构化 ExtractedFact，供 UserProfile 归档
 *
 * 设计原则：
 *   - 语义解析属于 agent/ 层，memory/ 只做存储
 *   - 兼顾阶段一低成本需求（正则规则），后续可升级为 LLM 提取
 */
import type { ExtractedFact } from '@/memory/userProfile.js';

export type { ExtractedFact } from '@/memory/userProfile.js';

/**
 * 从用户输入中提取事实
 *
 * 使用正则 + 关键词规则，兼顾阶段一的低成本需求。
 * 高置信度规则（≥0.9）→ 直接归档
 * 中置信度（0.7-0.8）→ 标记待确认
 *
 * @param input 用户原始输入
 * @param turnIndex 当前轮次标识
 */
export function extractUserFacts(input: string, turnIndex: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // ── 高置信度：身份声明 ──
  // "我叫张三" "我是张三" "我的名字是张三"
  // 排除问句关键词（谁/哪/什/吗），防止 "我是谁" "我是哪个" 误匹配
const identityMatch = input.match(/我(?:叫|是|的名字是)\s*([^\s，。,\.!！?？\n谁哪什吗]{1,15})/);
  if (identityMatch) {
    facts.push({
      category: 'identity',
      value: `姓名: ${identityMatch[1]}`,
      sourceTurn: turnIndex,
      confidence: 0.95,
    });
  }

  // "我住在北京" "我家在上海"
  const locationMatch = input.match(/(?:我住在?|我家在)\s*([^\s，。,\.!！?？\n]{1,15})/);
  if (locationMatch) {
    facts.push({
      category: 'identity',
      value: `住址: ${locationMatch[1]}`,
      sourceTurn: turnIndex,
      confidence: 0.9,
    });
  }

  // "我(是|当|做).*?(的)" —— 职业声明
  const jobMatch = input.match(
    /我(?:是|当|做)(?:一[个名位])?\s*([^\s，。,\.!！?？\n谁哪什吗]{1,10})(?:的)?/,
  );
  if (jobMatch && !identityMatch) {
    // 避免与 identityMatch 重复
    facts.push({
      category: 'identity',
      value: `职业: ${jobMatch[1]}`,
      sourceTurn: turnIndex,
      confidence: 0.85,
    });
  }

  // ── 高置信度：偏好声明 ──
  // "我喜欢TS" "我更喜欢Python" "我习惯用VS Code"
  const prefMatch = input.match(
    /(?:我(?:很|非常|最|更)?(?:喜欢|爱|习惯|偏好)(?:用|写|做|的))\s*([^\s，。,\.!！?？\n]{1,20})/,
  );
  if (prefMatch) {
    facts.push({
      category: 'preference',
      value: `偏好: ${prefMatch[1]}`,
      sourceTurn: turnIndex,
      confidence: 0.85,
    });
  }

  // ── 中置信度：工具/环境声明 ──
  // "我用VS Code" "我的环境是Windows"
  const toolMatch = input.match(/我(?:用|使用|的环境是)\s*([^\s，。,\.!！?？\n]{1,20})/);
  if (toolMatch && !prefMatch) {
    facts.push({
      category: 'preference',
      value: `工具: ${toolMatch[1]}`,
      sourceTurn: turnIndex,
      confidence: 0.8,
    });
  }

  // ── 较低置信度：专长声明 ──
  // "我熟悉React" "我擅长后端"
  const expertiseMatch = input.match(/我(?:熟悉|擅长|精通|会)\s*([^\s，。,\.!！?？\n]{1,20})/);
  if (expertiseMatch) {
    facts.push({
      category: 'expertise',
      value: `专长: ${expertiseMatch[1]}`,
      sourceTurn: turnIndex,
      confidence: 0.75,
    });
  }

  return facts;
}
