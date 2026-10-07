# 保险理赔案件编排与反欺诈调查服务

一个可本地运行的 Node.js + TypeScript 纯后端项目。系统不依赖 Docker、数据库或第三方服务，使用内存事件存储模拟真实的理赔领域基础设施，适合继续扩展 0-1、Feature、Bug 和综合题。

## 核心能力

- 保单版本与事故发生时间的责任快照
- 报案、补件、查勘、核验、理算、支付、结案状态机
- 事件溯源、幂等事件接收、乱序事件重放
- 可冻结、发布和回滚的规则版本
- 证据版本链、哈希、引用快照和审计轨迹
- 分阶段支付、追回、冲正和赔付上限账本
- 设备、车辆、人员、维修厂、账户的风险关联图
- 调查任务租约、过期提交保护和重派
- 单案件及跨案件风险解释
- 案件准备金版本链：初始估损、人工调整、责任确认、赔付授权到结案全程可追溯
- 按责任险种 × 费用类别拆分准备金，区分已发生损失、未决赔款、已支付、待追回
- 复式记账分录：借贷平衡校验、来源事件幂等、重放与实时一致
- 准备金演进、期间汇总与单笔分录审计链查询

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
```

## 准备金与财务分录

报案后系统按保单责任快照自动建立初始估损准备金（损失总额 × 责任比例 − 免赔， capped by 限额，按责任险种均分）。此后每个关键动作都会生成一个准备金版本和一组借贷平衡的会计分录：

| 阶段 | 事件 | 分录（借 / 贷） |
| --- | --- | --- |
| 初始估损 | `claim.reported` + 保单快照 | 已发生损失 / 未决赔款准备金 |
| 人工调整 | `reserve.adjusted` | 增减准备金的反向或正向计提 |
| 责任确认 | `liability.confirmed` | 未决责任在险种间重分摊（总额不变） |
| 赔付授权 | `payment.authorized` | 未决赔款准备金 / 应付赔款 |
| 赔付支付 | `payment.settled` | 应付赔款 + 未决赔款准备金 / 资金 |
| 赔付冲正 | `payment.reversed` | 应收追偿款 / 未决赔款准备金 |
| 追回入账 | `payment.recovered` | 资金 / 应收追偿款 |
| 结案/拒赔 | `claim.closed` / `claim.rejected` | 释放全部未决准备金 |

每条准备金变动都记录业务原因（reason）与来源事件（sourceEventId），并按 险种（coverage）× 费用类别（category） 拆分明细。四类金额口径：已发生损失（incurred）、未决赔款（outstanding = incurred − paid）、已支付（paid）、待追回（recoverable）。

幂等与一致性：事件按幂等键去重；投影按事件 ID 去重，重复/乱序事件不影响余额；分录按 （案件， 来源事件， 类型） 幂等且强制借贷平衡；所有读模型由事件流实时折叠，历史重放（`replayAt`）与实时处理结果必然一致。

### API

```bash
# 人工调整（必须携带业务原因；金额为最小货币单位）
curl -X POST http://localhost:4100/claims/$ID/reserves/adjust \
  -H 'content-type: application/json' -H 'idempotency-key: adj-1' \
  -d '{"reason":"查勘定损上调","moves":[{"coverage":"collision","category":"indemnity","deltaMinor":100000}]}'

# 责任确认（比例合计必须为 1）
curl -X POST http://localhost:4100/claims/$ID/liability/confirm \
  -H 'content-type: application/json' \
  -d '{"reason":"责任认定书","shares":[{"coverage":"collision","share":0.7},{"coverage":"theft","share":0.3}]}'

# 赔付授权 / 支付 / 冲正 / 追回 / 结案
curl -X POST http://localhost:4100/claims/$ID/authorizations -d '{"amount":5000,"currency":"CNY","sourceId":"auth-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/$ID/payments       -d '{"amount":3000,"currency":"CNY","sourceId":"pay-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/$ID/reversals      -d '{"amount":3000,"currency":"CNY","sourceId":"rev-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/$ID/recoveries     -d '{"amount":1000,"currency":"CNY","sourceId":"rec-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/$ID/closure

# 查询
curl http://localhost:4100/claims/$ID/reserves                  # 当前台账（明细 + 四类金额）
curl http://localhost:4100/claims/$ID/reserves/evolution        # 准备金版本演进
curl http://localhost:4100/claims/$ID/journal                   # 全部分录
curl http://localhost:4100/claims/$ID/journal/$ENTRY_ID/audit   # 单笔分录审计链
curl "http://localhost:4100/claims/$ID/reserves/summary?from=2026-10-01&to=2026-10-31"  # 案件期间汇总
curl "http://localhost:4100/reserves/summary?from=2026-10-01&to=2026-10-31"             # 全组合期间汇总
```

## 目录说明

- `src/domain`：理赔领域模型、规则、账本、准备金投影、会计分录、证据、风险图谱和任务租约
- `src/application`：事件存储、案件编排、支付、准备金、风险、任务和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
