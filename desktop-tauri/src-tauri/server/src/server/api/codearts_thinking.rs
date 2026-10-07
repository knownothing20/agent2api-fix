//! 码道「思考档位」：`GET/PUT /api/codeartsThinking`。
//!
//! ── 它解决什么（2026-10-07 实测）────────────────────────────
//! glm 这类模型思考长度无底洞：抬到 42768 的额度里烧掉 35155 思考、正文才 8927 字，
//! 单次 464.7 秒（7.7 分钟），远超常见客户端超时；思考还计入用量（成本≈正文 4 倍）。
//!
//! ── 为什么是「档位」而不是「开关」──────────────────────────
//! 先试过注入 `thinking:{"type":"disabled"}`，被上游明确拒绝：
//! `InferHub.malformed_json.400：该模型始终思考，不支持关闭思考；请使用 low、
//! high 或 max`。**这条链上关不掉思考，只能调档** —— 所以本开关的取值就是
//! 上游列的那三个（`low` / `high` / `max`），空串 = 不注入（默认）。
//!
//! ── 形态与 /api/hideReasoning、/api/codeartsMaxTokensCap 一致 ──
//! GET 读、PUT 写、响应体就是新值。转发层逐请求读内存快照，改完下一个请求生效，
//! 不重启进程。默认空串：调档会改变模型行为，该由使用者在知道代价之后自己选。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::config;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/codeartsThinking —— 当前档位（空串 = 不注入）
pub async fn get_codearts_thinking(State(_state): State<ServerState>) -> Response {
    ok_json(thinking_json())
}

/// PUT /api/codeartsThinking —— body `{codeartsThinkingLevel: "" | "low" | "high" | "max"}`
pub async fn put_codearts_thinking(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let key = config::KEY_CODEARTS_THINKING_LEVEL;
    let Some(value) = payload.get(key) else {
        return errors::management_error(400, format!("缺少 {key}"));
    };
    let Some(level) = value.as_str() else {
        return errors::management_error(400, format!("{key} 必须是字符串"));
    };
    let level = level.trim();
    if !level.is_empty() && !config::CODEARTS_THINKING_LEVELS.contains(&level) {
        return errors::management_error(
            400,
            format!(
                "{key} 只能是 {} 之一（空串 = 不注入）",
                config::CODEARTS_THINKING_LEVELS.join(" / ")
            ),
        );
    }
    if !config::set_codearts_thinking_level(level) {
        logging::log("[Config]", "⚠️  码道思考档位写入失败，本次运行内仍生效");
    }
    logging::log(
        "[Config]",
        &if level.is_empty() {
            "码道思考档位已清空：不再注入 thinking（由上游按默认档跑）".to_string()
        } else {
            format!("码道思考档位已设为 {level}（注入 thinking:{{\"type\":\"{level}\"}}）")
        },
    );
    ok_json(thinking_json())
}

/// 当前值（GET 与 PUT 共用，前端直接用响应刷新界面）
fn thinking_json() -> Value {
    json!({
        config::KEY_CODEARTS_THINKING_LEVEL: config::current().codearts_thinking_level(),
    })
}
