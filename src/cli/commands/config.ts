/**
 * config 命令
 *
 * 提供配置查看、编辑、定位
 * - show: 打印展开后的完整配置
 * - get <key>: dot path 读取某个字段（如 llm.apiKey）
 * - path: 打印实际加载的配置文件路径
 * - edit: 用 $EDITOR / $VISUAL 打开配置文件
 *
 * v1.2：多 Provider 管理
 * - llm list: 列出所有已注册的 LLM Provider
 * - llm add <name>: 添加新的 LLM Provider（交互式）
 * - llm use <name>: 切换当前激活的 LLM Provider
 *
 * 详见 M-104
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig, findConfigPath } from '@/config/loader.js';
import { configError } from '@/utils/errors.js';
import { createInterface } from 'node:readline';

export interface ConfigCommandOptions {
  config?: string;
}

/**
 * 用 dot path 读取嵌套对象的字段
 * @example getByPath({a: {b: 1}}, 'a.b') === 1
 */
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

/**
 * 遮蔽敏感字段（apiKey 显示前 3 + *** + 后 3）
 */
function maskSensitive(value: unknown, key: string): string {
  if (typeof value !== 'string' || value === '') return JSON.stringify(value);
  if (/key|secret|token|password/i.test(key) && value.length > 6) {
    return JSON.stringify(`${value.slice(0, 3)}***${value.slice(-3)}`);
  }
  return JSON.stringify(value);
}

/**
 * 格式化对象为带敏感遮蔽的字符串
 */
function formatConfig(obj: Record<string, unknown>, indent = 2): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${' '.repeat(indent)}${k}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`${' '.repeat(indent + 2)}${k2}: ${maskSensitive(v2, k2)}`);
      }
    } else if (Array.isArray(v)) {
      lines.push(`${' '.repeat(indent)}${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else {
      lines.push(`${' '.repeat(indent)}${k}: ${maskSensitive(v, k)}`);
    }
  }
  return lines.join('\n');
}

/**
 * config 子命令的 action handler
 */
export async function configCommand(
  action: string,
  rest: string[],
  options: ConfigCommandOptions,
): Promise<void> {
  switch (action) {
    case 'show':
      await showConfig(options);
      return;
    case 'get': {
      const key = rest[0];
      if (!key) {
        throw configError('config get 缺少 key 参数', '用法：memora config get <key>', [
          '示例：memora config get llm.provider',
          '示例：memora config get llm.apiKey',
        ]);
      }
      await getConfigValue(key, options);
      return;
    }
    case 'path':
      await showConfigPath(options);
      return;
    case 'edit':
      await editConfig(options);
      return;
    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp();
      return;
  }
}

async function showConfig(options: ConfigCommandOptions): Promise<void> {
  const config = await loadConfig(options.config);
  console.log('当前生效配置：');
  console.log(formatConfig(config as unknown as Record<string, unknown>));
}

async function getConfigValue(key: string, options: ConfigCommandOptions): Promise<void> {
  const config = await loadConfig(options.config);
  const value = getByPath(config, key);
  if (value === undefined) {
    throw configError('配置项不存在', `找不到 "${key}"`, [
      '用 `memora config show` 查看所有字段',
      '确认 key 大小写正确',
    ]);
  }
  // 敏感字段遮蔽
  console.log(maskSensitive(value, key.split('.').pop() ?? ''));
}

async function showConfigPath(options: ConfigCommandOptions): Promise<void> {
  const path = await findConfigPath(options.config);
  if (path) {
    console.log(path);
  } else {
    console.log('（未找到配置文件，将使用内置默认值）');
    console.log('用 `memora init` 生成默认配置');
  }
}

async function editConfig(options: ConfigCommandOptions): Promise<void> {
  const path = await findConfigPath(options.config);
  if (!path) {
    throw configError('未找到可编辑的配置文件', '当前没有 .memora/config.json', [
      '先用 `memora init` 生成项目级配置',
      '或在 ~/.memora/ 下创建用户级 config.json',
    ]);
  }

  // 用 EDITOR / VISUAL 打开
  const editor = process.env['VISUAL'] ?? process.env['EDITOR'];
  if (!editor) {
    throw configError('未配置编辑器', '找不到 EDITOR 或 VISUAL 环境变量', [
      'PowerShell：$env:EDITOR = "code"  (VS Code) 或 "notepad"',
      'Bash：export EDITOR=vim',
      '编辑后保存即可，下次启动自动加载新配置',
    ]);
  }

  console.log(`📝 用 ${editor} 打开 ${path} ...`);
  const child = spawn(editor, [path], { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`编辑器退出码：${code}`));
    });
    child.on('error', reject);
  });
}

function printHelp(): void {
  console.log('config 命令：');
  console.log('  show                显示当前生效配置（敏感字段已遮蔽）');
  console.log('  get <key>           读取某个字段，如 llm.apiKey');
  console.log('  path                打印实际加载的配置文件路径');
  console.log('  edit                用 $EDITOR / $VISUAL 打开配置文件');
  console.log('  llm list            列出所有已注册的 LLM Provider');
  console.log('  llm add <name>      添加新的 LLM Provider（交互式）');
  console.log('  llm use <name>      切换当前激活的 LLM Provider');
}

// ─── v1.2：多 Provider 管理 ────────────────────────────────

/**
 * config llm 子命令的 action handler
 *
 * 管理多个 LLM Provider 的注册、列出和切换。
 * 操作的是配置文件（真理源），修改后下次启动自动生效。
 */
export async function configLlmCommand(
  action: string,
  args: string[],
  options: ConfigCommandOptions,
): Promise<void> {
  switch (action) {
    case 'list':
      await listLlmProviders(options);
      return;
    case 'add': {
      const name = args[0];
      if (!name) {
        throw configError('config llm add 缺少 name 参数', '用法：memora config llm add <name>', [
          '示例：memora config llm add openai',
          '示例：memora config llm add local-model',
        ]);
      }
      await addLlmProvider(name, options);
      return;
    }
    case 'use': {
      const name = args[0];
      if (!name) {
        throw configError('config llm use 缺少 name 参数', '用法：memora config llm use <name>', [
          '示例：memora config llm use openai',
          '先用 memora config llm list 查看可用 Provider',
        ]);
      }
      await useLlmProvider(name, options);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
    default:
      printLlmHelp();
      return;
  }
}

/**
 * 列出所有已注册的 LLM Provider
 */
async function listLlmProviders(options: ConfigCommandOptions): Promise<void> {
  const config = await loadConfig(options.config);

  if (!config.llm.providers || Object.keys(config.llm.providers).length === 0) {
    // 旧格式：单 Provider
    console.log('当前使用单 Provider 模式（旧格式）：');
    console.log(`  名称: ${config.llm.provider}`);
    console.log(`  模型: ${config.llm.model}`);
    console.log(`  Base URL: ${config.llm.baseUrl ?? '(预设默认值)'}`);
    console.log();
    console.log('升级到多 Provider 格式：memora config llm add <name>');
    return;
  }

  const active = config.llm.active ?? Object.keys(config.llm.providers)[0]!;
  console.log('已注册的 LLM Provider：');
  console.log('─'.repeat(50));
  for (const [name, p] of Object.entries(config.llm.providers)) {
    const marker = name === active ? ' *' : '  ';
    console.log(`${marker} ${name}`);
    console.log(`    类型: ${p.provider}`);
    console.log(`    模型: ${p.model}`);
    console.log(`    Base URL: ${p.baseUrl ?? '(预设默认值)'}`);
    console.log(`    API Key: ${p.apiKey ? '已配置' : '(未配置)'}`);
    console.log();
  }
  console.log('─'.repeat(50));
  console.log('* 当前激活的 Provider');
  console.log('切换：memora config llm use <name>');
}

/**
 * 交互式添加新的 LLM Provider
 *
 * 通过交互式问答收集 Provider 配置，写入配置文件。
 * 支持预设 provider（deepseek/doubao/openai）和自定义 provider。
 */
async function addLlmProvider(name: string, options: ConfigCommandOptions): Promise<void> {
  const configPath = await findConfigPath(options.config);
  if (!configPath) {
    throw configError('未找到配置文件', '需要先有配置文件才能添加 Provider', [
      '先用 `memora init` 生成项目级配置',
      '或在 ~/.memora/ 下创建用户级 config.json',
    ]);
  }

  // 读取当前配置
  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;

  // 检查是否已存在同名 Provider
  const providers = (config.llm as Record<string, unknown> | undefined)?.['providers'] as
    | Record<string, unknown>
    | undefined;
  if (providers && name in providers) {
    throw configError('Provider 已存在', `"${name}" 已注册，请使用其他名称`, [
      '使用 memora config llm use <name> 切换到此 Provider',
      '使用 memora config llm list 查看可用 Provider',
    ]);
  }

  // 交互式收集 Provider 配置
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  console.log(`\n添加新的 LLM Provider：「${name}」`);
  console.log('预设：deepseek / doubao / openai / 自定义\n');

  const providerType = await ask('Provider 类型（deepseek/doubao/openai/自定义）[deepseek]: ');
  const provider = providerType.trim() || 'deepseek';

  let model: string;
  let baseUrl: string | undefined;
  let apiKey: string;

  // 预设默认值
  const presets: Record<string, { model: string; baseUrl: string }> = {
    deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    doubao: { model: 'doubao-pro-32k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  };

  if (presets[provider]) {
    const preset = presets[provider]!;
    model = await ask(`模型名称 [${preset.model}]: `);
    model = model.trim() || preset.model;

    const customBaseUrl = await ask(`Base URL [${preset.baseUrl}]: `);
    baseUrl = customBaseUrl.trim() || undefined;

    apiKey = await ask('API Key (支持 ${ENV_VAR} 占位符): ');
    apiKey = apiKey.trim();
  } else {
    // 自定义 Provider
    model = await ask('模型名称: ');
    model = model.trim();
    if (!model) {
      rl.close();
      throw configError('模型名称不能为空', '自定义 Provider 必须指定 model', [
        '示例：gpt-4o-mini / claude-3.5-sonnet / llama-3-70b',
      ]);
    }

    baseUrl = await ask('Base URL: ');
    baseUrl = baseUrl.trim() || undefined;
    if (!baseUrl) {
      rl.close();
      throw configError('Base URL 不能为空', '自定义 Provider 必须指定 baseUrl', [
        '示例：https://api.openai.com/v1',
        '示例：https://your-llm-proxy.com/v1',
      ]);
    }

    apiKey = await ask('API Key (支持 ${ENV_VAR} 占位符): ');
    apiKey = apiKey.trim();
  }

  rl.close();

  if (!apiKey) {
    throw configError('API Key 不能为空', '必须配置 API Key 或环境变量占位符', [
      '直接填写 Key：sk-xxx...',
      '使用环境变量：${DEEPSEEK_API_KEY}',
    ]);
  }

  // 构建 Provider 配置条目
  const newProvider: Record<string, string> = {
    provider,
    model,
  };
  if (baseUrl) newProvider['baseUrl'] = baseUrl;
  newProvider['apiKey'] = apiKey;

  // 写入配置文件
  const llm = (config.llm ?? {}) as Record<string, unknown>;
  const existingProviders = (llm['providers'] ?? {}) as Record<string, unknown>;
  existingProviders[name] = newProvider;
  llm['providers'] = existingProviders;

  // 如果这是第一个 Provider，自动设为 active
  if (!llm['active']) {
    llm['active'] = name;
  }

  config.llm = llm;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(`\n已添加 Provider：「${name}」`);
  console.log(`  类型: ${provider}`);
  console.log(`  模型: ${model}`);
  if (baseUrl) console.log(`  Base URL: ${baseUrl}`);
  console.log(`  API Key: ${apiKey.startsWith('${') ? apiKey : apiKey.slice(0, 3) + '***'}`);
  if (llm['active'] === name) {
    console.log(`  状态: 已激活（当前唯一 Provider）`);
  }
  console.log(`\n配置文件已更新：${configPath}`);
  console.log('重启后生效。或使用 `memora config llm use ${name}` 切换');
}

/**
 * 切换当前激活的 LLM Provider
 *
 * 修改配置文件中的 llm.active 字段。
 * 下次启动时自动生效。
 */
async function useLlmProvider(name: string, options: ConfigCommandOptions): Promise<void> {
  const configPath = await findConfigPath(options.config);
  if (!configPath) {
    throw configError('未找到配置文件', '需要先有配置文件才能切换 Provider', [
      '先用 `memora init` 生成项目级配置',
      '或在 ~/.memora/ 下创建用户级 config.json',
    ]);
  }

  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;

  // 检查 Provider 是否存在
  const llm = (config.llm ?? {}) as Record<string, unknown>;
  const providers = (llm['providers'] ?? {}) as Record<string, unknown>;
  if (!providers || !(name in providers)) {
    const available = providers ? Object.keys(providers).join(', ') : '(无)';
    throw configError('Provider 不存在', `"${name}" 不在 providers 映射表中`, [
      `可用的 Provider：${available || '(无)'}`,
      '使用 memora config llm list 查看可用 Provider',
      '使用 memora config llm add <name> 添加新 Provider',
    ]);
  }

  // 更新 active
  llm['active'] = name;
  config.llm = llm;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  const providerConfig = providers[name] as Record<string, string>;
  console.log(`已切换到 Provider：「${name}」`);
  console.log(`  类型: ${providerConfig['provider']}`);
  console.log(`  模型: ${providerConfig['model']}`);
  console.log(`\n配置文件已更新：${configPath}`);
  console.log('重启后生效。');
}

function printLlmHelp(): void {
  console.log('config llm 命令：');
  console.log('  list                列出所有已注册的 LLM Provider');
  console.log('  add <name>          交互式添加新的 LLM Provider');
  console.log('  use <name>          切换当前激活的 LLM Provider');
}
