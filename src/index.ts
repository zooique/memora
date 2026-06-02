/**
 * Memora — 通用 Agent 架构
 * CLI 入口
 *
 * 设计哲学：万物皆记忆（详见 docs/基础设计文档/agent设计.md §1.2）
 * 决策追溯：详见 .trae/rules/decisions/ 下的 8 个 ADR
 */
import { Command } from 'commander';
import { startRepl } from './cli/repl.js';
import { initCommand } from './cli/commands/init.js';
import { configCommand } from './cli/commands/config.js';
import { loadConfig } from './config/loader.js';
import { toFriendlyError } from './utils/errors.js';

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
  .description('初始化项目（生成 personality.md / rules/ / .memora/）')
  .option('-p, --project <path>', '指定项目目录', process.cwd())
  .action(initCommand);

program
  .command('config <action> [key]')
  .description('配置管理：show / get <key> / path / edit')
  .option('-c, --config <path>', '指定配置文件路径')
  .action(async (action, key, opts) => {
    try {
      // 把 key 也传给内部 handler（统一参数形式）
      await configCommand(action, key ? [key] : [], opts);
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
