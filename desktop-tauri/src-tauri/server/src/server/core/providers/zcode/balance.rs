//! ZCode 套餐余额查询（`GET /api/v1/zcode-plan/billing/balance`）。
//!
//! ── 这是 billing 网关上的第三个接口 ──────────────────────────
//! 同一台网关（`zcode.z.ai`）上前两个是 `preview` / `claim`（见 `claim.rs`，
//! 领取链路），本文件补的是**读数**：账号还剩多少、哪几个桶、什么时候过期。
//! 与领取一样，它认的是 **套餐 JWT**（不是推理用的 `accessToken`，两者不能
//! 互相替代，见 `credentials.rs` 的模块头）。
//!
//! ── `X-Device-Mid` 必须带（而且是 UUID 形态）─────────────────
//! 同一个 billing 网关上，**探测接口**对这一条是实测的：缺这个头、或值不是
//! UUID 形态，网关直接回 `400 {"code":3001,"msg":"parameter error"}`，与
//! `app_version` / `platform` / 各种客户端身份头都无关（2026-09-28 实测）。
//! 本接口（balance）上有 token 的账号才能走到参数校验之后，因此**没法用匿名
//! 请求把它单独测出来**；第三方实现（token-monitor 的 zai 探针）记的是同一台
//! 网关上的同一条要求，本家按同一口径发，反正它只多一个头。
//! 值必须**跨请求稳定**（风控据此关联同一设备的请求），所以账号记录里本来就
//! 存着一个（登录时生成、随凭证落盘），缺失时由
//! [`AccountStore::zcode_device_mid_or_create`] 现场生成一次并落盘 ——
//! 不要在调用点现编，每次现编等于「同一个账号天天换设备」。
//!
//! ── 字段清单的出处：官方客户端，不是第三方实现 ────────────────
//! `zai-org/ZCode`（官方仓库）的
//! `packages/services/src/model-provider/zaiStartPlanBilling.ts` 定义了
//! 响应接口 `ZaiStartPlanBalanceEnvelope`：`data.server_time` / `data.plans[]`
//! / `data.balances[]`，字段名逐条照抄（`bucket_id` / `user_plan_id` /
//! `show_name` / `meter` / `unit_type` / `capabilities` / `total_units` /
//! `used_units` / `reserved_units` / `remaining_units` / `available_units` /
//! `period_start` / `period_end` / `expires_at`）。
//! 三处**官方语义**一并移植，别当成优化去掉：
//!   1. `status: "active"` 但 `ends_at` 已过 → 视为 `expired`（上游偶尔不刷状态，
//!      照直读会让过期套餐一直显示在身边）；
//!   2. 归属到已过期套餐的余额桶**整条丢掉**（`user_plan_id` 优先、退回
//!      `plan_id` 配对）—— 否则「昨天领的 1 亿」会永远挂在那里；
//!   3. 认不出归属的桶**保留**（宁可在读数里多一行，也不误删另一个有效套餐的余额）。
//!
//! ── 与官方客户端的差异（有意为之）────────────────────────────
//!   - 官方按 `show_name` 把同模型的桶**相加**成一个池（token-monitor 等第三方
//!     也这么做）。本家不合并：账号页的余额面板是逐桶列明细的，合并会让
//!     「哪个活动/套餐给的额度还剩多少」消失 —— 而 ZCode 这个账号页恰恰是靠
//!     「今天领的 1 亿还剩多少」说话的（每日活动，见 `claim.rs` 的模块头）。
//!     逐桶列出来，面板上就是「GLM-5.3-Flash 1 亿 / 1 亿 token」这样一行一个来源。
//!   - 官方把「空 balances」当 `unavailable`；本家如实回 0 —— 上游明说
//!     `code: 0` 且没有桶，那就是没有额度，不是「没读到」。
//!
//! ── 出网代理：跟着账号走（与领取同一条，与余额查询的其它家相反）──
//! `zcode.z.ai` 对国内用户常常需要代理，而账号记录上的出口正是用户为这个账号
//! 配的。所以这里用 `session_proxy`（与 `api::zcode_claim::account_proxy` 同一
//! 取法），不走直连 —— 理由与 `api/zcode_claim.rs` 的模块头逐字相同。
//!
//! ── 硬约束 ──────────────────────────────────────────────────
//! release 是 `panic=abort`：本文件零 unwrap/expect/panic，取值一律走 Option 链。

use serde_json::{json, Map, Value};

use crate::server::core::account_store::AccountStore;
use crate::server::core::auth_http::send_raw;
use crate::server::errors::GatewayError;

use super::claim::{self, app_version, platform};
use super::region::Region;

/// 余额接口的请求超时。与领取同一档（15 秒）：同一个网关、同一种低频只读调用，
/// 而 `egress` 的默认 read_timeout 是 600 秒（给 SSE 长连接留的）——
/// 不设总超时会让前端的「查询余额」转圈十分钟。
const REQUEST_TIMEOUT_MS: u64 = 15_000;

/// 余额路径（官方客户端 `zcodePlanBillingBalanceUrl` 的后半段）
const BALANCE_PATH: &str = "/api/v1/zcode-plan/billing/balance";

/// 查询某账号的套餐余额（归一化形状见 `ProviderAdapter::query_usage` 的文档）。
///
/// 失败语义按调用方契约：**缺 JWT** 是「未配置查询凭证」（400 +
/// `usage_not_configured`，前端显示成中性提示），**JWT 被拒**原样透出 401
/// （调用方据此走「刷新后重试一次」；本家没有续期协议，那条路会如实报
/// 「请重新登录」）。
pub(super) async fn query_usage(
    store: &AccountStore,
    account_id: &str,
) -> Result<Value, GatewayError> {
    let record = store.zcode_account_record(account_id).ok_or_else(|| {
        GatewayError::with_status(404, "找不到该 ZCode 账号".to_string())
    })?;
    let region = record
        .get("provider")
        .and_then(Value::as_str)
        .and_then(Region::from_provider_id)
        .ok_or_else(|| GatewayError::with_status(400, "该账号不是 ZCode 账号".to_string()))?;
    let text = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };
    let jwt = text("jwt");
    if jwt.is_empty() {
        // 余额**只**认套餐 JWT（推理用的 accessToken 打这个接口必 401）。
        // 用可识别的「未配置」而不是失败：用户去账号设置里补上 jwt 就能查。
        return Err(crate::server::core::providers::adapter::usage_not_configured(
            &format!("ZCode {}", region.label()),
            "Coding Plan JWT",
        ));
    }
    let account_id_owned = record
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(account_id)
        .to_string();
    // 设备标识：记录里有就用，没有就现场生成并落盘（见模块头）。
    // 这里分两步调 store 的方法 —— 它们各自取锁，**不能**嵌套（会死锁）
    let device_mid = store.zcode_device_mid_or_create(&account_id_owned);
    let proxy = store
        .get_session_by_id(&account_id_owned)
        .and_then(|entry| crate::server::core::proxies::session_proxy(&entry.session));

    let url = format!(
        "{}{BALANCE_PATH}?app_version={}&platform={}",
        region.zcode_origin(),
        claim::urlencode(&app_version()),
        claim::urlencode(platform())
    );
    // 头集合：三个，一个不多（见模块头：其余客户端身份头对这台网关无效）。
    // 设备标识没有值时**不发空头**：空头与缺失同效（都是 3001），
    // 但日志里能少一条误导性的记录。
    let mut headers: Vec<(String, String)> = vec![
        ("Authorization".to_string(), format!("Bearer {jwt}")),
        ("Accept".to_string(), "application/json".to_string()),
    ];
    if let Some(mid) = device_mid.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        headers.push(("X-Device-Mid".to_string(), mid.to_string()));
    }

    let response = send_raw("GET", &url, None, &headers, proxy.as_ref(), Some(REQUEST_TIMEOUT_MS))
        .await
        .map_err(|error| {
            if error.is_timeout() {
                GatewayError::with_status(504, "ZCode 余额查询超时")
            } else {
                GatewayError::with_status(502, format!("ZCode 余额查询失败: {error}"))
            }
        })?;

    let payload = response.payload.clone().unwrap_or(Value::Null);
    let code = payload.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = payload
        .get("msg")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();

    // 401：JWT 被拒（失效 / 吊销 / 换了账号）。原样透出 401，让调用方走它既有的
    // 「刷新后重试一次」处置 —— 本家没有续期协议，那条路最终会报一句可读的话。
    if response.status == 401 || code == 401 {
        return Err(GatewayError::with_status(
            401,
            "ZCode 套餐令牌已失效，请重新登录该账号",
        ));
    }
    // 3001 = 参数错误：这台网关只有一种常见成因 —— 设备标识缺失或不是 UUID
    if code == 3001 {
        return Err(GatewayError::with_status(
            502,
            "ZCode 余额查询被上游以「参数错误」拒绝（常见成因：设备标识无效），请重新登录该账号",
        ));
    }
    // 429 = 风控限速。上游对这台网关的请求很敏感（实测短时间连续请求就会被挡），
    // 而**批量查询多个账号时是并发打过去的** —— 这一档要给一句能照着做的提示，
    // 而不是一句「HTTP 429」（用户看不出是限流还是账号问题）。
    // 注意响应体常常是空的，所以这条要判在下面那个「取 message」的兜底之前。
    if response.status == 429 {
        return Err(GatewayError::with_status(
            502,
            "ZCode 余额查询被上游限流（429），请稍后重试或改为逐个查询",
        ));
    }
    if !(200..300).contains(&response.status) || code != 0 {
        let detail = if message.is_empty() {
            format!("HTTP {}", response.status)
        } else {
            message.clone()
        };
        // 业务码为 0 表示「响应体里没有 code」（HTTP 层错误，体可能是空的）——
        // 那种情况别拼一个读起来莫名其妙的「（0）」
        let label = if code == 0 { String::new() } else { format!("（{code}）") };
        return Err(GatewayError::with_status(
            502,
            format!("ZCode 余额查询失败{label}：{detail}"),
        ));
    }
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    Ok(normalize(&data))
}

/// 上游 `data` → 账号页的统一形状。
///
/// 纯函数（不碰网络、不碰时钟以外的东西），因此这里能逐条对齐官方的三处语义
/// （见模块头）而不用管调用时机。`now` 取上游的 `server_time`：那是**上游自己
/// 的时间**，拿本机时间判「套餐过没过期」会在时区/时钟不准的机器上误判。
fn normalize(data: &Value) -> Value {
    let now = data
        .get("server_time")
        .and_then(number_of)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| (crate::server::logging::now_ms() as f64) / 1000.0);
    let plans: Vec<&Value> = data
        .get("plans")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    let expired = |plan: &Value| -> bool {
        let status = plan
            .get("status")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if status != "active" {
            // 非 active（expired / canceled / paused…）一律当作不再提供权益
            return true;
        }
        match plan.get("ends_at").and_then(number_of) {
            // 没有 ends_at 的 active 套餐不判过期（不拿缺失当已结束）
            None => false,
            Some(ends_at) => ends_at > 0.0 && ends_at <= now,
        }
    };
    // 桶的归属：`user_plan_id` 优先、退回 `plan_id`（官方同款配对规则）
    let owners_of = |bucket: &Value| -> Vec<&Value> {
        let user_plan_id = bucket.get("user_plan_id").and_then(Value::as_str);
        let plan_id = bucket.get("plan_id").and_then(Value::as_str);
        plans
            .iter()
            .copied()
            .filter(|plan| match (user_plan_id, plan.get("user_plan_id").and_then(Value::as_str)) {
                (Some(left), Some(right)) => left == right,
                _ => plan_id.is_some() && plan.get("plan_id").and_then(Value::as_str) == plan_id,
            })
            .collect()
    };
    let owner_expired = |bucket: &Value| -> bool {
        let owners = owners_of(bucket);
        // 认不出归属的桶不丢（官方注释：不能被误删）
        !owners.is_empty() && owners.iter().all(|plan| expired(plan))
    };
    // 桶所属套餐的展示名（给界面当「这个额度来自哪个套餐」的标签用；认不出就给 None，
    // 界面退回 `subscription.planName`）
    let owner_name = |bucket: &Value| -> Option<String> {
        owners_of(bucket)
            .into_iter()
            .find_map(plan_display_name)
    };

    let mut wallets: Vec<Value> = Vec::new();
    let mut available = 0.0_f64;
    let mut total = 0.0_f64;
    let mut unit = String::new();
    if let Some(buckets) = data.get("balances").and_then(Value::as_array) {
        for bucket in buckets.iter().filter(|bucket| !owner_expired(bucket)) {
            let show_name = bucket
                .get("show_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("额度")
                .to_string();
            let bucket_unit = bucket
                .get("unit_type")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("")
                .to_string();
            if unit.is_empty() && !bucket_unit.is_empty() {
                unit = bucket_unit.clone();
            }
            // 剩余量的取值链：`remaining_units` → 总额 − 已用 → `available_units`
            // （官方与第三方实现都是这条链；缺一项就退回下一项，不拿 0 冒充）
            let bucket_total = bucket.get("total_units").and_then(number_of);
            let used = bucket.get("used_units").and_then(number_of);
            let remaining = bucket
                .get("remaining_units")
                .and_then(number_of)
                .or_else(|| match (bucket_total, used) {
                    (Some(total), Some(used)) => Some(total - used),
                    _ => None,
                })
                .or_else(|| bucket.get("available_units").and_then(number_of));
            let Some(remaining) = remaining else {
                continue;
            };
            let unit_for_row = if bucket_unit.is_empty() { unit.clone() } else { bucket_unit };
            let view = match bucket_total {
                Some(total) if total > 0.0 => format!(
                    "{} / {} {}",
                    compact_number(remaining),
                    compact_number(total),
                    unit_for_row
                ),
                _ => format!("{} {}", compact_number(remaining), unit_for_row),
            };
            available += remaining;
            if let Some(value) = bucket_total {
                total += value;
            }
            // 剩余占比（0~100）：账号页那个进度条画的是**剩余**比例（与相邻的读数
            // 「8800万 / 1亿」同一口径 —— 进度条与数字指向相反方向会让人读反）。
            // 总量缺失或为 0 时不给这个字段（前端据此不画进度条，只显示读数）。
            let remaining_percent = bucket_total
                .filter(|value| *value > 0.0)
                .map(|value| (remaining / value * 100.0).clamp(0.0, 100.0));
            wallets.push(json!({
                "type": bucket
                    .get("bucket_id")
                    .and_then(Value::as_str)
                    .or_else(|| bucket.get("plan_id").and_then(Value::as_str))
                    .unwrap_or("zcode_balance"),
                "displayName": show_name,
                "balance": remaining,
                "balanceView": view.trim_end(),
                // 结构化读数（`balanceView` 是给人看的串，这三个是给界面算进度条 /
                // 排序用的）。缺失一律 null：界面按「不知道」处理，不拿 0 冒充。
                "total": bucket_total,
                "used": used,
                "remainingPercent": remaining_percent,
                // 这个额度来自哪个套餐（界面拿它当标签；认不出时不写这个键）
                "planName": owner_name(bucket),
            }));
        }
    }
    if unit.is_empty() {
        unit = "token".to_string();
    }

    let mut subscription = Map::new();
    if let Some(plan) = pick_plan(&plans, now) {
        if let Some(name) = plan_display_name(plan) {
            subscription.insert("planName".to_string(), Value::String(name));
        }
        if let Some(status) = plan.get("status").and_then(Value::as_str) {
            subscription.insert("status".to_string(), Value::String(status.to_string()));
        }
        if let Some(ends_at) = plan.get("ends_at").and_then(number_of).filter(|value| *value > 0.0) {
            // 秒 → 毫秒：账号页各家（qoder / raccoon / workbuddy）的到期一律毫秒，
            // 混用会让时间显示成 1970 年。
            //
            // 只取**套餐本身**的 `ends_at`，不拿额度桶的 `period_end` 顶替：每日桶的
            // period_end 是「今天的 24 点」，写成「套餐到期」会被读成套餐要过期了。
            subscription.insert("expireAt".to_string(), json!((ends_at * 1000.0) as i64));
        }
    }
    if total > 0.0 {
        subscription.insert("totalQuota".to_string(), json!(total));
        subscription.insert("remainQuota".to_string(), json!(available));
    }
    json!({
        "available": available,
        // `availableView` 是给「余额列」的展示串：1 亿这类数字用原始整数
        // （100000000）读起来是 9 位数字，而那一列只有几十像素宽。
        //
        // 没有额度桶时**不写「0 token」**：`code: 0` 且一个桶都没有，含义是
        // 「这个账号名下没有可读的额度桶」（免费账号没领过、或套餐的额度记在
        // 另一个口径上），把它显示成「0」会被读成「额度用光了」。文案取中性的
        // 「无额度」，数值仍如实给 0（批量查询与统计那边按数值处理）。
        "availableView": if wallets.is_empty() {
            "无额度".to_string()
        } else {
            format!("{} {}", compact_number(available), unit)
        },
        "unit": unit,
        "wallets": wallets,
        "subscription": subscription,
        // 排障用：上游原文（前端默认不展示）
        "raw": data,
    })
}

/// 挑一个「代表这个账号」的套餐（`subscription` 那段文案读它）。
///
/// 优先级（`0` 档最优先，见 [`plan_rank`]）：**有未来到期时间的**里取到期最早的
/// —— 它回答用户最关心的那句「这笔额度什么时候没了」，也正是账号页「有效期」
/// 那一列要知道的；都没有未来到期时，才退回「有每日权益的」（正在每天续发的
/// Start Plan），最后按 `plan_id` 字典序定序（上游给的顺序不保证稳定）。
///
/// ── 与官方客户端的取舍不同（别当成抄漏）───────────────────────
/// 官方客户端那个表头固定偏好「有每日权益的套餐」（它自己的面板按每日口径展示）。
/// 本家的账号页那一列问的是**有效期 / 到期**，活动送的额度（Trust Build 那类
/// 一次性包）恰恰是有明确截止的那一份 —— 拿一个「不会到期」的每日套餐当代表，
/// 那一列就空了，用户反而看不到自己刚领的 1 亿什么时候失效。
fn pick_plan<'a>(plans: &[&'a Value], now: f64) -> Option<&'a Value> {
    let active: Vec<&&Value> = plans
        .iter()
        .filter(|plan| {
            plan.get("status")
                .and_then(Value::as_str)
                .map(|value| value.trim().eq_ignore_ascii_case("active"))
                .unwrap_or(false)
        })
        .collect();
    let pool: Vec<&&Value> = if active.is_empty() { plans.iter().collect() } else { active };
    let mut best: Option<&&Value> = None;
    for plan in pool {
        match best {
            None => best = Some(plan),
            Some(current) => {
                let key = plan_rank(plan, now);
                let current_key = plan_rank(current, now);
                let take = key < current_key
                    || (key == current_key
                        && plan_id_of(plan) < plan_id_of(current));
                if take {
                    best = Some(plan);
                }
            }
        }
    }
    // `copied()`：best 持有的是 `&&Value`（遍历 `Vec<&&Value>` 的产物），
    // 调用方要的是 `&Value`
    best.copied()
}

/// 套餐的「代表度」键：元组比较，**越小越优先**。
///
///   - 档 0：有未来到期时间 —— 第二项就是 `ends_at`，元组比较取小，
///     于是**到期越早的越优先**；
///   - 档 1：没有未来到期、有每日权益（每天续发的额度）；
///   - 档 2：其余（有到期但已过、又不带每日权益）。
///
/// `now` 由 `data.server_time` 给出（上游自己的时间），判「未来」用它是为了避免
/// 本机时钟不准。
fn plan_rank(plan: &Value, now: f64) -> (u8, f64) {
    match plan
        .get("ends_at")
        .and_then(number_of)
        .filter(|value| value.is_finite() && *value > now)
    {
        Some(ends_at) => (0, ends_at),
        None if has_daily_entitlement(plan) => (1, 0.0),
        None => (2, 0.0),
    }
}

/// 套餐 id（缺失时给空串：参与的只是**定序**，不参与展示）
fn plan_id_of(plan: &Value) -> &str {
    plan.get("plan_id").and_then(Value::as_str).unwrap_or("")
}

/// 套餐的展示名：`name` → 退回 `plan_id`（都缺给 None）。
fn plan_display_name(plan: &Value) -> Option<String> {
    plan.get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            plan.get("plan_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

/// 套餐里有没有「每日」权益（`entitlements[].period == "daily"`）。
///
/// 官方客户端的表头选取口径同样优先这种套餐：每日活动的权益是每天续发的，
/// 它比一次性的活动包更能代表「这个账号现在靠什么在跑」。
fn has_daily_entitlement(plan: &Value) -> bool {
    plan.get("entitlements")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.get("period")
                    .and_then(Value::as_str)
                    .map(|value| value.trim().eq_ignore_ascii_case("daily"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 取一个数值字段（数字或**数字字符串**都认）。
///
/// 上游在不同接口上的形态不一致（官方 TS 接口里 `total_units` 就是
/// `number | string | null`），照直 `as_f64()` 会让一个字符串形态的读数整条消失。
fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok().filter(|value| value.is_finite()),
        _ => None,
    }
}

/// 大数字 → 中文紧凑串（`100000000` → `1亿`，`3000000` → `300万`）。
///
/// 余额列是本表最窄的几列之一，9 位原始数字在那儿读不动。单位固定用「万 / 亿」
/// （这是中文界面的默认刻度），小数最多两位、末尾的 0 去掉。
fn compact_number(value: f64) -> String {
    if !value.is_finite() {
        return "—".to_string();
    }
    let abs = value.abs();
    if abs >= 100_000_000.0 {
        format!("{}亿", trim_trailing_zeros(value / 100_000_000.0))
    } else if abs >= 10_000.0 {
        format!("{}万", trim_trailing_zeros(value / 10_000.0))
    } else if value.fract().abs() < f64::EPSILON {
        format!("{}", value as i64)
    } else {
        format!("{value:.2}")
    }
}

/// `1.00` → `1`、`1.03` → `1.03`（两位小数，去掉末尾的 0 与孤立的小数点）
fn trim_trailing_zeros(value: f64) -> String {
    let text = format!("{value:.2}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}
