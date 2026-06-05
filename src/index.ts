/**
 * Memora — 通用 Agent 架构
 *
 * 统一入口：
 * - CLI 模式（直接运行 memora）：解析命令参数，启动 REPL
 * - 库模式（import from '@memora/core'）：导出 Agent / Config 等供宿主项目接入
 *
 * 设计哲学：万物皆记忆（详见 docs/基础设计文档/01-主架构-v4.0.md §1.2）
 * 决策追溯：详见 .trae/rules/decisions/ 下的 8 个 ADR
 */
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startRepl } from './cli/repl.js';
import { initCommand } from './cli/commands/init.js';
import { configCommand, configLlmCommand } from './cli/commands/config.js';
import { loadConfig } from './config/loader.js';
import { toFriendlyError } from './utils/errors.js';

// ─── 库导出：供宿主项目 import 接入 ──────────────────────
export { Agent } from './agent/agent.js';
export type { AgentChunk, ThinkingPhase } from './agent/types.js';
export type {
  AgentOptions,
  AgentContext,
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  MountedSnapshot,
  ArchiveMode,
} from './agent/agent.js';
export type { ToolDefinition, ToolHandler } from './agent/tool-executor.js';
export type { PersonaMode } from './persona/personaManager.js';
export type { ConfigSuggestion, ConfigSuggestionHandler } from './agent/agent.js';
export { loadConfig } from './config/loader.js';
export type { Config } from './config/loader.js';
// P1-3 修复：导出宿主程序调用 addRule() 所需的类型
export { MemoryType, Permanence } from './memory/types.js';
export type { Memory, MemoryTypeValue, PermanenceValue } from './memory/types.js';
// C1 修复：导出宿主程序调用 addSkill() 所需的 SkillEntry 类型
export type { SkillEntry } from './skill/skillManager.js';

// ─── CLI 入口：仅在直接运行时执行（非 import 时） ─────────
// 判断依据：当前模块路径 === Node.js 执行入口（process.argv[1]）
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  const program = new Command();

  program.name('memora').description('通用 Agent 架构 — 本地、私有、领域无关').version('0.1.0');

  program
    .command('chat')
    .description('启动交互式 REPL（默认命令）')
    .option('-p, --project <path>', '指定项目目录', process.cwd())
    .option('-c, --config <path>', '指定配置文件路径')
    .action(async (opts) => {
      try {
        const config = await loadConfig(opts.config);
        await startRepl({ projectPath: opts.project, config });
      } catch (err) {
        const friendly = toFriendlyError(err);
        friendly.log();
        console.error(`\n${friendly.format()}\n`);
        process.exit(1);
      }
    });

  program
    .command('init')
    .description('初始化项目（生成 personas/ / rules/ / .memora/）')
    .option('-p, --project <path>', '指定项目目录', process.cwd())
    .option('-d, --domain <name>', '领域模板 code|novel（可选，不指定则只生成 .memora/ 骨架）')
    .option('-u, --user', '用户模式：交互式生成 ~/.memora/agent-config/（模式 2）')
    .action(async (opts) => {
      try {
        await initCommand(opts);
      } catch (err) {
        const friendly = toFriendlyError(err);
        friendly.log();
        console.error(`\n${friendly.format()}\n`);
        process.exit(1);
      }
    });

  program
    .command('config <action> [key]')
    .description('配置管理：show / get <key> / path / edit')
    .option('-c, --config <path>', '指定配置文件路径')
    .action(async (action, key, opts) => {
      try {
        await configCommand(action, key ? [key] : [], opts);
      } catch (err) {
        const friendly = toFriendlyError(err);
        friendly.log();
        console.error(`\n${friendly.format()}\n`);
        process.exit(1);
      }
    });

  // v1.2：多 Provider 管理
  program
    .command('config-llm <action> [name]')
    .description('LLM Provider 管理：list / add <name> / use <name>')
    .option('-c, --config <path>', '指定配置文件路径')
    .action(async (action, name, opts) => {
      try {
        await configLlmCommand(action, name ? [name] : [], opts);
      } catch (err) {
        const friendly = toFriendlyError(err);
        friendly.log();
        console.error(`\n${friendly.format()}\n`);
        process.exit(1);
      }
    });

  // 默认行为：直接进入 chat
  program.action(async () => {
    try {
      const config = await loadConfig();
      await startRepl({ projectPath: process.cwd(), config });
    } catch (err) {
      const friendly = toFriendlyError(err);
      friendly.log();
      console.error(`\n${friendly.format()}\n`);
      process.exit(1);
    }
  });

  program.parseAsync(process.argv).catch((err) => {
    const friendly = toFriendlyError(err);
    friendly.log();
    console.error(`\n${friendly.format()}\n`);
    process.exit(1);
  });
} // if (isDirectRun)
