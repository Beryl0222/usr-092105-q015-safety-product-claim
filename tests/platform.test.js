import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EventStore,
  project,
  applyEvent,
  validateEvent,
  coverageFor,
  detectDerivativeAssets,
  suspensionTargets,
  suspensionEvents,
  correctionNotice,
  claimDispositionView,
} from "../src/index.js";

const caseEvents = JSON.parse(
  await readFile(new URL("../data/case-foldable-helmet.json", import.meta.url), "utf8"),
);
const schema = JSON.parse(
  await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"),
);

const NOW = "2026-10-05T10:00:00+08:00";

function loadCase() {
  const store = new EventStore();
  const result = store.ingest(caseEvents);
  return { store, result, state: project(store.sorted()) };
}

test("案例事件全部符合领域契约", () => {
  for (const event of caseEvents) {
    assert.deepEqual(validateEvent(event), [], event.event_id);
    assert.ok(schema.properties.event_type.enum.includes(event.event_type), event.event_type);
    assert.ok(schema.properties.aggregate_type.enum.includes(event.aggregate_type), event.aggregate_type);
  }
});

test("重复抓取按 event_id 去重，投影状态不变", () => {
  const store = new EventStore();
  const first = store.ingest(caseEvents);
  assert.equal(first.accepted.length, caseEvents.length);
  assert.equal(first.rejected.length, 0);
  const second = store.ingest(caseEvents);
  assert.equal(second.accepted.length, 0);
  assert.equal(second.duplicates.length, caseEvents.length);
  assert.equal(store.sorted().length, caseEvents.length);
});

test("覆盖判定以单句声明为单位，只描述证据覆盖情况", () => {
  const { state } = loadCase();
  const evidence = [...state.evidence.values()];
  const c1 = state.claims.get("claim-c1");
  // 直播当时：报告只覆盖自行车骑行，电动车、摩托车场景无证据。
  const atLive = coverageFor(c1, "HM-01", evidence, "2026-09-28T20:30:00+08:00");
  assert.equal(atLive.status, "partial");
  assert.deepEqual(atLive.covered_scenarios, ["自行车骑行"]);
  assert.deepEqual(atLive.missing_scenarios, ["电动车驾乘", "摩托车驾乘"]);
  // 达人即兴的纸质结构声明：完全无证据。
  const c2 = state.claims.get("claim-c2");
  assert.equal(coverageFor(c2, "HM-01", evidence, "2026-09-28T20:30:00+08:00").status, "uncovered");
  // 申诉补充新报告后：只剩摩托车场景无证据。
  const afterAppeal = coverageFor(c1, "HM-01", evidence, NOW);
  assert.equal(afterAppeal.status, "partial");
  assert.deepEqual(afterAppeal.missing_scenarios, ["摩托车驾乘"]);
});

test("证据过期只影响对应型号、声明和时段", () => {
  const { state } = loadCase();
  const evidence = [...state.evidence.values()];
  const c3 = state.claims.get("claim-c3");
  // HM-02 报告 2026-09-30 到期：到期前覆盖，到期后不覆盖，互不影响 HM-01。
  assert.equal(coverageFor(c3, "HM-02", evidence, "2026-08-15T00:00:00+08:00").status, "covered");
  assert.equal(coverageFor(c3, "HM-02", evidence, "2026-10-02T09:00:00+08:00").status, "uncovered");
});

test("证据撤销只影响撤销之后的时段", () => {
  const { state } = loadCase();
  applyEvent(state, {
    event_id: "evt-revoke-hm01",
    event_type: "EVIDENCE_REVOKED",
    aggregate_type: "claim_evidence",
    aggregate_id: "ev-rpt-hm01",
    occurred_at: "2026-06-01T00:00:00+08:00",
    version: 2,
    summary: "撤销 HM-01 原检测报告",
    payload: { revoked_at: "2026-06-01T00:00:00+08:00" },
  });
  const evidence = [...state.evidence.values()];
  const c1 = state.claims.get("claim-c1");
  // 撤销前自行车场景仍有证据，撤销后连自行车场景也无证据（直至新报告生效）。
  const before = coverageFor(c1, "HM-01", evidence, "2026-05-31T00:00:00+08:00");
  assert.ok(before.covered_scenarios.includes("自行车骑行"));
  const after = coverageFor(c1, "HM-01", evidence, "2026-06-02T00:00:00+08:00");
  assert.ok(after.missing_scenarios.includes("自行车骑行"));
});

test("原素材停投后仍能识别实质相同的派生物", () => {
  const { state } = loadCase();
  const derivatives = detectDerivativeAssets(state, "claim-c1");
  // 未标注声明、但口播实质相同的改写剪辑被检出。
  assert.ok(derivatives.includes("asset-clip-004"));
  // 只剪了“纸质结构”片段的达人视频不被株连。
  assert.ok(!derivatives.includes("asset-clip-101"));
  assert.ok(!derivatives.includes("asset-hm02-demo"));
});

test("暂停沿派生链向下传播且不误伤其他型号与其他声明", () => {
  const { store, state } = loadCase();
  const rd1 = state.decisions.get("rd-001");
  assert.deepEqual(
    suspensionTargets(state, rd1),
    ["dist-clip-001", "dist-clip-002", "dist-clip-003", "dist-clip-004", "dist-live-0928"],
  );
  // 暂停事件入仓（幂等标识），状态更新；处置发生在派生剪辑起投之后。
  store.ingest(suspensionEvents(state, rd1, { at: "2026-09-29T08:00:00+08:00" }));
  store.ingest(suspensionEvents(state, state.decisions.get("rd-002"), { at: "2026-09-29T08:01:00+08:00" }));
  const after = project(store.sorted());
  const status = (id) => after.distributions.get(id).status;
  assert.equal(status("dist-live-0928"), "suspended");
  assert.equal(status("dist-clip-004"), "suspended");
  assert.equal(status("dist-clip-101"), "suspended"); // 由 rd-002 暂停，而非 rd-001
  assert.equal(after.distributions.get("dist-clip-101").suspended_by, "rd-002");
  // 合法型号 HM-02 的投放完全不受影响。
  assert.equal(status("dist-hm02-a"), "active");
  assert.equal(status("dist-hm02-b"), "active");
});

test("申诉部分成立：维持暂停，仅记录已解决场景，合规产品申诉通道保留", () => {
  const { store, state } = loadCase();
  store.ingest(suspensionEvents(state, state.decisions.get("rd-001"), { at: "2026-09-29T08:00:00+08:00" }));
  const after = project(store.sorted());
  const appeal = after.appeals.get("appeal-001");
  assert.equal(appeal.status, "partially_upheld");
  assert.deepEqual(appeal.resolved_scenarios, ["电动车驾乘"]);
  const rd1 = after.decisions.get("rd-001");
  assert.equal(rd1.status, "partially_overturned");
  assert.deepEqual(rd1.remaining_scenarios, ["摩托车驾乘"]);
  // 原素材仍含未覆盖表述，投放不自动恢复。
  assert.equal(after.distributions.get("dist-live-0928").status, "suspended");
});

test("申诉成立：仅恢复因该决定被暂停的投放", () => {
  const store = new EventStore();
  store.ingest([
    {
      event_id: "evt-t-claim",
      event_type: "CLAIM_DEFINED",
      aggregate_type: "claim_evidence",
      aggregate_id: "claim-t1",
      occurred_at: "2026-09-01T00:00:00+08:00",
      version: 1,
      summary: "登记测试声明",
      payload: { text: "续航一百公里", model_ids: ["M-1"], required_scenarios: ["续航"] },
    },
    {
      event_id: "evt-t-asset",
      event_type: "ASSET_REGISTERED",
      aggregate_type: "creative_asset",
      aggregate_id: "asset-t1",
      occurred_at: "2026-09-02T00:00:00+08:00",
      version: 1,
      summary: "登记测试素材",
      payload: { kind: "short_video", model_ids: ["M-1"], claim_ids: ["claim-t1"] },
    },
    {
      event_id: "evt-t-dist",
      event_type: "DISTRIBUTION_LAUNCHED",
      aggregate_type: "distribution_instance",
      aggregate_id: "dist-t1",
      occurred_at: "2026-09-03T00:00:00+08:00",
      version: 1,
      summary: "开始投放",
      payload: { asset_id: "asset-t1", account_id: "acc-1" },
    },
    {
      event_id: "evt-t-rd",
      event_type: "REVIEW_RECORDED",
      aggregate_type: "review_decision",
      aggregate_id: "rd-t1",
      occurred_at: "2026-09-04T00:00:00+08:00",
      version: 1,
      summary: "暂停决定",
      payload: { claim_id: "claim-t1", model_id: "M-1", action: "suspend" },
    },
  ]);
  let state = project(store.sorted());
  store.ingest(suspensionEvents(state, state.decisions.get("rd-t1"), { at: "2026-09-04T01:00:00+08:00" }));
  store.ingest([
    {
      event_id: "evt-t-appeal",
      event_type: "APPEAL_FILED",
      aggregate_type: "review_decision",
      aggregate_id: "appeal-t1",
      occurred_at: "2026-09-05T00:00:00+08:00",
      version: 1,
      summary: "提交申诉",
      payload: { decision_id: "rd-t1", appellant: "brand", evidence_ids: ["ev-new"] },
    },
    {
      event_id: "evt-t-appeal-decided",
      event_type: "APPEAL_DECIDED",
      aggregate_type: "review_decision",
      aggregate_id: "appeal-t1",
      occurred_at: "2026-09-06T00:00:00+08:00",
      version: 1,
      summary: "申诉成立",
      payload: { outcome: "upheld", resolved_scenarios: ["续航"] },
    },
  ]);
  state = project(store.sorted());
  assert.equal(state.decisions.get("rd-t1").status, "overturned");
  assert.equal(state.distributions.get("dist-t1").status, "reinstated");
});

test("更正说明指明产品、原表述与适用场景，不用笼统提示", () => {
  const { state } = loadCase();
  const notice = correctionNotice(state, state.decisions.get("rd-001"), { at: NOW });
  assert.ok(notice.text.includes("HM-01"));
  assert.ok(notice.text.includes("自行车、电动车、摩托车都能用"));
  assert.ok(notice.text.includes("自行车骑行、电动车驾乘"));
  assert.ok(notice.text.includes("摩托车驾乘"));
  assert.ok(!notice.text.includes("宣传不规范"));
});

test("处置视图从一句口播展开型号、证据与全部派生投放", () => {
  const { store, state } = loadCase();
  // 暂停与更正说明入仓后再看视图。
  store.ingest(suspensionEvents(state, state.decisions.get("rd-001"), { at: "2026-09-29T08:00:00+08:00" }));
  const notice = correctionNotice(state, state.decisions.get("rd-001"), { at: NOW });
  store.ingest({
    event_id: "evt-20261005-0001",
    event_type: "CORRECTION_PUBLISHED",
    aggregate_type: "review_decision",
    aggregate_id: "notice-001",
    occurred_at: NOW,
    version: 1,
    summary: "发布 rd-001 的消费者更正说明",
    payload: { decision_id: "rd-001", text: notice.text },
  });
  const view = claimDispositionView(project(store.sorted()), "claim-c1", { at: NOW });
  assert.equal(view.claim.id, "claim-c1");
  assert.equal(view.models[0].model_id, "HM-01");
  assert.deepEqual(view.models[0].coverage.missing_scenarios, ["摩托车驾乘"]);
  assert.deepEqual(
    view.models[0].evidence.map((e) => e.id).sort(),
    ["ev-rpt-hm01", "ev-rpt-hm01b"],
  );
  // 直播原片 + 4 条派生剪辑，不含只剪纸质结构的 asset-clip-101。
  assert.deepEqual(
    view.assets.map((a) => a.id).sort(),
    ["asset-clip-001", "asset-clip-002", "asset-clip-003", "asset-clip-004", "asset-live-0928"],
  );
  assert.equal(view.distributions.length, 5);
  assert.ok(view.distributions.every((d) => d.status === "suspended"));
  assert.deepEqual(view.decisions.map((d) => d.id), ["rd-001"]);
  assert.deepEqual(view.appeals.map((a) => a.id), ["appeal-001"]);
  assert.equal(view.notices.length, 1);
  assert.ok(view.notices[0].text.includes("HM-01"));
});

test("处置视图按投放发起时刻呈现证据覆盖（时段隔离）", () => {
  const { state } = loadCase();
  const view = claimDispositionView(state, "claim-c3", { at: NOW });
  const byId = Object.fromEntries(view.distributions.map((d) => [d.id, d]));
  // 同一素材的两次投放：证据有效期内起投的覆盖，过期后起投的不覆盖。
  assert.equal(byId["dist-hm02-a"].coverage_at_launch[0].status, "covered");
  assert.equal(byId["dist-hm02-b"].coverage_at_launch[0].status, "uncovered");
});
