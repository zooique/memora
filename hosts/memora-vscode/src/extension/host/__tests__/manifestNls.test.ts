/**
 * `manifestNls.ts` 单元测试（纯 node，无 vscode mock）
 *
 * 判据核心 = 与 VS Code 对 manifest `%key%` 的**文件选择规则同构**：
 * `package.nls.<locale>.json` 精确匹配 → 无文件 / 无键 / JSON 坏 → `package.nls.json` 默认兜底。
 * 尤其 zh-tw：VS Code 不假设 zh-tw 回落 zh-cn（ADR-042 边界），helper 必须同构——
 * 没有 `package.nls.zh-tw.json` 时解析出**英文**标题，与菜单显示恒一致。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { resolveCommandTitle, resolveNlsValue } from '../manifestNls.js';

let dir = '';
beforeEach(() => {
  dir = makeTempDir('memora-manifestnls-');
});

function writeNls(name: string, body: Record<string, string>): void {
  writeFileSync(join(dir, name), JSON.stringify(body), 'utf8');
}

describe('resolveNlsValue', () => {
  it('locale 文件精确命中', () => {
    writeNls('package.nls.json', { 'k.a': 'A default' });
    writeNls('package.nls.zh-cn.json', { 'k.a': '甲默认' });
    expect(resolveNlsValue(dir, 'zh-cn', 'k.a')).toBe('甲默认');
  });

  it('locale 文件缺该键 → 默认文件兜底', () => {
    writeNls('package.nls.json', { 'k.a': 'A default' });
    writeNls('package.nls.zh-cn.json', { 'k.other': 'other' });
    expect(resolveNlsValue(dir, 'zh-cn', 'k.a')).toBe('A default');
  });

  it('locale undefined / 空 → 直接默认文件', () => {
    writeNls('package.nls.json', { 'k.a': 'A default' });
    expect(resolveNlsValue(dir, undefined, 'k.a')).toBe('A default');
    expect(resolveNlsValue(dir, '', 'k.a')).toBe('A default');
  });

  it('zh-tw 无独立文件 → 英文兜底（与 VS Code 不回落行为同构，ADR-042 边界）', () => {
    writeNls('package.nls.json', { 'k.a': 'A default' });
    writeNls('package.nls.zh-cn.json', { 'k.a': '甲默认' });
    expect(resolveNlsValue(dir, 'zh-tw', 'k.a')).toBe('A default');
  });

  it('两份文件都缺键 → fail-visible 返回键名本身（不静默给空串）', () => {
    writeNls('package.nls.json', {});
    expect(resolveNlsValue(dir, 'zh-cn', 'k.missing')).toBe('k.missing');
  });

  it('locale 文件 JSON 坏 / 缺失 → 回落默认文件，不抛错', () => {
    writeNls('package.nls.json', { 'k.a': 'A default' });
    writeFileSync(join(dir, 'package.nls.zh-cn.json'), '{broken', 'utf8');
    expect(resolveNlsValue(dir, 'zh-cn', 'k.a')).toBe('A default');
    expect(resolveNlsValue(dir, 'ja', 'k.a')).toBe('A default');
  });
});

describe('resolveCommandTitle', () => {
  it('按命令短名映射到契约键（ADR-042 决策 3）', () => {
    writeNls('package.nls.json', {
      'command.addToChat.title': 'Memora: Add to Chat',
      'command.registerWork.title': 'Memora: Register Work Projection',
      'command.toggleResidentRule.title': 'Memora: Toggle Project Rule',
    });
    writeNls('package.nls.zh-cn.json', {
      'command.addToChat.title': 'Memora: 添加到对话',
      'command.registerWork.title': 'Memora: 登记作品投影',
      'command.toggleResidentRule.title': 'Memora: 切换项目规则',
    });
    expect(resolveCommandTitle(dir, 'zh-cn', 'addToChat')).toBe('Memora: 添加到对话');
    expect(resolveCommandTitle(dir, 'zh-cn', 'registerWork')).toBe('Memora: 登记作品投影');
    expect(resolveCommandTitle(dir, 'zh-cn', 'toggleResidentRule')).toBe('Memora: 切换项目规则');
    expect(resolveCommandTitle(dir, 'en', 'addToChat')).toBe('Memora: Add to Chat');
  });
});
