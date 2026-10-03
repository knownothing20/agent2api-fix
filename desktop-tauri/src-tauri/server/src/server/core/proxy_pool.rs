//! 出网代理池：集中管理一组**命名代理**（手动填的 / 引用 Clash Verge 的），
//! 账号的 proxy 字段可以按 id 引用它们（`{source:'pool', proxyId}`）。
//!
//! ── 为什么要有它（对照 OmniProxy 的 proxies 表）──────────────
//! 改造前代理只能**逐个账号**配：同一个出口用在三个账号上就要填三遍，
//! 改一次端口要改三处；也看不到「这个出口到底通不通、出口 IP 是多少」——
//! 出口测试只有账号弹窗里那一处入口。代理池把「出口」抽成独立实体：
//! 配一次、测一次、多个账号引用，账号记录里只留一个 id。
//!
//! ── 存储：kv 的 `proxyPool` 键（不是独立表）────────────────────
//! 条目数量级是几个到几十个、无查询需求（永远是整份读、整份写），
//! 与 `scheduledTasks` / `desktopSettings` 同一类零散状态 —— 按项目约定
//! 落 `kv` 的固定键（登记在 `db::schema::RESERVED_KV_KEYS`，否则
//! `config::save_raw` 写一次配置就会把它删掉）。不新增表也就**不动 schema
//! 版本**：`db::schema` 的模块头把「表只增不改」的成本讲得很清楚，这里没有
//! 需要索引/约束的字段，不值得为它推一个版本。
//!
//! ── 两种来源（对标 OmniProxy 的 proxies 表）────────────────────
//!   manual  手填 `{protocol, host, port, username, password}`；
//!   clash   **从 Clash Verge 同步进来**的镜像记录 `{listenerUid}`：名称 / 端口 /
//!           启用状态全部跟随 Clash（端口实时读取，见 `core::clash` 的「严格镜像」
//!           说明），因此**本地不可改不可删** —— 想改去 Clash Verge 改，想删去
//!           Clash Verge 删（下一次同步会把它从池里摘掉）。这条只读语义照
//!           OmniProxy 的 `imported_clash_listeners` 分支实现（它的 PUT/DELETE
//!           对同步来的记录一律 400「请在 Clash Verge 中修改」）。
//!
//! ── 同步（`sync_clash`，对标 OmniProxy 的 syncClashVergeListeners）──
//! 把 Clash 当前的出口集合**整体镜像**进池：新出口插入、已有出口按 uid 更新
//! （名称 / 启用）、Clash 侧已消失的摘掉。手动条目不受影响。触发点两处：
//! `GET /api/proxies/pool` 进来时自动同步一次（OmniProxy 的 `router.get('/proxies')`
//! 也是这么做的 —— 「Clash 里加了出口，打开页面就能看到」不必再点一次按钮），
//! 以及页面上的「同步 Clash Verge」按钮（手动强制一次）。
//! **镜像是全量的**：用户在池里看到的就是 Clash 当前的出口集合，不存在
//! 「半套」状态；这也意味着在 Clash 侧删掉一个出口，引用它的账号会解析失败并
//! 回退直连（与「账号直接引用 Clash 监听器」时的行为完全一致）。
//!
//! 与 OmniProxy 的一处**有意差异**：同步集合包含 Clash 的**混合端口**
//! （`__mixed__`，即「按规则分流」那个入口）。OmniProxy 只导手动监听器，而
//! workbuddy 的账号代理下拉从一开始就把混合端口列为第一项（见 `clash.rs` 的
//! `clash_proxy_options`）—— 不导入它，「按规则分流」这条最常用的出口在池里
//! 就没有任何可引用的条目，等于功能倒退。
//!
//! ── 解析复用账号代理那一条链，不另写一份 ──────────────────────
//! 条目 → 构造出与账号 `proxy` 字段同形的 config → 交给
//! `core::proxies::resolve_account_proxy`。于是「Clash 监听器被删了」
//! 「端口非法」这些失败形态与账号侧逐字一致，前端显示与排障口径只有一套。
//! 反向的依赖（proxies.rs 解析 pool 引用时回来查池）见 `core::proxies` 的
//! `pool` 分支 —— 条目自身只可能是 clash / manual（归一里挡掉了嵌套引用），
//! 不存在递归。
//!
//! ── 测试结果为什么也进条目 ────────────────────────────────────
//! `lastTest`（成功与否 / 出口 IP / 耗时 / 时刻）在测试后落库：重启、切页、
//! 换设备打开都能看到「上次测出来是什么」。它只是**展示用的历史事实**，
//! 不参与选路 —— 转发不会因为上次测试失败就跳过某个出口（判断出口可用性
//! 的唯一权威是实际请求的结果，测试结果只回答「上次手测时通不通」）。

use std::sync::OnceLock;

use serde_json::{json, Map, Value};

use crate::server::core::proxies::{resolve_account_proxy, ProxyResolution};
use crate::server::db::Db;
use crate::server::logging;

/// `kv` 表里的键名（保留键，见 `db::schema::RESERVED_KV_KEYS`）
pub const KV_KEY: &str = "proxyPool";

/// 名称 / 主机的长度上限（与账号代理的 MAX_* 同量级；名称要出现在下拉与表格里）
const MAX_NAME_LENGTH: usize = 60;
const MAX_HOST_LENGTH: usize = 255;
const MAX_USER_LENGTH: usize = 200;
const MAX_LABEL_LENGTH: usize = 100;

/// 进程级库句柄（照 `core::task_state` 的形态：bootstrap 时 install 一次）
static DB: OnceLock<Option<Db>> = OnceLock::new();

/// 接线（`ServerState::bootstrap` 调用）。重复调用无副作用。
pub fn install(db: Option<Db>) {
    let _ = DB.set(db);
}

fn database() -> Result<&'static Db, String> {
    DB.get()
        .and_then(Option::as_ref)
        .ok_or_else(|| "代理池数据库不可用".to_string())
}

// ─── 存取 ───────────────────────────────────────────────────

/// 读全部条目（原始形态，`items` 数组；库不可用/无记录/解析失败都给空表）。
///
/// 解析失败按空表处理而不是报错：库里的这行只可能被外部工具改坏，
/// 用户界面上的表现是「代理池空了」——比整个页面报错更可恢复（重新加一条即可）。
fn read_items() -> Vec<Value> {
    let Some(db) = DB.get().and_then(Option::as_ref) else {
        return Vec::new();
    };
    db.with(|conn| {
        conn.query_row("SELECT value FROM kv WHERE key = ?1", [KV_KEY], |row| {
            row.get::<_, String>(0)
        })
        .ok()
    })
    .flatten()
    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    .and_then(|value| value.get("items").and_then(Value::as_array).cloned())
    .unwrap_or_default()
}

/// 整份写回（增删改都走它；条目数量小，整份重写的开销可忽略）
fn write_items(items: &[Value]) -> Result<(), String> {
    let db = database()?;
    let text = serde_json::to_string(&json!({ "items": items }))
        .map_err(|error| format!("编码代理池失败: {error}"))?;
    db.with(|conn| {
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![KV_KEY, text],
        )
        .map(|_| ())
        .map_err(|error| format!("保存代理池失败: {error}"))
    })
    .ok_or_else(|| "代理池数据库不可用".to_string())?
}

// ─── 正规化与校验 ───────────────────────────────────────────

fn clean_string(value: Option<&Value>, max: usize) -> String {
    let Some(Value::String(text)) = value else {
        return String::new();
    };
    text.trim().chars().take(max).collect()
}

/// 1..65535 的整数（数字或数字字符串，口径与 `core::proxies::valid_port` 一致）
fn valid_port(value: Option<&Value>) -> Option<u16> {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64()?,
        Some(Value::String(text)) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !number.is_finite() || number.fract() != 0.0 || !(1.0..=65535.0).contains(&number) {
        return None;
    }
    Some(number as u16)
}

fn text_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// 把 API 输入（新建 / 编辑的整份表单）归一成一条**手动**池条目。
///
/// `existing` 是编辑时的旧条目（新建传 None）：`id` / `createdAt` / `lastTest`
/// 从旧条目沿用，其余字段一律按本次输入覆盖（与账号「页面表单整份提交」同语义，
/// 前端编辑时会回显密码，不存在「空 = 保留」的隐式行为）。
///
/// **只产出 manual 条目**：clash 来源的条目由同步产生（见 `sync_clash`），
/// 从 API 进来的 clash 形状一律拒绝 —— 否则会凭空造出一条「不属于任何 Clash
/// 出口的镜像记录」，而它下次同步就会被摘掉，等于用户白填一次。
fn normalize_item(input: &Value, existing: Option<&Value>) -> Result<Value, String> {
    let Some(object) = input.as_object() else {
        return Err("代理条目必须是对象".to_string());
    };
    if clean_string(object.get("source"), 20) == "clash" {
        return Err("Clash Verge 出口由「同步 Clash Verge」自动导入，不能手工新建".to_string());
    }
    let name = clean_string(object.get("name"), MAX_NAME_LENGTH);
    if name.is_empty() {
        return Err("请填写代理名称".to_string());
    }

    let now = logging::now_ms();
    let id = existing
        .map(|item| text_of(item, "id"))
        .unwrap_or_default();
    let id = if id.is_empty() { new_id() } else { id };
    let created_at = existing
        .and_then(|item| item.get("createdAt"))
        .and_then(Value::as_i64)
        .unwrap_or(now);
    // 测试结果是「历史事实」：编辑配置后旧结果已经不对应新出口了，但**不删** ——
    // 前端在结果旁标注它测于何时，用户自己能判断要不要重测（悄悄删掉会让
    // 「上次测过、当时是通的」这条信息无端消失）。改地址时保留、改协议时保留，
    // 一律保留，唯一的重置是删除条目本身。
    let last_test = existing
        .and_then(|item| item.get("lastTest"))
        .cloned()
        .unwrap_or(Value::Null);

    let protocol = {
        let cleaned = clean_string(object.get("protocol"), 10).to_lowercase();
        if cleaned.is_empty() { "http".to_string() } else { cleaned }
    };
    if protocol != "http" && protocol != "socks5" {
        return Err("代理协议只支持 http 或 socks5".to_string());
    }
    let host = clean_string(object.get("host"), MAX_HOST_LENGTH);
    if host.is_empty() {
        return Err("请填写代理主机地址".to_string());
    }
    let Some(port) = valid_port(object.get("port")) else {
        return Err("代理端口必须是 1-65535 的整数".to_string());
    };

    let mut normalized = Map::new();
    normalized.insert("id".to_string(), Value::String(id));
    normalized.insert("name".to_string(), Value::String(name));
    normalized.insert("source".to_string(), Value::String("manual".to_string()));
    normalized.insert(
        "enabled".to_string(),
        Value::Bool(!matches!(object.get("enabled"), Some(Value::Bool(false)))),
    );
    normalized.insert("protocol".to_string(), Value::String(protocol));
    normalized.insert("host".to_string(), Value::String(host));
    normalized.insert("port".to_string(), Value::from(port));
    normalized.insert(
        "username".to_string(),
        Value::String(clean_string(object.get("username"), MAX_USER_LENGTH)),
    );
    normalized.insert(
        "password".to_string(),
        Value::String(clean_string(object.get("password"), MAX_USER_LENGTH)),
    );
    normalized.insert("createdAt".to_string(), Value::from(created_at));
    normalized.insert("updatedAt".to_string(), Value::from(now));
    normalized.insert("lastTest".to_string(), last_test);
    Ok(Value::Object(normalized))
}

/// 新条目的 id：`px_<毫秒>_<8 位随机>`。随机段与 `upstream::request` 的
/// 请求 id 同一手法（RandomState 的随机种子），不引第三方依赖。
fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(logging::now_ms() as u64);
    hasher.write_u64(std::process::id() as u64);
    let suffix = (hasher.finish() & 0xffff_ffff) as u32;
    format!("px_{}_{suffix:08x}", logging::now_ms())
}

// ─── 解析（给 core::proxies 的 pool 分支与 describe 共用）──────

/// 把条目解析成可用的出口（复用账号代理那条链，见模块头）。
///
/// 返回 None 只发生在条目形状残缺到连 config 都拼不出时（手工改坏的库）；
/// 正常条目一定拿到 `Resolved` / `Failed` 二选一。
pub fn resolve_item(item: &Value) -> Option<ProxyResolution> {
    let source = text_of(item, "source");
    let config = if source == "clash" {
        json!({ "source": "clash", "listenerUid": text_of(item, "listenerUid") })
    } else {
        json!({
            "source": "custom",
            "protocol": text_of(item, "protocol"),
            "host": text_of(item, "host"),
            "port": item.get("port").cloned().unwrap_or(Value::Null),
            "username": text_of(item, "username"),
            "password": text_of(item, "password"),
        })
    };
    resolve_account_proxy(Some(&config))
}

/// 池引用的解析（`core::proxies` 的 pool 分支调它）。
///
/// 三态（`Err` 的两种分开报：用户看到「已禁用」才会想到去代理页启用它，
/// 而「不存在」提示的是「被谁删了」）：
///   `Ok(proxy)` 出口可用；
///   `Err(原因)` 条目不存在 / 被禁用 / 解析失败 —— 调用方原样报出去
///               （账号列表的「代理异常」气泡、转发时回退直连的日志）。
pub fn resolve_reference(proxy_id: &str) -> Result<crate::server::core::proxies::ResolvedProxy, String> {
    let Some(item) = find_raw(proxy_id) else {
        return Err(format!("代理「{proxy_id}」不存在或已被删除"));
    };
    if matches!(item.get("enabled"), Some(Value::Bool(false))) {
        return Err(format!(
            "代理「{}」已禁用（在「网络代理」页启用它）",
            display_name(&item, proxy_id)
        ));
    }
    resolve_entry(&item, proxy_id)
}

/// 出口测试专用解析：与 `resolve_reference` 只差**不看禁用位** ——
/// 「先测通、再启用」是常见操作顺序，禁用的条目也要能测（只有引用解析
/// 那条链必须挡住禁用项，理由见 `resolve_reference`）。
pub fn resolve_for_test(proxy_id: &str) -> Result<crate::server::core::proxies::ResolvedProxy, String> {
    let Some(item) = find_raw(proxy_id) else {
        return Err(format!("代理「{proxy_id}」不存在或已被删除"));
    };
    resolve_entry(&item, proxy_id)
}

fn display_name(item: &Value, fallback: &str) -> String {
    let name = text_of(item, "name");
    if name.is_empty() { fallback.to_string() } else { name }
}

fn resolve_entry(
    item: &Value,
    proxy_id: &str,
) -> Result<crate::server::core::proxies::ResolvedProxy, String> {
    let name = display_name(item, proxy_id);
    match resolve_item(item) {
        Some(ProxyResolution::Resolved(mut proxy)) => {
            // label 换成用户自己起的名字（账号代理列 / 出口测试结果都读它）：
            // 「香港节点」比底层的 `http://127.0.0.1:7890` 更好认；
            // 实际地址仍在 host / port 字段里（测试响应会带出去）
            proxy.label = name;
            Ok(proxy)
        }
        Some(ProxyResolution::Failed(reason)) => Err(format!("代理「{name}」不可用: {reason}")),
        None => Err(format!("代理「{name}」配置不完整")),
    }
}

// ─── 公开形态 ───────────────────────────────────────────────

fn describe_item(item: &Value) -> Value {
    let source = text_of(item, "source");
    let (resolved, resolve_error) = match resolve_item(item) {
        Some(ProxyResolution::Resolved(proxy)) => (
            json!({
                "protocol": proxy.protocol,
                "host": proxy.host,
                "port": proxy.port_json(),
                "label": proxy.label,
            }),
            Value::Null,
        ),
        Some(ProxyResolution::Failed(reason)) => (Value::Null, Value::String(reason)),
        None => (Value::Null, Value::String("配置不完整".to_string())),
    };
    json!({
        "id": text_of(item, "id"),
        "name": text_of(item, "name"),
        "source": source,
        "enabled": !matches!(item.get("enabled"), Some(Value::Bool(false))),
        // manual 的字段原样带出（编辑弹窗要回显，含密码 —— 与账号代理表单同一口径：
        // 那是本机自己的配置，账号记录里的代理密码同样是明文存的）
        "protocol": text_of(item, "protocol"),
        "host": text_of(item, "host"),
        "port": item.get("port").cloned().unwrap_or(Value::Null),
        "username": text_of(item, "username"),
        "password": text_of(item, "password"),
        // clash 的引用 uid（编辑弹窗选中它 + 前端标注「来自 Clash Verge」）
        "listenerUid": text_of(item, "listenerUid"),
        "createdAt": item.get("createdAt").cloned().unwrap_or(Value::from(0)),
        "updatedAt": item.get("updatedAt").cloned().unwrap_or(Value::from(0)),
        "lastTest": item.get("lastTest").cloned().unwrap_or(Value::Null),
        "resolved": resolved,
        "resolveError": resolve_error,
    })
}

/// 最新全量列表（公开形态）。写操作也返回它 —— 与模型管理页的写接口同约定：
/// 前端就地替换，不必再拉一次。
pub fn list() -> Vec<Value> {
    read_items().iter().map(describe_item).collect()
}

fn find_raw(id: &str) -> Option<Value> {
    if id.is_empty() {
        return None;
    }
    read_items()
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
}

// ─── 写操作 ─────────────────────────────────────────────────

pub fn create(input: &Value) -> Result<Vec<Value>, String> {
    let item = normalize_item(input, None)?;
    let mut items = read_items();
    // 新条目排在最前（与账号页「新加的看得见」一致；代理数量少，没有再排序的价值）
    items.insert(0, item.clone());
    write_items(&items)?;
    logging::log(
        "[Proxies]",
        &format!("✅ 新增代理「{}」", text_of(&item, "name")),
    );
    Ok(list())
}

/// 该条目是否来自 Clash 同步（只读镜像）。写操作一律先过它。
fn is_clash_item(item: &Value) -> bool {
    text_of(item, "source") == "clash"
}

/// 只读条目被写操作命中时的统一提示（照 OmniProxy 的文案）
const CLASH_READONLY_HINT: &str =
    "该代理来自 Clash Verge 同步（名称 / 端口 / 启用都跟随 Clash），请到 Clash Verge 中修改";

pub fn update(input: &Value) -> Result<Vec<Value>, String> {
    let id = clean_string(input.get("id"), MAX_LABEL_LENGTH);
    if id.is_empty() {
        return Err("缺少代理 id".to_string());
    }
    let mut items = read_items();
    let Some(index) = items
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
    else {
        return Err(format!("代理「{id}」不存在"));
    };
    if is_clash_item(&items[index]) {
        return Err(CLASH_READONLY_HINT.to_string());
    }
    let next = normalize_item(input, Some(&items[index]))?;
    items[index] = next.clone();
    write_items(&items)?;
    logging::log(
        "[Proxies]",
        &format!("✅ 更新代理「{}」", text_of(&next, "name")),
    );
    Ok(list())
}

/// 删除条目；返回（最新列表, 被删条目的名称 —— 调用方拼日志/提示用）。
/// Clash 同步来的条目不可删（照 OmniProxy）：去 Clash 里删出口，下次同步自然摘掉。
pub fn remove(id: &str) -> Result<(Vec<Value>, String), String> {
    let mut items = read_items();
    let Some(index) = items
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
    else {
        return Err(format!("代理「{id}」不存在"));
    };
    if is_clash_item(&items[index]) {
        return Err(CLASH_READONLY_HINT.to_string());
    }
    let removed = items.remove(index);
    write_items(&items)?;
    let name = text_of(&removed, "name");
    logging::log("[Proxies]", &format!("🗑️ 删除代理「{name}」"));
    Ok((list(), name))
}

// ─── Clash Verge 同步（全量镜像）─────────────────────────────

/// 同步结果：变更条数 + 失败原因（「Clash 没装」不是错误路径，见 `sync_clash`）
pub struct ClashSyncReport {
    pub changes: usize,
    pub error: Option<String>,
}

/// 一个待镜像的 Clash 出口（合并「混合端口 + 各监听器」两种来源）
struct SyncTarget {
    uid: String,
    name: String,
    enabled: bool,
}

/// 把 Clash 当前出口集合整体镜像进池（详见模块头「同步」一节）。
///
/// 返回值语义：
///   · `error: Some(..)` 只表示**这一次没能同步**（找不到 Clash 配置 / verge.yaml
///     读不出来）—— 池原样保留、不算失败（绝大多数机器上没装 Clash，那是最常见
///     的正常状态，页面上只在 Clash 那一栏给一句说明）；
///   · 同步成功但**什么都没变**时 `changes = 0`，界面提示「已是最新」而不是
///     假装做了事。
///
/// 手动条目从不被碰；镜像集合的判据是 `listenerUid`（条目里存的 Clash 出口 uid）。
/// 手工改库造出的重复 uid（同一条 Clash 出口两条池条目）在收尾的 retain 里去重，
/// 只留第一行 —— 结果自然收敛到一 uid 一条。
pub fn sync_clash() -> ClashSyncReport {
    let snapshot = crate::server::core::clash::clash_snapshot();
    if !snapshot.available {
        return ClashSyncReport {
            changes: 0,
            error: Some(
                snapshot
                    .error
                    .unwrap_or_else(|| crate::server::core::clash::CLASH_UNAVAILABLE.to_string()),
            ),
        };
    }

    let mut targets: Vec<SyncTarget> = Vec::new();
    // 混合端口排在最前（与账号代理下拉里的顺序一致：它是最常用的那条）
    if snapshot.mixed_port.is_some() {
        targets.push(SyncTarget {
            uid: crate::server::core::clash::CLASH_MIXED_UID.to_string(),
            name: "Clash 混合端口（按规则分流）".to_string(),
            enabled: true,
        });
    }
    for listener in &snapshot.listeners {
        targets.push(SyncTarget {
            uid: listener.uid.clone(),
            name: listener.name.clone(),
            enabled: listener.enabled,
        });
    }

    let now = logging::now_ms();
    let mut items = read_items();
    let mut changes = 0usize;

    // ① 目标集合逐条 upsert
    for target in &targets {
        let existing = items.iter().position(|item| {
            is_clash_item(item)
                && item.get("listenerUid").and_then(Value::as_str) == Some(target.uid.as_str())
        });
        match existing {
            Some(index) => {
                // 先读完旧值再拿可变借用（同一元素不能同时借两次）
                let name_changed = text_of(&items[index], "name") != target.name;
                let current_enabled =
                    !matches!(items[index].get("enabled"), Some(Value::Bool(false)));
                if name_changed || current_enabled != target.enabled {
                    if let Some(object) = items[index].as_object_mut() {
                        object.insert("name".to_string(), Value::String(target.name.clone()));
                        object.insert("enabled".to_string(), Value::Bool(target.enabled));
                        object.insert("updatedAt".to_string(), Value::from(now));
                    }
                    changes += 1;
                }
            }
            None => {
                // 端口不落库：clash 条目的地址每次从 Clash 实时解析（见 resolve_item）
                items.insert(
                    0,
                    json!({
                        "id": new_id(),
                        "name": target.name,
                        "source": "clash",
                        "listenerUid": target.uid,
                        "enabled": target.enabled,
                        "createdAt": now,
                        "updatedAt": now,
                        "lastTest": Value::Null,
                    }),
                );
                changes += 1;
            }
        }
    }

    // ② Clash 侧已消失的镜像条目摘掉（严格镜像：池里不存在「半套」状态）
    //
    // 判据是「listenerUid 在不在本次目标集合里」：不在 = Clash 那边删了这个出口。
    // 顺手去重（同一条 Clash 出口只留第一行）—— 正常路径产不出重复（create 不收
    // clash，上一步的 upsert 按 uid 定位），防的是手工改库；没有 listenerUid 的
    // 坏行也在这里被清掉。
    let before = items.len();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    items.retain(|item| {
        if !is_clash_item(item) {
            return true;
        }
        let Some(uid) = item.get("listenerUid").and_then(Value::as_str) else {
            return false;
        };
        if !targets.iter().any(|target| target.uid == uid) {
            return false;
        }
        seen.insert(uid.to_string())
    });
    changes += before - items.len();

    if changes > 0 {
        if let Err(error) = write_items(&items) {
            return ClashSyncReport { changes: 0, error: Some(error) };
        }
        logging::log(
            "[Proxies]",
            &format!("🔄 已同步 Clash Verge 出口（{changes} 项变更）"),
        );
    }
    ClashSyncReport { changes, error: None }
}

/// 一次出口测试的结果（字段与 `egress::ConnectivityResult` 对应）。
///
/// 在这里独立一份而不是直接用 egress 的类型：`egress` 反过来经由
/// `core::proxies` 依赖本模块，为了一个「搬字段」的结构把它引进来会让
/// 依赖图绕一圈；两个类型都由 API 层对接，字段少了编译期就会发现。
pub struct TestOutcome {
    pub success: bool,
    pub ip: String,
    pub duration_ms: i64,
    pub error: Option<String>,
}

/// 记下一次连通性测试的结果（前端行内「测试」与弹窗里的测试都走它）。
pub fn record_test(id: &str, result: &TestOutcome) -> Result<Vec<Value>, String> {
    let mut items = read_items();
    let Some(index) = items
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
    else {
        return Err(format!("代理「{id}」不存在"));
    };
    let Some(object) = items[index].as_object_mut() else {
        return Err("代理条目形状异常".to_string());
    };
    let last_test = json!({
        "success": result.success,
        "ip": result.ip,
        "durationMs": result.duration_ms,
        "at": logging::now_ms(),
        // 成功时也带 null（前端按 success 分支取值，不靠键是否存在）
        "error": result.error,
    });
    object.insert("lastTest".to_string(), last_test);
    write_items(&items)?;
    Ok(list())
}
