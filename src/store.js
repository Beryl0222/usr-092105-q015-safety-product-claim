import { validateEvent } from "./validator.js";

/**
 * 事件存储：按 event_id 去重，来源系统重试或重复抓取不会产生重复记录。
 * 事实顺序以 occurred_at 为准，入仓顺序不影响投影结果。
 */
export class EventStore {
  constructor() {
    this.events = [];
    this.seen = new Set();
  }

  /** 入仓一批事件，返回 { accepted, duplicates, rejected }。 */
  ingest(batch) {
    const list = Array.isArray(batch) ? batch : [batch];
    const accepted = [];
    const duplicates = [];
    const rejected = [];
    for (const record of list) {
      const errors = validateEvent(record);
      if (errors.length > 0) {
        rejected.push({ record, errors });
        continue;
      }
      if (this.seen.has(record.event_id)) {
        duplicates.push(record.event_id);
        continue;
      }
      this.seen.add(record.event_id);
      this.events.push(record);
      accepted.push(record.event_id);
    }
    return { accepted, duplicates, rejected };
  }

  /** 按事实发生时间（再按版本、标识）排序后的事件流。 */
  sorted() {
    return [...this.events].sort(
      (a, b) =>
        Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
        a.version - b.version ||
        a.event_id.localeCompare(b.event_id),
    );
  }
}
