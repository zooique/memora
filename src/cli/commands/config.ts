/**
 * config 命令
 *
 * 提供配置查看、编辑、定位
 * - show: 打印展开后的完整配置
 * - get <key>: dot path 读取某个字段（如 llm.apiKey）
 * - path: 打印实际加载的配置文件路径
 * - edit: 用 $EDITOR / $VISUAL 打开配置文件
 *
 * 详见 M-104
 */
import { spawn } from 'node:child_process';
import { loadConfig, findConfigPath } from '@/config/loader.js';
import { configError } from '@/utils/errors.js';

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
}
