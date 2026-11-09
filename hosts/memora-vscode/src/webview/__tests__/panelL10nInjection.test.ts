/**
 * 面板注入存在性测试 · P1 判据「en 不注入 / zh-cn 注入」的**面板透传面**
 *
 * htmlShell 测试锁的是写端函数本身（序列化 / `<` 转义 / CSP type / 注入位置）；
 * 本文件锁的是「面板真把 `vscode.l10n.bundle` 传进了 buildHtmlHead」——面板忘传时
 * 写端函数照样全绿，真实运行时 en / zh-cn 都不注入且**没有任何测试会红**，
 * 故透传必须独立成判据（两个生产面板各扫一遍，不抽样）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { buildHtml as buildChatHtml } from '../panels/chatPanelHtml.js';
import { buildHtml as buildSettingsHtml } from '../panels/settingsPanelHtml.js';
import { L10N_BUNDLE_ELEMENT_ID } from '../../shared/constants.js';

/** 模拟 `vscode.l10n.bundle` 载荷：undefined = 默认语言（en），有值 = zh-cn */
const h = vi.hoisted(() => ({ bundle: undefined as Record<string, string> | undefined }));

vi.mock('vscode', async () => ({
  env: { language: 'zh-cn' },
  get l10n() {
    return {
      get bundle() {
        return h.bundle;
      },
      // Panel templates call `vscode.l10n.t` at module scope; identity keeps this test's
      // focus on bundle passthrough instead of translated text.
      t: (message: string, ...args: (string | number | boolean)[]) =>
        message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
    };
  },
}));

/** 假脚本 URI：buildHtml 只做字符串拼接，不触真实 vscode.Uri 行为 */
const fakeUri = { toString: () => 'file:///mock/view.js' } as never;

/** 两个生产面板（不抽样：各自独立透传，各自的接线各自锁） */
const panels = [
  ['chatPanel', buildChatHtml],
  ['settingsPanel', buildSettingsHtml],
] as const;

describe('面板 l10n 注入透传（P1 判据：en 不注入 / zh-cn 注入）', () => {
  it('zh-cn（bundle 有值）：两面板输出均内联数据块（共享 id + 译文可见）', () => {
    h.bundle = { Save: '保存' };
    for (const [name, build] of panels) {
      const html = build(fakeUri, 'self');
      expect(html, name).toContain(
        `<script type="application/json" id="${L10N_BUNDLE_ELEMENT_ID}"`,
      );
      expect(html, name).toContain('保存');
    }
  });

  it('en（bundle undefined）：两面板均不注入数据块', () => {
    h.bundle = undefined;
    for (const [name, build] of panels) {
      const html = build(fakeUri, 'self');
      expect(html, name).not.toContain(L10N_BUNDLE_ELEMENT_ID);
    }
  });
});
