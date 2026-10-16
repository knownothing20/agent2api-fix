//! 签到历史的面板入口：`GET / DELETE /api/checkin-history`。
//!
//! ── 为什么单开一个端点（2026-10-16 用户要求）────────────────────
//! 用户要「一个地方可以看到签到的历史」。数据本身由 `core::checkin_history`
//! 落盘（Trae 的 `push_outcome` 与通用签到的 `record_history` 写同一份台账），
//! 这里只负责把它读出来 / 清掉。
//!
//! ── 为什么不挂在 `/api/logs` 上 ────────────────────────────────
//! 事件日志有 500 条**总量**上限、且被「凭证自动维护」（≈144 条/天）占满，
//! 签到记录几天就被挤出去。历史是**独立保留**的一份台账（400 条 ≈ 50 天），
//! 端点也随之独立 —— 语义不同，不该共用一个出口。
//!
//! 参数：
//!   - `provider`（可选）：只看某一家（面板在 Trae 标签里默认只看 `trae`）；
//!   - `limit`（可选，默认 100，上限 `checkin_history::MAX_RECORDS`）。

use axum::extract::State;
use axum::http::Uri;
use axum::response::Response;
use serde_json::json;

use crate::server::core::checkin_history;
use crate::server::http::{ok_json, query_param};
use crate::server::logging;
use crate::server::ServerState;

/// 面板默认取多少条。
///
/// 100 是「一屏看不完、但翻起来不烦」的量：按每天 8 条估约两周，
/// 正好覆盖用户问的「最近几天」。要更多可以带 `limit`。
const DEFAULT_LIMIT: usize = 100;

/// GET /api/checkin-history —— 最近的签到记录（最新在前）。
pub async fn list(State(_state): State<ServerState>, uri: Uri) -> Response {
    let query = uri.query().unwrap_or("");
    let provider = query_param(query, "provider").filter(|value| !value.is_empty());
    let limit = query_param(query, "limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_LIMIT);
    ok_json(checkin_history::response(provider.as_deref(), limit))
}

/// DELETE /api/checkin-history —— 清空历史（`?provider=` 时只清那一家）。
///
/// 允许清空是有意的：这是用户自己的台账，试错几轮之后面板里会堆一串
/// 已经没意义的失败记录，得能自己抹掉。返回删掉的条数，便于界面提示。
pub async fn clear(State(_state): State<ServerState>, uri: Uri) -> Response {
    let query = uri.query().unwrap_or("");
    let provider = query_param(query, "provider").filter(|value| !value.is_empty());
    let removed = checkin_history::clear(provider.as_deref());
    logging::log(
        "[Checkin]",
        &format!(
            "签到历史已清空 {removed} 条{}",
            provider.map(|name| format!("（仅 {name}）")).unwrap_or_default()
        ),
    );
    ok_json(json!({ "removed": removed }))
}
