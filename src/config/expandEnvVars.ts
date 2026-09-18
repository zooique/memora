/**
 * 环境变量展开工具
 *
 * 展开配置文件中 ${ENV_VAR} 占位符为实际环境变量值。
 * 覆盖范围：llm.providers 映射表。
 *
 * 保持职责单一（从 loader.ts 提取）。
 */
import type { Config } from '@/config/loader.js';
import type { ProviderEntryConfig } from '@/llm/types.js';

/**
 * 展开 ${ENV_VAR} 占位符
 *
 * 配置文件可写 "apiKey": "${MEMORA_API_KEY}"，
 * 实际读取时展开为环境变量值。
 *
 * 展开范围覆盖所有可能包含敏感信息的通道：llm.providers（多 Provider 映射表）的 apiKey / baseUrl。
 *
 * @param config 原始配置（可能含 ${ENV_VAR} 占位符）
 * @returns 展开后的配置（占位符替换为环境变量值）
 */
export function expandEnvVars(config: Config): Config {
  const expand = (val: string | undefined): string | undefined => {
    if (!val) return val;
    return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
  };

  // 展开 providers 映射表中的环境变量
  const expandedProviders: Record<string, ProviderEntryConfig> | undefined = config.llm.providers
    ? Object.fromEntries(
        Object.entries(config.llm.providers).map(([key, p]) => [
          key,
          { ...p, apiKey: expand(p.apiKey), baseUrl: expand(p.baseUrl), model: expand(p.model) ?? p.model },
        ]),
      )
    : undefined;

  return {
    ...config,
    llm: {
      ...config.llm,
      providers: expandedProviders,
    },
  };
}