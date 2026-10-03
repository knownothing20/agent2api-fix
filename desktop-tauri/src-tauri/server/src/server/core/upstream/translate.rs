//! 上游**响应协议**的翻译层：上游吐的不是 chat SSE 时，先折成 chat SSE 再下发。
//!
//! ── 为什么在内置家的路径上需要它 ────────────────────────────
//! `ForwardStream` 与聚合器只认**标准 chat SSE**（它们是 SSE 逐行解析的唯一
//! 入口：reasoning 合并、usage 提取、model 回写都挂在那两层）。自定义提供商的
//! 翻译路径（`providers::custom::forward` 的 `ProtocolTranslateStream`）早已
//! 证明了这个结构，但那个实现在 `providers::custom` 下、并且要 slot /
//! connections 两个凭证参数 —— 内置家（ZCode 的活动套餐通道，见
//! `providers::zcode::plan`）由编排层移交凭证，因此这里给一个**不持凭证**的
//! 版本：构造它、交给 `ForwardStream::from_translated` 或聚合器，凭证仍由
//! `provider_loop` 那两处按既有规则处置。
//!
//! ── 与自定义家那条的三个差别（都是刻意的）────────────────────
//!   1. 只服务 **Anthropic** 一种上游协议：内置家里目前只有 ZCode 的活动套餐
//!      通道说 Anthropic，多一层协议分派壳没有第二个消费者；
//!   2. `model` 传**上游真名**（与自定义家一致）：帧里的 `model` 由下游的
//!      回写层按适配器的 `sse_model_rewrite()` 决定要不要改回请求名；
//!   3. 调试采集在这里采**上游原始字节**（翻译前），与 chat 路径「采上游原样
//!      吐出的东西」的语义一致 —— 翻译后的 chat 帧只是网关内部的中间形态。
//!
//! ── 硬盘约束 ────────────────────────────────────────────────
//! release 是 `panic=abort`：本文件零 unwrap/expect/panic。

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::Stream;

use crate::server::core::protocol::anthropic_outbound::ChatFromAnthropicStream;

/// 上游 Anthropic SSE → 标准 chat SSE 的字节流（`reqwest::Response` 直接进来）。
///
/// 管道结构：`响应字节 → 空闲守卫 → 转换器 → 帧队列`。错误在构造时就描述成
/// 文案折进 `io::Error`（与 `ForwardStream::new` 同一手法）：空闲守卫的入参是
/// 这个类型，下游两个消费层拿到的也是同一形态 —— 于是「上游断开」与「流式
/// 空闲超时」在流式路径由 `ForwardStream` 补错误帧收尾、在聚合路径转 502，
/// 与 chat 路径的错误语义逐条相同。
pub struct AnthropicToChatStream {
    /// 上游字节流（已描述错误、已装空闲守卫）
    inner: futures::stream::BoxStream<'static, Result<Bytes, std::io::Error>>,
    /// 协议状态机（上游事件 → chat 帧）
    machine: ChatFromAnthropicStream,
    /// 已翻译待下发的帧（一个上游 chunk 可能产出多帧）
    pending: VecDeque<Bytes>,
    /// 上游已结束（不再 poll 上游，把 pending 与收尾帧吐完即 None）
    upstream_done: bool,
    /// 调试模式的采集器（None = 未开启）
    capture: Option<Arc<crate::server::core::debug_traffic::TrafficCapture>>,
}

impl AnthropicToChatStream {
    /// `model` 是**上游真名**（下发帧里的 `model` 字段，见模块头第 2 条）。
    pub fn new(
        response: reqwest::Response,
        model: &str,
        telemetry: &Arc<super::usage::RequestTelemetry>,
    ) -> Self {
        use futures::StreamExt;
        // reqwest 错误就地描述成文案（折进 io::Error 之后只剩文本可读）；
        // 空闲守卫用设置页「请求超时」的「流式响应空闲超时」那一档 ——
        // 与 chat 路径、自定义家路径三处同源，改设置三处一起变
        let described = response.bytes_stream().map(|item| {
            item.map_err(|error| {
                std::io::Error::other(crate::server::core::egress::describe_error_detail(&error))
            })
        });
        let guarded = super::stall::idle_guard(
            Box::pin(described),
            Duration::from_millis(crate::server::config::timeout_settings().stream_idle_ms()),
        );
        Self {
            inner: guarded,
            machine: ChatFromAnthropicStream::new(model),
            pending: VecDeque::new(),
            upstream_done: false,
            capture: telemetry.capture(),
        }
    }
}

impl Stream for AnthropicToChatStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        use futures::StreamExt;
        loop {
            // 先把转换器攒下的帧发完，再拉上游 —— 顺序反了会让同一个上游 chunk
            // 产出的多帧乱序（工具调用的宣告帧必须先于参数帧）
            if let Some(frame) = self.pending.pop_front() {
                return Poll::Ready(Some(Ok(frame)));
            }
            if self.upstream_done {
                return Poll::Ready(None);
            }
            match self.inner.poll_next_unpin(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    // 上游 EOF：转换器收尾（finish_reason / usage 帧 / [DONE]）
                    self.upstream_done = true;
                    for frame in self.machine.finish() {
                        self.pending.push_back(frame);
                    }
                }
                Poll::Ready(Some(Ok(bytes))) => {
                    if let Some(capture) = &self.capture {
                        capture.push(&bytes);
                    }
                    for frame in self.machine.push(&bytes[..]) {
                        self.pending.push_back(frame);
                    }
                }
                Poll::Ready(Some(Err(error))) => {
                    self.upstream_done = true;
                    // 文案已在构造时描述好（见 inner 字段说明）：原样上抛，
                    // 由下游的流 / 聚合器转成错误帧或 502
                    return Poll::Ready(Some(Err(error)));
                }
            }
        }
    }
}
