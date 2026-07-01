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
 *   - onPersonaModeChange 回调注册
 *   - mode='manual' 归一化为 manual
 *   - mode='auto' 归一化为 auto
 *   - mode='unknown' 归一化为 auto（非 manual 即 auto）
 *   - setPersonaMode set=true → toast success（自动/手动文案）
 *   - setPersonaMode set=false → toast error
 *   - setPersonaMode 异常 → handleIpcError
 * - loadPersonaList：
 *   - listPersonas 成功 → renderPersonaDropdown
 *   - 有 active persona → updateActivePersona(active.name)
 *   - 无 active persona → 不调用 updateActivePersona
 *   - getPersonaMode 成功 → updatePersonaModeBadge + setPersonaMode
 *   - getPersonaMode 失败 → reportError（不抛出，不影响列表加载）
 *   - listPersonas 失败 → reportError + showToast error
 *
 * Mock 策略：
 * - mock uiManager（onPersonaSwitch/onPersonaModeChange 保存回调，其他方法 vi.fn()）
 * - mock window.electronAPI（switchPersona/listPersonas/setPersonaMode/getPersonaMode）
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
    personaModeChangeCb: ((mode: string) => void) | null;
  };
  spies: {
    updateActivePersona: ReturnType<typeof vi.fn>;
    showToast: ReturnType<typeof vi.fn>;
    renderPersonaDropdown: ReturnType<typeof vi.fn>;
    updatePersonaModeBadge: ReturnType<typeof vi.fn>;
    setPersonaMode: ReturnType<typeof vi.fn>;
  };
} {
  const captured = {
    personaSwitchCb: null as ((name: string) => void) | null,
    personaModeChangeCb: null as ((mode: string) => void) | null,
  };
  const spies = {
    updateActivePersona: vi.fn(),
    showToast: vi.fn(),
    renderPersonaDropdown: vi.fn(),
    updatePersonaModeBadge: vi.fn(),
    setPersonaMode: vi.fn(),
  };
  const uiManager = {
    onPersonaSwitch: vi.fn((cb: (name: string) => void) => {
      captured.personaSwitchCb = cb;
    }),
    onPersonaModeChange: vi.fn((cb: (mode: string) => void) => {
      captured.personaModeChangeCb = cb;
    }),
    updateActivePersona: spies.updateActivePersona,
    showToast: spies.showToast,
    renderPersonaDropdown: spies.renderPersonaDropdown,
    updatePersonaModeBadge: spies.updatePersonaModeBadge,
    setPersonaMode: spies.setPersonaMode,
  } as unknown as UIManager;
  return { uiManager, captured, spies };
}

/** 创建 mock electronAPI（角色相关 4 个方法） */
function mockElectronAPI(overrides?: {
  switchPersona?: ReturnType<typeof vi.fn>;
  listPersonas?: ReturnType<typeof vi.fn>;
  setPersonaMode?: ReturnType<typeof vi.fn>;
  getPersonaMode?: ReturnType<typeof vi.fn>;
}): {
  switchPersona: ReturnType<typeof vi.fn>;
  listPersonas: ReturnType<typeof vi.fn>;
  setPersonaMode: ReturnType<typeof vi.fn>;
  getPersonaMode: ReturnType<typeof vi.fn>;
} {
  const switchPersona = overrides?.switchPersona ?? vi.fn().mockResolvedValue({ switched: true, name: '助手' });
  const listPersonas = overrides?.listPersonas ?? vi.fn().mockResolvedValue({ personas: [] });
  const setPersonaMode = overrides?.setPersonaMode ?? vi.fn().mockResolvedValue({ set: true });
  const getPersonaMode = overrides?.getPersonaMode ?? vi.fn().mockResolvedValue({ mode: 'auto' });
  window.electronAPI = {
    switchPersona,
    listPersonas,
    setPersonaMode,
    getPersonaMode,
  } as unknown as typeof window.electronAPI;
  return { switchPersona, listPersonas, setPersonaMode, getPersonaMode };
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
    it('应注册 onPersonaSwitch 和 onPersonaModeChange 回调', () => {
      const { uiManager, captured } = createMockUiManager();
      mockElectronAPI();
      const controller = createPersonaController(uiManager);

      controller.setupPersonaSelector();

      expect(captured.personaSwitchCb).not.toBeNull();
      expect(captured.personaModeChangeCb).not.toBeNull();
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

    it('switchPersona switched=false 不应调用 updateActivePersona / showToast', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({
        switchPersona: vi.fn().mockResolvedValue({ switched: false, name: null }),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaSwitchCb!('不存在');

      expect(spies.updateActivePersona).not.toHaveBeenCalled();
      expect(spies.showToast).not.toHaveBeenCalled();
    });

    it('switchPersona 异常应走 handleIpcError（showToast error）', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({
        switchPersona: vi.fn().mockRejectedValue(new Error('IPC 失败')),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaSwitchCb!('教师');

      // handleIpcError 会拼接错误信息：`${toastPrefix}：${errorMessage}`
      expect(spies.showToast).toHaveBeenCalledWith('切换角色失败：IPC 失败', 'error');
    });

    // ─── onPersonaModeChange 回调 ───────────────────────

    it('mode="manual" 应归一化为 manual 调用 setPersonaMode', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      const api = mockElectronAPI();
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaModeChangeCb!('manual');

      expect(api.setPersonaMode).toHaveBeenCalledWith('manual');
      expect(spies.showToast).toHaveBeenCalledWith('角色匹配模式已切换为：手动', 'success');
    });

    it('mode="auto" 应归一化为 auto 调用 setPersonaMode', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      const api = mockElectronAPI();
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaModeChangeCb!('auto');

      expect(api.setPersonaMode).toHaveBeenCalledWith('auto');
      expect(spies.showToast).toHaveBeenCalledWith('角色匹配模式已切换为：自动', 'success');
    });

    it('mode="unknown"（非 manual）应归一化为 auto', async () => {
      const { uiManager, captured } = createMockUiManager();
      const api = mockElectronAPI();
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaModeChangeCb!('unknown');

      // 未知值归一化为 auto
      expect(api.setPersonaMode).toHaveBeenCalledWith('auto');
    });

    it('setPersonaMode set=true 应 toast success（手动文案）', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({ setPersonaMode: vi.fn().mockResolvedValue({ set: true }) });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaModeChangeCb!('manual');

      expect(spies.showToast).toHaveBeenCalledWith('角色匹配模式已切换为：手动', 'success');
      // C-4：成功后应主动同步 badge + 单选按钮状态
      expect(spies.updatePersonaModeBadge).toHaveBeenCalledWith('manual');
      expect(spies.setPersonaMode).toHaveBeenCalledWith('manual');
    });

    it('setPersonaMode set=false 应 toast error', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({ setPersonaMode: vi.fn().mockResolvedValue({ set: false }) });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaModeChangeCb!('manual');

      expect(spies.showToast).toHaveBeenCalledWith('角色匹配模式切换失败', 'error');
      // C-4：IPC 拒绝切换时应回滚 UI 到旧模式（manual → 旧模式 auto）
      expect(spies.updatePersonaModeBadge).toHaveBeenCalledWith('auto');
      expect(spies.setPersonaMode).toHaveBeenCalledWith('auto');
    });

    it('setPersonaMode 异常应走 handleIpcError（showToast error）', async () => {
      const { uiManager, captured, spies } = createMockUiManager();
      mockElectronAPI({
        setPersonaMode: vi.fn().mockRejectedValue(new Error('IPC 失败')),
      });
      const controller = createPersonaController(uiManager);
      controller.setupPersonaSelector();

      await captured.personaModeChangeCb!('auto');

      expect(spies.showToast).toHaveBeenCalledWith('设置角色模式失败：IPC 失败', 'error');
      // C-4：IPC 异常时应回滚 UI 到旧模式（auto → 旧模式 manual）
      expect(spies.updatePersonaModeBadge).toHaveBeenCalledWith('manual');
      expect(spies.setPersonaMode).toHaveBeenCalledWith('manual');
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

    it('getPersonaMode 成功应调用 updatePersonaModeBadge + setPersonaMode', async () => {
      const { uiManager, spies } = createMockUiManager();
      mockElectronAPI({
        listPersonas: vi.fn().mockResolvedValue({ personas: createPersonas() }),
        getPersonaMode: vi.fn().mockResolvedValue({ mode: 'manual' }),
      });
      const controller = createPersonaController(uiManager);

      await controller.loadPersonaList();

      expect(spies.updatePersonaModeBadge).toHaveBeenCalledWith('manual');
      expect(spies.setPersonaMode).toHaveBeenCalledWith('manual');
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
      expect(spies.setPersonaMode).not.toHaveBeenCalled();
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
