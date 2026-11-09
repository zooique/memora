/**
 * webviewL10n 测试 — P1 基建读端（宿主注入译文的消费契约）
 *
 * 锁三件事：① 未注入（默认语言）时 `l10n.t` 返回原文——「P1 零可见变化」的机检面；
 * ② 注入后按元素 id 装配、译文生效（含 `{0}` 占位）；③ 注入块损坏不抛错（入口抛错
 * 会带塌整个面板，降级只应表现为回落原文）。
 *
 * 全局状态注意：`@vscode/l10n` 的 config 是进程级单例且**整体替换**（config 不合并），
 * 故用例按「未配置 → 损坏 → 有效」声明序执行，乱序会产生假红；vitest 按文件隔离
 * 模块注册表，跨文件不互染。
 */
import { describe, it, expect } from 'vitest';
import * as l10n from '@vscode/l10n';
import { initWebviewL10n } from '../webviewL10n.js';
import { L10N_BUNDLE_ELEMENT_ID } from '../../../shared/constants.js';

/** 假 document：只实现 getElementById，并记录请求的 id（验证读端用共享契约键） */
function fakeDoc(text: string | null): {
  doc: { getElementById(id: string): { textContent: string | null } | null };
  askedId: string[];
} {
  const askedId: string[] = []; // 读端实际请求的元素 id（与写端对账）
  return {
    askedId,
    doc: {
      getElementById(id: string) {
        askedId.push(id);
        return text === null ? null : { textContent: text };
      },
    },
  };
}

describe('webviewL10n · initWebviewL10n', () => {
  it('未注入（元素不存在）不 config，l10n.t 返回原文', () => {
    const { doc } = fakeDoc(null);
    initWebviewL10n(doc);
    expect(l10n.t('Hello {0}', 'world')).toBe('Hello world');
  });

  it('注入块 JSON 损坏时不抛错、不 config（保持原文）', () => {
    const { doc, askedId } = fakeDoc('{broken json');
    expect(() => initWebviewL10n(doc)).not.toThrow();
    expect(askedId).toEqual([L10N_BUNDLE_ELEMENT_ID]); // 按共享契约键取元素
    expect(l10n.t('Hello {0}', 'world')).toBe('Hello world');
  });

  it('有效注入：按共享契约键取元素并装配，l10n.t 返回译文（含占位替换）', () => {
    const bundle = { Hello: '你好 {0}' };
    const { doc, askedId } = fakeDoc(JSON.stringify(bundle));
    initWebviewL10n(doc);
    expect(askedId).toEqual([L10N_BUNDLE_ELEMENT_ID]);
    expect(l10n.t('Hello', '世界')).toBe('你好 世界');
    expect(l10n.t('未登记键')).toBe('未登记键'); // 键不在译文表 ⇒ 原文回落，与宿主侧同语义
  });
});
