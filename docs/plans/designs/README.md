# DA Design Workspace

本目录只保存尚未冻结且需要跨多轮讨论的 active design topic。一个 topic 最多一个 Workspace；DA 维护讨论面，UD 是唯一 canonical design writer。AI 仅在当前任务明确绑定该 topic 时装载对应 Workspace，不把本目录当作默认 stable truth。

## Minimal template

```markdown
# <Design Topic>

## Objective

## Scope

## Protected scope

## Current truth baseline

## Current proposed design

## Human-confirmed Proposal boundary

## Open questions

## Intended canonical changes

## Validation and rollback

## Next discussion point
```

Workspace 原位更新，不记录聊天或时间线。Human 确认 exact Proposal 后由 DA 提交 UD 审计；接受内容进入 canonical truth。全部有效内容回写后，在独立 cleanup 边界删除 Workspace。
