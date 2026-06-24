/**
 * QC-R1-02 CLI_CONFIG_KEYS 同步校验脚本
 *
 * 校验 src/index.ts 中的 CLI_CONFIG_KEYS 是否为 SpriteConfigKey 的合法子集。
 * 如果 SpriteConfig 新增字段但 CLI_CONFIG_KEYS 未同步（或多出已删除的字段），此脚本会报错。
 *
 * 集成方式：在 package.json 的 lint 脚本中通过 check-configs 调用
 *   "check-cli-keys": "npx tsx scripts/check-cli-config-keys.ts"
 *
 * 用法：npx tsx scripts/check-cli-config-keys.ts
 * 退出码：0 = 一致，1 = 不一致
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── 配置 ─────────────────────────────────────────────────
/** SpriteConfig 定义文件（真理源） */
const SPRITE_CONFIG_PATH = resolve(import.meta.dirname, '../src/sprite/spriteConfig.ts');
/** cli.ts 文件（包含 CLI_CONFIG_KEYS） */
const CLI_PATH = resolve(import.meta.dirname, '../src/cli.ts');

// ─── 解析工具 ─────────────────────────────────────────────

/**
 * 从 SpriteConfig 接口中提取所有字段名
 *
 * 匹配模式：`fieldName?: type` 或 `fieldName: type`（忽略注释和空行）
 * 支持嵌套对象类型（如 `floatIconPosition?: { x: number; y: number }`）
 *
 * @param source 源码字符串
 * @returns 字段名集合
 */
function extractSpriteConfigFields(source: string): Set<string> {
  const fields = new Set<string>();
  // 找到 interface SpriteConfig 块的起始位置
  const interfaceStart = source.indexOf('export interface SpriteConfig {');
  if (interfaceStart === -1) {
    console.error('[check-cli-config-keys] 错误：未找到 interface SpriteConfig 定义');
    process.exit(1);
  }
  // 从 { 开始，匹配到对应的 }（考虑嵌套大括号）
  const braceStart = source.indexOf('{', interfaceStart);
  if (braceStart === -1) {
    console.error('[check-cli-config-keys] 错误：SpriteConfig 接口未找到起始大括号');
    process.exit(1);
  }
  let depth = 0;
  let blockEnd = -1;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        blockEnd = i;
        break;
      }
    }
  }
  if (blockEnd === -1) {
    console.error('[check-cli-config-keys] 错误：SpriteConfig 接口大括号未闭合');
    process.exit(1);
  }
  const block = source.slice(braceStart + 1, blockEnd);
  // 匹配字段名（支持可选字段 ?: 和必填字段 :）
  // 格式：缩进 + 可选注释 + 字段名 + 可选 ? + : + 类型
  const fieldRegex = /^\s*(?:\/\*\*[\s\S]*?\*\/\s*)?(\w+)\??\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(block)) !== null) {
    const fieldName = match[1];
    // 跳过 TypeScript 关键字
    if (fieldName === 'type' || fieldName === 'interface') continue;
    fields.add(fieldName);
  }
  return fields;
}

/**
 * 从 index.ts 中提取 CLI_CONFIG_KEYS 集合的内容
 *
 * 匹配模式：'fieldName' 或 "fieldName"（在 CLI_CONFIG_KEYS 块内）
 *
 * @param source 源码字符串
 * @returns CLI_CONFIG_KEYS 中的字段名集合
 */
function extractCliConfigKeys(source: string): Set<string> {
  const keys = new Set<string>();
  // 找到 CLI_CONFIG_KEYS 定义块
  const startIdx = source.indexOf('const CLI_CONFIG_KEYS');
  if (startIdx === -1) {
    console.error('[check-cli-config-keys] 错误：未找到 CLI_CONFIG_KEYS 定义');
    process.exit(1);
  }
  // 找到对应的 Set 结束位置（第一个 ）
  const blockStart = source.indexOf('new Set([', startIdx);
  if (blockStart === -1) {
    console.error('[check-cli-config-keys] 错误：CLI_CONFIG_KEYS 不是 Set 定义');
    process.exit(1);
  }
  const blockEnd = source.indexOf(']);', blockStart);
  if (blockEnd === -1) {
    console.error('[check-cli-config-keys] 错误：CLI_CONFIG_KEYS 块未正确闭合');
    process.exit(1);
  }
  const block = source.slice(blockStart, blockEnd);
  // 提取所有字符串字面量
  const keyRegex = /['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(block)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

// ─── 主逻辑 ───────────────────────────────────────────────

function main(): void {
  console.log('[check-cli-config-keys] 开始校验 CLI_CONFIG_KEYS 同步...');
  const configSource = readFileSync(SPRITE_CONFIG_PATH, 'utf-8');
  const indexSource = readFileSync(CLI_PATH, 'utf-8');

  const spriteConfigFields = extractSpriteConfigFields(configSource);
  const cliConfigKeys = extractCliConfigKeys(indexSource);

  if (spriteConfigFields.size === 0) {
    console.error('[check-cli-config-keys] 错误：未能从 spriteConfig.ts 提取任何字段');
    process.exit(1);
  }
  if (cliConfigKeys.size === 0) {
    console.error('[check-cli-config-keys] 错误：未能从 index.ts 提取 CLI_CONFIG_KEYS');
    process.exit(1);
  }

  let hasErrors = false;

  // 检查 1：CLI_CONFIG_KEYS 中的每个键必须是 SpriteConfig 的合法字段
  for (const key of cliConfigKeys) {
    if (!spriteConfigFields.has(key)) {
      console.error(
        `[check-cli-config-keys] 无效键：CLI_CONFIG_KEYS 包含 '${key}'，但 SpriteConfig 中不存在此字段`,
      );
      hasErrors = true;
    }
  }

  // 检查 2：列出 SpriteConfig 中存在但未加入 CLI_CONFIG_KEYS 的字段（仅提示，不报错）
  const missingKeys: string[] = [];
  for (const field of spriteConfigFields) {
    if (!cliConfigKeys.has(field)) {
      missingKeys.push(field);
    }
  }
  if (missingKeys.length > 0) {
    console.log(
      `[check-cli-config-keys] 提示：以下 SpriteConfig 字段未加入 CLI_CONFIG_KEYS（可能是故意排除）：`,
    );
    for (const key of missingKeys) {
      console.log(`  - ${key}`);
    }
  }

  if (hasErrors) {
    console.error('\n[check-cli-config-keys] 校验失败！请同步 CLI_CONFIG_KEYS 与 SpriteConfig 字段。');
    process.exit(1);
  }

  console.log(
    `[check-cli-config-keys] 校验通过：CLI_CONFIG_KEYS（${cliConfigKeys.size} 项）均为 SpriteConfig 合法字段。`,
  );
}

main();
