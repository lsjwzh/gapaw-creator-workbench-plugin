# 达人工作台插件独立项目

0.15.2：统一从工作总览进入，先看当前进展、下一步和待你决定的事项。最近正式投递、真人回复与合作确认分别展示，同时标明收信更新时间和测试／正式模式；像素办公室保留，历史累计折叠，模拟动画放入使用演示。

需要启动新一轮工作时，从「安排新工作」确定产品目标、市场、筛选要求和本轮已有候选（1–20 位），审阅真实角色提示词并确认工作约定。开工检查通过并点击开工后，宿主每分钟核对真实队列，关闭页面仍可继续；员工遇到卡点再找老板，其他工单继续。

目前自动链路为「已有候选复核 → 宿主交付与文案验收 → 文案工单 → 草稿候选」。不自动发现新平台候选、不正式采用、不发送邮件；其余角色已可认识与配置，但本版不会自动启动它们的业务流程。MultiCC 配套交付接口未上线时明确显示缺项并禁止开工，安装插件本身不会启动员工或登记时钟。


0.13.4 开发版：新增发件箱（`outbox-*`）：在达人抽屉里写信、发送前复查硬规则、建飞书草稿后发送并查投递状态，中断或超时只核对不重发；测试模式只发往测试收件邮箱。此前 0.13.3：首页是像素办公室，旧版十模块工作台、草稿任务、选人与候选区页面已下线，业务库与后端命令保留为数据层。新增从原台账整库更新、外部批次建档（`creator-import*`）与飞书邮件增量同步（`mail-sync`）。业务规则、数据库读写与导出由 Rust 处理，不需要运行原 Python 工作台服务。

使用方式、模块边界及迁入注意事项见 [插件说明](PLUGIN_README.md)。真实资料不随源码或安装包分发。

## 业务与数据

插件统一从工作总览（`ui/index.html`）进入，优先显示最近正式投递、下一步与收信更新时间，下面保留像素办公室。工作安排（`ui/onboarding.html`）、连接与设置（`ui/setup.html`）与影子演练（`ui/rehearsal.html`）是独立功能入口；共用请求与 MultiCC 任务派发在 `ui/client.js`。

插件持久目录默认是 `~/.multicc/plugins-data/gapaw-creator-workbench/`：

- `workbench.sqlite`：独立业务库，保留原工作台七张表的结构、主键、版本、消息来源与撤销记录；另有稳定业务身份、迁入回执及待核验候选区。
- `state.sqlite`：插件配置、任务快照、候选版本、请求与采纳回执。
- `exports/`：带校验摘要的固定导出快照。

迁入通过 SQLite 在线备份读取一致快照，包括尚在 WAL 中的已提交记录。只读预览后按来源摘要确认，复制到目标目录临时库并逐表核对，再原子落位；原库保留，不覆盖既有目标。成功重试返回原回执，不把本地后来改动覆盖回旧数据。迁入后两库独立，原工作台后续改动不会自动同步。

人工设置使用版本校验；事件、消息与撤销使用固定请求编号、来源身份及载荷核对。写后读回才确认成功，未知结果沿原编号恢复。AI 草稿与摘要冻结业务库身份，人工采用后才写业务表；无来源身份的旧任务仍可查看历史，但迁入后需重新生成候选才能采用。

候选区在本地直接调用既有 Rust 事务实现，不需要 HTTP 桥接、端口或令牌。候选入库仍不等于正式达人身份合并。旧远端模式保留作显式兼容，新首页以本地库为准。

## 代码位置

- `src/selection.rs`：自动依赖检查、同任务对话、内置任务约定及不可变名单版本。
- `src/selection_data.rs`：资料契约校验、身份匹配、采用事务与幂等回执。
- `src/office.rs`：首页只读汇总 `office-status` 与达人抽屉 `office-creator`。`src/mail_sync.rs`：飞书邮件增量同步。`src/intake.rs`：外部批次建档。
- `src/local_store.rs`：七表兼容的读模型、设置、文案、事件、消息、谈判与七日回复统计。
- `src/local_migration.rs`：只读盘点、一致备份、类型敏感的逐表完整摘要与迁入回执。
- `src/local_backend.rs`：业务库生命周期与本地模式启用。
- `src/local_export.rs`：一致读取事务生成 XLSX、CSV 与 ZIP。
- `src/console.rs`、`src/drafts.rs`、`src/facts.rs`：页面读模型、任务候选、人工确认及恢复。
- `src/exports.rs`：持久导出快照、哈希校验与宿主下载。
- `src/workbench.rs`、`src/workbench_store.rs`：候选预览、事务采纳、核对与分页。
- `src/results.rs`、`src/platform.rs`、`src/observations.rs`：原选人报告、精确计算与离线来源观测。
- `src/browser.rs`、`src/browser_catalog.rs`：通过宿主发现与公开 `list` 命令读取专用 Chrome 实例，校验安全元数据并绑定到任务。
- `src/bridge.rs`：显式旧版配置保留的受限只读桥接，新版默认清单模式不使用它。
- `ui/`：中文界面；`scripts/` 和 `tests/`：构建与隔离验证。

`integrations/workbench-adoption/` 仅为旧版远端兼容工具，本地运行不使用它。Python 仅用于测试、构建及保留的兼容适配，新的业务核心使用 Rust。

## 验证与打包

```sh
cargo test --locked --target-dir=/tmp/gapaw-creator-plugin-target
cargo clippy --locked --target-dir=/tmp/gapaw-creator-plugin-target -- -D warnings
cargo build --locked --release --target-dir=/tmp/gapaw-creator-plugin-target
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench node --test tests/*.test.cjs
PYTHONDONTWRITEBYTECODE=1 python3 -B tests/package.test.py
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench PYTHONDONTWRITEBYTECODE=1 python3 -B tests/office-browser.test.py
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench PYTHONDONTWRITEBYTECODE=1 python3 -B tests/setup-browser.test.py
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench PYTHONDONTWRITEBYTECODE=1 python3 -B tests/rehearsal-browser.test.py
python3 -B scripts/package_plugin.py build --binary /tmp/gapaw-creator-plugin-target/release/gapaw-creator-workbench
```

兼容性测试只读引用原工作台源码，以全新合成资料比对业务行为；不使用真实数据库。浏览器测试使用独立测试浏览器，验证空库、模块、迁入、冲突、恢复和手机布局。`GAPAW_OUTREACH_SOURCE` 可指定原源码目录，`GAPAW_TEST_CHROME` 可指定已安装测试浏览器。

构建器将目录与当前平台 ZIP 留在主项目 `dist/`；此目录和宿主调试副本均不提交。源码与运行数据保持分离。无需修改 MultiCC 主代码或部署旧服务。

## 边界

浏览器默认经 `MULTICC_BASE_URL`（缺省为本机 3000 端口）访问宿主，也可用 `GAPAW_BROWSER_HOST_URL` 指定本机宿主根地址。按公开命令和返回字段判断是否可读取，产品版本仅作展示；不直接读取浏览器插件的内部配置。来源失败时明确报错，不回退私有文件。返回只保留身份、名称、运行线索和安全版本元数据，不传播代理凭据、订阅地址或登录态。

MultiCC 随包分发的浏览器隔离插件自 1.6.4 起内置公开页面接口，沿用 `browser-read`、`browser-read-capabilities` 与 `multicc-browser-read-v1`，达人工作台无需改调用方式。`integrations/chrome-public-read/` 仅保留历史补丁与验证记录，构建入口已停用；不得用本项目补丁覆盖 MultiCC 主仓插件目录。后续浏览器插件改动应在 MultiCC 仓库通过正常分支与提交完成。

已具备页面读取能力的运行实例可继续使用，无需为版本更新专门重开；缺少接口的旧监督进程需在保存工作后正常重开才能加载新能力。真实独立 Chrome 与合成 HTTPS 平台联合验证通过，真实平台仍待核验。

`prototypes/selection-workspace.html` 是新版对话式选人的独立交互评审稿，使用全新演示数据，无外部请求；其中登录检测、对话生成和正式采用均为模拟，不属于已接入能力。

“连接与设置”页（`ui/setup.html`）统一检测业务数据、飞书邮箱登录（本机 `lark-cli`）、发件与测试收件邮箱、运行模式和运行参数；测试邮件只在用户点击时发往测试收件邮箱，测试可用 `GAPAW_LARK_CLI` 指向合成命令行。发件箱与收件同步已接入飞书邮箱；私信、物流、付款以及真实平台实时采集尚未接入；人工登记记录已发生事实，不执行这些动作。对话名单可在预览确认后写入正式档案；仅使用来源明确的平台稳定账号编号建立身份，旧档案缺少映射或发生冲突时保留待核验，不按昵称合并。

需求从主项目 `requirements/workbench-plugin-plan-v2.md` 读取，不复制到任务工作区。不得将生产数据库、私人消息、登录态或密钥加入源码、测试夹具或安装包。

## 对话选人实现范围

旧版对话选人页面已下线；`selection-*` 命令与数据保留，新版选人将并入首页员工“小选”的工作流。

绑定后在同一浏览器实例内自动检查平台身份，不再填写账号、市场或核验依据。检测结果绑定实例生命周期，缓存最多两分钟，每轮发送前重查。多页时选择本次使用的页面。真实平台检测仍待在指定实例中验收；登录通过不代表所有筛选字段与时窗可用。

名单先按契约保存版本；身份未知可保留候选，不能采用为正式档案。采用只新增档案或更新选人资料快照，保留人工设置与已发生事实，重复同版跳过。工作台档案显示来源、指标时窗及缺失项。所有发布验收中的 AI 回答和平台资料均使用合成接口；不代表真实模型采集或自动登录检测已验收。

首页（`ui/index.html`）先显示业务进度，再呈现像素办公室：7 位 AI 员工按工作流排布，真实状态来自只读命令 `office-status`（Rust），显示谁因设置缺失受阻、谁在等演练回答、哪些谈判与新来信等你处理；点卡片用 `office-creator` 打开达人抽屉查看往来；“立即同步邮件”调用 `mail-sync`；“模拟一天”只改页面显示，不发送、不改数据。

## 办公室与角色任务（0.14.0）

在「连接与设置 → 办公室与员工任务」选择模型、线路和运营目录，保存后点击「初始化办公室」。可以自动建立专属运营目录；宿主负责将它准备成 Git 工作目录。初始化只创建一个流转器和七个员工角色任务，不启动模型。中途中断后点击继续初始化，会复用原任务编号与角色计划。任务准备后目录与创建计划固定，模型变更可在 MultiCC 原任务中管理。

打开某位达人的往来记录，选择工单类型并填写要求，点击「创建影子工单」，再到首页「办公室任务」点击「唤醒流转器」。工单候选通过插件保存，页面可查看摘要、依据与邮件候选；这一步不采用正式数据、不发送邮件。手工工单仍需手动唤醒；开工引导中的已选候选会在明确开工后由后台时钟流转。工单依据过期或需要终止时可作废，再基于最新业务数据新建工单。

工单协议：`work-create`、`work-next`、`work-dispatched`、`work-context`、`work-submit`、`work-get`、`work-list`、`work-cancel`。流转器和员工都从插件重新读取状态；角色提示词内附有命令和交回格式。跨进程领取、派发回执和交回结果保存在业务库，测试邮箱配置不阻塞影子工单。

本切片通过任务编号校验逻辑归属，但不提供宿主任务之间的权限沙箱；受信任的宿主工具仍有全局能力。任务执行状态需回原任务查看，工单的「处理中」是员工最近读取上下文后的记账状态。手工工单的积压可在刷新工单后再次手动唤醒；开工引导队列由专属时钟核对。正式采用、新来信自动触发和按动作放权仍待后续切片。

### Homepage progress

The plugin opens `ui/index.html` for both new and existing workspaces. `ui/home.js` presents the Rust `office-status` snapshot without starting work, synchronizing mail, or sending messages on page load. Recent outreach excludes test mail and cancelled drafts. Delivery, subsequent inbound mail, and recorded cooperation remain separate facts. Missing sync history is shown explicitly; local records are not presented as a live inbox check. The setup wizard remains available under work planning, and demonstrations are separate from real progress.
