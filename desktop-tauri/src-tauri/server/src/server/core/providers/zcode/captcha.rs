//! 活动套餐通道的**人机验证令牌池**（阿里云无痕验证 proof，由界面铸造、网关消费）。
//!
//! ── 为什么需要它（实测结论，2026-09-28）────────────────────────
//! `POST {zcode}/api/v1/zcode-plan/anthropic/v1/messages` 这道门有**两道锁**：
//!
//!   1. 少 `X-Aliyun-Captcha-Verify-Param` → `400 {"code":3007,"msg":"captcha verify failed"}`；
//!   2. 令牌对但请求体里没有官方身份提示词块 → `405 {"code":3012,...}`（见 `plan.rs`）。
//!
//! 而活动额度（限时体验套餐）**只**从这条路花得出去：同样一个账号，拿套餐 JWT 打
//! 开放平台的 `/api/anthropic` 或 `/api/coding/paas/v4` 一律回「无可用资源包」，
//! 打 `api.z.ai` 是 401（社区实测，与我们的探测一致）。也就是说「1 亿 token」
//! 要用起来，就必须**每条请求附一个当次铸的验证码令牌**。
//!
//! 令牌是阿里云验证码 V3 的「无痕验证」产物（`certifyId` + `securityToken` 的
//! JWT 形态，约 280 字符）。参考实现（`Acankao/zcode-api`）用 happy-dom 在进程内
//! 跑阿里云 SDK 铸令牌；Rust 侧没有 JS/DOM 引擎，铸不出来 —— **但我们的桌面端
//! 有**：Tauri 的 WebView 就是浏览器，`ui/aliyun-captcha.js` 早已为「领套餐」加载
//! 同一套 SDK（同一个 scene/prefix）。于是分工是：
//!
//! ```text
//!   WebView（ui/zcode-captcha-pool.js）
//!       └─ SDK.instance.startTracelessVerification()   ← 静默、无需用户操作
//!              └─ POST /api/zcode/captcha {tokens:[…]}  ← 铸一个推一个（本模块的收口）
//!   Rust 转发层（plan.rs）
//!       └─ take() → X-Aliyun-Captcha-Verify-Param / -Region
//! ```
//!
//! ── 令牌的几个硬性质（都来自实测/参考实现，别当成优化去掉）────
//!   · **一次一用**：同一个令牌发第二次必回 3007（我们实测）；失败的请求同样
//!     消耗掉它（上游在鉴权前先验验证码），所以「重试」必须再取一个；
//!   · **有寿命**：参考实现按 ~95 秒 TTL 维护池子，我们取 [`TOKEN_TTL_MS`]；
//!     过期的直接丢，不试 —— 试了也是 3007，还白费一次往返；
//!   · **与账号无关**：令牌是「这台设备 + 这个场景」的产物，不绑账号，全池共用
//!     （参考实现同样是一个池子服务所有账号）；
//!   · **有风控上限**：阿里云侧对铸造频率/IP 有风控（参考实现为此做了限速与
//!     熔断）。因此铸造节奏由界面控制（库存低于目标才补），本模块只做收口与
//!     消费，不主动向任何地方要令牌。
//!
//! ── 没有令牌时怎么办（这是本模块的**边界**）──────────────────
//! 如实失败，给出可执行的提示：headless / Docker 部署没有 WebView，铸不出令牌，
//! 活动套餐通道在那里**不可用** —— 那种部署请用编码套餐通道（账号设置里的
//! 「使用套餐」切回编码套餐）。不要伪造一个令牌、也不要静默降级：上游会用
//! 3007 把请求挡回来，用户只会看到一句看不懂的英文。
//!
//! ── 硬约束 ──────────────────────────────────────────────────
//! release 是 `panic=abort`：本文件零 unwrap/expect/panic；锁中毒退化成空池。

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

/// 请求头：阿里云验证码 proof（参考实现 `RETRY_HEADERS.PARAM` 逐字相同）
pub(super) const VERIFY_PARAM_HEADER: &str = "x-aliyun-captcha-verify-param";

/// 请求头：这个 proof 属于哪个阿里云站点（`cn` / `sgp` 等）
pub(super) const VERIFY_REGION_HEADER: &str = "x-aliyun-captcha-verify-region";

/// 令牌寿命（毫秒）。参考实现按 ~95 秒维护，这里留一点余量给「铸好到发出」的
/// 窗口 —— 超过它的一律丢弃（过期令牌上游一定拒，试它只是多一次 3007）。
pub const TOKEN_TTL_MS: i64 = 120_000;

/// 池子容量上限：超过就丢**最旧**的。
///
/// 界面按「库存低于目标才补」的节奏铸造，正常不会逼近这个上限；它是防御性的
/// （界面被改坏 / 重复推送时不至于把内存撑爆）。
const POOL_MAX: usize = 500;

/// 一条令牌
struct Entry {
    param: String,
    region: String,
    /// 铸出时刻（毫秒时间戳，本地时钟）
    at: i64,
}

/// 池子 + 计数（计数只为界面/排障展示，不参与判定）
#[derive(Default)]
struct Pool {
    entries: VecDeque<Entry>,
    /// 累计入库 / 消费 / 上游拒收（3007）/ 过期丢弃
    minted: u64,
    consumed: u64,
    rejected: u64,
    stale: u64,
    /// 最近一次上游回 3007 的时刻（0 = 没有过）—— 界面据此提高补货优先级
    last_challenge_at: i64,
    /// 最近一次入库时刻
    last_mint_at: i64,
}

fn pool() -> &'static Mutex<Pool> {
    static POOL: OnceLock<Mutex<Pool>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(Pool::default()))
}

/// 入池（界面铸好一个就推一个）。返回入库后的库存数。
///
/// 空串一律拒绝：`param` 是必填的 JWT 形态串，空值入池只会让下一次请求带着一个
/// 空头出去（上游当缺失处理，回 3007，白费一次往返）。
pub fn push(param: &str, region: &str) -> usize {
    let param = param.trim();
    if param.is_empty() {
        return ready();
    }
    let now = crate::server::logging::now_ms();
    let Ok(mut pool) = pool().lock() else {
        return 0;
    };
    pool.entries.push_back(Entry {
        param: param.to_string(),
        region: region.trim().to_string(),
        at: now,
    });
    while pool.entries.len() > POOL_MAX {
        pool.entries.pop_front();
    }
    pool.minted = pool.minted.saturating_add(1);
    pool.last_mint_at = now;
    pool.entries.len()
}

/// 取一个令牌（FIFO：先铸先用，避免新令牌被旧令牌挤到过期）。
///
/// 顺手把过期条目丢掉并计数 —— 池子里躺着几十条过期令牌时，库存数会骗人
/// （界面看「还有 8 个」却连续 3007）。
pub fn take() -> Option<(String, String)> {
    let now = crate::server::logging::now_ms();
    let mut pool = pool().lock().ok()?;
    while let Some(entry) = pool.entries.pop_front() {
        if now.saturating_sub(entry.at) > TOKEN_TTL_MS {
            pool.stale = pool.stale.saturating_add(1);
            continue;
        }
        pool.consumed = pool.consumed.saturating_add(1);
        return Some((entry.param, entry.region));
    }
    None
}

/// 上游回了一次 3007（令牌被拒/过期/没用上）。
///
/// 由 `plan.rs` 的错误分类点调用：它同时是「池子里的令牌不可信了」的信号 ——
/// 界面看到这个计数就会立刻补货。
pub fn note_challenge() {
    let now = crate::server::logging::now_ms();
    if let Ok(mut pool) = pool().lock() {
        pool.rejected = pool.rejected.saturating_add(1);
        pool.last_challenge_at = now;
    }
}

/// 当前可用库存（不含过期条目）
pub fn ready() -> usize {
    let now = crate::server::logging::now_ms();
    let Ok(mut pool) = pool().lock() else {
        return 0;
    };
    while pool
        .entries
        .front()
        .is_some_and(|entry| now.saturating_sub(entry.at) > TOKEN_TTL_MS)
    {
        pool.entries.pop_front();
        pool.stale = pool.stale.saturating_add(1);
    }
    pool.entries.len()
}

/// 池子概况（管理接口 `GET /api/zcode/captcha` 的响应体）
pub fn stats() -> Value {
    let ready = ready();
    let now = crate::server::logging::now_ms();
    let Ok(pool) = pool().lock() else {
        return json!({ "ready": ready, "ttlMs": TOKEN_TTL_MS });
    };
    let oldest_age_ms = pool
        .entries
        .front()
        .map(|entry| now.saturating_sub(entry.at))
        .unwrap_or(0);
    json!({
        "ready": ready,
        "ttlMs": TOKEN_TTL_MS,
        "oldestAgeMs": oldest_age_ms,
        "minted": pool.minted,
        "consumed": pool.consumed,
        "rejected": pool.rejected,
        "stale": pool.stale,
        "lastChallengeAt": pool.last_challenge_at,
        "lastMintAt": pool.last_mint_at,
    })
}
