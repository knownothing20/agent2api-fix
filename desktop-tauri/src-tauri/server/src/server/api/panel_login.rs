//! 「面板密码登录」开关：`GET/PUT /api/panel/login-required`。
//!
//! ── 这个开关做什么（2026-10-21 用户要求）──────────────────────
//! Docker / headless 形态下，只要 `.env` 配了 `AGENT2API_ADMIN_USER` /
//! `AGENT2API_ADMIN_PASSWORD`，`access::panel_auth_enabled()` 就恒为真 ⇒
//! 面板每次换设备、清 cookie 都要重新输密码。内网自用（面板只在局域网）
//! 时这很啰嗦，用户要一个「关掉密码登录」的开关。
//!
//! 关掉之后：
//!   · `/api/*`（管理面）**直接放行**，打开面板就能进；
//!   · `/v1/*`（转发面）**仍然要求 API Key** —— 两件事必须分开：
//!     关掉的是「人看面板要不要密码」，不是「程序调模型要不要鉴权」。
//!     把 `/v1/*` 一起放开等于把模型额度对全网开放，那是另一回事。
//!
//! ⚠️ 代价写在界面上（`settings-page.tsx` 的 `NOTES.panelLoginRequired`）：
//! 关掉后任何能访问这个端口的人都能进面板 —— 能改账号、看网关 Key、花积分。
//! 所以默认 `true`，必须管理员显式关闭。
//!
//! 挂在 `/api/panel/` 前缀下（而不是 `/api/`）：闸门对这个前缀始终放行，
//! 否则关掉之后再也调不回来（自锁）。
//!
//! 与 `/api/captcha` 同形：GET 读、PUT 写、响应体就是新状态；写盘位置是
//! config 的 `panelLoginRequired` 键，改完下一个请求立即生效，不重启进程。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::access;
use crate::server::config;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

fn state_json() -> Value {
    json!({
        "required": config::current().panel_login_required(),
        // 有没有配管理员 —— 界面据此说明「关掉之后是不是真的免密」
        // （没配管理员本来就不需要登录，开关只是一个显式声明）
        "adminRegistered": access::admin_registered(),
    })
}

/// GET /api/panel/login-required —— 当前开关状态
pub async fn get_login_required(State(_state): State<ServerState>) -> Response {
    ok_json(state_json())
}

/// PUT /api/panel/login-required —— body `{required: true|false}`
pub async fn put_login_required(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let Some(value) = object.get("required") else {
        return errors::management_error(400, "缺少 required 字段");
    };
    let Some(required) = value.as_bool() else {
        return errors::management_error(400, "required 必须是布尔值");
    };
    if !config::set_panel_login_required(required) {
        return errors::management_error(500, "写入配置失败，请重试");
    }
    logging::log(
        "[Security]",
        if required {
            "面板密码登录已开启：/api/* 需要登录（或带 API Key）"
        } else {
            "⚠️ 面板密码登录已关闭：能访问本端口的人可直接进入面板（/v1/* 仍要 API Key）"
        },
    );
    ok_json(state_json())
}
