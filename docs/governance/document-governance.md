# OES 文档治理

## 1. 目标

OES 文档只保存当前有效的设计、契约、操作方法和活跃工作面。Git 保存历史；文档树不保存聊天记录、迁移流水、完成账本或 task registry。

核心规则：

- 一个事实只有一个规范真相源；
- stable truth 与 active work 分离；
- Index 只导航；
- 当前状态原位更新；
- 已被吸收的过程文件在独立 cleanup 边界删除；
- 删除前证明唯一有效内容已进入正确真相源。

## 2. 目标结构

```text
docs/
├── index.md
├── architecture/
├── contracts/
├── adr/
├── governance/
├── runbooks/
└── plans/
    ├── index.md
    ├── intake.md
    ├── backlog.md
    ├── designs/
    ├── deliveries/
    └── features/     # pre-V2 historical records only
```

不建立 archive、history、migration ledger 或 task ledger。V2 的 active delivery control surface 是 owner task stable artifact root 中的 Delivery Package (DP)；CO 另有 Aggregate Delivery Package (ADP)。`docs/plans/deliveries/` 仅保留历史说明，不是 active 状态源。

## 3. 稳定真相源

### 3.1 Architecture

- `architecture/system/`：系统愿景、上下文、bounded contexts 与整体技术结构。
- `architecture/services/<service-name>.md`：单服务职责、核心对象、拥有/不拥有的真相和主要协同引用；每个服务仅一份。
- `architecture/platforms/`：身份、权限、信任、租户、事件、审计、AI 等跨域平台设计。
- `architecture/collaborations/`：可复用的跨服务业务旅程与协同边界。
- `architecture/frontends/` 与 `architecture/terminals/`：稳定交互边界。

其他文件引用这些真相，不重复定义服务对象、边界或命名。

### 3.2 Contracts

`docs/contracts/` 保存规范性的黑盒业务语义，包括行为、输入输出、错误、权限、租户和兼容性边界。Proto、OpenAPI、schema 与生成类型是可执行表达；语义不一致视为契约缺陷并同步修正。

### 3.3 ADR

ADR 解释高影响选择的原因，architecture 解释当前方案。bounded context、新服务、跨服务通信、身份/权限/安全/租户模型，以及高成本且难撤销的选择可建立 ADR；普通交付、UI、内部重构、测试步骤和实现清单不建立 ADR。

### 3.4 Governance 与 runbook

- `AGENTS.md` 与 `docs/governance/**` 定义当前协作、执行和文档纪律。
- 项目只允许一个 active UD；UD 是唯一 canonical design writer。DA 提交一次 Human-confirmed Proposal，UD 基于当前 architecture、ADR、contracts 与 governance 独立审计并把接受结论放入规范真相源。
- DO、CO、RV、bounded helper、请求来源和父 task 都不成为 canonical design writer。
- Runbook 只保存当前可执行的操作、故障处理与恢复步骤。
- 技术 binding、task 状态、进度、一次性复盘和已完成治理项目不进入长期治理文档。

DA、UD、DO、CO 是 Human-visible task；RV 是可查看进度与结果的独立 subagent，并在 DP/ADP 中保存稳定身份。task/subagent 与 Git worktree 相互独立；host-local 操作不为可见性创建 repository record、branch、candidate 或 PR。

## 4. Design Workspace 与 Proposal

需要跨多轮维护的未冻结设计可使用：

```text
docs/plans/designs/<design-key>.md
```

Workspace 由 DA 维护，只保存 objective、scope/protected scope、truth references、current proposed design、open questions、intended canonical changes 和 next discussion point；每轮原位覆盖，不追加时间线。

Human 确认 exact Proposal preview 后，DA 才形成 immutable Proposal 并提交 bound unique UD。UD 未作实质修订地接受后，Proposal 的确认持续覆盖 canonical write、Design PR、Merge Queue、merge verification 与 exact Proposal cleanup。后续实现由一次 Delivery card 激活。全部结论进入 canonical truth 后，Workspace 在独立 cleanup 执行边界删除，不新增确认节点。

## 5. V3 Delivery Package

一个 repository DO 对应一个 stable artifact root 中的 DP：

```text
<owner-task-stable-artifact-root>/delivery-package.json
```

DP 只保存 activation-fixed objective、scope/protected scope、dependencies、acceptance、risk、rollback，以及 execution slices、candidate/self-test/RV/CI/PR、remaining risk 和 cleanup state。V3 明确绑定受信 Human confirmation receipt，并保存一个可查看 RV subagent 的 canonical session path、reviewer 与 append-only candidate history；PASSED/FAILED 都绑定同一 RV。每个 design/DA/UD reference 在 DP 接纳时必须从 exact physical path 重开并校验文件 bytes；ADP 接纳 child DP 时同样重开这些 design bytes。已完成的 evidence 必须绑定 evidence type、verdict、owner/reviewer、evidence generation、当前 basis、exact candidate/operation 与 source artifact hashes；只匹配任意自指纹或重新贴状态不构成可复用证据。V3 是正式 wire-version 升级，旧 V2 artifact 不会被误当成 V3；续作时由 controller 用当前确认 receipt 重新签发 V3 package。只有 exact DO 写自己的 DP；状态原位覆盖。证据、patch、verification 与 rollback 引用由薄验证入口生成，不由 Agent 手工拼装。

CO 的 decomposition、dependency order、integration contract、aggregate acceptance、scoped RV references 与 aggregate candidate 保存在 CO stable artifact root 的 ADP。ADP 重开 Human-confirmed complete child roster，精确覆盖每个内部 DO DP，并把外部 dependency 作为独立 accepted identity 显式声明；缺失内部 child/dependency 时不得生成 Aggregate RV input。ADP 另绑定 accepted candidate SHA、aggregate RV/CI、merge、post-check 与 cleanup。CO 默认生成一个 aggregate branch/PR；若 Human 明确确认 independently releasable 的 independent-PR exception，各 DO DP 仍分别绑定各自 candidate/PR。

Repository merge 和 main verification 完成后，DP/ADP 自动进入 terminal lifecycle disposal；先终止 RV subagent，再处理 owner。repository-mode package cleanup 必须重开 exact owner binding，确认 package 的 physical path 位于 bound repository 之外，并以 explicit worktree/Git-directory 参数和受控环境（排除继承的 Git repository/index/discovery/config overrides）对该 bound repository 执行 Git status 观察，不能接受调用方声明的空 diff。Host-local package cleanup 必须用同一受控环境观察 stable artifact root 不属于任何 Git repository。Package 与所有 ancestor 组件都使用 no-follow entry 检查；dangling link 仍是存在的 alias/unknown resource，不得当作 absent。删除 package 属于零新增内容的 cleanup 执行边界，不新增确认，也不得借 cleanup 产生产品修改或其他 repository diff。未知、共享、歧义或不匹配资源保留并交 Human 决定。

## 6. Host-local work

Host-local DO 在 stable artifact root 保存同一 DP schema 的 scope/protected scope、精确资源、acceptance、verification、post-check 与 rollback；没有 repository 修改时不创建 Git candidate、PR、Merge Queue 或远程 CI。Host-local CO 使用 ADP 绑定至少两个独立 workstream 及真实并行/跨操作集成。破坏性操作绑定 exact operation candidate，完成后按同一 owner 的 child-first disposal 处理临时资源与 task。

## 7. Intake 与 Backlog

- `plans/intake.md` 是当前能力候选入口；它只保存尚未进入设计或交付的需求。
- `plans/backlog.md` 只保存仍有效且明确延期的事项。
- 进入稳定设计时路由到 DA；已设计且 cohesive 的实现路由到一个 DO；只有多个 independently ownable workstreams 且存在真实并行或 cross-delivery integration 时才路由到 CO。
- 完成、取消或失效的条目直接删除；不保存 promoted/cancelled/completed 历史。

## 8. Index

Index 只包含一到两句目录用途、当前规范文件名称和 repository-relative links。禁止进度、owner、状态镜像、`updatedAt`、迁移说明、长阅读顺序或 future truth。导航最多两级：

```text
docs/index.md -> category/index.md -> canonical document
```

Active Workspace 由目录中的当前文件表示；DP/ADP 由 owner task stable artifact root 表示，不维护第二状态表。

## 9. 历史文件

`docs/plans/features/` 与 `docs/plans/deliveries/` 下的既有文件是 pre-V2 historical records，不是 active route、template 或 owner authority。它们可保留原词作为历史证据；任何新交付都使用 stable artifact root 中的 DP/ADP。后续逐文件清理时：

- 已存在于 canonical truth、active Workspace 或 DP/ADP：删除重复文件；
- 仅包含完成 checklist、命令或流水：删除；
- 包含唯一稳定事实：提取最小事实到 architecture/contract/ADR/runbook 后删除；
- 包含仍有效的未冻结设计：提取当前草稿到 active Workspace 后删除。

不得整批搬运历史文本，也不得为清理建立 archive 或 ledger。

## 10. 轻量验证

文档变更至少检查：

- 所有 Markdown 相对链接存在；
- stable truth 被索引且不重复；
- active route 只出现 DA/UD/DO/CO/RV；
- active DP/ADP 路径仅为 owner task stable artifact root；
- repository 文档不含本机 home 目录；
- plans index 不枚举实现进度；
- cleanup 变更没有新增/修改 repository 内容；
- `git diff --check` 通过。

规范语义变化继续经过 DA/UD；纯 editorial 变更只运行与 changed paths 和风险匹配的 focused checks。
