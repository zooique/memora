/**
 * CLI 格式化器 — 纯文本展示逻辑
 *
 * 从 Sprite 核心类提取的 CLI 专用格式化方法。
 * Electron 模式下不使用这些方法（UI 直接消费结构化数据），
 * 仅 CLI 模式下需要。
 *
 * 提取理由（P2-5）：
 *   - formatConfig / formatDashboard / formatPersonas 是 CLI 专用的文本格式化
 *   - 耦合在 Sprite 核心类中违反职责单一
 *   - 提取后 Sprite 只提供结构化数据，格式化由消费方决定
 */

import type { SpriteConfig } from './spriteConfig.js';
import type { DashboardData } from './controllers/index.js';
import { DEFAULT_SPRITE_CONFIG } from './spriteConfig.js';
import { MS_PER_MINUTE } from './constants.js';

/** 角色列表项（与 PersonaController.list() 返回类型对齐） */
interface PersonaEntry {
  name: string;
  description?: string;
  active: boolean;
}

/**
 * 格式化精灵配置为 CLI 可读文本
 *
 * @param config 精灵配置对象
 * @returns 格式化后的配置文本
 */
export function formatConfig(config: SpriteConfig): string {
  const lines: string[] = ['── 精灵配置 ──'];
  // P1-4 修复：兜底默认值引用 DEFAULT_SPRITE_CONFIG，避免与实际默认值不一致
  lines.push(`  触发器间隔：${(config.triggerIntervalMs ?? DEFAULT_SPRITE_CONFIG.triggerIntervalMs) / MS_PER_MINUTE} 分钟`);
  lines.push(`  默认角色：${config.defaultPersona || '(未设置)'}`);
  lines.push(`  静默模式：${config.silentMode ? '开启' : '关闭'}`);
  lines.push(`  主动提示阈值：${config.proactiveThreshold ?? DEFAULT_SPRITE_CONFIG.proactiveThreshold} 个事件`);
  lines.push(`  主动提示冷却：${(config.proactiveCooldownMs ?? DEFAULT_SPRITE_CONFIG.proactiveCooldownMs) / MS_PER_MINUTE} 分钟`);
  lines.push(`  文件监听：${config.fileWatcherEnabled ? '开启' : '关闭'}`);
  if (config.fileWatcherEnabled) {
    lines.push(`  监听路径：${(config.fileWatcherPaths ?? []).join(', ')}`);
    lines.push(`  忽略模式：${(config.fileWatcherIgnore ?? []).join(', ')}`);
    lines.push(`  防抖时间：${config.fileWatcherDebounceMs ?? 1000} 毫秒`);
  }
  const modeLabel = config.projectMode === 'focus' ? '专注模式' : '智能模式';
  lines.push(`  项目模式：${modeLabel}`);
  if (config.projectMode === 'focus' && config.focusProjectPath) {
    lines.push(`  专注项目：${config.focusProjectPath}`);
  }
  return lines.join('\n');
}

/**
 * 格式化记忆仪表盘为 CLI 可读文本
 *
 * @param data 仪表盘数据
 * @param pendingNotices 累积事件数
 * @param proactiveThreshold 主动提示阈值
 * @param registeredTriggers 已注册触发器列表
 * @returns 格式化后的仪表盘文本
 */
export function formatDashboard(
  data: DashboardData,
  pendingNotices: number,
  proactiveThreshold: number,
  registeredTriggers: string[],
): string {
  const lines: string[] = [];

  lines.push('── 记忆仪表盘 ──');
  lines.push(`总记忆数：${data.total}`);

  lines.push(`累积事件：${pendingNotices}（阈值 ${proactiveThreshold}）`);
  lines.push(`已注册触发器：${registeredTriggers.join(', ')}`);

  if (Object.keys(data.bySource).length > 0) {
    const sourceList = Object.entries(data.bySource)
      .sort(([, a], [, b]) => b - a)
      .map(([source, count]) => `  ${source}: ${count}`)
      .join('\n');
    lines.push(`按来源：\n${sourceList}`);
  }

  if (data.suggestions.length > 0) {
    lines.push('推荐关注：');
    for (const hit of data.suggestions) {
      lines.push(`  [${hit.source}] ${hit.name} (${hit.reason}, 相关度 ${hit.relevance})`);
    }
  } else {
    lines.push('暂无推荐（记忆库为空或尚无足够数据）');
  }

  return lines.join('\n');
}

/**
 * 格式化角色列表为 CLI 可读文本
 *
 * @param personas 角色列表项
 * @param activeName 当前激活角色名
 * @returns 格式化后的角色列表文本
 */
export function formatPersonas(personas: PersonaEntry[], activeName?: string): string {
  if (personas.length === 0) {
    return '暂无可用角色\n\n提示：在 agent-config/personas/ 目录下创建角色配置文件（.md 格式）即可添加角色';
  }

  const lines: string[] = ['── 角色列表 ──'];
  for (const p of personas) {
    const marker = p.active ? ' *' : '';
    const desc = p.description ? ` — ${p.description}` : '';
    lines.push(`  ${p.name}${marker}${desc}`);
  }
  lines.push(`\n当前角色：${activeName ?? '(无)'}`);
  return lines.join('\n');
}
