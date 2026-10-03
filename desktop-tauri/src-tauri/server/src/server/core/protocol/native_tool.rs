//! 原生（上游服务端执行）工具声明的保真携带与按家降级。
//!
//! ── 什么是「原生工具声明」────────────────────────────────────
//! 与 function 工具（**客户端执行**：模型给出参数，客户端跑完把结果回灌）不同，
//! 原生工具由**上游自己执行**，声明里带的是协议私有的类型字段：
//!
//! ```json
//! Responses：{"type":"web_search"} / {"type":"tool_search"} / {"type":"file_search"}
//! Anthropic：{"type":"web_search_20250305","name":"web_search","max_uses":5}
//! ```
//!
//! 它们没有 `function` 嵌套体，参数表也不在客户端手里。本项目的枢纽形态是
//! Chat，没有这个概念的对应字段 —— 处理不当就是 issue #61 / #55 的现象：
//! 入口把声明丢掉（Responses 路径）或把它改写成一只**空壳 function**
//! （Anthropic 路径：`name` 在、`type` 没了 —— 上游既不会真去搜，模型拿到的
//! schema 也是空的），客户端侧的表现就是「模型自带的搜索工具无法调用」。
//!
//! ── 本模块的取舍：保真携带 + 按家降级 ─────────────────────────
//! 入口不再丢弃也不再改写，而是**原样携带**（[`carry`]：整个声明逐字保留，
//! 只多挂一枚 [`FIELD_NATIVE_TOOL`] 来源标记）。出站时按**目标协议**决定去留：
//!
//!   · 目标协议与来源一致（自定义家的 anthropic / responses 上游）→ [`restore`]
//!     逐字恢复。DeepSeek 的 Anthropic 端点只认 `web_search_20250305` /
//!     `web_search_20260209` 两个值，类型字段正是它的准入凭据（参考实现
//!     9Router 为此专门维护 `claudeSupportedToolTypes`）；
//!   · 内置家（各家官方客户端的后端，只承载 `type:"function"` 的函数工具）
//!     → 统一降级：剔除 + 留痕。不降级的后果各家还不一样：CatPaw 整轮 400、
//!     Qoder / Trae 静默剔除、其余原样发给一个不认它的上游；
//!   · 跨协议（来源与目标协议不同）→ 同样剔除 + 留痕。**不猜**翻译：
//!     `web_search` 在 Chat（智谱的 `web_search.enable` 那套）与 Responses 里
//!     同名不同义，`web_search_20250305` 的版本号是上游白名单 —— 猜一个错形态
//!     比丢掉更危险（上游报错，且错得难查）。
//!
//! 留痕一律走 [`Downgrade::describe`]：剔除必须能回答「丢了什么、为什么」——
//! 那正是 #55 那次排查最缺的一行日志。
//!
//! ── 与内部暂存字段机制的关系 ─────────────────────────────────
//! 标记走 `_wb_` 前缀（见 [`super`] 的说明）：chat 透传出口（内置家、自定义家
//! 的 chat 协议）发送前由 [`super::strip_internal_fields`] 统一剥离，标记本身
//! 不会漏给上游；标记在，才说明「这条声明是从另一条协议保真带过来的」。

use serde_json::{json, Value};

/// 来源协议的暂存字段（工具对象上，值 = 来源协议字面量）。
pub const FIELD_NATIVE_TOOL: &str = "_wb_native_tool";

/// 来源协议：chat 入口（客户端直接声明的 chat 方言原生工具，如智谱的
/// `{"type":"web_search","web_search":{"enable":true}}`）。
///
/// 这一路**不挂标记**（chat 体本来就是枢纽形态，原样透传即可）——本常量只用来
/// 表达「目标就是 chat」时的比较对象，见 [`strip_cross_protocol`]。
pub const ORIGIN_CHAT: &str = "chat";
/// 来源协议：Responses（`web_search` / `tool_search` 等宿主工具）。
pub const ORIGIN_RESPONSES: &str = "responses";
/// 来源协议：Anthropic（`web_search_20250305` 等服务端工具）。
pub const ORIGIN_ANTHROPIC: &str = "anthropic";

/// 一次降级的明细（供调用方留痕，见 [`Downgrade::describe`]）。
pub struct Downgrade {
    /// 被剔除的声明（原样，用于取名字与打印标签）
    pub tools: Vec<Value>,
    /// 被一并撤掉的 `tool_choice` 及原因（没有就是 None）
    pub choice: Option<String>,
}

impl Downgrade {
    /// 留痕文案。`provider` 传 Some 时补上 `provider=` 尾巴（内置家闸门用；
    /// 协议翻译器在纯函数里调用，拿不到 provider id）；`reason` 是这一处
    /// 剔除的场合说明（例如「目标上游为 anthropic 协议」）。
    pub fn describe(&self, provider: Option<&str>, reason: Option<&str>) -> String {
        let mut text = String::new();
        if !self.tools.is_empty() {
            let labels: Vec<String> = self
                .tools
                .iter()
                .map(super::tool_plan::tool_kind_label)
                .collect();
            text.push_str(&format!(
                "⚠️ 剔除原生（服务端执行）工具声明 {} 条：{}",
                self.tools.len(),
                labels.join(", ")
            ));
            if let Some(reason) = reason {
                text.push_str(&format!("（{reason}）"));
            }
        }
        if let Some(choice) = &self.choice {
            if text.is_empty() {
                text.push_str(&format!("⚠️ 撤掉 tool_choice（{choice}）"));
            } else {
                text.push_str(&format!("；连带撤掉 tool_choice（{choice}）"));
            }
        }
        if let Some(provider) = provider {
            text.push_str(&format!("；provider={provider}"));
        }
        text
    }
}

/// 把一条原生声明收进内部形态：**逐字保留**原声明，只多挂来源标记。
///
/// Responses 允许字符串简写（`tools: ["web_search"]` 等价于
/// `{"type":"web_search"}`）：字符串挂不了字段，先归一成对象形态再标记。
pub fn carry(tool: &Value, origin: &str) -> Value {
    let mut entry = match tool {
        Value::String(name) => json!({ "type": name }),
        other => other.clone(),
    };
    if let Some(object) = entry.as_object_mut() {
        object.insert(
            FIELD_NATIVE_TOOL.to_string(),
            Value::String(origin.to_string()),
        );
    }
    entry
}

/// 来源协议（不是携带过来的声明则 None）
pub fn origin_of(tool: &Value) -> Option<&str> {
    tool.get(FIELD_NATIVE_TOOL)
        .and_then(Value::as_str)
        .filter(|origin| !origin.trim().is_empty())
}

/// 是否原生声明：**带标记**的，或 `type` 存在且不是 `function` 的。
///
/// 第二条覆盖没挂标记的来路：chat 入口的请求体是原样透传的，客户端的
/// chat 方言原生工具（智谱那套）不会经过 [`carry`]。
pub fn is_native(tool: &Value) -> bool {
    if origin_of(tool).is_some() {
        return true;
    }
    match tool {
        // 字符串简写只可能是宿主工具名（function 工具必须给参数表，写不成字符串）
        Value::String(_) => true,
        _ => {
            let kind = super::string_field(tool, "type");
            !kind.is_empty() && !kind.eq_ignore_ascii_case("function")
        }
    }
}

/// Anthropic 口径的原生声明判定：`type:"custom"` 是**客户端自定义函数工具**的
/// 显式写法（新 spec），不是服务端工具 —— 服务端工具的 `type` 是
/// `web_search_20250305` 这类带版本日的形态（见 `super::anthropic` 的入口转换）。
pub fn is_native_anthropic(tool: &Value) -> bool {
    let kind = super::string_field(tool, "type");
    !kind.is_empty()
        && !kind.eq_ignore_ascii_case("function")
        && !kind.eq_ignore_ascii_case("custom")
}

/// 还原成「发给同协议上游」的形态：去掉内部暂存字段，其余逐字保留。
///
/// 只在目标协议与 [`origin_of`] 一致时调用 —— 跨协议没有可靠的翻译口径
/// （模块头「不猜」那一段）。
pub fn restore(tool: &Value) -> Value {
    let mut entry = tool.clone();
    // 私有函数：同模块的后代可见（`_wb_` 前缀的剥离只此一份实现）
    super::strip_on_object(&mut entry);
    entry
}

/// 声明指代的工具名（`name` 优先；没有 name 的宿主工具退回 `type`；
/// 字符串简写取自身）。`tool_choice` 的点名匹配用它。
pub fn name_of(tool: &Value) -> String {
    let name = super::string_field(tool, "name");
    if !name.is_empty() {
        return name;
    }
    match tool {
        Value::String(text) => text.trim().to_string(),
        other => super::string_field(other, "type"),
    }
}

/// 一条 chat 形态 `tool_choice` 指向的工具名（`auto` / `none` / `required`
/// 这类模式词不算点名）。
pub fn choice_target(choice: &Value) -> Option<String> {
    match choice {
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty()
                || matches!(
                    text.to_ascii_lowercase().as_str(),
                    "auto" | "none" | "required"
                )
            {
                None
            } else {
                Some(text.to_string())
            }
        }
        _ => {
            let nested = choice
                .pointer("/function/name")
                .map(super::string_value)
                .unwrap_or_default();
            if !nested.trim().is_empty() {
                return Some(nested);
            }
            let flat = super::string_field(choice, "name");
            if flat.is_empty() { None } else { Some(flat) }
        }
    }
}

/// `tool_choice` 是否是原生工具的表达（chat 侧没有「强制调用宿主工具」的语义）。
///
/// 排除 `auto` / `none` / `required` 的对象写法：那三种是 chat 自己的模式词
/// （客户端混用两种形态，WorkBuddy 的归一化里就有它们）。
pub fn is_native_choice(choice: &Value) -> bool {
    if choice.is_string() {
        return false;
    }
    let kind = super::string_field(choice, "type").to_ascii_lowercase();
    !kind.is_empty()
        && !matches!(kind.as_str(), "function" | "auto" | "none" | "required")
}

/// `tool_choice` 是否与本次剔除的声明冲突：是则返回一句原因。
///
/// 两种冲突：它本身指向原生工具；或它点名的工具正在被剔除。两种都必须撤掉 ——
/// 留着一条指向不存在工具的 `tool_choice`，上游会按「指定的工具不存在」把整轮
/// 打成 400（CatPaw 的 `select_tools` 就是这么判的）。
pub fn choice_conflict(choice: &Value, dropped: &[Value]) -> Option<String> {
    if is_native_choice(choice) {
        let kind = super::string_field(choice, "type");
        return Some(format!("它本身指向原生工具（type={kind}）"));
    }
    let name = choice_target(choice)?;
    dropped
        .iter()
        .any(|tool| name_of(tool) == name)
        .then(|| format!("它点名的「{name}」是本次被剔除的原生工具"))
}

/// 内置家闸门：剔除**全部**原生声明（内置家只承载 `type:"function"` 的函数工具）。
///
/// 判据是 [`is_native`] —— 函数工具（`type:"function"`，含嵌套与扁平两种写法）
/// 一律保留。这里**不能**用恒真谓词：那会把客户端的函数工具一并删掉，模型拿到
/// 一个没有 tools 的请求，只能把调用写成正文吐出来（2026-10-01 那次「什么模型
/// 都调不了工具」的事故就是这样发生的）。
///
/// 没有可剔的（绝大多数请求）返回 None；有则连带处理指向它们的 `tool_choice`。
pub fn downgrade(body: &Value) -> Option<(Value, Downgrade)> {
    strip_with(body, is_native)
}

/// 自定义家 chat 出口：只剔「来源协议 ≠ 目标协议」的**带标记**声明。
///
/// 无标记的声明一律不碰 —— 那是 chat 入口原样带上来的 chat 方言原生工具，
/// 自定义家的契约就是透传（上游认不认由用户自己的配置决定）。
pub fn strip_cross_protocol(body: &Value, target: &str) -> Option<(Value, Downgrade)> {
    strip_with(body, |tool| match origin_of(tool) {
        Some(origin) => !origin.eq_ignore_ascii_case(target),
        None => false,
    })
}

/// 剔除与 `tool_choice` 撤回的共同实现（两个口径只差 `should_drop` 判据）。
fn strip_with<F: Fn(&Value) -> bool>(body: &Value, should_drop: F) -> Option<(Value, Downgrade)> {
    let mut next = body.clone();
    let mut dropped: Vec<Value> = Vec::new();
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mut kept: Vec<Value> = Vec::with_capacity(tools.len());
        for tool in tools {
            if should_drop(tool) {
                dropped.push(tool.clone());
            } else {
                kept.push(tool.clone());
            }
        }
        if !dropped.is_empty() {
            if let Some(object) = next.as_object_mut() {
                if kept.is_empty() {
                    object.remove("tools");
                } else {
                    object.insert("tools".to_string(), Value::Array(kept));
                }
            }
        }
    }
    let mut choice: Option<String> = None;
    if let Some(current) = next.get("tool_choice").cloned() {
        if let Some(reason) = choice_conflict(&current, &dropped) {
            if let Some(object) = next.as_object_mut() {
                object.remove("tool_choice");
            }
            choice = Some(reason);
        }
    }
    if dropped.is_empty() && choice.is_none() {
        return None;
    }
    Some((next, Downgrade { tools: dropped, choice }))
}
