//! 积分发放台账 —— 「每一次到账是什么时候、多少、什么时候到期」。
//!
//! ── 为什么要有它（2026-10-16 用户要求）────────────────────────
//! 用户先说「积分明细才是每一次积分的领取时间、到期时间」，随后又说
//! 「码道也加个领取历史」。两件事要的是同一份数据：**逐次的发放流水**。
//!
//! ── 为什么必须我们自己记（★ 上游不给）────────────────────────
//! 把 CodeArts 上游能读到的字段翻过一遍（线上实测 + 代码）：
//!   · 订阅统计 `/snap-manager/v1/statistics/plugin` 只给**计量表读数**，
//!     唯一的时间字段是 `statistics.reset_date`（整期重置日）；
//!   · 福利网关 `/api/v1/user/tokens/balance` 只给余额，无时间；
//!   · CodeArts 的**全部** 8 条路径里没有任何「流水 / 明细」端点；
//!   · 福利台账（`codearts::welfare::Ledger`）是**按天**存的
//!     （`day` / `attempts` / `accepted`），**没有历史** ⇒ 补不回来。
//! ⇒ 「每一次领取的时间」只能靠**我们自己**在发放那一刻记下来。
//! 代价是**从上线那天起累积**（历史不可重建），这一条在界面上如实写出。
//!
//! ── 到期那一列怎么办（同样是不编数据）──────────────────────
//! 上游不提供**逐包到期**（那是 WorkBuddy 系才有的 `expireAt`）。所以：
//!   · 有逐包到期的家（WorkBuddy）：`packages[].expireAt` 是真值，直接展示；
//!   · 其余家：展示**整期到期日**（CodeArts 的 `subscription.resetDate`、
//!     Trae 的 `subscription.expireAt`）—— 那是真数据，但语义是「这一期到哪天」，
//!     不是「这笔分哪天作废」。界面上用列名与脚注把这个区别说清楚。
//!
//! ── 存储形状（对外契约，改要前后端一起改）────────────────────
//! kv 键 `creditGrants`，JSON 数组、**最新在前**、上限 [`MAX_RECORDS`]：
//! ```json
//! {
//!   "at": 1792120612673,        // 到账时刻（毫秒）
//!   "provider": "codearts",     // provider id
//!   "accountId": "hw52400462",
//!   "source": "welfare",        // welfare（福利领取）/ checkin（签到）
//!   "name": "每日登录积分",       // 活动名 / 包名 / 来源说明
//!   "amount": 100,              // 数量（拿不到则 null —— 不拿 0 冒充）
//!   "unit": "积分",
//!   "note": ""                  // 补充说明（可空）
//! }
//! ```

use serde_json::{json, Map, Value};

use crate::server::config;
use crate::server::logging;

/// kv 键名（与 `modelRules` / `checkinHistory` 同级）。
const KEY: &str = "creditGrants";

/// 记录条数上限。
///
/// 400 是按「4 个码道账号 × 每天 1 笔 + 2 个 Trae 号 × 每天 1 笔」估的（≈6 条/天）
/// ⇒ 约 **60 天**。用户要的是「每一次领取」，留一个数量级的余量即可；
/// 再大只是让 kv 里那一行 JSON 变长（每次写入都要整份重写）。
pub const MAX_RECORDS: usize = 400;

/// 一条待写入的发放记录。
pub struct Entry<'a> {
    pub provider: &'a str,
    pub account_id: &'a str,
    /// `welfare` / `checkin`
    pub source: &'a str,
    /// 活动名 / 包名 / 来源说明（空串允许 —— 界面退回显示来源）
    pub name: &'a str,
    /// 数量（拿不到传 None ⇒ 落成 null，界面显示「—」而不是编个 0）
    pub amount: Option<f64>,
    pub unit: &'a str,
    pub note: &'a str,
}

/// 追加一条发放记录。返回是否落盘成功。
///
/// 失败**只返回 false**：积分已经到账了，因为一次落盘失败就把「领取成功」
/// 报成失败是本末倒置（与 `checkin_history::record` 同一取向）。
pub fn record(entry: Entry<'_>) -> bool {
    let mut items = stored_items();
    items.insert(
        0,
        json!({
            "at": logging::now_ms(),
            "provider": entry.provider,
            "accountId": entry.account_id,
            "source": entry.source,
            "name": entry.name,
            "amount": entry.amount,
            "unit": entry.unit,
            "note": entry.note,
        }),
    );
    items.truncate(MAX_RECORDS);
    save(Value::Array(items))
}

/// 读最近记录（最新在前）。`provider` / `account_id` 为 `None` = 不过滤。
pub fn list(provider: Option<&str>, account_id: Option<&str>, limit: usize) -> Vec<Value> {
    let limit = limit.clamp(1, MAX_RECORDS);
    stored_items()
        .into_iter()
        .filter(|item| match provider {
            None => true,
            Some(want) => item.get("provider").and_then(Value::as_str) == Some(want),
        })
        .filter(|item| match account_id {
            None => true,
            Some(want) => item.get("accountId").and_then(Value::as_str) == Some(want),
        })
        .take(limit)
        .collect()
}

/// 清空（两个过滤条件都可选）。返回删掉的条数。
pub fn clear(provider: Option<&str>, account_id: Option<&str>) -> usize {
    let before = stored_items();
    let kept: Vec<Value> = before
        .iter()
        .filter(|item| {
            let provider_hit = provider.map_or(true, |want| {
                item.get("provider").and_then(Value::as_str) == Some(want)
            });
            let account_hit = account_id.map_or(true, |want| {
                item.get("accountId").and_then(Value::as_str) == Some(want)
            });
            // 保留「不命中过滤」的那些
            !(provider_hit && account_hit)
        })
        .cloned()
        .collect();
    let removed = before.len() - kept.len();
    if removed > 0 {
        save(Value::Array(kept));
    }
    removed
}

/// 读 kv 里那份数组；缺失 / 形状不对都当空列表（历史是增量数据，坏了不该带崩别的链路）。
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

/// 面板要的响应体（放在这里而不是 api 层：字段名与 `record` 的落盘形状是一份契约）。
pub fn response(provider: Option<&str>, account_id: Option<&str>, limit: usize) -> Value {
    let records = list(provider, account_id, limit);
    json!({
        "records": records,
        "max": MAX_RECORDS,
        "total": stored_items().len(),
    })
}

/// 给 `config` 的 `raw` 补一条空数组（首次运行让键存在）。
#[allow(dead_code)]
pub fn ensure_key(raw: &mut Map<String, Value>) {
    raw.entry(KEY.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
}
