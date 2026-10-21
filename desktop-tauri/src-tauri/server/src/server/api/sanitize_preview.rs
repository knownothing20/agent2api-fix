//! 脱敏规则**试算**：`POST /api/sanitize/preview`（dry-run，不改任何东西）。
//!
//! ── 为什么需要它（2026-10-22 用户要求「完善」）──────────────────
//! 规则集是**硬编码**的（7 条特征串 + 3 条正则 + 5 条改写，见 `core::sanitize`），
//! 而客户端指纹与上游黑名单会变。用户遇到「某个客户端被上游 400 拦了」时，
//! 只能靠请求日志里那条「敏」标签猜「是不是脱敏没覆盖到」—— 但日志只在**真的
//! 发过请求**之后才有，而且看不到「如果不改会怎样」。
//!
//! 这个端点把规则集变成可验证的：粘一段文本（system prompt、报文片段都行），
//! 直接回「命中哪几条、各自改成了什么、改完长什么样」。等于把
//! 「规则够不够用」的判断权交给用户，而不用真的发一次请求去撞上游。
//!
//! ── 只读 ────────────────────────────────────────────────────
//! 不写配置、不落库、不计入统计 —— 纯函数调用（`sanitize_text` 无状态无 IO）。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::core::sanitize;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

/// 回显正文的上限：试算的目的是「看改了哪几个词」，不是搬运整份 system prompt。
/// 截断处会带一个明确标记，避免用户以为「后面被删了」。
const OUTPUT_LIMIT: usize = 4000;

/// POST /api/sanitize/preview —— body `{text: "..."}`
pub async fn preview(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let Some(text) = object.get("text").and_then(Value::as_str) else {
        return errors::management_error(400, "缺少 text 字段（字符串）");
    };
    if text.trim().is_empty() {
        return errors::management_error(400, "text 不能为空");
    }

    // 与转发层同一条路径：`sanitize_text` 就是出站时对每条 message 调的那个函数
    let mut hits = sanitize::Hits::default();
    let output = sanitize::sanitize_text(text, &mut hits);
    let entries = hits.into_sorted();

    let truncated = output.chars().count() > OUTPUT_LIMIT;
    let shown: String = if truncated {
        let mut cut: String = output.chars().take(OUTPUT_LIMIT).collect();
        cut.push_str("\n…（已截断，完整长度见 outputChars）");
        cut
    } else {
        output.clone()
    };

    ok_json(json!({
        // 有没有改动 —— 与转发层「改了才落敏标签」同一判据
        "changed": output != text,
        "inputChars": text.chars().count(),
        "outputChars": output.chars().count(),
        // 命中明细：word = 规则标签（改写规则是原文串），to = 改成了什么（null = 整段剥离）
        "hits": entries
            .iter()
            .map(|entry| json!({
                "word": entry.label,
                "to": entry.to,
                "count": entry.count,
            }))
            .collect::<Vec<_>>(),
        // 改写后的正文（截断到 OUTPUT_LIMIT，够看清上下文）
        "output": shown,
        "truncated": truncated,
    }))
}
