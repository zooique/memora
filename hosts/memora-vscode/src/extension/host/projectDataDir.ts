/**
 * 项目数据目录单点 —— `.memora` 目录名的唯一计算点（宿主内 SSOT）
 *
 * ## 为什么单独成模块
 * 此前该目录名在宿主生产代码里有 6 处各自 `join(path, '.memora', ...)` 字面量拼接
 * （memoryStorage / sessionStore / assemble / workspaceStorage / workspaceRoundStore /
 * extension 兜底根），外加 `scripts/` 三个验证脚本的复刻——memoryStorage 里那句
 * 「唯一计算点」注释只覆盖记忆库一条路径，另几处无判据绑定（台账 HOST-DATA-DIR-1，
 * 真源 = docs/边界-图片采集UI-VSCode能力边界-20261028.md §3 B9）。
 * IMG-2 要在该目录下新增 `attachments/`，第四处拷贝出现前先收口——半截重构比不重构更糟。
 *
 * ## 守护（声明必须绑判据，否则又是一句空话）
 * - **宿主内**：`src/__tests__/dataDirLiteralGuard.test.ts` 扫生产代码字符串字面量，
 *   `'.memora'` 只允许出现在本文件（防未来再写第二份）；
 * - **跨宿主**（`hosts/memora-mcp` 跨包各自持有同名常量，无法共模块）：
 *   `src/__tests__/crossHostLayout.test.ts` 断言两宿主算出**同一数据目录** + 锚定
 *   `<工作区>/.memora`（防两侧一起改名漂移）。
 *
 * 内核不参与：按 ADR-002 内核只收全长路径，不感知目录布局（见 memoryStorage 文件头「路径语义」）。
 */
import { join } from 'node:path';

/** 项目数据目录名（本契约的字面量只许出现在本文件，见文件头「守护」） */
const DATA_DIR_NAME = '.memora';
/** 图片附件子目录名（同上：字面量唯一容身处本文件；宿主写盘点与 webview 预览 roots 同源） */
const ATTACHMENTS_DIR_NAME = 'attachments';

/**
 * 解析项目数据目录绝对路径 —— 宿主内 `.memora` 拼接的唯一入口。
 *
 * 所有落盘存储（记忆库 / 会话 / 轮次 / 内核 dataDir）与后续 `attachments/`
 * 一律经此推导，禁在调用方重复拼目录名。
 *
 * @param projectPath 项目/工作区根（须为绝对路径——相对路径基于进程 cwd，
 *   VS Code 扩展宿主 cwd 不可控，见 extension.ts resolveWorkspacePath）
 * @returns `<projectPath>/.memora`
 */
export function resolveProjectDataDir(projectPath: string): string {
  return join(projectPath, DATA_DIR_NAME);
}

/**
 * 解析图片附件目录绝对路径 —— `<数据目录>/attachments` 的唯一计算点。
 *
 * 消费双方同源（缺一即漂移）：宿主 `image_ingest` 落盘点写这里，
 * chatPanel 的 `localResourceRoots` 放行这里（悬停预览 `asWebviewUri` 指向它）。
 *
 * @param projectPath 项目/工作区根
 * @returns `<projectPath>/.memora/attachments`
 */
export function resolveAttachmentsDir(projectPath: string): string {
  return join(resolveProjectDataDir(projectPath), ATTACHMENTS_DIR_NAME);
}
