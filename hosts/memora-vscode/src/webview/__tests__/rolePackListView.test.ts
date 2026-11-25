/**
 * 角色列表投影 · 工种闸（三处选择面中的两面：设置页 roles_loaded / 聊天页 chat_role_packs）
 *
 * 判据：`kind: 'assistant'` 的助手包在盘上真实存在，但**绝不进任何工作会话选择面**。
 * 第三面（主控 `list_role_packs`）走真实装配验收，见
 * `extension/host/__tests__/workSessionTools.test.ts` 的同名用例。
 *
 * 为什么直接测投影函数：三处选择面各自构造载荷，纯函数单测能钉住「过滤发生在列表源头」，
 * 而不是靠 UI 隐藏补救；主控面则必须走真实装配，才能证明接线位置正确（投影函数跑通
 * 不代表装配时真的调到了它）。
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import { listBuiltinToolFaces } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { ASSISTANT_ROLE_PACK } from '../../shared/rolePackKind.js';
import {
  buildChatRolePacks,
  postRolePackList,
  type RolePackListContext,
} from '../helpers/rolePackListView.js';

// 投影模块经 rolePackTeams 间接依赖 vscode（仅用 l10n.t）；node 环境无该模块，按需最小替身。
// 替身只提供真正被调用的一面——多给能力就是让测试替身替生产代码兜底。
vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
}));

/** 唯一的工作包名（选择面里应该只剩它） */
const WORK_PACK = '写手';

/** 套餐清单：一个工作包 + 一个助手包（后者必须被挡掉） */
const PACKS = [
  { name: WORK_PACK, displayName: WORK_PACK, description: '', kind: 'work' as const },
  {
    name: ASSISTANT_ROLE_PACK,
    displayName: ASSISTANT_ROLE_PACK,
    description: '',
    kind: 'assistant' as const,
  },
];

/**
 * 最小角色包管理器替身
 *
 * 只实现投影真正读取的三个面（`listMeta` / `get` / `activeName`）——替身多实现一个方法，
 * 就等于让测试替身替生产代码兜底，测出来的绿是假的。
 */
function stubRolePackManager(): Agent['rolePackManager'] {
  return {
    listMeta: () => PACKS,
    get: (name: string) =>
      PACKS.some((pack) => pack.name === name)
        ? ({
            meta: { name, displayName: name },
            strategy: undefined,
            capabilities: undefined,
            traits: undefined,
            validationIssues: [],
            filePath: undefined,
          } as never)
        : undefined,
    activeName: WORK_PACK,
  } as unknown as Agent['rolePackManager'];
}

describe('postRolePackList（设置页 roles_loaded）', () => {
  it('助手包被工种闸挡在列表外，工作包与当前角色照旧', () => {
    /** 投影投递消息的收集器（替身 post，只记账不投递） */
    const posted: ExtensionToWebviewMessage[] = [];
    /** 投影所需的宿主面（globalState 缺省 = 无队伍数据，不触发健康检测） */
    const ctx: RolePackListContext = {
      post: (msg) => posted.push(msg),
      globalState: undefined,
      rolePackSource: () => 'user',
    };
    postRolePackList(ctx, stubRolePackManager());
    expect(posted).toHaveLength(1);
    const msg = posted[0] as Extract<ExtensionToWebviewMessage, { type: 'roles_loaded' }>;
    expect(msg.type).toBe('roles_loaded');
    // 只剩工作包；助手包在 listMeta 里真实存在，但不得出现在选择面
    expect(msg.packs.map((pack) => pack.name)).toEqual([WORK_PACK]);
    expect(msg.activeName).toBe(WORK_PACK);
  });

  it('内置工具清单随 roles_loaded 下发，且逐项派生自内核真源（零手工副本）', () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const ctx: RolePackListContext = {
      post: (msg) => posted.push(msg),
      globalState: undefined,
      rolePackSource: () => 'user',
    };
    // 两条分支都要下发：rpm 就绪 与 rpm 缺省（编辑模式不因装配时序缺席）
    postRolePackList(ctx, stubRolePackManager());
    postRolePackList(ctx, undefined);
    const expected = listBuiltinToolFaces();
    expect(expected.length).toBeGreaterThan(0);
    for (const msg of posted) {
      const loaded = msg as Extract<ExtensionToWebviewMessage, { type: 'roles_loaded' }>;
      expect(loaded.builtinToolFaces).toEqual(expected);
    }
  });
});

describe('buildChatRolePacks（聊天页 chat_role_packs）', () => {
  it('助手包被工种闸挡在列表外，且不会被回退成「当前角色」', () => {
    const msg = buildChatRolePacks(stubRolePackManager(), undefined) as Extract<
      ExtensionToWebviewMessage,
      { type: 'chat_role_packs' }
    >;
    expect(msg.type).toBe('chat_role_packs');
    // 过滤后只剩工作包：若助手包漏进来且排在前，回退链会把它当成当前角色
    expect(msg.packs.map((pack) => pack.name)).toEqual([WORK_PACK]);
    expect(msg.activeName).toBe(WORK_PACK);
    // 未请求任何角色 ⇒ 不产生「不可用」提示
    expect(msg.unavailableName).toBeUndefined();
  });
});
