/**
 * 「新建用户技能」命令回归测试
 *
 * 被测不变量（缺一条即功能带伤）：
 *   1. description 缺失 ⇒ 拒绝且**文件不落盘**（缺描述的技能会被 LLM 可见集过滤，等于白建）；
 *   2. 同名用户文件已存在 ⇒ 拒绝（不静默覆盖用户已有内容）；
 *   3. 同名内置 ⇒ 走「确认覆盖内置」弹窗路径，确认后才写；
 *   4. 写盘唯一落点 = `writeFile` 一次，且写后触发内核重扫（`resyncUserSkills`）。
 *
 * 说明：`stat` 被 mock 成可编程的「存在表」，因此不触真实文件系统；写入也只是 spy，
 * 断言的是**调用次数**而不是磁盘内容。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

/** fs 可观测桩（vi.hoisted：mock 工厂被提升，闭包外变量必须先声明） */
const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  stat: vi.fn(),
  /** 模拟「这些路径已存在」的集合（键 = 绝对路径） */
  existingPaths: new Set<string>(),
}));

/** vscode 可观测桩 */
const vsMock = vi.hoisted(() => ({
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: fsMock.mkdir,
  writeFile: fsMock.writeFile,
  stat: fsMock.stat,
}));

vi.mock('vscode', () => ({
  window: {
    showInputBox: vsMock.showInputBox,
    showWarningMessage: vsMock.showWarningMessage,
    showInformationMessage: vsMock.showInformationMessage,
  },
  commands: { executeCommand: vsMock.executeCommand },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
}));

import type { Agent } from '@zooique/memora';
import { createUserSkillCommand, writeUserSkillFile } from '../createUserSkill.js';

/** 测试用用户技能目录（绝对路径） */
const SKILLS_DIR = resolve(process.cwd(), 'tmp-user-skills');

/** 构造命令依赖（agent 桩只暴露本命令消费面） */
function setupDeps(skillNames: string[]): {
  deps: Parameters<typeof createUserSkillCommand>[0];
  resync: ReturnType<typeof vi.fn>;
  refreshSettings: ReturnType<typeof vi.fn>;
  refreshChat: ReturnType<typeof vi.fn>;
} {
  const resync = vi.fn(async () => ({ added: 0, removed: [], updated: [] }));
  const refreshSettings = vi.fn(async () => undefined);
  const refreshChat = vi.fn();
  const agent = {
    skills: {
      list: skillNames.map((name) => ({ name })),
      resyncUserSkills: resync,
    },
  } as unknown as Agent;
  return {
    deps: {
      userSkillsDir: SKILLS_DIR,
      tryGetAgent: async () => agent,
      chatProvider: { refreshSkillList: refreshChat } as never,
      settingsProvider: { refreshSkillList: refreshSettings } as never,
    },
    resync,
    refreshSettings,
    refreshChat,
  };
}

beforeEach(() => {
  fsMock.mkdir.mockClear();
  fsMock.writeFile.mockClear();
  fsMock.existingPaths.clear();
  // 默认真实文件系统的 stat：只有登记在 existingPaths 的路径才算存在
  fsMock.stat.mockImplementation(async (p: unknown) => {
    if (fsMock.existingPaths.has(resolve(String(p)))) return {};
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  vsMock.showInputBox.mockReset();
  vsMock.showWarningMessage.mockReset();
  vsMock.showInformationMessage.mockReset();
  vsMock.executeCommand.mockReset();
});

describe('writeUserSkillFile（唯一写盘实现）', () => {
  it('description 缺失 ⇒ 拒绝且不落盘', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, { name: 'demo', description: '   ' });
    expect(result.ok).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('description 含换行 ⇒ 拒绝且不落盘（换行会提前闭合 frontmatter）', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, {
      name: 'demo',
      description: '第一行\n第二行',
    });
    expect(result.ok).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('同名用户文件已存在 ⇒ 拒绝且不落盘（不静默覆盖）', async () => {
    fsMock.existingPaths.add(resolve(SKILLS_DIR, 'demo.md'));
    const result = await writeUserSkillFile(SKILLS_DIR, { name: 'demo', description: '说明' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('同名用户技能文件已存在');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('合法输入 ⇒ 唯一一次 writeFile，路径落在技能目录内', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, { name: 'demo', description: '说明' });
    expect(result.ok).toBe(true);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.filePath).toBe(resolve(SKILLS_DIR, 'demo.md'));
      const [filePath, content] = fsMock.writeFile.mock.calls[0] as unknown as [string, string];
      expect(resolve(String(filePath))).toBe(result.filePath);
      // frontmatter 值不裹引号（内核 parseFrontmatter 不剥引号）
      expect(String(content)).toContain('description: 说明');
      expect(String(content)).not.toContain('description: "');
    }
  });
});

describe('createUserSkillCommand（命令面板与设置页共用入口）', () => {
  it('同名内置 ⇒ 必须走覆盖确认；用户放弃则不写盘', async () => {
    vsMock.showInputBox.mockResolvedValueOnce('builtin-skill'); // 名字
    vsMock.showWarningMessage.mockResolvedValueOnce(undefined); // 覆盖确认：放弃
    const { deps, resync } = setupDeps(['builtin-skill']);

    await createUserSkillCommand(deps);

    expect(vsMock.showWarningMessage).toHaveBeenCalledTimes(1);
    // 文案须说清「会发生什么」：明确写「会覆盖内置技能「X」」，不靠用户猜
    expect(vsMock.showWarningMessage.mock.calls[0][0]).toContain('会覆盖内置技能「builtin-skill」');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });

  it('同名内置 + 用户确认 ⇒ 写盘一次并触发重扫 + 双通道刷新', async () => {
    vsMock.showInputBox.mockResolvedValueOnce('builtin-skill').mockResolvedValueOnce('覆盖说明');
    vsMock.showWarningMessage.mockResolvedValueOnce('继续覆盖');
    vsMock.showInformationMessage.mockResolvedValueOnce(undefined);
    const { deps, resync, refreshSettings, refreshChat } = setupDeps(['builtin-skill']);

    await createUserSkillCommand(deps);

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(refreshSettings).toHaveBeenCalledTimes(1);
    expect(refreshChat).toHaveBeenCalledTimes(1);
    expect(vsMock.showInformationMessage.mock.calls[0][0]).toContain(
      resolve(SKILLS_DIR, 'builtin-skill.md'),
    );
  });

  it('描述留空 ⇒ 命令链路也拒绝且不落盘（写盘函数二次校验，不依赖输入框校验）', async () => {
    vsMock.showInputBox.mockResolvedValueOnce('demo').mockResolvedValueOnce('   ');
    const { deps, resync } = setupDeps([]);

    await createUserSkillCommand(deps);

    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(vsMock.showWarningMessage).toHaveBeenCalled();
  });

  it('名字含路径分隔符 ⇒ 命令入口拒绝且不落盘', async () => {
    vsMock.showInputBox.mockResolvedValueOnce('a/b');
    const { deps } = setupDeps([]);

    await createUserSkillCommand(deps);

    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(vsMock.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
