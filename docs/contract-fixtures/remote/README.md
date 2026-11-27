# 远程契约 golden fixture

由宿主生成器**产出**，不是手写样本。规则只在这里说一次：

- 生成（唯一写入口）：`cd hosts/memora-vscode` → `npm run fixtures:gen`
- 宿主断言（桥构造 == fixture）：`hosts/memora-vscode/src/extension/host/remote/__tests__/remoteFixtures.test.ts`
- 手机镜像与断言（fixture → DTO 字段级）：`../memora-mobile/test/fixtures/remote/` + `dart run tool/fixture_smoke.dart`
- 覆盖范围：`snapshot` 两用例（未裁剪 / 超限裁剪）。`err` / `delta` / `session_list_ok` 尚未生成样本。

禁止手改任何 `*.json`：手改后宿主单测仍绿（它只认重算结果），手机会基于伪造样本"通过"，
契约测试就退化成装饰。要改样本，改生成器再重跑。
