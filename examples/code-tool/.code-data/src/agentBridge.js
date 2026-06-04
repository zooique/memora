// agentBridge.js — Memora Agent 接入代码
// 领域: code
//
// 使用前请：
//   1. 填入你的 LLM API Key（第 18 行附近）
//   2. 确认 configDir 指向你的 agent-config/ 目录
//   3. 运行: node src/agentBridge.js

import { Agent } from 'memora';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const agent = new Agent({
    projectPath: resolve(__dirname, '..'),
    configDir: resolve(__dirname, '..', 'agent-config'),
    config: {
      llm: {
        // TODO: 替换为你的 LLM API Key
        // 方式 1: 直接填入（不推荐提交到 git）
        // apiKey: 'sk-xxxxxxxxxxxxxxxx',
        // 方式 2: 从环境变量读取（推荐）
        provider: 'deepseek',      // 'deepseek' | 'doubao' | 'openai' | 'mock'
        model: 'deepseek-chat',
        apiKey: process.env.LLM_API_KEY || 'YOUR_API_KEY_HERE',
      },
      memory: {
        dataDir: '~/.memora',
        maxContextTokens: 120000,
      },
      security: {
        permission: 'owner',
        confirmWrites: false,
      },
      allowedPaths: [resolve(__dirname, '..')],
    },
  });

  console.log('[AgentBridge] 正在初始化...');
  await agent.init();
  console.log('[AgentBridge] 初始化完成！输入你的消息，按 Ctrl+C 退出。\n');

  // 简单的 REPL 循环（你也可以替换为自己的 UI）
  process.stdout.write('> ');
  process.stdin.on('data', async (chunk) => {
    const input = chunk.toString().trim();
    if (input === 'exit' || input === 'quit') {
      await agent.close();
      console.log('[AgentBridge] 已退出。');
      process.exit(0);
    }

    try {
      process.stdout.write('\n');
      for await (const chunk of agent.chat(input)) {
        process.stdout.write(chunk);
      }
      process.stdout.write('\n\n> ');
    } catch (err) {
      console.error('出错:', err.message);
      process.stdout.write('> ');
    }
  });
}

main().catch((err) => {
  console.error('初始化失败:', err.message);
  process.exit(1);
});
