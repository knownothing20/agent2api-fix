//! GLM-5.3 家族的**思考等级契约**：等级 ↔ thinking 预算，以及预算与
//! `max_tokens` 的配对规则。
//!
//! ── 为什么这家需要一份专门的契约 ────────────────────────────
//! GLM-5.3 / GLM-5.3-Flash 是**始终思考**的模型：关不掉。实测（2026-09-30，
//! 编码套餐端点）三种「关思考」的写法全部被上游拒掉：
//!
//! ```text
//!   thinking:{"type":"disabled"}   → 400 code 1210
//!   reasoning_effort:"none"        → 400 code 1210
//!   reasoning_effort:"minimal"     → 400 code 1210
//!   上游原文：该模型始终思考，不支持关闭思考；请使用 low、high 或 max。
//! ```
//!
//! 这句话里有两个硬事实：**合法等级只有 low / high / max 三档**，并且
//! 「关不掉」意味着思考**一定**会发生。于是存在一个静默的失败形态：
//!
//!   · 思考与正文**共用** `max_tokens` 这一个额度（实测：`max_tokens=16`
//!     时全部被 `reasoning_content` 吃掉，`content` 是空串，而 HTTP 状态
//!     仍是 200、`finish_reason` 是 `length`）；
//!   · 客户端一旦给的是小额度（Codex CLI 的标题生成正是这类内部请求），
//!     用户看到的就是「200 但回复为空」（issue #52），或客户端把它显示成
//!     「网络错误」（issue #54）。
//!
//! ── 与官方客户端的口径对齐 ──────────────────────────────────
//! 参考实现（`Acankao/zcode-api`）从 ZCode 客户端 bundle 里读出的做法是：
//! **`max_tokens` 把思考预算加在上面**（`max_tokens += budget`，再按模型的
//! `maxOutputTokens` 截顶）—— 预算花在「回答额度之外」，真实流量因此永远
//! 留得住正文空间。本模块照此实现，并补一条自己的兜底规则（见 [`resolve`]
//! 里「短输出」那一档）。
//!
//! ── 契约只对 5.3 家族生效 ───────────────────────────────────
//! 下面的预算数字（8000 / 16000 / 32000）来自官方目录 `agent/configs` 的
//! `builtinModels[].reasoning.levels`，**只有 GLM-5.3 与 GLM-5.3-Flash 有
//! 目录与实测依据**。glm-5 / 5.1 / 5.2 / 4.x 的档位表我们没有证据
//! （参考实现的模型匹配式也刻意把它们排除在外），因此那些模型原样走通用
//! 路径，不猜数字 —— 猜错的代价是给上游发一个它不认的预算。
//!
//! 同一条界线也管**映射绑定**：模型管理里给某条映射绑的档位只在 5.3 家族上
//! 生效（适配器的 `reasoning_patch` 对别的模型直接 `Skip`），所以「绑了不生效」
//! 时详细日志里能读到原因，而不是一个静默的默认值。
//!
//! ── 硬约束 ──────────────────────────────────────────────────
//! release 是 `panic=abort`：本文件零 unwrap/expect/panic。

use serde_json::Value;

/// 思考等级在请求体里的**唯一**字段名。
///
/// 两条通道都认它：编码套餐通道由 [`apply_to_chat`] 原样归一后发上游；
/// 活动套餐通道由 `plan::build_request` 从同一处读出来交给
/// [`apply_to_anthropic`] 折成 thinking 预算 + `output_config.effort`。
/// 映射绑定的默认档（适配器的 `reasoning_patch`）也写这个键 —— 定义在这里
/// 是为了三处写读同一个字面量，改名时不会漏掉某一条通道。
pub(super) const EFFORT_FIELD: &str = "reasoning_effort";

/// 合法思考等级（上游文档化的三档，见模块头）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Level {
    Low,
    High,
    Max,
}

impl Level {
    /// 发上游的等级字面量（同名的两个协议字段都用它）
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::High => "high",
            Self::Max => "max",
        }
    }

    /// 官方目录给这一档配的思考预算（`thinking.budget_tokens`）
    fn budget(self) -> i64 {
        match self {
            Self::Low => 8_000,
            Self::High => 16_000,
            Self::Max => 32_000,
        }
    }
}

/// 「短输出请求」的判据：客户端给的 `max_tokens` 低于它就按短输出处理。
///
/// 依据是实测的失败面：这类请求（标题生成、摘要、单行补全）的共同点是
/// **要的正文极短**，而思考一开就是几千 token —— 官方默认档（max = 32000）
/// 会把它们从「立刻返回」拖成「先思考三万个 token」。1024 是 Anthropic SDK
/// 自己的思考预算地板值，正好也是「短输出」与「正常对话」的分界。
const SHORT_OUTPUT_TOKENS: i64 = 1024;

/// 短输出请求用的思考预算：SDK 地板值。
///
/// 实测该组合（low + 1024）下模型**连思考块都不出**，直接给正文
/// （"Reply with exactly: OK" 只花 3 个输出 token）—— 既满足「必须思考」
/// 的上游约束，又没有把额度浪费在思考上。
const FLOOR_BUDGET: i64 = 1_024;

/// 本模型是否属于 GLM-5.3 家族（`glm-5.3` / `glm-5.3-flash`，大小写不敏感）。
///
/// 尾随数字要排除（`glm-5.30` 不算 5.3 家族）——参考实现用正则的负向前瞻
/// 表达这件事，而 Rust 的 `regex` crate 不支持前瞻，所以这里手写扫描。
pub(super) fn is_glm53(model: &str) -> bool {
    const NEEDLE: &str = "glm-5.3";
    let lower = model.trim().to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower.get(from..).and_then(|rest| rest.find(NEEDLE)) {
        let end = from + at + NEEDLE.len();
        let next_is_digit = lower
            .get(end..)
            .and_then(|rest| rest.chars().next())
            .is_some_and(|next| next.is_ascii_digit());
        if !next_is_digit {
            return true;
        }
        from = end;
    }
    false
}

/// 客户端给的等级字面量 → 三档。`None` = 客户端没点名（空串与缺省同义）。
///
/// 映射表照抄参考实现的 `normalizeGlm53Effort`，包括两个刻意的取值：
///   · `none` / `minimal` 归到 `low` —— 上游不接受「不思考」，所以「尽量少想」
///     是这些取值唯一能落到的档位（直接透传会被 400 code 1210 拒掉）；
///   · `medium` 归到 `high`（**向上取整**，不是就近），官方映射表如此；
///   · 认不出的取值给 `max`（官方目录的 `defaultLevel`），与「没点名」同档。
pub(super) fn normalize(effort: Option<&str>) -> Option<Level> {
    let raw = effort.map(str::trim).filter(|text| !text.is_empty())?;
    Some(match raw.to_ascii_lowercase().as_str() {
        "none" | "minimal" | "light" | "low" => Level::Low,
        "medium" | "high" => Level::High,
        "xhigh" | "max" | "ultra" => Level::Max,
        _ => Level::Max,
    })
}

/// 定档：客户端点名优先，没点名时按输出额度推。
///
/// 返回 `(等级, 预算)` —— 两者不总是 `level.budget()`：短输出那一档用
/// [`FLOOR_BUDGET`]（见其说明），档位与预算因此要一起给出去。
fn resolve(effort: Option<&str>, client_max_tokens: Option<i64>) -> (Level, i64) {
    if let Some(level) = normalize(effort) {
        return (level, level.budget());
    }
    match client_max_tokens {
        Some(value) if value < SHORT_OUTPUT_TOKENS => (Level::Low, FLOOR_BUDGET),
        // 没点名又不像短输出：按官方目录默认档（max）。这条与官方客户端
        // 行为一致 —— 它在没被点名时也用目录的 defaultLevel。
        _ => (Level::Max, Level::Max.budget()),
    }
}

/// 活动套餐通道（Anthropic 协议）的思考装配。
///
/// 三件事一起做，缺一不可：
///   1. `thinking: {type:"enabled", budget_tokens}` —— 单给 `output_config.effort`
///      是无效的（实测：只发 effort 时上游照旧把额度耗在思考上、正文为空）；
///   2. `output_config: {effort}` —— 参考实现的实测结论是「预算要与等级配对」，
///      只给预算会让上游落回它自己的低默认；
///   3. `max_tokens = 客户端额度 + 预算`（按模型 `maxOutputTokens` 截顶）——
///      这一步是留出正文空间的关键，也是官方客户端的做法（见模块头）。
///
/// 开启思考时 `temperature` / `top_p` / `top_k` 一律删掉：上游拒绝采样参数
/// 与扩展思考并存（通用转换层已按同一口径处理过，这里再守一次是因为**本次**
/// 才真正决定要开思考 —— 客户端没点名等级时通用层什么都没注入）。
///
/// `client_max_tokens` 取**客户端原始请求**里的值（不是转换后的 payload：
/// 通用层可能已经按它自己的档位表抬过一次，那份额度不能当客户端的意图用）。
///
/// 非 5.3 家族直接返回（不做任何改动）—— 通用转换层的行为原样保留。
pub(super) fn apply_to_anthropic(
    payload: &mut Value,
    model: &str,
    effort: Option<&str>,
    client_max_tokens: Option<i64>,
) {
    if !is_glm53(model) {
        return;
    }
    let (level, budget) = resolve(effort, client_max_tokens);
    // 额度基数：客户端给了就用它的，没给就用转换层已经填好的默认值
    // （Anthropic 协议必填 `max_tokens`，通用层填的是 `DEFAULT_MAX_TOKENS`）。
    // 客户端**没给**时通用层不会抬过额度（抬额度只在它自己注入了思考时发生，
    // 而没给等级时它什么也没注入），所以读回来的就是干净默认值。
    let base = client_max_tokens
        .or_else(|| payload.get("max_tokens").and_then(Value::as_i64))
        .filter(|value| *value > 0)
        .unwrap_or(FLOOR_BUDGET);
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    object.insert(
        "thinking".to_string(),
        serde_json::json!({ "type": "enabled", "budget_tokens": budget }),
    );
    object.insert(
        "output_config".to_string(),
        serde_json::json!({ "effort": level.as_str() }),
    );
    for key in ["temperature", "top_p", "top_k"] {
        object.remove(key);
    }
    let ceiling = super::models::max_output(model).unwrap_or(base.saturating_add(budget));
    let total = base.saturating_add(budget).min(ceiling);
    object.insert("max_tokens".to_string(), Value::from(total));
}

/// 编码套餐通道（OpenAI 协议）的思考装配：只把等级归一化后注入。
///
/// 这条通道**不能**做「预算相加」：OpenAI 体里没有 budget 概念，
/// `reasoning_effort` 是唯一的旋钮（实测有效：同一条 prompt 下
/// `low` 只用 3 个思考 token，`max` 用 199 个）。同一条实测也给出了
/// 小额度场景的出路 —— 把等级压到 `low` 之后，16 个 token 的额度里
/// 也留得住正文，所以这里对「短输出且客户端没点名」的情形注 `low`。
///
/// 体里点名了就用它的档位（客户端显式传的、或映射上绑的默认档 —— 两者走到
/// 这里都已经是同一个 [`EFFORT_FIELD`] 键）；没点名又不像短输出则**不注入**
/// （保持上游默认，实测约 100 个思考 token，属于正常量级）——与 Anthropic
/// 那条通道不同，那边「不注入」会让上游按自己的默认想到把额度吃光，这边不会。
pub(super) fn apply_to_chat(body: &mut Value, model: &str) {
    if !is_glm53(model) {
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let effort = object
        .get(EFFORT_FIELD)
        .and_then(Value::as_str)
        .map(str::to_string);
    let client_max = object
        .get("max_tokens")
        .or_else(|| object.get("max_completion_tokens"))
        .and_then(Value::as_i64)
        .filter(|value| *value > 0);
    let level = match normalize(effort.as_deref()) {
        Some(level) => Some(level),
        None if client_max.is_some_and(|value| value < SHORT_OUTPUT_TOKENS) => Some(Level::Low),
        None => None,
    };
    if let Some(level) = level {
        object.insert(
            EFFORT_FIELD.to_string(),
            Value::String(level.as_str().to_string()),
        );
    }
}
