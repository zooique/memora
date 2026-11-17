/**
 * 托管建会话落盘链路测试（2026-11-17 真机缺陷回归）
 *
 * 覆盖「mandate（语义边界）→ 建会话依赖第 5 参 → SessionMeta.workOrder」这条链的
 * 后两段（面板薄壳之外的 helper 层）。装配层那一段由
 * `extension/host/__tests__/lazyHostedSessionCreator.test.ts` 守。
 *
 * 缺口成因（真机实测）：这条链此前**没有任何测试**，且卡片路径全被绕开。
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// hostedSessionCreate 运行期 import vscode（l10n / logger 装配），这里按宿主替身注入
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
  },
}));

import { createHostedSessionWith, type HostedSessionCreateDeps } from '../hostedSessionCreate.js';
import { newSessionMeta } from '../newSessionMeta.js';

/** 建会话依赖替身：只记录调用，不碰会话文件 */
function makeDeps(overrides: Partial<HostedSessionCreateDeps> = {}): {
  deps: HostedSessionCreateDeps;
  createCalls: unknown[][];
} {
  const createCalls: unknown[][] = [];
  const deps: HostedSessionCreateDeps = {
    isManaged: () => true,
    readRolePackCatalog: async () => new Set(['writer']),
    createBackgroundSession: async (...args) => {
      createCalls.push(args);
      return true;
    },
    getAgent: async () => ({}) as never,
    startFlow: () => {},
    nextSessionId: () => 'sid-fixed',
    ...overrides,
  };
  return { deps, createCalls };
}

describe('createHostedSessionWith · mandate 透传到建会话依赖', () => {
  it('带 mandate → createBackgroundSession 第 5 参收到原文（workOrder 的落盘输入）', async () => {
    const { deps, createCalls } = makeDeps();

    const result = await createHostedSessionWith(
      deps,
      'calling',
      'writer',
      '统计 agent 目录',
      '开始',
      'Memora',
      ['src/agent'],
      '只读统计 src/agent 下 .ts 文件数量并汇报',
    );

    expect(result.ok).toBe(true);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual([
      'sid-fixed',
      'writer',
      '统计 agent 目录',
      ['src/agent'],
      '只读统计 src/agent 下 .ts 文件数量并汇报',
    ]);
  });

  it('不带 mandate → 第 5 参为 undefined（调用形态不变）', async () => {
    const { deps, createCalls } = makeDeps();

    await createHostedSessionWith(deps, 'calling', 'writer', '标题', '正文', 'Memora', []);

    expect(createCalls[0][4]).toBeUndefined();
  });
});

describe('newSessionMeta · workOrder 与 workStatus 落盘补丁', () => {
  it('带 workOrder → 补丁含该键（托管会话）', () => {
    const patch = newSessionMeta('writer', {
      title: 't',
      declaredPaths: ['src/agent'],
      agentCreated: true,
      workOrder: '只读盘点',
      workStatus: 'working',
    });

    expect(patch.origin).toBe('hosted');
    expect(patch.workOrder).toBe('只读盘点');
    expect(patch.workStatus).toBe('working');
  });

  it('不带 workOrder → 补丁不含该键（自助会话零污染，不带伤）', () => {
    const patch = newSessionMeta(undefined, { title: 't' });

    expect(patch.origin).toBe('user');
    expect('workOrder' in patch).toBe(false);
    expect('workStatus' in patch).toBe(false);
  });
});
