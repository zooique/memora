/**
 * 宿主诊断聚合 — 「复制诊断摘要」命令的数据源
 *
 * 为什么独立成文件（自 chatPanel.ts 拆出）：chatPanel 是逼近 eslint max-lines 基线的
 * TARGET 文件（只降不升），而诊断聚合是「配置项逐个增加」的线性增长域，留在大文件必爆线
 * （同 injectionBodies.ts 先例）。本模块只做只读聚合，不持有 UI 状态。
 *
 * 安全边界：apiKey 不纳入诊断——真源在 SecretStorage，而摘要是给用户贴到公开渠道的。
 */
import * as vscode from 'vscode';
import type { LlmProviderConfig } from '../../shared/protocol.js';

/** 最近 webview 错误上报的保留条数（容量与格式化同处，防两处漂移） */
export const MAX_RECENT_HOST_DIAGS = 20;

/** webview 错误上报条目（与 protocol.ts 的 host_diag 载荷同形） */
export interface HostDiagEntry {
  at: string;
  source: string;
  message: string;
  stack?: string;
}

/**
 * 诊断只消费的三个计数（结构化子集）
 *
 * 内核 AgentMetrics 可结构化兼容传入——此处不 import 内核类型，避免诊断模块
 * 与内核指标结构强耦合（内核加字段时这里零改动）。
 */
export interface DiagnosticsMetrics {
  llm: { callCount: number; totalInputTokens: number; totalOutputTokens: number };
  tools: { failureCount: number };
  context: { truncationCount: number };
}

/** formatDiagnosticsSnapshot 的入参（调用方只负责取数，格式化与脱敏全在本模块） */
export interface DiagnosticsSnapshotInput {
  extensionVersion: string;
  recentHostDiags: readonly HostDiagEntry[];
  agentMetrics?: DiagnosticsMetrics;
}

/** chatPanel 侧产出的原始诊断数据（版本号由 extension 入口注入——面板不知道版本，也不该知道） */
export type DiagnosticsData = Omit<DiagnosticsSnapshotInput, 'extensionVersion'>;

/**
 * 追加一条 webview 错误并裁到上限
 *
 * 日志留痕与缓冲写入同处：两者是同一事件的两种出口，分开写会出现「日志有、摘要无」。
 * 就地修改缓冲（chatPanel 只持有数组，不复制第二份状态）。
 *
 * @param buffer 环形缓冲（调用方持有）
 * @param entry  刚收到的上报
 */
export function recordHostDiag(buffer: HostDiagEntry[], entry: HostDiagEntry): void {
  console.warn(`Memora webview 未处理异常 [${entry.source}] ${entry.message}`, entry.stack ?? '');
  buffer.push(entry);
  // 有界保留：超出容量从最旧开始丢弃（用户报障关心的是「最近一次现场」）
  while (buffer.length > MAX_RECENT_HOST_DIAGS) buffer.shift();
}

/**
 * 生成可公开的诊断摘要纯文本
 *
 * @param input 版本 / 最近错误 / 运行指标
 * @returns 可直接写入剪贴板的纯文本
 */
export function formatDiagnosticsSnapshot(input: DiagnosticsSnapshotInput): string {
  const cfg = vscode.workspace.getConfiguration('memora');
  const providers = cfg.get<LlmProviderConfig[]>('providers', []);
  const activeProvider = cfg.get<string>('activeProvider', '');
  const metrics = input.agentMetrics;
  const providerLines = providers.length
    ? providers.map((p, i) => {
        // 标签一律走 l10n（摘要会被用户贴进公开渠道，英文用户也要能读懂字段名）
        return vscode.l10n.t(
          '  - {0}: model={1} baseUrl={2}',
          p.name || `#${i + 1}`,
          p.model || vscode.l10n.t('(not filled)'),
          p.baseUrl || vscode.l10n.t('(not filled)'),
        );
      })
    : [`  ${vscode.l10n.t('(not configured)')}`];
  const diagLines = input.recentHostDiags.length
    ? input.recentHostDiags.flatMap((d) => [
        vscode.l10n.t('[{0}] {1}: {2}', d.at, d.source, d.message),
        // 栈只留前 5 行：完整栈对定位「哪个消息处理点炸了」足够，再长反而淹没摘要
        ...(d.stack ? [`  ${d.stack.split('\n').slice(0, 5).join('\n  ')}`] : []),
      ])
    : [vscode.l10n.t('(none)')];
  return [
    vscode.l10n.t('=== Memora diagnostics ==='),
    vscode.l10n.t('Time: {0}', new Date().toISOString()),
    vscode.l10n.t('Extension version: {0}', input.extensionVersion),
    vscode.l10n.t('VS Code: {0} ({1}-{2})', vscode.version, process.platform, process.arch),
    vscode.l10n.t('Host Node: {0}', process.version),
    '',
    vscode.l10n.t('--- Configuration (apiKey lives in SecretStorage and is excluded) ---'),
    vscode.l10n.t('activeProvider: {0}', activeProvider || vscode.l10n.t('(not set)')),
    vscode.l10n.t('providers ({0}):', providers.length),
    ...providerLines,
    vscode.l10n.t('allowedPaths: {0} entries', cfg.get<string[]>('allowedPaths', []).length),
    vscode.l10n.t(
      'disabledSkills: {0}',
      cfg.get<string[]>('disabledSkills', []).join(', ') || vscode.l10n.t('(none)'),
    ),
    vscode.l10n.t('archiveMode: {0}', cfg.get<string>('archiveMode', 'full')),
    vscode.l10n.t(
      'scriptNodePath: {0}',
      cfg.get<string>('scriptNodePath', '') || vscode.l10n.t('(empty → system PATH)'),
    ),
    vscode.l10n.t('showMetrics: {0}', cfg.get<boolean>('showMetrics', false)),
    vscode.l10n.t('attentionSound: {0}', cfg.get<boolean>('attentionSound', true)),
    '',
    vscode.l10n.t('--- Runtime metrics ---'),
    metrics
      ? vscode.l10n.t(
          'LLM calls {0} · tokens in {1} / out {2} · tool failures {3} · truncations {4}',
          metrics.llm.callCount,
          metrics.llm.totalInputTokens,
          metrics.llm.totalOutputTokens,
          metrics.tools.failureCount,
          metrics.context.truncationCount,
        )
      : vscode.l10n.t('(Agent not assembled)'),
    '',
    vscode.l10n.t('--- Recent webview errors (up to {0}) ---', MAX_RECENT_HOST_DIAGS),
    ...diagLines,
  ].join('\n');
}
