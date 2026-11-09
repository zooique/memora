/**
 * 设置面板「用户资产刷新」消息路由回归测试
 *
 * 被测不变量：
 *   `skills_refresh` 触发内核**真实重扫**（`resyncUserSkills`），不是「读内存快照」的
 *   `skills_load`——这是「建了不生效」的修复点，也是表单新建入口剪除后唯一保留的用户资产
 *   webview 通道（创建能力改由「对话写入 + 压缩包导入」承接，见台账 UI-CREATE-PRUNE-1）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

/** vscode 可观测桩 */
const vsMock = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  createWebviewPanel: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}));

/** fs 写入桩：面板侧必须零写入 */
const writeFileMock = vi.hoisted(() => vi.fn(async () => undefined));

/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行，import 绑定不可用） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

vi.mock('vscode', () => ({
  l10n: { t: tStub },
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined), update: vi.fn() })),
  },
  window: {
    showWarningMessage: vsMock.showWarningMessage,
    showErrorMessage: vsMock.showErrorMessage,
    showInformationMessage: vi.fn(),
    createWebviewPanel: vsMock.createWebviewPanel,
  },
  commands: { executeCommand: vsMock.executeCommand },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: 1 },
  env: { language: 'zh-cn' },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: writeFileMock };
});

import type { Agent } from '@zooique/memora';
import { MemoraSettingsPanel } from '../panels/settingsPanel.js';

/** 技能目录（绝对路径） */
const SKILLS_DIR = resolve(process.cwd(), 'tmp-panel-skills');
/** 内置配置目录（loadSkills 需要） */
const CONFIG_DIR = resolve(process.cwd(), 'tmp-panel-config');

/** agent 桩：技能面只暴露本组用例消费的成员 */
function agentStub(): { agent: Agent; resync: ReturnType<typeof vi.fn> } {
  const resync = vi.fn(async () => ({ added: 1, removed: [], updated: [] }));
  const agent = {
    skills: {
      list: [],
      disabledSkillNames: [],
      resyncUserSkills: resync,
      validateFile: vi.fn(async () => ({ ok: true, issues: [] })),
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Agent;
  return { agent, resync };
}

/** 构造 provider（注入 agent 工厂 + 目录 + 可捕获 postMessage 的伪面板） */
function setup(): {
  provider: MemoraSettingsPanel;
  agent: Agent;
  resync: ReturnType<typeof vi.fn>;
  posted: { type: string }[];
} {
  const { agent, resync } = agentStub();
  const posted: { type: string }[] = [];
  const provider = new MemoraSettingsPanel({} as never, {} as never);
  provider.setAgentFactory(async () => agent);
  provider.setUserSkillsDir(SKILLS_DIR);
  provider.setConfigDir(CONFIG_DIR);
  (provider as unknown as { _panel: unknown })._panel = {
    webview: {
      postMessage: (msg: never) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  return { provider, agent, resync, posted };
}

/** 走面板真实入口（handleMessage），钉的是行为而非私有字段 */
function dispatch(provider: MemoraSettingsPanel, msg: unknown): Promise<void> {
  return (provider as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(msg);
}

beforeEach(() => {
  vsMock.executeCommand.mockReset();
  writeFileMock.mockClear();
});

describe('技能刷新 = 真实重扫（不是读内存快照）', () => {
  it('skills_refresh ⇒ 调 resyncUserSkills 并回推 skills_loaded', async () => {
    const { provider, resync, posted } = setup();
    await dispatch(provider, { type: 'skills_refresh' });

    expect(resync).toHaveBeenCalledTimes(1);
    // 净差对账 notice + 列表回推（两者都不可省）
    expect(posted.some((m) => m.type === 'notice')).toBe(true);
    expect(posted.some((m) => m.type === 'skills_loaded')).toBe(true);
    // 刷新链路不应写盘
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
