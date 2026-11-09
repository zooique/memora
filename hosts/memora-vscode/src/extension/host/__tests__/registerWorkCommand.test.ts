/**
 * 「登记作品投影」命令冒烟测试（`commands/registerWork.ts`）
 *
 * 切片 2 改造的判据面：① 无 uri ⇒ 警告嵌菜单标题（与命令面板**同源**——标题经
 * `resolveCommandTitle` 解析传入，ADR-042 后果第 2 条硬债）；② Agent 未就绪 ⇒ 明确提示。
 * LLM 描述生成与落库链路不在此测（原命令无专门测试，保持范围最小；核心判据面
 * = workspaceRelativePath 单点 + addToChat 路由，各有专属测试）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

const state = vi.hoisted(() => ({
  warnings: [] as unknown[],
  infos: [] as unknown[],
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn((m: unknown) => {
      state.warnings.push(m);
      return undefined;
    }),
    showInformationMessage: vi.fn((m: unknown) => {
      state.infos.push(m);
      return undefined;
    }),
  },
  workspace: {
    fs: { readFile: vi.fn() },
    // 首根供给：workspaceRelativePath 判据在 tryGetAgent 之前执行，缺根会被拒在更早的分支
    workspaceFolders: [{ uri: { fsPath: '/ws' } }],
  },
  l10n: { t: tStub },
}));

import { registerWorkCommand } from '../../commands/registerWork.js';
import type { Agent } from '@zooique/memora';

const TITLE = 'Memora: Register Work Projection';

beforeEach(() => {
  state.warnings.length = 0;
  state.infos.length = 0;
});

describe('registerWorkCommand · 切片 2 冒烟', () => {
  it('无 uri（命令面板调用）→ 警告嵌菜单标题（同源判据，ADR-042 后果第 2 条）', async () => {
    await registerWorkCommand(undefined, async () => null, {} as never, undefined, TITLE);
    expect(state.warnings).toEqual([
      'Right-click a file and choose "Memora: Register Work Projection".',
    ]);
  });

  it('Agent 未就绪 → 明确提示，不抛错不落库', async () => {
    const tryGetAgent = vi.fn(async (): Promise<Agent | null> => null);
    const uri = { fsPath: '/ws/a.md' };
    await registerWorkCommand(uri as never, tryGetAgent, {} as never, undefined, TITLE);
    expect(state.warnings).toEqual(['Memora Agent is not ready; cannot register the work']);
    expect(tryGetAgent).toHaveBeenCalledTimes(1);
  });
});
