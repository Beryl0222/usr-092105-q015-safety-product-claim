import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPlatform } from "../src/platform.js";
import { validateEvent } from "../src/validator.js";

const NOW = "2026-10-05T12:00:00+08:00";
const C1 = { text: "自行车、电动车、摩托车都能用", scenarios: ["自行车", "电动车", "摩托车"] };
const C2 = { text: "纸质结构同样高强度", scenarios: [] };
const C3 = { text: "折叠后只有篮球大小", scenarios: [] };

const ts = (s) => Date.parse(s);

async function loadScenario() {
  const raw = JSON.parse(await readFile(new URL("../data/scenario-helmet.json", import.meta.url), "utf8"));
  return raw.events;
}

/** 直播停投几小时后，同一段口播被剪成 30 条短视频继续投放；含重复抓取与合法对照。 */
function buildClipEvents() {
  const events = [];
  for (let i = 1; i <= 30; i += 1) {
    const id = String(i).padStart(3, "0");
    events.push({
      event_id: `evt-20260921-c${id}`,
      event_type: "DERIVATIVE_DETECTED",
      aggregate_type: "creative_asset",
      aggregate_id: `A-CLIP-${id}`,
      occurred_at: `2026-09-21T02:${String(i).padStart(2, "0")}:00+08:00`,
      version: 1,
      summary: `抓取到 FOLD-1 直播的派生短视频 A-CLIP-${id}`,
      asset_kind: "short_video",
      source_asset_id: "A-LIVE-001",
      platform: "videogo",
      external_asset_id: `vg-clip-${id}`,
      model_ids: ["FOLD-1"],
      claims: i <= 20 ? [C1] : [C1, C2],
    });
    events.push({
      event_id: `evt-20260921-d${id}`,
      event_type: "DISTRIBUTION_STARTED",
      aggregate_type: "distribution_instance",
      aggregate_id: `D-CLIP-${id}`,
      occurred_at: `2026-09-21T03:${String(i).padStart(2, "0")}:00+08:00`,
      version: 1,
      summary: `投放账户 ACCT-MCN-07 开始投放 A-CLIP-${id}`,
      asset_id: `A-CLIP-${id}`,
      account_id: "ACCT-MCN-07",
    });
  }
  // 重复抓取一：同一外部素材换了新事件标识再次上报 → 应并入已有素材
  events.push({
    ...events.find((e) => e.event_id === "evt-20260921-c007"),
    event_id: "evt-20260921-rc07",
    occurred_at: "2026-09-21T04:30:00+08:00",
    version: 2,
    summary: "重复抓取到同一短视频 A-CLIP-007",
  });
  // 重复抓取二：来源系统重试，沿用原事件标识 → 应判为重复
  events.push(events.find((e) => e.event_id === "evt-20260921-c008"));
  // 合法对照：URBAN-3 的派生短视频，同一句口播但证据齐全，不应被误伤
  events.push({
    event_id: "evt-20260921-cu31",
    event_type: "DERIVATIVE_DETECTED",
    aggregate_type: "creative_asset",
    aggregate_id: "A-CLIP-U3",
    occurred_at: "2026-09-21T05:00:00+08:00",
    version: 1,
    summary: "抓取到 URBAN-3 直播的派生短视频",
    asset_kind: "short_video",
    source_asset_id: "A-LIVE-002",
    platform: "videogo",
    external_asset_id: "vg-u3-001",
    model_ids: ["URBAN-3"],
    claims: [C1],
  });
  events.push({
    event_id: "evt-20260921-du31",
    event_type: "DISTRIBUTION_STARTED",
    aggregate_type: "distribution_instance",
    aggregate_id: "D-CLIP-U3",
    occurred_at: "2026-09-21T05:30:00+08:00",
    version: 1,
    summary: "投放账户 ACCT-BRAND-02 开始投放 A-CLIP-U3",
    asset_id: "A-CLIP-U3",
    account_id: "ACCT-BRAND-02",
  });
  // 证据过期演示：只含合规句“折叠后只有篮球大小”的派生，在报告到期后才开始投放
  events.push({
    event_id: "evt-20261001-c31",
    event_type: "DERIVATIVE_DETECTED",
    aggregate_type: "creative_asset",
    aggregate_id: "A-CLIP-031",
    occurred_at: "2026-10-01T08:00:00+08:00",
    version: 1,
    summary: "抓取到只含合规句的派生短视频 A-CLIP-031",
    asset_kind: "short_video",
    source_asset_id: "A-LIVE-001",
    platform: "videogo",
    external_asset_id: "vg-clip-031",
    model_ids: ["FOLD-1"],
    claims: [C3],
  });
  events.push({
    event_id: "evt-20261001-d31",
    event_type: "DISTRIBUTION_STARTED",
    aggregate_type: "distribution_instance",
    aggregate_id: "D-CLIP-031",
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "投放账户 ACCT-MCN-07 开始投放 A-CLIP-031",
    asset_id: "A-CLIP-031",
    account_id: "ACCT-MCN-07",
  });
  return events;
}

async function buildPlatform() {
  const scenario = await loadScenario();
  const stream = [...scenario, ...buildClipEvents()].sort((a, b) => ts(a.occurred_at) - ts(b.occurred_at));
  const platform = createPlatform({ now: () => NOW });
  const report = platform.ingest(stream);
  return { platform, report, stream };
}

function distOf(platform, id) {
  return platform.listDistributions().find((d) => d.distribution_id === id);
}

test("场景事件本身符合信封约定", async () => {
  const scenario = await loadScenario();
  for (const event of scenario) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 应通过信封校验`);
  }
});

test("摄取：重复抓取被识别，不重复建对象", async () => {
  const { report, stream } = await buildPlatform();
  assert.equal(report.rejected.length, 0);
  assert.equal(report.duplicates, 1, "同一 event_id 重试应判重复");
  assert.equal(report.merged, 1, "同一外部素材换事件标识应合并");
  assert.equal(report.accepted, stream.length - 2);
  // 合并的素材不重复出现
  return buildPlatform().then(({ platform }) => {
    const clips = platform.snapshot().assets.filter((a) => a.external_asset_id === "vg-clip-007");
    assert.equal(clips.length, 1);
    assert.equal(clips[0].crawl_count, 2);
  });
});

test("处置视图：从一句口播展开型号、证据与全部派生投放", async () => {
  const { platform } = await buildPlatform();
  const view = platform.claimView("自行车、电动车、摩托车都能用");
  assert.equal(view.claim.asset_count, 34, "脚本+两场直播+30条剪辑+URBAN-3派生，同一句口播归并为一条声明");
  assert.equal(view.distributions.length, 33);
  const modelIds = view.models.map((m) => m.model_id).sort();
  assert.deepEqual(modelIds, ["FOLD-1", "URBAN-3"]);
  const fold1 = view.models.find((m) => m.model_id === "FOLD-1");
  const urban3 = view.models.find((m) => m.model_id === "URBAN-3");
  assert.equal(fold1.coverage_now.covered, false);
  assert.equal(urban3.coverage_now.covered, true, "同一句口播对证据齐全的型号依然覆盖");
  assert.equal(fold1.currently_suspended, true);
  assert.equal(urban3.currently_suspended, false);
  // 派生关系可展开
  const live = view.assets.find((a) => a.asset_id === "A-LIVE-001");
  assert.equal(live.source_asset_id, "A-SCRIPT-001");
  assert.equal(live.derivative_ids.length, 31, "30条违规剪辑+1条合规句剪辑都挂在直播下面");
  const clip = view.assets.find((a) => a.asset_id === "A-CLIP-001");
  assert.equal(clip.substantially_identical_to_source, true, "剪辑与直播共享口播，识别为实质相同派生物");
});

test("停投向下传播，且不误伤其他合法型号", async () => {
  const { platform } = await buildPlatform();
  assert.equal(distOf(platform, "D-001").status, "suspended");
  assert.equal(distOf(platform, "D-001").suspended_by, "RD-1");
  for (let i = 1; i <= 30; i += 1) {
    const id = `D-CLIP-${String(i).padStart(3, "0")}`;
    assert.equal(distOf(platform, id).status, "suspended", `${id} 应被自动停投`);
  }
  // 合法型号与合规投放不受波及
  assert.equal(distOf(platform, "D-U3").status, "active");
  assert.equal(distOf(platform, "D-CLIP-U3").status, "active");
  // 停投事件是系统按（声明×型号）生成的
  const generated = platform.snapshot();
  assert.ok(generated.distributions.every((d) => d.status !== "suspended" || d.suspended_by));
});

test("达人自行加话：无证据、禁用比较、未授权三重原因", async () => {
  const { platform } = await buildPlatform();
  const view = platform.claimView("纸质结构同样高强度");
  const fold1 = view.models.find((m) => m.model_id === "FOLD-1");
  const rd2 = fold1.decisions.find((d) => d.decision_id === "RD-2");
  const codes = rd2.reasons.map((r) => r.code);
  assert.ok(codes.includes("PHRASING_NOT_ALLOWED"));
  assert.ok(codes.includes("PROHIBITED_COMPARISON"));
  assert.ok(codes.includes("PERFORMER_NOT_AUTHORIZED"));
  assert.equal(rd2.verdict, "uncovered");
});

test("证据过期只影响对应型号、声明和时段", async () => {
  const { platform } = await buildPlatform();
  // 直播当时（2026-09-20）报告仍有效，该句当时是覆盖的
  const during = platform.evaluateClaimAt("折叠后只有篮球大小", "FOLD-1", "2026-09-20T21:00:00+08:00");
  assert.equal(during.covered, true, "到期前的投放不受追溯");
  // 到期后的新投放不再覆盖
  const view = platform.claimView("折叠后只有篮球大小");
  const fold1 = view.models.find((m) => m.model_id === "FOLD-1");
  const rd4 = fold1.decisions.find((d) => d.decision_id === "RD-4");
  assert.ok(rd4.reasons.some((r) => r.code === "EVIDENCE_EXPIRED"));
  assert.equal(distOf(platform, "D-CLIP-031").status, "suspended", "到期后新投放的合规句剪辑也被拦截");
});

test("证据撤销只影响对应范围，申诉成立后按范围恢复", async () => {
  const { platform } = await buildPlatform();
  // 撤销后、复效前的时段不覆盖
  const revoked = platform.evaluateClaimAt("自行车、电动车都能用", "FOLD-2", "2026-10-02T12:00:00+08:00");
  assert.equal(revoked.covered, false);
  assert.ok(revoked.reasons.some((r) => r.code === "EVIDENCE_REVOKED"));
  // 申诉成立（AP-1）：D-F2 恢复投放，当前时点重新覆盖
  const dF2 = distOf(platform, "D-F2");
  assert.equal(dF2.status, "active");
  assert.equal(dF2.reinstated_by, "AP-1");
  assert.deepEqual(
    dF2.history.map((h) => h.action),
    ["started", "suspended", "reinstated"],
  );
  const nowCoverage = platform.evaluateClaimAt("自行车、电动车都能用", "FOLD-2", NOW);
  assert.equal(nowCoverage.covered, true);
  // 申诉部分成立（AP-2）：原表述仍含摩托车场景，D-001 维持停投
  assert.equal(distOf(platform, "D-001").status, "suspended");
  const view = platform.claimView("自行车、电动车、摩托车都能用");
  const fold1 = view.models.find((m) => m.model_id === "FOLD-1");
  const rd1 = fold1.decisions.find((d) => d.decision_id === "RD-1");
  assert.equal(rd1.appeal.outcome, "partial");
  assert.equal(fold1.currently_suspended, true);
});

test("更正说明：明确产品型号与适用场景，不用笼统措辞", async () => {
  const { platform } = await buildPlatform();
  const view = platform.claimView("自行车、电动车、摩托车都能用");
  const notice = view.correction_notices["FOLD-1"];
  assert.ok(notice, "被停投的型号必须有更正说明");
  assert.match(notice, /FOLD-1/);
  assert.match(notice, /自行车/);
  assert.match(notice, /电动车/);
  assert.match(notice, /摩托车/);
  assert.match(notice, /TST-2025-FOLD1-009/, "要点明具体报告");
  assert.match(notice, /不构成行政认定/);
  assert.ok(!notice.includes("宣传不规范"), "不得使用笼统提示");
  assert.equal(view.correction_notices["URBAN-3"], undefined, "合法型号不应被附上更正说明");
});

test("重复摄取整体幂等：状态不变、不再生成处置事件", async () => {
  const { platform, stream } = await buildPlatform();
  const before = JSON.stringify(platform.snapshot());
  const report = platform.ingest(stream);
  assert.equal(report.accepted, 0);
  assert.equal(report.merged, 0);
  assert.equal(report.generated.length, 0);
  assert.equal(report.duplicates, stream.length);
  assert.equal(JSON.stringify(platform.snapshot()), before);
});

test("非法事件被拒之门外并给出中文原因", async () => {
  const { platform } = await buildPlatform();
  const report = platform.ingest([
    { event_id: "bad-00000001", event_type: "REVIEW_DECIDED", aggregate_type: "review_decision", aggregate_id: "RD-X", occurred_at: NOW, version: 1, summary: "缺少型号" },
    { event_id: "bad-00000002", event_type: "SOMETHING_ELSE", aggregate_type: "claim_evidence", aggregate_id: "E-X", occurred_at: NOW, version: 1, summary: "未知类型" },
    { event_id: "bad-00000003", event_type: "CLAIM_PUBLISHED", aggregate_type: "creative_asset", aggregate_id: "A-X", occurred_at: NOW, version: 0, summary: "版本非法" },
  ]);
  assert.equal(report.accepted, 0);
  assert.equal(report.rejected.length, 3);
  assert.match(report.rejected[0].errors.join(), /claim_text 或 claim_id/);
  assert.match(report.rejected[1].errors.join(), /不支持的事件类型/);
  assert.match(report.rejected[2].errors.join(), /version 必须是正整数/);
});
