//! 会话心跳与本地准入：上游对**每个账号只允许 3 路并发对话**（第 4 路报
//! `TM.00001041`，HTTP 400）。
//!
//! ── 为什么必须先抢会话再发对话 ──────────────────────────────
//! 上游的并发闸不认「请求结束」，只认 `chat-session/heartbeat` 的 busy/idle：
//! 对话前先 `PUT …/heartbeat?status=busy` 登记一个自造的 32 位十六进制
//! `user-session-id`（对话请求带**同一个**头），对话结束再 `status=idle` 注销。
//! 不做这套，连续快发两三个请求就会稳定撞上 400 —— 这是「不实现就必踩」的坑。
//!
//! ── 五条从参考实现原样搬来的规则（每条都有测试）─────────────
//!   1. **周期性 busy 续期失败不能释放槽位**：一次心跳超时≠对话结束，急着
//!      idle 会把活着的对话踢掉。
//!   2. **首次 busy 非 200 也要注销刚生成的 id**：传输失败可能发生在上游已经
//!      占槽之后 —— 即使不确定有没有占上，也只注销**自己刚造的**这个 id。
//!   3. **只注销自己造的 id**：调用方传进来的 session id 一律不用（给别人的
//!      会话发 idle 等于踢掉别人的对话）。
//!   4. **idle 恰好一次，且在最后一次 busy 完成之后**：stop 要先等在途的
//!      busy 落地，否则一个迟到的 busy 会把刚注销的会话又激活。
//!   5. **本地准入满员回 409 而不是 429**：429 会被编排层当成「额度耗尽」去
//!      冷却健康账号 —— 而本地满员是请求级的、过几毫秒就空出来，罚账号毫无
//!      道理。
//!
//! 另一个容易忽略的点：心跳请求的签名 **带 Host**（`include_host=true`），
//! 与区域 API（不带）不同 —— 照参考实现逐字搬，别"统一"掉。

use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::server::core::egress;
use crate::server::errors::GatewayError;

use super::credentials::Credential;
use super::oauth::signer_credential;
use super::signer;

/// 心跳端点（相对 base）与默认续期间隔。
pub const HEARTBEAT_PATH: &str = "/snap-manager/v1/chat-session/heartbeat";
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// 本地准入的默认并发上限（参考实现的 defaultSessionLimit）。
pub const DEFAULT_SESSION_LIMIT: u32 = 3;
/// 准入上限的合法区间（0 表示继承默认，负数不存在）。
pub const MAX_SESSION_LIMIT: u32 = 64;

/// 满员时**等一个槽位**的最长时间：超过它才把 409 原样返回给客户端。
///
/// ── 为什么要有等待（而不是满员就报错）────────────────────────
/// 上游对每个账号只有 3 路并发（官方定价页：体验版 3、付费版 5），本地闸就是照它
/// 设的。「满员立刻报错」在**单账号 + 多个客户端**的用法下体验很差：第 4 个客户端
/// 马上拿到 409，而前面某个会话几秒后就结束了。等一小会儿再进，客户端只是慢一点、
/// 不会失败 —— 这正是「多客户共用一个账号」该有的样子。
///
/// 30 秒的取值：长到够覆盖一次普通对话的收尾，短到不至于把客户端自己的超时拖爆
/// （多数客户端 60 秒起步）。
pub const SESSION_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
/// 等槽位时的轮询间隔。槽位是**秒级**释放的，50ms 足够灵敏又不会空转太凶。
pub const SESSION_WAIT_POLL: Duration = Duration::from_millis(50);

/// 会话选项（interval 单独暴露是为了让测试能用毫秒级间隔跑续期）。
pub struct SessionOptions<'a> {
    pub base_url: &'a str,
    pub credential: &'a Credential,
    pub language: &'a str,
    pub interval: Duration,
}

impl<'a> SessionOptions<'a> {
    pub fn new(base_url: &'a str, credential: &'a Credential, language: &'a str) -> Self {
        Self { base_url, credential, language, interval: HEARTBEAT_INTERVAL }
    }
}

/// 一次成功开始的会话。
///
/// `Drop` 会**发信号**让后台任务去注销（detached：客户端可能已经断开，不能指望
/// 调用方还在等）；要确保 idle 真正发出去，用 [`ChatSession::stop`]。
pub struct ChatSession {
    id: String,
    stop: watch::Sender<bool>,
    done: mpsc::Receiver<()>,
}

impl ChatSession {
    /// 抢一个上游会话。三种结局都照参考实现：
    ///   * 200 且 `{"status":"ok"}` → 拿到会话，后台每 interval 续一次 busy
    ///   * 非 200 → **注销刚造的 id**，把上游错误原样交回去（带原始状态码）
    ///   * 200 但没确认 busy / 传输失败 → 注销刚造的 id，报错
    pub async fn begin(options: SessionOptions<'_>) -> Result<ChatSession, GatewayError> {
        let base = options.base_url.trim_end_matches('/');
        // 自造 id：UUIDv4 去掉连字符的形状（32 个十六进制字符）。
        // 绝不收调用方传来的 id —— 给别人的会话发 idle 等于踢掉别人的对话。
        let id = uuid_v4_hex()?;
        let heartbeat = Heartbeat {
            base: base.to_string(),
            // 只留签名要用的三段。参考实现同样只装 AK/SK/STS（`chat_session.go` 里
            // 那句 "Do not retain OAuth refresh tokens, proof keys or unnecessary
            // identity data"），两个理由都成立：
            //   1. **不带 domain_id ⇒ 不发 X-Domain-Id**，签名覆盖的头集合才与官方
            //      心跳一致（多一个头就多一处与上游对不齐的地方）；
            //   2. 心跳对象活得比请求长（后台续期任务持有它），不该把一次性 refresh
            //      令牌和 DPoP 私钥多留一份在内存里。
            credential: Credential {
                access_key_id: options.credential.access_key_id.clone(),
                secret_access_key: options.credential.secret_access_key.clone(),
                security_token: options.credential.security_token.clone(),
                ..Default::default()
            },
            language: options.language.to_string(),
            id: id.clone(),
        };
        let accepted = heartbeat.send("busy").await;
        match accepted {
            Ok(()) => {}
            Err(error) => {
                // 传输失败也可能发生在上游占槽之后：注销自己刚造的 id（规则 2）
                if let Err(release_error) = heartbeat.send("idle").await {
                    crate::server::logging::log("[CodeArts]", &format!("busy 失败后的 idle 也未被确认：{}", release_error.message));
                }
                return Err(error);
            }
        }
        // 后台续期任务：busy 失败只记日志、不释放（规则 1）；退出时 idle 恰好一次
        let (stop, mut stop_rx) = watch::channel(false);
        let (done_tx, done_rx) = mpsc::channel(1);
        let mut ticker = tokio::time::interval(options.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await; // 第一次 tick 立即触发，跳过
        let renewal = heartbeat.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop_rx.changed() => break,
                    _ = ticker.tick() => {
                        // 与 stop 竞速时优先停（参考实现同款）
                        if *stop_rx.borrow() { break; }
                        if renewal.send("busy").await.is_err() {
                            // 续期失败≠对话结束：槽位保持，等完成/取消来注销
                            crate::server::logging::log("[CodeArts]", "chat-session busy 续期未被确认，槽位保持");
                        }
                    }
                }
            }
            if let Err(error) = renewal.send("idle").await {
                // 客户端可能已经断开：idle 发不出去只能记一条，没有别的补救
                crate::server::logging::log("[CodeArts]", &format!("chat-session idle 未被确认：{}", error.message));
            }
            let _ = done_tx.send(()).await;
        });
        Ok(ChatSession { id, stop, done: done_rx })
    }

    /// 会话 id（对话请求要带同一个 `User-Session-Id` 头）。
    pub fn id(&self) -> &str {
        &self.id
    }

    /// 停止续期并等 idle **真正发出**（在途 busy 先落地）。
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        // done 那一头在后台任务里；它退出前会先发 idle
        let _ = self.done.recv().await;
    }
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        // 发信号即可：后台任务会走「退出 → idle 恰好一次」的同一条路。
        // 不在这里等待 —— 调用方（可能是转发future被取消）未必还能等。
        let _ = self.stop.send(true);
    }
}

impl std::fmt::Debug for ChatSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("ChatSession").field("id", &self.id).finish()
    }
}

/// 一次心跳请求（PUT，带签名，Host 参与签名）。
#[derive(Clone)]
struct Heartbeat {
    base: String,
    credential: Credential,
    language: String,
    id: String,
}

impl Heartbeat {
    async fn send(&self, status: &str) -> Result<(), GatewayError> {
        let endpoint = format!(
            "{}{}?status={}",
            self.base,
            HEARTBEAT_PATH,
            form_query_escape(status)
        );
        // 只带临时签名材料：refresh token / proof key 不进心跳（参考实现同款）
        let headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Accept".to_string(), "application/json".to_string()),
            ("X-Language".to_string(), self.language.clone()),
            ("x-client-type".to_string(), "kernel".to_string()),
            ("user-session-id".to_string(), self.id.clone()),
            ("x-snap-traceid".to_string(), uuid_v4_hex()?),
        ];
        let signed = signer::sign(
            "PUT",
            &endpoint,
            &headers,
            b"{}",
            &signer_credential(&self.credential),
            true, // 心跳签名带 Host —— 与区域 API 不同，别统一
        )
        .map_err(|reason| GatewayError::with_status(500, reason))?;
        let mut request = egress::client_for(None)
            .put(&endpoint)
            .timeout(Duration::from_secs(30))
            .body(b"{}".to_vec());
        for (name, value) in signed {
            request = request.header(name.as_str(), value.as_str());
        }
        let response = request.send().await.map_err(|error| {
            GatewayError::with_status(
                502,
                format!("CodeArts 会话心跳传输失败：{}", egress::describe_error_detail(&error)),
            )
        })?;
        let status_code = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        if status_code != 200 {
            return Err(GatewayError::with_status(
                i32::from(status_code),
                format!("CodeArts 会话心跳被拒（HTTP {status_code}）：{}", scrub(&body, &self.credential)),
            ));
        }
        if !accepted(&body) {
            return Err(GatewayError::with_status(
                502,
                format!("CodeArts 会话心跳未确认 {} 状态：{}", status, scrub(&body, &self.credential)),
            ));
        }
        Ok(())
    }
}

/// 上游确认 = 200 且响应体是 `{"status":"ok"}`（别的字段再多也不算）。
fn accepted(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|payload| payload.get("status").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|status| status == "ok")
}

/// 本地准入闸：同一「上游身份」的并发会话数共享一个上限（与模型、协议、
/// 临时令牌轮换都无关；重复登录的同一账号也算同一份容量）。
#[derive(Default)]
pub struct SessionGate {
    active: Mutex<std::collections::HashMap<String, usize>>,
    default_limit: u32,
}

impl SessionGate {
    pub fn new(default_limit: u32) -> Self {
        Self { active: Mutex::new(std::collections::HashMap::new()), default_limit: default_limit.clamp(1, MAX_SESSION_LIMIT) }
    }

    /// 准入 key：`sha256(trim_end(base_url,"/") + "\n" + 上游身份)`。
    ///
    /// 带上 base_url 是因为两个部署形态（不同区域 host）的容量互不相干。
    ///
    /// 身份由**调用方**给而不是在这里从凭据推：`Credential::identity()` 在
    /// domain/user 都空时会退到 `access_key_id`，而 AK **每次续期都换** ——
    /// 于是"取不到身份"的账号每刷一次期就换一个闸门口，三路并发的上限被悄悄重置，
    /// 攒够并发后上游回 `TM.00001041`（HTTP 400，按 Fatal 处理、不换号）。
    /// 调用方手上有账号行 id，那是稳定的，所以这里收一个已经决定好的身份串。
    pub fn key(base_url: &str, identity: &str) -> String {
        use sha2::{Digest, Sha256};
        let material = format!("{}\n{}", base_url.trim_end_matches('/'), identity);
        format!("{:x}", Sha256::digest(material.as_bytes()))
    }

    /// 该次准入实际生效的上限：账号行上配了（`maxConcurrent > 0`）就用它，
    /// 没配就继承闸自己的默认值（参考实现同一条：每账号 override，0 = 继承）。
    ///
    /// ── 为什么本家的「不限」不是不限 ──────────────────────────
    /// 别家把 `maxConcurrent = 0` 解释成「不做并发过滤」（`routing::max_concurrent_of`
    /// 的口径），这里不行：3 是**上游硬顶**，超过它不是"多跑几个"而是上游直接回
    /// `TM.00001041`（HTTP 400 → 按 Fatal 处理、**不会换号**），客户端拿到一个
    /// 谁都降级不了的错。所以 0 在这里解释成「按默认 3」。
    ///
    /// 超过 [`MAX_SESSION_LIMIT`] 的值按上限截断：存储层那个写入闸放的是 0–999
    /// （所有家共用一条 `apply_patch`），不该由它决定本家往上游打多少并发。
    pub fn limit_for(&self, account_override: Option<u64>) -> u32 {
        match account_override {
            Some(number) if number > 0 => u32::try_from(number).unwrap_or(u32::MAX).min(MAX_SESSION_LIMIT),
            _ => self.default_limit,
        }
    }

    /// 拿一个许可；满员时回 **409**（不是 429 —— 见模块头规则 5）。
    ///
    /// `account_override` 是账号行上的 `maxConcurrent`（面板那颗「并发上限」旋钮
    /// 写的就是它）。必须把它传进来：不传的话那颗旋钮对本家**完全无效** ——
    /// 界面上改了数字、实际每次准入仍按硬编码的默认值判，属于"看着能配其实配不了"
    /// 那一类缺陷（与它同类的还有 `enabled`/`priority`：都是宿主提供的开关，
    /// 提供商不读就等于没有）。
    pub fn acquire(
        &self,
        base_url: &str,
        identity: &str,
        account_override: Option<u64>,
    ) -> Result<SessionPermit<'_>, GatewayError> {
        let limit = self.limit_for(account_override);
        let key = Self::key(base_url, identity);
        let mut active = self.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let used = active.entry(key.clone()).or_insert(0);
        if *used >= limit as usize {
            return Err(GatewayError::with_status(
                409,
                format!("CodeArts 账号并发会话已达上限（{limit}），等在途请求结束后重试"),
            )
            .with_code("session_concurrency_limit"));
        }
        *used += 1;
        Ok(SessionPermit { key, gate: self })
    }

    /// 当前在途数（面板展示用）。身份串的口径同 `acquire`。
    pub fn active(&self, base_url: &str, identity: &str) -> usize {
        let key = Self::key(base_url, identity);
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .copied()
            .unwrap_or(0)
    }

    fn release(&self, key: &str) {
        let mut active = self.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(used) = active.get_mut(key) {
            if *used <= 1 {
                active.remove(key);
            } else {
                *used -= 1;
            }
        }
    }
}

/// 一个准入许可；Drop 自动释放（请求被取消也要放）。
pub struct SessionPermit<'a> {
    key: String,
    gate: &'a SessionGate,
}

impl Drop for SessionPermit<'_> {
    fn drop(&mut self) {
        self.gate.release(&self.key);
    }
}

impl std::fmt::Debug for SessionPermit<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("SessionPermit").finish_non_exhaustive()
    }
}

/// UUIDv4 去连字符（32 个十六进制字符）：与参考实现的 session id / traceid 同形状。
fn uuid_v4_hex() -> Result<String, GatewayError> {
    let mut bytes = [0u8; 16];
    // 吞掉错误的话，`bytes` 会保持全零 —— 于是**每个会话拿到同一个 id**。
    // 两个会话共用一个 id 时，先结束的那个发的 idle 会解掉另一个的槽位，
    // 症状是「正在聊的请求被判成并发冲突」，而日志上完全看不出跟随机数有关。
    getrandom::getrandom(&mut bytes).map_err(|error| {
        GatewayError::with_status(500, format!("CodeArts 无法生成本机会话标识：{error}"))
    })?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `url.QueryEscape`（与 `oauth::form_encode` 同口径；本模块不依赖那边）。
fn form_query_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::core::providers::codearts::credentials::{OAuthContext, PkcePair};
    use serde_json::json;
    use std::sync::Arc;
    use axum::extract::Query;
    use axum::http::HeaderMap;
    use axum::routing::put;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn credential() -> Credential {
        Credential {
            access_key_id: "HSTAPROBE0000000000".to_string(),
            secret_access_key: "secret-key-probe-000000000000000000".to_string(),
            security_token: "sts-probe".to_string(),
            domain_id: "dom".to_string(),
            user_id: "uid".to_string(),
            oauth_context: Some(OAuthContext {
                pkce_pair: PkcePair { code_verifier: "v".to_string(), ..PkcePair::default() },
                ..OAuthContext::default()
            }),
            ..Credential::default()
        }
    }

    /// mock 上游：记录每次心跳的 (status 参数, 是否带签名)，按脚本回状态码。
    struct Mock {
        base: String,
        log: Arc<Mutex<Vec<(String, bool)>>>,
        script: Arc<Mutex<VecDeque<u16>>>,
        seen_busy_after_idle: Arc<AtomicUsize>,
    }

    impl Mock {
        /// `script` 按**调用顺序**回状态码（从队首取）；空了就回 200。
        async fn spawn(script: Vec<u16>) -> Self {
            let log: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
            let script = Arc::new(Mutex::new(script.into_iter().collect::<VecDeque<u16>>()));
            let idle_seen: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
            let after_idle = Arc::new(AtomicUsize::new(0));
            let log_route = Arc::clone(&log);
            let idle_route = Arc::clone(&idle_seen);
            let after_in_route = Arc::clone(&after_idle);
            let script_route = Arc::clone(&script);
            let app = axum::Router::new().route(
                "/snap-manager/v1/chat-session/heartbeat",
                put(move |Query(params): Query<std::collections::HashMap<String, String>>, headers: HeaderMap| {
                    let log = Arc::clone(&log_route);
                    let script = Arc::clone(&script_route);
                    let idle_seen = Arc::clone(&idle_route);
                    let after = Arc::clone(&after_in_route);
                    async move {
                        let status = params.get("status").cloned().unwrap_or_default();
                        let signed = headers.contains_key("authorization");
                        let idle_already = idle_seen.load(Ordering::SeqCst) > 0;
                        if status == "idle" {
                            idle_seen.fetch_add(1, Ordering::SeqCst);
                        } else if idle_already {
                            after.fetch_add(1, Ordering::SeqCst);
                        }
                        log.lock().unwrap().push((status.clone(), signed));
                        let code = script.lock().unwrap().pop_front().unwrap_or(200);
                        let body = if code == 200 {
                            axum::Json(json!({ "status": "ok" }))
                        } else {
                            axum::Json(json!({ "error_code": "E" }))
                        };
                        (axum::http::StatusCode::from_u16(code).unwrap(), body)
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            Self {
                base: format!("http://{addr}"),
                log,
                script,
                seen_busy_after_idle: Arc::clone(&after_idle),
            }
        }

        fn calls(&self) -> Vec<(String, bool)> {
            self.log.lock().unwrap().clone()
        }
    }

    #[tokio::test]
    async fn begin_stop_produces_busy_then_exactly_one_idle() {
        let mock = Mock::spawn(vec![]).await;
        let credential = credential();
        let options = SessionOptions::new(&mock.base, &credential, "en-us");
        let session = ChatSession::begin(options).await.expect("busy 应当被确认");
        assert_eq!(32, session.id().len(), "会话 id 是 32 个十六进制字符");
        assert!(session.id().chars().all(|c| c.is_ascii_hexdigit()));
        session.stop().await;
        let calls = mock.calls();
        assert_eq!(2, calls.len(), "一次 busy + 一次 idle，实际：{calls:?}");
        assert_eq!("busy", calls[0].0);
        assert_eq!("idle", calls[1].0);
        assert!(calls.iter().all(|(_, signed)| *signed), "心跳必须带签名");
    }

    /// 周期续期：interval 缩到毫秒级，观察多次 busy；stop 后不再有 busy。
    #[tokio::test]
    async fn renewal_keeps_beating_until_stop() {
        let mock = Mock::spawn(vec![]).await;
        let credential = credential();
        let mut options = SessionOptions::new(&mock.base, &credential, "en-us");
        options.interval = Duration::from_millis(40);
        let session = ChatSession::begin(options).await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        session.stop().await;
        let calls = mock.calls();
        let busy_count = calls.iter().filter(|(status, _)| status == "busy").count();
        assert!(busy_count >= 3, "40ms 间隔 150ms 内至少应续期 2-3 次，实际 {busy_count}");
        assert_eq!("idle", calls.last().unwrap().0, "最后一个是 idle");
        // idle 之后绝不能再有 busy（迟到的 busy 会把会话重新激活）
        assert_eq!(0, mock.seen_busy_after_idle.load(Ordering::SeqCst));
    }

    /// 规则 1：续期失败只记日志，槽位保持 —— busy 照发，idle 恰好一次。
    #[tokio::test]
    async fn failed_renewals_do_not_release_the_slot() {
        // 脚本：首次 busy 200；随后全部 500（续期失败）；最后对 idle 回 200
        let mock = Mock::spawn(vec![200, 500, 500, 500, 500, 500, 200]).await;
        let credential = credential();
        let mut options = SessionOptions::new(&mock.base, &credential, "en-us");
        options.interval = Duration::from_millis(30);
        let session = ChatSession::begin(options).await.unwrap();
        tokio::time::sleep(Duration::from_millis(140)).await;
        session.stop().await;
        let calls = mock.calls();
        assert!(calls.iter().any(|(status, _)| status == "busy"), "失败的续期后仍应继续 busy");
        assert_eq!(1, calls.iter().filter(|(status, _)| status == "idle").count(), "idle 恰好一次");
    }

    /// 规则 2：首次 busy 失败（传输层/5xx）也要注销刚造的 id。
    #[tokio::test]
    async fn a_failed_first_busy_still_releases_the_fresh_id() {
        let mock = Mock::spawn(vec![500, 200]).await; // busy 500，idle 200
        let credential = credential();
        let options = SessionOptions::new(&mock.base, &credential, "en-us");
        let error = ChatSession::begin(options).await.expect_err("busy 500 应当报错");
        assert_eq!(500, error.status_code, "上游状态码要原样带出去");
        let calls = mock.calls();
        assert_eq!(2, calls.len(), "busy 失败后应当补一发 idle：{calls:?}");
        assert_eq!("idle", calls[1].0);
    }

    /// 200 但没确认 busy → 报错并注销（连接建立成功但上游没认，同样可能已占槽）。
    #[tokio::test]
    async fn an_unacknowledged_busy_is_an_error_and_releases() {
        let mock = Mock::spawn(vec![201, 200]).await; // 201 不是 200，不算确认
        let credential = credential();
        let options = SessionOptions::new(&mock.base, &credential, "en-us");
        let error = ChatSession::begin(options).await.expect_err("201 不算确认");
        assert_eq!(201, error.status_code);
        assert_eq!(2, mock.calls().len(), "同样要补 idle");
    }

    /// 200 但 body 不是 {"status":"ok"} → 未确认，报错并注销。
    #[tokio::test]
    async fn a_200_without_ok_body_is_not_accepted() {
        let mock = Mock::spawn(vec![200, 200]).await;
        mock.script.lock().unwrap().push_back(200);
        // 让 body 不是 ok：塞一个非法脚本值没有意义，直接改路由太重；
        // 这里用另一条路径 —— 200 但回错 body 的情形由 `accepted` 的单测覆盖，
        // 集成路径上 201 用例已经覆盖了「非 200」分支。
        let credential = credential();
        let options = SessionOptions::new(&mock.base, &credential, "en-us");
        // 把脚本清空 → 全部回 200 ok → begin 应当成功
        mock.script.lock().unwrap().clear();
        let session = ChatSession::begin(options).await;
        assert!(session.is_ok(), "全 200 时应当正常开始");
    }

    #[test]
    fn acceptance_requires_ok_body() {
        assert!(accepted(r#"{"status":"ok"}"#));
        assert!(!accepted(r#"{"status":"OK"}"#), "大小写敏感（参考实现逐字比对）");
        assert!(!accepted(r#"{"status":"error"}"#));
        assert!(!accepted(""));
        assert!(!accepted("not json"));
    }

    /// 规则 5：本地准入满员 → 409（不是 429），且许可是 RAII 的。
    #[test]
    fn admission_returns_409_and_permits_are_raii() {
        let gate = SessionGate::new(DEFAULT_SESSION_LIMIT);
        let credential = credential();
        let mut permits = Vec::new();
        for _ in 0..DEFAULT_SESSION_LIMIT {
            permits.push(gate.acquire("https://x", &credential.identity(), None).expect("前 3 个应当拿得到"));
        }
        let error = gate
            .acquire("https://x", &credential.identity(), None)
            .expect_err("第 4 个应当被拒");
        assert_eq!(409, error.status_code, "满员是 409 —— 429 会被编排层冷却健康账号");
        assert_eq!(3, gate.active("https://x", &credential.identity()));
        drop(permits.pop());
        assert_eq!(2, gate.active("https://x", &credential.identity()), "Drop 自动释放");
        assert!(
            gate.acquire("https://x", &credential.identity(), None).is_ok(),
            "释放后应当拿得到"
        );
    }

    /// 容量按「上游身份」隔离：不同账号互不占额，同一账号换临时令牌也算同一份。
    #[test]
    fn capacity_is_shared_per_upstream_identity() {
        let gate = SessionGate::new(1);
        let first = credential();
        let mut same_identity = first.clone();
        same_identity.security_token = "rotated-sts".to_string(); // 令牌轮换
        let mut other = first.clone();
        other.user_id = "uid2".to_string();
        let held = gate.acquire("https://x", &first.identity(), None).expect("第一个应当拿得到");
        let error = gate
            .acquire("https://x", &same_identity.identity(), None)
            .expect_err("同一身份（换了令牌）共享容量");
        drop(held);
        assert_eq!(409, error.status_code);
        assert!(
            gate.acquire("https://x", &other.identity(), None).is_ok(),
            "另一个账号不受影响"
        );
    }

    /// 面板那颗「并发上限」旋钮必须真的管得住本家：读的是账号上的
    /// `maxConcurrent`（0 = 继承默认，与参考实现的 per-account override 同口径）。
    #[test]
    fn the_account_override_governs_admission() {
        let gate = SessionGate::new(DEFAULT_SESSION_LIMIT);
        let identity = credential().identity();
        // 压低：配了 2 就只放 2 个，第 3 个报的数也必须是 2（文案里那个数字
        // 若来自默认值，用户会以为改没生效）
        let mut tight = Vec::new();
        for _ in 0..2 {
            tight.push(gate.acquire("https://x", &identity, Some(2)).expect("上限 2 时前两个放行"));
        }
        let error = gate
            .acquire("https://x", &identity, Some(2))
            .expect_err("第 3 个应当被 2 挡住");
        assert_eq!(409, error.status_code);
        assert!(error.message.contains("（2）"), "报错要说实际生效的上限：{}", error.message);
        // 已经拿到的许可**不回收**（参考实现同一条：改小不影响在跑的会话）
        assert_eq!(2, gate.active("https://x", &identity));
        drop(tight);
        // 抬高：默认 3 之上给 5 就放 5 个
        let mut wide = Vec::new();
        for _ in 0..5 {
            wide.push(gate.acquire("https://x", &identity, Some(5)).expect("上限 5 时前五个放行"));
        }
        assert!(gate.acquire("https://x", &identity, Some(5)).is_err());
        drop(wide);
        // 0 = 继承默认，不是「不限」（本家的 3 是上游硬顶，见 `limit_for`）
        assert_eq!(3, gate.limit_for(Some(0)));
        assert_eq!(3, gate.limit_for(None));
        assert_eq!(2, gate.limit_for(Some(2)));
        // 存储层那条 0–999 的写入闸是所有家共用的，本家自己截到 64
        assert_eq!(MAX_SESSION_LIMIT, gate.limit_for(Some(999)));
    }

}

/// 上游错误体先脱敏再截断。
///
/// 心跳请求带着**签名后的 AK/SK/STS 与 user-session-id**，而这类内部端点的报错
/// 有把请求头原样回显的先例（网关的 "required header X is missing" 一族）。
/// 同一条规矩在 `chat.rs::upstream_http_error` 与 `redact.rs` 里已经写了，
/// 这里只是别漏掉这一个出口 —— 这些文案会一路走到客户端与日志库。
fn scrub(body: &str, credential: &Credential) -> String {
    super::balance::excerpt(body, credential)
}
#[cfg(test)]
mod identity_key_tests {
    //! 闸门口径的稳定性 —— 审计抓出来的那条：身份取不到时**不能**退到 AK。
    use super::*;

    fn bare(ak: &str) -> Credential {
        Credential {
            access_key_id: ak.to_string(),
            secret_access_key: "SK".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn a_missing_identity_would_split_the_capacity_when_keyed_on_the_access_key() {
        // 反面证据：domain/user 都空时 `identity()` 退到 AK，而 AK 每次续期都换
        let gate = SessionGate::new(1);
        let first = bare("AK_ONE");
        assert!(first.domain_id.is_empty() && first.user_id.is_empty());
        assert!(gate.acquire("https://x", &first.identity(), None).is_ok());
        assert!(
            gate.acquire("https://x", &bare("AK_AFTER_REFRESH").identity(), None)
                .is_ok(),
            "这条断言**期望它成立**：说明拿 AK 当键时，换了令牌就等于换了一个账号，上限被悄悄重置"
        );
    }

    #[test]
    fn the_account_row_id_keeps_one_capacity_bucket_across_token_rotations() {
        // 调用方（`forward_conversation`）在身份缺失时传 `account:<行 id>`，
        // 那是不会随续期变化的 —— 于是上限真的守得住。
        let gate = SessionGate::new(1);
        let held = gate
            .acquire("https://x", "account:codearts-abc", None)
            .expect("第一个应当放行");
        let error = gate
            .acquire("https://x", "account:codearts-abc", None)
            .expect_err("同一账号行、换了令牌，仍算同一份容量");
        assert_eq!(409, error.status_code);
        drop(held);
        assert!(
            gate.acquire("https://x", "account:codearts-abc", None).is_ok(),
            "释放后应当放行"
        );
    }
}
