# Agent Note: 单次运行的 Subagent 工作区权限

Status: implemented

[English](2026-08-30-per-run-subagent-workspace.md) | 中文

## Problem

受信 Workflow Consumer 需要为同一个父级在不同 Git worktree 中启动子级，同时让进程启动、文件系统与 shell 策略、持久化和恢复共享一个工作区事实。要求模型自行切换目录无法建立该事实，因为子级 `SessionHeader` 与 Provider 进程初始化仍会使用另一个工作区。

单次运行工作区会改变文件与进程权限。因此它必须是显式 Provider 能力，在不支持或不可用时必须于发布前失败，并且必须成为工具、策略、进程适配器和持久化共同消费的唯一子 Session 工作区事实。部署级固定目录仍是操作员限制，单个调用方不能静默绕过。

## Decision

`SubagentStartRequest` 携带可选 `cwd`，`SubagentCapabilities` 携带必填 `cwd` 成员。请求提供 `cwd` 时，`SubagentRuntime.start()` 要求选中的 Provider 声明该能力。该字段仍是受信的同进程 API 输入，不属于模型可见 `subagent` 工具 schema。

声明该能力的 Provider 在发布前解析子工作区。仅当 Provider 没有配置 `cwd` 时，请求提供的绝对且可访问目录才优先于父 Session 工作区。当 Provider 已配置 `cwd` 时，不同的请求目录会失败，而不是覆盖或忽略部署限制；相同目录可以接受。Provider 通过已有的本地或远端工作区准入路径校验最终目录。

进程内 spawn 与 fork Provider 在 Session 可见前把最终目录写入子级 `SessionHeader.cwd`。进程外 ACP、Codex、Claude Code 与 DSH SDK Provider 把同一最终目录传给进程和远端会话初始化。请求是远端 Run 在父端的工作区权威；Provider 不在结果中另造第二个工作区字段。

## Alternatives considered

**要求每个 Worker 执行 `cd`。** 不采纳，因为提示词遵从不是权限机制，shell 与文件系统默认值仍保留父工作区，持久子级身份也会记录错误目录。

**创建 Header 指向 worktree 的伪造父 Agent。** 不采纳，因为这会伪造所有权与谱系，绕过 Subagent Runtime 的父级检查，并创建没有合法 Session 生命周期的存活对象。

**增加 PactFlow 私有 Provider 包装器。** 不采纳，因为每个 Provider 已经拥有工作区解析与子级发布。外部产品重新实现这些生命周期会让取消、持久化和策略行为不一致。

**允许请求总是覆盖 Provider 配置。** 不采纳，因为 Provider 配置可能把执行固定在操作员批准的 sandbox 或 checkout。单次运行选择不能扩大该部署权限。

## Testing

能力测试证明不支持的 `cwd` 会在 Provider 启动前被拒绝。共享工作区测试覆盖绝对目录准入、请求优先级、配置目录冲突、父级回退和无效路径。Spawn、ACP、Codex、Claude Code 与 DSH SDK Provider 测试通过已发布子 Session 或真实 Provider 启动协议观察所选目录；省略字段的测试保留既有行为。类型检查要求每个 Provider 与测试 Provider 声明新能力。

## Consequences

受信 Host 插件可以选择 DSH 进程已经能够访问的任意目录。本决策不向模型调用方授予新字段，也不替代 sandbox 或文件系统策略；部署仍需限制进程本身。

增加一个能力标志会更新所有 Provider 与测试 Provider。缺失声明必须导致编译失败，而不是默认为 false，避免未来 Provider 意外接受或忽略请求。
