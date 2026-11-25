/**
 * settingsPanel 常规页消息链路测试（活动指标 + 复制诊断）
 *
 * 覆盖被测不变量（对齐 settingsPanelArchiveMode 的「消息分支 → 唯一写入 → 回推」形态）：
 *   ① 活动指标写既有 `memora.showMetrics`（Global），写入后回推配置真值；
 *   ② 复制诊断是动作型 kind：在 config.update 之前分流，只执行现有命令，
 *      不写幽灵配置键、不弹「保存失败」误导提示；
 *   ③ 回推值取自配置读口而非写入意图——受管设置上写入失败时 UI 复位到盘上真值。
 *
 * ⚠ 变异验证靶标：把 copyDiagnostics 分流移到 writeSetting 之后 → 本文件
 * 「不写配置」用例真红（幽灵键 + 错误 toast）；删掉 pushGeneralStatus 的
 * showMetrics 回推 → 「回推」用例真红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@zooique/memora';
import { MemoraSettingsPanel } from '../panels/settingsPanel.js';

/** 配置读口的可观测替身：读写同处一份状态，忠实于「回推读真值」语义 */
const configState = vi.hoisted(() => ({ showMetrics: false }));
const vscodeConfigMock = vi.hoisted(() => ({
  cfgGet: vi.fn((key: string, defaultValue?: unknown) => {
    if (key === 'showMetrics') return configState.showMetrics;
    return defaultValue;
  }),
  cfgUpdate: vi.fn((key: string, value: unknown) => {
    if (key === 'showMetrics') configState.showMetrics = Boolean(value);
    return Promise.resolve();
  }),
}));

/** l10n.t 替身（vi.hoisted：mock 工厂先于 import 执行） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});
const executeCommand = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('vscode', () => ({
  l10n: { t: tStub },
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
  commands: { executeCommand },
  ConfigurationTarget: { Global: 1 },
  env: { language: 'zh-cn' },
}));

type Posted = { type: string; kind?: string; value?: unknown; level?: string };

function setup(): { provider: MemoraSettingsPanel; posted: Posted[] } {
  const posted: Posted[] = [];
  const agent = { on: vi.fn(), off: vi.fn() } as unknown as Agent;
  const provider = new MemoraSettingsPanel({} as never, {} as never);
  provider.setAgentFactory(async () => agent);
  provider.setGlobalState({ get: () => undefined, update: vi.fn() } as never);
  (provider as unknown as { _panel: unknown })._panel = {
    webview: {
      postMessage: (msg: never) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  return { provider, posted };
}

function send(provider: MemoraSettingsPanel, msg: unknown): Promise<void> {
  return (provider as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(msg);
}

beforeEach(() => {
  vi.clearAllMocks();
  configState.showMetrics = false;
});

describe('settingsPanel 常规页消息路由', () => {
  it('活动指标走唯一写入封装写既有键，并按配置真值回推', async () => {
    const { provider, posted } = setup();
    await send(provider, { type: 'general_setting', kind: 'showMetrics', value: true });
    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('showMetrics', true, 1);
    expect(
      posted.filter((m) => m.type === 'general_setting' && m.kind === 'showMetrics'),
    ).toMatchObject([{ value: true }]);
    expect(posted.filter((m) => m.type === 'notice')).toEqual([]);
  });

  it('复制诊断是动作型 kind：只执行现有命令，不写配置、不误弹保存失败', async () => {
    const { provider, posted } = setup();
    await send(provider, { type: 'general_setting', kind: 'copyDiagnostics' });
    expect(executeCommand).toHaveBeenCalledWith('memora.copyDiagnostics');
    expect(vscodeConfigMock.cfgUpdate).not.toHaveBeenCalled();
    expect(posted.filter((m) => m.type === 'notice')).toEqual([]);
  });

  it('写入失败时回推盘上真值而非写入意图（不谎报已保存）', async () => {
    // 模拟受管设置：update 直接拒绝（writeSetting 的 5s 兜底在单测里不触发）
    vscodeConfigMock.cfgUpdate.mockImplementationOnce(() => Promise.reject(new Error('read only')));
    const { provider, posted } = setup();
    await send(provider, { type: 'general_setting', kind: 'showMetrics', value: true });
    expect(
      posted.filter((m) => m.type === 'general_setting' && m.kind === 'showMetrics'),
    ).toMatchObject([{ value: false }]);
    expect(posted.some((m) => m.type === 'notice' && m.level === 'error')).toBe(true);
  });
});
