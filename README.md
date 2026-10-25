# 达人工作台插件独立项目

当前提供 0.6.0 开发版：Rust 命令程序、中文任务界面、平台响应观测、精确结果预检与工作台待核验候选区接入。使用范围与安装方式见 [插件说明](PLUGIN_README.md)。此前的 [交互原型](prototype/selection-setup.html) 仍是模拟演示，不承担真实操作。

## 产品方向

以现有 Gapaw 达人工作台为业务主体。工作台保存业务事实，MultiCC 保存任务和交互，技能负责执行。当前先实现“按回本率选人”的提示词入口，不采用多条件筛选表格；选人任务进入初始化时绑定的持久目录。

原有达人工作台通过 `/services/gapaw-creator-outreach/` 访问。此版本保留该入口，没有迁移生产数据库。已提供受限 Chrome 只读桥接与平台响应离线适配；实时平台采集尚未接入。配套工作台接口将经用户明确操作的报告保存到原业务库的待核验候选区，并读回确认；部署与初始化需单独完成。旧达人档案的身份合并、指标确认和活动入选仍未实现。

## 目录结构

- `src/main.rs`：Rust 配置、路径检查、SQLite 操作记录、两阶段回执与幂等逻辑。
- `src/results.rs`：只读预检、结果快照、精确十进制计算、时区校验、幂等提交、历史版本及来源与样本覆盖的核验提示。
- `src/platform.rs`：绑定原操作与任务的分来源读取契约。
- `src/observations.rs`：平台响应的严格投影、来源命名空间、原始数值类型与附属观测快照。
- `src/workbench.rs`：工作台候选接口客户端、不可变采纳计划、未知结果恢复与读回核对。
- `src/workbench_store.rs`：工作台业务库候选区的 Rust 事务、认证、幂等与读模型。
- `src/browser.rs`：Chrome 1.5 内部身份清单的只读适配、安全字段投影、绑定与历史快照检测。
- `src/bridge.rs`：受限 Unix socket 客户端、任务归属与会话检查、页面结果校验。
- `integrations/chrome-read-bridge/`：Chrome 1.5.0 配套升级源码与隔离验证工具，不自动改动运行副本。
- `integrations/workbench-adoption/`：旧工作台固定 HTTP 到 Rust 的兼容桥接、源码基线校验与隔离验收，不自动修改真实业务库。
- `plugin.json`：宿主识别清单、命令声明、界面入口及目录初始化要求。
- `ui/`：中文页面，调用宿主插件命令和既有任务接口。
- `resources/`：回本率提示词、结构化结果契约与执行说明；不包含真实报价、名单或成本。
- `scripts/package_plugin.py`：构建、校验和复制工具；不承担后端业务。
- `tests/`：发行与界面行为验证。
- `docs/`、`prototype/`：方案与早期交互原型。

## 构建与复制

在本任务工作区执行：

```sh
cargo test --locked --target-dir=/tmp/gapaw-creator-plugin-target
python3 tests/package.test.py
node --test tests/ui.test.cjs tests/data-workflow.test.cjs
python3 scripts/package_plugin.py build
```

构建后可用真实 Rust 程序联调页面投递模块，宿主接口由隔离测试替代，不创建真实任务：

```sh
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench node --test tests/integration.test.cjs tests/browser-integration.test.cjs tests/bridge-integration.test.cjs tests/result-preflight.test.cjs tests/observation-integration.test.cjs tests/workbench-integration.test.cjs tests/workbench-roundtrip.test.cjs
python3 tests/ui-browser.test.py
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench PYTHONDONTWRITEBYTECODE=1 python3 -B integrations/workbench-adoption/test_integration.py
```

浏览器验收需要 Python Playwright 与 Chromium，macOS 默认也可使用已安装的 Google Chrome；可通过 `GAPAW_TEST_CHROME` 指定可执行文件。测试使用独立浏览器进程和拦截接口，验证初始化、身份切换与任务快照、发送、报告恢复及手机布局，不操作用户登录窗口。浏览器适配器与桥接集成测试使用临时的虚构身份资料和本机测试 socket，验证不执行来源程序、不修改来源、不输出敏感配置字段，以及任务、实例和响应校验。配套桥接的构建与真实隔离 Chrome 验证见 `integrations/chrome-read-bridge/README.md`。

配套桥接已在隔离环境走通原启动器完整启动与停止，并与真正达人程序联合读取本地合成平台页面；覆盖首段指纹、会话保留、旧任务冻结身份与重启后实例失效。真实平台登录、业务字段及实际代理出口仍需单独验证。

工作台供应端测试使用全新合成旧库和仅用于测试的本机服务，验证 Python HTTP → Rust → 原业务库候选表 → 回执读回。旧七张表保持不变，未知值不补零，同名不合并，异常事务全部回滚；测试不会启动真实工作台、复制生产数据或初始化真实库。

构建器自动定位主项目目录，在其 `dist/` 保留完整插件目录和当前平台 ZIP；构建缓存放 `/tmp`。不把忽略的发行文件或运行数据放进任务工作区。

```sh
python3 scripts/package_plugin.py install-debug \
  --package /绝对项目路径/dist/gapaw-creator-workbench \
  --plugin-root /绝对宿主路径/plugins
```

复制前后校验完整文件哈希和执行权限；拒绝覆盖无法识别或被手动修改的目标。重新构建后需要再次复制，两个目录不是软链接。随后在 MultiCC 插件面板刷新即可发现，不需要另起服务。

插件兼容旧版按需命令通道和插件内目录绑定，也兼容新版宿主提供的目录绑定。安装新版插件不需要在本项目中修改或部署宿主代码。

## 需求与边界

开发约束见 [AGENTS.md](AGENTS.md)。当前需求位于主项目根目录的 `requirements/workbench-plugin-plan-v2.md`，优先于第一版调研；该目录不纳入版本控制，也不进入发行包。

- [回本率提示词、目录与任务方案](docs/selection-data-and-connections.md)
- [宿主安装与生命周期方案](docs/plugin-installation-and-lifecycle.md)

本项目是独立插件仓库；现有工作台与 MultiCC 主代码只作参考。后端业务默认 Rust，页面使用 JavaScript，Python 用于构建、测试和旧 HTTP 服务的最小协议桥接。插件源码不携带真实达人数据库、联系人、私人消息、账号配置、登录态或密钥。

工作台配套补丁保留现有 Python HTTP 服务的最小协议桥接，原因是它仍是既有页面与 API 的入口；新认证、业务校验、数据库事务和读模型均由 Rust 实现。以后迁移原 HTTP 服务时可删除该桥接，不需要迁移到第二套业务库。
