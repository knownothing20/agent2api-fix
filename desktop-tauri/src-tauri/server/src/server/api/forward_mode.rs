//! 转发模式开关：`GET/PUT /api/forwardMode`。
//!
//! ── 这个开关做什么 ──────────────────────────────────────────
//! 决定「这条请求走流式还是非流式」怎么定。设置页上是**两个控件**，后端只存**一个键**：
//!
//! ```text
//! 转发模式：    ( ) 总是流式    ( ) 总是非流式
//! 客户端遵循：  [✓] 按客户端要求（勾上：客户端要求了就听它；没要求则转发模式生效）
//! ```
//!
//! 两个控件的组合正好是四个取值：
//!   · 勾上 + 总是流式   → `follow-stream`     客户端要求了就听它；没要求用流式
//!   · 勾上 + 总是非流式 → `follow-nonstream`  客户端要求了就听它；没要求用非流式
//!   · 不勾 + 总是流式   → `always-stream`     **一律流式**（覆盖客户端）
//!   · 不勾 + 总是非流式 → `always-nonstream`  **一律非流式**（覆盖客户端）
//!
//! 判定逻辑**只写在一处**（`config::wants_stream`），三个转发入口（Chat / Responses /
//! Anthropic）共用它 —— 三处各写一遍必然漂移。
//!
//! ── 默认值 ──────────────────────────────────────────────────
//! `follow-nonstream` = **与改造前完全一致**（客户端说什么就是什么，没传按 API 规范当
//! 非流式），零意外。
//!
//! ── 形态刻意与 /api/debug、/api/sanitize、/api/hideReasoning 一致 ──
//! GET 读、PUT 写、响应体就是新状态 —— 设置页那几个开关的读写代码共用一套模式。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::config;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/forwardMode —— 当前转发模式
pub async fn get_forward_mode(State(_state): State<ServerState>) -> Response {
    ok_json(forward_mode_json())
}

/// PUT /api/forwardMode —— body `{forwardMode: "follow-stream" | …}`
///
/// 越界值拒绝（400）而不是静默回落：这是设置页写下来的值，写错就该当场知道，
/// 与「读文件时越界回落默认」是两种场景（那是防手改坏，这是防前端传错）。
pub async fn put_forward_mode(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let key = config::KEY_FORWARD_MODE;
    let Some(value) = object.get(key) else {
        return errors::management_error(400, format!("缺少 {key}"));
    };
    let Some(mode) = value.as_str() else {
        return errors::management_error(400, format!("{key} 必须是字符串"));
    };
    if !config::set_forward_mode(mode) {
        return errors::management_error(
            400,
            format!(
                "{key} 只能是 {}",
                config::FORWARD_MODES.join(" / ")
            ),
        );
    }
    logging::log(
        "[Config]",
        &format!("转发模式已改为 {mode}（下一个请求立即生效）"),
    );
    ok_json(forward_mode_json())
}

/// 开关状态（GET 与 PUT 共用，前端直接用响应刷新界面）
fn forward_mode_json() -> Value {
    json!({
        config::KEY_FORWARD_MODE: config::current().forward_mode(),
    })
}
