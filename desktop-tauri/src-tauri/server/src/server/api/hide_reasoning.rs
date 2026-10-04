//! 「不下发思考」开关：`GET/PUT /api/hideReasoning`。
//!
//! ── 这个开关做什么 ──────────────────────────────────────────
//! 开启后转发层在把响应交给客户端之前，把 `reasoning_content` 剥掉：模型**照常
//! 思考**（推理质量、耗时、扣费都不变），只是思考内容不下发 —— 客户端只看到
//! `content`（2026-10-04 用户要求：「要思考，但是不显示思考，只显示结果」）。
//!
//! 与请求头 `X-A2A-Hide-Reasoning: 1` 是**或**的关系：头管单次请求（客户端自己
//! 想要干净结果时带），这个键管全局（流量都经过别的网关时改它更省事）。
//!
//! ── 为什么默认关 ────────────────────────────────────────────
//! 与 `sanitizeBlacklistFingerprints` 的「默认开」相反：那个关掉会让新用户撞 400，
//! 这个开着只是少给一段信息。默认关 = 与改造前完全一致，零意外。
//!
//! ── 形态刻意与 /api/debug、/api/sanitize 一致 ─────────────────
//! GET 读、PUT 写、响应体就是新状态 —— 设置页那几个开关的读写代码因此共用一套模式。
//!
//! ── 写盘位置 ────────────────────────────────────────────────
//! `config` 的 `hideReasoning` 键（统一库 `kv` 表里的配置行）。转发层逐请求读快照，
//! 改完下一个请求立即生效，不重启进程。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::config;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/hideReasoning —— 当前开关状态
pub async fn get_hide_reasoning(State(_state): State<ServerState>) -> Response {
    ok_json(hide_reasoning_json())
}

/// PUT /api/hideReasoning —— body `{hideReasoning: true|false}`
///
/// 写配置，下一个请求立即生效（转发层逐请求读快照，不重启进程）。
pub async fn put_hide_reasoning(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let key = config::KEY_HIDE_REASONING;
    let Some(value) = object.get(key) else {
        return errors::management_error(400, format!("缺少 {key}"));
    };
    let Some(enabled) = value.as_bool() else {
        return errors::management_error(400, format!("{key} 必须是 true 或 false"));
    };
    if !config::set_hide_reasoning(enabled) {
        logging::log("[Config]", "⚠️  「不下发思考」设置写入失败，本次运行内仍生效");
    }
    logging::log(
        "[Config]",
        if enabled {
            "「不下发思考」已开启：模型照常思考，思考内容不下发（客户端只看到正文）"
        } else {
            "「不下发思考」已关闭：思考内容照常下发（与默认一致）"
        },
    );
    ok_json(hide_reasoning_json())
}

/// 开关状态（GET 与 PUT 共用，前端直接用响应刷新界面）
fn hide_reasoning_json() -> Value {
    json!({
        config::KEY_HIDE_REASONING: config::current().hide_reasoning(),
    })
}
