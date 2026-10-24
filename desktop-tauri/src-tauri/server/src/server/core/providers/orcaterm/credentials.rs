//! OrcaTerm 凭证：解析 / 本机登录态读取 / 续期（单飞）/ 从账号记录取快照。
//!
//! ── 凭证形态（2026-10-16 桌面客户端 1.6.4 实测）────────────────
//! 微信 OAuth 登录后客户端持有一枚 HS256 JWT（`oauth_access_token`，约
//! **2 小时**时效），payload 里有 `userId`（数字 uid，CGI 的 `uin` 参数）、
//! `provider`（`wechat`）、`iat` / `exp`。网关**只解 payload、不验签**
//! （与 raccoon 同一口径：token 好不好用由上游说了算）。
//!
//! ── 本机登录态（`importDesktop: true`）──────────────────────
//! 客户端是 Tauri 应用，登录态在
//! `%APPDATA%\com.orcaterm-desktop.app\data.bin`（Tauri store，**明文 JSON**，
//! 无加密），直接读 `oauth_access_token` / `oauth_expires_at` /
//! `auth_identity` 即可 —— 与 CatPaw 的 `auth.json` 同性质（复制值进账号
//! 记录，不长期盯着那个文件）。
//!
//! ── 续期（上游有真续期接口，与 KukuAI / CatPaw 的关键差别）────
//! `POST {CGI}/cgi/api?action=OAuthRefreshToken&uin=<userId>`，
//! body `{"action":"OAuthRefreshToken","data":{"accessToken":<旧 JWT>}}`
//! → `data.Response.AccessToken`（新 JWT，实测从旧 token 直接换新，
//! 2026-10-16 实测通过）。因此 `supports_refresh = true`：临期主动刷 +
//! 401 强制刷，结果回写账号记录（**不回写 data.bin**，见 `mod.rs`）。
//! 并发刷新走 `refresh_flight` 单飞表（与 raccoon / autoclaw 同一原语）。
//!
//! ── 硬约束 ──────────────────────────────────────────────────
//! release 是 `panic=abort`：本文件零 unwrap/expect/panic；
//! 任何 async fn 内不持有非 Send 的守卫（单飞表 / 无锁跨 await）。

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{Value, json};

use crate::server::core::account_store::AccountStore;
use crate::server::core::providers::refresh_flight;
use crate::server::errors::GatewayError;
use crate::server::logging;

use super::http::post_json_value;
use super::{CGI_BASE, DESKTOP_DATA_FILE, USER_AGENT};

/// 临期窗口（10 分钟；JWT 实测 2 小时时效，留足一次对话的余量）
const EXPIRY_WINDOW_MS: i64 = 10 * 60_000;

/// 登录态文件的大小上限（data.bin 正常约 1.5 KB；超限视为异常文件）
const MAX_DATA_FILE_SIZE: u64 = 256 * 1024;

/// 一条 OrcaTerm 登录态。
#[derive(Clone, Debug)]
pub struct OrcatermCredentials {
    /// OAuth access token（HS256 JWT，Bearer 头本体）。
    ///
    /// **控制台态**（浏览器 uin/skey）下为空串 —— 两种形态互斥，
    /// 判据见 [`Self::is_console`]。
    pub access_token: String,
    /// 控制台态：`skey`（腾讯云登录密钥，随登录态失效，数小时级）。
    pub skey: Option<String>,
    /// 控制台态：**原样重放的整段 Cookie**（`uin=…; skey=…; userId=…`）。
    ///
    /// 为什么存整串而不是只存 uin/skey：真实浏览器流量里还带着
    /// `userAccountType` / `userAccountLoginMethod` / `refreshSession` 等，
    /// 上游按整串校验（orcaterm2api 实测「保真重放」可用）；我们只解析出
    /// 判据需要的那几个键，发送时把原串照发。
    pub raw_cookie: Option<String>,
    /// JWT `exp`（秒；解析不出给 0 —— 按「判不出」处理，见 `is_expiring`）
    pub expires_at: i64,
    /// 数字用户 id（JWT `userId` / CGI 的 `uin` 参数；解析不出留空）
    pub user_id: String,
    /// 展示名（`auth_identity.nickName` / `GetUserInfo`，best-effort）
    pub nickname: String,
}

impl OrcatermCredentials {
    /// 控制台态（浏览器 `uin`+`skey`，没有 JWT）。
    ///
    /// 两态互斥：有 `ot_session` 就走 Bearer（桌面态），没有才看 skey。
    pub fn is_console(&self) -> bool {
        self.access_token.is_empty()
            && self
                .skey
                .as_deref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
    }

    /// 控制台态要重放的 Cookie 串：优先原串，缺了才用 uin/skey 拼。
    fn console_cookie(&self) -> String {
        if let Some(raw) = self.raw_cookie.as_deref() {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        let mut parts = vec![
            format!("uin={}", self.user_id),
            format!("skey={}", self.skey.clone().unwrap_or_default()),
        ];
        if !self.user_id.is_empty() {
            parts.push(format!("userId={}", self.user_id));
        }
        parts.join("; ")
    }

    /// JWT 是否已过期或临期（`exp` 判不出 → false，宁可漏刷不凭猜测打上游）。
    ///
    /// 控制台态恒 false：`skey` 不是 JWT、没有 `exp`，上游也没有续期接口
    ///（失效形态是 `NEED_UIN_AND_SKEY` / `VERIFY_SKEY_UIN_FAILED`）。
    pub fn is_expiring(&self) -> bool {
        if self.is_console() {
            return false;
        }
        if self.expires_at <= 0 {
            return false;
        }
        let now = crate::server::logging::now_ms() / 1000;
        self.expires_at - now < EXPIRY_WINDOW_MS / 1000
    }

    /// 脱敏尾段（展示用；与各家 `tokenTail` 同一口径）
    pub fn token_tail(&self) -> String {
        // 控制台态没有 JWT，展示用 skey 尾（skey 也是密钥，同样只留 8 位）
        let token = if self.is_console() {
            self.skey.as_deref().unwrap_or("")
        } else {
            self.access_token.trim()
        };
        if token.len() <= 8 {
            return String::new();
        }
        token.chars().skip(token.len() - 8).collect()
    }

    /// 账号标识首选：`orcaterm-<userId>`；userId 判不出用 token 尾兜底
    pub fn user_key(&self) -> String {
        if !self.user_id.trim().is_empty() {
            format!("orcaterm-{}", self.user_id.trim())
        } else {
            format!("orcaterm-{}", self.token_tail())
        }
    }
}

/// 归一化一个粘贴/读取到的 token 字符串：剥 `Bearer ` / `ot_session=` 前缀
/// 与首尾空白（前端用户可能整行复制 `Authorization: Bearer …` 或 Cookie 片段）。
pub fn normalize_token(raw: &str) -> String {
    let mut token = raw.trim().to_string();
    // ── 整段 Cookie（2026-10-24 加）──────────────────────────────
    // 用户从 DevTools 里复制 `document.cookie` 得到的是
    // `uin=…; skey=…; ot_session=eyJ…; userId=…` 这种整串 —— 让他自己在一长串里
    // 挑出 `ot_session` 那一段，少复制一个字符 JWT 就废了。这里直接按分号切、
    // 取出 `ot_session` 的值。判据用「含分号」：JWT 本身是 base64url 三段点分，
    // 不可能出现分号，所以不会误伤裸 token。
    if token.contains(';') {
        for part in token.split(';') {
            let part = part.trim();
            if let Some(rest) = part.strip_prefix("ot_session=") {
                token = rest.trim().to_string();
                break;
            }
        }
    }
    if let Some(rest) = token.strip_prefix("ot_session=") {
        token = rest.trim().to_string();
    }
    if let Some(rest) = token.strip_prefix("Bearer ").or_else(|| token.strip_prefix("bearer ")) {
        token = rest.trim().to_string();
    }
    token
}

/// 解码 JWT 的 payload 段（base64url → JSON；失败返回 None，绝不 panic）。
fn decode_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    if payload.is_empty() {
        return None;
    }
    let mut base64 = payload.replace('-', "+").replace('_', "/");
    while base64.len() % 4 != 0 {
        base64.push('=');
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).ok()?;
    let claims = serde_json::from_slice::<Value>(&bytes).ok()?;
    claims.is_object().then_some(claims)
}

/// 从 JWT 里解出（userId, exp 秒）；解不出的字段留空 / 0。
fn claims_of(token: &str) -> (String, i64) {
    let Some(claims) = decode_jwt_claims(token) else {
        return (String::new(), 0);
    };
    let user_id = claims
        .get("userId")
        .map(|value| match value {
            Value::Number(number) => number.to_string(),
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let exp = claims.get("exp").and_then(Value::as_i64).unwrap_or(0);
    (user_id, exp)
}

/// 从 payload 解析凭证（添加账号的「粘贴」入口）。
///
/// 支持三种形态：
///   1. **裸 token / 整行**（`Bearer …` / `ot_session=…` 自动剥）；
///   2. **data.bin 的 JSON 对象**（含 `oauth_access_token` 字段）；
///   3. **嵌套 `{accessToken: "…"}`**（与其它家粘贴表单同键名）。
/// 一段 Cookie 的解析结果（只取判据需要的键，原串单独留着用于重放）。
struct ParsedCookie {
    ot: Option<String>,
    uin: Option<String>,
    skey: Option<String>,
    user_id: Option<String>,
    raw: String,
}

/// 分号切分 `k=v`，按名取值；空白归一后保留原串（供控制台态保真重放）。
fn parse_cookie(raw: &str) -> ParsedCookie {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut parsed = ParsedCookie {
        ot: None,
        uin: None,
        skey: None,
        user_id: None,
        raw: normalized.clone(),
    };
    for part in normalized.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "ot_session" => parsed.ot = Some(value.to_string()),
            "uin" => parsed.uin = Some(value.to_string()),
            "skey" => parsed.skey = Some(value.to_string()),
            "userId" => parsed.user_id = Some(value.to_string()),
            _ => {}
        }
    }
    parsed
}

/// 从 payload 解析凭证（添加账号的「粘贴」入口）。
///
/// 支持两种凭证形态（2026-10-24 起）：
///   · **桌面态**：`ot_session` JWT（裸 token / `Bearer …` / 整段 Cookie 里的
///     `ot_session=` / data.bin JSON）—— 走 `Authorization: Bearer`；
///   · **控制台态**：浏览器 `document.cookie` 整串（含 `uin` + `skey`）——
///     没有 `ot_session` 时走 cookie 重放（Web 版 Origin/Referer/Sec-Fetch）。
///
/// 判据顺序：先 `ot_session`，没有才看 `uin`+`skey`（与 orcaterm2api 的
/// `Credential.Kind()` 同序）。两者都没有 → 报「不是有效凭证」。
pub fn credentials_from_payload(payload: &Value) -> Result<OrcatermCredentials, String> {
    let raw = match payload {
        Value::String(text) => text.clone(),
        Value::Object(object) => ["accessToken", "token", "oauth_access_token", "cookie"]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_default(),
        _ => String::new(),
    };
    let raw = raw.trim().to_string();
    if raw.is_empty() {
        return Err(
            "缺少凭证：粘贴 OrcaTerm 的 accessToken（JWT），或浏览器里的整段 document.cookie"
                .to_string(),
        );
    }
    let parsed = parse_cookie(&raw);

    // ① 桌面态：ot_session（或裸 JWT）
    let token = parsed.ot.clone().or_else(|| {
        // 裸 token：不含 `=`、三段点分
        if !raw.contains('=') && raw.split('.').count() == 3 {
            Some(normalize_token(&raw))
        } else {
            None
        }
    });
    if let Some(token) = token {
        if token.split('.').count() != 3 {
            return Err("这不是一个有效的 OrcaTerm accessToken（JWT 应为三段点分）".to_string());
        }
        let (user_id, expires_at) = claims_of(&token);
        return Ok(OrcatermCredentials {
            access_token: token,
            expires_at,
            skey: None,
            raw_cookie: None,
            user_id,
            nickname: String::new(),
        });
    }

    // ② 控制台态：uin + skey（浏览器 document.cookie）
    match (parsed.uin.clone(), parsed.skey.clone()) {
        (Some(uin), Some(skey)) if !uin.is_empty() && !skey.is_empty() => Ok(OrcatermCredentials {
            access_token: String::new(),
            // 控制台态没有 exp：上游也没有续期接口，失效形态是 NEED_UIN_AND_SKEY
            expires_at: 0,
            skey: Some(skey),
            raw_cookie: Some(parsed.raw.clone()),
            // userId 优先；没有再退回 uin（CGI 的 uin 参数两者都认）
            user_id: parsed
                .user_id
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or(uin),
            nickname: String::new(),
        }),
        _ => Err(
            "这段 Cookie 里既没有 ot_session（桌面态），也没有 uin + skey（控制台态）。\
             请确认复制的是 orcaterm.cloud.tencent.com 页面里登录后的 document.cookie。"
                .to_string(),
        ),
    }
}

// ─── 本机登录态（importDesktop）────────────────────────────────

/// 桌面端 data.bin 的候选路径（`%APPDATA%\com.orcaterm-desktop.app\data.bin`，
/// 外加 `ORCATERM_DATA_FILE` 环境变量直指）。
fn data_file_candidates() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(value) = std::env::var_os("ORCATERM_DATA_FILE") {
        dirs.push(PathBuf::from(value));
    }
    if let Some(value) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(value).join(DESKTOP_DATA_FILE));
    }
    dirs.into_iter().filter(|path| path.is_file()).collect()
}

/// 读本机桌面客户端登录态（`importDesktop: true` 用）。
pub fn read_desktop_credentials() -> Result<OrcatermCredentials, String> {
    let path = data_file_candidates().into_iter().next().ok_or_else(|| {
        "没有找到本机 OrcaTerm 客户端的登录态（%APPDATA%\\com.orcaterm-desktop.app\\data.bin）；请先安装并登录 OrcaTerm 桌面客户端，或用「粘贴 accessToken」添加账号".to_string()
    })?;
    let meta = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("读取客户端登录态失败（{}）：{error}", path.display()))?;
    if meta.len() > MAX_DATA_FILE_SIZE {
        return Err(format!(
            "客户端登录态文件异常过大（{}，{} 字节），拒绝读取",
            path.display(),
            meta.len()
        ));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("读取客户端登录态失败（{}）：{error}", path.display()))?;
    let Ok(data) = serde_json::from_str::<Value>(&text) else {
        return Err(format!("客户端登录态文件不是有效 JSON（{}）", path.display()));
    };
    let token = normalize_token(
        data.get("oauth_access_token").and_then(Value::as_str).unwrap_or(""),
    );
    if token.is_empty() {
        return Err("本机客户端未登录（data.bin 里没有 oauth_access_token）；请先在 OrcaTerm 客户端登录".to_string());
    }
    let expires_at = data.get("oauth_expires_at").and_then(Value::as_i64).unwrap_or(0) / 1000;
    let (user_id, jwt_exp) = claims_of(&token);
    // data.bin 的 oauth_expires_at 与 JWT exp 取较新者（两者语义相同，毫秒 / 秒）
    let expires_at = if jwt_exp > 0 { jwt_exp } else { expires_at };
    // 展示名：auth_identity 是一段内嵌 JSON 字符串（`{"nickName":"…"}`）
    let nickname = data
        .get("auth_identity")
        .and_then(Value::as_str)
        .and_then(|identity| serde_json::from_str::<Value>(identity).ok())
        .and_then(|identity| identity.get("nickName").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    Ok(OrcatermCredentials { access_token: token, expires_at, skey: None, raw_cookie: None, user_id, nickname })
}

/// 本机登录态的展示摘要（前端导入预检用）。
pub fn desktop_summary() -> Result<Value, String> {
    let credentials = read_desktop_credentials()?;
    Ok(json!({
        "userId": credentials.user_id,
        "nickname": credentials.nickname,
        "tokenTail": credentials.token_tail(),
    }))
}

// ─── 上游请求头 ─────────────────────────────────────────────

/// Web 版真实 UA（控制台态用；与桌面态刻意不同 —— orcaterm2api 实测：
/// 「控制台票据 + 桌面 origin」是真实世界不存在的组合，会被上游识别）。
const WEB_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

/// 控制台态的公共头（两处 `*_headers` 共用）：
/// 不带 `Authorization`（浏览器流量没有），用 Web 版 Origin/Referer + Sec-Fetch 族。
fn console_headers(credentials: &OrcatermCredentials) -> Vec<(String, String)> {
    vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Cookie".to_string(), credentials.console_cookie()),
        ("User-Agent".to_string(), WEB_USER_AGENT.to_string()),
        ("Origin".to_string(), "https://orcaterm.cloud.tencent.com".to_string()),
        ("Referer".to_string(), "https://orcaterm.cloud.tencent.com/".to_string()),
        ("Accept-Language".to_string(), "zh-CN,zh;q=0.9".to_string()),
        ("Sec-Fetch-Site".to_string(), "same-site".to_string()),
        ("Sec-Fetch-Mode".to_string(), "cors".to_string()),
        ("Sec-Fetch-Dest".to_string(), "empty".to_string()),
    ]
}

/// CGI 网关的请求头（`Authorization: Bearer`；`uin` 在 query 上，不在头里）。
pub fn cgi_headers(credentials: &OrcatermCredentials) -> Vec<(String, String)> {
    // 控制台态：浏览器 cookie 重放（CGI 也认登录态 cookie）
    if credentials.is_console() {
        return console_headers(credentials);
    }
    vec![
        ("Authorization".to_string(), format!("Bearer {}", credentials.access_token)),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("User-Agent".to_string(), USER_AGENT.to_string()),
        ("Origin".to_string(), "https://orcaterm.cloud.tencent.com".to_string()),
        ("Referer".to_string(), "https://orcaterm.cloud.tencent.com/".to_string()),
    ]
}

/// assistant 网关的请求头（`X-Product: orcaterm` 是本家的产品标识）。
pub fn lightai_headers(credentials: &OrcatermCredentials, seq_id: &str) -> Vec<(String, String)> {
    // 控制台态：Web 版头集 + 本家产品标识（`X-Product` / `x-seqid` 两种形态都要）
    if credentials.is_console() {
        let mut headers = console_headers(credentials);
        headers.push(("X-Product".to_string(), "orcaterm".to_string()));
        headers.push(("x-seqid".to_string(), seq_id.to_string()));
        headers.push((
            "Accept".to_string(),
            "text/event-stream, application/json".to_string(),
        ));
        return headers;
    }
    vec![
        ("Authorization".to_string(), format!("Bearer {}", credentials.access_token)),
        ("X-Product".to_string(), "orcaterm".to_string()),
        ("x-seqid".to_string(), seq_id.to_string()),
        ("User-Agent".to_string(), USER_AGENT.to_string()),
        ("Origin".to_string(), "https://orcaterm.cloud.tencent.com".to_string()),
        ("Referer".to_string(), "https://orcaterm.cloud.tencent.com/".to_string()),
    ]
}

// ─── CGI 动作（探活 / 续期 / 余额共用）────────────────────────

/// 调一次 CGI 动作（`POST {CGI}/cgi/api?action=<Action>&uin=<userId>`，
/// body `{"action":"<Action>","data":{…}}`）。HTTP 恒 200，业务码在
/// `data.Response.Error` —— 这里只拆出 `data.Response`，错误判定归调用方。
pub async fn cgi_action(
    credentials: &OrcatermCredentials,
    action: &str,
    data: Value,
    proxy: Option<&crate::server::core::proxies::ResolvedProxy>,
) -> Result<Value, GatewayError> {
    let url = format!("{CGI_BASE}/cgi/api?action={action}&uin={}", credentials.user_id);
    let body = json!({ "action": action, "data": data });
    let value = post_json_value(&url, &cgi_headers(credentials), &body, proxy, None).await?;
    Ok(value
        .get("data")
        .and_then(|data| data.get("Response"))
        .cloned()
        .unwrap_or(Value::Null))
}

/// 控制台态探活：`GET {LIGHTAI}/assistant/conversation/list?offset=0&limit=1`。
///
/// ── 为什么不用 CGI 的 `GetUserInfo` ──────────────────────────
/// CGI 认的是 JWT（Bearer）或云账号 cookie，控制台态的 `uin/skey` 是否被它
/// 接受**没有依据**；而 assistant 域是对话真正要打的地方，用它的只读列表接口
/// 探活，等于「验证的就是马上要用的那条链路」（orcaterm2api 的 `Probe` 同做法）。
///
/// 失败形态：HTTP 非 2xx、或流内 `code` 非 0（`NEED_UIN_AND_SKEY` /
/// `VERIFY_SKEY_UIN_FAILED` = 登录态失效）。
pub async fn probe_console(
    credentials: &OrcatermCredentials,
    proxy: Option<&crate::server::core::proxies::ResolvedProxy>,
) -> Result<(), GatewayError> {
    let url = format!("{}/assistant/conversation/list?offset=0&limit=1", super::LIGHTAI_BASE);
    let headers = lightai_headers(credentials, "probe-console");
    let value = super::http::get_json(&url, &headers, proxy, None).await?;
    // 成功是数字 0；失败是字符串（如 "10050000"）—— 两种都按宽松口径读
    let code = value.get("code").or_else(|| value.get("Code"));
    let ok = match code {
        None => true,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0) == 0,
        Some(Value::String(text)) => text.trim().is_empty() || text.trim() == "0",
        Some(_) => false,
    };
    if !ok {
        let message = value
            .get("message")
            .or_else(|| value.get("msg"))
            .and_then(Value::as_str)
            .unwrap_or("登录态无效");
        return Err(GatewayError::with_status(
            401,
            format!("OrcaTerm 控制台登录态被上游拒绝（{message}）：请重新复制 document.cookie"),
        ));
    }
    Ok(())
}

/// `GetUserInfo`（探活 + 补身份）。返回 `(userId, nickname)`；上游业务错误
/// 原样成错误（`VERIFY_USER_FAILED` = token 无效）。
pub async fn fetch_user_info(
    credentials: &OrcatermCredentials,
    proxy: Option<&crate::server::core::proxies::ResolvedProxy>,
) -> Result<(String, String), GatewayError> {
    let response = cgi_action(credentials, "GetUserInfo", json!({}), proxy).await?;
    if let Some(error) = response.get("Error") {
        let code = error.get("Code").and_then(Value::as_str).unwrap_or("UNKNOWN");
        let message = error.get("Message").and_then(Value::as_str).unwrap_or("上游错误");
        return Err(GatewayError::with_status(
            401,
            format!("OrcaTerm 凭证被上游拒绝（{code}：{message}）"),
        ));
    }
    let user_id = response
        .get("userId")
        .map(|value| match value {
            Value::Number(number) => number.to_string(),
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_else(|| credentials.user_id.clone());
    // 展示名按「第一个非空的候选」取：上游这三段的**存在性并不稳定** ——
    // 微信登录的账号实测是 `nickName: ""` + `username: "一颗苹果"`（2026-10-16），
    // 只按 `or_else` 取键会在 nickName 为空串时停住，把昵称丢成空
    // （症状是账号名退化成 `账号 orcaterm-…`）。
    let nickname = ["nickName", "username", "displayName"]
        .iter()
        .filter_map(|key| response.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("")
        .to_string();
    Ok((user_id, nickname))
}

// ─── 续期（单飞 + 回写）──────────────────────────────────────

/// 进程级单飞表（`refresh_flight` 原语）：只保存进行中的刷新，
/// key = `{账号 id}:{旧 token 指纹}` —— 账号间不互复用，换号后等待者
/// 不会误取到另一轮的结果。
fn inflight_table() -> &'static refresh_flight::Table<OrcatermCredentials> {
    static TABLE: OnceLock<refresh_flight::Table<OrcatermCredentials>> = OnceLock::new();
    TABLE.get_or_init(refresh_flight::Table::new)
}

/// 刷新 OrcaTerm 的 JWT（单飞；成功后回写账号记录）。
///
/// `force = false` 时只在临期才刷新（`ensure_access_token` 的语义）；
/// `force = true` 时无条件刷新（401 之后的 `refresh_access_token`）。
pub async fn refresh(
    store: &AccountStore,
    credentials: &OrcatermCredentials,
    account_id: &str,
    force: bool,
) -> Result<OrcatermCredentials, GatewayError> {
    // 控制台态（uin/skey）：上游没有续期接口，原样返回。
    // 这里**不能报错** —— 调用方（chat::run_chat）拿到 Err 会直接中断请求。
    if credentials.is_console() {
        return Ok(credentials.clone());
    }
    if !force && !credentials.is_expiring() {
        return Ok(credentials.clone());
    }
    let key = format!(
        "{}:{}",
        account_id,
        refresh_flight::fingerprint(&credentials.access_token)
    );
    let guard = match inflight_table().join(&key) {
        refresh_flight::Join::Leader(guard) => guard,
        refresh_flight::Join::Waiter(waiter) => return waiter.wait().await,
    };
    let result = call_refresh_api(credentials).await;
    let result = match result {
        Ok(next) => {
            store.update_orcaterm_token(account_id, &next.access_token, next.expires_at);
            Ok(next)
        }
        Err(error) => Err(error),
    };
    guard.finish(result.clone());
    result
}

/// 调 `OAuthRefreshToken` 换新 token（2026-10-16 实测：传旧 accessToken 即可）。
async fn call_refresh_api(
    credentials: &OrcatermCredentials,
) -> Result<OrcatermCredentials, GatewayError> {
    let response = cgi_action(
        credentials,
        "OAuthRefreshToken",
        json!({ "accessToken": credentials.access_token }),
        None,
    )
    .await?;
    let code = response.get("Code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let message = response.get("Message").and_then(Value::as_str).unwrap_or("未知错误");
        return Err(GatewayError::with_status(
            401,
            format!("OrcaTerm 续期失败（code={code}：{message}）；请重新导入桌面端登录态或重新粘贴 accessToken"),
        ));
    }
    let token = normalize_token(
        response.get("AccessToken").and_then(Value::as_str).unwrap_or(""),
    );
    if token.is_empty() {
        return Err(GatewayError::with_status(502, "OrcaTerm 续期响应缺少 AccessToken"));
    }
    let (user_id, expires_at) = claims_of(&token);
    logging::verbose(
        "[OrcaTerm]",
        &format!("账号 {} 的 accessToken 已续期（新过期时刻 {expires_at}）", credentials.user_id),
    );
    Ok(OrcatermCredentials {
        access_token: token,
        expires_at,
        skey: None,
        raw_cookie: None,
        user_id: if user_id.is_empty() { credentials.user_id.clone() } else { user_id },
        nickname: credentials.nickname.clone(),
    })
}

// ─── 账号记录快照 ───────────────────────────────────────────

/// 从账号记录取转发凭证（`account_id` 为空 → 本家组内优先级最小的启用账号）。
///
/// 记录里的 `accessToken` 存 JWT 本体（见账号层）。临期**不在这里刷**：
/// 返回快照后由调用方（`chat::run_chat` / `ensure_access_token`）决定
/// 何时调 [`refresh`]（那边手上有 store 与 account_id，能回写）。
pub fn snapshot_for(
    store: &AccountStore,
    account_id: &str,
) -> Result<OrcatermCredentials, GatewayError> {
    let record = store.orcaterm_account_record(account_id).ok_or_else(|| {
        GatewayError::with_status(
            401,
            "OrcaTerm 没有可用的登录凭证：请在账号页添加账号（粘贴 accessToken 或导入桌面端登录态）",
        )
    })?;
    let token = normalize_token(
        record.get("accessToken").and_then(Value::as_str).unwrap_or(""),
    );
    if token.is_empty() {
        // ── 控制台态（uin/skey）────────────────────────────────
        // 记录里 accessToken 为空、但有 skey ⇒ 上次粘贴的是浏览器 cookie。
        // 原串优先（保真重放），没有就用 uin + skey 拼（`console_cookie` 兜底）。
        let skey = record
            .get("skey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(skey) = skey {
            return Ok(OrcatermCredentials {
                access_token: String::new(),
                expires_at: 0,
                skey: Some(skey),
                raw_cookie: record
                    .get("rawCookie")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                user_id: record
                    .get("uid")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                nickname: record
                    .get("loginName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
        }
        return Err(GatewayError::with_status(
            401,
            "OrcaTerm 账号缺少凭证：请重新粘贴 accessToken 或整段 document.cookie",
        ));
    }
    let (jwt_user_id, jwt_exp) = claims_of(&token);
    Ok(OrcatermCredentials {
        access_token: token,
        // 桌面态：不存在 skey / 原串（控制台态在上面那个分支里返回）
        skey: None,
        raw_cookie: None,
        expires_at: record
            .get("tokenExpireAt")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .unwrap_or(jwt_exp),
        user_id: record
            .get("uid")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or(jwt_user_id),
        nickname: record.get("loginName").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}
