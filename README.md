# 达人工作台插件独立项目

当前已提供可安装的开发版结构：Rust 命令程序、插件清单、中文操作界面、专属目录绑定、持久选人操作记录及宿主任务投递。使用范围与安装方式见 [插件说明](PLUGIN_README.md)。此前的 [交互原型](prototype/selection-setup.html) 仍是模拟演示，不承担真实操作。

## 产品方向

以现有 Gapaw 达人工作台为业务主体。工作台保存业务事实，MultiCC 保存任务和交互，技能负责执行。当前先实现“按回本率选人”的提示词入口，不采用多条件筛选表格；选人任务进入初始化时绑定的持久目录。

原有达人工作台通过 `/services/gapaw-creator-outreach/` 访问。此版本保留该入口，没有迁移生产数据库。平台读取、Chrome 自动化桥接和候选结构化回写仍未接入；任务受理不能替代业务结果。

## 目录结构

- `src/main.rs`：Rust 配置、路径检查、SQLite 操作记录、两阶段回执与幂等逻辑。
- `plugin.json`：宿主识别清单、命令声明、界面入口及目录初始化要求。
- `ui/`：中文页面，调用宿主插件命令和既有任务接口。
- `resources/selection-method.md`：回本率方法提示词；不包含真实报价、名单或成本。
- `scripts/package_plugin.py`：构建、校验和复制工具；不承担后端业务。
- `tests/`：发行与界面行为验证。
- `docs/`、`prototype/`：方案与早期交互原型。

## 构建与复制

在本任务工作区执行：

```sh
cargo test --locked --target-dir=/tmp/gapaw-creator-plugin-target
python3 tests/package.test.py
node --test tests/ui.test.cjs
python3 scripts/package_plugin.py build
```

构建后可用真实 Rust 程序联调页面投递模块，宿主接口由隔离测试替代，不创建真实任务：

```sh
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench node --test tests/integration.test.cjs
python3 tests/ui-browser.test.py
```

浏览器验收需要 Python Playwright 与 Chromium，macOS 默认也可使用已安装的 Google Chrome；可通过 `GAPAW_TEST_CHROME` 指定可执行文件。测试使用独立浏览器进程和拦截接口，验证初始化、发送、刷新恢复及手机布局，不操作用户登录窗口。

构建器自动定位主项目目录，在其 `dist/` 保留完整插件目录和当前平台 ZIP；构建缓存放 `/tmp`。不把忽略的发行文件或运行数据放进任务工作区。

```sh
python3 scripts/package_plugin.py install-debug \
  --package /绝对项目路径/dist/gapaw-creator-workbench \
  --plugin-root /绝对宿主路径/plugins
```

复制前后校验完整文件哈希和执行权限；拒绝覆盖无法识别或被手动修改的目标。重新构建后需要再次复制，两个目录不是软链接。随后在 MultiCC 插件面板刷新即可发现，不需要另起服务。

当前运行宿主兼容旧版按需命令通道。新增安装和目录生命周期功能已在宿主独立分支实现，尚未部署；本插件同时兼容旧版插件内目录绑定与新版宿主绑定。

## 需求与边界

开发约束见 [AGENTS.md](AGENTS.md)。当前需求位于主项目根目录的 `requirements/workbench-plugin-plan-v2.md`，优先于第一版调研；该目录不纳入版本控制，也不进入发行包。

- [回本率提示词、目录与任务方案](docs/selection-data-and-connections.md)
- [宿主安装与生命周期方案](docs/plugin-installation-and-lifecycle.md)

本项目是独立插件仓库；现有工作台与 MultiCC 主代码只作参考。后端业务默认 Rust，页面使用 JavaScript，Python 仅用于构建工具。插件源码不携带真实达人数据库、联系人、私人消息、账号配置、登录态或密钥。
