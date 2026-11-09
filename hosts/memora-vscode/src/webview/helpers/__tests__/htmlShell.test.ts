/**
 * htmlShell 测试 — `<html lang>` 回落语言与 ADR-042 默认语言对齐；l10n 译文注入（P1 基建）
 *
 * 锁的是 SSOT：manifest 默认语言文件是英文，HTML lang 的兜底不得另立一套中文。
 * 曾写死 `zh-CN`，两侧漂移且无任何测试会红（改常量此前是裸改）。
 * 注入面锁三件事：en 不注入 / zh-cn 注入且 type=application/json（CSP 不破）/
 * 值里的 `<` 转义（防 `</script>` 截断）且 JSON.parse 往返无损。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HTML_LANG,
  resolveHtmlLang,
  buildHtmlHead,
  buildL10nBundleScript,
} from '../htmlShell.js';
import { L10N_BUNDLE_ELEMENT_ID } from '../../../shared/constants.js';

describe('htmlShell · <html lang>', () => {
  it('缺省 / 空串回落英文（ADR-042 决策 2：默认语言 = 英文）', () => {
    expect(DEFAULT_HTML_LANG).toBe('en');
    expect(resolveHtmlLang(undefined)).toBe('en');
    expect(resolveHtmlLang('')).toBe('en');
  });

  it('环境语言可得时原样透传，不改写 locale', () => {
    expect(resolveHtmlLang('zh-cn')).toBe('zh-cn');
    expect(resolveHtmlLang('ja')).toBe('ja');
  });

  it('buildHtmlHead 把解析后的 lang 写进文档头', () => {
    const head = buildHtmlHead({
      lang: resolveHtmlLang(undefined),
      cspSource: 'vscode-resource:',
      styles: '',
    });
    expect(head).toContain('<html lang="en">');
  });
});

describe('htmlShell · l10n 译文注入（P1 基建）', () => {
  /** 头部最小参数：注入面断言与样式 / lang 无关，只带必需项 */
  const base = { lang: 'en', cspSource: 'self', styles: 'body{}' };

  it('默认语言（bundle undefined）不注入数据块', () => {
    const head = buildHtmlHead({ ...base, l10nBundle: undefined });
    expect(head).not.toContain(L10N_BUNDLE_ELEMENT_ID);
    expect(head).not.toContain('<script type="application/json"');
    expect(buildL10nBundleScript(undefined)).toBe('');
  });

  it('zh-cn（bundle 有值）注入数据块，id 与 type 两侧契约正确（CSP 不破）', () => {
    const bundle = { Save: '保存' };
    const script = buildL10nBundleScript(bundle);
    expect(script).toContain(`<script type="application/json" id="${L10N_BUNDLE_ELEMENT_ID}">`);
    // 数据块不执行 ⇒ 不受 script-src 约束；若 type 丢了会直接撞 CSP 黑屏
    expect(script.startsWith('<script type="application/json"')).toBe(true);
    expect(script.endsWith('</script>')).toBe(true);
    // 注入片段必须落在 </style> 之后、</head> 之前（读端首帧解析时译文须已就位）
    const head = buildHtmlHead({ ...base, l10nBundle: bundle });
    expect(head.indexOf(L10N_BUNDLE_ELEMENT_ID)).toBeGreaterThan(head.indexOf('</style>'));
    expect(head.indexOf(L10N_BUNDLE_ELEMENT_ID)).toBeLessThan(head.indexOf('</head>'));
  });

  it('值里的 `<` 转义为 \\u003c（防 </script> 提前截断），JSON.parse 往返无损', () => {
    const bundle = { X: '</script><script>alert(1)</script>' };
    const script = buildL10nBundleScript(bundle);
    // 数据块内部不得出现字面量闭合标签（脚本自身合法的 </script> 是唯一一处）
    expect(script.split('</script>').length - 1).toBe(1);
    expect(script).toContain('\\u003c/script>');
    const inner = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'));
    expect(JSON.parse(inner)).toEqual(bundle);
  });
});
