/**
 * 宿主钉住上下文单测（0.10.0 会话级钉住：写侧 / 回种侧 / 落盘面形状闸）
 *
 * 覆盖范围（M3 + M5 的判据要求）：
 * - `seedPinnedRefs` 纯函数：存在 / 失效两态、`folder` 分支、`range` 透传、技能条目不进引用；
 * - `writePinnedItems`：草稿态（无 sessionId）不写且不抛；有 sessionId 时写入正确清单；
 * - `pinnedSkillNameOf`：技能槽取值 + 损坏 name 的 fail-closed；
 * - `pushPinnedRefsTo`：用**真实临时目录**（`existsSync` 真判，不 mock fs）验证回种投影，
 *   以及坏条目「跳过但不静默」（error notice 计数可见）。
 *
 * 不测什么（不要假装测了）：
 * - 跨进程真实重启后的回种属 e2e 范畴（需要 F5 宿主窗口），单测只覆盖「元数据 → 下行投影」；
 * - webview 侧 chip 渲染与钉住交互由 `chatView.test.ts` / `skillPickerView.test.ts` 覆盖。
 */
// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionMeta, SessionPinnedItem } from '@zooique/memora';

/** vscode mock 的可变首根（`pushPinnedRefsTo` 只用这一个字段） */
const h = vi.hoisted(() => ({ rootFsPath: '' as string }));

vi.mock('vscode', () => ({
  workspace: {
    // 与生产同源：基准恒取 workspaceFolders[0]
    get workspaceFolders() {
      return h.rootFsPath ? [{ uri: { fsPath: h.rootFsPath } }] : undefined;
    },
  },
}));

import {
  pinnedSkillNameOf,
  pushPinnedRefsTo,
  seedPinnedRefs,
  toPinnedItems,
  writePinnedItems,
} from '../pinnedContext.js';

describe('seedPinnedRefs（纯函数：失效判定 + folder + range）', () => {
  it('存在 → 无 missing；不存在 → missing: true；folder 保留形态；range 透传；技能条目不进引用', async () => {
    const refs = await seedPinnedRefs(
      [
        { kind: 'file', path: 'a.md' },
        { kind: 'file', path: 'missing.md' },
        { kind: 'folder', path: 'docs' },
        { kind: 'file', path: 'b.md', range: { start: 3, end: 9 } },
        { kind: 'skill', name: '某技能' },
      ],
      async (p) => p !== 'missing.md',
    );
    expect(refs).toEqual([
      { kind: 'file', path: 'a.md', pinned: true },
      { kind: 'file', path: 'missing.md', pinned: true, missing: true },
      { kind: 'folder', path: 'docs', pinned: true },
      { kind: 'file', path: 'b.md', range: { start: 3, end: 9 }, pinned: true },
    ]);
  });

  it('形状闸：坏条目跳过而非抛错；坏 range 只丢 range（path 仍是条目身份）', async () => {
    const raw = [
      { kind: 'file' }, // 缺 path
      { kind: 'file', path: 42 }, // path 非字符串（会让 existsSync 抛）
      { kind: 'weird', path: 'x.md' }, // 未知 kind
      null, // 非对象
      { kind: 'file', path: 'ok.md', range: { start: 'a', end: 2 } }, // range 坏
    ] as unknown as SessionPinnedItem[];
    const refs = await seedPinnedRefs(raw, async () => true);
    expect(refs).toEqual([{ kind: 'file', path: 'ok.md', pinned: true }]);
  });
});

describe('writePinnedItems（写侧：草稿态不写 / 有会话写入）', () => {
  it('草稿态（sessionId 为空 / undefined）⇒ 不写、不抛（已知限制：锁了没发就关窗会白锁）', () => {
    const calls: unknown[] = [];
    const store = {
      updateSessionMeta: (id: string, meta: Partial<SessionMeta>) => calls.push({ id, meta }),
    };
    const payload = { refs: [{ path: 'src/foo.ts', kind: 'file' as const, pinned: true }] };
    expect(() => writePinnedItems(store, '', payload)).not.toThrow();
    expect(() => writePinnedItems(store, undefined, payload)).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('有 sessionId ⇒ 写入只含钉住指针（未锁不入、技能单槽、range 保留）', () => {
    const calls: Array<{ id: string; meta: Partial<SessionMeta> }> = [];
    const store = {
      updateSessionMeta: (id: string, meta: Partial<SessionMeta>) => calls.push({ id, meta }),
    };
    writePinnedItems(store, 'sid-1', {
      refs: [
        { path: 'src/foo.ts', kind: 'file', pinned: true, range: { start: 1, end: 5 } },
        { path: 'src/bar.ts', kind: 'folder' }, // 未锁 ⇒ 不入清单
      ],
      skillName: '技能A',
      skillPinned: true,
    });
    expect(calls).toEqual([
      {
        id: 'sid-1',
        meta: {
          pinnedItems: [
            { kind: 'file', path: 'src/foo.ts', range: { start: 1, end: 5 } },
            { kind: 'skill', name: '技能A' },
          ],
        },
      },
    ]);
  });

  it('toPinnedItems：技能未钉住 / 未选中 ⇒ 不产生技能条目（发完即清的默认语义）', () => {
    expect(toPinnedItems([], '技能A', false)).toEqual([]);
    expect(toPinnedItems([], undefined, true)).toEqual([]);
  });
});

describe('pinnedSkillNameOf（技能槽 + 形状闸）', () => {
  it('取 skill 条目名；无技能条目 ⇒ undefined', () => {
    expect(pinnedSkillNameOf([{ kind: 'file', path: 'a.md' }])).toBeUndefined();
    expect(pinnedSkillNameOf([{ kind: 'skill', name: '技能A' }])).toBe('技能A');
  });

  it('损坏 name（非字符串 / 空串）⇒ undefined：脏值不得漏到 webview', () => {
    const raw = [{ kind: 'skill', name: 42 }] as unknown as SessionPinnedItem[];
    expect(pinnedSkillNameOf(raw)).toBeUndefined();
    expect(pinnedSkillNameOf([{ kind: 'skill', name: '' }])).toBeUndefined();
  });
});

describe('pushPinnedRefsTo（元数据 → 下行投影 + 落盘面形状闸）', () => {
  /** 真实临时根（`existsSync` 真判，不 mock 文件系统） */
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'memora-pin-'));
    h.rootFsPath = root;
    writeFileSync(join(root, '存在.md'), '# 存在\n', 'utf8');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 构造只实现 getSessionMeta 的最小 store */
  const storeOf = (pinnedItems: unknown) =>
    ({
      getSessionMeta: () => ({ sessionId: 'sid-1', pinnedItems }) as unknown as SessionMeta,
    }) as { getSessionMeta(sessionId: string): SessionMeta | undefined };

  it('真实文件系统：存在项正常回种，被删项带 missing（不静默过滤），技能条目不走 addRef', async () => {
    const posted: Array<Record<string, unknown>> = [];
    await pushPinnedRefsTo(
      storeOf([
        { kind: 'file', path: '存在.md' },
        { kind: 'folder', path: 'docs' },
        { kind: 'file', path: '已被删除.md' },
        { kind: 'skill', name: '某技能' },
      ]),
      'sid-1',
      (m) => posted.push(m as unknown as Record<string, unknown>),
    );
    expect(posted).toEqual([
      {
        type: 'addRef',
        refs: [
          { kind: 'file', path: '存在.md', pinned: true },
          { kind: 'folder', path: 'docs', pinned: true, missing: true },
          { kind: 'file', path: '已被删除.md', pinned: true, missing: true },
        ],
      },
    ]);
  });

  it('坏条目：不抛错（否则整个 replaySession 挂掉）、跳过并以 error notice 计数可见', async () => {
    const posted: Array<Record<string, unknown>> = [];
    await pushPinnedRefsTo(
      storeOf([{ kind: 'file', path: 42 }, { kind: 'file', path: '存在.md' }, { kind: 'skill' }]),
      'sid-1',
      (m) => posted.push(m as unknown as Record<string, unknown>),
    );
    // 好条目照常回种
    expect(posted[0]).toEqual({
      type: 'addRef',
      refs: [{ kind: 'file', path: '存在.md', pinned: true }],
    });
    // 坏条目 2 条 ⇒ 一条可见提示（停留更久的 error 级）
    expect(posted[1]).toMatchObject({ type: 'notice', level: 'error' });
    expect(String(posted[1]!.message)).toContain('2 条');
  });

  it('无 sessionId（草稿态）⇒ 什么都不发', async () => {
    const posted: unknown[] = [];
    await pushPinnedRefsTo(storeOf([{ kind: 'file', path: '存在.md' }]), '', (m) => posted.push(m));
    await pushPinnedRefsTo(storeOf([{ kind: 'file', path: '存在.md' }]), undefined, (m) =>
      posted.push(m),
    );
    expect(posted).toEqual([]);
  });

  it('无钉住清单 ⇒ 不发空 addRef（空清单不产生空回种）', async () => {
    const posted: unknown[] = [];
    await pushPinnedRefsTo(storeOf(undefined), 'sid-1', (m) => posted.push(m));
    expect(posted).toEqual([]);
  });
});
