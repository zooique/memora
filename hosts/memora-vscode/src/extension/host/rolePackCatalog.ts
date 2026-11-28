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
// 路径归属判据单点（与技能聚合共用；裸 startsWith 会把 `role-packs-x` 误判进 `role-packs`）
import { isPathWithin } from './userAssets/path.js';

/**
 * 角色包「按需加载器」：返回已装载的管理器（含技能枚举面），读不到返回 null
 *
 * 与目录编目同一扫描器、同一目录清单，差别只在返回值：编目只要名字，草稿页还要
 * `listSkills()`（当前角色包内嵌技能）。二者共用 {@link createRolePackLoader}，
 * 杜绝同一加载序列写两遍。
 */
export type RolePackLoader = (activeName?: string) => Promise<RolePackManager | null>;

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
 * 角色包来源层（单点判定）
 *
 * 判据与设置页「内置包只读」同源：先项目、再用户，剩下都是内置。
 * 裸 `startsWith` 会把 `role-packs-x` 误判进 `role-packs`，故一律走 `isPathWithin`。
 *
 * @param filePath 角色包 manifest.json 的绝对路径（`RolePackAssembly.filePath`）
 * @param dirs 用户级 / 项目级目录（内置不需要目录——不在前两者内即内置）
 */
export function rolePackSourceOf(
  filePath: string | undefined,
  dirs: { userRolePacksDir?: string; projectRolePacksDir?: string },
): 'builtin' | 'user' | 'project' {
  if (isPathWithin(dirs.projectRolePacksDir, filePath)) return 'project';
  return isPathWithin(dirs.userRolePacksDir, filePath) ? 'user' : 'builtin';
}

/**
 * 造一个「按需扫描」的角色包加载器（编目与草稿页技能枚举的共用加载序列）
 *
 * 每次调用新建一个 `RolePackManager` 并完整 `load()`：不做常驻缓存——缓存会把
 * 「刚删的包」读成仍存在（与角色页刷新后的真实目录不一致）。
 *
 * @param dirs 三处目录（与装配期注入同源）
 * @returns 已装载的管理器；目录读取异常时返回 `null`（= 校验/展示不可用，由调用方区分提示）
 */
export function createRolePackLoader(dirs: RolePackCatalogDirs): RolePackLoader {
  return async (activeName) => {
    try {
      const manager = new RolePackManager(dirs.configDir);
      await manager.loadExtraDir(dirs.userRolePacksDir);
      if (dirs.projectRolePacksDir) {
        // 档位必须显式传 project：内核据此裁决 project > user 的同名覆盖方向
        await manager.loadExtraDir(dirs.projectRolePacksDir, 'project');
      }
      // activeName 只在草稿页传：把「即将生效的角色包」设为内存激活态，供 listSkills() 取它内嵌技能。
      // 未传（目录编目场景）= 内核 §4.1 兜底包，行为与改造前逐字一致。
      await manager.load(activeName);
      return manager;
    } catch {
      // 目录本身读不到（权限/文件系统异常）⇒ 与「包不存在」区分，交由调用方给出不同反馈
      return null;
    }
  };
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
  const load = createRolePackLoader(dirs);
  return async () => {
    const manager = await load();
    return manager ? new Set(manager.listMeta().map((meta) => meta.name)) : null;
  };
}

/** 编目挂载目标（面板；测试可传最小替身） */
export interface RolePackCatalogTarget {
  setRolePackCatalog(reader: RolePackCatalogReader): void;
}

/**
 * 把目录编目挂到面板（宿主装配点只留一行调用，reader 构造留在本模块）
 *
 * 草稿页另需「按名取角色包技能」时，用 {@link createRolePackLoader} 单独构造，
 * 由装配点的 `DraftConfigSurface` 消费——编目与技能枚举两条注入面各有归属，不混成一个方法。
 *
 * @param target 支持挂载的面板实例（测试可传最小替身）
 * @param dirs 三处目录（与装配期注入同源）
 * @returns 已挂载的编目读面（装配点可直接复用，避免再建第二个实例扫同一批目录）
 */
export function attachRolePackCatalog(
  target: RolePackCatalogTarget,
  dirs: RolePackCatalogDirs,
): RolePackCatalogReader {
  const reader = createRolePackCatalogReader(dirs);
  target.setRolePackCatalog(reader);
  return reader;
}
