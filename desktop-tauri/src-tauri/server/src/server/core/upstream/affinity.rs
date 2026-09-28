//! 会话粘性：**会话号 → 账号 id** 的短期映射。
//!
//! ── 为什么需要它 ────────────────────────────────────────────
//! 选路默认是「严格优先级主备」：优先级最高的账号吃全部流量，只有它不可用
//! （被禁用 / 对该模型限流冷却 / 在途数达上限 / 本轮已试过）才顺延下一个。
//! 那套口径对**单次请求**没问题，但对**一条会话**会出现一个副作用：
//! 同一条会话的第 1 轮落在账号 A，第 2 轮可能因为 A 临时占满而落到账号 B，
//! 第 3 轮 A 空出来了又回到 A —— 会话在账号之间来回漂。
//!
//! 漂移本身不会丢上下文（客户端每轮把完整 `messages` 带齐，见
//! `providers::codearts::chat::build_upstream_request`），但它会让
//! 「同一条会话」在不同账号的额度上各记一笔，也让排查变得难以复述。
//! 本模块把「这条会话用哪个账号」记下来，让选路优先复用同一个账号。
//!
//! ── 三条口径 ────────────────────────────────────────────────
//!   1. **粘性是偏好，不是硬绑定**：调用方每次都要重新确认那个账号此刻可用
//!      （启用 / 未限流 / 未满并发）；不可用就照常按调度口径另选一个，并改写
//!      映射。宁可换号，也不要为了「粘住」让请求排队等一个满员的账号。
//!   2. **换号就改写映射**：一次失败顺延到别的账号之后，这条会话的新家就是
//!      新账号 —— 于是「这条会话现在在谁身上」永远只有一个答案。
//!   3. **纯内存、可丢**：进程重启即清空（没有任何持久化）。它只是一层优化，
//!      丢了最坏的结果就是回到「每次重新按调度口径选」。
//!
//! ── 会话号从哪来 ────────────────────────────────────────────
//! 只认客户端入站头 `x-session-id`。这个头名不是我们发明的：CatPaw 的会话
//! 转发早就在读它（`providers::catpaw::conversation::session_id_from_headers`），
//! 归一化规则两边**必须一致**（去掉首尾空白；空值或超过 256 个字符一律当
//! 「没有会话号」—— 超长不做截断，因为截断会让两个不同的会话不稳定地碰撞）。
//! 两处各留一份实现而不是互相调用：`providers/` 不该依赖 `upstream/`
//! （分层方向是 upstream 使用 providers），所以这里与那边是**同规则的两份
//! 拷贝**，改一处必须改另一处。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use axum::http::HeaderMap;

use crate::server::logging;

/// 会话号所在的入站头（与 CatPaw 同源，见模块头）。
const SESSION_HEADER: &str = "x-session-id";

/// 会话号的长度上限：超过就当「没有会话号」（不截断，理由见模块头）。
const MAX_SESSION_ID_CHARS: usize = 256;

/// 一条映射多久没被用到就丢弃（30 分钟）。
///
/// 取值口径：远大于一次对话的轮次间隔，又远小于「额度窗口」这种量级 ——
/// 一次会话结束半小时后再来，重新按调度口径选一个账号是完全可以接受的。
const PIN_TTL_MS: i64 = 30 * 60 * 1000;

/// 最多记住多少条会话。超出时按「最久未用」丢弃，避免长时间运行后无界增长。
///
/// 一条记录只有一个短字符串 + 一个时间戳，4096 条约几百 KB 量级。
const MAX_PINS: usize = 4096;

struct Entry {
    account_id: String,
    touched_at: i64,
}

static PINS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

fn table() -> &'static Mutex<HashMap<String, Entry>> {
    PINS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取表锁；锁中毒不致命（与 `connections.rs` 的 `lock_counts` 同一策略）。
fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    match table().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 从入站头取会话号并归一化。没有（或不合规）返回 None。
pub(super) fn conversation_key(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(SESSION_HEADER)?.to_str().ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_SESSION_ID_CHARS {
        return None;
    }
    Some(trimmed.to_string())
}

/// 该会话当前固定的账号（命中会刷新活跃时间）。
///
/// 过期判定不在这里写第二遍：`sweep` 已经把过期项 retain 掉了，所以能取到
/// 的就是还没过期的。
pub(super) fn pinned(key: &str) -> Option<String> {
    let now = logging::now_ms();
    let mut guard = lock();
    // 顺手清理：读路径上做，省一个后台定时任务
    sweep(&mut guard, now);
    let entry = guard.get_mut(key)?;
    entry.touched_at = now;
    Some(entry.account_id.clone())
}

/// 把这条会话固定到该账号（换号时由调用方改写）。
pub(super) fn pin(key: &str, account_id: &str) {
    if key.is_empty() || account_id.is_empty() {
        return;
    }
    let now = logging::now_ms();
    let mut guard = lock();
    sweep(&mut guard, now);
    guard.insert(
        key.to_string(),
        Entry { account_id: account_id.to_string(), touched_at: now },
    );
}

/// 丢弃过期的；仍然超量时按最久未用丢弃，直到回到上限内。
fn sweep(table: &mut HashMap<String, Entry>, now: i64) {
    table.retain(|_, entry| now.saturating_sub(entry.touched_at) <= PIN_TTL_MS);
    if table.len() <= MAX_PINS {
        return;
    }
    let mut ages: Vec<(i64, String)> = table
        .iter()
        .map(|(key, entry)| (entry.touched_at, key.clone()))
        .collect();
    ages.sort_by(|left, right| left.0.cmp(&right.0));
    let excess = table.len() - MAX_PINS;
    for (_, key) in ages.into_iter().take(excess) {
        table.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例用不同的会话号，避免共享的进程内表互相干扰。
    #[test]
    fn a_pinned_conversation_keeps_its_account() {
        let key = "test-keeps-its-account";
        assert_eq!(None, pinned(key), "还没固定过应当是 None");
        pin(key, "account-a");
        assert_eq!(Some("account-a".to_string()), pinned(key));
        pin(key, "account-b");
        assert_eq!(Some("account-b".to_string()), pinned(key), "换号要能改写");
    }

    #[test]
    fn an_expired_pin_is_forgotten() {
        let key = "test-expired-pin";
        {
            // 直接写表：TTL 是 30 分钟，用例里没法等
            let mut guard = lock();
            guard.insert(
                key.to_string(),
                Entry {
                    account_id: "account-old".to_string(),
                    touched_at: logging::now_ms() - PIN_TTL_MS - 1,
                },
            );
        }
        assert_eq!(None, pinned(key), "过期的映射应当被丢掉");
    }

    #[test]
    fn empty_key_or_account_is_ignored() {
        pin("", "account-a");
        pin("test-empty-account", "");
        assert_eq!(None, pinned(""));
        assert_eq!(None, pinned("test-empty-account"));
    }

    #[test]
    fn the_header_is_normalized() {
        let mut headers = HeaderMap::new();
        assert_eq!(None, conversation_key(&headers), "没有头 = 没有会话号");
        headers.insert(SESSION_HEADER, "  abc  ".parse().unwrap_or_default());
        assert_eq!(Some("abc".to_string()), conversation_key(&headers), "首尾空白要去掉");
        headers.insert(SESSION_HEADER, "   ".parse().unwrap_or_default());
        assert_eq!(None, conversation_key(&headers), "全空白 = 没有会话号");
        let too_long = "x".repeat(MAX_SESSION_ID_CHARS + 1);
        headers.insert(SESSION_HEADER, too_long.parse().unwrap_or_default());
        assert_eq!(None, conversation_key(&headers), "超长不截断，直接丢弃");
        let at_limit = "x".repeat(MAX_SESSION_ID_CHARS);
        headers.insert(SESSION_HEADER, at_limit.parse().unwrap_or_default());
        assert!(conversation_key(&headers).is_some(), "正好到上限是合法的");
    }
}
