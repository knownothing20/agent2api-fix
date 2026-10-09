//! Trae 每日签到（多账号）。
//!
//! 参考 `smart-open/TraeWorkAssistant` 的 `tasks/trae_checkin.rs` 重写，落点是本家
//! 已有的 ug 族通道。
//!
//! ── 为什么本家能做这件事 ────────────────────────────────────
//! `checkin_credits` 属于 **ug 族**（积分/权益族）—— 与 `usage.rs` 已经在调的
//! `ide_user_ent_usage` / `ide_user_pay_status` 同一个域名（`UG_HOST`）、同一套
//! 画像（`ug_headers`）。2026-10-09 实测：本家 OAuth 凭证 + `ug_headers` 直接通过
//! 鉴权，**不需要任何设备指纹改造**（那套头本来就对）：
//!
//! ```text
//! POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status   body {}
//! → 200 {"checked_in":true,"code":0,"credits":100,"enable":true,"message":"success"}
//! ```
//!
//! ── 与参考实现的四处取舍（都因为处境不同）────────────────────
//!   * **账号间隔默认 10 分钟**（参考实现 3 秒）：本家多个 Trae 账号共用同一个
//!     出口 IP，而参考实现是桌面端。`usage.rs` 里记着「参考实现有把出口 IP 打进
//!     封禁的前科」，间隔是这里唯一能主动收紧的旋钮（出口 IP 改不了）；
//!   * **幂等靠服务端 `checked_in` 预检**，不建本地台账：服务端才是事实，本地
//!     台账只是它的缓存 —— 而缓存会漂（参考实现就为「台账日期早于系统日期」
//!     专门写了错误分支）。每次多花一个只读请求，换掉一整类一致性 bug；
//!   * **不做账号级冷却落盘**：签到是每天一次的低频动作，失败由调度器按任务级
//!     冷却重试即可（`scheduled_tasks` 现成）。账号级冷却要在容器里维护一份
//!     持久状态，成本高于它挡掉的那点重复请求；
//!   * **已签的账号不占间隔**：`status` 预检是只读的，不需要拉开节奏；只有真正
//!     要写上游（claim）的账号之间才隔。否则「今天已签完」的常态下每轮白等
//!     (N-1)×gap。
//!
//! ── 错误分类沿用参考实现的表（未验证，按上游语义照录）──────────
//! 401 视为永久失效（JWT 被吊销），其余按状态码给冷却参考值 —— 本版只用它
//! 决定**日志措辞**与**是否值得重试**，不做持久化冷却。
//!
//! 硬约束：release 是 `panic=abort`，本文件零 unwrap / expect / panic。

use std::time::Duration;

use serde_json::{Value, json};

use crate::server::core::account_store::AccountStore;
use crate::server::core::proxies::ResolvedProxy;
use crate::server::errors::GatewayError;
use crate::server::logging;

use super::adapter::{account_proxy, read_record, renew_if_due};
use super::credentials::Credential;
use super::http::post_json;
use super::usage::{UG_HOST, ug_headers};

/// 签到状态预检（只读，不改任何状态）。
pub const STATUS_PATH: &str = "/trae/api/v2/ug/checkin_credits/status";
/// 执行签到（写）。
pub const CLAIM_PATH: &str = "/trae/api/v2/ug/checkin_credits/claim";

/// 单次请求超时。签到是交互型动作，20 秒足够（与积分查询同值）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// 宽容取整（int / 整值 float / 纯数字串 → i64），对齐 `usage.rs` 的读数纪律：
/// 上游把一个整数写成 `100.0` 不该让整格读不出来。
fn as_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// 按 HTTP 状态码与业务码分类签到错误 → `(类型, 建议冷却秒数)`。
///
/// 冷却值沿用参考实现（`-1` = 永久，`0` = 仅记录）；本版不落盘，只在日志里
/// 说明「这类错误值不值得马上重试」。表本身是上游语义的转述，不是实测结论 ——
/// 所以措辞上只当作提示。
pub fn classify_error(http_status: u16, code: Option<i64>) -> (&'static str, i64) {
    if http_status == 200 && code == Some(1005) {
        return ("PlanLimit", 43_200);
    }
    if http_status == 429 {
        return ("SoftRate", 60);
    }
    if http_status == 401 {
        return ("SessionDead", -1);
    }
    if http_status == 404 {
        return ("NotFound", 60);
    }
    if (500..600).contains(&http_status) {
        return ("Server", 600);
    }
    if (400..500).contains(&http_status) {
        return ("Client", 600);
    }
    if code.is_some_and(|c| c != 0) {
        return ("BusinessError", 300);
    }
    ("Unknown", 0)
}

/// 单账号的签到结果（面板与任务摘要共用）。
#[derive(Debug, Clone)]
pub struct AccountOutcome {
    pub name: String,
    pub uid: String,
    /// `success` / `already` / `fail`
    pub status: &'static str,
    pub credits: Option<i64>,
    /// 本次新增积分（拿不到就 0；`already` 恒为 0）
    pub delta: i64,
    pub message: String,
    pub error_type: Option<&'static str>,
}

impl AccountOutcome {
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "uid": self.uid,
            "status": self.status,
            "credits": self.credits,
            "delta": self.delta,
            "message": self.message,
            "errorType": self.error_type,
        })
    }
}

/// 一轮签到汇总。
#[derive(Debug, Default)]
pub struct RoundSummary {
    pub outcomes: Vec<AccountOutcome>,
    pub ok: usize,
    pub already: usize,
    pub failed: usize,
}

impl RoundSummary {
    /// 任务摘要（调度器日志与面板共用同一句话）。
    pub fn summary_text(&self) -> String {
        format!(
            "签到成功 {} 个，今日已签 {} 个，失败 {} 个",
            self.ok, self.already, self.failed
        )
    }

    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "already": self.already,
            "failed": self.failed,
            "total": self.outcomes.len(),
            "summary": self.summary_text(),
            "accounts": self.outcomes.iter().map(AccountOutcome::to_json).collect::<Vec<_>>(),
        })
    }
}

/// 一次 ug 族 POST → `(http_status, 解析后的 JSON)`。
///
/// 头一律走 `ug_headers`：签到与积分查询是同族，**共用一套画像**是这里最重要
/// 的约束 —— 换个 UA 或加个 `X-Uid` 会被上游当成另一个身份（`usage.rs` 记着
/// 「谱系/画像不匹配时回 401 `code=1001`」）。响应体解析失败给 `Null`，由调用方
/// 按状态码判读。
async fn ug_post(
    credential: &Credential,
    proxy: Option<&ResolvedProxy>,
    path: &str,
) -> Result<(u16, Value), GatewayError> {
    let prepared: Vec<(String, String)> = ug_headers(
        credential.variant(),
        credential.access_token.trim(),
        credential.device_id.trim(),
    )
    .into_iter()
    .collect();
    let headers: Vec<(&str, String)> = prepared
        .iter()
        .map(|(name, value)| (name.as_str(), value.clone()))
        .collect();
    let url = format!("{UG_HOST}{path}");
    let reply = post_json(&url, &json!({}), &headers, REQUEST_TIMEOUT, proxy).await?;
    let body = reply.json().unwrap_or(Value::Null);
    Ok((reply.status, body))
}

/// `status` 预检结果。
struct StatusOutcome {
    /// 上游明确答复「今天已签 / 未签」且业务码为 0。
    ok: bool,
    checked_in: bool,
    credits: Option<i64>,
    message: String,
}

/// 预检今日是否已签（只读）。任何异常都归为 `ok: false`，由调用方决定怎么处置 ——
/// 预检失败**不**等于「未签」，所以绝不能因为预检失败就去 claim。
async fn status_of(credential: &Credential, proxy: Option<&ResolvedProxy>) -> StatusOutcome {
    let fail = |message: String| StatusOutcome { ok: false, checked_in: false, credits: None, message };
    match ug_post(credential, proxy, STATUS_PATH).await {
        Ok((status, body)) => {
            if !body.is_object() {
                return fail(format!("HTTP {status}：响应不是 JSON 对象"));
            }
            let code = body.get("code").and_then(Value::as_i64);
            let checked_in = body
                .get("checked_in")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let credits = body.get("credits").and_then(as_int);
            let message = body
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let ok = status == 200 && code == Some(0);
            StatusOutcome {
                ok,
                checked_in,
                credits,
                message: if message.is_empty() { format!("HTTP {status}") } else { message },
            }
        }
        Err(error) => fail(error.message),
    }
}

/// 执行签到 → `(成功, 本次新增积分, 消息, 错误类型)`。
///
/// 新增积分优先取 claim 响应自身的奖励字段（上游返回为准），取不到再看
/// 「签到后复查余额 − 签到前余额」；两者都没有就是 0（面板显示「已签」而不编数）。
async fn claim_of(
    credential: &Credential,
    proxy: Option<&ResolvedProxy>,
    credits_before: Option<i64>,
) -> (bool, i64, String, Option<&'static str>) {
    match ug_post(credential, proxy, CLAIM_PATH).await {
        Ok((status, body)) => {
            let code = body.get("code").and_then(Value::as_i64);
            let message = body
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {status}"));
            let success = status == 200 && code == Some(0);
            if !success {
                let (error_type, _) = classify_error(status, code);
                return (false, 0, message, Some(error_type));
            }
            // 奖励字段候选（与参考实现同一优先级），命中正整数才采信。
            const REWARD_KEYS: [&str; 8] = [
                "reward", "reward_credits", "claim_credits", "checkin_credits", "delta",
                "increase", "obtain", "credits",
            ];
            let reward = REWARD_KEYS
                .iter()
                .find_map(|key| body.get(*key).and_then(as_int).filter(|n| *n > 0));
            match reward {
                Some(value) => (true, value, message, None),
                None => {
                    // 复查余额求差（best-effort：失败不影响「签到成功」的判定）
                    let after = status_of(credential, proxy).await;
                    let delta = match (credits_before, after.credits) {
                        (Some(before), Some(now)) if now >= before => now - before,
                        _ => 0,
                    };
                    (true, delta, message, None)
                }
            }
        }
        Err(error) => {
            let (error_type, _) = classify_error(0, None);
            (false, 0, error.message, Some(error_type))
        }
    }
}

/// 只读地查询全部 Trae 账号的签到状态（面板用；**不发任何写请求**，也不续期
/// 凭证 —— 展示动作不该有副作用）。
///
/// `status` 取值：`already`（今日已签）/ `pending`（今日未签）/ `fail`（查询失败）。
/// 后两者必须分开：**「查不到」不等于「未签」** —— 面板若把查询失败显示成
/// 「未签」，用户会以为账号有问题。
pub async fn status_all(store: &AccountStore) -> Result<Vec<AccountOutcome>, String> {
    let (targets, _skipped) =
        crate::server::core::usage_query::resolve_batch_targets(store, Some("trae"), None)
            .map_err(|error| error.message)?;
    let mut outcomes = Vec::new();
    for account in targets.iter() {
        let Some(account_id) = account.get("id").and_then(Value::as_str) else {
            continue;
        };
        let record = match read_record(store, account_id) {
            Ok(value) => value,
            Err(error) => {
                outcomes.push(AccountOutcome {
                    name: account_id.to_string(),
                    uid: String::new(),
                    status: "fail",
                    credits: None,
                    delta: 0,
                    message: error.message,
                    error_type: Some("Unknown"),
                });
                continue;
            }
        };
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(account_id)
            .to_string();
        let uid = record.get("uid").and_then(Value::as_str).unwrap_or("").to_string();
        let credential = match Credential::from_payload(&record) {
            Ok(value) => value,
            Err(message) => {
                outcomes.push(AccountOutcome {
                    name,
                    uid,
                    status: "fail",
                    credits: None,
                    delta: 0,
                    message,
                    error_type: Some("Unknown"),
                });
                continue;
            }
        };
        let proxy = account_proxy(&record).ok().flatten();
        let pre = status_of(&credential, proxy.as_ref()).await;
        // already 的文案固定用「今日已签到」：上游那一格的 message 恒是通用回执
        // （实测为 `"success"`），拿它当状态说明没有任何信息量。
        let (status, message) = if !pre.ok {
            ("fail", format!("查询失败：{}", pre.message))
        } else if pre.checked_in {
            ("already", "今日已签到".to_string())
        } else {
            ("pending", "今日未签到".to_string())
        };
        outcomes.push(AccountOutcome {
            name,
            uid,
            status,
            credits: pre.credits,
            delta: 0,
            message,
            error_type: None,
        });
    }
    Ok(outcomes)
}

/// 跑一轮签到：遍历全部 Trae 账号，逐账号「预检 → 需要就签」。
///
/// 单账号失败不中断整轮；返回汇总供任务摘要与面板消费。
/// `gap_minutes` 是**需要真正写上游的账号之间**的间隔（已签的账号不占），
/// 传 0 表示不等待。
pub async fn run_round(store: &AccountStore, gap_minutes: i64) -> Result<RoundSummary, String> {
    let (targets, _skipped) =
        crate::server::core::usage_query::resolve_batch_targets(store, Some("trae"), None)
            .map_err(|error| error.message)?;

    let mut summary = RoundSummary::default();
    let mut claimed_so_far = 0usize;

    for account in targets.iter() {
        let Some(account_id) = account.get("id").and_then(Value::as_str) else {
            continue;
        };
        // ── 读凭证（含临期续期）────────────────────────────────
        let record = match read_record(store, account_id) {
            Ok(value) => value,
            Err(error) => {
                summary.failed += 1;
                summary.outcomes.push(AccountOutcome {
                    name: account_id.to_string(),
                    uid: String::new(),
                    status: "fail",
                    credits: None,
                    delta: 0,
                    message: error.message,
                    error_type: Some("Unknown"),
                });
                continue;
            }
        };
        let name = record
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(account_id)
            .to_string();
        let uid = record.get("uid").and_then(Value::as_str).unwrap_or("").to_string();
        let credential = match Credential::from_payload(&record) {
            Ok(value) => value,
            Err(message) => {
                summary.failed += 1;
                summary.outcomes.push(AccountOutcome {
                    name,
                    uid,
                    status: "fail",
                    credits: None,
                    delta: 0,
                    message,
                    error_type: Some("Unknown"),
                });
                continue;
            }
        };
        let proxy = account_proxy(&record).ok().flatten();
        // 临期先续期：拿一个刚被作废的串去签，只会得到 401 而不是"未签"。
        let credential = match renew_if_due(store, &record, &credential, proxy.as_ref()).await {
            Ok(value) => value,
            Err(error) => {
                summary.failed += 1;
                summary.outcomes.push(AccountOutcome {
                    name,
                    uid,
                    status: "fail",
                    credits: None,
                    delta: 0,
                    message: error.message,
                    error_type: Some("Unknown"),
                });
                continue;
            }
        };

        // ── 预检 ────────────────────────────────────────────
        let pre = status_of(&credential, proxy.as_ref()).await;
        if pre.ok && pre.checked_in {
            summary.already += 1;
            summary.outcomes.push(AccountOutcome {
                name,
                uid,
                status: "already",
                credits: pre.credits,
                delta: 0,
                message: "今日已签到".to_string(),
                error_type: None,
            });
            continue;
        }
        // 预检失败 ≠ 未签 —— 不签，如实报错（避免在凭证/网络异常时误发写请求）
        if !pre.ok {
            summary.failed += 1;
            summary.outcomes.push(AccountOutcome {
                name,
                uid,
                status: "fail",
                credits: pre.credits,
                delta: 0,
                message: format!("预检失败：{}", pre.message),
                error_type: Some("Unknown"),
            });
            continue;
        }

        // ── 账号间隔（只挡真正要写上游的账号）──────────────────
        if claimed_so_far > 0 && gap_minutes > 0 {
            logging::log(
                "[Trae]",
                &format!("签到：账号之间等待 {gap_minutes} 分钟（防同 IP 连打）"),
            );
            tokio::time::sleep(Duration::from_secs(gap_minutes.max(0) as u64 * 60)).await;
        }
        claimed_so_far += 1;

        // ── 签到 ────────────────────────────────────────────
        let (ok, delta, message, error_type) =
            claim_of(&credential, proxy.as_ref(), pre.credits).await;
        if ok {
            summary.ok += 1;
            let credits = pre.credits.map(|before| before + delta).or(pre.credits);
            summary.outcomes.push(AccountOutcome {
                name,
                uid,
                status: "success",
                credits,
                delta,
                message: if message.is_empty() { "签到成功".to_string() } else { message },
                error_type: None,
            });
        } else {
            summary.failed += 1;
            let hint = error_type
                .map(|kind| format!("（{kind}）"))
                .unwrap_or_default();
            summary.outcomes.push(AccountOutcome {
                name,
                uid,
                status: "fail",
                credits: pre.credits,
                delta: 0,
                message: format!("{message}{hint}"),
                error_type,
            });
        }
    }

    Ok(summary)
}
