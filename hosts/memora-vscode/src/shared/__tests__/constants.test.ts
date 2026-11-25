import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IRREVERSIBLE_ACTION_WORDS } from '../constants.js';

/**
 * 词表人工镜像守卫（2026-11-25 拍板）
 *
 * `IRREVERSIBLE_ACTION_WORDS` 的消费面（全集以 `grep -rn IRREVERSIBLE_ACTION_WORDS
 * hosts/memora-vscode/src` 为准，不写死面数——新增超时闸时曾漏补本声明）：
 *   - 代答工具描述（代码，import 常量，断言在 workSessionTools.test.ts）
 *   - 唤醒种子（代码，import 常量，断言在 hostedSessionNotice.test.ts）
 *   - ask 超时闸 `extension/host/askCoordinator.ts`（代码，import 常量，布尔判定不产文本）
 *   - `role-packs/memora宝/rules.md`（markdown，**无法 import**，只能人工镜像）
 *
 * 三个代码消费面各自 import 常量、改词表自动跟随；唯 markdown 面没有编译链能守，
 * 于是落到这里：词表改了而规则文本没跟上 ⇒ 本用例转红。
 * 这是把「人工同步」变成可机检的唯一低成本手段。
 *
 * 依赖仓库结构（读仓库根的 role-packs/）；测试只在源码仓库跑，不进打包产物。
 */
describe('IRREVERSIBLE_ACTION_WORDS 的人工镜像守卫', () => {
  it('宝 rules.md 的不可逆清单与共享词表逐项一致', () => {
    // __dirname = hosts/memora-vscode/src/shared/__tests__ ⇒ 上 5 级到仓库根
    const rulesPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'role-packs',
      'memora宝',
      'rules.md',
    );
    const text = readFileSync(rulesPath, 'utf-8');

    // 逐项断言：漏一个词就红（不比对整句——句式为人工镜像完全自由）
    for (const word of IRREVERSIBLE_ACTION_WORDS) {
      expect(text).toContain(word);
    }
  });
});
