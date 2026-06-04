/**
 * B1: 极简 CLI demo
 *
 * 5 分钟上手——开发者视角：
 * - 启动 → 看到 ASCII banner
 * - 提示符（带彩色）
 * - 流式输出（不缓存）
 * - /exit 退出
 */
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createNovelAgent } from './agentBridge.js';
import { loadDemoConfig } from './config.js';
// 导入 Agent 类型（来自 memora）
import type { Agent } from 'memora';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, '..', 'agent-config');
const PROJECT_PATH = resolve(__dirname, '..', '.novel-data');

// ANSI 颜色（不引入 picocolors 依赖，保持 demo 极简）
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
};

function banner(): void {
  console.log(`${c.cyan}${c.bold}
╔══════════════════════════════════════════╗
║                                          ║
║    Memora · 小说创作 Demo（CLI 形态）     ║
║                                          ║
║    一个真实可跑的"宿主项目接入"参考       ║
║                                          ║
╚══════════════════════════════════════════╝${c.reset}
`);
}

function status(config: ReturnType<typeof loadDemoConfig>): void {
  const mode = config.hasRealLlm
    ? `${c.green}真实 LLM${c.reset}（${config.llm.baseUrl} / ${config.llm.model}）`
    : `${c.yellow}Mock 输出${c.reset}（无 API Key，已自动降级）`;
  console.log(`${c.dim}运行模式：${mode}${c.reset}`);
  console.log(`${c.dim}配置文件：${CONFIG_DIR}${c.reset}\n`);
}

async function main(): Promise<void> {
  banner();
  const config = loadDemoConfig();
  status(config);

  // 启动 Agent
  const agent: Agent = await createNovelAgent({
    llmApiKey: config.llm.apiKey,
    llmBaseUrl: config.llm.baseUrl,
    llmModel: config.llm.model,
    configDir: CONFIG_DIR,
    projectPath: PROJECT_PATH,
  });
  console.log(`${c.green}✓ Agent 已启动${c.reset}\n`);

  // REPL
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(`${c.dim}输入 /exit 退出，输入 /memories 查看记忆库${c.reset}\n`);

  while (true) {
    const input = await rl.question(`${c.magenta}你 › ${c.reset}`);
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === '/exit') break;

    if (trimmed === '/memories') {
      // 使用 inspect() 接口展示已挂载的话题记忆
      const snapshot = agent.inspect();
      const { mounted } = snapshot;
      console.log(
        `${c.dim}已挂载 ${mounted.total} 条话题记忆 (isMounted=${mounted.isMounted})：${c.reset}`,
      );
      mounted.items.forEach((m) => {
        console.log(`  - ${m.name} (weight=${m.weight.toFixed(2)})`);
      });
      console.log();
      continue;
    }

    // 真实对话
    process.stdout.write(`${c.cyan}墨羽 › ${c.reset}`);
    if (!config.hasRealLlm) {
      // Mock 输出：让 demo 在无 API Key 情况下也能展示
      console.log(
        `${c.yellow}[Mock] 收到「${trimmed}」— 真实模式下，Agent 会基于 personality + rules + skills 上下文生成回复。${c.reset}\n`,
      );
    } else {
      // 真实 LLM 流式输出（过滤 text 事件，忽略工具调用事件）
      for await (const chunk of agent.chat(trimmed)) {
        if (chunk.type === 'text') {
          process.stdout.write(chunk.content);
        }
      }
      console.log('\n');
    }
  }

  await agent.close();
  rl.close();
  console.log(`\n${c.dim}再见。${c.reset}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
