# 达人工作台插件独立项目

项目目录：`/Users/Zhuanz/Downloads/gapasea-all-in-one/code/claudecode/gapaw-creator-workbench-plugin`

当前状态：独立需求承载目录已建立；尚未开发插件，尚未初始化 Git，尚未登记为 MultiCC 项目。会话由用户手动迁移。

## 产品方向

以现有 `gapaw-creator-outreach` 达人工作台为插件主体。用户在工作台选择达人、活动、草稿或对话并发起业务操作；MultiCC 承接任务和交互，技能执行具体工作，结果结构化回写原业务对象。

工作台保存业务事实；MultiCC 保存执行和会话状态。聊天中的“完成”不能代替工作台的业务结果。

## 需求资料

- [当前规划：工作台为核心（第二版）](requirements/workbench-plugin-plan-v2.md)
- [背景调研：外部依赖与历史实现（第一版）](requirements/external-dependencies-assessment-v1.md)
- [项目开发约束](AGENTS.md)

第二版的产品架构和实施顺序优先。第一版作为外部依赖调查与历史实现参考，不把其中账号或接口能力视为已经联通。

需求资料存放在本项目根目录的 `requirements/`，不纳入版本控制。未来在 MultiCC 任务工作区中开发时，使用以下绝对路径读取，不能把忽略文件搬进临时工作区：

- `/Users/Zhuanz/Downloads/gapasea-all-in-one/code/claudecode/gapaw-creator-workbench-plugin/requirements/workbench-plugin-plan-v2.md`
- `/Users/Zhuanz/Downloads/gapasea-all-in-one/code/claudecode/gapaw-creator-workbench-plugin/requirements/external-dependencies-assessment-v1.md`

原资料保留在 MultiCC 的持久数据目录中作为历史副本；本独立项目后续以这里的需求文件为工作入口。

## 首个开发切片

在现有达人档案或列表中选择对象 → 发起“生成邀约草稿” → 关联 MultiCC 任务 → 在任务里补充条件 → 草稿写回对应档案 → 用户审阅、采用或继续修改。

首期验收包括上下文范围、任务关联、结果回写、版本冲突、重复请求去重及页面刷新恢复。随后扩展核验资料、总结对话、邮件往来、选人和分渠道私信。

## 参考资产与修改边界

- 现有工作台入口：`/services/gapaw-creator-outreach/`。访问地址使用用户当前 MultiCC 的入口，不在产品中写死本机地址。
- 现有工作台源码：`/Users/Zhuanz/Downloads/gapasea-all-in-one/code/gapasea-marketing/tools/creator_outreach/`。
- 宿主源码：`/Users/Zhuanz/Downloads/gapasea-all-in-one/code/claudecode/multicc/`。

上述源码为只读参考。插件实现放在本独立项目；不要直接修改宿主主工作区、现有线上工作台或持久运行副本。确需宿主适配时，使用宿主自己的独立任务工作区处理。

本目录没有复制真实达人数据库、联系人、私人消息、账号配置、登录态或密钥，也没有建立指向生产数据的可写链接。

## 开发与迁移约束

- 新增后端业务采用 Rust；前端可以复用现有工作台设计。Node 或旧 Python 仅保留必要的迁移兼容范围。
- 复用 MultiCC 任务、会话、技能、人机交互和凭据能力；不再另建一套智能体调度系统。
- 邮件、普通私信、Shop 联盟聊天／邀请分别验证；发送授权绑定对象、账号、渠道和内容版本。
- 持久数据、密钥和需求文件留在独立项目根目录的用途目录，通过绝对路径访问；不放临时工作区。
- 所有新增 Git 提交遵守 `AGENTS.md`，身份唯一来源是 `commit-policy.json`；本次未创建任何提交。

## 会话迁移后

用户把此目录添加为 MultiCC 项目并手动移动会话。下一轮先核对新的当前目录和适用约束，再从第二版规划的首个开发切片开始。本轮仅准备目录和资料，不执行会话迁移、插件安装、服务重启或对外业务操作。
