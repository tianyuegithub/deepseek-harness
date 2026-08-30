# Agent Note：外部 Session 事件生产者的持久声明

Status: implemented

[English](2026-08-29-durable-external-session-event-producers.md) | 中文

## 问题

`SessionEventMap` 有意采用可合并扩展设计，因此仓库外 Host Package 可以通过编译并追加自己的仅日志 Session 事件。当前持久化在进程存活期间会接收这些事件，但 `PersistenceCoordinator` 在首次冷读取时会拒绝它们，因为 `KNOWN_SESSION_EVENT_TYPES` 只包含从本仓库声明生成的事件。这种失败关闭行为可以防止静默丢失语义，但也使已安装的外部产品无法把 Session Log 作为持久事实源。

持久日志必须说明解释它需要哪些外部代码。只有进程内允许列表是不够的：同一份产物会随当前恰好挂载的插件而变得可读或不可读，而且没有持久证据说明每组事件词汇由哪个生产者写入。忽略事件、复用第一方事件名、关闭已知类型检查或发行私有持久化分叉都会削弱一个不变量：读取成功就代表完整还原了 Session 含义。

PactFlow 是首个具体外部消费者。它的项目状态需要必需的仅日志事件、冷恢复、保留产物的插件移除，以及精确重装恢复。该机制必须保持通用，不能向 DSH 核心加入 PactFlow 名称或行为。

## 决策

### 一个核心声明事件

新增一个第一方仅日志事件 `session/external-event-producer`，其不可变 payload 记录：

```ts
interface ExternalSessionEventProducerDeclaration {
  readonly producer: string
  readonly version: string
  readonly eventTypes: readonly string[]
}
```

`producer` 是发布 Package 身份，`version` 是解析后的 Package 版本，`eventTypes` 是该生产者可以追加的经过排序的精确集合。这个元组本身就是持久词汇身份；摘要既不增加信任，也不增加信息，因此不持久化。声明 payload 是无损 JSON，不包含可执行 schema；核心校验非空有界值、规范排序、名称唯一性、命名空间语法以及与第一方事件类型的冲突。

声明事件是读取时必需的，但核心能够解释它。更旧的 DSH 构建不认识这个新事件，因此会通过现有未知事件规则拒绝日志。事件 envelope 和 `SessionHeader` 结构都不变化，因此 `SESSION_FORMAT_VERSION` 不变化。

### SessionStore 所有的生产者注册表

`SessionStore` 拥有通过 `ctx.sessions.externalEventProducers` 暴露的、由 fiber 管理生命周期的外部生产者注册表。受信 Host 插件在组合期间注册一个精确声明。注册会拒绝重复的生产者/版本身份、两个生产者争用同一事件类型、第一方事件名、非法名称，以及与已注册身份的规范事件集合不同的声明。释放注册会移除运行时注册，并阻止其 handle 再次追加事件。

注册返回与生产者绑定的 handle。受支持的追加路径等价于：

```ts
declare const ctx: {
  sessions: {
    externalEventProducers: {
      register(options: { producer: string; version: string; eventTypes: readonly string[] }): {
        append(session: unknown, type: string, payload: unknown): void
      }
    }
  }
}
declare const session: unknown
declare const payload: unknown

const pactflowEvents = ctx.sessions.externalEventProducers.register({
  producer: '@nous/dsh-pactflow',
  version: '0.1.0',
  eventTypes: ['pactflow/project-initialized'],
})

pactflowEvents.append(session, 'pactflow/project-initialized', payload)
```

该 handle 只接受自身的精确事件类型和仅日志 payload。它在改变日志之前完整校验目标事件。在某个 Session 中首次用该生产者身份追加时，它同步追加 `session/external-event-producer`，随后追加目标事件，中间没有异步间隙。后续追加复用匹配声明。声明冲突、handle 已释放、Session 携带不同生产者版本或事件集合，以及事件不属于 handle 集合，都会在目标事件进入日志前失败。

直接的 `session.append()` 仍是第一方类型化原语。仓库外 Package 必须使用与生产者绑定的 handle 写入持久事件。绕过 handle 的 Package 仍可能在 JavaScript 中构造经过声明合并的事件，但该事件没有获准声明，持久化读取器会拒绝它；任何绕过方式都不会成为受支持的持久化路径。

### 确定性的读取准入

`PersistenceCoordinator.assertEventsSupported()` 按序扫描规范化事件，并用 `KNOWN_SESSION_EVENT_TYPES` 初始化本次读取的准入集合。

1. 对 `session/external-event-producer` 事件执行结构校验。
2. 当前运行时注册表中必须存在与其完全一致的声明。生产者缺失、版本不匹配或事件集合不匹配都会抛出 `SessionFormatUnsupportedError`，诊断包含生产者身份，并在可用时包含原始产物位置。
3. 将声明的事件名加入该日志的准入集合。已经被另一个生产者或核心准入的名称会被拒绝。
4. 后续非核心事件只有在更早的有效声明已经准入其精确类型时才被接受。出现在声明之前的外部事件会在对应序号被拒绝。

读取器绝不把只有运行时注册视为许可，也不会因为声明之后没有匹配外部事件就忽略声明。声明表示该 Session 需要这个精确生产者才能建立完整语义。

JSONL 与 SQLite 把声明存为普通逻辑事件。后缀读取保留现有作用域规则：可 seek 的后端可以只校验返回的后缀；但如果后缀包含外部事件而不含其声明，协调器会先回退读取完整持久前缀，再决定是否支持。这与受支持旧格式规范化属于同一类前缀依赖，不能让 SQLite 接受完整 JSONL 读取会拒绝的后缀。

### 升级、移除与兼容

移除外部 Bundle 会在 Profile 重启后移除运行时注册。Session Header 仍可列出，原始产物保持不变，但读取声明了缺失生产者的日志会以 `SessionFormatUnsupportedError` 失败。重新安装完全相同的生产者/版本/事件集合注册后，不改写日志即可恢复读取。

新版插件不会隐式宣称兼容旧声明。如果某个发行版有意支持旧日志，它需要额外注册该历史元组的只读兼容声明，并保留能够证明该主张的 payload 版本 fold。当前写入 handle 只注册和追加当前声明。可选外部事件、通配命名空间、兼容版本范围、schema 驱动迁移，以及生产者缺失时跳过事件，都不属于首版合同。

### 范围与所有权

DSH 核心拥有声明校验、生命周期注册、追加顺序、持久化准入和诊断。外部生产者拥有自身 payload schema、payload `v` 字段、fold、Projection、迁移和兼容注册。注册表不会在持久化解析期间执行插件代码，也不会让持久化依赖 Web Client、Agent Preset 或模型工具。

该功能是通用外部扩展合同。只有当机制进入受支持的 DSH 发行版后，PactFlow 才从独立仓库消费它；本仓库不会加入 PactFlow Package、事件名、Projection 或迁移。

## 已考虑的替代方案

**使用当前已挂载事件名集合。** 拒绝，因为产物可读性会在没有持久生产者证据的情况下变化，重新引入现有失败关闭决策明确避免的组合依赖行为。

**把生产者声明加入 `SessionHeader`。** 首次实现拒绝，因为 Header 不可变且在 Session 创建时固定。后续引入的产品无法在不 fork 或改写唯一产物的情况下加入首个事件，而且 Header 结构变化会无必要地触发格式版本迁移。

**持久化词汇摘要而不是精确事件名。** 拒绝，因为读取器仍需要精确名称来准入事件，而无密钥摘要既不能证明 Package 真实性，也不能证明 schema 兼容。精确规范元组概念更小，诊断也更好。

**持久化可执行 schema，或为所有事件采用运行时 schema 注册表。** 拒绝，因为这是运行时 schema Agent Note 已分析的全仓词汇重设计。本提案只建立持久所有权和必需读取器在场条件；生产者继续拥有 payload 校验与版本。

**允许生产者缺失并跳过它的事件。** 拒绝，因为未知持久事实可能影响 Projection、授权、恢复或之后的模型输入。读取器无法推断它是可选信息。

**提升 `SESSION_FORMAT_VERSION`。** 拒绝，因为 Header 和事件 envelope 都没有改变。旧读取器已经会对新的第一方声明事件安全失败，新读取器仍可读取不含声明的旧日志。

**在每个外部产品中 patch 持久化协调器。** 拒绝，因为这会分叉信任边界、破坏 Profile 可移植性，并让卸载或 DSH 升级行为变成产品特例。

## 测试

- 核心单元测试覆盖声明结构、规范排序、边界、命名空间、第一方冲突、重复生产者身份、重复事件所有权、释放行为与声明冲突。
- 与生产者绑定的追加操作在首个事件前只写一次声明，不重复声明，并在目标校验失败时保持日志不变。
- JSONL 和 SQLite 合同测试能够持久化并冷读取已声明外部事件，且存在匹配生产者注册。
- 两个后端都以 `SessionFormatUnsupportedError` 拒绝声明前外部事件、未声明事件、生产者缺失、版本不匹配、事件集合不匹配和所有权冲突；诊断包含生产者/事件，并在可用时包含原始产物。
- 完整读取和后缀读取作出相同准入决定；所需声明位于返回范围之外时，后缀读取回退到前缀，而不是过度接受或过度拒绝。
- 注销生产者可模拟 Bundle 移除，使冷读取失败但不改变产物；再次注册精确元组后恢复读取。
- 现有第一方日志和不含外部声明的 Session 保持字节兼容且可读，`SESSION_FORMAT_VERSION` 保持不变。
- 生成的持久化目录、Session 与 Persistence Package 文档、TypeScript 公共导出、Python SDK 生成期望以及无密钥快照都包含声明事件与新诊断。
- `pnpm run verify-persistence-catalog`、Session/Persistence 定向测试、JSONL/SQLite 差分测试、`pnpm run test:docs`、`pnpm run doc-sync` 和仓库 lint 全部通过。

## 后果

- 受信 Package 可以谎报自身 Package 名或兼容性。该注册表提供确定性所有权和失败关闭恢复，不提供 Package 签名验证；安装信任仍由 Bundle Manager 负责。
- 两次同步追加会先向进程内 observer 暴露声明，再暴露目标事件。handle 必须预校验目标，observer 也必须已经能够独立容忍任何已提交仅日志事件；两次追加之间没有异步操作或外部副作用。
- 插件重构后，历史兼容注册可能变成错误主张。外部生产者必须为其注册的每个历史元组测试冷 fold；DSH 无法只从事件名推断 payload 兼容性。
- 依赖前缀的后缀准入可能在声明位于后缀外时增加一次完整日志读取。这保留了正确性，并且只影响使用外部事件的 Session；后续可用索引化声明表优化，而不改变日志合同。
- 新公共 API 会成为长期扩展边界。在真正出现可选事件消费者并提供独立、可评审的语义合同之前，它必须限制为必需的仅日志事件。
