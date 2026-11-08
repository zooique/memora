/**
 * 角色包目录编目（宿主侧独立读取面 · 建会话默认包校验的唯一真相源）
 *
 * 为什么需要它：建会话校验「默认角色包是否存在」不能依赖「已装配的 Agent 实例」——
 * 冷启动第一个会话时还没有任何实例，旧实现据此乐观放行，把已失效的默认名当真选过的包
 * 写进了 `SessionMeta`（详见 newSessionRolePack.ts 模块头的「历史事实」段）。
 *
 * 真相源 = 内核 `RolePackManager`：与装配期（assemble.ts 的 `loadExtraDir`）和角色页
 * （`listMeta()`）**同一个扫描器、同一份目录清单**，本模块不另写扫描/解析逻辑。
 * 三处目录由 extension.ts 单点解析后传入（内置 configDir / 用户级 / 项目级），
 * 与装配注入顺序一致（内置 → 用户 → 项目，后加载者胜）。
 */
import { RolePackManager } from '@zooique/memora';
import type { RolePackCatalogReader } from './newSessionRolePack.js';

/** 编目所需的目录清单（与装配期注入完全同源，解析点唯一 = extension.ts） */
export interface RolePackCatalogDirs {
  /** 内置角色包根目录（内核扫 `<configDir>/role-packs/`） */
  configDir: string;
  /** 用户级角色包目录（`globalStorageUri/role-packs`） */
  userRolePacksDir: string;
  /** 项目级角色包目录（未信任/不存在时为空） */
  projectRolePacksDir?: string;
}

/**
 * 造一个「按需扫描」的编目读取面
 *
 * 每次调用新建一个 `RolePackManager` 并完整 `load()`：编目只在建会话时用一次，
 * 不做常驻缓存——缓存会把「刚删的包」读成仍存在（与角色页刷新后的真实目录不一致）。
 *
 * @returns 目录内全部角色包名；目录读取异常时返回 `null`（= 校验不可用，由调用方区分提示）
 */
export function createRolePackCatalogReader(dirs: RolePackCatalogDirs): RolePackCatalogReader {
  return async () => {
    try {
      const manager = new RolePackManager(dirs.configDir);
      await manager.loadExtraDir(dirs.userRolePacksDir);
      if (dirs.projectRolePacksDir) {
        // 档位必须显式传 project：内核据此裁决 project > user 的同名覆盖方向
        await manager.loadExtraDir(dirs.projectRolePacksDir, 'project');
      }
      await manager.load();
      return new Set(manager.listMeta().map((meta) => meta.name));
    } catch {
      // 目录本身读不到（权限/文件系统异常）⇒ 与「包不存在」区分，交由调用方给出不同反馈
      return null;
    }
  };
}

/**
 * 把目录编目挂到对话面板（宿主装配点只留一行调用，reader 构造留在本模块）
 *
 * @param target 只需 `setRolePackCatalog` 一个方法（面板实例；测试可传最小替身）
 * @param dirs 三处目录（与装配期注入同源）
 */
export function attachRolePackCatalog(
  target: { setRolePackCatalog(reader: RolePackCatalogReader): void },
  dirs: RolePackCatalogDirs,
): void {
  target.setRolePackCatalog(createRolePackCatalogReader(dirs));
}
