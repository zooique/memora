/**
 * 极简 CLI demo — 代码开发助手
 *
 * 5 分钟上手——开发者视角：
 * - 启动 → 看到 ASCII banner
 * - 流式输出（不缓存）
 * - /exit 退出
 */
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createCodeAgent } from './agentBridge.js';
import { loadDemoConfig } from './config.js';
import type { Agent } from 'memora';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, '..', 'agent-config');
const PROJECT_PATH = resolve(__dirname, '..', '.code-data');

// ANSI 颜色（不引入 picocolors 依赖，保持 demo 极简）
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
};

console.log(
  [
    '',
    `${c.cyan}╔══════════════════════════════════════╗${c.reset}`,
    `${c.cyan}║   ${c.bold}Memora · Code Tool${c.reset}${c.cyan}              ║${c.reset}`,
    `${c.cyan}║   ${c.dim}通用 AI 编程助手${c.reset}${c.cyan}                ║${c.reset}`,
    `${c.cyan}╚══════════════════════════════════════╝${c.reset}`,
    '',
  ].join('\n'),
);

const config = loadDemoConfig();
// 初始化时不 await——让提示符先出现，Agent 后台初始化
const agentPromise = createCodeAgent({
  llmApiKey: config.llm.apiKey,
  llmBaseUrl: config.llm.baseUrl,
  llmModel: config.llm.model,
  configDir: CONFIG_DIR,
  projectPath: PROJECT_PATH,
});

async function main() {
  const agent: Agent = await agentPromise;
  const hasKey = config.hasRealLlm;
  const provider = hasKey
    ? `${c.green}✓${c.reset} 真实 LLM (${config.llm.model})`
    : `${c.yellow}⚠ Mock${c.reset} 模式——点 "⚙ 配置 LLM" 填入 API Key`;

  console.log(`  ${provider}\n`);
  console.log(`${c.dim}  输入 /exit 退出。直接输入内容开始对话。${c.reset}\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    const input = (await rl.question(`${c.bold}code ›${c.reset} `)).trim();

    if (!input) continue;
    if (input === '/exit' || input === '/quit') break;

    process.stdout.write(`\n${c.bold}agent ›${c.reset} `);
    for await (const chunk of agent.chat(input)) {
      process.stdout.write(chunk);
    }
    console.log('\n');
  }

  await agent.close();
  rl.close();
  console.log(`\n${c.dim}再见。${c.reset}\n`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
