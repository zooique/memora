/**
 * 设置面板「用户资产创建 / 重扫」消息路由回归测试
 *
 * 被测不变量：
 *   1. `skills_create_request` / `roles_create_request` 只做**路由**：各调用一次对应命令
 *      （命令处理器是唯一实现，webview 侧零写盘）；
 *   2. `skills_refresh` 触发内核**真实重扫**（`resyncUserSkills`），不是「读内存快照」的
 *      `skills_load`——这是「建了不生效」的修复点。
 *
 * 「两个入口同一实现」的断言分两半：
 *   - 本文件：webview 消息 → `executeCommand('memora.createSkill')` 恰好一次、面板零 writeFile；
 *   - `createUserSkill.test.ts` / `createRolePack.test.ts`：命令处理器内部 `writeFile` 恰好一次。
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

vi.mock('vscode', () => ({
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
import { CREATE_ROLE_PACK_COMMAND, CREATE_SKILL_COMMAND } from '../../shared/constants.js';

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

describe('新建入口只路由到命令处理器（webview 零写盘）', () => {
  it('skills_create_request ⇒ executeCommand(memora.createSkill) 一次，且不写盘', async () => {
    const { provider } = setup();
    await dispatch(provider, { type: 'skills_create_request' });

    expect(vsMock.executeCommand).toHaveBeenCalledTimes(1);
    expect(vsMock.executeCommand.mock.calls[0][0]).toBe(CREATE_SKILL_COMMAND);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('roles_create_request ⇒ executeCommand(memora.createRolePack) 一次，且不写盘', async () => {
    const { provider } = setup();
    await dispatch(provider, { type: 'roles_create_request' });

    expect(vsMock.executeCommand).toHaveBeenCalledTimes(1);
    expect(vsMock.executeCommand.mock.calls[0][0]).toBe(CREATE_ROLE_PACK_COMMAND);
    expect(writeFileMock).not.toHaveBeenCalled();
  });
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
