/**
 * Memora Demo - 小说创作助手
 *
 * 演示 Memora Agent 门面类的"宿主项目接入"路径。
 * 这是 Memora 移植指南的"活样本"——任何想接入 Memora 的开发者，
 * 都可以 cat 这个文件，看到 5 行核心接入代码。
 *
 * 双形态：
 * - CLI: npm run cli （面向开发者，5 分钟上手）
 * - Web: npm run web （面向最终用户，UI 配置 + 聊天）
 */
import { Agent } from 'memora';
import type { Config } from 'memora';

// ─── 5 行核心接入代码（这是 Memora 的"一行接入"承诺） ───
export async function createNovelAgent(config: {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  configDir: string; // 宿主项目的人格/规则/技能目录
  projectPath: string; // .memora/ 所在目录
}) {
  // Memora 完整配置（llm + memory + security 子配置）
  // 注意：llmApiKey 为空时切到 'mock' provider，让 demo 在没配 Key 时也能跑
  // （mock 模式仍走完整 Agent 链路 → topic-*.md 持久化 + signal 检测 + lazy 扫描都生效）
  const hasRealLlm = !!config.llmApiKey;
  const memoraConfig: Config = {
    llm: hasRealLlm
      ? {
          provider: 'openai-compatible',
          apiKey: config.llmApiKey,
          baseUrl: config.llmBaseUrl,
          model: config.llmModel,
          temperature: 0.7, // 小说创作建议略高温度，激发创造性
        }
      : {
          provider: 'mock',
          model: 'mock-novel-writer',
          temperature: 0.7,
        },
    memory: {
      dataDir: '.memora',
      maxContextTokens: 8000,
    },
    security: {
      permission: 'owner',
      confirmWrites: true,
    },
    allowedPaths: ['.'],
  };

  const agent = new Agent({
    config: memoraConfig,
    configDir: config.configDir,
    projectPath: config.projectPath,
  });
  await agent.init();
  return agent;
}
