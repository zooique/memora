/**
 * 技能格式校验回归测试（校验从写盘器退役后迁来的判据）
 *
 * 被测不变量：`validateSkillAsset` **只做校验、不落盘**——
 *   1. description 缺失 / 含换行 / 正文为空 ⇒ 给出可读拒绝原因；
 *   2. 名字含路径分隔符或 `..` ⇒ 拒绝（复用 `sanitizeAssetName` 的单一判据）；
 *   3. 合法输入 ⇒ null（通过）。
 *
 * 为什么仍要这组用例：写盘函数已退役（对话路径走内核 `write_file`），但这些格式判据
 * 仍被压缩包导入复用；判据跟着写盘器一起消失，等于把校验也删了。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// 宿主文案已本地化：`{0}` 插值照做，断言用英文源键比对（同 providerStore.test 口径）
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: (string | number)[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
  },
}));

import { validateSkillAsset } from '../userAssets/validateSkill.js';

describe('validateSkillAsset（只校验、不落盘）', () => {
  it('description 缺失 ⇒ 拒绝并说明「不会进入模型可见清单」', () => {
    const reason = validateSkillAsset({ name: 'demo', description: '   ', content: '# Demo' });
    expect(reason).toContain('description');
  });

  it('description 含换行 ⇒ 拒绝（会提前闭合 frontmatter）', () => {
    expect(
      validateSkillAsset({ name: 'demo', description: '第一行\n第二行', content: '# Demo' }),
    ).toContain('line breaks');
  });

  it('正文为空 ⇒ 拒绝（空技能对模型无用）', () => {
    const reason = validateSkillAsset({ name: 'demo', description: '说明', content: '  \n  ' });
    expect(reason).toContain('skill body cannot be empty');
  });

  it('名字含路径分隔符 ⇒ 拒绝（复用名字净化单点）', () => {
    expect(
      validateSkillAsset({ name: 'a/b', description: '说明', content: '# Demo' }),
    ).not.toBeNull();
  });

  it('合法输入 ⇒ null（通过）', () => {
    expect(
      validateSkillAsset({
        name: '资料整理',
        description: '整理资料',
        content: '# 资料整理\n正文',
      }),
    ).toBeNull();
  });
});
