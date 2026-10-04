/* Agent2API · CodeArts 每日福利领取（账号页那颗「领福利」按钮）。

   ── 与 ZCode 那颗「领套餐」是两件事，所以另开一个文件 ─────────
   判据位不同（`welfare` vs `claim`）、流程不同（本家**不要**验证码）、
   后端端点也不同。共用一个位会让两边的按钮判据互相污染。

   ── 两步：先只读探测，再由用户明确点一下才发写请求 ────────────
     ① 探测  POST /api/accounts/{id}/codearts-welfare/preview  —— 动作是只读的，一个写请求都不发
     ② 领取  POST /api/accounts/{id}/codearts-welfare          —— 真的去领

   为什么值得先探测：领取是**外部服务的写操作**（点一下账号当天的领取机会就少一次），
   而「今天有什么可领、已经试过几次」这条信息是免费的。先看一眼再动手，
   也让最常见的两种结果（暂无可领 / 今天已经到账）不消耗一次点击。

   ── 后端返回的四种结果都不是错误 ─────────────────────────────
   `官方已确认到账` / `已领取并确认` / `暂无可领取活动` / `等待重试` ——
   只有 HTTP 非 2xx 才当失败处理。特别是第三种：它说的是「这个账号不在活动范围内」，
   不是「网关坏了」，显示成红色会让用户去查一个不存在的问题。

   ── 到账的是什么 ────────────────────────────────────────────
   ops 福利领的是**套餐赠送积分**，**不增加福利模型的 token 池**（两个账户各记各的，
   见后端 providers::codearts::balance 的模块头）。文案照实写，别让人以为
   领完就能多跑福利模型。

   依赖：`window.__TAURI_INTERNALS__.invoke('api_request')`（与 add-provider-forms.js
   的 postAccount 同一个通用入口，不为这两个端点去桥里加具名方法）、
   `window.wbConfirm`、`window.wbApp.{toast, refresh}`。脚本顺序见 index.html。 */
(() => {
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const describeError = error => {
    if (error instanceof Error && error.message) return error.message;
    const text = String(error ?? '').trim();
    return text || '未知错误';
  };

  /** 管理端点的通用调用（POST /api/accounts 在桥里没有具名方法，这里同一口径）。 */
  async function manage(method, path, body) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      throw new Error('桌面运行时不可用（Tauri 未初始化）');
    }
    return internals.invoke('api_request', { request: { method, path, body } });
  }

  /** 一条活动 → 给人看的一行。状态用中文，但保留上游原码（排障时要对得上）。 */
  function describeCampaign(item) {
    const amount = Number(item.benefitAmount) || 0;
    const state = item.confirmed
      ? '已到账'
      : item.localClaimed
        ? '已领取，等官方确认'
        : item.claimable
          ? '可领取'
          : `不可领（${escapeHtml(item.status || '未知')}）`;
    return `<li><b>${amount} ${escapeHtml(item.benefitUnit || '积分')}</b> · ${state}</li>`;
  }

  function summaryHtml(account, preview) {
    const campaigns = preview?.campaigns || [];
    const attemptsLeft = Number(preview?.attemptsLeft ?? 0);
    const waiting = Number(preview?.nextAttemptInMs ?? 0);
    return `账号：<b>${escapeHtml(account?.name || account?.id || '')}</b><br>`
      + `今天（北京时间 ${escapeHtml(preview?.day || '')}）已试 ${preview?.attempts ?? 0} 次，`
      + `还能试 ${attemptsLeft} 次${waiting ? `，下一次最快 ${Math.ceil(waiting / 60000)} 分钟后` : ''}<br>`
      + `<ul class="codearts-welfare-campaigns">${campaigns.map(describeCampaign).join('') || '<li>没有可自动领的活动</li>'}</ul>`
      + '<p class="muted">领到的是<b>套餐赠送积分</b>，不会增加福利模型的 token 池；'
      + '领取按账号计，官方确认后本机会不再重复领。</p>';
  }

  async function start(account) {
    // 失败一律红色 toast；成功与「无事可做」走下面的中性提示
    const fail = message => window.wbApp?.toast?.(message, 'err');
    if (!account?.id) return;
    let preview;
    try {
      preview = await manage('POST', `/api/accounts/${encodeURIComponent(account.id)}/codearts-welfare/preview`, {});
    } catch (error) {
      fail(`探测失败：${describeError(error)}`);
      return;
    }
    if (!preview?.eligible) {
      // 最常见的两种结果不值得让用户多点一次：直接说清楚就收工
      window.wbApp?.toast?.(
        preview?.campaigns?.length
          ? '今天没有需要领的活动（都已到账）'
          : '这个账号当前没有可自动领的活动（只自动领每日登录赠送积分）',
      );
      // 后端在探测到「每日活动都已确认到账」时会顺手把台账补成 accepted
      // （见 welfare::preview 的自愈），刷新一次账号列表让那颗按钮**立刻**变成
      // 「已领」—— 否则按钮一直亮着、点一次弹一句同样的话，看着像功能坏了。
      await window.wbApp?.refresh?.();
      return;
    }
    const ok = await window.wbConfirm?.ask?.({
      title: '领取 CodeArts 每日福利',
      html: summaryHtml(account, preview),
      okText: '领取并让官方确认',
    });
    if (!ok) return;
    let result;
    try {
      result = await manage('POST', `/api/accounts/${encodeURIComponent(account.id)}/codearts-welfare`, {});
    } catch (error) {
      fail(`领取失败：${describeError(error)}`);
      return;
    }
    if (result?.confirmed) {
      window.wbApp?.toast?.(`✅ ${result.result || '官方已确认到账'}`);
    } else {
      // 「已领取并确认」与「等待重试」都是真话，不是失败：用中性提示
      window.wbApp?.toast?.(result?.result || '本次未确认到账');
    }
    await window.wbApp?.refresh?.();
  }

  window.wbCodeArtsWelfare = { start };
})();
