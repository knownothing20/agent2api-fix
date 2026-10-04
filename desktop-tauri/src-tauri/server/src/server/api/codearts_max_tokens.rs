//! 码道（CodeArts）`max_tokens` 硬顶：`GET/PUT /api/codeartsMaxTokensCap`。
//!
//! ── 为什么是码道特有、不是通用配置 ─────────────────────────
//! 65536 是**码道上游平台（InferHub）的参数硬顶**（2026-10-04 逐档实测：65536 收、
//! 70000+ 一律 `InferHub.001001005.400`），别家的上限各不相同 —— 所以键名带
//! `codearts` 前缀（与 `codeartsWelfare` 同一命名法），端点也单独一条，不混进通用设置。
//!
//! ── 钳制而不是拒绝 ─────────────────────────────────────────
//! 模型目录里 `maxOutputTokens: 384000` 是假的（照它设必被上游拒），而网关会把上游
//! 的 400 包成 502 —— 客户端看到的是「疑似网络故障」，排查成本极高。钳制后这类请求
//! 从「必失败」变成「输出截到上限」，对客户端透明。
//!
//! ── 形态与 /api/hideReasoning、/api/forwardMode 一致 ────────
//! GET 读、PUT 写、响应体就是新值。钳制动作在码道适配器里、逐请求读内存快照，
//! 改完下一个请求立即生效，不重启进程。`0` = 不钳制（原样透传，与改造前一致）。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::config::{
    self, CODEARTS_MAX_TOKENS_CAP_MAX, CODEARTS_MAX_TOKENS_CAP_MIN,
};
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/codeartsMaxTokensCap —— 当前钳制值（对外口径与存储一致：0 = 不钳制）
pub async fn get_codearts_max_tokens_cap(State(_state): State<ServerState>) -> Response {
    ok_json(cap_json())
}

/// PUT /api/codeartsMaxTokensCap —— body `{codeartsMaxTokensCap: 0..=1000000}`
pub async fn put_codearts_max_tokens_cap(
    State(_state): State<ServerState>,
    body: Bytes,
) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let key = config::KEY_CODEARTS_MAX_TOKENS_CAP;
    let Some(value) = object.get(key) else {
        return errors::management_error(400, format!("缺少 {key}"));
    };
    let Some(cap) = value.as_u64() else {
        return errors::management_error(
            400,
            format!("{key} 必须是 {CODEARTS_MAX_TOKENS_CAP_MIN} 到 {CODEARTS_MAX_TOKENS_CAP_MAX} 的整数"),
        );
    };
    if !(CODEARTS_MAX_TOKENS_CAP_MIN..=CODEARTS_MAX_TOKENS_CAP_MAX).contains(&cap) {
        return errors::management_error(
            400,
            format!(
                "{key} 必须在 {CODEARTS_MAX_TOKENS_CAP_MIN} 到 {CODEARTS_MAX_TOKENS_CAP_MAX} 之间（0 = 不钳制）"
            ),
        );
    }
    if !config::set_codearts_max_tokens_cap(cap) {
        logging::log("[Config]", "⚠️  码道 max_tokens 硬顶写入失败，本次运行内仍生效");
    }
    logging::log(
        "[Config]",
        &format!(
            "码道 max_tokens 硬顶已设为 {}",
            if cap == 0 {
                "不钳制（原样透传）".to_string()
            } else {
                format!("{cap}（转发前超限一律压到它）")
            }
        ),
    );
    ok_json(cap_json())
}

/// 当前值（GET 与 PUT 共用，前端直接用响应刷新界面）
fn cap_json() -> Value {
    json!({
        config::KEY_CODEARTS_MAX_TOKENS_CAP: config::current().codearts_max_tokens_cap().unwrap_or(0),
    })
}
