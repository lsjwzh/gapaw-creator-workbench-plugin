【谈判摘要与回复草稿交回达人工作台】
这次操作编号为 {{OPERATION_ID}}。请阅读这位达人已登记的往来消息，整理谈判摘要并撰写一条回复草稿，作为候选版本交回插件。候选版本不会自动替换工作台里的谈判摘要或文案，必须由用户在插件页面比较后分别点击“采用”。

1. 在当前 MultiCC 宿主调用 POST /api/plugins/gapaw-creator-workbench/run，请求体为 {"command":"draft-context","input":{"operationId":"{{OPERATION_ID}}","taskId":本任务的taskId}}。使用宿主提供的 MULTICC_BASE_URL。scope.creators[0] 是发起时冻结的档案摘要、合作设置、当前谈判摘要、目标文案位置的现有文案（含 revision），conversation 是最近至多 40 条往来消息（含 messageId、方向、渠道、类型、原文与中文摘要）。只依据这些消息和用户在本任务中补充的条件，不编造对方没说过的报价、承诺或时间。
2. 谈判摘要是事实记录，按往来消息写实际金额与条件，不用占位符：status 写当前进展（一句中文）；our_offer 写我方最新报价与条件；their_ask 写对方最新要价与条件，对方没提就留空；next_step 写下一步由谁做什么。basis 列出支撑摘要的 messageId，必须来自 conversation。“自动回复”类型的消息不能当作对方真实答复。
3. 回复草稿：针对对方最后一条真实来信回复；对方还没回信时，可只交回摘要、不交回草稿。金额写【固定费】，佣金写【佣金比例】，署名写【姓名】，不要直接写 50/100 美元；需要商品资料链接时写【两款商品资料链接】，发送前由人工替换。不能使用其他自造的【…】占位符。语言与往来消息一致；回复邮件需要 subject。note 用中文简述依据和待核项。
4. 调用 {"command":"submit-drafts","input":{"operationId":"{{OPERATION_ID}}","taskId":本任务taskId,"submissionId":新生成的唯一编号,"negotiation":{"status":"…","our_offer":"…","their_ask":"…","next_step":"…","basis":["messageId"],"note":"…"},"drafts":[{"creatorId":达人编号,"channel":本操作的文案位置,"subject":"…","body":"…","note":"…"}]}}。网络结果未知时用同一 submissionId 和同一内容原样重试；用户要求修改时用新的 submissionId 再提交，插件生成新版本，旧版本保留。
5. 用 {"command":"get-drafts","input":{"operationId":"{{OPERATION_ID}}"}} 读回，核对版本号。向用户说明“摘要和回复草稿已交回插件，待在工作台比较并采用”。不能声称已更新工作台、已发送或已回复达人。

本操作不发送任何消息，不登记往来消息或触达事件，不修改合作设置与报价。用户在任务中补充条件后，按新条件重新提交即可。
