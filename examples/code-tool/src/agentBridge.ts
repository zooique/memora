/**
 * Memora Demo - 代码开发助手
 *
 * 演示 Memora Agent 门面类的"宿主项目接入"路径。
 * 这是 Memora 在工程场景的"装车指南"——证明换 personality + 换领域模板 +
 * 5 行接入，就能从"小说助手"变成"代码助手"。
 *
 * CLI 单形态（无需 WebUI，代码场景更适合终端）
 */
import { Agent } from 'memora';
import type { Config } from 'memora';

// ─── 5 行核心接入代码（这是 Memora 的"一行接入"承诺） ───
export async function createCodeAgent(config: {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  configDir: string; // 宿主项目的人格/规则/技能目录
  projectPath: string; // .memora/ 所在目录
}) {
  const hasRealLlm = !!config.llmApiKey;
  const memoraConfig: Config = {
    llm: hasRealLlm
      ? {
          provider: 'openai-compatible',
          apiKey: config.llmApiKey,
          baseUrl: config.llmBaseUrl,
          model: config.llmModel,
          temperature: 0.2, // 代码开发建议低温度，追求确定性
        }
      : {
          provider: 'mock',
          model: 'mock-coder',
          temperature: 0.2,
        },
    memory: {
      dataDir: '.memora',
      maxContextTokens: 16000, // 代码场景需要更长上下文
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
