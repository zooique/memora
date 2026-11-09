/**
 * responseLanguage 测试 — 语言真源单点与英文兜底（HOST-I18N-LLM-1）
 *
 * 判据不重算映射：断言「有对应语言用对应语言 / 没有统一英文」，并锁住两条纪律——
 * ① 不得自建第二套语言真源（ADR-042 决策 1）；② 原型链键不得穿透成「已支持语言」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildResponseLanguageDirective,
  FALLBACK_RESPONSE_DIRECTIVE,
} from '../responseLanguage.js';

/** manifest 的 contributes.configuration 允许单对象或数组两种形态 */
interface ConfigurationGroup {
  properties?: Record<string, unknown>;
}

/** 读取宿主 manifest 的全部配置项键名 */
function manifestConfigKeys(): string[] {
  // __tests__ → host → extension → src → memora-vscode 根
  const raw = readFileSync(join(__dirname, '../../../../package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { contributes?: { configuration?: unknown } };
  const conf = pkg.contributes?.configuration;
  const groups: ConfigurationGroup[] = Array.isArray(conf)
    ? (conf as ConfigurationGroup[])
    : conf
      ? [conf as ConfigurationGroup]
      : [];
  return groups.flatMap((group) => Object.keys(group.properties ?? {}));
}

describe('buildResponseLanguageDirective · 回答语言指令', () => {
  it('两种中文变体各走自己的中文指令（zh-cn 简 / zh-tw 繁）', () => {
    expect(buildResponseLanguageDirective('zh-cn')).toContain('简体中文');
    // zh-tw 界面已是繁体中文 ⇒ 回答必须也是中文，不能落到英文（用户需求：设置中文就中文）
    expect(buildResponseLanguageDirective('zh-tw')).toContain('繁體中文');
  });

  it('无对应语言一律英文兜底（en / 未支持的 ja / 取不到）', () => {
    for (const locale of ['en', 'en-us', 'ja', 'fr', '', undefined]) {
      expect(buildResponseLanguageDirective(locale)).toBe(FALLBACK_RESPONSE_DIRECTIVE);
    }
  });

  it('大小写与首尾空格归一化，不产生静默英文回落', () => {
    expect(buildResponseLanguageDirective('  ZH-CN  ')).toContain('简体中文');
  });

  it('原型链键不得被当成已支持语言（边界前置）', () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      expect(buildResponseLanguageDirective(key)).toBe(FALLBACK_RESPONSE_DIRECTIVE);
    }
  });

  it('语言真源纪律：manifest 不得出现任何语言选择配置项（ADR-042 决策 1）', () => {
    // 判据按**语义**扫全部配置键，不锁具体键名——否则换个名字（memora.responseLanguage /
    // memora.uiLocale）就绕过去了，守卫退化成两个字符串的巧合。
    const offenders = manifestConfigKeys().filter((key) => /language|locale/i.test(key));
    expect(offenders).toEqual([]);
  });
});
