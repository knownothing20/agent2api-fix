//! CodeArts 的 OAuth 令牌端点：授权码换凭据、refresh token 续凭据。
//!
//! 两次调用（首登与续期）打的是同一个端点、同一个 `client_id`，差别只在
//! `grant_type` 与 body 里的那几个字段；更要紧的是**两次都要出示 DPoP proof**
//! 与 PKCE verifier —— 这正是「长期那一半」（`credentials.rs` 的 `OAuthContext`）
//! 必须在手的原因。
//!
//! ── 请求形状（三条都不能省）────────────────────────────────
//!   * `Content-Type: application/x-www-form-urlencoded`，body 是表单而不是 JSON
//!   * `DPoP: <proof>`，proof 的 `htm` / `htu` 必须与本次请求逐字一致
//!   * `client_id` = `vscode-codebot`，`code_verifier` = 首次登录生成的那个
//!
//! ── 续期为什么也要 verifier ─────────────────────────────────
//! 上游把 `refresh_token` 绑在「当初那次授权的 PKCE 上下文」上（官方扩展同样
//! 把 verifier 与 DPoP 私钥一起落盘）。只带 refresh token 会被拒，所以迁移凭据
//! 时少搬一半就是死的（见 `credentials.rs` 模块头）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::server::core::egress;
use crate::server::logging;
use crate::server::core::proxies::ResolvedProxy;
use crate::server::errors::GatewayError;

use super::chat;
use super::credentials::{Credential, OAuthContext, PkcePair};
use super::dpop::DpopKey;

/// 与官方扩展一致的固定 client_id。
pub const CLIENT_ID: &str = "vscode-codebot";
/// 令牌端点与身份端点（两个地区目前共用同一套 STS 主机）。
pub const TOKEN_URL: &str = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
pub const IDENTITY_URL: &str = "https://sts.cn-north-4.myhuaweicloud.com/v5/caller-identity";
const REQUEST_TIMEOUT_MS: u64 = 30_000;

// ─── 网页登录（OAuth 授权码 + PKCE，回调落本机 loopback）────────
//
// portal 的授权页只认我们给的 **port**，回调路径由它自己拼成
// `http://127.0.0.1:<port>/oauth/callback`（参考实现额外带一个
// `auth_callback_url`，但另一个独立实现 `hitzy-codearts2api` 只用 `port` 也走得通 ——
// 所以我们两个都带，回调路由两条都注册，见 `http.rs`）。
// 参数顺序与取值逐字照抄参考实现，`authorize_url` 的测试拿它生成的金向量钉住。

/// 授权页所在站点（与 API 的 `snap-access` 不是一台）。
pub const WEB_LOGIN_BASE: &str = "https://codearts.huaweicloud.com";
/// portal 固定回到的路径（我们不能改，改了就 404 在它自己的站上）。
pub const CALLBACK_PATH: &str = "/oauth/callback";
/// portal 只认这一种 challenge 方法名（**不是** OAuth 标准的 `S256`）。
pub const PKCE_METHOD: &str = "SHA-256";
/// 一轮登录的有效期：超时后待办条目作废。
///
/// 参考实现是 300 秒，这里给 600：**这一家要人在浏览器里登完华为云账号**
/// （可能还要过二次验证 / 选账号），五分钟对「点开就自动回跳」够用，对真人不够。
/// 超时的代价只是重新点一次，不超时的代价是「码回来了但轮次已经没了」——
/// 那种失败用户只看得到一句「账号没出现」，最难查。
pub const LOGIN_TIMEOUT_MS: u64 = 10 * 60 * 1000;

/// 令牌端点的响应包（`credentials` 是嵌套的一段，别拉平了读）。
#[derive(Debug, Default)]
struct TokenResponse {
    access_key_id: String,
    secret_access_key: String,
    security_token: String,
    expiration: String,
    refresh_token: String,
}

/// 用授权码换凭据（网页登录的最后一步）。
pub async fn exchange_authorization_code(
    code: &str,
    redirect_uri: &str,
    context: &OAuthContext,
    proxy: Option<&ResolvedProxy>,
) -> Result<Credential, GatewayError> {
    let form = vec![
        ("client_id".to_string(), CLIENT_ID.to_string()),
        ("code".to_string(), code.trim().to_string()),
        ("code_verifier".to_string(), verifier(context)?),
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("redirect_uri".to_string(), redirect_uri.to_string()),
    ];
    token_request(form, context, "", proxy).await
}

/// 用 refresh token 换一套新的临时 AK/SK/STS。
///
/// 上游**可能轮换 refresh token**（响应里给了就用新的，没给就沿用旧的）；
/// 由于同一个 refresh token 只能换一次，这条路径必须由调用方保证单飞
/// （`refresh.rs` 用进程级单飞表，与 qoder 同一套原语）。
pub async fn refresh_credential(
    existing: &Credential,
    proxy: Option<&ResolvedProxy>,
) -> Result<Credential, GatewayError> {
    let context = existing
        .oauth_context
        .as_ref()
        .ok_or_else(|| GatewayError::with_status(400, "CodeArts 凭据缺少 OAuth 上下文（PKCE/DPoP），请重新登录"))?;
    if existing.refresh_token.trim().is_empty() {
        return Err(GatewayError::with_status(400, "CodeArts 凭据没有 refresh token，请重新登录"));
    }
    let form = vec![
        ("client_id".to_string(), CLIENT_ID.to_string()),
        ("code_verifier".to_string(), verifier(context)?),
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), existing.refresh_token.trim().to_string()),
    ];
    let mut fresh = token_request(form, context, existing.refresh_token.trim(), proxy).await?;
    // 续期响应不带身份信息（只有短期材料），所以身份从旧凭据继承下来，
    // 否则账号会在每次刷新后"失去"domain/user，同账号判定与单飞 key 全乱
    fresh.domain_id = first_non_empty(&[&fresh.domain_id, &existing.domain_id]);
    fresh.user_id = first_non_empty(&[&fresh.user_id, &existing.user_id]);
    fresh.user_name = first_non_empty(&[&fresh.user_name, &existing.user_name]);
    fresh.login_type = first_non_empty(&[&fresh.login_type, &existing.login_type, "WEB"]);
    // 授权到期线同理：新 token 声明了 exp 就用新的（token_request 里已填）；
    // 没声明（非 JWT）则继承旧值 —— 「续期不凭空延长授权线」，有新声明才动。
    if fresh.auth_expires_at == 0 {
        fresh.auth_expires_at = existing.auth_expires_at;
    }
    Ok(fresh)
}

/// 打一次令牌端点并按上游回复组装凭据（两个 grant 共用）。
async fn token_request(
    form: Vec<(String, String)>,
    context: &OAuthContext,
    previous_refresh_token: &str,
    proxy: Option<&ResolvedProxy>,
) -> Result<Credential, GatewayError> {
    let key = DpopKey::from_key_pair(&context.dpop_key_pair)
        .map_err(|reason| GatewayError::with_status(400, reason))?;
    let proof = key
        .proof("POST", TOKEN_URL, crate::server::logging::now_ms())
        .map_err(|reason| GatewayError::with_status(500, reason))?;
    let body = form
        .iter()
        .map(|(name, value)| format!("{}={}", form_encode(name), form_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let response = egress::client_for(proxy)
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .header("DPoP", proof)
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .body(body)
        .send()
        .await
        .map_err(|error| {
            GatewayError::with_status(
                502,
                format!("CodeArts 令牌请求失败：{}", egress::describe_error_detail(&error)),
            )
        })?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        // 上游的错误体可能很长（HTML），截断后原样带上，便于排障
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|payload| {
                payload
                    .get("error_description")
                    .or_else(|| payload.get("error"))
                    .or_else(|| payload.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| truncate(&text, 300));
        // 错误体里可能回显我们发过去的东西 —— 这个端点的表单里躺着 **refresh_token**
        // 与 PKCE verifier，而它们都不在 `Credential` 之外可得的清单里，所以用
        // `redact_values` 把「这次真的发出去的值」逐个盖掉。
        // 这条消息有三条出路：日志（会进 SQLite）、面板、以及登录失败时浏览器上那一页。
        let mut secrets: Vec<String> = form.iter().map(|(_, value)| value.clone()).collect();
        secrets.extend(super::redact::secret_material(context));
        let detail = super::redact::redact_values(&detail, &secrets, false);
        return Err(GatewayError::with_status(
            // 4xx 是上游对**这次请求/这份凭据**的明确答复，原样透出（刷新令牌被拒
            // 就是 400 `STS5.1806`，重试它没有意义）；5xx 与网络类的才归 502。
            if (400..500).contains(&status) { i32::from(status) } else { 502 },
            format!("CodeArts 令牌请求被拒（HTTP {status}）：{detail}"),
        ));
    }
    let parsed = parse_token_response(&text)?;
    if !parsed.valid() || parsed.security_token.is_empty() {
        return Err(GatewayError::with_status(502, "CodeArts 令牌响应缺少 access_key_id / secret_access_key / security_token"));
    }
    // 没有 refresh token 的凭据**收下来就是死路一条**：一小时后到期，届时既刷不回
    // 也解释不了为什么。参考实现同样在这里拒（`cred.RefreshToken == ""` 直接失败）。
    // 唯一合法拿不到它的通道是 ticket 那条，而它走的是 `parse_ticket_credential`，
    // 不经过这里 —— 所以这条不会误伤。
    if parsed.refresh_token.is_empty() {
        return Err(GatewayError::with_status(502, "CodeArts 令牌响应没有 refresh token，该凭据无法续期，拒绝收下（请重新登录）"));
    }
    let mut credential = Credential {
        access_key_id: parsed.access_key_id,
        secret_access_key: parsed.secret_access_key,
        security_token: parsed.security_token,
        expires_at: parsed.expiration,
        refresh_token: first_non_empty(&[&parsed.refresh_token, previous_refresh_token]),
        oauth_context: Some(context.clone()),
        login_type: "WEB".to_string(),
        ..Credential::default()
    };
    // 授权到期线：refresh token 的 JWT 里声明了 exp（首登与续期都走这里）。
    // 轮换出的新 token 声明了就跟着走 —— 那是上游亲口说的到期时刻；
    // 解析不出（非 JWT / 无 exp）由 refresh_credential 兜底继承旧值。
    let declared_exp = refresh_exp_ms(&credential.refresh_token);
    if declared_exp > 0 {
        credential.auth_expires_at = declared_exp;
    }
    // 身份优先从 refresh token 的 JWT 载荷里解 —— 比多打一次 caller-identity 便宜；
    // 解不出来再问身份端点（续期响应本来就不带身份，所以这条兜底很常用）
    match identity_from_refresh_token(&credential.refresh_token) {
        Some((domain, user, name)) => {
            credential.domain_id = domain;
            credential.user_id = user;
            credential.user_name = name;
        }
        None => {
            if let Some((domain, user, name)) = fetch_identity(&credential, proxy).await? {
                credential.domain_id = domain;
                credential.user_id = user;
                credential.user_name = name;
            }
        }
    }
    Ok(credential)
}

/// 上游把凭据放在 `credentials` 这一段里，字段名是 snake_case。
fn parse_token_response(text: &str) -> Result<TokenResponse, GatewayError> {
    let payload: Value = serde_json::from_str(text)
        .map_err(|error| GatewayError::with_status(502, format!("CodeArts 令牌响应不是合法 JSON：{error}")))?;
    let credentials = payload.get("credentials").cloned().unwrap_or(Value::Null);
    let read = |name: &str| {
        credentials
            .get(name)
            .or_else(|| payload.get(name))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    };
    Ok(TokenResponse {
        access_key_id: read("access_key_id"),
        secret_access_key: read("secret_access_key"),
        security_token: read("security_token"),
        expiration: read("expiration"),
        refresh_token: read("refresh_token"),
    })
}

impl TokenResponse {
    fn valid(&self) -> bool {
        !self.access_key_id.is_empty() && !self.secret_access_key.is_empty()
    }
}

/// refresh token（JWT）的 `exp` claim → 毫秒 epoch（解析不出返回 0）。
///
/// **不验签**：这里只是读它声明的时间用于面板展示，真伪由使用时的成败裁决。
/// 实测 claim 形态：`exp`/`iat` 是秒级 Unix 时间（还带 `counter`/`family_id`，
/// 即轮换族）。这条线就是「授权会话到期、须重新登录」的展示依据。
fn refresh_exp_ms(refresh_token: &str) -> i64 {
    let Some(payload) = refresh_token.split('.').nth(1) else { return 0 };
    let Some(decoded) = decode_base64url(payload) else { return 0 };
    let Ok(claims) = serde_json::from_slice::<Value>(&decoded) else { return 0 };
    claims
        .get("exp")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds * 1000)
        .unwrap_or(0)
}

/// 从 refresh token 的 JWT 载荷里取身份：`user_profile` 段又是一个 base64url 的
/// JSON。这是上游把身份**藏在令牌里**的设计，解出来就省一次网络往返。
fn identity_from_refresh_token(refresh_token: &str) -> Option<(String, String, String)> {
    let payload = refresh_token.split('.').nth(1)?;
    let decoded = decode_base64url(payload)?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    let profile = claims.get("user_profile").and_then(Value::as_str)?;
    let decoded = decode_base64url(profile)?;
    let identity: Value = serde_json::from_slice(&decoded).ok()?;
    let account_id = identity.get("account_id").and_then(Value::as_str).unwrap_or("").trim();
    let principal_id = identity.get("principal_id").and_then(Value::as_str).unwrap_or("").trim();
    let urn = identity.get("principal_urn").and_then(Value::as_str).unwrap_or("").trim();
    if account_id.is_empty() || principal_id.is_empty() || urn.is_empty() {
        return None;
    }
    // URN 的末段才是给人看的名字（`…:user/GT-gitcode337577`）
    let name = urn.rsplit([':', '/']).next().unwrap_or(urn).to_string();
    Some((account_id.to_string(), principal_id.to_string(), name))
}

/// 问身份端点（需要签名，用的是刚拿到的那套临时凭据）。
async fn fetch_identity(
    credential: &Credential,
    proxy: Option<&ResolvedProxy>,
) -> Result<Option<(String, String, String)>, GatewayError> {
    let headers = vec![
        ("Accept".to_string(), "application/json".to_string()),
        ("Content-Type".to_string(), "application/json".to_string()),
    ];
    let signed = super::signer::sign("GET", IDENTITY_URL, &headers, b"", &signer_credential(credential), false)
        .map_err(|reason| GatewayError::with_status(500, reason))?;
    let mut request = egress::client_for(proxy)
        .get(IDENTITY_URL)
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS));
    for (name, value) in signed {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request.send().await.map_err(|error| {
        GatewayError::with_status(
            502,
            format!("CodeArts 身份查询失败：{}", egress::describe_error_detail(&error)),
        )
    })?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        // 身份拿不到不是致命：账号还能转发，只是面板上没名字
        crate::server::logging::log("[CodeArts]", &format!("身份查询失败（HTTP {status}），账号仍可用，只是面板上没有名字"));
        return Ok(None);
    }
    let identity: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let account_id = identity.get("account_id").and_then(Value::as_str).unwrap_or("").trim();
    let principal_id = identity.get("principal_id").and_then(Value::as_str).unwrap_or("").trim();
    let urn = identity.get("principal_urn").and_then(Value::as_str).unwrap_or("").trim();
    if account_id.is_empty() || principal_id.is_empty() {
        return Ok(None);
    }
    let name = urn.rsplit([':', '/']).next().unwrap_or(urn).to_string();
    Ok(Some((account_id.to_string(), principal_id.to_string(), name)))
}

/// 签名器只认它的三个字段，这里做个适配（避免签名模块反过来依赖凭据模块）。
pub(crate) fn signer_credential(credential: &Credential) -> super::signer::Credential {
    super::signer::Credential {
        access_key_id: credential.access_key_id.clone(),
        secret_access_key: credential.secret_access_key.clone(),
        security_token: credential.security_token.clone(),
        domain_id: credential.domain_id.clone(),
    }
}

fn verifier(context: &OAuthContext) -> Result<String, GatewayError> {
    let verifier = context.pkce_pair.code_verifier.trim();
    if verifier.is_empty() {
        return Err(GatewayError::with_status(400, "CodeArts 凭据缺少 PKCE verifier，无法续期，请重新登录"));
    }
    Ok(verifier.to_string())
}

fn first_non_empty(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// 表单字段编码：与 `url.Values.Encode()` 同口径（空格编码成 `+`，
/// 其余非未保留字符按 `%XX` 大写十六进制）。
fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => {
                out.push('%');
                out.push_str(&format!("{other:02X}"));
            }
        }
    }
    out
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('='))
        .ok()
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.trim().to_string();
    }
    text.chars().take(limit).collect::<String>() + "…"
}

/// 发起一次网页登录所需的那一整套长期材料（PKCE + DPoP）。
///
/// 两样都必须与最终落盘的凭据一起保存：授权码换出来的 refresh_token 与**签发时那把
/// DPoP 公钥绑定**（换一把去刷新会被 STS 判 `InvalidDPoPHeader`），而续期又要出示
/// 当初的 PKCE verifier。所以「登录上下文」不是一次性的临时变量，而是凭据的一半。
pub fn new_login_context() -> Result<OAuthContext, String> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|error| format!("随机数不可用：{error}"))?;
    // 43 字符的 base64url（无填充）= 32 字节，正好落在 RFC 7636 的 43–128 区间
    let code_verifier = URL_SAFE_NO_PAD.encode(seed);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    Ok(OAuthContext {
        pkce_pair: PkcePair {
            code_verifier,
            code_challenge: challenge,
            code_challenge_method: PKCE_METHOD.to_string(),
        },
        dpop_key_pair: super::dpop::DpopKey::generate()?,
    })
}

/// 进行中的一轮登录。
#[derive(Clone, Debug)]
pub struct PendingLogin {
    /// 我们生成的轮次标识 —— **同时充当登录任务的 state**（portal 回调里能带回来时
    /// 就直接按它配对，带不回来时退化成「逐个候选试」，见 `candidates`）。
    pub ticket_id: String,
    pub context: OAuthContext,
    /// 交给 portal 的那个回调地址，换码时要**逐字**作为 `redirect_uri` 回带
    /// （STS 比对 redirect_uri，差一个斜杠就拒）。
    pub callback_url: String,
    /// portal 首次回调下发的 secret（只有 ticket 轮询通道用得上）。
    pub secret: String,
    pub started_at_ms: i64,
    /// 这一轮是否已经有人认领了后台轮询。**每轮最多一个轮询循环**：
    /// `/oauth/callback` 是免鉴权路由，没有这个标记时，攻击者反复打
    /// `?secret=<每次换一个值>` 就能凭空造出 N 个各跑 10 分钟的循环
    /// （每个都在真打上游），把一次登录窗口变成免费的压力放大器。
    pub poll_claimed: bool,
}

/// 进程级待办表。
///
/// ── 为什么要一张表，而 CPA 是「一轮一个 listener」──────────────
/// CPA 是插件，每轮登录自己起一个 loopback 端口，回调天然按端口归属。本网关只有
/// **一个**监听端口，回调路径又是 portal 自己拼的（`http://127.0.0.1:<port>/oauth/callback`，
/// 见 `authorize_url` 的说明：我们只能给 `port`，路径它固定），所以同一端口上
/// 多轮登录必须靠表来分。上限 8 与 CPA 同值：每轮都占一份 5 分钟的待办，
/// 不设限会让「发起了没做完」把表撑满。
fn pending_table() -> &'static Mutex<HashMap<String, PendingLogin>> {
    static TABLE: OnceLock<Mutex<HashMap<String, PendingLogin>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

const MAX_PENDING_LOGINS: usize = 8;

/// 本进程的回调端口（`ServerState::bootstrap` 写一次）。
///
/// 与 accio 各自持有一份而不是共用：那家的地址由 `set_loopback_port` 的调用点决定，
/// 两家对「回调落在哪个端口」的取值口径将来若分叉（例如分端口部署只给某一家开），
/// 各自一份能各自改，共用会变成「改一处影响两家」。
static LOOPBACK_PORT: OnceLock<u16> = OnceLock::new();

pub fn set_loopback_port(port: u16) {
    let _ = LOOPBACK_PORT.set(port);
}

/// 回调地址（端口还没定就返回 None —— 上层文案负责说清为什么）。
pub fn loopback_base() -> Option<String> {
    LOOPBACK_PORT.get().map(|port| format!("http://127.0.0.1:{port}"))
}

/// 发起一轮登录：生成上下文与 ticket，登记待办，返回 `(授权地址, 待办条目)`。
///
/// `ticket_id` 同时充当登录任务的 **state**：任务表与待办表用同一个键，回调无论
/// 带不带配对信息，收尾那条路都能只认这一个值。
pub fn begin_login(plugin_name: &str, plugin_version: &str, language: &str) -> Result<(String, PendingLogin), String> {
    let port = LOOPBACK_PORT.get().copied().ok_or("网关还在启动中，回调端口尚未确定，请稍后重试")?;
    let context = new_login_context()?;
    let mut seed = [0u8; 16];
    getrandom::getrandom(&mut seed).map_err(|error| format!("随机数不可用：{error}"))?;
    let ticket_id = seed.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let callback_url = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let pending = PendingLogin {
        started_at_ms: logging::now_ms(),
        ticket_id,
        context,
        callback_url,
        secret: String::new(),
        poll_claimed: false,
    };
    let url = authorize_url(
        WEB_LOGIN_BASE,
        &pending.ticket_id,
        &pending.context.pkce_pair,
        &pending.callback_url,
        plugin_name,
        plugin_version,
        language,
    );
    let mut table = pending_table().lock().unwrap_or_else(|error| error.into_inner());
    table.retain(|_, item| item.started_at_ms + LOGIN_TIMEOUT_MS as i64 > logging::now_ms());
    if table.len() >= MAX_PENDING_LOGINS {
        // 挤掉最旧的一轮（保住用户刚点的这一次），与参考实现的 `evictLoginSessionsLocked` 同策略
        let oldest = table.iter().min_by_key(|(_, item)| item.started_at_ms).map(|(key, _)| key.clone());
        if let Some(key) = oldest {
            table.remove(&key);
        }
    }
    table.insert(pending.ticket_id.clone(), pending.clone());
    Ok((url, pending))
}

/// 授权页地址。
///
/// 参数**顺序**与百分号编码都照参考实现：`encodeURIComponent` 的未保留集比 RFC 3986
/// 少四个字符（`!'()*` 不转义），换一种编码器生成的地址在 portal 那边仍然能用，
/// 但金向量就对不上了 —— 而这条地址是给人看的、也是 portal 校验的输入，
/// 与参考实现逐字一致才有「上游会接受」的证据（向量见 `login_url_vectors.json`）。
///
/// `port` 是从 `callback_url` 里**读**出来的（参考实现同样如此：portal 只认 port，
/// 路径它自己拼），所以两者不可能被调用方各写一份而对不上。
pub fn authorize_url(
    base: &str,
    ticket_id: &str,
    pkce: &PkcePair,
    callback_url: &str,
    plugin_name: &str,
    plugin_version: &str,
    language: &str,
) -> String {
    let locale = if language.trim().to_ascii_lowercase().starts_with("zh") { "zh-cn" } else { "en" };
    let pairs = [
        ("theme", "2".to_string()),
        ("locale", locale.to_string()),
        ("uri_scheme", CLIENT_ID.to_string()),
        ("client_id", CLIENT_ID.to_string()),
        ("port", url_port(callback_url)),
        ("code_challenge", pkce.code_challenge.clone()),
        ("code_challenge_method", pkce.code_challenge_method.clone()),
        ("ticket_id", ticket_id.to_string()),
        ("auth_callback_url", callback_url.to_string()),
        ("plugin-name", plugin_name.to_string()),
        ("plugin-version", plugin_version.to_string()),
    ];
    let query = pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", super::signer::encode_component(value.as_bytes())))
        .collect::<Vec<_>>()
        .join("&");
    // 尾部斜杠要吃掉：配置里写成 `https://x/` 就会拼出 `//portal/authorize`
    let trimmed = base.trim_end_matches('/');
    format!("{trimmed}/portal/authorize?{query}")
}

/// 从回调地址里取端口（没有端口就回空串，与 Go `url.Port()` 一致）。
fn url_port(callback_url: &str) -> String {
    let without_scheme = callback_url.split_once("://").map(|(_, rest)| rest).unwrap_or(callback_url);
    let authority = without_scheme.split(['/', '?', '#']).next().unwrap_or("");
    authority.rsplit_once(':').map(|(_, port)| port.to_string()).unwrap_or_default()
}

/// portal 首次回调下发 secret：换进对应那一轮（ticket 轮询通道要用**它给的**那个，
/// 不是我们自己生成的 —— 用错了会一直 401，且没有任何提示）。
pub fn attach_ticket_secret(ticket_id: &str, secret: &str) -> bool {
    let mut table = pending_table().lock().unwrap_or_else(|error| error.into_inner());
    match table.get_mut(ticket_id) {
        Some(item) if !secret.trim().is_empty() => {
            item.secret = secret.trim().to_string();
            true
        }
        _ => false,
    }
}

/// 取走一轮（授权码换码与 ticket 轮询都是**一次性**的，取走即从表里消失）。
pub fn take_pending(ticket_id: &str) -> Option<PendingLogin> {
    pending_table().lock().unwrap_or_else(|error| error.into_inner()).remove(ticket_id)
}

/// 认领这一轮的后台轮询。返回 false 表示已经有人在轮了（或这一轮没了）。
pub fn claim_ticket_poll(ticket_id: &str) -> bool {
    let mut table = pending_table().lock().unwrap_or_else(|error| error.into_inner());
    match table.get_mut(ticket_id) {
        Some(item) if item.poll_claimed => false,
        Some(item) => {
            item.poll_claimed = true;
            true
        }
        None => false,
    }
}

/// 只读一份（ticket 轮询要用：换成功才取走，失败时这一轮还得留在表里）。
pub fn peek_pending(ticket_id: &str) -> Option<PendingLogin> {
    pending_table().lock().unwrap_or_else(|error| error.into_inner()).get(ticket_id).cloned()
}

/// 放弃一轮（取消登录时调用，免得表里留占位）。
pub fn drop_pending(ticket_id: &str) {
    pending_table().lock().unwrap_or_else(|error| error.into_inner()).remove(ticket_id);
}

/// 逐个候选（新→旧）。
///
/// portal 的回调**实测可能只带一个 `code`、不带任何配对信息**（另一个实现
/// `hitzy-codearts2api` 的注释原话），所以只能试。用错的 verifier 会被 STS 判
/// `STS5.1805` 而**不消耗授权码**（同一处注释），因此逐个试是安全的；试到通过为止。
pub fn candidates() -> Vec<PendingLogin> {
    let now = logging::now_ms();
    let mut table = pending_table().lock().unwrap_or_else(|error| error.into_inner());
    table.retain(|_, item| item.started_at_ms + LOGIN_TIMEOUT_MS as i64 > now);
    let mut items: Vec<PendingLogin> = table.values().cloned().collect();
    items.sort_by(|left, right| right.started_at_ms.cmp(&left.started_at_ms));
    items
}

/// 用授权码换凭据（`redirect_uri` 必须与交给 portal 的那份逐字相同）。
pub async fn exchange_for(pending: &PendingLogin, code: &str, proxy: Option<&ResolvedProxy>) -> Result<Credential, GatewayError> {
    exchange_authorization_code(code, &pending.callback_url, &pending.context, proxy).await
}

/// ticket 轮询通道：portal 只把 secret 送到本机回调、授权码始终没送到时用它。
///
/// 这条通道**不签名**（ticket/secret 本身就是凭据），响应里也**没有 refresh token** ——
/// 所以经它落账的账号约一小时后就刷不回来，只能重新登录。调用方要把这件事告诉用户，
/// 别让人以为账号是长期的。
pub async fn poll_ticket(base: &str, pending: &PendingLogin, proxy: Option<&ResolvedProxy>) -> Result<Credential, GatewayError> {
    if pending.secret.trim().is_empty() {
        return Err(GatewayError::with_status(400, "这一轮登录还没有拿到 portal 下发的 secret，无法用 ticket 通道换取凭证"));
    }
    let endpoint = format!(
        "{}/snap-manager/v1/login/ticket?ticket_id={}&secret={}",
        base.trim_end_matches('/'),
        form_encode(&pending.ticket_id),
        form_encode(&pending.secret)
    );
    let headers = vec![
        ("Content-Type".to_string(), "application/json;charset=UTF-8".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
        ("plugin-name".to_string(), chat::DEFAULT_PLUGIN_NAME.to_string()),
        ("plugin-version".to_string(), chat::DEFAULT_PLUGIN_VERSION.to_string()),
    ];
    let mut request = egress::client_for(proxy).get(&endpoint).timeout(Duration::from_millis(REQUEST_TIMEOUT_MS));
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request.send().await.map_err(|error| {
        GatewayError::with_status(
            502,
            // 传输错误的文本里带着**完整 URL**，而这条 URL 的查询串就是 ticket_id + secret
            format!("CodeArts ticket 通道请求失败：{}", scrub_ticket(&egress::describe_error_detail(&error), pending)),
        )
    })?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        // ticket 还没就绪是常态（portal 那边用户还没点完），文案要能区分「再等等」与「坏了」
        return Err(GatewayError::with_status(
            if status == 404 { 408 } else { i32::from(status) },
            format!("CodeArts ticket 通道返回 {status}：{}", truncate(&text, 200)),
        ));
    }
    parse_ticket_credential(&text)
}

/// 把 ticket 通道的两个敏感量从任意文本里盖掉（secret 是 portal 下发的领取凭据，
/// 泄漏等于把这一轮登录交给看到日志的人）。
fn scrub_ticket(text: &str, pending: &PendingLogin) -> String {
    let mut out = text.to_string();
    if !pending.secret.is_empty() {
        out = out.replace(&pending.secret, super::redact::REDACTED);
    }
    out
}

/// ticket 通道的响应形状（与令牌端点**不同**：字段名是 `access`/`secret`/`securitytoken`，
/// 身份信息在外层，且没有 refresh token）。
pub(crate) fn parse_ticket_credential(text: &str) -> Result<Credential, GatewayError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|error| GatewayError::with_status(502, format!("CodeArts ticket 响应不是合法 JSON：{error}")))?;
    let read = |object: &Value, key: &str| object.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let inner = value.get("credential").cloned().unwrap_or(Value::Null);
    let credential = Credential {
        access_key_id: read(&inner, "access"),
        secret_access_key: read(&inner, "secret"),
        security_token: read(&inner, "securitytoken"),
        expires_at: read(&inner, "expires_at"),
        domain_id: read(&value, "domain_id"),
        user_id: read(&value, "user_id"),
        user_name: read(&value, "user_name"),
        login_type: first_non_empty(&[&read(&value, "login_type"), "WEB"]),
        // 故意留空：这条通道不给 refresh token，账号到期后必须重新登录（见 `poll_ticket`）
        refresh_token: String::new(),
        oauth_context: None,
    };
    if !credential.valid() || credential.security_token.trim().is_empty() {
        return Err(GatewayError::with_status(502, "CodeArts ticket 响应里的临时凭据不完整"));
    }
    Ok(credential)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::core::providers::codearts::credentials::{DpopKeyPair as Pair, Jwk as KeyJwk, PkcePair as Pkce};
    use serde_json::json;

    /// 授权地址与参考实现**逐字节**对账（向量由 `login_url_vectors_gen_test.go`
    /// 在参考实现里跑出来，覆盖：中英文 locale、`!'()*` 不转义、`/` 要转义、
    /// 回调地址带查询串时端口怎么取、自定义授权站点尾部斜杠）。
    #[test]
    fn authorize_url_matches_reference_vectors() {
        let parsed: Value =
            serde_json::from_str(include_str!("login_url_vectors.json")).expect("向量文件要是合法 JSON");
        let vectors = parsed.as_array().expect("向量是一份数组");
        assert!(!vectors.is_empty());
        for vector in vectors {
            let read = |key: &str| vector[key].as_str().unwrap_or_default().to_string();
            let built = authorize_url(
                &read("web_login_base"),
                &read("ticket_id"),
                &PkcePair {
                    code_verifier: "verifier-not-in-url".to_string(),
                    code_challenge: read("code_challenge"),
                    code_challenge_method: read("code_challenge_method"),
                },
                &read("callback_url"),
                &read("plugin_name"),
                &read("plugin_version"),
                &read("language"),
            );
            assert_eq!(read("want"), built, "向量 {} 对不上", read("name"));
        }
    }

    /// portal 的回调路径与端口是从地址里读的，不是调用方另写一份。
    #[test]
    fn port_comes_out_of_the_callback_url() {
        assert_eq!("40605", url_port("http://127.0.0.1:40605/oauth/callback"));
        assert_eq!("3065", url_port("http://127.0.0.1:3065/oauth/callback?a=b&c=d"));
        assert_eq!("", url_port("http://127.0.0.1/oauth/callback"), "没写端口就是空串（Go 的 URL.Port()）");
    }

    #[test]
    fn form_encoding_matches_go_url_values() {
        assert_eq!("a+b", form_encode("a b"), "空格编成 +（表单口径，不是 %20）");
        assert_eq!("a%2Bb", form_encode("a+b"), "+ 自身要编码");
        assert_eq!("a%2Fb", form_encode("a/b"));
        assert_eq!("GT-gitcode337577", form_encode("GT-gitcode337577"), "未保留字符不动");
        assert_eq!("%E4%B8%AD", form_encode("中"), "非 ASCII 按字节大写十六进制");
    }

    #[test]
    fn token_response_reads_the_nested_credentials_block() {
        let text = json!({
            "credentials": {
                "access_key_id": "AK",
                "secret_access_key": "SK",
                "security_token": "sts",
                "expiration": "2026-09-27T16:17:00.327Z"
            },
            "refresh_token": "jwt"
        })
        .to_string();
        let parsed = parse_token_response(&text).unwrap();
        assert!(parsed.valid());
        assert_eq!("sts", parsed.security_token);
        assert_eq!("2026-09-27T16:17:00.327Z", parsed.expiration);
        assert_eq!("jwt", parsed.refresh_token);
    }

    /// `user_profile` 是**再一层** base64url JSON —— 身份就在这里，解出来能省一次
    /// 网络往返；这条测试用的是按该结构手搓的令牌。
    #[test]
    fn identity_is_read_from_the_refresh_token_payload() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        let profile = json!({
            "account_id": "9e5d1997c2e74fd0a06577be357d3d4c",
            "principal_id": "052ec0e2ab0b4d7596a1b1f0e6c9a111",
            "principal_urn": "iam::domain:user/GT-gitcode337577"
        })
        .to_string();
        let claims = json!({ "user_profile": URL_SAFE_NO_PAD.encode(profile.as_bytes()) }).to_string();
        let token = format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}"),
            URL_SAFE_NO_PAD.encode(claims.as_bytes()),
            URL_SAFE_NO_PAD.encode(b"sig")
        );
        let (domain, user, name) = identity_from_refresh_token(&token).expect("应当能解出身份");
        assert_eq!("9e5d1997c2e74fd0a06577be357d3d4c", domain);
        assert_eq!("052ec0e2ab0b4d7596a1b1f0e6c9a111", user);
        assert_eq!("GT-gitcode337577", name, "名字取 URN 末段");
    }

    #[test]
    fn identity_decoding_is_lenient_about_garbage() {
        // 不是 JWT / 载荷不是 JSON / 没有 user_profile / 身份不全 → 一律 None，
        // 由调用方决定要不要去问身份端点（绝不能因此 panic 或当成账号无效）
        assert!(identity_from_refresh_token("not-a-jwt").is_none());
        assert!(identity_from_refresh_token("a.b").is_none());
        assert!(identity_from_refresh_token("a.@@@.c").is_none());
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        let empty = json!({}).to_string();
        let token = format!("x.{}.y", URL_SAFE_NO_PAD.encode(empty.as_bytes()));
        assert!(identity_from_refresh_token(&token).is_none());
    }

    #[test]
    fn refresh_without_context_is_rejected_locally() {
        // 本地就该拦住，不要拿着半份凭据去打上游
        let bare = Credential {
            access_key_id: "AK".to_string(),
            secret_access_key: "SK".to_string(),
            refresh_token: "jwt".to_string(),
            ..Credential::default()
        };
        assert!(!bare.can_refresh(), "没有 oauth_context 就刷不了");
    }

    /// 打一次**真** STS，只验「请求形状对不对」：用一份现造的 DPoP 密钥 +
    /// 一个**编造的 refresh token**，看上游怎么答。
    ///
    /// 默认不跑（`#[ignore]`），要手工开：
    /// ```bash
    /// cargo test -p agent2api-server codearts -- --ignored --nocapture
    /// ```
    ///
    /// 期望结论（2026-09-26 实测）：**HTTP 400 `STS5.1806` `invalid refresh token:
    /// 'decode jwt header failed'`** —— 上游收下了表单与 `DPoP` 头，一路走到校验
    /// 令牌那一步才发现这串是编的。这就是「请求形状对了、只是没有真凭据」的证据，
    /// 用它验证移植，就不必为了证明形状正确去烧一份真凭据。
    /// **它一个真凭据都不碰**：密钥现生成、令牌是编造的。
    #[tokio::test]
    #[ignore]
    async fn live_token_endpoint_rejects_the_request_not_our_shape() {
        let mut secret = [0u8; 32];
        getrandom::getrandom(&mut secret).expect("随机源不可用");
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        let context = OAuthContext {
            pkce_pair: Pkce {
                code_verifier: "probe-verifier-not-a-real-one".to_string(),
                code_challenge_method: "SHA-256".to_string(),
                ..Default::default()
            },
            dpop_key_pair: Pair {
                private_key_jwk: KeyJwk {
                    kty: "EC".to_string(),
                    crv: "P-256".to_string(),
                    d: URL_SAFE_NO_PAD.encode(secret),
                    ..Default::default()
                },
                ..Default::default()
            },
        };
        let credential = Credential {
            refresh_token: "probe-not-a-real-refresh-token".to_string(),
            oauth_context: Some(context),
            ..Credential::default()
        };
        // 这份密钥要用两次：一次经 refresh_credential，一次直接进三点阶梯
        let key = DpopKey::from_key_pair(&credential.oauth_context.as_ref().unwrap().dpop_key_pair).unwrap();
        let result = refresh_credential(&credential, None).await;
        match result {
            Ok(_) => panic!("编造的刷新令牌居然换到了凭据？"),
            Err(error) => {
                println!("HTTP {} {}", error.status_code, error.message);
                assert_eq!(400, error.status_code, "编造的刷新令牌应当是 400（不是 401/502）");
                assert!(
                    error.message.contains("STS5.1806"),
                    "期望上游给出 STS5.1806（刷新令牌被拒），拿到：{}",
                    error.message
                );
                // 关键：理由必须是「令牌有问题」，不能是「DPoP 头不合法」或
                // 「请求体缺字段」—— 后者才说明我们的请求形状没搭对
                let message = error.message.to_lowercase();
                assert!(message.contains("refresh token"), "上游该抱怨的是令牌本身：{}", error.message);
                assert!(
                    !message.contains("invalid_dpop") && !message.contains("invalid dpop proof"),
                    "上游在抱怨 DPoP 头的构造，说明 proof 有问题：{}",
                    error.message
                );
            }
        }

        // ── 三点阶梯：证明 proof 是**被结构校验通过**的，而不只是"有这一项" ──
        // 固定用同一份现造密钥，只换 DPoP 头的形态，看上游的拒绝理由怎么变：
        //   ① 不给        → APIGW.0106 `Invalid header parameter: DPoP, required`
        //   ② 给一串垃圾  → STS5.1804 `invalid DPoP proof: 'decode header failed'`
        //   ③ 给我们的    → STS5.1806 `invalid refresh token: 'decode jwt header failed'`
        // ③ 比 ② 往后走了一整步（头解开了 → 开始验令牌），说明 ES256/JWK/JWS 这三层
        // 都被上游收下了。这条阶梯只在 `--ignored` 下跑，一次真凭据都不碰。
        async fn ladder(label: &str, proof: Option<String>) -> (u16, String) {
            let mut request = crate::server::core::egress::client_for(None)
                .post(TOKEN_URL)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Accept", "application/json")
                .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS));
            if let Some(proof) = proof {
                request = request.header("DPoP", proof);
            }
            let response = request
                .body("client_id=vscode-codebot&code_verifier=probe&grant_type=refresh_token&refresh_token=probe")
                .send()
                .await
                .expect("阶梯请求发不出去");
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            println!("[{label}] HTTP {status} {text}");
            (status, text)
        }
        let (_, without) = ladder("① 无 DPoP 头", None).await;
        let (_, garbage) = ladder("② 垃圾 DPoP 头", Some("not.a.jwt".to_string())).await;
        let (_, ours) = ladder(
            "③ 我们的 proof",
            Some(key.proof("POST", TOKEN_URL, crate::server::logging::now_ms()).unwrap()),
        )
        .await;
        assert!(without.contains("APIGW.0106"), "① 应当是因为缺 DPoP 头而被拒：{without}");
        assert!(garbage.contains("STS5.1804"), "② 垃圾头应当是「DPoP proof 解不开」：{garbage}");
        assert!(ours.contains("STS5.1806"), "③ 我们的 proof 应当被收下、只卡在令牌上：{ours}");
    }
}
