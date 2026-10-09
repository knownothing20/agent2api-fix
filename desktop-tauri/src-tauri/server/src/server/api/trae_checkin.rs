//! Trae 签到的面板入口：`GET/PUT /api/traeCheckin`。
//!
//! - **GET**：账号间隔配置 + 全部 Trae 账号的**实时签到状态**（只读预检）。
//!   这里确实会逐账号发一个 `checkin_credits/status`，因为「今天签没签」只有
//!   上游知道 —— 本地台账会漂（参考实现就为「台账日期早于系统日期」专门写了
//!   错误分支，那正是不信上游的代价）。**不发任何写请求**。
//! - **PUT**：保存账号之间的间隔（越界 400，不静默钳制）。
//!
//! ── 手动签到为什么不在这里 ──────────────────────────────────
//! 它直接复用任务触发端点 `POST /api/scheduled-tasks/traeCheckin/run` ——
//! 手动与自动因此走**完全同一段代码**（`checkin::run_round`）。另开一条手动
//! 路径的代价是两套分支：将来改了自动那条，手动这条会安静地留在旧行为上，
//! 而「手动能签、自动不能」这种分叉最难查。CodeArts 福利也是同一取向。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::config::{self, TRAE_CHECKIN_GAP_MINUTES_MAX, TRAE_CHECKIN_GAP_MINUTES_MIN};
use crate::server::core::providers::trae::checkin;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/traeCheckin —— 账号间隔 + 全部 Trae 账号的实时签到状态。
pub async fn get_trae_checkin(State(state): State<ServerState>) -> Response {
    let gap = config::current().trae_checkin_gap_minutes();
    match checkin::status_all(state.store()).await {
        Ok(outcomes) => ok_json(json!({
            config::KEY_TRAE_CHECKIN_GAP_MINUTES: gap,
            "accounts": outcomes.iter().map(|item| item.to_json()).collect::<Vec<_>>(),
        })),
        Err(message) => ok_json(json!({
            config::KEY_TRAE_CHECKIN_GAP_MINUTES: gap,
            "accounts": [],
            "error": message,
        })),
    }
}

/// PUT /api/traeCheckin —— 只接受 `traeCheckinGapMinutes`。
pub async fn put_trae_checkin(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let key = config::KEY_TRAE_CHECKIN_GAP_MINUTES;
    let minutes = object
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| (TRAE_CHECKIN_GAP_MINUTES_MIN..=TRAE_CHECKIN_GAP_MINUTES_MAX).contains(value));
    let Some(minutes) = minutes else {
        return errors::management_error(
            400,
            format!(
                "{key} 必须是 {} 到 {} 的整数（0 = 不等待）",
                TRAE_CHECKIN_GAP_MINUTES_MIN, TRAE_CHECKIN_GAP_MINUTES_MAX
            ),
        );
    };
    if !config::set_trae_checkin_gap_minutes(minutes) {
        logging::log("[Config]", "⚠️  Trae 签到账号间隔写入失败，本次运行内仍生效");
    }
    logging::log(
        "[Config]",
        &format!("Trae 签到账号间隔已设为 {minutes} 分钟"),
    );
    ok_json(json!({ key: minutes }))
}
