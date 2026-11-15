/**
 * 形态 + 座位启动恢复的用例（`helpers/uiFormPersistence.ts`）
 *
 * 这些用例锁的是「重启后照旧」的三件套必须**成对**：形态 / 座位 / 当前会话。
 * 只恢复形态（不恢复座位）是第一轮真机验收修过的病灶（界面说托管、实际没人接），
 * 所以每个分支都断言「有没有写座位」，而不只断言 form。
 */
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { UI_FORM_STATE_KEY, type PersistedUiFormState } from '../../shared/constants.js';
import {
  readPersistedUiForm,
  restorePersistedUiForm,
  type UiFormRestoreDeps,
} from '../helpers/uiFormPersistence.js';
import { SessionModeStore } from '../../extension/host/sessionModeStore.js';

/**
 * 构造一个只实现 `get` 的伪 Memento（恢复路径只读，不写）
 *
 * @param value 持久值（undefined = 没存过）
 */
function mementoOf(value: unknown): vscode.Memento {
  return { get: (key: string) => (key === UI_FORM_STATE_KEY ? value : undefined) } as never;
}

/** 恢复依赖替身的可调项 */
interface RestoreOptions {
  /** 持久值 */
  saved?: unknown;
  /** 当前显示会话（草稿为空串） */
  current?: string;
  /** 可解析出实体的会话 */
  resolvable?: string[];
  /** 托管出生的会话 */
  hostedBorn?: string[];
}

/**
 * 构造依赖替身并记录所有副作用
 *
 * 替身只给 `seedForm` / `restoreSeat` / `enterManagedDraft` 三面——恢复路径**只读**，
 * 没有「写盘」「切会话」的注入口可调（想加回来得先改接口，改不动就是纪律生效）。
 *
 * @param options 可调项
 */
function makeDeps(options: RestoreOptions = {}): {
  deps: UiFormRestoreDeps;
  seedForm: ReturnType<typeof vi.fn>;
  restoreSeat: ReturnType<typeof vi.fn>;
  enterManagedDraft: ReturnType<typeof vi.fn>;
} {
  const seedForm = vi.fn();
  const restoreSeat = vi.fn();
  const enterManagedDraft = vi.fn();
  const deps: UiFormRestoreDeps = {
    uiState: mementoOf(options.saved),
    currentSessionId: () => options.current ?? '',
    sessionFacts: (id) => ({
      resolvable: (options.resolvable ?? []).includes(id),
      hostedBorn: (options.hostedBorn ?? []).includes(id),
    }),
    seedForm,
    restoreSeat,
    enterManagedDraft,
  };
  return { deps, seedForm, restoreSeat, enterManagedDraft };
}

describe('readPersistedUiForm — 脏数据整体回落', () => {
  it('没存过 / 非对象 / form 非法：一律当没有（不猜半个值）', () => {
    expect(readPersistedUiForm(undefined)).toBeUndefined();
    expect(readPersistedUiForm(mementoOf(undefined))).toBeUndefined();
    expect(readPersistedUiForm(mementoOf('assistant'))).toBeUndefined();
    expect(readPersistedUiForm(mementoOf({ form: 'weird', seatSessionId: 'x' }))).toBeUndefined();
  });

  it('合法值：座位字段缺失按空串补齐（旧写入 / 手改文件都能读）', () => {
    expect(readPersistedUiForm(mementoOf({ form: 'assistant' }))).toEqual({
      form: 'assistant',
      seatSessionId: '',
    });
    expect(readPersistedUiForm(mementoOf({ form: 'self', seatSessionId: 3 }))).toEqual({
      form: 'self',
      seatSessionId: '',
    });
  });
});

describe('restorePersistedUiForm — 形态 / 座位就位，页面不动', () => {
  it('自助 / 无持久值：什么都不做（自助就是默认值，不写盘）', () => {
    for (const saved of [undefined, { form: 'self', seatSessionId: '' }]) {
      const h = makeDeps({ saved });
      restorePersistedUiForm(h.deps);
      expect(h.seedForm).not.toHaveBeenCalled();
      expect(h.restoreSeat).not.toHaveBeenCalled();
    }
  });

  it('助手 + 座位可解析：播种形态、登记座位；**不把当前页面切到座位**（口径 A）', () => {
    const h = makeDeps({
      saved: { form: 'assistant', seatSessionId: 'session-seat' },
      current: 'session-other',
      resolvable: ['session-seat'],
    });
    restorePersistedUiForm(h.deps);
    expect(h.seedForm).toHaveBeenCalledWith('assistant');
    expect(h.restoreSeat).toHaveBeenCalledWith('session-seat');
    // 恢复只读：没有「换会话」这条路可走（依赖面里根本没有这个注入口）
    expect(h.enterManagedDraft).not.toHaveBeenCalled();
  });

  it('助手 + 座位就是当前会话：同样只登记（导航写点不白跑一次）', () => {
    const h = makeDeps({
      saved: { form: 'assistant', seatSessionId: 'session-seat' },
      current: 'session-seat',
      resolvable: ['session-seat'],
    });
    restorePersistedUiForm(h.deps);
    expect(h.seedForm).toHaveBeenCalledWith('assistant');
    expect(h.restoreSeat).toHaveBeenCalledWith('session-seat');
  });

  it('助手 + 座位会话已删除：静默回落自助（不赌最近一条，也不纠正磁盘）', () => {
    const h = makeDeps({
      saved: { form: 'assistant', seatSessionId: 'session-gone' },
      current: 'session-other',
      resolvable: ['session-other'],
    });
    restorePersistedUiForm(h.deps);
    expect(h.seedForm).not.toHaveBeenCalled();
    expect(h.restoreSeat).not.toHaveBeenCalled();
  });

  it('助手 + 座位为空 + 没有会话（关闭时在托管草稿）：进托管草稿', () => {
    const h = makeDeps({ saved: { form: 'assistant', seatSessionId: '' } });
    restorePersistedUiForm(h.deps);
    expect(h.seedForm).toHaveBeenCalledWith('assistant');
    expect(h.enterManagedDraft).toHaveBeenCalledTimes(1);
  });

  it('助手 + 座位可解析 + 当前是空白页：座位登记与空白页**同时成立**（不切走页面）', () => {
    const h = makeDeps({
      saved: { form: 'assistant', seatSessionId: 'session-seat' },
      current: '',
      resolvable: ['session-seat'],
    });
    restorePersistedUiForm(h.deps);
    expect(h.restoreSeat).toHaveBeenCalledWith('session-seat');
    // 页面仍是空白页：只把草稿身份定成托管（首句按助手路径建会话），不离开这一页
    expect(h.enterManagedDraft).toHaveBeenCalledTimes(1);
  });

  it('助手 + 座位为空 + 当前会话是托管出生：认它当座位（草稿首句已落盘）', () => {
    const h = makeDeps({
      saved: { form: 'assistant', seatSessionId: '' },
      current: 'session-flushed',
      resolvable: ['session-flushed'],
      hostedBorn: ['session-flushed'],
    });
    restorePersistedUiForm(h.deps);
    expect(h.seedForm).toHaveBeenCalledWith('assistant');
    expect(h.restoreSeat).toHaveBeenCalledWith('session-flushed');
  });

  it('助手 + 座位为空 + 当前会话是自助出生：回自助（出生来源只做守卫，不当权限）', () => {
    const h = makeDeps({
      saved: { form: 'assistant', seatSessionId: '' },
      current: 'session-self',
      resolvable: ['session-self'],
      hostedBorn: [],
    });
    restorePersistedUiForm(h.deps);
    expect(h.seedForm).not.toHaveBeenCalled();
    expect(h.restoreSeat).not.toHaveBeenCalled();
  });
});

describe('SessionModeStore — 恢复标签的生命周期', () => {
  /** 构造容器（globalState 只用于「上次模式」，本组用例不读） */
  function store(): SessionModeStore {
    return new SessionModeStore({ get: () => undefined, update: async () => undefined } as never);
  }

  it('restoreManaged：先写权限再打标签（顺序反了标签会丢）', () => {
    const s = store();
    s.restoreManaged('sid');
    expect(s.isManaged('sid')).toBe(true);
    expect(s.isRestored('sid')).toBe(true);
    // has() 也为真：这正是「与刚收回长得一样、必须靠 restored 区分」的原因
    expect(s.has('sid')).toBe(true);
  });

  it('用户再次显式 set：恢复标签撤销（那一刻起不再是「恢复来的」）', () => {
    const s = store();
    s.restoreManaged('sid');
    s.set('sid', 'self');
    expect(s.isRestored('sid')).toBe(false);
    s.restoreManaged('sid');
    s.set('sid', 'managed');
    expect(s.isRestored('sid')).toBe(false);
  });

  it('delete：三个容器一起清（不留残影）', () => {
    const s = store();
    s.restoreManaged('sid');
    s.markAgentDriven('sid');
    s.delete('sid');
    expect(s.has('sid')).toBe(false);
    expect(s.isAgentDriven('sid')).toBe(false);
    expect(s.isRestored('sid')).toBe(false);
  });
});

/** 类型回归：持久值形状与恢复依赖的可调项同名，防止两边各写一套 */
const _shapeCheck: PersistedUiFormState = { form: 'self', seatSessionId: '' };
void _shapeCheck;
