/**
 * CLI 输出格式化工具（M-205）
 *
 * 设计：纯函数 + 零副作用（不直接 console.log）
 * 使用方：
 *   - src/cli/repl.ts（欢迎/帮助/列表/工具结果）
 *   - src/agent/tool-executor.ts（错误消息友好化）
 *
 * 依赖：picocolors（ANSI 颜色，< 2KB 零依赖）
 */
import pc from 'picocolors';

const HORIZONTAL = '─';
const BOX_HORIZONTAL = '─';
const BOX_VERTICAL = '│';
const BOX_TOP_LEFT = '┌';
const BOX_TOP_RIGHT = '┐';
const BOX_BOTTOM_LEFT = '└';
const BOX_BOTTOM_RIGHT = '┘';

/**
 * 工具结果框（box-drawing 字符 + cyan 边框）
 * @param name 工具名称
 * @param result 工具结果字符串
 * @returns 多行 ANSI 彩色字符串
 */
export function formatToolResult(name: string, result: string): string {
  const title = `🔧 ${name}`;
  const bodyLines = result.split('\n');
  const width = Math.max(title.length + 4, ...bodyLines.map((l) => l.length + 2));
  const titleLine = `${BOX_TOP_LEFT}${BOX_HORIZONTAL} ${title} ${BOX_HORIZONTAL.repeat(Math.max(0, width - title.length - 4))}${BOX_TOP_RIGHT}`;
  const body = bodyLines
    .map((l) => `${pc.cyan(BOX_VERTICAL)} ${l.padEnd(width - 2, ' ')}`)
    .join('\n');
  const endLine = `${BOX_BOTTOM_LEFT}${BOX_HORIZONTAL.repeat(width)}${BOX_BOTTOM_RIGHT}`;
  return pc.cyan(titleLine) + '\n' + body + '\n' + pc.cyan(endLine);
}

/**
 * 工具调用开始标记
 */
export function formatToolStart(name: string): string {
  return pc.cyan(`\n🔧 正在调用工具: ${pc.bold(name)} ...`);
}

/**
 * 工具调用结束标记
 */
export function formatToolEnd(name: string, ok: boolean): string {
  return ok ? pc.green(`✅ 工具完成: ${name}\n`) : pc.red(`❌ 工具失败: ${name}\n`);
}

/**
 * 欢迎横幅（M-205 美化版）
 */
export function formatWelcome(opts: {
  version: string;
  projectPath: string;
  projectName: string;
  modelName: string;
  dbPath: string;
  loadedCount: number;
  bootstrapCount: number;
  skippedCount: number;
  globalRulesCount: number;
  currentTopic: string;
}): string {
  const lines = [
    '',
    pc.bold(pc.cyan(`🌲 Memora Agent v${opts.version}`)),
    pc.dim(HORIZONTAL.repeat(60)),
    `${pc.dim('📁 项目：')}      ${opts.projectName} ${pc.dim(`(${opts.projectPath})`)}`,
    `${pc.dim('🤖 模型：')}      ${opts.modelName}`,
    `${pc.dim('💾 数据库：')}    ${opts.dbPath}`,
    `${pc.dim('📚 加载记忆：')}  ${opts.loadedCount} 条（必召 ${pc.cyan(String(opts.bootstrapCount))} 条）${
      opts.skippedCount > 0 ? pc.yellow(` ⚠️ 跳过 ${opts.skippedCount} 条`) : ''
    }${opts.globalRulesCount > 0 ? pc.dim(` · 全局规则 ${opts.globalRulesCount} 条`) : ''}`,
    `${pc.dim('💬 当前话题：')}  ${pc.cyan(opts.currentTopic)}`,
    pc.dim(HORIZONTAL.repeat(60)),
    `${pc.gray('输入 ')}${pc.bold('/exit')}${pc.gray(' 退出，')}${pc.bold('/help')}${pc.gray(' 查看帮助')}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * 帮助信息
 */
export function formatHelp(): string {
  const cmds: Array<[string, string]> = [
    ['/exit, /quit', '退出'],
    ['/help', '显示帮助'],
    ['/tools', '列出可用工具'],
    ['/memories', '列出已加载记忆'],
    ['/search <query>', '搜索记忆'],
    ['/project [name]', '切换项目（不填则显示列表）'],
    ['/domain [name]', '切换领域（不填则显示列表）'],
    ['/topic <name>', '切换话题（不填则显示当前）'],
    ['/topics', '列出所有话题文件'],
  ];
  const lines = [
    pc.bold(pc.blue('命令：')),
    ...cmds.map(([name, desc]) => `  ${pc.cyan(name.padEnd(20))} ${pc.dim(desc)}`),
  ];
  return lines.join('\n');
}

/**
 * 工具列表
 */
export function formatToolsList(
  tools: ReadonlyArray<{ name: string; description: string }>,
): string {
  const lines = [
    pc.bold(pc.blue(`可用工具（共 ${tools.length} 个）：`)),
    ...tools.map((t) => `  ${pc.cyan(pc.bold(t.name))}: ${t.description}`),
  ];
  return lines.join('\n');
}

/**
 * 必召记忆列表
 */
export function formatMemoriesList(
  memories: ReadonlyArray<{ permanence: string; type: string; name: string }>,
): string {
  const lines = [
    pc.bold(pc.blue(`已加载 ${memories.length} 条必召记忆：`)),
    ...memories.map(
      (m) => `  ${pc.yellow(m.permanence.padEnd(8))} ${pc.cyan(`${m.type}:${m.name}`)}`,
    ),
  ];
  return lines.join('\n');
}

/**
 * 话题列表
 */
export function formatTopicsList(topics: ReadonlyArray<string>): string {
  if (topics.length === 0) {
    return pc.dim('（暂无话题）');
  }
  const lines = [
    pc.bold(pc.blue(`共 ${topics.length} 个话题文件：`)),
    ...topics.map((t) => `  ${pc.cyan('•')} ${t}`),
  ];
  return lines.join('\n');
}

/**
 * 成功消息（绿色）
 */
export function formatSuccess(msg: string): string {
  return pc.green(`✅ ${msg}`);
}

/**
 * 错误消息（红色加粗）
 */
export function formatError(title: string, detail?: string): string {
  const lines = ['', pc.red(pc.bold(`❌ ${title}`))];
  if (detail) {
    lines.push(pc.red(detail));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 警告消息（黄色）
 */
export function formatWarning(msg: string): string {
  return pc.yellow(`⚠️  ${msg}`);
}
