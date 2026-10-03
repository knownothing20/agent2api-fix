/* Agent2API · ZCode「领套餐」的探测与领取（账号页那一列按钮）

   ── 这一家为什么没有「签到」而是这个 ────────────────────────
   其余各家的运营玩法是每日签到（见 core/auto_checkin），ZCode 是**限时发放的
   体验套餐**（官方叫 start-plan，客户端里点一下就领）。因此本家在账号行上
   给的是「领套餐」而不是「签到」。

   ── 每日一期：2026-09-28 起那期（ZCode Trust Build）────────
   活动窗口里**每天换一个新套餐**（plan_id 带日期段：…-trust-0928 → …-0929），
   所以活动期内每天都能领一次。而「已领取过」是上游**按套餐**判的：同一份当天
   再领回 1003，换一份（比如每日额度那份）照样能领 —— 因此本流程逐份比对台账
   （账号页的 `claimedPlanIdsToday`），把今天领过的那几份标出来、只让选还没领的，
   全领过了才提示「明天再来」。一个账号同时挂着几份可领套餐时，用户就能一份份领完。

   ── 两步，而且只有第二步要验证码 ────────────────────────────
     ① 探测  POST /api/accounts/{id}/zcode-claim/preview   —— 只读，不要验证码
     ② 领取  POST /api/accounts/{id}/zcode-claim           —— **要**验证码

   上游的领取接口通常要求 `X-Aliyun-Captcha-Verify-Param`（阿里云无痕验证），
   而解它的唯一可行方式是在 webview 里跑阿里云官方 SDK —— 那正是
   `ui/aliyun-captcha.js` 提供的东西（同一个求解器也给 AutoClaw 的 OAuth 用）。
   要不要弹滑块由上游的风控配置说了算（见第 ③ 步）。

   ── 为什么探测值得单独跑一次 ────────────────────────────────
   探测不需要验证码，所以「当前有没有可领的套餐」这条信息是**免费**的；
   而一旦开始领取就要用户拖一次滑块。先探测再确认，能让用户在动手之前就
   知道有什么可领、值不值得拖 —— 也让「今天没有活动」这种最常见的结果
   不消耗一次人工交互。

   ── 404 与「业务失败」都不是错误（后端已归一）───────────────
     · `deployed: false`（上游活动接口未部署）→ 说一句「当前没有可领套餐」；
     · 领取返回 `ok: false` + `failure`（如 `already_claimed` / `quota_exhausted`
       / `captcha`）→ 按 `failureLabel` 提示。这两种都不该报红。
       只有 HTTP 非 2xx（账号不存在 / 缺 jwt / 网络故障）才当失败处理。

   ── 返回值：把业务结果交回账号页 ────────────────────────────
   `start()` 逐条 return 本次的业务结果（`{ok, failure, planId}` 或 null）。
   调用方（accounts-data.ts 的 startZcodeClaim）据此决定要不要刷余额与账号状态：
   领到东西、以及「已领过」都会改变余额读数与那颗按钮的状态。

   依赖：`window.workbuddyDesktop`（桥接方法，见 web_shim.rs 的
   zcodeClaim* 三个）、`window.wbAliyunCaptcha`、`window.wbConfirm`、
   `window.wbApp.toast`。脚本顺序见 index.html。 */
(() => {
  const bridge = () => window.workbuddyDesktop;

  const describeError = error => {
    if (error instanceof Error && error.message) return error.message;
    const text = String(error ?? '').trim();
    return text || '未知错误';
  };

  /** 权益的周期 → 给人看的一小段（每日额度与一次性活动额度要能分开） */
  function describePeriod(period) {
    const value = String(period || '').trim().toLowerCase();
    if (value === 'daily') return '每日';
    if (value === 'monthly') return '每月';
    if (value === 'weekly') return '每周';
    return '';
  }

  /** 一条套餐的可读内容（名字 / 有效期 / 权益 / 描述），不含外层的 `<li>` */
  function planBody(plan, mark) {
    const window_ = [formatTime(plan.startsAt), formatTime(plan.endsAt)]
      .filter(Boolean)
      .join(' → ');
    const grants = (plan.entitlements || [])
      .map(item => {
        const quota = Number(item.grantUnits) > 0
          ? ` ${formatUnits(item.grantUnits)} ${item.unitType || ''}`.trimEnd()
          : '';
        const period = describePeriod(item.period);
        return `${escapeHtml(item.showName || '')}${quota}${period ? `（${period}）` : ''}`;
      })
      .filter(Boolean);
    return `<b>${escapeHtml(plan.name || plan.planId || '套餐')}</b>${mark || ''}`
      + (window_ ? `（${escapeHtml(window_)}）` : '')
      + (grants.length ? `<br><span class="muted">${grants.join(' · ')}</span>` : '')
      + (plan.description ? `<br><span class="muted">${escapeHtml(plan.description)}</span>` : '');
  }

  /** 一条套餐 → 只读的一行（只有一个可领套餐时用它列出） */
  function describePlan(plan) {
    return `<li>${planBody(plan)}</li>`;
  }

  /**
   * 一条套餐 → **可选**的一行（多套餐时用它出单选）。
   *
   * `checked` 是默认选中项（可领的那几份里优先级最高的那个）。
   * `claimedToday` 为真时：圆钮 `disabled`、整行压暗、名字后面标「今日已领」——
   * 上游的「已领取过」是**按套餐**判的（同一份再领回 1003），所以这里必须逐份标，
   * 只把还没领的那些留给用户选；否则「今天领过 A」会把 B 也一起堵死。
   *
   * label 包住圆钮与说明，点文字也能选中；`name` 固定成 `zcode-claim-plan`，
   * 外面的 change 监听按它认这一次选择。
   */
  function describePlanOption(plan, checked, claimedToday) {
    const mark = claimedToday ? ' <span class="zcode-claim-taken">（今日已领）</span>' : '';
    return `<li><label class="zcode-claim-option${claimedToday ? ' taken' : ''}">`
      + `<input type="radio" name="zcode-claim-plan" value="${escapeHtml(plan.planId || '')}"`
      + `${checked ? ' checked' : ''}${claimedToday ? ' disabled' : ''}>`
      + `<span>${planBody(plan, mark)}</span>`
      + '</label></li>';
  }

  /** 额度 → 紧凑串（`100000000` → `1亿`）：活动发的就是这种 9 位数，原样显示读不动 */
  function formatUnits(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value ?? '');
    const compact = (scaled, suffix) => {
      const text = scaled.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
      return `${text}${suffix}`;
    };
    if (Math.abs(number) >= 1e8) return compact(number / 1e8, '亿');
    if (Math.abs(number) >= 1e4) return compact(number / 1e4, '万');
    return String(number);
  }

  /** unix 秒 → 本地可读时间（后端给的一律是秒，不是毫秒） */
  function formatTime(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return '';
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 走完一次「探测 → 确认 → 验证码 → 领取」。
   *
   * `account` 是账号行对象（要用它的 `id` / `name` 与领取台账）。
   * `claimedPlanIds` 是**今天已经领过的套餐 id**（判定在账号页域层的
   * `claimedPlanIdsToday`，那边管着北京时间这个日界）—— 逐份比它才能知道
   * 「还能领哪几份」，而不是笼统地按「今天领过了」把整件事堵死。
   * 返回值是本次的业务结果（见文件头）：调用方拿它决定要不要刷新余额与行状态。
   */
  async function start(account, claimedPlanIds) {
    const api = bridge();
    const accountId = String(account?.id || '');
    if (!accountId) {
      window.wbApp.toast('账号信息不完整，请刷新后重试', 'warn');
      return null;
    }
    if (!api?.zcodeClaimPreview || !api?.zcodeClaim) {
      window.wbApp.toast('当前环境不支持领取（桥接方法缺失）', 'warn');
      return null;
    }

    // ── ① 探测（不要验证码）──────────────────────────────────
    let preview;
    try {
      preview = await api.zcodeClaimPreview(accountId);
    } catch (error) {
      window.wbApp.toast(`探测套餐失败：${describeError(error)}`, 'warn');
      return null;
    }
    if (!preview?.deployed) {
      // 上游活动接口还没部署 —— 活动开抢前的**正常**状态，不是错误
      window.wbApp.toast('当前没有可领取的套餐（活动尚未开始）');
      return null;
    }
    const plans = Array.isArray(preview.plans) ? preview.plans : [];
    if (plans.length === 0) {
      window.wbApp.toast('当前没有可领取的套餐');
      return null;
    }

    // ── ② 逐份比对「今天领过没」，只把还没领的留给用户选 ──────
    // 上游的「已领取过」是**按套餐**判的（同一份再领回 1003），所以一份领过了
    // 不影响另一份 —— 台账里记着的那些标成「今日已领」且不可选，剩下的照常能领。
    const claimedToday = new Set(
      (Array.isArray(claimedPlanIds) ? claimedPlanIds : []).map(String),
    );
    const options = plans.map(plan => ({
      plan,
      claimed: claimedToday.has(String(plan.planId || '')),
    }));
    const selectable = options.filter(item => !item.claimed);
    if (selectable.length === 0) {
      // 全领过了：不弹窗、不报错（这是正常状态，不是失败）
      window.wbApp.toast('今天这些套餐都已领取过；活动按自然日发新套餐，明天可再领');
      return null;
    }
    // 默认目标：可领的那几份里优先级最高的那个（后端在 planId 为空时也是这个口径）
    const byPriority = [...selectable]
      .map(item => item.plan)
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
    const target = byPriority[0];

    // ── ③ 让用户看清楚要拖一次滑块（并在多选时挑一份），再动手 ──
    // 多份时给一组单选（已领的那些置灰并标出），点确认后按选中的那份领取；
    // 只有一份可领时保持原样，只把名字写进按钮文案。
    //
    // 选择结果靠 document 上的 change 监听读回：确认框的 HTML 是**原样注入**的
    // （见 confirm-dialog.tsx），里面的原生圆钮归浏览器管，弹窗关掉就没了 ——
    // 读 DOM 必须在它卸载之前，所以监听装在 ask 之前、拆在 finally 里。
    const pickable = options.length > 1;
    let picked = target.planId || '';
    const rememberPick = event => {
      const el = event.target;
      if (el && el.name === 'zcode-claim-plan') picked = String(el.value || '');
    };
    if (pickable) document.addEventListener('change', rememberPick, true);

    const claimedNote = options.some(item => item.claimed)
      ? '<p class="muted">标「今日已领」的那几份今天已经领过了，可以改选其他还没领的。</p>'
      : '';
    let ok;
    try {
      ok = await window.wbConfirm?.ask?.({
        title: '领取 ZCode 限时套餐',
        html: `账号：<b>${escapeHtml(account.name || accountId)}</b><br>`
          + (pickable
            ? `选择要领取的套餐：<ul class="zcode-claim-plans pickable">${
              options.map(item => describePlanOption(item.plan, item.plan === target, item.claimed)).join('')}</ul>`
            : `可领取的套餐：<ul class="zcode-claim-plans">${options.map(item => describePlan(item.plan)).join('')}</ul>`)
          + claimedNote
          + '<p class="muted">官方要求一次人机验证（滑块），完成后即可领取。'
          + '活动期内每天发一份新套餐，同一份当天重复领取会提示「已领取过」，次日可再领。</p>',
        okText: pickable ? '领取所选套餐' : `领取「${escapeHtml(target.name || target.planId || '套餐')}」`,
      });
    } finally {
      if (pickable) document.removeEventListener('change', rememberPick, true);
    }
    if (!ok) return null;
    // 选中的那个（单选没读到就回落到默认目标：`planId` 认不出时上游那边也会报错，
    // 而回落到默认目标正是「用户没动过选择」的正常情形）
    const chosen = plans.find(plan => plan.planId && plan.planId === picked) || target;

    // ── ④ 要不要滑块，由上游的风控配置说了算 ─────────────────
    // `enabled: false` = 上游此刻不要人机验证 → **直接领**（后端允许不带
    // 验证码参数，只在该有值时发那个头）。硬弹一次滑块会让用户在本不需要
    // 验证的时候被拦一道，而且滑块可能根本初始化不出来。
    let captchaConfig = { enabled: false };
    try {
      captchaConfig = await api.zcodeClaimCaptchaConfig(accountId) || { enabled: false };
    } catch (error) {
      // 取配置失败不等于不能领：按「不需要验证码」试一次，上游要的话会回
      // 3007，那时再如实告诉用户「验证码校验未通过」
      window.wbApp.toast(`获取风控配置失败，将直接尝试领取：${describeError(error)}`, 'warn');
    }

    const callClaim = captchaVerifyParam => api.zcodeClaim(
      accountId,
      chosen.planId || '',
      captchaVerifyParam || '',
      captchaConfig.region || '',
    );

    // 不需要验证码：一次请求就完事
    if (!captchaConfig?.enabled) {
      try {
        return reportOutcome(await callClaim(''));
      } catch (error) {
        window.wbApp.toast(`领取失败：${describeError(error)}`, 'warn');
        return null;
      }
    }

    // ── ⑤ 需要验证码：滑块 → 拿 verifyParam 直接领取 ──────────
    // 注意与 AutoClaw 的 OAuth 不同 —— 那边拿到串之后是去换授权地址、再开窗口
    // 等回调（长流程，必须放在 solve 之外）；这里是**拿串直接领取**，全部动作
    // 都在 `request` 回调里完成，因此不存在「长流程被 120 秒验证码超时误杀」
    // 的问题（见 aliyun-captcha.js 里 solve 的说明）。
    const captcha = window.wbAliyunCaptcha;
    if (!captcha) {
      window.wbApp.toast('验证码组件未加载，请重启应用后重试', 'warn');
      return null;
    }

    let outcome;
    try {
      outcome = await captcha.solve(
        {
          region: captchaConfig.region || 'ga',
          prefix: captchaConfig.prefix,
          sceneId: captchaConfig.sceneId,
        },
        async captchaVerifyParam => {
          const result = await callClaim(captchaVerifyParam);
          // 业务结果借返回值带回上层（`solve` 会原样 resolve 它）
          return { captchaResult: true, bizResult: true, result };
        },
      );
    } catch (error) {
      // 用户主动取消验证码不算失败（与 AutoClaw 登录那边同一处置）
      if (error instanceof captcha.CaptchaCancelledError) {
        window.wbApp.toast('已取消领取');
        return null;
      }
      window.wbApp.toast(`领取失败：${describeError(error)}`, 'warn');
      return null;
    }
    return reportOutcome(outcome?.result);
  }

  /**
   * 领取结果 → 提示 + 返回值。
   *
   * 业务失败按后端给的 `failureLabel` 提示（中文已由后端归一，前端不再按
   * `failure` 键自己写一套文案 —— 那样两处会漂移）。
   * 返回值原样透出后端那份结果（账号页据此刷余额 / 按钮状态）。
   */
  function reportOutcome(result) {
    if (!result) return null;
    if (result.ok) {
      const window_ = [formatTime(result.startsAt), formatTime(result.endsAt)]
        .filter(Boolean)
        .join(' → ');
      window.wbApp.toast(
        `✅ 领取成功：${result.planId || ''}${window_ ? `（${window_}）` : ''}`,
      );
      // 领到的额度**不在**默认那条转发通道上（编码套餐走开放平台、活动套餐走
      // 官方活动端点），所以顺手说一句去哪儿切 —— 否则用户领完直接发请求，会
      // 拿到「套餐已到期」而完全不知道这回事（见 providers::zcode::plan）
      window.wbApp.toast(
        '这份额度走「活动套餐」通道：若转发时提示编码套餐已到期，'
        + '在账号设置里把「使用套餐」切到活动套餐即可',
      );
      return result;
    }
    const label = result?.failureLabel || '未领取成功';
    window.wbApp.toast(`${label}${result?.message ? `：${result.message}` : ''}`, 'warn');
    return result;
  }

  // 「这个账号有没有领取能力」的判据**不在这里** —— 它走账号页的能力表
  // （accounts-domain.ts 的 `claim` 位 + 后端给的 `canClaim`，见 `supportsClaim`）。
  // 本模块只负责「发起一次领取」。
  window.wbZcodeClaim = { start };
})();
