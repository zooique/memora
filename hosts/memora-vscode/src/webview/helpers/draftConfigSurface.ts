/**
 * 草稿页配置面 —— 无 Agent 时的技能三源聚合（草稿技能下拉的数据源）
 *
 * 为什么需要它：草稿页（无会话 id）按红线**不装配 Agent**，而 `listVisibleSkills` 的
 * 技能源（`agent.skills` / `agent.rolePackManager`）来自 Agent。本模块用宿主独立构造的
 * 内核管理器提供同一形状的源，**复用同一个聚合函数**，不另写第二套去重/排序/禁用标注。
 *
 * 加载顺序与装配期逐字一致（见 `extension/host/assemble.ts`）：
 *   内置 `load()` → 禁用集 → 用户目录 → 项目目录（后加载者胜）。
 * 角色包源由注入的 `RolePackLoader` 按「草稿即将生效的角色包名」装载（与角色页同一扫描器）。
 *
 * 禁用集走宿主唯一读点（`skillSync.readDisabledSkills`），面板不再各读一份配置。
 * 降级：任一源读不到 ⇒ 该源为空（不清屏、不报错）——配置面读不到 ≠ 会话坏了。
 */
import { SkillManager } from '@zooique/memora';
import type { SkillDto } from '../../shared/protocol.js';
import type { RolePackLoader } from '../../extension/host/rolePackCatalog.js';
import { listVisibleSkills } from '../../extension/host/skillAggregation.js';
// 禁用集唯一读点（`memora.disabledSkills`）：面板不再各读一份，避免两源分叉
import { readDisabledSkills } from '../../extension/host/skillSync.js';

/** 草稿配置面聚合所需的注入项（宿主装配点持有全部来源，本模块不自行读配置） */
export interface DraftConfigSurfaceDeps {
  /** 系统内置配置目录（技能在 `<configDir>/skills/`） */
  configDir: string;
  /** 用户级技能目录（`globalStorage/skills`） */
  userSkillsDir: string;
  /** 项目级技能目录（未信任工作区时为空 = 不注入，与装配期信任门同向） */
  projectSkillsDir?: string;
  /** 草稿「即将生效」的角色包名（未选 = 用户级默认 / 内核兜底包） */
  rolePackName: string;
  /** 角色包加载器（与目录编目同一扫描器；读不到返回 null） */
  loadRolePackManager: RolePackLoader;
}

/**
 * 装载全局技能池（内置 + 用户 + 项目，含禁用集）
 *
 * @returns 已装载的管理器；扫描异常时返回 null（调用方按「该源为空」降级）
 */
async function loadGlobalSkills(deps: DraftConfigSurfaceDeps): Promise<SkillManager | null> {
  try {
    const skills = new SkillManager(deps.configDir);
    await skills.load();
    // 禁用集在 load 之后设（load 会整体替换 items，先设会被冲掉——与装配期注释同源）
    const disabledSkills = readDisabledSkills();
    if (disabledSkills.length > 0) skills.setDisabledSkills(disabledSkills);
    if (deps.userSkillsDir) await skills.loadExtraDir(deps.userSkillsDir);
    // 档位必须显式传 project：内核据此裁决 项目 > 用户 > 内置 的同名覆盖方向
    if (deps.projectSkillsDir) await skills.loadExtraDir(deps.projectSkillsDir, 'project');
    return skills;
  } catch {
    return null;
  }
}

/**
 * 草稿页技能清单（与设置页 / 会话页同一份 `listVisibleSkills` 口径）
 *
 * @param deps 全部来源（见 {@link DraftConfigSurfaceDeps}）
 * @returns 技能 DTO 列表（含 `layer` / `disabled` / 覆盖事实）；两源都为空时返回空数组
 */
export async function buildDraftSkillList(deps: DraftConfigSurfaceDeps): Promise<SkillDto[]> {
  const skills = await loadGlobalSkills(deps);
  const rolePackManager = await deps.loadRolePackManager(deps.rolePackName);
  return listVisibleSkills({
    // 草稿没有 Agent：用两个独立管理器提供与会话页相同的技能源形状
    agent: { skills, rolePackManager },
    configDir: deps.configDir,
    userSkillsDir: deps.userSkillsDir,
    projectSkillsDir: deps.projectSkillsDir,
  });
}

/**
 * 草稿配置面控制器（宿主装配点构造一个实例，面板只持 `push` 一个回调）
 *
 * 为什么不放面板类里：面板受 `max-lines` 约束，且「代际守卫 + 来源是否可用」属配置面自身语义，
 * 与对话状态无关——放这里既能单测，也不挤占面板行数。
 */
export class DraftConfigSurface {
  /** 代际号：每次推送自增，用于丢弃「await 期间页面已变」的过期结果 */
  private epoch = 0;

  constructor(
    /** 取草稿态实时状态：[是否草稿, 草稿即将生效的角色包名] */
    private readonly state: () => [isDraft: boolean, rolePackName: string],
    /** 取配置目录与加载器（读不到 / 未注入返回 null = 此刻不推） */
    private readonly sources: () => Omit<DraftConfigSurfaceDeps, 'rolePackName'> | null,
    /** 投递口（面板 post `skills_loaded`） */
    private readonly post: (skills: SkillDto[]) => void,
  ) {}

  /**
   * 重推草稿页技能清单（无 Agent 的独立聚合）
   *
   * 非草稿 / 来源不可用时静默跳过；过期的异步结果一律丢弃。
   */
  async push(): Promise<void> {
    const source = this.sources();
    if (!source || !this.state()[0]) return;
    const current = ++this.epoch;
    const skills = await buildDraftSkillList({ ...source, rolePackName: this.state()[1] });
    // 二次校验：期间已离开草稿 / 又发过一轮（换角色包）⇒ 旧结果不得盖回新页面
    if (current !== this.epoch || !this.state()[0]) return;
    this.post(skills);
  }
}
