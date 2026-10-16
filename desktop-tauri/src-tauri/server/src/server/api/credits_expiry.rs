//! 「积分到期」总览的面板入口：`GET /api/credits/expiry`。
//!
//! 数据与口径全部在 `core::credits_expiry`（那里解释了为什么按自然日算窗口、
//! 为什么不抄参考面板那句「调度会优先消耗」）。这里只负责取数与触发刷新。
//!
//! 参数：
//!   - `refresh=1`：**先真查一遍余额**再返回（等价于点一次账号页的「查询余额」），
//!     否则直接用现有快照 —— 打开这一页默认**零上游成本**（见模块头）。

use axum::extract::State;
use axum::http::Uri;
use axum::response::Response;

use crate::server::core::credits_expiry;
use crate::server::core::usage_query;
use crate::server::http::{ok_json, query_param};
use crate::server::ServerState;

/// GET /api/credits/expiry —— 逐账号的「总余额 / 临期 / 最近到期 / 包数 + 逐包」。
pub async fn get_credits_expiry(State(state): State<ServerState>, uri: Uri) -> Response {
    let query = uri.query().unwrap_or("");
    let refresh = query_param(query, "refresh")
        .map(|value| value == "1" || value == "true")
        .unwrap_or(false);
    if refresh {
        // 查询失败不挡住总览：快照里本来就留着上一轮的结果，
        // 把「刷新失败」变成「整页打不开」是更差的取舍（界面靠 `at` 判断时效）。
        if let Err(error) = usage_query::query_all(state.store(), None).await {
            crate::server::logging::log(
                "[Usage]",
                &format!("积分到期页刷新余额失败（沿用上次快照）：{}", error.message),
            );
        }
    }
    ok_json(credits_expiry::build(state.store()))
}
