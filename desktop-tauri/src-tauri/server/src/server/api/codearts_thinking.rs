//! 码道「禁用思考」开关：`GET/PUT /api/codeartsThinking`。
//!
//! ── 它解决什么（2026-10-07 实测）────────────────────────────
//! glm 这类模型思考长度无底洞：抬到 42768 的额度里烧掉 35155 思考、正文才 8927 字，
//! 单次 464.7 秒（7.7 分钟），远超常见客户端超时；思考还计入用量（成本≈正文 4 倍）。
//! 上游的实测记录（`codearts/chat.rs` 的 `reserve_for_thinking` 注释）指出：
//! **上游认 `thinking:{type:"disabled"}`**（reasoning 归 0、正文正常出），
//! 而 `reasoning_effort:"minimal"` / `thinking.budget` 上游不理 —— 所以这是唯一
//! 「既快又不烧思考」的开关。
//!
//! ── 形态与 /api/hideReasoning、/api/codeartsMaxTokensCap 一致 ──
//! GET 读、PUT 写、响应体就是新值。转发层逐请求读内存快照，改完下一个请求生效，
//! 不重启进程。**默认关** —— 关掉思考会改变模型行为（同一个模型在同一个客户端里
//! 两种表现），该由使用者在知道代价之后自己选。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::config;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/codeartsThinking —— 当前开关状态
pub async fn get_codearts_thinking(State(_state): State<ServerState>) -> Response {
    ok_json(thinking_json())
}

/// PUT /api/codeartsThinking —— body `{codeartsDisableThinking: true|false}`
pub async fn put_codearts_thinking(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let key = config::KEY_CODEARTS_DISABLE_THINKING;
    let Some(value) = payload.get(key) else {
        return errors::management_error(400, format!("缺少 {key}"));
    };
    let Some(enabled) = value.as_bool() else {
        return errors::management_error(400, format!("{key} 必须是布尔值"));
    };
    if !config::set_codearts_disable_thinking(enabled) {
        logging::log("[Config]", "⚠️  码道「禁用思考」写入失败，本次运行内仍生效");
    }
    logging::log(
        "[Config]",
        if enabled {
            "码道已开启「禁用思考」：请求注入 thinking:{type:\"disabled\"}（思考归 0、正文直出）"
        } else {
            "码道已关闭「禁用思考」：恢复为抬额度给思考留空间"
        },
    );
    ok_json(thinking_json())
}

/// 当前值（GET 与 PUT 共用，前端直接用响应刷新界面）
fn thinking_json() -> Value {
    json!({
        config::KEY_CODEARTS_DISABLE_THINKING: config::current().codearts_disable_thinking(),
    })
}
