//! GET/PUT /api/scheduling —— 多账号调度的两项设置（设置页「网关 → 多账号调度」）。
//!
//! ── 两项各管什么 ────────────────────────────────────────────
//! · `schedulingMode`：粘性命中**之后**怎么排（会话粘性固定生效，不在这一档里），
//!   取值见 `core::routing::ConversationOrder`；
//! · `schedulingWaitSeconds`：**满员时等一个会话槽位**的最长秒数 —— 该账号的并发
//!   上限用满时不立刻拿 409，而是等一个空位，等满才把原来的 409 原样返回。
//!   `0` = 不等待（等于改造前的行为）。
//!
//! 两项都属于「多账号调度」这一组，所以走同一条端点、同一份响应 —— 前端一次拿到
//! 全部生效值、改哪项传哪项（与 /api/retry 的「允许部分字段」同一口径）。
//!
//! 与 /api/retry 同一模式：独立端点、返回生效后的全量值、**没有副作用**
//! （不清理数据、不重启进程），保存后对下一次选路 / 下一次满员立即生效
//! （两者都是逐请求读内存快照，不读盘）。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{Map, Value};

use crate::server::config::{
    self, KEY_SCHEDULING_MODE, KEY_SCHEDULING_WAIT, SCHEDULING_WAIT_MAX, SCHEDULING_WAIT_MIN,
};
use crate::server::core::routing::ConversationOrder;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

/// 三个合法档位，报错文案里直接用（与 `ConversationOrder::parse` 同源，
/// 多一处手写清单就会多一处漂移的地方）。
const ALLOWED_MODES: &str = "stickyOnly / creditFirst / idleFirst";

/// GET /api/scheduling
pub async fn get_scheduling(State(_state): State<ServerState>) -> Response {
    ok_json(scheduling_json())
}

/// PUT /api/scheduling —— body `{schedulingMode?, schedulingWaitSeconds?}`
///
/// 允许部分字段：只改一项时另一项保持原值。**两项都不给报 400** —— 否则一次
/// 空请求会被当成保存成功，用户看不出自己漏了字段（与 /api/retry 同一取舍）。
pub async fn put_scheduling(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };

    // ── 先全部校验、再写盘（与 put_retry 同一顺序）：两项里有一项非法时整体不落盘，
    //    免得出现「档位改了、等待没改」的半套设置 ──────────────────
    let mut mode: Option<ConversationOrder> = None;
    if let Some(raw) = object.get(KEY_SCHEDULING_MODE) {
        let Some(text) = raw.as_str() else {
            return errors::management_error(400, format!("{KEY_SCHEDULING_MODE} 必须是字符串"));
        };
        let Some(parsed) = ConversationOrder::parse(text) else {
            return errors::management_error(
                400,
                format!("{KEY_SCHEDULING_MODE} 取值非法：{text}（可选值：{ALLOWED_MODES}）"),
            );
        };
        mode = Some(parsed);
    }

    let mut wait_seconds: Option<u64> = None;
    if let Some(raw) = object.get(KEY_SCHEDULING_WAIT) {
        let Some(value) = raw.as_u64() else {
            return errors::management_error(
                400,
                format!("{KEY_SCHEDULING_WAIT} 必须是 0–{SCHEDULING_WAIT_MAX} 的整数（秒）"),
            );
        };
        if !(SCHEDULING_WAIT_MIN..=SCHEDULING_WAIT_MAX).contains(&value) {
            return errors::management_error(
                400,
                format!(
                    "{KEY_SCHEDULING_WAIT} 超出范围：{value}（可填 {SCHEDULING_WAIT_MIN}–{SCHEDULING_WAIT_MAX} 秒，0 = 不等待）"
                ),
            );
        }
        wait_seconds = Some(value);
    }

    if mode.is_none() && wait_seconds.is_none() {
        return errors::management_error(
            400,
            format!("至少要给一项：{KEY_SCHEDULING_MODE} 或 {KEY_SCHEDULING_WAIT}"),
        );
    }

    // 内存都已更新（见两个 setter 的说明），只有落盘可能失败 —— 记一条，不静默
    if let Some(mode) = mode {
        if !config::set_scheduling_mode(mode) {
            crate::server::logging::verbose("[Config]", "调度档位落盘失败（内存已生效）");
        }
    }
    if let Some(seconds) = wait_seconds {
        if !config::set_scheduling_wait_seconds(seconds) {
            crate::server::logging::verbose("[Config]", "调度等待秒数落盘失败（内存已生效）");
        }
    }
    // 返回**生效后**的值：前端直接用响应刷新界面，不必再 GET 一次（与 put_retry 同）
    ok_json(scheduling_json())
}

/// 响应形状 `{schedulingMode, schedulingWaitSeconds}`。
///
/// 用 `Map` 拼而不是 `json!({ KEY: … })`：`json!` 的键只认字符串字面量，
/// 把常量写在键位上会变成字面量 `"KEY_SCHEDULING_MODE"` 这个键名。
fn scheduling_json() -> Value {
    let mut object = Map::new();
    object.insert(
        KEY_SCHEDULING_MODE.to_string(),
        Value::String(config::scheduling_mode().as_str().to_string()),
    );
    object.insert(
        KEY_SCHEDULING_WAIT.to_string(),
        Value::from(config::scheduling_wait_seconds()),
    );
    Value::Object(object)
}
