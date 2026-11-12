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
 * 展开范围覆盖所有可能包含敏感信息的通道：llm.providers（多 Provider 映射表）的 apiKey / baseUrl / model。
 *
 * 变量未设置时**保留 `${NAME}` 原样**，既不置空串也不抛 configError：
 *   - 不抛错：一个占位符没设就让整份配置加载失败，属行为回退
 *     （用 A 家 provider 却留着 B 家 key 的占位符，是常见配置）。
 *   - 不置空串：空串不报错且 `??` 兜不住（只认 null/undefined），
 *     失败推迟到运行期，还看不出是哪个变量没设。
 *   - 代价：apiKey 会带着字面量 `${NAME}` 发出（401），baseUrl 会让 `new URL()` 抛错，
 *     即失败可见，但位置在运行期。
 */
export function expandEnvVars(config: Config): Config {
  /**
   * 展开单个字符串中的 ${NAME} 占位符；只替换「变量已设」的，未设的整段原样返回。
   *
   * 重载声明表达真实契约：string 进 string 出（`model` 是必填 string，无需再写 `?? p.model` 兜底），
   * undefined 原样返回，调用方不会拿到意料外的 undefined。
   */
  function expand(val: string): string;
  function expand(val: undefined): undefined;
  function expand(val: string | undefined): string | undefined;
  function expand(val: string | undefined): string | undefined {
    if (!val) return val;
    // match 即匹配到的整段文本（如 `${NAME}`），变量未设时用它顶替
    return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name) => process.env[name] ?? match);
  }

  const expandedProviders: Record<string, ProviderEntryConfig> | undefined = config.llm.providers
    ? Object.fromEntries(
        Object.entries(config.llm.providers).map(([key, p]) => [
          key,
          {
            ...p,
            apiKey: expand(p.apiKey),
            baseUrl: expand(p.baseUrl),
            model: expand(p.model),
          },
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
