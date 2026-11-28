# 验证纪律（指针）

> 本文件只做**指针**，不重复定义：通用测试纪律见 [generic/testing_rules.md](./generic/testing_rules.md)。
> 2026-11-28 补建：本路径此前被 `.trae/documents/计划-手机联调首切片-20261127.md` 与
> `tasks/待完成任务.md` 引用为「应写进」的落点，但文件从未存在（引用腐烂）。
> 这里只登记**已有事实**，不新增判据。

## 手机远程桥的两条必跑校验

- **涉及桥 / 传输 / 帧形状的改动**：跑手机仓 `dart run tool/check_bridge.dart`。
  验证的是**真桥 + 假数据**（外部依赖：node + 主仓宿主 `ws` / `esbuild`）。
- **涉及 mTLS / `pinned_tls_client` / 证书栈的改动**：跑手机仓 `dart run tool/check_mtls.dart`
  （每次重生成 24h 临时证书，端口由 OS 分配，含 `ok` / `wrong-pin` / `no-client-cert` 三用例与错误码断言）。

以上两条均**不进** `tool/check_all.dart`（它保持零依赖三步），原因见台账 `REMOTE-LAN-1` 的修法订正：
把依赖外部进程的冒烟硬塞进纯 Dart 一键校验只会造出假绿或证书过期假红。
