/**
 * userDataReset — 用户级数据初始化（恢复首装态）
 *
 * 不引入真实 VS Code 运行时：vi.mock 提供内存版 configuration / Memento / SecretStorage，
 * 调用时序用共享 callOrder 数组记录；globalStorage 目录清理走真实 tmpdir（mkdtemp）。
 *
 * 覆盖四条通道的不变量（K1 顺序 / K3 前缀 / K4 target / 目录不越界）+ 键清单派生。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 内存版 configuration + 调用时序记录（hoisted 以便 vi.mock 工厂内引用） */
const h = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  const updateCalls: Array<{ key: string; value: unknown; target: unknown }> = [];
  /** 跨通道调用时序（secret:xxx / cfg:xxx / gs:xxx），K1 断言用 */
  const callOrder: string[] = [];
  const config = {
    store,
    updateCalls,
    callOrder,
    get: (key: string, def?: unknown) => (key in store ? store[key] : def),
    update: (key: string, val: unknown, target?: unknown) => {
      store[key] = val;
      updateCalls.push({ key, value: val, target });
      callOrder.push(`cfg:${key}`);
    },
    inspect: (key: string) => ({ globalValue: key in store ? store[key] : undefined }),
  };
  return { config, store, updateCalls, callOrder };
});

/** 内存版 SecretStorage（delete 记入 callOrder，K1 时序断言） */
const secretsStore: Record<string, string> = {};
const secrets = {
  get: vi.fn(async (k: string) => secretsStore[k] ?? null),
  store: vi.fn(async (k: string, v: string) => {
    secretsStore[k] = v;
  }),
  delete: vi.fn(async (k: string) => {
    delete secretsStore[k];
    h.callOrder.push(`secret:${k}`);
  }),
};

/** 内存版 Memento（globalState；update undefined = 删键，与 VS Code 语义一致） */
const gsStore = new Map<string, unknown>();
const globalState = {
  keys: () => [...gsStore.keys()],
  get: (k: string) => gsStore.get(k),
  update: vi.fn(async (k: string, v: unknown) => {
    if (v === undefined) gsStore.delete(k);
    else gsStore.set(k, v);
    h.callOrder.push(`gs:${k}`);
  }),
};

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: { getConfiguration: () => h.config },
}));

import * as vscode from 'vscode';
import { listUserSettingKeys, resetUserData, type UserDataResetScope } from '../userDataReset.js';

/** 与宿主 package.json 同构的最小样本（完整设置 ID 形态） */
const SAMPLE_PACKAGE_JSON = {
  contributes: {
    configuration: {
      title: 'Memora',
      properties: {
        'memora.providers': { type: 'array' },
        'memora.activeProvider': { type: 'string' },
        'memora.backgroundProvider': { type: 'string' },
        'memora.disabledSkills': { type: 'array' },
      },
    },
  },
};

function makeScope(overrides?: Partial<UserDataResetScope>): UserDataResetScope {
  return {
    globalState: globalState as unknown as vscode.Memento,
    secrets: secrets as unknown as vscode.SecretStorage,
    globalStorageDir: join(tmpdir(), 'memora-reset-nonexistent'),
    packageJson: SAMPLE_PACKAGE_JSON,
    ...overrides,
  };
}

describe('userDataReset.resetUserData', () => {
  beforeEach(() => {
    for (const k of Object.keys(h.store)) delete h.store[k];
    for (const k of Object.keys(secretsStore)) delete secretsStore[k];
    h.updateCalls.length = 0;
    h.callOrder.length = 0;
    gsStore.clear();
    secrets.delete.mockClear();
    globalState.update.mockClear();
  });

  it('K3 前缀过滤：只清 memora. 前缀的 globalState 键，其他扩展的键不碰', async () => {
    gsStore.set('memora.activeRolePack', 'pack-a');
    gsStore.set('memora.rolePackTeams', [{ leader: 'a', members: [] }]);
    gsStore.set('memora.confirmWrites', true);
    gsStore.set('otherExt.foo', 'bar');
    gsStore.set('someOther.key', 42);

    const report = await resetUserData(makeScope());

    expect(report.globalStateCleared).toEqual([
      'memora.activeRolePack',
      'memora.rolePackTeams',
      'memora.confirmWrites',
    ]);
    // 其他扩展的键原地不动（无脑 keys() 全清 = 误删，K3 防的就是这个）
    expect(gsStore.has('otherExt.foo')).toBe(true);
    expect(gsStore.has('someOther.key')).toBe(true);
    // 本插件前缀的键确已清掉
    expect(gsStore.size).toBe(2);
  });

  it('K1 时序：secrets.delete 全部发生在 settings update 之前，且 secret key 与 providerSecretKey 同源', async () => {
    h.store['providers'] = [{ name: 'p1' }, { name: 'p2' }];

    const report = await resetUserData(makeScope());

    expect(report.secretsCleared).toEqual(['p1', 'p2']);
    // 时序：secret 删除的最大下标 < settings 更新的最小下标
    const secretIdx = h.callOrder
      .map((c, i) => (c.startsWith('secret:') ? i : -1))
      .filter((i) => i >= 0);
    const cfgIdx = h.callOrder.map((c, i) => (c.startsWith('cfg:') ? i : -1)).filter((i) => i >= 0);
    expect(secretIdx).toHaveLength(2);
    expect(cfgIdx.length).toBeGreaterThan(0);
    expect(Math.max(...secretIdx)).toBeLessThan(Math.min(...cfgIdx));
    // key 构造式 = memora.provider.{name}.apiKey（与 providerStore 单一构造点同源）
    expect(h.callOrder).toContain('secret:memora.provider.p1.apiKey');
    expect(h.callOrder).toContain('secret:memora.provider.p2.apiKey');
  });

  it('K4 target：settings 逐键清空，update 第三参恒为 Global，Workspace target 零调用', async () => {
    h.store['providers'] = [];

    const report = await resetUserData(makeScope());

    // 派生清单（4 个样本键，package.json 声明序）
    expect(report.settingsCleared).toEqual([
      'memora.providers',
      'memora.activeProvider',
      'memora.backgroundProvider',
      'memora.disabledSkills',
    ]);
    expect(h.updateCalls.length).toBe(4);
    for (const call of h.updateCalls) {
      expect(call.value).toBeUndefined();
      expect(call.target).toBe(vscode.ConfigurationTarget.Global);
    }
    expect(h.updateCalls.some((c) => c.target === vscode.ConfigurationTarget.Workspace)).toBe(
      false,
    );
  });

  it('相对键换算：完整 ID 剥 section 前缀后 update（不写成 memora.memora.providers）', async () => {
    h.store['providers'] = [];
    await resetUserData(makeScope());
    const updatedKeys = h.updateCalls.map((c) => c.key);
    expect(updatedKeys).toContain('providers');
    expect(updatedKeys).toContain('backgroundProvider');
    // 双前缀脏键零出现
    expect(updatedKeys.some((k) => k.startsWith('memora.'))).toBe(false);
  });

  it('providers 异形条目：无 name / 非字符串 name 跳过，不阻塞清理', async () => {
    h.store['providers'] = [{ name: 'ok' }, {}, { name: 42 }, null];
    const report = await resetUserData(makeScope());
    expect(report.secretsCleared).toEqual(['ok']);
  });

  it('globalStorage：只删并重建 skills/ 与 role-packs/，目录内其他内容不越界删', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'memora-reset-'));
    try {
      await mkdir(join(tmp, 'skills', 'sub'), { recursive: true });
      await writeFile(join(tmp, 'skills', 'sub', 'a.md'), 'x');
      await mkdir(join(tmp, 'role-packs', 'pack-a'), { recursive: true });
      await writeFile(join(tmp, 'role-packs', 'pack-a', 'manifest.json'), '{}');
      await writeFile(join(tmp, 'other-cache.bin'), 'keep');

      const report = await resetUserData(makeScope({ globalStorageDir: tmp }));

      // 两个目标目录：存在且为空（重建，与 activate mkdir 对齐）
      expect(existsSync(join(tmp, 'skills'))).toBe(true);
      expect(readdirSync(join(tmp, 'skills'))).toEqual([]);
      expect(existsSync(join(tmp, 'role-packs'))).toBe(true);
      expect(readdirSync(join(tmp, 'role-packs'))).toEqual([]);
      // 白名单外内容保留（删整个目录 = 越界，本测试防的就是这个）
      expect(existsSync(join(tmp, 'other-cache.bin'))).toBe(true);
      expect(report.dirsReset).toEqual([join(tmp, 'skills'), join(tmp, 'role-packs')]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('userDataReset.listUserSettingKeys', () => {
  it('对象形态：取 properties 全部键', () => {
    expect(listUserSettingKeys(SAMPLE_PACKAGE_JSON)).toEqual([
      'memora.providers',
      'memora.activeProvider',
      'memora.backgroundProvider',
      'memora.disabledSkills',
    ]);
  });

  it('数组形态：多 configuration 块都扫（VS Code 规范允许拆分）', () => {
    const keys = listUserSettingKeys({
      contributes: {
        configuration: [
          { properties: { 'memora.providers': {} } },
          { properties: { 'memora.searchEngine': {} } },
        ],
      },
    });
    expect(keys).toEqual(['memora.providers', 'memora.searchEngine']);
  });

  it('多块重复声明同一键 → 只入列一次（Set 去重）', () => {
    const keys = listUserSettingKeys({
      contributes: {
        configuration: [
          { properties: { 'memora.providers': {} } },
          { properties: { 'memora.providers': {} } },
        ],
      },
    });
    expect(keys).toEqual(['memora.providers']);
  });

  it('畸形输入：无 contributes / 空值 / 非对象不炸，返回空清单', () => {
    expect(listUserSettingKeys(undefined)).toEqual([]);
    expect(listUserSettingKeys({})).toEqual([]);
    expect(listUserSettingKeys('nope')).toEqual([]);
    expect(listUserSettingKeys({ contributes: { configuration: { properties: null } } })).toEqual(
      [],
    );
  });
});
