/**
 * 对话文字三档 — 首帧 HTML 注入判据（CHAT-TEXT-SCALE-1）
 *
 * 独立 node 环境：buildHtml 顶层解构 vscode 导出（jsdom 下 mock 命名空间代理会 throw）。
 * 首帧属性必须与脚本热更同源——normal 不写属性（与既往逐字等价），
 * 非 normal 写 data-text-scale，脚本未加载即正确、不闪常规档。
 *
 * 变异验证：把「normal 不写属性」改成恒写 / 把属性名改错 ⇒ 本文用例真红。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { buildHtml } from '../panels/chatPanelHtml.js';
import { buildChatHtml } from '../panels/chatHtmlFrame.js';

const scaleState = vi.hoisted(() => ({ value: 'normal' as string }));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'chatTextScale' ? scaleState.value : undefined),
    }),
  },
}));

const fakeUri = { toString: () => 'file:///mock/view.js' } as never;
const csp = 'vscode-resource:';

describe('首帧 data-text-scale 注入', () => {
  it('normal 不写属性（与既往 HTML 逐字等价）', () => {
    const html = buildHtml(fakeUri, csp, 'self', 'normal');
    // 只验 body 起始标签：token 的 JSDoc 注释会被注入 <style>，全文匹配会假命中说明文字
    expect(html).toMatch(/<body data-form="self">/);
    expect(html).not.toMatch(/<body[^>]*data-text-scale/);
  });

  it('small / large 写属性，形态属性不受影响', () => {
    expect(buildHtml(fakeUri, csp, 'assistant', 'small')).toContain(
      '<body data-form="assistant" data-text-scale="small">',
    );
    expect(buildHtml(fakeUri, csp, 'self', 'large')).toContain(
      '<body data-form="self" data-text-scale="large">',
    );
  });

  it('缺省参数 = normal（既有调用不传参也不写属性）', () => {
    expect(buildHtml(fakeUri, csp, 'self')).not.toMatch(/<body[^>]*data-text-scale/);
  });
});

describe('面板 wrapper：读配置 → 传骨架（两入口同源）', () => {
  it('配置 large 时 wrapper 写 large 属性，normal 时不写', () => {
    scaleState.value = 'large';
    expect(buildChatHtml(fakeUri, csp, 'assistant')).toMatch(
      /<body data-form="assistant" data-text-scale="large">/,
    );
    scaleState.value = 'normal';
    expect(buildChatHtml(fakeUri, csp, 'self')).not.toMatch(/<body[^>]*data-text-scale/);
  });

  it('配置非法值回退 normal（wrapper 与消息面共用同一归一化）', () => {
    scaleState.value = 'huge';
    expect(buildChatHtml(fakeUri, csp, 'self')).not.toMatch(/<body[^>]*data-text-scale/);
  });
});
