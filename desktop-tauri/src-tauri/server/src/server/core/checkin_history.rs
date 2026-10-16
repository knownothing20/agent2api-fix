//! 签到历史（本地台账）—— 「最近签过什么、结果如何」的唯一真相。
//!
//! ── 为什么要有它（2026-10-16 用户要求）────────────────────────
//! 用户的原话：「最近几天是不是都签到不了了，看下什么问题」「我希望有一个地方
//! 可以看到签到的历史」。而当时的实际情况是：**签到失败的原因根本没被留下来** ——
//! `trae::checkin::run_round` 把每个账号的结果放进内存里的 `outcomes`，
//! 只把「成功 X 个、失败 Y 个」的**汇总**写进日志，单账号的 `message`
//! （上游原话，例如业务错误码的解释）随函数返回就丢了。于是：
//!   · 面板上只看得到「未签到」；
//!   · 任务卡只看得到「失败 1 个」；
//!   · 日志里只有汇总行。
//! 排查时等于没有任何线索 —— 这就是本模块存在的理由：**把单账号结果落盘**。
//!
//! ── 为什么存 kv 而不新建一张表 ──────────────────────────────
//! 这张表的产品语义是「一个有上限的最近列表」：面板只做「按 provider 过滤 +
//! 取前 N 条」，不需要按字段查询、排序、聚合 —— 那正是 `kv` 表注释里写的
//! 「没有固定结构、读写都是整份进出」的形态（`model_rules` / `custom_providers`
//! 同款）。新建表要动 `SCHEMA_VERSION` 与建表分支，换来的查询能力用不上。
//!
//! ── 为什么不复用事件日志（`logs` 表）────────────────────────
//! 事件日志有 **500 条总量**上限（`logs_store::MAX_ENTRIES`），而「凭证自动维护」
//! 每 10 分钟一条（≈144 条/天）⇒ 表里绝大部分是维护噪音，**签到记录 3 天就会被
//! 挤出去**。而用户要的恰恰是「最近几天」的历史，且希望它别被别的日志冲掉。
//! 所以单开一份存储，带自己的上限（见 `MAX_RECORDS`）。
//!
//! ── 存储形状（对外契约，改要前后端一起改）────────────────────
//! kv 键 `checkinHistory`，值是 JSON 数组，**最新在前**：
//! ```json
//! {
//!   "at": 1792156030631,          // 毫秒时间戳
//!   "provider": "trae",           // provider id（内置家）或自定义家 id
//!   "accountId": "trae-...",      // 账号记录 id
//!   "name": "2803042591",         // 展示名
//!   "uid": "1915817845352675",    // 上游 uid（Trae 用；其余家可为空）
//!   "status": "success",          // success / already / fail
//!   "credits": 100,               // 签到后余额（拿不到则 null）
//!   "delta": 200,                 // 本次新增（already 恒为 0）
//!   "message": "今日已签到",       // 上游原话 / 本地说明
//!   "errorType": null,            // 失败分类（PlanLimit / SessionDead / …）
//!   "source": "daily"             // manual / daily / interval
//! }
//! ```
//! **最新在前**是有意的：面板取前 N 条就是「最近 N 次」，不需要排序；
//! 裁剪也是从尾部砍，与「留最近」同一方向。
//!
//! ── `source` 三档 ──────────────────────────────────────────
//! `manual` 面板上那颗「立即签到 / 签到」按钮；`daily` 定点轮（配置的 HH:MM）；
//! `interval` 间隔型任务（`traeCheckin` 的每 N 分钟一轮）与通用定时签到。
//! 有它才能回答「这条是我手点的还是它自己跑的」—— 排查时第一个要问的问题。

use serde_json::{json, Map, Value};

use crate::server::config;
use crate::server::logging;

/// kv 键名（落进 `kv` 表，与 `modelRules` / `customProviders` 同级）。
const KEY: &str = "checkinHistory";

/// 记录条数上限。
///
/// 400 是按「两个账号、每天定点 + 间隔各一轮 + 偶尔手点」估的（≈8 条/天）
/// ⇒ 约 **50 天**。用户要的是「最近几天」，留一个数量级的余量即可；
/// 再大就只是让 kv 里那一行 JSON 变长（每次写入都要整份重写）。
pub const MAX_RECORDS: usize = 400;

/// 一条待写入的签到记录（借字符串，避免调用方先拼一遍 `String`）。
pub struct Entry<'a> {
    pub provider: &'a str,
    pub account_id: &'a str,
    pub name: &'a str,
    pub uid: &'a str,
    /// `success` / `already` / `fail`
    pub status: &'a str,
    /// 签到后的余额（拿不到传 None ⇒ 落成 JSON null，面板显示「—」而不是编个数）
    pub credits: Option<i64>,
    /// 本次新增积分（`already` 恒为 0）
    pub delta: i64,
    /// 上游原话或本地说明
    pub message: &'a str,
    /// 失败分类（`None` = 没失败或没分类）
    pub error_type: Option<&'a str>,
    /// `manual` / `daily` / `interval`
    pub source: &'a str,
    /// 这次失败是不是「签到拥堵」（上游 code=9074）—— 见 `crowded_today`。
    /// 非失败（成功 / 已签 / 跳过）恒为 false。
    pub crowded: bool,
}

/// 追加一条记录。返回是否落盘成功。
///
/// **失败只返回 false、不 panic 也不改签到结果**：上游那边积分已经领到了，
/// 因为一次落盘失败就把成功的签到报成失败是本末倒置（与 `mark_checkin`
/// 那句「写盘失败只记日志」同一取向）。调用方负责把 false 记一行日志。
pub fn record(entry: Entry<'_>) -> bool {
    let mut items = stored_items();
    items.insert(
        0,
        json!({
            "at": logging::now_ms(),
            "provider": entry.provider,
            "accountId": entry.account_id,
            "name": entry.name,
            "uid": entry.uid,
            "status": entry.status,
            "credits": entry.credits,
            "delta": entry.delta,
            "message": entry.message,
            "errorType": entry.error_type,
            "source": entry.source,
            "crowded": entry.crowded,
        }),
    );
    items.truncate(MAX_RECORDS);
    save(Value::Array(items))
}

/// 读最近记录（最新在前）。`provider` 为 `None` = 不过滤（面板默认看全部）。
///
/// 过滤与截断都在内存里做：数据量是「最多 400 条的小数组」，
/// 而 kv 的读写本来就是整份进出（见模块头），没有可省的 SQL 工作。
pub fn list(provider: Option<&str>, limit: usize) -> Vec<Value> {
    let limit = limit.clamp(1, MAX_RECORDS);
    stored_items()
        .into_iter()
        .filter(|item| match provider {
            None => true,
            Some(want) => item.get("provider").and_then(Value::as_str) == Some(want),
        })
        .take(limit)
        .collect()
}

/// 「今天这个账号已经撞过签到拥堵（9074）」吗？
///
/// ── 为什么要这个判据（2026-10-16 用户拍板）──────────────────────
/// Trae 对签到 claim 回的 `9074` 是**签到拥堵**（参考实现的向量里给它标的字面就是
/// `checkin crowded`，与上游文案「当前参与用户太多，请稍后再试」完全对上）。
/// 关键点：**多试几次不会让它不挤** —— 实测那个账号 09:00 与 21:07 都撞，
/// 而另一个号任何时候都能签上（同 IP、同套餐、同活动开关），说明这是上游侧的
/// 拥堵/限流，不是我们能靠「更勤快」解决的。
///
/// 而 `providers/trae/usage.rs` 的模块头记着一条前科：
/// **`checkin_credits/status` 这条链曾因「9074 重试链 + 面板连点」把出口 IP 打进封禁**。
/// 一旦 IP 被封，同一个 IP 下**所有**账号的签到一起废 —— 拿两个号的每日签到
/// 去换一件大概率没收益的事，不值。
///
/// ⇒ 所以：**当天撞过一次 9074 就不再自动重试**（后续轮次连只读预检都不做），
/// 但**手动触发不受此限** —— 用户按按钮就是明确的「现在再试一次」。
/// 判据取自历史里今天的记录（`at` 的**本地日期**），所以跨零点自然失效。
pub fn crowded_today(provider: &str, account_id: &str) -> bool {
    let today = day_text(logging::now_ms());
    stored_items().iter().any(|item| {
        item.get("provider").and_then(Value::as_str) == Some(provider)
            && item.get("accountId").and_then(Value::as_str) == Some(account_id)
            && item.get("crowded").and_then(Value::as_bool) == Some(true)
            && item
                .get("at")
                .and_then(Value::as_i64)
                .map(|at| day_text(at) == today)
                .unwrap_or(false)
    })
}

/// 毫秒时间戳 → **本地**日期串（`YYYY-MM-DD`）。
///
/// 用本地日期而不是 UTC：用户看到的「今天」是他自己时区的今天（与 Trae 侧
/// 「每天一次」的自然日口径一致）。
fn day_text(at_ms: i64) -> String {
    use chrono::TimeZone;
    let millis = at_ms.max(0);
    chrono::Local
        .timestamp_millis_opt(millis)
        .single()
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// 清空历史（`provider` 给定时只清那一家的）。返回删掉的条数。
///
/// 为什么要有：这是用户自己攒的台账，得能自己清掉 —— 否则试错几轮之后
/// 面板里会堆着一串已经没意义的失败记录。
pub fn clear(provider: Option<&str>) -> usize {
    let before = stored_items();
    let kept: Vec<Value> = match provider {
        None => Vec::new(),
        Some(want) => before
            .iter()
            .filter(|item| item.get("provider").and_then(Value::as_str) != Some(want))
            .cloned()
            .collect(),
    };
    let removed = before.len() - kept.len();
    if removed > 0 {
        save(Value::Array(kept));
    }
    removed
}

/// 读 kv 里那份数组；缺失 / 形状不对都当空列表（历史是**增量数据**，
/// 坏了就当没有，不能让它把签到链路带崩）。
fn stored_items() -> Vec<Value> {
    config::current()
        .raw()
        .get(KEY)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn save(value: Value) -> bool {
    config::update_raw_field(KEY, value)
}

/// 面板要的响应体（放在这里而不是 api 层：字段名与 `record` 的落盘形状
/// 是一份契约，分两处写迟早会漂）。
pub fn response(provider: Option<&str>, limit: usize) -> Value {
    let records = list(provider, limit);
    json!({
        "records": records,
        "max": MAX_RECORDS,
        "total": stored_items().len(),
    })
}

/// 给 `config` 的 `raw` 补一条空数组（首次运行让键存在，便于排查时一眼看到
/// 「这个键是干什么的」）。当前没有调用方，保留给将来的迁移脚本。
#[allow(dead_code)]
pub fn ensure_key(raw: &mut Map<String, Value>) {
    raw.entry(KEY.to_string()).or_insert_with(|| Value::Array(Vec::new()));
}
