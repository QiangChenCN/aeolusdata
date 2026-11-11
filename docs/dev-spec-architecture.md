# 开发规范：后端架构、分层与文件层级

- 版本：v1.0
- 日期：2026-09-20
- 适用范围：`backend/`（NestJS 服务）
- 关联决策：[ADR-后端选型-NestJS](./adr-backend-nestjs-2026-09-20.md)

> 本规范为绿地重构后的**唯一架构事实来源**。现有 `server.py` 的结构不作为参考；新代码必须遵循本规范。

---

## 1. 架构风格

**Modular Monolith（模块化单体）+ DDD-lite 分层。**

- 单体部署，不引入微服务（避免过早分布式）。
- 按**业务特性（feature）**切分模块，而非按技术层切分。
- 每个特性模块内部做轻量分层；跨模块共享的能力收口到 `python/common/`（共享内核）。
- 可插拔能力（计算）通过 **Port/Adapter + 依赖注入** 解耦，运行时按配置切换实现。

调研依据（主流/行业实现）：NestJS 官方 modular 推荐、Synapse Studios《Modular Monolith in NestJS》、Capital Compute《Modular and Maintainable Backend》、NestJS 官方 SSE 技术文档、社区 DDD-lite 分层实践。

---

## 2. 分层与职责

依赖方向严格**单向向下**（外层依赖内层，内层不感知外层）：

```
Controller（接入层）
   │ 仅做：路由映射、参数校验、协议转换（DTO↔领域）、调用 Service
   ▼
Service（应用/领域层）
   │ 仅做：业务编排、事务、协调 Adapter / 领域逻辑
   ▼
Port（端口/接口）  ──── 由 Adapter 实现
   ▼
Adapter（适配器：Node 实现 / Python-FastAPI 实现 / 外部 HTTP 等）
```

- **Controller**：禁止写业务规则、禁止直接访问进程外资源（spawn/HTTP/DB）。不得出现 `child_process`、`fetch` 调用。
- **Service**：承载业务逻辑；可调用同模块 Adapter 与跨模块**导出的 Provider**（通过端口接口，而非具体类）。
- **Port**：纯 TS 接口（如 `ComputePort`），定义能力契约，无实现。
- **Adapter**：实现 Port。Node 版就地实现；Python 版通过 HTTP/子进程对接 FastAPI。
- **python/common/（共享内核）**：被所有模块依赖，但**不得反向依赖任何业务模块**；只放通用能力（异常、守卫、拦截器、校验、日志、配置类型）。

---

## 3. 模块边界规则

1. 模块通过 `@Module({ exports: [...] })` **显式导出** 才能被其他模块使用。
2. 跨模块调用**只依赖对方导出的 Port/Service 接口**，禁止 `import` 对方内部文件（controller/adapter/dto 内部实现）。
3. 每个特性模块自带 `*.module.ts` 作为唯一入口；根 `AppModule` 仅做聚合与全局配置。
4. 特性模块之间**禁止循环依赖**；公共契约提升到 `python/common/` 或抽到独立的 `contracts/` 模块。

---

## 4. 文件与命名约定

目录树（以 `backend/` 为根）：

```
backend/
├─ src/
│  ├─ main.ts                     # 启动引导（仅装配，不放逻辑）
│  ├─ app.module.ts               # 根模块（聚合 + 全局配置）
│  ├─ config/                     # 配置：env schema、配置类型、加载
│  ├─ python/common/                     # 共享内核（跨切面）
│  │  ├─ filters/                 # 全局异常过滤器
│  │  ├─ guards/                  # 鉴权守卫
│  │  ├─ interceptors/            # 日志/响应拦截器
│  │  ├─ decorators/              # 自定义装饰器
│  │  └─ utils/                   # 通用工具（logger 等）
│  └─ modules/
│     ├─ auth/                    # 鉴权（token 校验）
│     ├─ compute/                 # 【可插拔计算】Port + Adapters
│     │  ├─ compute.module.ts
│     │  ├─ compute.service.ts
│     │  ├─ compute.port.ts       # ComputePort 接口
│     │  ├─ adapters/
│     │  │  ├─ node-compute.adapter.ts    # 当前：Node 实现（占位）
│     │  │  └─ python-compute.adapter.ts  # 未来：FastAPI 客户端（桩）
│     │  └─ dto/
│     ├─ streaming/               # SSE 实时推送
│     │  ├─ streaming.controller.ts  # @Sse()
│     │  └─ streaming.service.ts      # 按 taskId 的 Subject 管理
│     ├─ tasks/                   # 任务编排（触发/执行长任务）
│     │  ├─ tasks.controller.ts
│     │  └─ tasks.service.ts
│     ├─ scheduler/               # 定时任务（@nestjs/schedule）
│     └─ serve/                   # 前端静态资源托管 / 开发代理
├─ test/
├─ package.json
├─ tsconfig.json / tsconfig.build.json
└─ nest-cli.json
```

命名：
- 文件：`kebab-case`；类：`PascalCase`。
- 角色后缀（文件名末尾）：`.controller.ts`、`.service.ts`、`.module.ts`、`.port.ts`、`.adapter.ts`、`.dto.ts`、`.entity.ts`、`.guard.ts`、`.filter.ts`、`.interceptor.ts`、`.decorator.ts`、`.util.ts`。
- 常量/DI Token：大写下划线（`COMPUTE_PORT`）；配置键：`UPPER_SNAKE`。

---

## 5. 跨切面（common）约定

- **校验**：所有入参走 `class-validator` + 全局 `ValidationPipe`（`whitelist: true, transform: true`）。禁止在 Controller 手写字面量校验。
- **异常**：统一 `HttpException` 体系；全局 `ExceptionFilter` 输出 `{ code, message, traceId? }` 结构。禁止向客户端泄漏堆栈。
- **鉴权**：统一 `TokenGuard`，支持 Header 与 `?token=` 查询参数（兼容 SSE / 跨源 iframe 无法带自定义头的场景）。
- **日志**：统一 `Logger` 封装（禁止散用 `console`）；请求级 `traceId` 透传（拦截器注入）。
- **配置**：`ConfigModule.forRoot({ isGlobal, validationSchema })` 启动时校验 env；业务只注入 `ConfigService`，禁止直接读 `process.env`。

---

## 6. 可插拔计算边界（源自 ADR-2026-09-20，强制）

- 所有计算逻辑**只**存在于 `modules/compute/` 之下，经 `ComputePort` 暴露。
- 唯一实现 `PythonComputeAdapter`（HTTP 对接 FastAPI）：重计算一律转发 8900 计算服务；
  Nest 侧只做取数 / 轻计算 / 编排 / 权限闸门。历史上有 `NodeComputeAdapter` +
  `COMPUTE_PROVIDER` 环境变量做 DI 切换，因 node 模式对 proxy 端点只会报 NEED_PYTHON、
  run() 通道零调用点，已于 2026-11-11 移除（线上还曾因 .env 残留 COMPUTE_PROVIDER=node 翻车）。
- `TasksModule` / 其他模块**只依赖 `ComputePort` 接口**，不感知具体实现；切换实现时调用方零改动。
- 触发条件与拆分方式见 ADR。

---

## 7. SSE / 长任务约定

- 长任务执行与传输解耦：`TasksService` 执行任务并通过 `StreamingService.emit(taskId, event)` 推日志；`StreamingController` 的 `@Sse('stream/:taskId')` 仅负责把 `StreamingService.subscribe(taskId)` 暴露为 SSE。
- `StreamingService` 内部用 `Map<taskId, Subject<MessageEvent>>` 维护订阅；客户端断连自动退订，避免堆积。
- 任务状态机：`pending → running → succeeded|failed`；状态变更同样经 Streaming 广播。
- 调度器（`@nestjs/schedule`）不订阅 SSE，直接读任务状态（避免流满丢事件导致状态卡死，沿用旧架构教训）。

---

## 8. 错误处理 / 日志 / 配置

- 业务错误抛 `HttpException` 子类或领域异常；由全局 Filter 归一。
- 第三方/子进程失败必须带上下文字段（taskId、阶段、退出码），便于诊断。
- 配置变更需同步更新 `.env.example` 与 `configuration.ts` 的校验 schema。

---

## 9. 测试约定

- Service 层单测（mock Adapter / Port）为必选项。
- 跨模块契约（Port 接口）变更需同步更新 Adapter 与调用方测试。
- e2e 覆盖：触发任务 → SSE 收到事件 → 终态正确。

---

## 10. 反模式（禁止）

- ❌ Controller 内写业务逻辑或直连进程外资源。
- ❌ 跨模块 `import` 对方内部实现文件。
- ❌ 计算逻辑散落到 Tasks/Controller 中（必须进 `compute`）。
- ❌ 直接 `process.env` / `console` / 硬编码 token。
- ❌ 为当前轻计算引入数据库/消息队列等重依赖（按需再加入）。
