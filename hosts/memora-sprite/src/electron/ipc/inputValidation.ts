/**
 * IPC 输入验证工具
 *
 * 实现已迁移到 shared/inputValidation.ts，本模块仅作重新导出。
 *
 * 迁移原因：
 *   原实现位于 electron/ipc/ 层，Web 路由层（web/routes/*）为了避免反向依赖
 *   （electron/ipc → shared 是正确方向，shared → electron/ipc 是反向依赖），
 *   在 sessionRoutes.ts 本地复制了一份 isValidSessionName，且改用黑名单模式，
 *   导致两层校验行为不一致（Web 层比 IPC 层宽松，存在安全风险）。
 *
 *   迁移到 shared/ 层后，IPC 和 Web 都依赖 shared，架构方向正确，
 *   真理源唯一，杜绝再次出现行为分歧。
 *
 * 向后兼容：所有现有 `from './inputValidation.js'` 或
 *   `from '../../electron/ipc/inputValidation.js'` 的 import 无需修改。
 */
export {
  isValidSessionName,
  isValidConfigName,
  isValidContent,
  isValidId,
  isValidSearchQuery,
  isValidPersonaName,
  isValidFilePath,
  isPathAllowed,
  isValidRelationType,
} from '../../shared/inputValidation.js';
