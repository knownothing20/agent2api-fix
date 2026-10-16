//! 积分发放台账的面板入口：`GET /api/credit-grants`。
//!
//! 数据与口径在 `core::credit_grants`（那里解释了「为什么必须我们自己记」与
//! 「到期那一列为什么是整期」）。这里多做一件事：把每个账号的**整期到期日**
//! 从余额快照里带出来 —— 上游不提供逐笔到期，界面上那一列显示的是整期，
//! 不带出来前端就只能显示空白。
//!
//! 参数：`provider`、`accountId`、`limit`（默认 100）。

use axum::extract::State;
use axum::http::Uri;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::core::{credit_grants, usage_query};
use crate::server::http::{ok_json, query_param};
use crate::server::ServerState;

const DEFAULT_LIMIT: usize = 200;

/// GET /api/credit-grants —— 发放流水（最新在前）+ 各账号的整期到期日。
pub async fn list(State(state): State<ServerState>, uri: Uri) -> Response {
    let query = uri.query().unwrap_or("");
    let provider = query_param(query, "provider").filter(|value| !value.is_empty());
    let account_id = query_param(query, "accountId").filter(|value| !value.is_empty());
    let limit = query_param(query, "limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_LIMIT);
    let mut body = credit_grants::response(provider.as_deref(), account_id.as_deref(), limit);
    body["periods"] = periods_of(state.store());
    ok_json(body)
}

/// DELETE /api/credit-grants —— 清空（`?provider=` / `?accountId=` 可只清一部分）。
pub async fn clear(State(_state): State<ServerState>, uri: Uri) -> Response {
    let query = uri.query().unwrap_or("");
    let provider = query_param(query, "provider").filter(|value| !value.is_empty());
    let account_id = query_param(query, "accountId").filter(|value| !value.is_empty());
    let removed = credit_grants::clear(provider.as_deref(), account_id.as_deref());
    crate::server::logging::log(
        "[Credits]",
        &format!("发放台账已清空 {removed} 条"),
    );
    ok_json(json!({ "removed": removed }))
}

/// 每个账号的**整期到期**：`{ "<accountId>": { at, text, kind } }`。
///
/// 两个来源（都是真数据，但语义都是「这一期到哪天」，不是「这笔分哪天作废」）：
///   · CodeArts —— `subscription.resetDate`（`YYYY-MM-DD` 文本，**当天结束**为到期时刻）；
///   · Trae —— `subscription.expireAt`（毫秒时间戳）。
/// 拿不到就不放进表里 ⇒ 界面显示「上游未提供」，不编时间。
fn periods_of(store: &crate::server::core::account_store::AccountStore) -> Value {
    let snapshot = usage_query::snapshot();
    let mut out = serde_json::Map::new();
    for row in snapshot
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
        let Some(subscription) = row
            .get("usage")
            .and_then(|usage| usage.get("subscription"))
            .filter(|value| !value.is_null())
        else {
            continue;
        };
        if let Some(text) = subscription.get("resetDate").and_then(Value::as_str) {
            if let Some(at) = end_of_day_ms(text) {
                out.insert(id.to_string(), json!({ "at": at, "text": text, "kind": "reset" }));
            }
            continue;
        }
        if let Some(at) = subscription.get("expireAt").and_then(Value::as_i64) {
            if at > 0 {
                out.insert(id.to_string(), json!({ "at": at, "text": "", "kind": "expire" }));
            }
        }
    }
    let _ = store;
    Value::Object(out)
}

/// `YYYY-MM-DD` → 那天**结束**的毫秒时间戳（本地时区）。
/// 语义上 resetDate 是「这一期到这天为止」，所以取当天 23:59:59 而不是零点。
fn end_of_day_ms(text: &str) -> Option<i64> {
    use chrono::{NaiveDate, TimeZone};
    let date = NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").ok()?;
    let naive = date.and_hms_opt(23, 59, 59)?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|value| value.timestamp_millis())
}
