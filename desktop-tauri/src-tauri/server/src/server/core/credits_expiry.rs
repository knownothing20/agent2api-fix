//! 「积分到期」总览 —— 哪些账号有多少分快作废。
//!
//! ── 为什么要有它（2026-10-16 用户要求，参照 workbuddy2api 的同名页面）──
//! 账号页那一格只放得下一个总数（「可用 2500」），而积分**过期即作废**：
//! 真实账号的余额常常是「一个月度大包 + 若干个每天发的小包」，只看总数会把
//! 「今天有 100 分要没了」完全藏起来。逐包明细（`积分明细` 弹窗）回答的是
//! **一个账号**的问题；这里回答的是**全部账号**的问题 —— 一屏看出谁快作废。
//!
//! ── 与参考面板（workbuddy2api）的一处**有意不同** ────────────
//! 它那一页会写「在临期窗口内 —— 调度会优先消耗」，因为它有
//! `assign_mode=expiring_first` 的调度：**面板说快过期的，正是调度在抢的**，
//! 两处必须共用同一份窗口口径（它的注释里记了参考实现踩过的坑）。
//!
//! **agent2api 没有这个调度** —— 选路读的是 `routing::CreditRank`
//! （账号的**整期重置日** + 剩余量，见 `usage_query::credit_rank`），与逐包到期
//! 无关。所以这里**不抄那句话**：编一个「调度会优先消耗」的承诺，比不显示更糟。
//! 本页的定位就是**信息展示**：告诉用户「这些分什么时候没」。
//!
//! ── 数据从哪来（关键：不额外打上游）────────────────────────────
//! 全部取自**已有的余额快照**（`usage_query::snapshot()`，由「定时查询积分」
//! 任务与账号页的「查询余额」写入）。参考面板是点一次打一遍上游（每账号一个
//! 只读接口 + 60 秒缓存）；这里复用快照 ⇒ **打开这一页零上游成本**，
//! 代价是数字的时效性取决于上一次查询（响应里带回 `at`，界面显示查询时刻）。
//!
//! ── 临期窗口：按**自然日**算 ─────────────────────────────────
//! 截止 = 今天 23:59:59 再往后 `HORIZON_DAYS` 个自然日。
//! **刻意不用**「当前时刻 + N×24h」的滚动口径 —— 后者截止线随「现在几点」漂移，
//! 会在自然日边界差几小时漏掉整批包（这条理由抄自参考实现，它的注释里写明了
//! 参考实现因为展示与调度两处口径不同，导致「面板说快过期」和「系统在抢的」
//! 不是同一批）。agent2api 虽然没有那个调度，口径统一仍然是对的：
//! 明天再打开这一页，「临期」那一列不该因为现在是上午还是下午而变化。

use chrono::{Duration as ChronoDuration, Local};
use serde_json::{json, Value};

use crate::server::core::account_store::AccountStore;
use crate::server::core::usage_query;

/// 临期窗口长度（自然日）。**这一处是唯一的定义**，改它即可改全站口径。
///
/// 7 天：与参考面板的默认值一致。更短（3 天）会让「周末不上班」这类场景来不及
/// 反应；更长（14 天）会把「还早着呢」的包也标成临期，反而淹没真正紧急的那几个。
pub const HORIZON_DAYS: i64 = 7;

/// 临期窗口的截止时刻（毫秒）。
///
/// 今天 23:59:59 的本地时刻 + `HORIZON_DAYS` 天。
/// 本地时刻在夏令时跳变日可能不存在（春季）或被跳过 —— 那种情况下退化成
/// 「现在 + N×24h」的滚动口径：一年最多影响一两次，且只影响那一天的边界，
/// 比让整条链路报错好。
pub fn deadline_ms() -> i64 {
    let now = Local::now();
    let naive = now
        .date_naive()
        .and_hms_opt(23, 59, 59)
        .map(|value| value + ChronoDuration::days(HORIZON_DAYS));
    naive
        .and_then(|value| {
            use chrono::TimeZone;
            Local.from_local_datetime(&value).single()
        })
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|| now.timestamp_millis() + HORIZON_DAYS * 86_400_000)
}

/// 构造「积分到期」总览。
///
/// 每个账号一行，行内带 `packages`（逐包）。**上游不给逐包到期的家**
/// （CodeArts / Trae：它们的 `wallets` 里没有到期字段）如实标 `note`，
/// 不编时间 —— 与 `BalanceDetailDialog` 里那句「写清楚比编一列假倒计时诚实」同一取向。
pub fn build(store: &AccountStore) -> Value {
    let snapshot = usage_query::snapshot();
    let at = snapshot.get("at").and_then(Value::as_i64).unwrap_or(0);
    let deadline = deadline_ms();

    // 快照行里只有 `{id, name, usage, error}` —— provider 与启用状态要回账号表取。
    // `resolve_batch_targets` 是内存操作（读 store 的账号快照），不打上游。
    let accounts: std::collections::HashMap<String, Value> =
        usage_query::resolve_batch_targets(store, None, None)
            .map(|(list, _)| {
                list.into_iter()
                    .filter_map(|account| {
                        let id = account.get("id").and_then(Value::as_str)?.to_string();
                        Some((id, account))
                    })
                    .collect()
            })
            .unwrap_or_default();

    let mut rows: Vec<Value> = Vec::new();
    let mut totals = Totals::default();

    for row in snapshot
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id = row.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let account = accounts.get(&id);
        let provider = account
            .and_then(|item| item.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // 禁用判据取**用户开关**（`enabled`），不是 `available` ——
        // 后者还掺了冷却之类的运行时状态，用它会让「禁用」这一列忽明忽暗。
        let disabled = account
            .and_then(|item| item.get("enabled"))
            .and_then(Value::as_bool)
            == Some(false);
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .or_else(|| account.and_then(|item| item.get("name")).and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| id.clone());

        let usage = row.get("usage").filter(|value| !value.is_null());
        let mut entry = json!({
            "id": id,
            "name": name,
            "provider": provider,
            "disabled": disabled,
            "at": at,
        });

        match usage {
            None => {
                // 未查询 / 查询失败：如实说，不给 0（0 会被读成「额度用完了」）
                let error = row.get("error").and_then(Value::as_str).unwrap_or("");
                entry["note"] = Value::String(if error.is_empty() {
                    "还没查过余额".to_string()
                } else {
                    format!("余额查询失败：{error}")
                });
                totals.failed += 1;
            }
            Some(usage) => {
                let packages = packages_of(usage);
                if packages.is_empty() {
                    // 两件事在这里合并成一句「上游不提供逐包到期」是不对的，
                    // 所以分开写：有 `wallets` 说明这家的余额是分账本的、只是没给到期；
                    // 连 wallets 都没有才是「只有一个总数」。
                    let has_wallets = usage
                        .get("wallets")
                        .and_then(Value::as_array)
                        .map(|list| !list.is_empty())
                        .unwrap_or(false);
                    entry["note"] = Value::String(if has_wallets {
                        "上游不提供逐包到期时间（该家余额按账本分开，但账本没有到期字段）".to_string()
                    } else {
                        "上游不提供逐包到期时间（该家余额只有一个总数）".to_string()
                    });
                    // 总数仍然给 —— 「这一家没有到期概念」不等于「这一家没有额度」
                    if let Some(available) = usage.get("available").and_then(Value::as_f64) {
                        entry["left"] = json_number(available);
                    } else if let Some(total_left) = usage.get("totalLeft").and_then(Value::as_f64) {
                        entry["left"] = json_number(total_left);
                    }
                    totals.unsupported += 1;
                    if !disabled {
                        if let Some(left) = entry.get("left").and_then(Value::as_f64) {
                            totals.total_left += left;
                        }
                    }
                } else {
                    let mut left_sum = 0.0_f64;
                    let mut expiring_sum = 0.0_f64;
                    let mut nearest: Option<i64> = None;
                    let mut detailed: Vec<Value> = Vec::new();
                    for package in &packages {
                        let left = package.get("left").and_then(Value::as_f64).unwrap_or(0.0);
                        let expire_at = package.get("expireAt").and_then(Value::as_i64);
                        let expiring = expire_at.map(|value| value <= deadline).unwrap_or(false);
                        left_sum += left;
                        if expiring {
                            expiring_sum += left;
                        }
                        if let Some(value) = expire_at {
                            nearest = Some(nearest.map_or(value, |best: i64| best.min(value)));
                        }
                        let mut item = package.clone();
                        item["expiring"] = Value::Bool(expiring);
                        detailed.push(item);
                    }
                    entry["left"] = json_number(left_sum);
                    entry["expiring"] = json_number(expiring_sum);
                    entry["packageCount"] = Value::from(packages.len());
                    entry["nearestAt"] = nearest.map(Value::from).unwrap_or(Value::Null);
                    entry["packages"] = Value::Array(detailed);
                    totals.supported += 1;
                    if !disabled {
                        totals.total_left += left_sum;
                        totals.expiring += expiring_sum;
                    } else {
                        totals.disabled_left += left_sum;
                    }
                }
            }
        }

        if disabled {
            totals.disabled += 1;
        }
        totals.accounts += 1;
        rows.push(entry);
    }

    // 排序：**启用在前**（禁用号的「紧迫度」没有意义，但数据不该被藏起来），
    // 同组内**有临期余额的排前面**（临期多的更紧急），再看最近到期时间。
    // 没有到期时间的排最后 —— 拿 0 当「最小」会把它顶到最前面，与语义相反。
    rows.sort_by(|a, b| {
        let da = a.get("disabled").and_then(Value::as_bool).unwrap_or(false);
        let db = b.get("disabled").and_then(Value::as_bool).unwrap_or(false);
        if da != db {
            return da.cmp(&db);
        }
        let ea = a.get("expiring").and_then(Value::as_f64).unwrap_or(0.0);
        let eb = b.get("expiring").and_then(Value::as_f64).unwrap_or(0.0);
        if (ea > 0.0) != (eb > 0.0) {
            return if ea > 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        if ea != eb {
            return eb.partial_cmp(&ea).unwrap_or(std::cmp::Ordering::Equal);
        }
        let na = a.get("nearestAt").and_then(Value::as_i64).unwrap_or(i64::MAX);
        let nb = b.get("nearestAt").and_then(Value::as_i64).unwrap_or(i64::MAX);
        na.cmp(&nb)
    });

    json!({
        "at": at,
        "horizonDays": HORIZON_DAYS,
        "deadlineAt": deadline,
        "deadlineText": text_of(Some(deadline)),
        "totals": {
            "accounts": totals.accounts,
            "disabled": totals.disabled,
            "supported": totals.supported,
            "unsupported": totals.unsupported,
            "failed": totals.failed,
            "totalLeft": json_number(totals.total_left),
            "expiring": json_number(totals.expiring),
            "disabledLeft": json_number(totals.disabled_left),
        },
        "rows": rows,
    })
}

#[derive(Default)]
struct Totals {
    accounts: i64,
    disabled: i64,
    supported: i64,
    unsupported: i64,
    failed: i64,
    total_left: f64,
    expiring: f64,
    disabled_left: f64,
}

/// 从一份余额结果里取逐包明细（只认 `packages`）。
///
/// **只认 `packages`，不猜 `wallets`**：`wallets` 是「按账本分开的读数」
/// （码道 6 本账、Trae 5 本），它们的键里根本没有到期字段 —— 把 `wallets`
/// 当逐包明细用，会让「上游不给到期」这件事看起来像「这些包不会过期」。
/// 两件事必须分开（见 `build` 里 `note` 的分支）。
fn packages_of(usage: &Value) -> Vec<Value> {
    usage
        .get("packages")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|item| item.get("left").and_then(Value::as_f64).unwrap_or(0.0) > 0.0)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// 毫秒时间戳 → `YYYY-MM-DD HH:MM`（本地时区）。空值给空串，不编时间。
fn text_of(value: Option<i64>) -> String {
    match value {
        None => String::new(),
        Some(ms) => chrono::DateTime::<Local>::from(
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64),
        )
        .format("%Y-%m-%d %H:%M")
        .to_string(),
    }
}

/// 数值一律写成「整数形态的数」（与 `billing::usage` 的 `json_number` 同一取舍：
/// 上游额度是整数，`100.0` 这种形态漏到界面上很刺眼）。
fn json_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}
