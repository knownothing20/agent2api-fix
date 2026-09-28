//! 账号选路 —— 严格优先级排队（对照 Node 版 src/workbuddy-routing.mjs 全量移植）。
//!
//! 优先级是「主备序号」：优先级必须唯一（Agent2API 改造后作用域收窄为
//! **同 provider 内**，由 account-store 在写入侧保证，见其模块头），
//! 不允许多个账号并列 —— 并列会让「同级」语义失效。本模块只做**纯判定**，
//! 数据来源是账号存储的公开形态（`store.list_accounts()` 的 `accounts` 数组），
//! 字段就是 UI 上看到的那几个：`id` / `name` / `priority` / `addedAt` /
//! `enabled` / `rateLimits`。
//!
//! ── 为什么用 `serde_json::Value` 而不是强类型结构 ──────────────
//! Node 版的判据全部作用在「公开形态对象」上，而公开形态是容错的
//! （字段缺失/类型不对都不报错，按 JS 语义回落）。这里保持同一数据源与同一
//! 语义，避免为了「类型好看」把手工编辑出的脏数据在解析期整条丢掉 ——
//! 那会让选路结果与 Node 版分叉（例如某个账号因为 `priority: "abc"` 而消失）。
//!
//! ── 规则（照抄 Node 版头部注释）──────────────────────────────
//!   1. 候选 = 启用中（`enabled !== false`）且未对「该模型」处于限额冷却期的账号；
//!   2. 取候选里优先级数值最小的那个（数值小的先用）；
//!   3. 本次已尝试过的账号（429 降级）从候选中排除，避免回环；
//!   4. 全部候选都不可用时，由调用方决定是降级重试还是透传错误。
//!
//! ── 规则 1 里的「该模型」指**上游真名**，不是请求名 ─────────────
//! `rateLimits` 的键是上游实际收到并据此记额度的那个名字。映射
//! （`modelRules.mappings`）会在发送前把请求名改写成上游真名，所以判定与写入
//! 都必须用真名 —— 键怎么来见 [`cooldown_key`]，用请求名会有什么后果见那里。
//! 传进本模块各函数的 `model` 参数因此一律是**请求名**，由函数自己按账号所属
//! 的家解析成真名（[`CooldownKeys`] 负责让这次解析每家只做一次）。
//!
//! 「当前账号」不是独立的手动选择，而是本模块选路结果在「不限模型」下的那个账号
//! （account-store 的 `get_current_entry` 按同样的判据派生）。因此界面上的「当前」
//! 与转发默认使用谁始终一致；仅当账号对某具体模型限额时，该模型的请求才会临时
//! 降级到下一个候选 —— 那是按模型的一次性决策，不改写「当前账号」。

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::server::core::account_store::priority::{by_priority_order, normalize_priority};
use crate::server::core::account_store::store_util::js_truthy;

/// 「请求名 → 各家上游真名」的解析缓存：限额冷却键的解析器。
///
/// ── 为什么冷却键必须是真名而不是请求名（本模块最要紧的一条）─────
/// `rateLimits` 的键是**上游按它记额度的那个名字**。映射（`modelRules.mappings`）
/// 会在发送前把请求名改写成上游真名（`providers::catalog::wire_target_for_provider`），
/// 上游因此只认识真名：它对 `deepseek-v4.1-flash` 记额度，而 `gpt-5.6-luna`
/// 这种纯对外名上游根本没见过。拿请求名当冷却键会同时坏掉三件事：
///
///   1. **写入分裂**：同一份额度被记成 `deepseek-v4.1-flash` 与 `gpt-5.6-luna`
///      两条互不相干的冷却。2026-09 实测：同一账号上 `deepseek-v4.1-flash` /
///      `gpt-5.6-luna` / `gpt-6-astra` 三个键的 `resetAt` 完全相同（它们本就
///      是同一份额度，因为后两个都是映射到第一个的对外名），账号页却显示成
///      「3 个模型限流中」。
///   2. **判定漏命中**（最实质的伤害）：用别名请求撞限额后，冷却写在别名键上；
///      接着用真名请求时读的是真名键 —— 读不到那条冷却，于是照样选中这个已经
///      限额的账号，白撞一次 429。换号链因此反复挑到「名字不同但同一个额度」
///      的账号，看起来像「映射没生效、请求还是打到原模型」。
///   3. **清除失效**：成功时按请求名清（`provider_loop::cap_cleared`），真名键下
///      那条旧记录一直留到重置时间，账号页常驻一条点不掉的限流记录。
///
/// ── 为什么按 provider 缓存（而不是每次现算）──────────────────
/// 真名是**按家**解析的：同一个 `gpt-6-astra` 在 workbuddy 家映射到
/// `deepseek-v4.1-flash`，在 catpaw 家可能映射到别的 target。而选路要对
/// **账号列表**逐个判定，同一家往往有多个账号 —— 不缓存的话，一家有几个账号
/// 就把 `wire_target_for_provider`（内含一次 `model_rules::current()` 克隆与
/// 一轮清单扫描）跑几遍。缓存键是 provider id，规模恒等于候选家数（≤6）。
///
/// 用 `Mutex` 而不是 `RefCell`：本结构会被**异步**的选路路径持有（`select_target_account`
/// 是 async），而 `RefCell` 不是 `Sync` —— 它会让整个 handler 的 future 失去
/// `Send`，编译期直接失败（这正好也说明它跨 await 存在）。锁的临界区只有
/// 几次哈希查找，且与 `wire_target_for_provider` 的解析不重叠（解析在锁外做，
/// 结果才写回），不存在锁竞争问题。
pub struct CooldownKeys<'a> {
    /// 客户端请求名（原始形态，未解析）
    requested: &'a str,
    /// provider id → 该家收到的上游真名
    resolved: Mutex<HashMap<String, String>>,
}

impl<'a> CooldownKeys<'a> {
    pub fn new(requested: &'a str) -> Self {
        Self { requested, resolved: Mutex::new(HashMap::new()) }
    }

    /// 该家实际收到的上游模型名 —— 也就是它的冷却键。
    ///
    /// 解析不出（请求名为空 / 该家既不原生承载、也没有映射指向它）时原样返回
    /// 请求名：与转发侧 `wire_target_for_provider` 的 ④ 兜底同一口径 ——
    /// 那时发出去的就是请求名，键也该是它。
    ///
    /// 锁中毒（别的线程 panic 过）时**不做缓存**、直接现算 —— 缓存只是加速，
    /// 选路结果不该因为一个内部加速器而失败。
    pub fn for_provider(&self, provider_id: &str) -> String {
        if self.requested.is_empty() || provider_id.is_empty() {
            return self.requested.to_string();
        }
        if let Ok(cache) = self.resolved.lock() {
            if let Some(cached) = cache.get(provider_id) {
                return cached.clone();
            }
        }
        // 传 `None` 账号：`wire_target_for_provider` 当前不读它（同家多条映射
        // 由 target 的通道前缀判定，见那里的说明），而选路时账号还没被选中 ——
        // 「按账号解析」在判定阶段根本无从谈起。
        //
        // ── 自定义提供商走自己的解析（第二阶段）───────────────────
        // modelRules 的映射表不认识 custom id（添加侧按注册表校验），
        // `wire_target_for_provider` 对它只会原样返回请求名 —— 而自定义家的
        // 真名解析有自己的数据源（提供商记录上的 `mappings`，见
        // `custom_providers::wire_model_for`）。跳过这一步会让 alias 请求的
        // 冷却写在请求名上：正是本模块头描述的那类「判定漏命中、已限额账号
        // 被反复选中」的事故形态，所以这里必须按家分派。
        let wire =
            if crate::server::core::custom_providers::is_custom_provider_id(provider_id) {
                crate::server::core::providers::custom::forward::cooldown_model(
                    provider_id,
                    self.requested,
                )
            } else {
                crate::server::core::providers::catalog::wire_target_for_provider(
                    self.requested,
                    provider_id,
                    None,
                )
                .model
            };
        if let Ok(mut cache) = self.resolved.lock() {
            cache.insert(provider_id.to_string(), wire.clone());
        }
        wire
    }

    /// 某条账号记录的冷却键：按它所属的家解析（每条账号记录只属于一家）。
    pub fn for_account(&self, account: &Value) -> String {
        self.for_provider(provider_of(account))
    }
}

/// 账号对某模型是否处于限额冷却期。
///
/// 对应 Node 版 `isRateLimited(account, model, now)`：只认 `rateLimits[model].resetAt`
/// 是**未来**时间戳的情况；记录存在但已过期 = 未限额（冷却自然结束，不必清理）。
///
/// 这里的 `keys` 把请求名解析成**上游真名**再查（理由见 [`CooldownKeys`]）。
pub fn is_rate_limited(account: &Value, keys: &CooldownKeys<'_>, now: i64) -> bool {
    rate_limit_reset_at(account, keys, now) > 0
}

/// 限额恢复时间（未限额返回 0）。
///
/// Node 版口径：`Number(limit.resetAt) || 0`，只有大于 now 才返回，
/// 否则返回 0 —— 这个 0 在选路里表示「当前可用」，不是「立刻恢复」。
///
/// 冷却键按 [`CooldownKeys`] 解析（真名，不是请求名）。
pub fn rate_limit_reset_at(account: &Value, keys: &CooldownKeys<'_>, now: i64) -> i64 {
    let key = keys.for_account(account);
    let Some(limit) = account
        .get("rateLimits")
        .and_then(|limits| limits.get(key.as_str()))
    else {
        return 0;
    };
    let reset_at = limit
        .get("resetAt")
        .and_then(js_number)
        .unwrap_or(0.0);
    if reset_at > now as f64 {
        reset_at as i64
    } else {
        0
    }
}

/// 账号是否可用于转发：启用 + 未被该模型限额。
/// `reason` ∈ `Some("disabled")` | `Some("rate-limited")` | `None`（可用）。
pub fn account_usability(account: &Value, keys: &CooldownKeys<'_>, now: i64) -> AccountUsability {
    // Node: `account?.enabled === false` —— 只有显式 false 才算禁用，
    // 缺失/字符串 "false"/0 都视为启用（与 account-store 的 enabled() 同口径）
    if matches!(account.get("enabled"), Some(Value::Bool(false))) {
        return AccountUsability { usable: false, reason: Some("disabled") };
    }
    if is_rate_limited(account, keys, now) {
        return AccountUsability { usable: false, reason: Some("rate-limited") };
    }
    AccountUsability { usable: true, reason: None }
}

/// `account_usability` 的结果
#[derive(Clone, Copy, Debug)]
pub struct AccountUsability {
    pub usable: bool,
    pub reason: Option<&'static str>,
}

/// 账号记录上的并发上限（单账号**同时在途**的下游请求数）。
///
/// 「一次下游请求 = 一条连接」的计数在 `upstream::connections`（账号页「连接数」
/// 列的数据源），口径正是并发上限要限制的东西，所以这里直接读账号记录上的
/// `maxConcurrent` 与那份计数比对。记录里没有该键、或值不是数字 = 0 = **不限**
/// —— 与写入侧（`store_crud::apply_patch` 的 0）和公开形态
/// （`store_util::max_concurrent_public` 的缺省 0）三条口径一致。
pub fn max_concurrent_of(account: &Value) -> u64 {
    account
        .get("maxConcurrent")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// 按优先级挑选本次请求使用的账号。
///
/// `accounts` 为 store.listAccounts().accounts 的公开形态；
/// `exclude_ids` 是本次请求已尝试过的账号 id（429 降级用）。
/// 返回账号对象，或 None（没有可用账号）。
///
/// `keys` 是请求名到各家真名的解析器（冷却键，见 [`CooldownKeys`]）。
///
/// `counts` 是各账号**当前在途请求数**（账号 id → 数，`upstream::connections`
/// 的快照）：`maxConcurrent > 0` 且在途数已达上限的账号被跳过，请求转给
/// 其他账号。没有运行时计数可拿的调用方传**空表** = 不做并发过滤（见
/// `pick_for_model` / `describe_route_decision` 的说明）。
///
/// ── 并发上限是**软上限**（选路与 rebind 之间的微小窗口）────────
/// 两个并发请求可能在同一瞬间选中同一个账号、然后各自 +1 —— 期间谁都还
/// 读不到对方的计数。为此引入额外加锁不值得：超出的那 1-2 个请求只意味着
/// 短暂超载（请求结束计数立刻回落），而选路必须是「读一次快照、立刻决策」
/// 的廉价操作。把这个口径写明：**允许短暂超 1-2 个，不做强一致**。
///
/// 排序取首位即为唯一答案（优先级唯一由写入侧保证）；并列属手工编辑出来的
/// 异常数据，按加入时间兜底，结果依旧稳定。
pub fn pick_account_by_priority(
    accounts: &[Value],
    keys: &CooldownKeys<'_>,
    counts: &HashMap<String, usize>,
    exclude_ids: &[String],
    now: i64,
) -> Option<Value> {
    let mut candidates: Vec<Value> = accounts
        .iter()
        .filter(|account| {
            let Some(id) = account_id(account) else {
                return false;
            };
            if exclude_ids.iter().any(|excluded| excluded == id) {
                return false;
            }
            account_usability(account, keys, now).usable
                // 并发过滤放在 usability 之后：先答「这个账号让不让你用」，
                // 再答「它忙不忙」—— 禁用 / 限流的原因不变，这里只追加一条。
                && !at_concurrency_limit(account, id, counts)
        })
        .cloned()
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(compare_by_priority);
    candidates.into_iter().next()
}

/// 该账号的在途请求数是否已达并发上限（`maxConcurrent == 0` = 不限，恒 false）。
///
/// 计数缺失按 0（空闲）算：快照里只留非零项（见 `Connections::snapshot`），
/// 「缺键」与「0 个在途」是同一件事。
fn at_concurrency_limit(account: &Value, id: &str, counts: &HashMap<String, usize>) -> bool {
    let limit = max_concurrent_of(account);
    limit > 0 && counts.get(id).copied().unwrap_or(0) >= limit as usize
}

/// 该账号此刻是否**可用**：启用 + 对该模型未限流冷却 + 未达并发上限。
///
/// 与 `pick_account_by_priority` 的过滤条件逐条同源（就是那两个谓词的合取），
/// 抽出来是给「会话粘性」用的：粘性命中之后**必须再确认一次**这个账号此刻
/// 还能不能用 —— 粘性是偏好而不是硬绑定，宁可换号也不要为了粘住一个满员的
/// 账号让请求排队（见 `upstream::affinity` 的模块头）。
pub fn account_is_available(
    account: &Value,
    keys: &CooldownKeys<'_>,
    counts: &HashMap<String, usize>,
    now: i64,
) -> bool {
    let Some(id) = account_id(account) else {
        return false;
    };
    account_usability(account, keys, now).usable && !at_concurrency_limit(account, id, counts)
}

/// 一个账号的「额度读数」，供会话调度排序用。
///
/// 两个字段都可能取不到：`expires_at` 依赖上游给出套餐重置日，`available`
/// 依赖余额查询成功过。取不到时**排在能取到的之后**，而不是当成 0 ——
/// 「没读到」与「读到了 0」在排序里也必须是两件事，与余额面板的口径一致。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CreditRank {
    /// 到期/重置日（上游 `subscription.resetDate` 的 `YYYY-MM-DD`）
    pub expires_at: Option<(i32, u32, u32)>,
    /// 剩余积分
    pub available: Option<f64>,
}

impl CreditRank {
    /// 从「重置日文本 + 剩余积分」构造。认不出的日期按「没有到期日」处理。
    pub fn from_parts(reset_date: Option<&str>, available: Option<f64>) -> Self {
        Self {
            expires_at: reset_date.and_then(parse_iso_date),
            available,
        }
    }
}

/// 只认 `YYYY-MM-DD`（上游给的就是这个形态）。认不出返回 None。
fn parse_iso_date(text: &str) -> Option<(i32, u32, u32)> {
    let mut parts = text.trim().split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

/// 会话调度的排序键（**升序取第一个** = 最该用的那个）：
///
///   1. **到期早的优先**（`expires_at` 升序；取不到到期日的排最后）；
///   2. 到期日相同 → **积分多的优先**（取负值参与升序；取不到积分的排最后）；
///   3. 再相同 → **在途少的优先**（把新会话摊到空闲的账号上）；
///   4. 再相同 → 原来的优先级 / 加入时间（与 `compare_by_priority` 同口径）。
///
/// 全部判据都是确定性的：同一批账号、同一时刻，选出来的永远是同一个。
fn conversation_sort_key(
    account: &Value,
    counts: &HashMap<String, usize>,
    credit: &dyn Fn(&str) -> CreditRank,
) -> ((u8, i32, u32, u32), (u8, i64), usize, (i64, i64)) {
    let id = account_id(account).unwrap_or("");
    let rank = credit(id);
    let expiry = match rank.expires_at {
        Some((year, month, day)) => (0u8, year, month, day),
        None => (1u8, 0, 0, 0),
    };
    let credits = match rank.available {
        // 积分多的优先 ⇒ 取负值参与升序；先夹到 i64 安全区间再取整
        Some(value) if value.is_finite() => {
            (0u8, -(value.round().clamp(-9.0e15, 9.0e15) as i64))
        }
        _ => (1u8, 0),
    };
    let busy = counts.get(id).copied().unwrap_or(0);
    let priority = (
        normalize_priority(
            account.get("priority"),
            crate::server::core::account_store::priority::DEFAULT_PRIORITY,
        ),
        js_number(account.get("addedAt").unwrap_or(&Value::Null)).unwrap_or(0.0) as i64,
    );
    (expiry, credits, busy, priority)
}

/// 按**会话调度**口径挑账号：到期早 → 积分多 → 在途少 → 优先级。
///
/// 与 [`pick_account_by_priority`] 的关系：过滤条件完全相同（启用 / 该模型未
/// 限流 / 未达并发上限 / 不在 `exclude_ids` 里），只把「排序键」换掉。
/// 两个函数并存是刻意的 —— 首次选路走本函数（会话要摊开、要粘住），
/// 失败后的顺延仍走原来的优先级口径（那是「换一个试试」，不是「挑最该用的」）。
///
/// `credit` 是账号 id → 额度读数的取值器（由 `core::usage_query` 的定时快照
/// 提供）。查不到时返回默认值，于是两级额度判据同时打平、自然落到
/// 「在途少 → 优先级」，退化行为是可预期的。
///
/// ⚠️ 两级额度判据**只在候选同属一家时**参与排序：`available` 的单位各家不同、
/// 到期日目前只有码道有，跨家比较没有意义（详见函数体内那一段说明）。
pub fn pick_account_for_conversation(
    accounts: &[Value],
    keys: &CooldownKeys<'_>,
    counts: &HashMap<String, usize>,
    exclude_ids: &[String],
    now: i64,
    credit: &dyn Fn(&str) -> CreditRank,
) -> Option<Value> {
    let eligible: Vec<&Value> = accounts
        .iter()
        .filter(|account| {
            let Some(id) = account_id(account) else {
                return false;
            };
            if exclude_ids.iter().any(|excluded| excluded == id) {
                return false;
            }
            account_usability(account, keys, now).usable && !at_concurrency_limit(account, id, counts)
        })
        .collect();
    if eligible.is_empty() {
        return None;
    }
    // ── 额度两级只在**同一家内部**参与排序 ────────────────────────
    // `available` 这个字段名多家共用，但**单位与口径各不相同**（码道是积分、
    // cline 是 credits、autoclaw 是钱包余额…），而「到期日」目前只有码道产出。
    // 跨家比较会同时坏两件事：拿不同单位的数字比大小；以及「有到期日的那家」
    // 仅凭有值就排到「没到期日的那家」前面，把原来的优先级顺序压过去。
    // 所以候选跨家时把这两级让开（返回默认值 ⇒ 两级打平），退回「空闲 → 优先级」。
    let first_provider = provider_key_of(eligible[0]);
    let comparable = eligible
        .iter()
        .all(|account| provider_key_of(account) == first_provider);
    let no_credit = |_: &str| CreditRank::default();
    let credit: &dyn Fn(&str) -> CreditRank = if comparable { credit } else { &no_credit };
    eligible
        .into_iter()
        .min_by_key(|account| conversation_sort_key(account, counts, credit))
        .cloned()
}

/// 账号所属的 provider id（缺字段按默认 provider 归属，与 store 的兜底口径一致）。
fn provider_key_of(account: &Value) -> &str {
    account
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or(crate::server::core::providers::DEFAULT_PROVIDER_ID)
}

/// 按**指定模型**派生队首：候选先收窄到「清单里有这个模型的家」，再走
/// [`pick_account_by_priority`] 的常规判据（启用 + 该模型未限流 + 优先级序）。
///
/// ── 为什么要单独有这个函数（`pick_current` 不够用）──────────────
/// 账号库里的「当前账号」是**不限模型**的队首（只判启用 + 凭证），转发层却还要
/// 剔除「对该模型限流中」的账号。两者在「队首正被限流」时给出不同答案：界面标着
/// ★ 的那个账号，请求根本不会走它。账号页要回答的是「下一个请求会先用谁」，
/// 所以必须按模型派生，见 `/api/session` 的 `routedAccountId`。
///
/// ── 为什么要传 `providers` 而不是只给 model ──────────────────
/// 全局队列里四家混排，但一家只能承接**它自己清单里有的**模型（见
/// `providers::router::route_for_forward`）。少了这道收窄，一个「优先级更小、
/// 也对该模型未限流、但根本不提供该模型」的账号会被误判成队首。
/// `providers` 为空（未知模型）时不过滤 —— 宁可退回全局队首，也不给空答案。
///
/// `hasCredentials` 也算进判据：转发挑出候选后还要取到会话才用，无凭证的账号
/// 必然被跳过，前端按同一口径推算时才不会把这种账号标成 ★。
///
/// 冷却键按各家真名解析（[`CooldownKeys`]）—— 界面标的 ★ 因此与转发实际会先试
/// 的那个账号同判据：别名请求撞限额后，★ 不会再指向那个额度已耗尽的账号。
///
/// `counts` 的口径同样要对齐真实选路（并发过滤，见
/// [`pick_account_by_priority`]）：★ 推算拿得到运行时计数就传（`/api/session`
/// 从 `UpstreamService::connections()` 取），拿不到就传空表 = 并发不过滤 ——
/// 宁可 ★ 少剔一个忙账号，也不要让整条推算在缺数据时静默失效。
pub fn pick_for_model(
    accounts: &[Value],
    model: &str,
    providers: &[&str],
    counts: &HashMap<String, usize>,
    now: i64,
) -> Option<Value> {
    let candidates: Vec<Value> = accounts
        .iter()
        .filter(|account| {
            if !providers.is_empty() && !providers.iter().any(|known| *known == provider_of(account))
            {
                return false;
            }
            !matches!(account.get("hasCredentials"), Some(Value::Bool(false)))
        })
        .cloned()
        .collect();
    let keys = CooldownKeys::new(model);
    pick_account_by_priority(&candidates, &keys, counts, &[], now)
}

/// 账号记录上的 provider id（缺失按默认 provider 兜底，与 store 的
/// `StoredAccount::provider` 同口径）。
pub fn provider_of(account: &Value) -> &str {
    account
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or(crate::server::core::providers::DEFAULT_PROVIDER_ID)
}

/// 选路决策的完整快照（供日志展示与排障）：
///   `{ picked, priority, candidateCount, blocked: [{ id, name, reason }], total }`
///
/// Node 版 workbuddy-routing.mjs 同名导出 `describeRouteDecision` 的对等物：
/// 生产路径用不到（Node 同样只导出未使用，仅 smoke test 覆盖），
/// 但排障时能直接拿来比对「为什么选了 B 而不是 A」，故保留 —— 字段与 Node 逐一对齐。
#[allow(dead_code)]
pub fn describe_route_decision(
    accounts: &[Value],
    model: &str,
    exclude_ids: &[String],
    now: i64,
) -> Value {
    let keys = CooldownKeys::new(model);
    let mut blocked: Vec<Value> = Vec::new();
    let mut candidate_count = 0usize;
    for account in accounts {
        let Some(id) = account_id(account) else {
            continue;
        };
        if exclude_ids.iter().any(|excluded| excluded == id) {
            blocked.push(json!({
                "id": id,
                "name": account_name(account, id),
                "reason": "tried",
            }));
            continue;
        }
        let usability = account_usability(account, &keys, now);
        if usability.usable {
            candidate_count += 1;
        } else {
            blocked.push(json!({
                "id": id,
                "name": account_name(account, id),
                "reason": usability.reason.unwrap_or(""),
            }));
        }
    }
    // 排障快照，拿不到运行时的在途计数（它住在 UpstreamService 里），
    // 传空表 = 并发过滤不生效 —— 这里只回答「按启用/限流该选谁」。
    let picked = pick_account_by_priority(accounts, &keys, &HashMap::new(), exclude_ids, now);
    let priority = picked
        .as_ref()
        .map(|account| normalize_priority_value_of(account))
        .unwrap_or(Value::Null);
    json!({
        "picked": picked.unwrap_or(Value::Null),
        "priority": priority,
        "candidateCount": candidate_count,
        "blocked": blocked,
        "total": accounts.len(),
    })
}

/// 账号 id（非空字符串才算；对应 Node 的 `account?.id` 真值判定）
pub fn account_id(account: &Value) -> Option<&str> {
    account
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// 账号展示名：`account.name || account.id`（Node 的 blocked 列表用这个兜底）
pub fn account_name(account: &Value, id: &str) -> String {
    match account.get("name") {
        Some(value) if js_truthy(value) => match value.as_str() {
            Some(text) => text.to_string(),
            None => value.to_string(),
        },
        _ => id.to_string(),
    }
}

/// 从 store 快照 `{ currentAccountId, accounts: [...] }` 取账号数组。
/// 形状不对（手工编辑坏数据）时返回空列表 —— 与 Node 的
/// `Array.isArray(accounts) ? accounts : []` 同义。
pub fn accounts_of(snapshot: &Value) -> Vec<Value> {
    snapshot
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// 选路排序：优先级升序，同优先级按加入时间（复用 account-store 的规则实现，
/// 保证「界面排序」与「转发顺序」永远同一套判据）。
fn compare_by_priority(a: &Value, b: &Value) -> std::cmp::Ordering {
    let key = |account: &Value| {
        (
            normalize_priority(account.get("priority"), crate::server::core::account_store::priority::DEFAULT_PRIORITY),
            js_number(account.get("addedAt").unwrap_or(&Value::Null)).unwrap_or(0.0),
        )
    };
    let (a_priority, a_added) = key(a);
    let (b_priority, b_added) = key(b);
    by_priority_order((a_priority, a_added as i64), (b_priority, b_added as i64))
}

/// 公开形态里的 priority（归一后的数值）——对应 Node 在日志里打印的 `priority`。
/// 这里沿用 store 归一后的值（Rust 的公开形态一定带这个字段）。
fn normalize_priority_value_of(account: &Value) -> Value {
    Value::from(normalize_priority(
        account.get("priority"),
        crate::server::core::account_store::priority::DEFAULT_PRIORITY,
    ))
}

/// JS `Number(x)`：解析不出（NaN）时返回 None，由调用方按 `|| 0` 兜底。
fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                // JS: Number('') === 0（与 Number('abc') 的 NaN 不同）
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok().filter(|value| value.is_finite())
            }
        }
        // Boolean / null / 对象 / 数组：Number(true)=1、Number(null)=0、
        // 其余 NaN。这些取值在真实数据里不会出现，但按 JS 语义实现不费事
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

#[cfg(test)]
mod conversation_scheduling_tests {
    //! 会话调度排序键的验收：**到期早 → 积分多 → 在途少 → 优先级**。
    //!
    //! 每一条都钉一个「为什么它该赢」：只断言结果不断言理由的话，
    //! 把某一级判据写反（比如积分按升序）也照样能过。

    use super::*;

    fn account(id: &str, priority: i64) -> Value {
        account_of(id, priority, "codearts")
    }

    fn account_of(id: &str, priority: i64, provider: &str) -> Value {
        json!({ "id": id, "name": id, "priority": priority, "enabled": true, "provider": provider })
    }

    /// 固定读数表：`(账号 id, 到期日, 剩余积分)`。
    fn credit_of(table: &[(&str, Option<&str>, Option<f64>)]) -> impl Fn(&str) -> CreditRank + '_ {
        move |id: &str| {
            table
                .iter()
                .find(|(account_id, _, _)| *account_id == id)
                .map(|(_, reset, available)| CreditRank::from_parts(*reset, *available))
                .unwrap_or_default()
        }
    }

    fn pick(
        accounts: &[Value],
        counts: &HashMap<String, usize>,
        credit: &dyn Fn(&str) -> CreditRank,
    ) -> Option<String> {
        let keys = CooldownKeys::new("gpt-4o");
        pick_account_for_conversation(accounts, &keys, counts, &[], 0, credit)
            .and_then(|account| account_id(&account).map(str::to_string))
    }

    #[test]
    fn the_earlier_reset_date_wins() {
        let accounts = vec![account("a", 100), account("b", 101)];
        let credit = credit_of(&[
            ("a", Some("2026-12-01"), Some(1000.0)),
            ("b", Some("2026-10-29"), Some(1000.0)),
        ]);
        assert_eq!(
            Some("b".to_string()),
            pick(&accounts, &HashMap::new(), &credit),
            "b 先到期，哪怕它优先级更靠后也该先用它"
        );
    }

    #[test]
    fn the_bigger_credit_wins_when_the_dates_tie() {
        let accounts = vec![account("a", 100), account("b", 101)];
        let credit = credit_of(&[
            ("a", Some("2026-10-29"), Some(500.0)),
            ("b", Some("2026-10-29"), Some(11000.0)),
        ]);
        assert_eq!(
            Some("b".to_string()),
            pick(&accounts, &HashMap::new(), &credit),
            "到期日相同 ⇒ 积分多的先消耗"
        );
    }

    #[test]
    fn the_idler_account_wins_when_the_credits_tie() {
        let accounts = vec![account("a", 100), account("b", 101)];
        let credit = credit_of(&[]);
        let mut counts = HashMap::new();
        counts.insert("a".to_string(), 2usize);
        counts.insert("b".to_string(), 0usize);
        assert_eq!(
            Some("b".to_string()),
            pick(&accounts, &counts, &credit),
            "额度读数打平 ⇒ 挑在途少的，把新会话摊开"
        );
    }

    #[test]
    fn priority_is_the_last_tie_breaker() {
        let accounts = vec![account("a", 101), account("b", 100)];
        let credit = credit_of(&[]);
        assert_eq!(
            Some("b".to_string()),
            pick(&accounts, &HashMap::new(), &credit),
            "全打平时回到原来的优先级口径"
        );
    }

    #[test]
    fn an_account_without_credit_readings_sorts_last() {
        let accounts = vec![account("a", 100), account("b", 101)];
        let credit = credit_of(&[("b", Some("2026-10-29"), Some(1.0))]);
        assert_eq!(
            Some("b".to_string()),
            pick(&accounts, &HashMap::new(), &credit),
            "「读到了额度」排在「没读到」之前（哪怕 a 的优先级更高）"
        );
    }

    #[test]
    fn a_disabled_account_is_never_picked() {
        let mut accounts = vec![account("a", 100), account("b", 101)];
        accounts[1]["enabled"] = Value::Bool(false);
        let credit = credit_of(&[
            ("a", Some("2026-12-01"), Some(1.0)),
            ("b", Some("2026-10-29"), Some(99999.0)),
        ]);
        assert_eq!(
            Some("a".to_string()),
            pick(&accounts, &HashMap::new(), &credit),
            "禁用优先于一切排序判据"
        );
    }

    #[test]
    fn a_saturated_account_is_skipped() {
        let accounts = vec![account("a", 100), account("b", 101)];
        let credit = credit_of(&[]);
        let mut counts = HashMap::new();
        counts.insert("a".to_string(), 3usize);
        let mut with_limit = accounts.clone();
        with_limit[0]["maxConcurrent"] = Value::from(3);
        assert_eq!(
            Some("b".to_string()),
            pick(&with_limit, &counts, &credit),
            "a 已达 maxConcurrent=3 ⇒ 转给 b"
        );
    }

    #[test]
    fn the_credit_levels_are_skipped_when_the_candidates_span_providers() {
        // 跨家时「到期日 / 剩余积分」不可比（字段名共用但单位不同；到期日目前
        // 只有码道产出）。若照旧参与排序，码道会仅凭「有到期日」压过优先级。
        let accounts = vec![
            account_of("a", 101, "codearts"),
            account_of("b", 100, "workbuddy"),
        ];
        let credit = credit_of(&[("a", Some("2026-10-29"), Some(11000.0))]);
        assert_eq!(
            Some("b".to_string()),
            pick(&accounts, &HashMap::new(), &credit),
            "跨家 ⇒ 退回原来的优先级口径（b 的优先级更小）"
        );
    }

    #[test]
    fn the_credit_levels_still_apply_within_one_provider() {
        let accounts = vec![
            account_of("a", 100, "codearts"),
            account_of("b", 101, "codearts"),
        ];
        let credit = credit_of(&[
            ("a", Some("2026-12-01"), Some(1000.0)),
            ("b", Some("2026-10-29"), Some(1000.0)),
        ]);
        assert_eq!(
            Some("b".to_string()),
            pick(&accounts, &HashMap::new(), &credit),
            "同一家内仍按「到期早」优先"
        );
    }

    #[test]
    fn the_reset_date_parser_only_takes_iso_dates() {
        assert_eq!(Some((2026, 10, 29)), parse_iso_date("2026-10-29"));
        assert_eq!(Some((2026, 10, 29)), parse_iso_date(" 2026-10-29 "));
        assert_eq!(None, parse_iso_date("2026/10/29"));
        assert_eq!(None, parse_iso_date("2026-13-01"), "月份越界不认");
        assert_eq!(None, parse_iso_date("2026-10-29T00:00:00Z"), "上游给的是纯日期，多一段就不认");
        assert_eq!(None, parse_iso_date(""));
    }
}
