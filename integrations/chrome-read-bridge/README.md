# Chrome 1.5.0 受限只读桥接配套补丁

此目录提供达人工作台的配套源码补丁。它为 Chrome 隔离出口插件现有的 Rust 监督进程增加只读页面接口，复用原私有 CDP 管道。它不安装插件、不修改来源目录、不接管已有 Chrome，不启动真实身份或替换运行服务。

## 应用与验证

构建脚本先校验来源的全部 Rust 源码、扩展模板、测试、清单和原依赖锁文件 SHA256，只复制匹配基线的文件到一个尚不存在的隔离目录，再应用补丁。新增依赖使用本目录的已验证 `Cargo.lock` 锁定。来源任何一个受校验文件变化都会拒绝应用；不得绕过校验强行套用其他版本。

```sh
python3 integrations/chrome-read-bridge/build-patched.py \
  /path/to/chrome-proxy-launcher \
  --output /tmp/chrome-read-bridge-review --build
cargo check --locked --manifest-path /tmp/chrome-read-bridge-review/Cargo.toml
cargo test --locked --manifest-path /tmp/chrome-read-bridge-review/Cargo.toml
CHROME_TEST_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
PLUGIN_TEST_MANIFEST=/tmp/chrome-read-bridge-review/Cargo.toml \
node --test integrations/chrome-read-bridge/verify-headless.cjs
CHROME_TEST_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
PLUGIN_TEST_MANIFEST=/tmp/chrome-read-bridge-review/Cargo.toml \
GAPAW_TEST_BINARY=/tmp/gapaw-creator-plugin-target/debug/gapaw-creator-workbench \
node --test integrations/chrome-read-bridge/verify-launch.cjs
```

两种验收均创建 `/tmp/cbr-*` 专用测试根目录，通过 `CHROME_READ_TEST_ROOT` 传入测试二进制，不重设 `HOME` 或 `CODEX_HOME`。Chrome profile 和一次性 TLS 证书均在该目录内；Chrome 使用 `--use-mock-keychain`。测试代理只把指定平台主机连接转入本地合成 HTTPS 页面，没有远端转发路径，其他目标拒绝。结束后关闭临时 Chrome、监督进程、代理和测试服务器。

`verify-headless.cjs` 使用仅 `cfg(test)` 可见的绑定入口，复用生产 `Pipe` 与 `Bridge` 验证真实 Unix socket 的状态、列页、正文、身份/版本/实例拒绝和清理。普通 Rust 测试中的这个无头用例默认忽略，由专门命令显式执行。

`verify-launch.cjs` 每次在自己的临时构建目录启用 `gapaw-read-bridge-test` feature 构建原插件。该 feature 把数据目录导向新建、当前 UID 所有、权限 `0700` 的 `/tmp/cbr-*` 根目录；缺少或不合法的根目录立即停止，不回退生产数据。它还允许夹具在该隔离目录放置一次性的 `run/test-snapshot-delay` 标记：真实 `DOMSnapshot.captureSnapshot` 请求完整写入后生成 `.started` 标记，并等待至原请求截止或停止信号；另记录是否触发系统停止回退。普通构建不编译这些延迟/回退标记，不读取延迟环境变量。测试二进制不得安装为运行插件。

完整夹具调用原 `save → launch → 自动指纹加载 → browser-supervise → Bridge → stop`，再调用真正达人插件二进制的 `configure`、`bind-browser`、`prepare-operation`、两阶段 `record-dispatch`、`browser-probe`、`browser-pages`、`browser-read-page`。达人插件配置会拒绝 `/tmp` 工作目录，因此夹具另建一个空的 `~/.gapaw-full-bridge-test-*` 目录并在结束时删除；没有复用现有运营目录。宿主任务回执为明确标记的合成夹具，不创建真实 MultiCC 任务或发送消息。

已在 macOS arm64、Chrome `156.0.8078.48` 验证：

- 两个真实独立 Chrome 身份分别读取合成 Kalodata 和 TikTok Affiliate 正文；表单、密码、编辑节点、隐藏/透明/裁切内容和跨来源 iframe 被排除。
- 网页首段脚本受到已加载指纹扩展影响；正常停止重开后，同一身份指纹结果和合成会话 Cookie 保持。
- 默认绑定切换到第二身份后，原操作和任务仍读取第一身份；跨任务请求拒绝。只读调用前后达人 SQLite 文件 SHA256 不变。
- 在真实 `DOMSnapshot` 已写入、响应读取被测试标记延迟时停止第一身份，同时保留一个排队的未完成 socket 请求。停止使原读取返回失败，随后 Chrome、监督进程、PID/监督记录和 socket 消失；本机完整回收耗时 533 毫秒，夹具上限为 3 秒，未进入系统退出回退。
- 读中停止后重新启动仍保留合成会话 Cookie 和首段指纹结果，产生新的实例编号；旧实例编号在读取前被拒绝，新实例可读。
- 未指定网址时成功打开新标签；新标签不会出现在允许平台列表中；最终全部测试进程和端点清理。

这覆盖原完整命令和双方二进制的联合链路，仍未验证已有用户身份、真实平台登录与业务字段、订阅/中继出口、桌面窗口视觉行为或其他操作系统。

## 原启动流程的最小修复

原 1.5.0 在扩展加载后再次启动相同 profile 的 Chrome 进程以打开窗口。隔离复现中，无头 Chrome 报 `SingletonLock: File exists`，并明确拒绝重复创建 `ProcessSingleton`，因此原 `launch` 返回“打开身份窗口失败”。

补丁保留“先确认没有页面，再确认扩展加载”的顺序，随后通过原私有管道的固定 `Target.createTarget({url, newWindow:true})` 打开原请求网址；未指定网址使用 `chrome://newtab/`，并用 `Target.getTargetInfo` 确认页面目标。它不再启动第二个 Chrome 进程。这个启动阶段内部操作不属于外部只读协议；外部调用方仍不能创建页面或导航。完整夹具已验证原请求页面、首段指纹、会话保留、默认新标签及停止路径。

## 读取中停止的最小修复

原监督循环只在 `bridge.poll` 前检查停止信号，而一次桥接请求总预算为 8 秒，恰好等于原 `stop` 等待正常退出的时间。慢读取可能使停止进入系统退出回退；读端超时或半帧还会把整条管道标为失效，导致后续 `Browser.close` 被拒绝。

补丁保持正常 RPC 总预算和原 `stop` 等待各 8 秒。socket 和 CDP 读等待按最多 100 毫秒分段检查停止信号，写入等待也限制为 100 毫秒；取消时丢弃当前只读结果。收到停止后不再接受任何排队 RPC，不再解析或复用读端。只有此前写帧均完整、写端未出现失败时，才通过原私有管道发送一次固定 `Browser.close`，该次写入上限为 500 毫秒，再仅等待 Chrome 退出。写端失败或可能留下半帧时禁止追加关闭帧，继续采用原系统退出回退；此内部关闭路径没有对外协议入口。

生产 Rust 测试为 38 项通过、1 项真实 Chrome 测试默认忽略；新增断言覆盖未完成 socket 请求的取消和写端失败后禁止追加关闭帧，原半帧测试还验证读端失效后可发送且只能发送一次固定关闭帧。两套显式真实 Chrome 夹具继续验证正常读取、双方二进制读中停止、排队请求不会延迟退出，以及 Cookie 和进程清理。

该验收使用受控延迟，并未证明任意卡死的 Chrome 都能正常退出。原系统回退在 macOS 仍先请求系统正常退出，失败后再使用 SIGTERM；其他系统和该旧回退的极端失败行为本次未改造、未作会话保留保证。

## 协议

清单增加 `readOnlyBridge.protocol = "gapaw-browser-read-v1"`，版本暂保留 `1.5.0`，不向原命令表添加通用浏览器命令。

每个已启动的自动指纹监督会话绑定以下 Unix socket：

```text
<插件数据目录>/run/read-<SHA256(profileId UTF-8)前16个小写十六进制字符>.sock
```

默认目录中使用 36 字符身份编号时，路径为 88 字节，可用于 macOS 的 104 字节地址限制。路径仍过长时明确失败，不回退 TCP。哈希只用于缩短文件名：请求和响应均核验完整身份，已有 socket 一律拒绝占用，不能覆盖另一个实例。

一连接一请求，以换行结束的 JSON；请求不超过 16 KiB，响应不超过 512 KiB，供应端总预算 8 秒。读取正文预留 500 毫秒释放附着会话，所有 CDP 子调用共享剩余预算。

```json
{
  "protocol": "gapaw-browser-read-v1",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "profileId": "example",
  "sourceRevision": {
    "profileCreatedAt": 1,
    "profileUpdatedAt": 2,
    "subscription": null,
    "confidence": "metadata_only"
  },
  "action": "status"
}
```

成功响应为 `{ "ok": true, "data": { protocol, requestId, profileId, sourceRevision, instanceId, action, ... } }`。`sourceRevision` 在启动时冻结，格式与达人插件一致；它只是弱元数据标记，不是完整代理配置或登录态指纹。`instanceId` 是监督进程生命周期内固定的随机 UUID。

| 操作 | 附加输入 | 返回字段 |
| --- | --- | --- |
| `status` | 无 | `state: "ready"`；仅用固定 `Browser.getVersion` 验证管道，不读取页面 |
| `pages` | 无 | 最多 100 个 `pages: [{ targetId, title, url, platform }]` |
| `read-page` | `targetId`、从列页结果取得的 `expectedInstanceId` | `page: { targetId, title, url, platform, text, truncated }` |

平台限定为 `https://affiliate.tiktok.com`、`https://kalodata.com`、`https://www.kalodata.com` 的已有主页面，不允许非默认端口、URL 凭据或其他来源。输出 URL 去掉查询和片段，平台标记为 `affiliate` 或 `kalodata`。请求没有导航、脚本、点击、发送、Cookie、文件路径或任意 CDP 入口；陌生命令及额外字段拒绝。

## 正文快照与保护边界

读取通过固定的 `DOMSnapshot.captureSnapshot` 完成，不执行页面 JavaScript。仅投影主文档布局中的文本节点，不输出 DOM 属性、表单值、原始快照、嵌套文档或跨来源 iframe。正文限制为 120000 个 Unicode 字符，超限标记 `truncated`。

过滤脚本、样式、表单、输入框、文本域、选择器、可编辑节点、隐藏属性、不可见/透明样式和 iframe 祖先；对裁切路径以及落在祖先裁切边界外的文本采取保守丢弃。它是按这些 DOM/CSS 规则提取的正文快照，不能保证任意复杂视觉遮挡下的逐像素可见性，也不会自动读取虚拟列表尚未渲染的行或滚动加载更多数据。页面内容来自外部网站，必须视为业务资料而非执行指令。

读取前后核对目标、主 frame、完整 URL 和 loaderId；快照文档地址也必须一致。导航变化则丢弃结果。HTTP/Chrome 错误页即使目标列表仍显示原站点地址，也不会被当作平台正文。

数据目录和运行目录必须属于当前 UID，不能允许组或其他用户写入；运行目录收紧为 `0700`，socket 为 `0600`，服务端验证客户端 UID。固定路径拒绝符号链接，结束时只删除仍匹配自己设备号和 inode 的 socket。这个协议不隔离同一系统用户下的其他程序。

异常或超大的 CDP 帧、管道中断和帧读取超时会标记读端失效，之后健康检查也会失败，须重新启动该身份；停止仍可在写端确定有效时发送上述固定关闭帧。完整的 CDP 错误响应（例如页面已经关闭）不破坏后续帧。断管道时附着会话可能无法正常释放，重新启动浏览器后清理；不会为清理延长请求时限。

已有普通启动模式没有私有管道，不能使用桥接；旧监督进程也不会因磁盘升级而自动获得接口。需要使用升级后的原插件重新启动自动指纹会话。本次未安装补丁或重启真实身份。失效残留 socket、路径过长或绑定失败会使该次自动启动失败并关闭新启动的 Chrome，不会覆盖旧路径或降级为无保护启动；应先核查对应旧监督进程，不能盲目删除仍被使用的 socket。

桥接可用仅表示能够请求页面正文，不证明代理出口、平台登录、目标字段、费用参数或选人数据完整。后续平台读取契约和业务报告仍须分别校验。
