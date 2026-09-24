# OES Intake

本文件只保存尚未进入 Design Task 的当前候选。Design Task 创建后移除对应条目。

| Candidate | Current question |
| --- | --- |
| Egocentric shop-floor process intelligence | 是否建立第一视角与固定机位协同的车间过程智能能力，用于质量事件视频追溯、技能与 SOP 提取、新员工防错及经人工复核的效率分析；在选择首个试点工序时继续讨论采集设备、MES/质量关联、数据最小化与保留、边缘推理、模型评估和员工权益边界。 |
| Cross-scenario image asset retrieval | 是否建立统一图片资产与意图检索能力，以及来源权限、tenant/org 隔离、OCR/视觉理解和高权限跨来源检索边界。 |
| Robot / automation execution | 如何在现有 machine principal、ActionGrant、权限和审计基础上定义 trigger、run、action、retry、timeout 与 workflow 边界。 |
| AI Decision Context | `DecisionType / ContextDefinition / ContextBuilder / ContextPackage / Suggestion` 是否需要成为正式平台对象。 |
| Multi-channel role assistants | 如何在统一 AI 平台上支持多渠道、多岗位 Agent Profile，并确定 Task Assistant 之后的首批场景。 |
| Tenant Web lock screen | 锁屏目的、解锁凭据、自动锁屏策略以及与登录 session 的边界。 |
| QR code login | 终端范围、challenge、轮询、过期、重放保护与审计模型。 |
| Self-service registration | 邀请、自助注册、租户初始化以及 Auth/Identity ownership。 |
| Third-party login | Identity provider 范围、tenant/platform 配置、callback continuation 与外部身份绑定。 |
| Server-side interaction challenge | 将当前前端滑块升级为服务端 challenge 时的时效、滥用防护与审计契约。 |
| Workflow service | 是否建立跨域人工审批服务，以及业务 owner、责任组织、有限线性节点、退回修改和最终业务状态的边界。 |
| Contract document review agent | 是否建立合同文件审核 Agent 能力，以及适用合同范围、审核规则、风险提示、证据引用、权限隔离、人工复核与审计责任边界。 |
