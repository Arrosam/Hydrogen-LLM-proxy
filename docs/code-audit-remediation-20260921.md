# 2026-09-21 全仓审计逐项复核与修复

依据本地 `code-audit-core-fullrepo-20260920-2255.md` 的 AF-01…AF-73。目标仓库 Hydrogen-LLM-proxy，基线 75e605a，分支 `codex/fix-core-audit-20260920`。源报告及其他原有未跟踪文件不纳入此次提交。

## 验证摘要

最终验证：Node 22.22.2；`npm ci` 从最终锁文件成功安装。

| 验证 | 结果 |
|---|---|
| `npm run lint` | 通过 |
| `npm run typecheck` | server、web 均通过 |
| `npm test` | server 71 文件 / 1161 测试通过；web 1 文件 / 11 测试通过；共 1172，通过率 100%，零失败、零跳过 |
| `npm run build` | server 与 web 生产构建通过；Vite 仍有非阻断的大 chunk 提示 |
| `npm audit` | info/low/moderate/high/critical 全部为 0，包含开发依赖 |
| Docker | 最终 lockfile 镜像构建通过（本机 linux/arm64）；无网络一次性容器加载 better-sqlite3/argon2/Fastify/static 成功；CI 的 linux/amd64 构建留待 CI 实际运行 |
| Compose | 根目录与 deploy/vps 两份配置均通过 `config --quiet` |
| Drizzle | 临时目录生成 17 表成功；相对输出路径再次生成显示无 schema 变化，原迁移文件和应用数据库未修改 |
| 补丁与台账 | `git diff --cached --check` 通过；AF-01…AF-73 共 73 唯一条目，无缺号 |

结论分布：69 项修复/加固，3 项核实并补验证，1 项澄清契约。每行的“修复”包含适用的行为修复、加固或维护改进；不是宣称原报告每一项都是已证实漏洞。AF-24/52/60/66 保留具体复核结论，AF-64 明确保留自助查询产品契约。

## 逐项结论

| ID | 结论 | 修改与验证依据 |
|---|---|---|
| AF-01 | 已修复/加固 | 随机初始密码；轮换未完成设置的历史默认密码并撤销旧会话；设置会话只能改密/读自身。auditSecurity、auditPersistence。 |
| AF-02 | 已修复/加固 | GET 叠加 AbortSignal.timeout 墙钟期限；滴流下载测试证明持续有数据也会到期。auditTransport。 |
| AF-03 | 已修复/加固 | Anthropic/Responses 同族渲染保留服务端工具调用与结果、错误和暂停标志。auditProtocol、serverTools。 |
| AF-04 | 已修复/加固 | 解析保留 provider-executed 内容及同族 opaque 数据；不再把服务端调用改写成客户端函数。auditProtocol。 |
| AF-05 | 已修复/加固 | collectStream 接收服务端调用/结果并保留输入、来源、错误、未执行状态。auditIr、auditProtocol。 |
| AF-06 | 已修复/加固 | start 输入/缓存计数在流截断时仍进入用量账本。auditIr。 |
| AF-07 | 已修复/加固 | addUsage 传播任一阶段 incomplete 标记。auditIr。 |
| AF-08 | 已修复/加固 | CI verify 要求 lint、双工作区类型检查、测试、构建、生产依赖审计；镜像发布依赖 verify，PR 不发布。 |
| AF-09 | 已修复/加固 | 补缺失/无效/禁用/过期/配额边界及关闭配额执行分支。auditContracts。 |
| AF-10 | 已修复/加固 | Docker 构建及运行阶段均用根 lockfile + npm ci；本地 Docker 实际构建验证。 |
| AF-11 | 已修复/加固 | engines、.nvmrc、CI、Docker、esbuild target 对齐 Node 22；README 说明最低 22.12 与原生模块构建前提。 |
| AF-12 | 已修复/加固 | compose 转发 HOST、JSON_COMMIT_GRACE_MS、UPDATE_REPO 等遗漏项；VPS 保留安全默认设置。 |
| AF-13 | 已修复/加固 | 示例与中英文 README 的 LOG_PAYLOAD_MAX_CHARS 对齐实现 100000。 |
| AF-14 | 已修复/加固 | 成功状态返回非法 JSON 时显式抛错；不吞解析异常。auditTransport。 |
| AF-15 | 已修复/加固 | 永久 URL/格式错误类型优先于含 timeout 文本的启发式判断。auditContracts。 |
| AF-16 | 已修复/加固 | 下载跳转/读取/结束增加取消检查，监听 abort 销毁流并清理监听器。auditTransport。 |
| AF-17 | 已修复/加固 | 更新查询合并在途 Promise，失败有 30 秒冷却，包括强制刷新。update 测试。 |
| AF-18 | 已修复/加固 | 整数解析用 Number + 截断和边界约束，不再把 1.5 变成 15。web primitives。 |
| AF-19 | 已修复/加固 | 展示用 != null 区分零配额/无限额；零上限进度显示耗尽；API 零边界和 UI 算法复核。 |
| AF-20 | 已修复/加固 | useAsync 请求序号及卸载失效守卫，旧响应不会覆盖新状态。web primitives。 |
| AF-21 | 已修复/加固 | scrypt salt 要求规范 Base64 与 16 字节，补 N/r/p/内存边界拒绝测试。auditContracts。 |
| AF-22 | 已修复/加固 | 参数和 overrides 独立深复制、递归合并 extra、null extra 不清空原键。auditContracts。 |
| AF-23 | 已修复/加固 | 补 URL 判定表各分支，admin 前缀仅匹配真实边界。auditContracts、fuzzyUrl。 |
| AF-24 | 已核实并补验证 | 直接 import 数不是行为覆盖率，不能据此断言 41 个模块无测试；补 redactor、tokens、endpoints、logPruner 等真实边界。auditContracts、auditPersistence；不宣称 100% 覆盖。 |
| AF-25 | 已修复/加固 | Responses input 中 web_search_call 转为可往返 IR，pending 调用保持 serverTool。auditProtocol。 |
| AF-26 | 已修复/加固 | 保留 content_filter，缓冲与流式均不再折叠成 length。auditProtocol。 |
| AF-27 | 已修复/加固 | 流式搜索用与缓冲路径相同 renderSearchCall，保留完整 action/queries/sources。auditProtocol。 |
| AF-28 | 已修复/加固 | fabricate/serialize/collect 均保留无结果的暂停调用；Anthropic 终止未关闭的服务端块。auditProtocol。 |
| AF-29 | 已修复/加固 | 未知或无有效数据的 document source 明确拒绝，避免静默丢附件。auditProtocol、fileFetch。 |
| AF-30 | 已修复/加固 | requireAnswer 将服务端工具事件计为有效答案。auditIr。 |
| AF-31 | 已修复/加固 | 异步 DNS 返回后再次比较缓存条目身份，避免返回已移除 dispatcher；auditPool 竞态/关闭测试及 egressProxy 回归。 |
| AF-32 | 已修复/加固 | withJsonHeartbeat 在 hijack 后异常也写入通用错误并 end；内部错误只记日志。auditTransport。 |
| AF-33 | 已修复/加固 | LRU 淘汰使用 graceful close，跟踪退休 dispatcher 以便 shutdown destroy；auditPool 竞态/关闭测试及 egressProxy 回归。 |
| AF-34 | 已修复/加固 | OCR 按图片 hash 排队重查缓存，finally 释放，取消等待者不占用后续位置。auditPersistence、imageCache/microAgent 回归。 |
| AF-35 | 已修复/加固 | 活动请求注册后的意外异常必 finish；executor Promise finally 停止心跳，已提交连接销毁。proxyStreaming 等异常路径回归。 |
| AF-36 | 已修复/加固 | 日志 demotion 与统计快照同一事务；持久化失败恢复内存计数。statsCache 验证重启及磁盘失败回滚。 |
| AF-37 | 已修复/加固 | 删除无运行时/测试引用的 56 个 legacy 文件；完整构建与回归验证。 |
| AF-38 | 已修复/加固 | Family 统一 FAMILIES tuple，schema/Zod/provider/catalog/bench 共享；THINKING_FORMATS 复用。类型检查与配置测试。 |
| AF-39 | 已修复/加固 | 统一 tokenAllowsService；媒体拒绝范围权限的 403 写 request log。媒体与授权回归。 |
| AF-40 | 已修复/加固 | adminRoutes 按 12 个职责模块拆分，入口只注册插件及会话守卫；保持路由路径。backup/security/egressProxy 等测试。 |
| AF-41 | 已修复/加固 | 接入 web Vitest/jsdom/Testing Library，测试异步乱序/卸载、整数、keys、日期；根 typecheck/test 运行两个 workspace。 |
| AF-42 | 已修复/加固 | 升级 drizzle-orm 至 0.45.2，迁移/备份/统计回归验证。 |
| AF-43 | 已修复/加固 | 升级 @fastify/static 至 10.1.4，SPA/安全头测试与 Docker 构建验证。 |
| AF-44 | 已修复/加固 | 重启信号失败记录错误并 exit(1)，不再静默 exit(0)；update 回归。 |
| AF-45 | 已修复/加固 | 以支持的 Node 22 为运行契约，直接使用 AbortSignal.any，无丢外部取消的降级分支。auditTransport。 |
| AF-46 | 已修复/加固 | 未改动 datetime-local 显示时保留原毫秒时间；明确修改/清空才转值。web primitives。 |
| AF-47 | 已修复/加固 | useListKeys 提供 reset，ServiceEditor 整体替换调用 reset 并变更 StageEditor key。web primitives。 |
| AF-48 | 已修复/加固 | useRef 存最新 loader，reload 不再捕获首帧函数。web primitives。 |
| AF-49 | 已修复/加固 | toId 仅接收正安全整数及十进制数字串；拒绝指数、空白、布尔、非整数。auditContracts。 |
| AF-50 | 已修复/加固 | ESLint flat config 接入基础正确性规则及 TS 解析，CI 必须通过；不以全面风格改写扩大补丁。 |
| AF-51 | 已修复/加固 | fresh migrations 与每个 schema 表的列名、非空约束、声明索引逐项比对。auditPersistence。 |
| AF-52 | 已核实并补验证 | 报告中的 hook 失败不是 skip 成功；修复运行环境后全量零失败、零跳过；CI 保留失败退出码。 |
| AF-53 | 已修复/加固 | git/dockerignore 排除 npm/GraphFlow/PearAI 缓存和系统文件；Docker 额外排除本地 agent/audit 内容；保留原有未跟踪用户文件。 |
| AF-54 | 已修复/加固 | 统一 requireAdmin 和 tokenAllowsService；角色仍从数据库读取。auth/媒体/backup 回归。 |
| AF-55 | 已修复/加固 | 日志保留配置统一使用 RetentionPut schema + parse 助手。settingsRoutes 与类型检查。 |
| AF-56 | 已修复/加固 | 删除确认无消费者的导出，THINKING_FORMATS 改为真正权威列表；删除旧 initialCredentialHint。类型检查、全量测试。 |
| AF-57 | 已修复/加固 | 删除 context 里的无调用全局 allowlist；SSRF 继续通过构造器读取 settings cache。SSRF 回归。 |
| AF-58 | 已修复/加固 | 备份启动自检 TABLES 与 Drizzle schema 表集合完全一致；保留显式外键恢复顺序。backup 与迁移测试。 |
| AF-59 | 已修复/加固 | Anthropic 提取幂等 closeText/closeReasoning，Responses 复用已有 close helper 和搜索项 renderer，并关闭暂停块；保留各族协议状态机，避免强行共享不同线协议。流式/签名/工具往返回归。 |
| AF-60 | 已核实并补验证 | 各族保留自身 RESERVED（wire 键确实不同），增加三族 canonical 覆盖与 vendor passthrough 一致性回归；Responses OWNED/PROVIDER_STATE 继续派生集合。auditProtocol。 |
| AF-61 | 已修复/加固 | 空 think 块不生成空 reasoning part，统一缓冲/流式语义。thinkingFormat 回归。 |
| AF-62 | 已修复/加固 | 插值使用字面量 split/join，不把 key 编译为正则。前端构建/类型检查。 |
| AF-63 | 已修复/加固 | CSP、nosniff、frame DENY、同源 referrer；SPA 允许现有内联样式，API JSON 不受脚本策略影响。auditSecurity。 |
| AF-64 | 已修复/加固 | 缩减 Key 查询：不返回内部 key/owner/service ID、前缀，仅保留自助配额所需数据；no-store、结构化审计日志、现有 30/min 限流。完整高熵 Key 本身仍为认证凭据，公开可用性查询是保留的产品契约，不改成管理会话功能。auditSecurity。 |
| AF-65 | 已修复/加固 | get/list 返回 structuredClone 快照，调用者不能改内部 registry 状态。activeRequests 回归。 |
| AF-66 | 已澄清契约 | 明确 shutdown deadline 是强制退出上限，不是取消 JavaScript handler；超时后仅同步清理并立即退出。原审计是契约歧义，澄清而不声称 Promise.race 能终止任务。 |
| AF-67 | 已修复/加固 | JsonKeepalive finish 内部停止 grace/ping 两类计时器，异常同样清理。auditTransport。 |
| AF-68 | 已修复/加固 | 升级 react-router-dom 7.18.4；web 类型检查、测试和 Vite 构建。 |
| AF-69 | 已修复/加固 | 升级 Vitest 5.0.1，两个 workspace 全量测试验证。 |
| AF-70 | 已修复/加固 | 升级 Vite/plugin-react/esbuild/drizzle-kit；统一覆盖 esbuild 为 0.28.2，并在工具所在根工作区声明同版 drizzle-orm 供 hoisted CLI 解析；验证迁移 CLI；npm audit 结果见验证摘要。 |
| AF-71 | 已修复/加固 | LogSummary 补缓存读取/写入及推理 token 三字段；统计回归与类型检查。 |
| AF-72 | 已修复/加固 | 示例、中英文 README 补 HOST、JSON_COMMIT_GRACE_MS、UPDATE_REPO；compose 同步。 |
| AF-73 | 已修复/加固 | CI tag 注入 APP_VERSION、SHA；本地 compose 支持 GIT_SHA，未标记构建明确显示 dev 身份。构建/更新服务测试。 |

## 可重复的审计修复方法

1. 固定基线与原有工作区状态，按 AF-ID 建账；先确认实际调用链，再改实现。
2. 对协议变更同时测试 request replay、buffered response、stream parse/serialize；覆盖错误与暂停，不只检查有文本的成功路径。
3. 对异步变更验证超时、取消、乱序、卸载、资源释放；对持久化变更验证事务回滚与重启重读。
4. 依赖升级以 lockfile、全量测试、两个 workspace 类型检查、生产构建、审计和镜像构建共同验证；生成迁移到临时目录，不覆盖生产数据库。
5. 将“已确认缺陷”“契约澄清”“维护风险”分开记录；失败 hook 和 skipped 不计为通过。提交仅包含本次代码、测试和台账。

运行期间未部署镜像、重启服务或修改用户数据库。验证产生的数据库在临时目录中；Docker 仅创建本地验证镜像。
