/**
 * 角色面板控制器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - setupPersonaSelector：
 *   - onPersonaSwitch 回调注册
 *   - switchPersona 成功（switched=true）→ updateActivePersona + showToast success
 *   - switchPersona switched=false → 不更新 UI / 不 toast
 *   - switchPersona 异常 → handleIpcError（showToast error）
 * - loadPersonaList：
 *   - listPersonas 成功 → renderPersonaDropdown
 *   - 有 active persona → updateActivePersona(active.name)
 *   - 无 active persona → 不调用 updateActivePersona
 *   - getPersonaMode 成功 → updatePersonaModeBadge
 *   - getPersonaMode 失败 → reportError（不抛出，不影响列表加载）
 *   - listPersonas 失败 → reportError + showToast error
 *
 * 说明：角色匹配模式持久化由精灵设定面板（settingsManagerPanel.onPersonaModeChange）
 * 独立负责，本控制器不再注册 onPersonaModeChange 回调，故不覆盖相关用例。
 *
 * Mock 策略：
 * - mock uiManager（onPersonaSwitch 保存回调，其他方法 vi.fn()）
 * - mock window.electronAPI（switchPersona/listPersonas/getPersonaMode）
 * - 不依赖真实 DOM（控制器层纯逻辑，UI 委托给 uiManager）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPersonaController } from '../../../electron/renderer/controllers/personaController.js';
import type { UIManager } from '../../../electron/renderer/ui.js';

// ─── 类型定义 ─────────────────────────────────────────────

/** 角色列表项类型（对齐 PersonaItem） */
interface PersonaItem {
  name: string;
  description: string;
  active: boolean;
}

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock uiManager，回调注册时保存到 captured 变量 */
function createMockUiManager(): {
  uiManager: UIManager;
  captured: {
    personaSwitchCb: ((name: string) => void) | null;
  };
  spies: {
    updateActivePersona: ReturnType<typeof vi.fn>;
    showToast: ReturnType<typeof vi.fn>;
    renderPersonaDropdown: ReturnType<typeof vi.fn>;
    updatePersonaModeBadge: ReturnType<typeof vi.fn>;
  };
} {
  const captured = {
    personaSwitchCb: null as ((name: string) => void) | null,
  };
  const spies = {
    updateActivePersona: vi.fn(),
    showToast: vi.fn(),
    renderPersonaDropdown: vi.fn(),
    updatePersonaModeBadge: vi.fn(),
  };
  const uiManager = {
    onPersonaSwitch: vi.fn((cb: (name: string) => void) => {
      captured.personaSwitchCb = cb;
    }),
    updateActivePersona: spies.updateActivePersona,
    showToast: spies.showToast,
    renderPersonaDropdown: spies.renderPersonaDropdown,
    updatePersonaModeBadge: spies.updatePersonaModeBadge,
  } as unknown as UIManager;
  return { uiManager, captured, spies };
}

/** 创建 mock electronAPI（角色相关 3 个方法） */
function mockElectronAPI(overrides?: {
  switchPersona?: ReturnType<typeof vi.fn>;
  listPersonas?: ReturnType<typeof vi.fn>;
  getPersonaMode?: ReturnType<typeof vi.fn>;
}): {
  switchPersona: ReturnType<typeof vi.fn>;
  listPersonas: ReturnType<typeof vi.fn>;
  getPersonaMode: ReturnType<typeof vi.fn>;
} {
  const switchPersona = overrides?.switchPersona ?? vi.fn().mockResolvedValue({ switched: true, name: '助手' });
  const listPersonas = overrides?.listPersonas ?? vi.fn().mockResolvedValue({ personas: [] });
  const getPersonaMode = overrides?.getPersonaMode ?? vi.fn().mockResolvedValue({ mode: 'auto' });
  window.electronAPI = {
    switchPersona,
    listPersonas,
    getPersonaMode,
  } as unknown as typeof window.electronAPI;
  return { switchPersona, listPersonas, getPersonaMode };
}

/** 创建角色列表测试数据 */
function createPersonas(opts?: { activeName?: string }): PersonaItem[] {
  return [
    { name: '助手', description: '默认助手', active: opts?.activeName === '助手' },
    { name: '教师', description: '教学角色', active: opts?.activeName === '教师' },
    { name: '朋友', description: '陪伴角色', active: opts?.activeName === '朋友' },
  ];
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('createPersonaController', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 抑制 reportError 的 console.error 输出（避免污染测试输出）
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    // 清理 window.electronAPI
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  // ─── setupPersonaSelector ──────────────────────────────

  describe('setupPersonaSelector', () => {
    it('应注册 onPersonaSwitch 回调', () => {
      const { uiManager, captured } = createMockUiManager();
      mockElectronAPI();
      const controller = createPersonaController(uiManager);

      controller.setupPersonaSelector();

      expect(captured.personaSwitchCb).not.toBeNull();
    });

    // ─── onPersonaSwitch 回调 ───────────────────────────

    it('switchPersona 成功（switched=true）应调用 updateActivePersona + showToast success', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({
        switchPersona: vi.fn().mockResolvedValue({ switched: true, name: '教师' }),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      // 手动触发回调
      await captured.personaSwitchCb!('教师');

      expect(window.electronAPI.switchPersona).toHaveBeenCalledWith('教师');
      expect(spies.updateActivePersona).toHaveBeenCalledWith('教师');
      expect(spies.showToast).toHaveBeenCalledWith('已切换到角色：教师', 'success');
    });

    it('switchPersona switched=false + reason=not_found 应显示 warning toast（P0-2 信息可见性）', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({
        switchPersona: vi.fn().mockResolvedValue({
          switched: false,
          name: null,
          reason: 'not_found',
        }),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaSwitchCb!('不存在');

      // P0-2 新行为：失败时按 reason 显示具体原因（warning toast），而非静默无反馈
      expect(spies.updateActivePersona).not.toHaveBeenCalled();
      expect(spies.showToast).toHaveBeenCalledWith(
        expect.stringContaining('不存在'),
        'warning',
      );
    });

    it('switchPersona switched=false + reason=locked 应显示剩余锁定时长', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      const unlockAt = Date.now() + 300_000;
      mockElectronAPI({
        switchPersona: vi.fn().mockResolvedValue({
          switched: false,
          name: 'default',
          reason: 'locked',
          unlockAt,
        }),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaSwitchCb!('coder');

      // 锁定 toast 应包含"锁定"和"分钟"
      expect(spies.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/锁定.*分钟/),
        'warning',
      );
    });

    it('switchPersona switched=false + reason=busy 应显示对话进行中提示', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({
        switchPersona: vi.fn().mockResolvedValue({
          switched: false,
          name: null,
          reason: 'busy',
        }),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaSwitchCb!('coder');

      expect(spies.showToast).toHaveBeenCalledWith(
        expect.stringContaining('对话进行中'),
        'warning',
      );
    });

    it('switchPersona 异常应走 handleIpcError（showToast error）', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({
        switchPersona: vi.fn().mockRejectedValue(new Error('IPC 失败')),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaSwitchCb!('教师');

      // handleIpcError 走 formatErrorMessage：'IPC 失败' 不匹配 ERROR_PATTERNS，回退两段式
      expect(spies.showToast).toHaveBeenCalledWith('切换角色失败，请稍后重试', 'error');
    });
  });

  // ─── loadPersonaList ──────────────────────────────────

  describe('loadPersonaList', () => {
    it('listPersonas 成功应调用 renderPersonaDropdown', async () => {
      const { uiManager, spies } = createMockUiManager();
      const personas = createPersonas({ activeName: '助手' });
      mockElectronAPI({
        listPersonas: vi.fn().mockResolvedValue({ personas }),
      });
      const controller = createPersonaController(uiManager);

      await controller.loadPersonaList();

      expect(spies.renderPersonaDropdown).toHaveBeenCalledWith(personas);
    });

    it('有 active persona 应调用 updateActivePersona(active.name)', async () => {
      const { uiManager, spies } = createMockUiManager();
      const personas = createPersonas({ activeName: '教师' });
      mockElectronAPI({
        listPersonas: vi.fn().mockResolvedValue({ personas }),
      });
      const controller = createPersonaController(uiManager);

      await controller.loadPersonaList();

      expect(spies.updateActivePersona).toHaveBeenCalledWith('教师');
    });

    it('无 active persona 不应调用 updateActivePersona', async () => {
      const { uiManager, spies } = createMockUiManager();
      // 所有 active=false
      const personas: PersonaItem[] = [
        { name: 'A', description: 'a', active: false },
        { name: 'B', description: 'b', active: false },
      ];
      mockElectronAPI({
        listPersonas: vi.fn().mockResolvedValue({ personas }),
      });
      const controller = createPersonaController(uiManager);

      await controller.loadPersonaList();

      expect(spies.updateActivePersona).not.toHaveBeenCalled();
    });

    it('getPersonaMode 成功应调用 updatePersonaModeBadge', async () => {
      const { uiManager, spies } = createMockUiManager();
      mockElectronAPI({
        listPersonas: vi.fn().mockResolvedValue({ personas: createPersonas() }),
        getPersonaMode: vi.fn().mockResolvedValue({ mode: 'manual' }),
      });
      const controller = createPersonaController(uiManager);

      await controller.loadPersonaList();

      expect(spies.updatePersonaModeBadge).toHaveBeenCalledWith('manual');
    });

    it('getPersonaMode 失败应 reportError（不抛出，不影响列表加载）', async () => {
      const { uiManager, spies } = createMockUiManager();
      mockElectronAPI({
        listPersonas: vi.fn().mockResolvedValue({ personas: createPersonas({ activeName: '助手' }) }),
        getPersonaMode: vi.fn().mockRejectedValue(new Error('mode 加载失败')),
      });
      const controller = createPersonaController(uiManager);

      // 不应抛出
      await expect(controller.loadPersonaList()).resolves.toBeUndefined();

      // 列表仍应正常渲染
      expect(spies.renderPersonaDropdown).toHaveBeenCalled();
      expect(spies.updateActivePersona).toHaveBeenCalledWith('助手');
      // mode 相关不应被调用
      expect(spies.updatePersonaModeBadge).not.toHaveBeenCalled();
    });

    it('listPersonas 失败应 reportError + showToast error', async () => {
      const { uiManager, spies } = createMockUiManager();
      mockElectronAPI({
        listPersonas: vi.fn().mockRejectedValue(new Error('列表加载失败')),
      });
      const controller = createPersonaController(uiManager);

      await controller.loadPersonaList();

      expect(spies.renderPersonaDropdown).not.toHaveBeenCalled();
      expect(spies.showToast).toHaveBeenCalledWith('加载角色列表失败，请检查连接后重试', 'error');
    });
  });
});
