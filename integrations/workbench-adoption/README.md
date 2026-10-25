# 旧达人工作台的待核验候选区配套适配

此目录交付旧工作台的最薄 Python 协议桥接与源码基线校验。候选校验、精确重算、SQLite 事务、幂等及读模型全部由本插件的 `src/workbench_store.rs` 实现。没有复制生产数据、seed、联系人或登录态，没有初始化、升级或部署正式服务。

## 数据归属与边界

候选区使用旧工作台同一个已有 SQLite 文件，追加六张 `gapaw_selection_*` 表：初始化标识、批次与完整报告快照、候选与原始候选快照、附属来源观测、保存回执、审计。旧 `creators/drafts/events/audit/meta/messages/negotiations` 七张表只读，不添加草稿，不更新合作设置、触达阶段或正式指标。

保存的状态永远是 `candidate_pending_verification`，身份核验状态永远是 `unverified`。来源观测保持各自命名空间；报告的 `creatorId` 只是 `reportedIdentity`，不能自动关联旧 `oec_id`、Kalodata 编号或 TikTok 统一身份。同名只提示冲突，不合并达人。保存到候选区不等于正式入选、完成来源核验或确认费用。新候选通过独立候选页展示，不伪造旧档案要求的历史字段、排名或五类草稿。

## 生成隔离源码副本

```sh
python3 -B integrations/workbench-adoption/build-patched.py \
  /path/to/creator_outreach \
  --output /tmp/outreach-selection-review
```

来源必须符合 `source-checksums.json`。工具只读取并复制七个核心源码文件，拒绝不匹配文件和符号链接，再添加 `workbench_bridge.py` 并应用补丁；不扫描或复制数据目录。输出必须尚不存在，不能位于来源内部。原帮助文档、依赖安装和运行数据不在此源码白名单内；隔离输出用于审查与合成测试，不能直接替换完整运行目录。

旧 `index.html` 仅增加 `/plugins/gapaw-creator-workbench/ui/candidates.html` 入口；该页经宿主插件读取候选区，浏览器不持有供应端凭证。旧接口和页面其他行为保留。

## 供应端与默认关闭

隐藏 CLI `workbench-provider` 接收单个 JSON：`{action, authorization, payload}`。它不在插件公开命令列表内。业务库只能来自 `GAPAW_WORKBENCH_DB`，必须是已存在、符合已验证旧结构的文件；拒绝工作树、符号链接、缺失文件、未知表/触发器或不完整的候选区结构。查询不会创建数据库或初始化候选区。

`GAPAW_WORKBENCH_ADOPTION_TOKEN` 是至少 32 个可打印 ASCII 字符的高熵随机凭证，经受控配置注入进程环境；请求必须携带完全匹配的 `Authorization: Bearer …`。凭证不进入前端、载荷、数据库、日志或聊天。缺少配置时默认拒绝。旧 `X-Outreach-Request: 1` 不是这条新入口的授权方式。

正式启用还需配置旧服务的绝对执行器路径 `GAPAW_WORKBENCH_EXECUTABLE`。Python 固定路由 `POST /api/plugin-selection` 只接受 `{action,payload}`，从 HTTP 头转交授权，始终用服务自身 `store.path` 覆盖数据库环境变量，只执行配置的二进制及固定 `workbench-provider` 子命令。客户端不能传数据库路径或子命令。请求体最多 950000 字节，读取正文共享 3 秒总预算，短读立即拒绝；执行时限 10 秒，标准输出最多 2 MiB；失败或超时终止并回收子进程，不回显 stderr。正文读取的临时 socket 设置只影响新路由，随后恢复。

初始化必须经显式 CLI `action: initialize`，它需要同一授权，只为经过校验的旧库增加命名空间表和持久 `businessStoreId`。HTTP 白名单不包含初始化。正式初始化和部署仍需用户授权，本轮只在自动生成的合成库中执行。

## 协议

HTTP 可用操作为 `status/preview/adopt/receipt/list/batch`，均要求凭证。CLI 返回统一 `{ok,data}` 或 `{ok:false,error}`。

写载荷固定为：

```text
{schemaVersion:1, adoptionId, expectedStoreId,
 operationId, taskId, resultId, resultRevision,
 report, computed, observations:[snapshot...场景需要时]}
```

`observations` 必须是数组，可为空；整个载荷上限 900000 字节，最多 100 份观测。供应端调用同一报告算法重算并要求 `computed` 完全一致；观测调用共同的快照校验器，并检查原操作/任务归属。未知费用仍为 null，空候选报告拒绝保存。整个报告全部进入候选区，不暗中筛掉候选或用零填补未知。

| 操作 | 载荷与结果 |
|---|---|
| `status` | `{}`；返回 `protocolVersion/ready/businessStoreId/status`，未初始化时 `ready:false` |
| `preview` | 完整写载荷；只读返回 `payloadHash/businessStoreId/candidateCount/canAdopt:true/verification/warnings/handleConflicts` |
| `adopt` | 同一完整载荷；返回 `{receipt,batch,candidates,replayed}` |
| `receipt` | `{adoptionId}`；不存在返回 `{found:false}`，存在返回 `{found:true,receipt,batch,candidates}` |
| `list` | `{offset?:0,limit?:20}`；返回批次摘要 `{items,total,offset,limit,nextOffset}` |
| `batch` | `{batchId,offset?:0,limit?:20}`；返回 `{batch,candidates,total,offset,limit,nextOffset}` |

分页上限 50。列表和详情不返回旧私人档案、联系方式或凭证。回执字段为 `schemaVersion/adoptionId/businessStoreId/payloadHash/batchId/operationId/taskId/resultId/resultRevision/candidateCount/candidateIds/status/createdAt`。批次另含 `verification/reportMetadata/observationCount/warnings/handleConflicts`，候选摘要含报告声明身份、理由、重算结果、缺项和报告来源。

完整载荷按排序后的对象键生成 SHA256；数组顺序保留。`adopt` 在同一个 `BEGIN IMMEDIATE` 事务内核对结构、库身份、归属、重算与幂等，再写批次、候选、观测、审计及回执。相同 `adoptionId` 与相同载荷返回原回执，异载荷拒绝；同操作/结果/修订换编号也拒绝重复建批。约束失败回滚整个批次。只读操作使用 `BEGIN DEFERRED` 保持回执、批次与候选的一致快照。超时后必须沿用原编号查询回执，不能换编号盲重试。

## 隔离验证

```sh
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench \
PYTHONDONTWRITEBYTECODE=1 \
python3 -B integrations/workbench-adoption/test_integration.py
```

可用 `GAPAW_OUTREACH_SOURCE` 指定只读源码基线目录。测试在系统临时目录生成全新合成旧库、隔离源码、短期本机 HTTP 夹具与插件数据；另建空的 `~/.gapaw-provider-test-*` 目录供真实插件目录校验，结束删除。测试凭证只在内存和子进程环境内存在。

10 项端到端测试已通过，覆盖真实 Python HTTP → Rust CLI → SQLite → 回执/候选页读模型，包含授权失败、未初始化、初始化不对 HTTP 开放、旧请求路径兼容、幂等与异载荷冲突、事务中途约束失败全批回滚、旧七表 SQL 与行值字节语义不变、未知成本保留、跨库/跨任务拒绝、同名不合并、分页、无观测旧报告、路径与未知结构拒绝、半截请求/短读、子进程超时/超大输出后的回收，以及来源源码哈希不变。未验证真实工作台部署、生产数据迁移、正式身份合并或实时平台采集。
