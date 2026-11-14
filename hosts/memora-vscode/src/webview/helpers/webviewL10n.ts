/**
 * webview 侧 l10n 装配 — 宿主注入译文的读取端
 *
 * webview 运行时拿不到 `vscode.l10n`，译文由宿主序列化进 HTML 数据块
 * （写端 = helpers/htmlShell 的 buildL10nBundleScript，元素 id 真源 =
 * shared/constants 的 L10N_BUNDLE_ELEMENT_ID），本模块在面板入口启动时读出并
 * `config`——必须先于任何 `l10n.t` 调用（@vscode/l10n 契约：config 定义译文表）。
 *
 * 无注入（默认语言，`vscode.l10n.bundle` 为 undefined ⇒ 宿主不产数据块）时保持
 * 未配置：`l10n.t` 返回原文，与宿主侧 `vscode.l10n.t` 同一语义——本模块落地时零可见
 * 变化。译文迁移按面板分批推进，进度真源是 `scripts/verify-nls.mjs` 的 `WEBVIEW_PANELS`
 * （逐项 `state: 'migrated'`）；本模块自身不持有任何文案。
 *
 * 消费约定：webview 业务码一律 `import * as l10n from '@vscode/l10n'` 后写
 * `l10n.t('…')`——键面守卫 verify-nls 按 `l10n.t(` 采集源码键（判据⑨⑫），
 * `import { t }` 裸别名会让键面静默脱管（判据⑯ 拦截）。
 */
import * as l10n from '@vscode/l10n';
import { L10N_BUNDLE_ELEMENT_ID } from '../../shared/constants.js';

/** 最小文档面：测试注入假 document（vitest 环境为 node，无 DOM） */
interface BundleDoc {
  getElementById(id: string): { textContent: string | null } | null;
}

/**
 * 读注入数据块并装配译文（webview 入口启动时调用一次）。
 *
 * 无元素 / JSON 损坏时不 `config`（`l10n.t` 保持返回原文）。损坏不抛错：
 * 入口抛错会带塌整个面板，而降级只是「显示源语言」——注入块是跨进程边界数据，
 * 宁可降级不可塌面板。
 */
export function initWebviewL10n(doc: BundleDoc = document): void {
  const raw = doc.getElementById(L10N_BUNDLE_ELEMENT_ID)?.textContent;
  if (!raw) return;
  try {
    l10n.config({ contents: JSON.parse(raw) as Record<string, string> });
  } catch {
    // 注入块损坏：写端已转义 `<`，正常不可达；防御旧版本宿主 / 手改 HTML，保持未配置
  }
}
