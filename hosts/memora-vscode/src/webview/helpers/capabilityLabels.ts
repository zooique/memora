/**
 * capabilityLabels — 中立能力名（`域:动作`）→ 展示文案投影（**非「能力→工具分类」真源**）
 *
 * 角色管理视图（roles view）展示角色能力时的展示映射。能力命名空间是内核概念
 * （role-pack-spec §四：`web:search` / `code:execute` / `task:plan`，见内核
 * `src/role-pack/capabilityMap.ts` 的能力→工具映射），本文档只负责「UI 展示文案」，由 host 在
 * 推送 `roles_loaded` 时把 capability 映射为 label（走默认 `capabilityLabel`，产出英文源键，不做 l10n）。
 *
 * 能力 → 工具映射与「特权键」分类的真源 = 内核 `capabilityMap.ts`；本表只是文案
 * 投影，不复述分类（复述即第二份文字真源，内核改分类时无门会红）。表内保留
 * 非特权键的翻译，只为兼容其它实现生成的中立角色包：未知能力仍回退原始名。
 *
 * **值全为英文源键**：本文件保持纯函数（不 import l10n），由**消费侧**决定
 * 用哪个本地化器——webview 侧 `@vscode/l10n` 的 `t()`，extension host 侧 `vscode.l10n.t()`。
 * 两个环境取同一个 `t` 的实现不同，函数内写死任一个都会在另一侧失效。
 * 当前**过 l10n** 的消费点在 webview 侧（`capabilityChips` / `roleBadgeView`）；host 侧
 * `capabilityState` / `chatPanel` 也消费本表，但只取源键、不做本地化。
 *
 * 未知能力回退显示原始 capability（不硬造文案，避免误导）。
 */

// @nls-keys
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  // 文件域（memora 默认常驻工具；保留翻译 = 中立字典兼容）
  'file:read': 'Read files',
  'file:write': 'Write files',
  'file:list': 'Browse directories',
  // 网络域（特权键）
  'web:search': 'Web search',
  'web:fetch': 'Fetch page content',
  // 通用计算域（特权键）
  'code:execute': 'Execute code',
  // 记忆域（memora 默认常驻；中立字典兼容）
  'memory:recall': 'Recall memories',
  // 任务域（memora 默认常驻、非特权键；保留翻译 = 中立字典兼容）
  'task:plan': 'Plan tasks',
  // 内核内部能力
  'llm:summarize': 'Generate summaries',
};

/** 能力名 → 可读标签（未知能力回退原始 capability 名；消费侧再过 l10n） */
export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

/** 输入区能力徽章的**域级短标签**（`file:read` → 「File」）：该处只有一行空间，按域折叠 */
// @nls-keys
const CAPABILITY_DOMAIN_LABELS: Readonly<Record<string, string>> = {
  file: 'File',
  web: 'Web',
  memory: 'Memory',
  llm: 'LLM',
};

/**
 * 能力面**三态**的界面文案（`all` / `residentOnly` 两种；`list` 走 `capabilityLabel` 的能力名）。
 *
 * 输入区能力徽章（`roleBadgeView.updateCapabilityBadge`）与角色卡（`rolesView`）**共用这一份**——
 * 两个显示面都只是投影，判定仍只在 `capabilityState.ts` 一处做。新增显示面请复用本表，
 * 禁止在视图里另写文案。值 = 英文源键，消费侧过 l10n。
 */
// @nls-keys
export const CAPABILITY_STATE_TEXT: Readonly<
  Record<'all' | 'residentOnly', { label: string; title: string }>
> = {
  /** 未声明能力白名单 = 放行全部工具 */
  all: {
    label: 'All tools',
    title: 'All tools are allowed (the role pack declares no capability allowlist)',
  },
  /** 显式声明空能力白名单 = 仅常驻工具，特权工具全关 */
  residentOnly: {
    label: 'Basic tools only',
    title:
      'Basic tools only: the role pack declares an empty capability allowlist (privileged tools such as web search and code execution are off)',
  },
};

/**
 * 能力名 → 域级短标签（取 `域:动作` 的域段；未配短标签的域回退原始域段，不硬造文案。
 * 当前表只配 `file` / `web` / `memory` / `llm`，`code` / `task` 域会显示原文）
 *
 * 供输入区能力徽章使用（`roles_loaded` 的角色卡用 `capabilityLabel` 的细粒度文案）。
 * 两者都只是**标签投影**；三态判定仍只由 `capabilityState.ts` 一处做。
 *
 * @param capability 中立能力名，如 `web:search`
 */
export function capabilityDomainLabel(capability: string): string {
  const [domain] = capability.split(':');
  return CAPABILITY_DOMAIN_LABELS[domain] ?? domain;
}
