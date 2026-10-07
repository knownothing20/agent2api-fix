//! 自动领福利（码道）的三个节流旋钮：`GET/PUT /api/welfareSettings`。
//!
//! ── 三个「间隔」各管各的（2026-10-07 用户要求后两个可配）──
//!   ① 任务的 `interval`（`/api/scheduled-tasks` 里那条，面板上那个输入框）
//!      = **多久扫一轮**账号列表；
//!   ② `welfareAccountGapMinutes` = **账号之间**等多久 —— 防「同 IP 一口气把
//!      N 个账号的写请求打完」（批量操作最显眼的特征）；
//!   ③ `welfareMinAttemptGapMinutes` + `welfareMaxAttemptsPerDay`
//!      = **同一账号**的写闸（两次写至少隔多久、一天最多写几次）。
//!
//! ②③ 只约束**自动**领取（定时任务那条链）；面板上那颗「领福利」按钮走手动
//! 路径，不受它们约束（与改造前一致）。
//!
//! ── 形态与 /api/codeartsMaxTokensCap、/api/hideReasoning 一致 ──
//! GET 读、PUT 写、响应体就是新值。领取路径逐轮读内存快照，改完下一轮立即
//! 生效，不重启进程。越界一律 400（**不静默钳制**）—— 这三个值直接决定发
//! 多少写请求，写错一个数量级的影响比「少写一个零」大得多。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::server::config::{
    self, WELFARE_ACCOUNT_GAP_MINUTES_MAX, WELFARE_ACCOUNT_GAP_MINUTES_MIN,
    WELFARE_MAX_ATTEMPTS_PER_DAY_MAX, WELFARE_MAX_ATTEMPTS_PER_DAY_MIN,
    WELFARE_MIN_ATTEMPT_GAP_MINUTES_MAX, WELFARE_MIN_ATTEMPT_GAP_MINUTES_MIN,
};
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/welfareSettings —— 当前三个旋钮
pub async fn get_welfare_settings(State(_state): State<ServerState>) -> Response {
    ok_json(settings_json())
}

/// PUT /api/welfareSettings —— body 三个键都要给（缺一个 400，不做部分更新）
pub async fn put_welfare_settings(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let Some(account_gap) = read_number(
        object,
        config::KEY_WELFARE_ACCOUNT_GAP_MINUTES,
        WELFARE_ACCOUNT_GAP_MINUTES_MIN,
        WELFARE_ACCOUNT_GAP_MINUTES_MAX,
    ) else {
        return errors::management_error(
            400,
            range_message(
                config::KEY_WELFARE_ACCOUNT_GAP_MINUTES,
                WELFARE_ACCOUNT_GAP_MINUTES_MIN,
                WELFARE_ACCOUNT_GAP_MINUTES_MAX,
            ),
        );
    };
    let Some(min_attempt_gap) = read_number(
        object,
        config::KEY_WELFARE_MIN_ATTEMPT_GAP_MINUTES,
        WELFARE_MIN_ATTEMPT_GAP_MINUTES_MIN,
        WELFARE_MIN_ATTEMPT_GAP_MINUTES_MAX,
    ) else {
        return errors::management_error(
            400,
            range_message(
                config::KEY_WELFARE_MIN_ATTEMPT_GAP_MINUTES,
                WELFARE_MIN_ATTEMPT_GAP_MINUTES_MIN,
                WELFARE_MIN_ATTEMPT_GAP_MINUTES_MAX,
            ),
        );
    };
    let Some(max_attempts) = read_number(
        object,
        config::KEY_WELFARE_MAX_ATTEMPTS_PER_DAY,
        WELFARE_MAX_ATTEMPTS_PER_DAY_MIN,
        WELFARE_MAX_ATTEMPTS_PER_DAY_MAX,
    ) else {
        return errors::management_error(
            400,
            range_message(
                config::KEY_WELFARE_MAX_ATTEMPTS_PER_DAY,
                WELFARE_MAX_ATTEMPTS_PER_DAY_MIN,
                WELFARE_MAX_ATTEMPTS_PER_DAY_MAX,
            ),
        );
    };
    if !config::set_welfare_settings(account_gap, min_attempt_gap, max_attempts) {
        logging::log("[Config]", "⚠️  福利节流设置写入失败，本次运行内仍生效");
    }
    logging::log(
        "[Config]",
        &format!(
            "福利节流已设为：账号之间 {account_gap} 分钟、单账号写闸 {min_attempt_gap} 分钟 / 每天 {max_attempts} 次"
        ),
    );
    ok_json(settings_json())
}

fn read_number(object: &Map<String, Value>, key: &str, min: u64, max: u64) -> Option<u64> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| (min..=max).contains(value))
}

fn range_message(key: &str, min: u64, max: u64) -> String {
    format!("{key} 必须是 {min} 到 {max} 的整数")
}

/// 当前值（GET 与 PUT 共用，前端直接用响应刷新界面）
fn settings_json() -> Value {
    let snapshot = config::current();
    json!({
        config::KEY_WELFARE_ACCOUNT_GAP_MINUTES:
            snapshot.welfare_account_gap().as_secs() / 60,
        config::KEY_WELFARE_MIN_ATTEMPT_GAP_MINUTES:
            snapshot.welfare_min_attempt_gap().as_secs() / 60,
        config::KEY_WELFARE_MAX_ATTEMPTS_PER_DAY:
            snapshot.welfare_max_attempts_per_day(),
    })
}
