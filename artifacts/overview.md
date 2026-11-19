# 本轮交付概览 · 真机首轮回填 + create_session 会话卡（2026-11-19）

## 做了什么
用户真机实测 3 项反馈：通过的回填测试台账，发现的体验缺口按 SSOT/自然生长/不带伤三原则直接修。本轮提交 `0ee8bcd5`（7 文件 +346/−29），未推送。

## 真机结果（只写用户原文事实）
| 项 | 结论 |
|---|---|
| 气泡底部引用按钮 → 引用到输入区气泡 | ✅ 验收通过（额外体验点） |
| 新建会话开任务 → 建会话 + 派活 + 结论回执 | ✅ 执行正确；但暴露"回答下方无可点会话气泡" |
| 重启后任务内部输入不当用户输入 | ✅ 既有修复回归成立 |

用户未回传实测窗口 HEAD/版本 ⇒ §6 版本基线如实标「未取证」，未代填。T2/T3/T4/T5/T7/T8 本轮未执行，不算通过也不算失败。

## 修复（DISPATCH-CREATE-CARD-1 · 真机 A9）
- **根因**：派活卡只在 `send_to_session` 工具行渲染（sid 取 args）；`create_session` 的 sid 只在 `tool_result.summary` ⇒ 回答下方无卡，无法一键切侧栏工作会话。
- **修法**：create_session 成功工具行从结果摘要解析 sid 挂同款卡，复用派活卡 build/mounter 与 `switch_session` 点击出口，零新协议。
- **SSOT**：解析复用 `parseCreateSessionSid` 单真源（互锁契约钉住）；真源下沉 webview 纯 helper `processEventText`，`workbenchHistory` re-export 保持 import 路径——避免拖宿主模块进 webview bundle。
- **不带伤**：失败结果不出卡、自助会话零行为差、sid 解析不到不编卡。

## 台账回填
- 真机方案 §6 结果表：T1/T6 部分覆盖 + 其余未执行 + A9 异常登记 + 收口判据维持不放宽。
- `tasks/待完成任务.md`：`HOSTED-SEAT-SESSION-1` 追加真机注记（判据⑨部分覆盖不销项）+ 新条目 `DISPATCH-CREATE-CARD-1`（待真机复验）。

## 验证
- 定向 3 文件 556/556；宿主全量 228 文件 3396 passed / 4 skipped（基线 3394 + 新增 2），FULL_EXIT=0。
- tsc=0 / eslint=0 / prettier=0 / verify-nls=0 / git diff --check=0。
- 变异验证：create 分支返回 undefined ⇒ 仅新增断言 1 红、send_to_session 用例与其余 538 绿；恢复后 hash 字节一致、残留 0。
- lefthook 真跑全链（prettier-fix / lint-staged / gate-fast 10 步全绿 / commitlint），零绕过。

## 交付与后续
- 提交 `0ee8bcd5`，未推送；连同 `e52e5048`、`b616590b` 共 3 笔留给用户按约定推送。
- 上一轮遗留改动（审查报告、hostedSessionNotice.test.ts、terminology、2 个未跟踪文档）原样未碰。
- **memora 宝全量闭环仍未成立**：T1/T6 仅部分覆盖，P0（T2/T3/T4）未执行；需补跑并真机复验 A9 修复（回答下方应出现可点会话卡）。
