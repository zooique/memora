/**
 * 数据目录字面量守卫 —— `'.memora'` 只允许出现在 `projectDataDir.ts` 单点文件
 *
 * ## 为什么需要这条测试
 * HOST-DATA-DIR-1 的伤是「memoryStorage 注释自称唯一计算点、判据却只绑了记忆库一条路径」——
 * 声明在、机器不拦，第四处拷贝照样能写出来。本测试就是那句声明的判据：
 * 宿主生产代码里出现第二份 `'.memora'` 字符串字面量 ⇒ 当场红。
 *
 * ## 扫描口径
 * - 范围：`src/**`（排除 `__tests__`）+ `scripts/**` 的 .ts/.mts —— 即宿主全部生产拼接面；
 *   测试夹具里的字面量是**锚定断言的期望值**（如 crossHostLayout 的 `.memora` 锚），故意不扫。
 * - 匹配：TypeScript AST 的字符串字面量节点——**注释里的同款文字不是节点，天然不误报**
 *   （这正是用 AST 而非正则的原因）。
 * - 跨包的 `hosts/memora-mcp` 无法共模块，由 `crossHostLayout.test.ts` 守两侧一致，不在本扫描内。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** 本文件位于 `hosts/memora-vscode/src/__tests__`，上跳两级即包根 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 单点文件（相对包根）——全仓唯一允许出现 `.memora` 字面量的生产文件 */
const SINGLE_POINT = join('src', 'extension', 'host', 'projectDataDir.ts');
/** src 目录（测试目录在收集时跳过） */
const SRC_DIR = join(PKG_ROOT, 'src');
/** 验证脚本目录（同样拼 dataDir，属生产拼接面） */
const SCRIPTS_DIR = join(PKG_ROOT, 'scripts');

/**
 * 递归收集待扫源文件（.ts / .mts），跳过 `__tests__` 目录
 *
 * @param dir 起始目录
 * @returns 源文件绝对路径列表
 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // 测试目录里的字面量是锚定断言的期望值，不是拼接行为
      if (entry.name === '__tests__') continue;
      out.push(...collectSourceFiles(join(dir, entry.name)));
    } else if (/\.(ts|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * 用 TS AST 找出值为 `.memora` 的字符串字面量及其行号
 *
 * @param file 源文件绝对路径
 * @returns 命中行号列表（1 起）
 */
function findDirNameLiterals(file: string): number[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    // 普通字符串与无插值模板串都算；注释不产生字面量节点 ⇒ 不误报
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === '.memora'
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe('数据目录字面量守卫（单点 = projectDataDir.ts）', () => {
  it('生产代码里的 .memora 字符串字面量只允许出现在单点文件', () => {
    // 越界清单：每项 = `<相对路径>:<行>`；为空即全绿
    const violations: string[] = [];
    for (const file of [...collectSourceFiles(SRC_DIR), ...collectSourceFiles(SCRIPTS_DIR)]) {
      const relPath = relative(PKG_ROOT, file).replaceAll('\\', '/');
      if (relPath === SINGLE_POINT.replaceAll('\\', '/')) continue;
      for (const line of findDirNameLiterals(file)) {
        violations.push(`${relPath}:${line}`);
      }
    }
    expect(
      violations,
      `发现单点之外的 .memora 字面量拼接（${violations.length} 处）——` +
        `目录名一律经 resolveProjectDataDir 取，勿写第二份拷贝：\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});
