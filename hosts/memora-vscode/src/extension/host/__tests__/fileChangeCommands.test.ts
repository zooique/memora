/**
 * 文件改动命令 id 守卫（真源对拍：代码常量 ↔ `package.json#contributes.commands`）
 *
 * 起因（2026-09-26 实证）：`memora.revertAllFileChanges` 曾在代码里 `registerCommand`、
 * 却在 `contributes.commands` 漏声明——webview 与状态栏都能用，唯独命令面板看不到，
 * 而**当时没有任何测试报警**（该漂移靠真机复现才发现，修法是补一行 JSON）。
 *
 * 命令 id 物理上必然存在两处（TS 常量 + package.json 的 JSON，后者无法 import），
 * 所以无法靠「单一真源」消灭，只能靠**守卫**钉死二者一致。本用例即那道守卫。
 *
 * 两个方向都要断言（缺一即半守卫）：
 *   - 对外命令（状态栏 / 对话区常驻条 / 命令面板入口）**必须**已贡献；
 *   - CodeLens 内部命令（需携带文件路径参数）**必须不**贡献——暴露到命令面板会得到
 *     无参调用而静默失败（见 `fileChangeView` 中两个 INLINE 常量的注释）。
 *
 * 无需模拟 VS Code 运行时：`fileChangeView` 模块顶层已无 `vscode.<成员>` 取值
 * （惰性化见 memora-host-ui-consistency 技能规则 6 ⑤），空 mock 即可安全 import。
 *
 * @module __tests__/fileChangeCommands.test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  REVIEW_FILE_CHANGES_COMMAND,
  CONFIRM_ALL_FILE_CHANGES_COMMAND,
  REVERT_ALL_FILE_CHANGES_COMMAND,
  CONFIRM_INLINE_COMMAND,
  RESTORE_INLINE_COMMAND,
} from '../fileChangeView.js';

/** 本文件位于 `<pkg>/src/extension/host/__tests__/` ⇒ 上溯四层即包根 */
const PACKAGE_JSON = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../package.json');

interface Contributes {
  contributes?: { commands?: { command: string }[] };
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as Contributes;
const contributed = new Set((pkg.contributes?.commands ?? []).map((entry) => entry.command));

describe('fileChangeView 命令 id ↔ package.json#contributes.commands', () => {
  it('三个对外命令均已在 package.json 贡献（命令面板可见）', () => {
    expect(contributed.has(REVIEW_FILE_CHANGES_COMMAND)).toBe(true);
    expect(contributed.has(CONFIRM_ALL_FILE_CHANGES_COMMAND)).toBe(true);
    expect(contributed.has(REVERT_ALL_FILE_CHANGES_COMMAND)).toBe(true);
  });

  it('两个 CodeLens 内部命令不贡献（需路径参数，无参调用会静默失败）', () => {
    expect(contributed.has(CONFIRM_INLINE_COMMAND)).toBe(false);
    expect(contributed.has(RESTORE_INLINE_COMMAND)).toBe(false);
  });
});
