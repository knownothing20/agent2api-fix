//! GET/PUT /api/scheduling —— 多账号调度档位（设置页「通用 → 多账号调度」）。
//!
//! ── 为什么只有一档可调 ──────────────────────────────────────
//! **会话粘性固定生效**：客户端带 `x-session-id` 时，同一条会话的每一轮都落在
//! 同一个账号上，这一条不给关。这个端点管的是粘性命中**之后**怎么排，取值见
//! `core::routing::ConversationOrder`：
//!   · `stickyOnly`  —— 只保粘性，之后按优先级（等于改造前的选路）
//!   · `creditFirst` —— 粘性 + 积分优先（默认，也是引入设置项之前的行为）
//!   · `idleFirst`   —— 粘性 + 空闲优先
//!
//! 与 /api/retry 同一模式：独立端点、返回生效后的全量值、**没有副作用**
//! （不清理数据、不重启进程），保存后对下一次选路立即生效（选路逐请求读内存
//! 快照，不读盘）。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{Map, Value};

use crate::server::config::{self, KEY_SCHEDULING_MODE};
use crate::server::core::routing::ConversationOrder;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

/// 三个合法取值，报错文案里直接用（与 `ConversationOrder::parse` 同源，
/// 多一处手写清单就会多一处漂移的地方）。
const ALLOWED: &str = "stickyOnly / creditFirst / idleFirst";

/// GET /api/scheduling
pub async fn get_scheduling(State(_state): State<ServerState>) -> Response {
    ok_json(scheduling_json(config::scheduling_mode()))
}

/// PUT /api/scheduling —— body `{schedulingMode}`
pub async fn put_scheduling(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let Some(raw) = object.get(KEY_SCHEDULING_MODE).and_then(Value::as_str) else {
        return errors::management_error(400, format!("缺少 {KEY_SCHEDULING_MODE}（可选值：{ALLOWED}）"));
    };
    let Some(mode) = ConversationOrder::parse(raw) else {
        return errors::management_error(
            400,
            format!("{KEY_SCHEDULING_MODE} 取值非法：{raw}（可选值：{ALLOWED}）"),
        );
    };
    if !config::set_scheduling_mode(mode) {
        // 内存已生效（见 setter 的说明），只是落盘失败 —— 记一条，不静默
        crate::server::logging::verbose("[Config]", "调度档位落盘失败（内存已生效）");
    }
    // 返回**生效后**的值：前端直接用响应刷新界面，不必再 GET 一次（与 put_retry 同）
    ok_json(scheduling_json(config::scheduling_mode()))
}

/// 响应形状 `{schedulingMode: "…"}`。
///
/// 用 `Map` 拼而不是 `json!({ KEY: … })`：`json!` 的键只认字符串字面量，
/// 把常量写在键位上会变成字面量 `"KEY_SCHEDULING_MODE"` 这个键名。
fn scheduling_json(mode: ConversationOrder) -> Value {
    let mut object = Map::new();
    object.insert(
        KEY_SCHEDULING_MODE.to_string(),
        Value::String(mode.as_str().to_string()),
    );
    Value::Object(object)
}
