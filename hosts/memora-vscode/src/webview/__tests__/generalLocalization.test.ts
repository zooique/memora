/**
 * 常规卡本地化文案语义守卫（node 环境：读盘与 fileURLToPath 需要真实 file scheme）
 *
 * 为什么单独成文件：`verify-nls.mjs` 只守「源码用的键在 bundle 里存在」，
 * 不守「译文语义是否串味」。`Automatic` 曾被译成「自动归档」——语言 radio 显示
 * 错位而所有机检全绿（2026-11-25 用户真机截图发现）。此守卫把两个语义域的键
 * 与译文分别钉死，并在产线骨架层确认各自消费了正确的键。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGeneralBodyHtml } from '../panels/settingsGeneralHtml.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = join(HERE, '..', '..', '..');
const readBundle = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(join(HOST_ROOT, 'l10n', name), 'utf8')) as Record<string, string>;

describe('常规卡本地化 — 自动 vs 自动归档', () => {
  it('两键两义：语言「自动」、归档「自动归档」，中文译文不串味', () => {
    const zh = readBundle('bundle.l10n.zh-cn.json');
    const en = readBundle('bundle.l10n.json');
    expect(zh['Automatic']).toBe('自动');
    expect(zh['Automatic archiving']).toBe('自动归档');
    expect(en).toHaveProperty('Automatic');
    expect(en).toHaveProperty('Automatic archiving');
  });

  it('产线常规骨架分别消费两键，防「只改译文不改调用」的假修', () => {
    const keys: string[] = [];
    buildGeneralBodyHtml({
      t: (s) => {
        keys.push(s);
        return s;
      },
    });
    expect(keys).toContain('Automatic');
    expect(keys).toContain('Automatic archiving');
  });
});
