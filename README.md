# 安全用品宣传举证

本项目保存“安全用品宣传举证”领域中跨机构交换记录的基础约定，并在其上实现宣传声明举证与传播处置平台：以每一句可传播声明为核对单位，判断现有证据能否覆盖声明，并驱动停投、派生识别与申诉恢复。

## 领域资料

- `contracts/domain.schema.json`：事件信封与本领域允许的聚合、事件类型。
- `data/sample.json`：一条可用于本地联调的中文样例。
- `data/scenario-helmet.json`：折叠头盔完整处置场景（单型号报告、超范围口播、达人加话、证据过期与撤销、申诉）。
- `src/`：平台实现。
- `tests/`：验证样例、公共字段约定与场景行为。

事件由 `event_id` 唯一标识，`aggregate_id` 指向业务对象，`version` 从 1 开始递增，`occurred_at` 保留真实发生时间。来源系统重试时必须沿用原事件标识。

## 平台能力

- **以声明为核对单位**：声明标识由口播文本归一化后生成，同一段话出现在脚本、直播或几十条剪辑里都是同一条声明（`src/textnorm.js`）。
- **证据覆盖判定**（`src/coverage.js`）：核对产品型号、认证范围、允许表述、禁用比较、报告有效期 / 撤销时间与达人授权。系统只判断现有证据能否覆盖声明，不作行政认定。
- **处置传播**（`src/platform.js`）：审核决定判定“未覆盖”后，停投只落到命中（声明 × 型号）的投放实例上；原素材停投后，实质相同派生物（共享口播的剪辑）的新投放一出现即被拦截；其他合法型号的投放不受波及。
- **时段敏感**：证据过期或撤销只影响对应型号、声明和时段，不追溯既往合规投放。
- **申诉通道**：申诉材料（新证据）登记后，申诉决定按列明的（声明 × 型号）范围恢复投放；部分成立时不扩大恢复范围。
- **处置视图**：`claimView(任一句口播)` 展开该声明对应的型号、证据、审核决定、全部派生素材与派生投放，并生成面向消费者的更正说明——明确产品型号与适用场景，不使用“宣传不规范”这类笼统措辞。
- **重复抓取安全**：同一 `event_id` 重试直接跳过；同一外部素材（`platform` + `external_asset_id`）重复上报并入已有素材；同一聚合的旧版本事件丢弃。系统生成的处置事件标识确定，整体重复摄取幂等。

## 事件词汇

| event_type | aggregate_type | 含义 |
| --- | --- | --- |
| `EVIDENCE_REGISTERED` / `EVIDENCE_REVOKED` | `claim_evidence` | 登记 / 撤销检测报告与认证（型号、认证范围、允许表述、禁用比较、有效期） |
| `CLAIM_PUBLISHED` | `creative_asset` | 登记脚本、直播、短视频及其包含的声明 |
| `DERIVATIVE_DETECTED` | `creative_asset` | 抓取到派生剪辑，记录剪辑来源与内容指纹 |
| `DISTRIBUTION_STARTED` | `distribution_instance` | 投放账户开始投放某素材 |
| `REVIEW_DECIDED` | `review_decision` | 审核决定：平台计算（声明 × 型号 × 时段）的证据覆盖结论 |
| `DELIVERY_SUSPENDED` / `DELIVERY_REINSTATED` | `distribution_instance` | 停止 / 恢复投放（含平台按传播规则自动生成的处置事件） |
| `APPEAL_FILED` / `APPEAL_DECIDED` | `review_decision` | 申诉材料与申诉决定（挂在原审核决定上，版本递增） |

## 本地检查

运行 `node --test`。
