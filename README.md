# 保险理赔案件编排与反欺诈调查服务

一个可本地运行的 Node.js + TypeScript 纯后端项目。系统不依赖 Docker、数据库或第三方服务，使用内存事件存储模拟真实的理赔领域基础设施，适合继续扩展 0-1、Feature、Bug 和综合题。

## 核心能力

- 保单版本与事故发生时间的责任快照
- 报案、补件、查勘、核验、理算、支付、结案状态机
- 事件溯源、幂等事件接收、乱序事件重放
- 可冻结、发布和回滚的规则版本
- 证据版本链、哈希、引用快照和审计轨迹
- 分阶段支付、追回、冲正和赔付上限账本
- 案件准备金与财务分录子系统（估损→调整→责任确认→授权→支付→结案全链路）
  - 按责任险种 × 费用类别 × 币种拆分单元格，区分已发生损失、未决赔款、已授权应付、已支付、待追回/已追回、结案释放
  - 每次增减记录业务原因码、说明与来源事件，形成不可变准备金版本
  - 每事件一张借贷平衡凭证，ID 由来源事件确定性派生；重复事件/乱序事件/重开/冲正下保持幂等与冲正链
  - 纯函数事件流投影：实时处理与历史重放走同一份折叠代码，余额可从凭证行独立重算并试算平衡
  - 准备金演进、期间汇总（可跨案件）、单笔分录审计链 API
- 设备、车辆、人员、维修厂、账户的风险关联图
- 调查任务租约、过期提交保护和重派
- 单案件及跨案件风险解释

## 启动

```bash
npm install
npm run build
npm test
npm start
```

服务默认监听 `http://localhost:4100`，可用 `PORT=4200 npm start` 修改端口。

## 示例

```bash
curl http://localhost:4100/health
curl -X POST http://localhost:4100/claims \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-claim-1' \
  -d '{"policyId":"P-100","lossAt":"2026-10-06T08:00:00Z","reportedAt":"2026-10-06T09:00:00Z","participants":[{"kind":"person","id":"person-1"},{"kind":"vehicle","id":"car-1"}],"loss":{"currency":"CNY","gross":18000},"channel":"mobile"}'

# 案件准备金：按险种 × 费用类别初始估损（金额单位：分）
curl -X POST http://localhost:4100/claims/$CID/reserve/estimates \
  -H 'content-type: application/json' -H 'idempotency-key: est-1' \
  -d '{"currency":"CNY","lines":[{"coverage":"collision","feeCategory":"labor","amountMinor":500000},{"coverage":"collision","feeCategory":"parts","amountMinor":800000}],"reasonNote":"initial survey"}'
# 人工调整（带符号增量）/ 责任确认（目标值）/ 授权 / 支付 / 追回 / 结案 / 重开
curl -X POST http://localhost:4100/claims/$CID/reserve/adjustments    -H 'content-type: application/json' -d '{"currency":"CNY","lines":[{"coverage":"collision","feeCategory":"parts","amountMinor":-100000}],"reasonNote":"supplier discount"}'
curl -X POST http://localhost:4100/claims/$CID/reserve/confirmations  -H 'content-type: application/json' -d '{"currency":"CNY","lines":[{"coverage":"collision","feeCategory":"labor","amountMinor":500000},{"coverage":"collision","feeCategory":"parts","amountMinor":700000}]}'
curl -X POST http://localhost:4100/claims/$CID/reserve/authorizations -H 'content-type: application/json' -d '{"currency":"CNY","authorizationId":"AUTH-1","lines":[{"coverage":"collision","feeCategory":"labor","amountMinor":500000},{"coverage":"collision","feeCategory":"parts","amountMinor":700000}]}'
curl -X POST http://localhost:4100/claims/$CID/reserve/settlements    -H 'content-type: application/json' -d '{"currency":"CNY","sourceId":"PAY-1","stage":"settled","authorizationId":"AUTH-1","lines":[{"coverage":"collision","feeCategory":"labor","amountMinor":500000},{"coverage":"collision","feeCategory":"parts","amountMinor":700000}]}'
# 查询：当前视图 / 版本演进 / 一致性校验（借贷平衡+乱序重放+凭证重算）/ 单笔分录审计链 / 期间汇总
curl http://localhost:4100/claims/$CID/reserve
curl http://localhost:4100/claims/$CID/reserve/evolution
curl http://localhost:4100/claims/$CID/reserve/verify
curl http://localhost:4100/claims/$CID/journal/$ENTRY_ID/audit
curl 'http://localhost:4100/reserves/period-summary?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z'
```

### 准备金科目与恒等式

- 科目：`已发生损失`（费用/借）、`未决赔款准备金`（负债/贷）、`应付赔付款`（负债/贷）、`银行存款`、`应收代位追偿款`、`追偿及残值收入`、`准备金转回`。
- 桶位恒等式：`incurred = outstanding + payable + paid − recovered + released`（净已发生损失 = `incurred − recovered`）。
- 每张凭证借贷相等，全部账户余额合计为 0；`/reserve/verify` 用凭证行独立重算单元格并与折叠结果逐格比对。


## 目录说明

- `src/domain`：理赔领域模型、规则、账本、证据、风险图谱和任务租约
- `src/domain/reserve.ts`：准备金单元格/桶位、凭证、版本、事件载荷契约
- `src/domain/reserve-projector.ts`：纯函数凭证构造与事件流折叠投影、冲正链两趟挂接、余额重算与试算平衡
- `src/application`：事件存储、案件编排、支付、准备金、风险、任务和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
