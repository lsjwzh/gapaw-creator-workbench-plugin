【邀约草稿交回达人工作台】
这次操作编号为 {{OPERATION_ID}}。请为下列达人与渠道撰写邀约草稿，并作为这次操作的候选版本交回插件。候选版本不会自动替换工作台里的现有文案，必须由用户在插件页面比较后点击“采用”。

1. 在当前 MultiCC 宿主调用 POST /api/plugins/gapaw-creator-workbench/run，请求体为 {"command":"draft-context","input":{"operationId":"{{OPERATION_ID}}","taskId":本任务的taskId}}。使用宿主提供的 MULTICC_BASE_URL。返回内容是发起时冻结的达人档案摘要、合作设置、谈判摘要、最近往来与各渠道现有文案（含 revision），以及 submissionTemplate。只依据这些资料和用户在本任务中补充的条件撰写，不编造视频细节、销量或合作历史；资料缺失时在 note 中说明。
2. 写作规则：金额写【固定费】，佣金写【佣金比例】，署名写【姓名】，工作台会按每位达人的合作设置替换；不要直接写 50/100 美元。评论只建立联系；私信简短；邮件给完整条件（需要 subject）；联盟邀请写平台站内说明；跟进稿只用于确实联系过的人。语言与现有文案保持一致（默认英文正文）。每条 note 用中文简述改写依据和待核项。
3. 调用 {"command":"submit-drafts","input":{"operationId":"{{OPERATION_ID}}","taskId":本任务taskId,"submissionId":新生成的唯一编号,"drafts":[{"creatorId":"GW001","channel":"email","subject":"…","body":"…","note":"…"}]}}。只能提交本操作范围内的达人与渠道，每个达人与渠道组合在一次提交中至多一条。网络结果未知时用同一 submissionId 和同一内容原样重试；用户要求修改时，用新的 submissionId 再提交，插件会生成新版本，旧版本保留。
4. 用 {"command":"get-drafts","input":{"operationId":"{{OPERATION_ID}}"}} 读回，核对版本号与条数。向用户说明“草稿候选已交回插件，待在插件页面比较并采用”。不能声称已写入工作台档案、已发送或已联系达人。

本操作不发送邮件、私信、评论或联盟邀请，不登记触达事件，不修改合作设置。用户在任务中补充条件后，按新条件重新提交即可。
