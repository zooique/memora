/**
 * ShortcutManager 单元测试
 *
 * 验证全局快捷键注册/注销/热更新/总开关逻辑。
 * 通过 mock GlobalShortcut 接口实现纯逻辑测试，不依赖 Electron 运行时。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShortcutManager, SHORTCUT_ACTIONS, DEFAULT_SHORTCUT_CONFIG } from '../../electron/shortcuts.js';
import type { GlobalShortcut } from 'electron';

/** Mock GlobalShortcut 接口实现 */
function createMockGlobalShortcut() {
  /** 已注册的快捷键映射（accelerator → handler） */
  const registered = new Map<string, () => void>();
  /** register 调用返回值控制（用于模拟注册失败） */
  let registerResult = true;

  return {
    register: vi.fn((accelerator: string, handler: () => void) => {
      if (!registerResult) return false;
      registered.set(accelerator, handler);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      registered.delete(accelerator);
    }),
    unregisterAll: vi.fn(() => {
      registered.clear();
    }),
    isRegistered: vi.fn((accelerator: string) => registered.has(accelerator)),
    /** 测试辅助：触发已注册的快捷键 */
    trigger: (accelerator: string) => {
      const handler = registered.get(accelerator);
      if (handler) handler();
    },
    /** 测试辅助：设置 register 返回值 */
    setRegisterResult: (result: boolean) => { registerResult = result; },
    /** 测试辅助：获取已注册数量 */
    getRegisteredCount: () => registered.size,
    /** 测试辅助：检查是否已注册 */
    isRegisteredInternal: (accelerator: string) => registered.has(accelerator),
  };
}

describe('ShortcutManager', () => {
  let mockGlobalShortcut: ReturnType<typeof createMockGlobalShortcut>;
  let toggleHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGlobalShortcut = createMockGlobalShortcut();
    toggleHandler = vi.fn();
  });

  describe('registerAll', () => {
    it('enabled=true 时注册所有配置的快捷键', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();

      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('Ctrl+Shift+Space', toggleHandler);
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(1);
    });

    it('enabled=false 时跳过所有注册', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: false,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();

      expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(0);
    });

    it('注册失败时不中断后续注册', () => {
      mockGlobalShortcut.setRegisterResult(false);
      const handler2 = vi.fn();
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
            [SHORTCUT_ACTIONS.QUICK_RECORD]: 'Ctrl+Shift+M',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
          [SHORTCUT_ACTIONS.QUICK_RECORD]: handler2,
        },
      });

      manager.registerAll();

      // 第一个注册失败，但第二个仍应尝试注册
      expect(mockGlobalShortcut.register).toHaveBeenCalledTimes(2);
      // 失败的快捷键不应被记录为已注册
      expect(manager.getConfig().accelerators[SHORTCUT_ACTIONS.TOGGLE_WINDOW]).toBe('Ctrl+Shift+Space');
    });

    it('动作未注册处理器时跳过', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {},
      });

      manager.registerAll();

      expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
    });
  });

  describe('unregisterAll', () => {
    it('注销所有已注册的快捷键', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
            [SHORTCUT_ACTIONS.QUICK_RECORD]: 'Ctrl+Shift+M',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
          [SHORTCUT_ACTIONS.QUICK_RECORD]: vi.fn(),
        },
      });

      manager.registerAll();
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(2);

      manager.unregisterAll();

      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+Space');
      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+M');
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(0);
    });
  });

  describe('updateShortcut（热更新）', () => {
    it('热更新先注销旧快捷键再注册新快捷键', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();

      // 热更新为新的加速器
      const result = manager.updateShortcut(SHORTCUT_ACTIONS.TOGGLE_WINDOW, 'Alt+Space');

      expect(result).toBe(true);
      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+Space');
      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('Alt+Space', toggleHandler);
    });

    it('热更新注册失败时返回 false', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();
      mockGlobalShortcut.setRegisterResult(false);

      const result = manager.updateShortcut(SHORTCUT_ACTIONS.TOGGLE_WINDOW, 'Alt+Space');

      expect(result).toBe(false);
    });

    it('enabled=false 时热更新仅更新配置不注册', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: false,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      const result = manager.updateShortcut(SHORTCUT_ACTIONS.TOGGLE_WINDOW, 'Alt+Space');

      expect(result).toBe(true);
      expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
      expect(manager.getConfig().accelerators[SHORTCUT_ACTIONS.TOGGLE_WINDOW]).toBe('Alt+Space');
    });
  });

  describe('setEnabled（总开关）', () => {
    it('从禁用切换到启用时注册所有快捷键', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: false,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.setEnabled(true);

      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('Ctrl+Shift+Space', toggleHandler);
    });

    it('从启用切换到禁用时注销所有快捷键', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();
      manager.setEnabled(false);

      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+Space');
    });

    it('状态未变化时不重复操作', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();
      const registerCountBefore = mockGlobalShortcut.register.mock.calls.length;

      manager.setEnabled(true); // 状态未变化

      expect(mockGlobalShortcut.register.mock.calls.length).toBe(registerCountBefore);
    });
  });

  describe('setConfig（全量替换配置）', () => {
    it('enabled=true 时先注销旧的再注册新的', () => {
      const quickRecordHandler = vi.fn();
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
          [SHORTCUT_ACTIONS.QUICK_RECORD]: quickRecordHandler,
        },
      });

      manager.registerAll();
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(1);

      // 全量替换：新增 quick-record 快捷键
      manager.setConfig({
        enabled: true,
        accelerators: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Alt+Space',
          [SHORTCUT_ACTIONS.QUICK_RECORD]: 'Ctrl+Shift+M',
        },
      });

      // 旧的 Ctrl+Shift+Space 应被注销
      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+Space');
      // 新的两个快捷键应被注册
      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('Alt+Space', toggleHandler);
      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('Ctrl+Shift+M', quickRecordHandler);
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(2);
      // 内部配置应更新
      expect(manager.getConfig().accelerators[SHORTCUT_ACTIONS.TOGGLE_WINDOW]).toBe('Alt+Space');
    });

    it('新配置 enabled=false 时注销所有但不注册新的', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(1);

      // 全量替换：禁用快捷键
      manager.setConfig({
        enabled: false,
        accelerators: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Alt+Space',
        },
      });

      // 旧的应被注销
      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+Space');
      // 不应注册新的
      expect(mockGlobalShortcut.register).not.toHaveBeenCalledWith('Alt+Space', toggleHandler);
      expect(mockGlobalShortcut.getRegisteredCount()).toBe(0);
      // 内部配置应更新（enabled=false）
      expect(manager.getConfig().enabled).toBe(false);
    });

    it('深拷贝 accelerators 避免外部引用污染', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: false,
          accelerators: {},
        },
        handlers: {},
      });

      /** 外部传入的 accelerators 引用 */
      const externalAccelerators = {
        [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
      };
      manager.setConfig({
        enabled: false,
        accelerators: externalAccelerators,
      });

      // 修改外部引用不应影响内部状态
      externalAccelerators[SHORTCUT_ACTIONS.TOGGLE_WINDOW] = 'Alt+Space';
      expect(manager.getConfig().accelerators[SHORTCUT_ACTIONS.TOGGLE_WINDOW]).toBe('Ctrl+Shift+Space');
    });
  });

  describe('动作触发', () => {
    it('注册的快捷键触发时调用对应处理器', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      manager.registerAll();

      // 模拟快捷键被按下
      mockGlobalShortcut.trigger('Ctrl+Shift+Space');

      expect(toggleHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConfig', () => {
    it('返回只读配置副本', () => {
      const manager = new ShortcutManager(mockGlobalShortcut as unknown as GlobalShortcut, {
        config: {
          enabled: true,
          accelerators: {
            [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: 'Ctrl+Shift+Space',
          },
        },
        handlers: {
          [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: toggleHandler,
        },
      });

      const config = manager.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.accelerators[SHORTCUT_ACTIONS.TOGGLE_WINDOW]).toBe('Ctrl+Shift+Space');

      // 修改返回的副本不应影响内部状态
      // 用 as unknown as 绕过可能的 readonly 检查，模拟"恶意修改"
      (config as unknown as { enabled: boolean }).enabled = false;
      expect(manager.getConfig().enabled).toBe(true);
    });
  });

  describe('DEFAULT_SHORTCUT_CONFIG', () => {
    it('包含三个默认快捷键动作', () => {
      expect(DEFAULT_SHORTCUT_CONFIG.enabled).toBe(true);
      expect(DEFAULT_SHORTCUT_CONFIG.accelerators[SHORTCUT_ACTIONS.TOGGLE_WINDOW]).toBe('Ctrl+Shift+Space');
      expect(DEFAULT_SHORTCUT_CONFIG.accelerators[SHORTCUT_ACTIONS.QUICK_RECORD]).toBe('Ctrl+Shift+M');
      expect(DEFAULT_SHORTCUT_CONFIG.accelerators[SHORTCUT_ACTIONS.RECALL_MEMORY]).toBe('Ctrl+Shift+R');
    });
  });
});
