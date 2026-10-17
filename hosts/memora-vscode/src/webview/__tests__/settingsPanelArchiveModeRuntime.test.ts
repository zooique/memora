/**
 * settingsPanel.setArchiveMode —— **运行时真相层**链路测试（2026-10-17 补测批次）
 *
 * 为什么单开一个文件（不并进 settingsPanelArchiveMode.test.ts）：
 *   该文件覆盖「持久化 / 热更新 / 回推 / 文案」四层，**从未对「运行时到底是哪个模式」
 *   发过任何断言**——替身连 `getArchiveMode()` 读口都没有。本文件补的就是这一层。
 *
 * 三个层次的诊断（决定本文件的必要性）：
 *   ① `settingsPanel.setArchiveMode` 的 `archive_mode_status` 写在 `if (applied)` **之外**，
 *      回推的是**入参 mode** ⇒ 「忙不忙、真没真切换」输出完全一致，现有回推断言
 *      物理上不可能发现缺口；
 *   ② 现有繁忙用例的 `expect(setArchiveMode).toHaveBeenCalledWith('manual')` 是
 *      **反号断言**——抛错也算「调用过」，恰被被测的失败状态满足；
 *   ③ 现有 6 例全是**单拍**，而「繁忙期偏好何时兑现」恰需要跨拍观察——该缺口的内核侧
 *      （无暂存/补执行载体）已由 ADR-041 方案 A2 闭合，权威守卫在内核侧「轮终补执行」
 *      describe（真实 Agent 驱动）；宿主侧本文件**不模拟第二拍**（替身补执行 = 自证预言）。
 *
 * 关键替身约定（本文件的核心资产，勿删）：
 *   `truthfulAgentStub()` 带 **`getArchiveMode()` 运行时真值读口**（内核真有的出口，
 *   `Agent.getArchiveMode`，宿主侧此前零消费——这是首次把它作为「UI 谎言检测口」
 *   投入使用）+ **busy 开关**。没有这个读口，测试在物理上无法断言运行时真相。
 *
 * ⚠ 变异验证靶标（新增断言必做）：
 *   撤掉 `settingsPanel.setArchiveMode` 的 archive_mode_status → 「偏好回显」类断言转红；
 *   把 `archive_mode_status` 改成读 `getArchiveMode()` → 「状态回复不动用运行时真值」转红
 *     （这是**设计决定**的语法锁：UI 层不得出现第二条真值运输通道，见 ADR 裁决）；
 *   把繁忙 catch 的成功文案加回来 → 「不得谎报已切换」转红；
 *   把 busy 抛错换成普通 Error → 「MemoraError 分支」断言转红（toNoticeText 的双分支）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoraError } from '@zooique/memora';
import type { Agent, ArchiveMode } from '@zooique/memora';
import { MemoraSettingsViewProvider } from '../panels/settingsPanel.js';

const vscodeConfigMock = vi.hoisted(() => ({
  cfgGet: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
  cfgUpdate: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vscodeConfigMock.cfgGet,
      update: vscodeConfigMock.cfgUpdate,
    })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1 },
  env: { language: 'zh-cn' },
}));

/**
 * 真实「对话繁忙」错误（复刻内核 `chatBusyError(action)` 的输出形态）
 *
 * 契约来源：内核 `chatBusyError` 工厂（src/utils/errors.ts）
 *   chatBusyError(action) = configError('对话繁忙', `上一轮对话尚未完成，请等待其结束后再${action}`,
 *                                        ['等待当前对话完成后重试'])
 * 工厂本身**未从包 index 导出**（index 只导出 MemoraError / ToolErrorCode /
 * isRetryableErrorCode），故在宿主侧按同一形状用 MemoraError 构造。
 *
 * 为什么不能像旧测试那样手写 `new Error('对话繁忙：…')`：
 *   宿主 `toNoticeText`（extension/host/noticeText）对 MemoraError 走 `err.format()`，
 *   对普通 Error 才走 `err.message` —— 手写普通 Error 意味着**永远只测了第二个分支**，
 *   真实内核抛出的 MemoraError 形态（含 ❌ / 原因 / 建议 多行结构）从未进入过这条链路。
 */
function chatBusyErrorLike(action: string): MemoraError {
  return new MemoraError({
    title: '对话繁忙',
    detail: `上一轮对话尚未完成，请等待其结束后再${action}`,
    suggestions: ['等待当前对话完成后重试'],
    category: 'config',
  });
}

interface TruthfulAgentStub {
  agent: Agent;
  setArchiveMode: ReturnType<typeof vi.fn>;
  getArchiveMode: ReturnType<typeof vi.fn>;
  /** busy 开关：true = 内核拒热更新（A2 后为暂存+抛错；宿主侧只看见抛错） */
  setBusy(busy: boolean): void;
  /** 运行时真值（反映类内核 #config.archiveMode） */
  runtime(): ArchiveMode;
}

/**
 * 带**运行时真值读口**的 agent 替身（对照原 agentStub：只有 setArchiveMode/on/off）
 *
 * 建模内容严格对应内核 `Agent.setArchiveMode`：
 *   ① assertNotBusy 拒绝（本替身用 busy 开关模拟）；② 幂等 return（同值不改、不发事件）；
 *   ③ 改内部真值 + emit archiveModeChanged。
 */
function truthfulAgentStub(initial: ArchiveMode = 'full'): TruthfulAgentStub {
  let runtimeMode: ArchiveMode = initial;
  let busy = false;

  const setArchiveMode = vi.fn((mode: ArchiveMode) => {
    if (busy) throw chatBusyErrorLike('切换归档模式');
    if (runtimeMode === mode) return; // 幂等出口
    runtimeMode = mode;
  });
  const getArchiveMode = vi.fn(() => runtimeMode);

  return {
    agent: { setArchiveMode, getArchiveMode, on: vi.fn(), off: vi.fn() } as unknown as Agent,
    setArchiveMode,
    getArchiveMode,
    setBusy: (b: boolean) => {
      busy = b;
    },
    runtime: () => runtimeMode,
  };
}

/** 构造 provider + 记录 postMessage 的 posted 数组 */
function setup(agent: Agent): {
  provider: MemoraSettingsViewProvider;
  posted: { type: string; level?: string; message?: string; mode?: string }[];
} {
  const posted: { type: string; level?: string; message?: string; mode?: string }[] = [];
  const provider = new MemoraSettingsViewProvider({} as never, {} as never);
  provider.setAgentFactory(async () => agent);
  provider.setGlobalState({ get: () => undefined, update: vi.fn() } as never);
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: (msg: never) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  return { provider, posted };
}

function sendArchiveModeSet(provider: MemoraSettingsViewProvider, mode: string): Promise<void> {
  return (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
    type: 'archive_mode_set',
    mode,
  });
}

function notices(posted: { type: string; level?: string; message?: string }[]) {
  return posted.filter((m) => m.type === 'notice');
}

function statusMessages(posted: { type: string; mode?: string }[]) {
  return posted.filter((m) => m.type === 'archive_mode_status');
}

describe('settingsPanel.setArchiveMode —— 运行时真相层（UI 谎言检测）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeConfigMock.cfgGet.mockImplementation(
      (_key: string, defaultValue?: unknown) => defaultValue,
    );
  });

  // ─── P0-1：繁忙拒切后的「两拍时间线」第一拍 ───

  /**
   * 宿主侧职责边界：忙期保存偏好 ⇒ 落盘 + 如实顺延文案 + 运行时**此刻**不变。
   *
   * 「流退出后补应用」这条契约的**权威守卫在内核侧**（真实 Agent 驱动 + 四个变异靶标，
   * 见内核 agent.test.ts 的「轮终补执行」describe）——ADR-041 方案 A2 已于 2026-10-17
   * 落地：`setArchiveMode` 对齐 `reloadConfig`（busy 时暂存+抛错，`chat()` 与
   * `resumeExecution()` 的 finally 补执行）。宿主不监听补执行回执（生效回执由既有
   * `archiveModeChanged` 事件承担），故此处**不再**用替身模拟第二拍：那等于让「补应用」
   * 契约在宿主侧变成自证预言，判据单点原则下也不许在两处各造一个假内核。
   */
  it('P0-1 繁忙拒切 → 偏好落盘 + 运行时不变 + 顺延文案承诺轮终生效（A2 后文案为真）', async () => {
    const stub = truthfulAgentStub('full');
    const { provider, posted } = setup(stub.agent);
    stub.setBusy(true);

    // 第 1 拍：繁忙 → 拒切，偏好落盘但运行时零变化
    await sendArchiveModeSet(provider, 'manual');
    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('archiveMode', 'manual', 1);
    // ← 现有 6 例**从未问过这句**：偏好存了 ≠ 运行时改了
    expect(stub.runtime()).toBe('full');
    expect(notices(posted)[0]?.message).toContain('偏好已保存');
    // 顺延文案必须点名「对话结束后生效」——A2 落地后这是**被兑现的承诺**而非空头支票
    expect(notices(posted)[0]?.message).toContain('对话结束后生效');
    // 忙期不得出现任何「已切换」成功话术（与 P0-2 负向断言同口径）
    expect(notices(posted)[0]?.message).not.toContain('已切换归档模式');
  });

  it('P0-1 反面对照：非繁忙时，偏好在流外一次即到运行时（基线锚点，必须绿）', async () => {
    // 与上一例互为对照：证明替身/读口本身有效（流外 1 拍能成功 ⇒ 若繁忙用例的第 1 拍
    // 断言红，必是宿主实现问题，而非 harness 造不出来）。缺这条对照，繁忙用例的红
    // 就无法排除「断言永远不可能绿」。
    const stub = truthfulAgentStub('full');
    const { provider } = setup(stub.agent);

    await sendArchiveModeSet(provider, 'manual');

    expect(stub.runtime()).toBe('manual');
  });

  // ─── P0-2：繁忙顺延不得谎报「已切换」 ───

  it('P0-2 繁忙拒切 → 提示如实顺延：info 级「偏好已保存」且绝不出现「已切换/已生效」', async () => {
    const stub = truthfulAgentStub('full');
    const { provider, posted } = setup(stub.agent);
    stub.setBusy(true);

    await sendArchiveModeSet(provider, 'manual');

    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.level).toBe('info');
    expect(msgs[0]?.message).toContain('偏好已保存');
    expect(msgs[0]?.message).toContain('对话结束后生效');
    // 负向断言（现有用例只有正向断言，堵不住「把顺延分支改成成功文案」这类 wrong fix）
    expect(msgs[0]?.message).not.toContain('已切换归档模式');
    expect(msgs[0]?.message).not.toContain('已生效');
  });

  // ─── P0-3：钉死 archive_mode_status 的语义 = 偏好回显（设计决定，非缺陷） ───

  it('P0-3 archive_mode_status 恒推偏好值，且**不咨询**运行时真值（UI 不设第二条真值通道）', async () => {
    // ADR 裁决：`archive_mode_status` 语义 = **偏好回显**（busy 时仍推用户选的 'manual'），
    // 这是设计决定而非缺陷；运行时真相不由 protocol 字段运输（UI 层不得出现第二条通道），
    // 生效回执由既有 `archiveModeChanged` 事件承担。
    // ⇒ 本用例锁死该语义，防止后来者「顺手改成运行时口径」。
    const stub = truthfulAgentStub('full');
    const { provider, posted } = setup(stub.agent);
    stub.setBusy(true);

    await sendArchiveModeSet(provider, 'manual');

    // 运行时仍是 full，但 status 回推 'manual'（偏好口径）
    expect(stub.runtime()).toBe('full');
    expect(statusMessages(posted)).toContainEqual({ type: 'archive_mode_status', mode: 'manual' });
    // 语法级的强锁：回显路径**不得**去读运行时真相（读了就等于把第二条通道开了口子）
    expect(stub.getArchiveMode).not.toHaveBeenCalled();
  });

  it('P0-3 附：切换成功时同样推偏好值（两条路径口径一致，不得因 applied 分叉）', async () => {
    const stub = truthfulAgentStub('full');
    const { provider, posted } = setup(stub.agent);

    await sendArchiveModeSet(provider, 'manual');

    expect(statusMessages(posted)).toContainEqual({ type: 'archive_mode_status', mode: 'manual' });
    // 成功路径才允许出现「已切换」的成功提示（对比 P0-2 的负向断言）
    expect(notices(posted)[0]?.message).toContain('已切换归档模式');
  });

  // ─── P1-3：对接内核真实错误契约（MemoraError 分支） ───

  it('P1-3 繁忙错误走内核 MemoraError 形态 → notice 用 err.format() 渲染（非 err.message）', async () => {
    // toNoticeText 对 MemoraError 走 `err.format()`，
    // 输出 `❌ 标题 / 原因： / 建议：` 多行结构；普通 Error 才走 err.message。
    // 旧用例手抄普通 Error ⇒ **MemoraError 分支从未被覆盖**。
    const stub = truthfulAgentStub('full');
    const { provider, posted } = setup(stub.agent);
    stub.setBusy(true);

    await sendArchiveModeSet(provider, 'manual');

    const msg = notices(posted)[0]?.message ?? '';
    // 「❌ 对话繁忙」+「原因：」是 format() 独有的结构标记 ⇒ 证明走的是 MemoraError 分支
    expect(msg).toContain('❌ 对话繁忙');
    expect(msg).toContain('原因：上一轮对话尚未完成，请等待其结束后再切换归档模式');
    expect(msg).toContain('建议：');
    expect(msg).toContain('等待当前对话完成后重试');
  });

  it('P1-3 附：抛出的繁忙错误须具备契约形状（title/category = config）', async () => {
    // 与 chatBusyError 工厂同形的结构锁：
    // 将来若工厂改了标题/分类，本 exemplified 断言负责让本文件的复刻件同步失效可见。
    const err = chatBusyErrorLike('切换归档模式');
    expect(err).toBeInstanceOf(MemoraError);
    expect(err.title).toBe('对话繁忙');
    expect(err.category).toBe('config');
    expect(err.detail).toBe('上一轮对话尚未完成，请等待其结束后再切换归档模式');
    expect(err.suggestions).toEqual(['等待当前对话完成后重试']);
  });
});
