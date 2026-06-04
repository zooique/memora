/**
 * 配置文件加载（demo 公共模块）
 *
 * 优先级：环境变量 > 配置文件 > 默认值
 * 自适应：有真实 LLM Key 就走真实调用，否则走 Mock 输出
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 类型 ────────────────────────────────────────────
export interface DemoConfig {
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  hasRealLlm: boolean; // 自适应：true=真实 LLM，false=Mock
}

// ─── 默认配置（mimo 免费 API） ──────────────────────────
const DEFAULTS: DemoConfig = {
  llm: {
    apiKey: '',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
  },
  hasRealLlm: false,
};

// ─── 加载逻辑 ────────────────────────────────────────
export function loadDemoConfig(): DemoConfig {
  // 1) 优先：环境变量
  const envKey = process.env.MIMI_API_KEY ?? process.env.LLM_API_KEY ?? '';
  const envBaseUrl = process.env.LLM_BASE_URL;
  const envModel = process.env.LLM_MODEL;

  // 2) 次选：配置文件
  const configPath = resolve(__dirname, '..', 'config.local.json');
  let fileConfig: Partial<DemoConfig> = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // 配置文件解析失败，忽略
    }
  }

  // 3) 合并（环境变量覆盖文件，文件覆盖默认）
  const apiKey = envKey || fileConfig.llm?.apiKey || DEFAULTS.llm.apiKey;
  const baseUrl = envBaseUrl || fileConfig.llm?.baseUrl || DEFAULTS.llm.baseUrl;
  const model = envModel || fileConfig.llm?.model || DEFAULTS.llm.model;

  return {
    llm: { apiKey, baseUrl, model },
    hasRealLlm: apiKey.length > 0,
  };
}
