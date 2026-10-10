//! `/api/accounts/usage` 的实现（**薄壳**：查询逻辑已下沉到
//! `core::usage_query`，见那里的模块头）。
//!
//! 本文件只做三件事：解析 `?id=`、调 core 拿结果、把 `TargetError` 转成管理
//! 信封的响应。目标集合解析、跨账号并发、单账号失败收敛、401 的刷新重试全在 core
//! ——「定时查询积分」也要走同一份逻辑，而它不认识 axum。
//!
//! ── `?id=` 与批量是两条语义 ─────────────────────────────
//! 不带 `id` = 批量（目标集合是「全部**可用**账号」，供工具栏的「查询积分」
//! 与定时任务）；带 `id` = 查这一个账号（账号页每一行的「积分」按钮走这条）。
//! **两条都不看启用状态**：禁用只表示「不参与转发」，与其余额能否查无关 ——
//! 按启用状态把批量挡掉，界面只会让那些行永远停在「未查询」，用户只能逐个手点
//! （那正是「定时查询看起来没生效」的来源）。凭证不完整的账号（available:false）
//! 仍在批量目标之外，`skipped` 记的就是它们的数量。
//! 判据落在 `core::usage_query::query_all` 的 `id` 参数上（那一段有完整说明）。
//!
//! ── 额外的一条：定时查询的结果快照 ─────────────────────────
//! `GET /api/accounts/usage/snapshot` 读 `core::usage_query` 里的内存快照，
//! 供界面在**不点按钮**的情况下拿到定时那一轮的最新余额（含失败行）。

use axum::response::Response;
use serde_json::Value;

use crate::server::core::usage_query;
use crate::server::errors::management_error;
use crate::server::http::{ok_json, query_param};
use crate::server::ServerState;

/// GET /api/accounts/usage
///
/// 逐账号并发查询余额 / 积分汇总（`{ results: [{id,name,usage,error,code?}], skipped }`）。
/// 用户手动点「查询积分」走这条；`?id=` 则只查那一个账号（单行「积分」按钮）。
/// 查询行为见 `core::usage_query::query_all`。
pub async fn accounts_usage(state: &ServerState, query: &str) -> Response {
    // 空串与缺失同义（前端 `''` 时不带 id），所以这里 filter 掉空值再往下传
    let id = query_param(query, "id").filter(|value| !value.is_empty());
    match usage_query::query_all(state.store(), id.as_deref()).await {
        Ok(report) => {
            // 查询结果**一律**同步进快照：账号页读的是快照（`/usage/snapshot`），
            // 不落盘的话，用户点完「查询余额」看到新值、**一刷新又变回上一轮的旧值**
            // （新账号显示「未查询」）—— 2026-10-04 与 2026-10-10 两次用户实测报的都是这个。
            //
            // 两条路径的写法不同，因为语义不同：
            //   · 批量（`id.is_none()`）：这一批就是「全部可用账号」的完整结果 ⇒ **整体替换**；
            //   · 单查（`?id=`）：只拿到一条 ⇒ **按 id 合并**进现有快照。原先单查干脆不动
            //     快照（注释理由是「一次针对性查询不代表整批刚查过」），但快照的用途是
            //     「界面读余额」而不是「标记这一批查过」—— 单查的结果同样是有效数据，
            //     不合并就会让行内按钮变成「刷新即失效」。整体替换更不行：会把其他行抹掉。
            if id.is_none() {
                usage_query::store_snapshot(report.clone());
            } else {
                let rows = report
                    .get("results")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                usage_query::merge_snapshot(rows);
            }
            ok_json(report)
        }
        Err(error) => management_error(error.status_code as i32, error.message),
    }
}

/// GET /api/accounts/usage/snapshot
///
/// 最近一次**定时查询**的结果快照
/// （`{ at, results: [...], skipped }`，`at` 是毫秒时间戳、0 表示本进程还没查过）。
///
/// 形状与 `/api/accounts/usage` 的响应**逐字一致**（多一个 `at`）：
/// 前端因此可以用同一个 `applyBalances` 写缓存，不必为「手动」与「定时」两条
/// 来源各写一套解析。多出来的 `at` 只用于「这份快照我应用过了没」的判断。
pub async fn accounts_usage_snapshot() -> Response {
    ok_json(usage_query::snapshot())
}
