(function () {
  "use strict";

  const TOKEN_KEY = "ggcdc-oa-token";

  const moduleMeta = {
    dashboard: { icon: "⌂", title: "工作台", subtitle: "待办、申请、通知和常用功能入口" },
    platform: { icon: "▦", title: "基础平台", subtitle: "组织架构、用户、角色和流程配置" },
    leave: { icon: "休", title: "请假管理", subtitle: "请假申请、审批、状态跟踪和统计" },
    trip: { icon: "差", title: "出差管理", subtitle: "出差申请、审批、状态跟踪和统计" },
    vehicle: { icon: "车", title: "用车管理", subtitle: "用车申请、审批、车辆台账和行车记录" },
    document: { icon: "文", title: "公文管理", subtitle: "收文、发文、审批、分发和归档" },
    stats: { icon: "析", title: "统计分析", subtitle: "请假、出差、用车和收发文统计导出" },
    logs: { icon: "志", title: "操作日志", subtitle: "登录、审批和业务操作审计" },
  };

  // 类别与扩展字段改为从后端表单定义（form_definitions）动态加载；以下为兜底默认值。
  let categoryOptions = {
    leave: ["事假", "病假", "年假", "婚假", "产假", "丧假", "调休", "其他"],
    trip: ["市内出差", "区内出差", "省内出差", "省外出差"],
    vehicle: ["公务用车", "下乡采样", "会议用车", "应急用车"],
  };

  let requestFields = {
    leave: [],
    trip: [
      { key: "destination", label: "出差地点", required: true },
      { key: "companions", label: "同行人员" },
      { key: "transport", label: "交通方式" },
    ],
    vehicle: [
      { key: "destinationDetail", label: "用车去向", required: true },
      { key: "passengers", label: "乘车人员", required: true },
      { key: "passengerCount", label: "乘车人数", required: true },
      { key: "startDateTime", label: "用车开始时间", required: true },
      { key: "endDateTime", label: "用车结束时间", required: true },
      { key: "durationHours", label: "用车小时数" },
      { key: "waitLocation", label: "候车地点", required: true },
      { key: "deptSuggestion", label: "无中心车时科室建议" },
      { key: "internalContact", label: "本单位联系人" },
      { key: "internalPhone", label: "本单位联系电话" },
      { key: "externalContact", label: "外单位联系人" },
      { key: "externalPhone", label: "外单位联系电话" },
      { key: "otherRequirement", label: "其他要求" },
      { key: "preassignDriver", label: "调度驾驶员" },
      { key: "preassignVehicleId", label: "调度车号" },
      { key: "remark", label: "备注" },
    ],
  };

  // 申请类业务的标准字段（固定 UI 处理），其余字段进入 fields_json。
  const STD_FIELD_KEYS = ["category", "startDate", "endDate", "reason"];
  const formCache = {};
  let bizTypes = {}; // code -> business type（含自定义类型），用于菜单路由与渲染

  const PRESET_CODES = ["leave", "trip", "vehicle", "document"];
  async function loadBizTypes() {
    try {
      const r = await api("/api/business-types");
      bizTypes = {};
      (r.items || []).forEach((b) => { bizTypes[b.code] = b; });
    } catch (e) { /* 忽略 */ }
  }
  // 自定义业务类型 = 业务类型存在、非预置四类、且不是系统视图
  function isCustomType(code) {
    return !!bizTypes[code] && !PRESET_CODES.includes(code);
  }

  // 拉取业务类型的启用表单，派生 categoryOptions / requestFields，使设计器改动即时生效。
  async function loadBusinessForms(types = ["leave", "trip", "vehicle"]) {
    await Promise.all(types.map(async (t) => {
      try {
        const r = await api(`/api/business-types/${t}/form`);
        const schema = (r.form && r.form.schema) || [];
        formCache[t] = schema;
        const catField = schema.find((f) => f.key === "category");
        if (catField) categoryOptions[t] = catField.options || [];
        requestFields[t] = schema.filter((f) => !STD_FIELD_KEYS.includes(f.key))
          .map((f) => ({ key: f.key, label: f.label, required: f.required, type: f.type, textarea: f.type === "textarea", options: f.options || [] }));
      } catch (e) { /* 后端无表单时用内置默认 */ }
    }));
  }

  async function ensureForms(type) {
    if (!formCache[type]) await loadBusinessForms([type]);
  }

  // 按字段类型渲染一个表单控件（动态表单渲染器）。
  function renderSchemaField(f) {
    const req = f.required ? "required" : "";
    const star = f.required ? " *" : "";
    const today = new Date().toISOString().slice(0, 10);
    const label = escapeHtml(f.label);
    if (f.textarea || f.type === "textarea") return `<label class="full">${label}${star}<textarea name="fld_${f.key}" ${req}></textarea></label>`;
    if (f.type === "select") return `<label>${label}${star}<select name="fld_${f.key}" ${req}>${(f.options || []).map((o) => `<option>${escapeHtml(o)}</option>`).join("")}</select></label>`;
    if (f.type === "date") return `<label>${label}${star}<input type="date" name="fld_${f.key}" value="${today}" ${req} /></label>`;
    if (f.type === "number") return `<label>${label}${star}<input type="number" name="fld_${f.key}" ${req} /></label>`;
    if (f.type === "datetime") return `<label>${label}${star}<input type="datetime-local" name="fld_${f.key}" ${req} /></label>`;
    return `<label>${label}${star}<input name="fld_${f.key}" ${req} /></label>`;
  }

  let token = localStorage.getItem(TOKEN_KEY);
  let session = null;
  let modules = [];
  let activeView = "dashboard";
  let directoryCache = null;
  let pickerDirectoryCache = null;
  // 用户管理（规模化）筛选/分页状态与上下文
  const userMgrState = { page: 1, pageSize: 20, keyword: "", deptId: "", roleId: "", status: "", sortBy: "id", sortDir: "asc" };
  let userMgrCtx = { departments: [], roles: [] };

  const $ = (id) => document.getElementById(id);
  const loginPanel = $("loginPanel");
  const appShell = $("appShell");
  const moduleNav = $("moduleNav");
  const viewRoot = $("viewRoot");
  const pageTitle = $("pageTitle");
  const pageSubtitle = $("pageSubtitle");
  const currentUserName = $("currentUserName");
  const currentUserRole = $("currentUserRole");

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function nowLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toISO(localValue) {
    if (!localValue) return undefined;
    const d = new Date(localValue);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  function fmtTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function api(path, options) {
    const isFormData = options && options.body instanceof FormData;
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...((options && options.headers) || {}),
      },
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      if (response.status === 401) logout(false);
      throw new Error((data && data.message) || "请求失败");
    }
    return data;
  }

  function statusText(status) {
    return { pending: "待审批", approved: "已通过", rejected: "已驳回", withdrawn: "已撤回", draft: "草稿" }[status] || status;
  }
  function accountStatusText(status) {
    return { active: "启用", disabled: "禁用" }[status] || status;
  }
  function typeText(type) {
    return { leave: "请假", trip: "出差", vehicle: "用车" }[type] || type;
  }
  function approverTypeText(t) {
    return { dept_leader: "本部门负责人", role: "指定角色", user: "指定人员" }[t] || t;
  }
  function canApprove() {
    if (!session) return false;
    if (session.canApprove != null) return !!session.canApprove;
    return ["admin", "leader", "director", "vice_director"].includes(session.roleCode);
  }
  function hasModule(code) {
    return modules.some((item) => item.code === code);
  }

  async function getDirectory() {
    if (directoryCache) return directoryCache;
    directoryCache = await api("/api/directory");
    return directoryCache;
  }

  // 业务表单挑同事用：任何登录用户都能拉到 id/姓名/部门
  // 与 getDirectory 拆开，避免普通员工被审批权限挡在表单门外。
  async function getPickerDirectory() {
    if (pickerDirectoryCache) return pickerDirectoryCache;
    pickerDirectoryCache = await api("/api/directory/picker");
    return pickerDirectoryCache;
  }

  function setPageMeta() {
    let meta = moduleMeta[activeView];
    if (!meta) {
      const bt = bizTypes[activeView];
      const mod = modules.find((m) => m.code === activeView);
      meta = { title: (bt && bt.name) || (mod && mod.name) || "工作台", subtitle: bt ? "自定义业务申请、审批与查询" : "" };
    }
    pageTitle.textContent = meta.title;
    pageSubtitle.textContent = meta.subtitle;
  }

  function renderNav() {
    moduleNav.innerHTML = modules.map((item) => {
      const meta = moduleMeta[item.code] || { icon: "·", title: item.name };
      return `<button class="nav-item ${activeView === item.code ? "active" : ""}" data-view="${item.code}">
        <span>${meta.icon}</span><span>${escapeHtml(meta.title)}</span></button>`;
    }).join("");
  }

  async function setView(view) {
    activeView = hasModule(view) ? view : "dashboard";
    setPageMeta();
    renderNav();
    await renderView();
  }

  async function renderView() {
    try {
      if (activeView === "dashboard") return await renderDashboard();
      if (activeView === "platform") return await renderPlatform();
      if (activeView === "leave") return await renderBusiness("leave");
      if (activeView === "trip") return await renderBusiness("trip");
      if (activeView === "vehicle") return await renderVehicle();
      if (activeView === "document") return await renderDocuments();
      if (activeView === "stats") return await renderStats();
      if (activeView === "logs") return await renderLogs();
      if (isCustomType(activeView)) return await renderInstanceBusiness(activeView);
    } catch (error) {
      viewRoot.innerHTML = `<section class="panel"><div class="empty">${escapeHtml(error.message)}</div></section>`;
    }
  }

  /* ---------------- 工作台 ---------------- */

  // 工作台底部「待办面板」的当前过滤态：默认显示我的待办；点统计卡片可切换
  let dashboardJump = "myPending"; // myPending | pendingRequests | approvedRequests

  async function renderDashboard() {
    const dashboard = await api("/api/dashboard");
    viewRoot.innerHTML = `
      <div class="grid cols-4">
        ${statCard("我的待办", dashboard.stats.myPending, "待", "myPending", "看我当前需要审批/处理的单据")}
        ${statCard("可见待审", dashboard.stats.pendingRequests, "审", "pendingRequests", "看我权限范围内全部待审批单据")}
        ${statCard("已办申请", dashboard.stats.approvedRequests, "办", "approvedRequests", "看已通过的申请清单")}
        ${statCard("公文流转", dashboard.stats.documents, "文", "documents", "进入公文管理")}
      </div>
      <div class="grid cols-2" style="margin-top:16px;align-items:start">
        <div class="dash-col" style="display:flex;flex-direction:column;gap:16px">
          <section class="panel">
            <div class="panel-header"><h2>快捷申请</h2></div>
            <div class="panel-body"><div class="quick-actions">
              ${quickButton("leave", "休", "请假申请")}
              ${quickButton("trip", "差", "出差申请")}
              ${quickButton("vehicle", "车", "用车申请")}
              ${hasModule("document") && canApprove() ? `<button class="quick-action" data-create-doc="收文"><b>文</b><span>收文登记</span></button>` : ""}
            </div></div>
          </section>
          <section class="panel" id="dashboardTodo">
            <div class="panel-header"><h2 id="dashboardTodoTitle">${dashboardJumpTitle(dashboardJump)}</h2><span class="muted" id="dashboardTodoHint"></span></div>
            <div class="panel-body" id="dashboardTodoBody"><div class="empty">加载中…</div></div>
          </section>
        </div>
        <section class="panel">
          <div class="panel-header"><h2>通知公告</h2>${session && session.roleCode === "admin" ? `<button class="link" data-go-notices>管理公告</button>` : ""}</div>
          <div class="panel-body"><div class="notice-list">
            ${(dashboard.notices || []).length ? dashboard.notices.map(noticeRow).join("") : `<div class="empty">暂无公告</div>`}
          </div></div>
        </section>
      </div>`;
    bindActions();
    // 统计卡片点击：公文流转直接进入公文管理；其余切换底部待办面板
    viewRoot.querySelectorAll("[data-stat-jump]").forEach((card) => {
      card.addEventListener("click", () => {
        const key = card.dataset.statJump;
        if (key === "documents") return setView("document");
        dashboardJump = key;
        viewRoot.querySelectorAll("[data-stat-jump]").forEach((c) => c.classList.toggle("active", c.dataset.statJump === key));
        $("dashboardTodoTitle").textContent = dashboardJumpTitle(key);
        loadDashboardTodo(key);
      });
    });
    // 管理员入口：点「管理公告」直接进入「基础平台 → 通知公告」
    const goNotices = viewRoot.querySelector("[data-go-notices]");
    if (goNotices) goNotices.addEventListener("click", () => { platformTab = "notices"; setView("platform"); });
    // 初次进入：默认显示「我的待办」
    viewRoot.querySelector(`[data-stat-jump="${dashboardJump}"]`)?.classList.add("active");
    await loadDashboardTodo(dashboardJump);
  }

  function dashboardJumpTitle(key) {
    return { myPending: "我的待办", pendingRequests: "可见待审", approvedRequests: "已办申请" }[key] || "我的申请";
  }

  // 工作台「待办面板」按统计卡片切换数据源
  async function loadDashboardTodo(key) {
    const body = $("dashboardTodoBody");
    const hint = $("dashboardTodoHint");
    if (!body) return;
    body.innerHTML = `<div class="empty">加载中…</div>`;
    try {
      let qs = "pageSize=20";
      if (key === "myPending") { qs += "&status=pending&mine=1"; if (hint) hint.textContent = "等待我审批的全部业务申请"; }
      else if (key === "pendingRequests") { qs += "&status=pending"; if (hint) hint.textContent = "权限范围内的全部待审单据"; }
      else if (key === "approvedRequests") { qs += "&status=approved"; if (hint) hint.textContent = "近期已通过的申请"; }
      const data = await api(`/api/requests?${qs}`);
      body.innerHTML = renderRequestTable(data.items || []);
      bindRowActions(body);
    } catch (err) {
      body.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function noticeRow(item) {
    const who = item.created_by_name ? ` · 发布人 ${escapeHtml(item.created_by_name)}` : "";
    return `<div class="notice-item"><strong>${escapeHtml(item.title)}</strong>
      <div class="muted">${escapeHtml(item.published_at)} · ${escapeHtml(item.scope)}${who}</div>
      <p>${escapeHtml(item.content)}</p></div>`;
  }

  function statCard(label, value, icon, jumpKey, tip) {
    const jump = jumpKey ? ` data-stat-jump="${jumpKey}" role="button" tabindex="0" title="${escapeHtml(tip || "")}"` : "";
    return `<section class="panel stat clickable"${jump}><div><span>${label}</span><strong>${value || 0}</strong></div><div class="stat-icon">${icon}</div></section>`;
  }
  function quickButton(type, icon, text) {
    return hasModule(type) ? `<button class="quick-action" data-create="${type}"><b>${icon}</b><span>${text}</span></button>` : "";
  }

  /* ---------------- 基础平台 ---------------- */

  const platformTabs = [
    ["org", "组织架构"],
    ["users", "用户管理"],
    ["workflow", "流程配置"],
    ["forms", "表单配置"],
    ["roles", "角色与权限"],
    ["notices", "通知公告"],
    ["annual", "年假台账"],
  ];
  let platformTab = "org";
  let platformData = null;

  async function renderPlatform() {
    const [departments, rolesData, workflows, directory, businessTypes] = await Promise.all([
      api("/api/departments"), api("/api/roles"), api("/api/workflows"), getDirectory(), api("/api/business-types?all=1"),
    ]);
    platformData = { departments, rolesData, workflows, directory, businessTypes: businessTypes.items || [] };
    userMgrCtx = { departments, roles: rolesData.roles };
    renderPlatformShell();
  }

  function renderPlatformShell() {
    viewRoot.innerHTML = `
      <div class="subtabs">${platformTabs.map(([k, l]) => `<button class="subtab ${platformTab === k ? "active" : ""}" data-ptab="${k}">${escapeHtml(l)}</button>`).join("")}</div>
      <div id="platformPanel"></div>`;
    viewRoot.querySelectorAll("[data-ptab]").forEach((b) => b.addEventListener("click", () => { platformTab = b.dataset.ptab; renderPlatformShell(); }));
    renderPlatformSection();
  }

  function renderPlatformSection() {
    const panel = $("platformPanel");
    if (!panel || !platformData) return;
    const { departments, rolesData, workflows, directory, businessTypes } = platformData;
    if (platformTab === "org") {
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-header"><h2>组织架构</h2><div class="row-actions"><button class="secondary" data-admin="import-dept">批量导入</button><button class="secondary" data-admin="department">新增部门</button></div></div>
          <div class="panel-body"><p class="muted" style="margin:0 0 12px; line-height:1.7"><b>平级部门</b>（同一上级下）并列展示并按排序号排列；<b>子部门</b>缩进显示在其上级下方。新增时不选「上级部门」即为顶级部门。可逐个「新增部门」或「批量导入」。<b>「排序号」</b>决定同一层级内部门的先后，<b>数字越小越靠前</b>（如 1 在 2 前面）。</p><div class="dept-tree">${renderDeptTree(departments)}</div></div>
        </section>`;
      panel.querySelector("[data-admin='department']").addEventListener("click", () => openDepartmentForm(departments));
      panel.querySelector("[data-admin='import-dept']").addEventListener("click", () => openImportForm("departments"));
      panel.querySelectorAll("[data-edit-dept]").forEach((b) => b.addEventListener("click", () => openDepartmentForm(departments, b.dataset.editDept)));
      panel.querySelectorAll("[data-del-dept]").forEach((b) => b.addEventListener("click", () => deleteDepartment(b.dataset.delDept)));
    } else if (platformTab === "users") {
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-header"><h2>用户管理</h2><span class="muted">搜索 · 部门/角色/状态筛选 · 分页 · 批量操作</span></div>
          <div class="panel-body"><div id="userManager"><div class="empty">加载中…</div></div></div>
        </section>`;
      renderUserManager();
    } else if (platformTab === "workflow") {
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-header"><h2>流程配置</h2><button class="secondary" data-admin="workflow">设计流程</button></div>
          <div class="panel-body"><div class="workflow-grid">${activeWorkflows(workflows).map((w) => workflowCard(w)).join("") || `<div class="empty">暂无流程</div>`}</div></div>
        </section>`;
      panel.querySelector("[data-admin='workflow']").addEventListener("click", () => openWorkflowDesigner(rolesData.roles, directory));
      panel.querySelectorAll("[data-edit-wf]").forEach((b) => b.addEventListener("click", () => openWorkflowDesigner(rolesData.roles, directory, workflows.find((w) => String(w.id) === b.dataset.editWf))));
      panel.querySelectorAll("[data-enable-wf]").forEach((b) => b.addEventListener("click", () => enableWorkflow(b.dataset.enableWf)));
    } else if (platformTab === "forms") {
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-header"><h2>表单 / 业务类型配置</h2><button class="secondary" data-admin="biz-new">+ 新增业务类型</button></div>
          <div class="panel-body">
            <p class="muted" style="margin:0 0 12px;line-height:1.7">每个业务类型可<b>设计申请表单字段</b>（保存即生成新版本并启用）。<b>新增业务类型</b>会自动建好菜单、默认表单与默认审批流程，随后可在「流程配置」调整其审批流。</p>
            <div class="workflow-grid">${(businessTypes || []).map((bt) => formTypeCard(bt)).join("") || `<div class="empty">暂无业务类型</div>`}</div>
          </div>
        </section>`;
      panel.querySelector("[data-admin='biz-new']").addEventListener("click", () => openBusinessTypeForm());
      panel.querySelectorAll("[data-design-form]").forEach((b) => b.addEventListener("click", () => openFormDesigner(b.dataset.designForm, b.dataset.designName)));
    } else if (platformTab === "annual") {
      const curYear = new Date().getFullYear();
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-header"><h2>年假台账</h2>
            <div class="row-actions">
              <label style="display:flex;align-items:center;gap:6px;margin:0;color:var(--muted)">年度
                <select id="alYear">${[curYear - 1, curYear, curYear + 1].map((y) => `<option value="${y}" ${y === curYear ? "selected" : ""}>${y}</option>`).join("")}</select></label>
              <input id="alKeyword" placeholder="搜索姓名 / 账号" style="width:180px" />
              <button class="secondary" id="alSearch">查询</button>
            </div>
          </div>
          <div class="panel-body">
            <p class="muted" style="margin:0 0 12px;line-height:1.7">为每名员工录入<b>该年度的总年假天数</b>，员工提交「年假」申请时系统自动扣减；驳回 / 撤回时回补。<b>已用天数</b>由系统维护，不可手动改。</p>
            <div id="alList"><div class="empty">加载中…</div></div>
          </div>
        </section>`;
      const reload = async () => {
        const y = $("alYear").value;
        const k = $("alKeyword").value.trim();
        const qs = new URLSearchParams({ year: y }); if (k) qs.set("keyword", k);
        try {
          const r = await api(`/api/annual-leave?${qs.toString()}`);
          $("alList").innerHTML = `<table>
            <thead><tr><th>姓名</th><th>账号</th><th>科室</th><th>入职日期</th><th>总天数</th><th>已用</th><th>可用</th><th>操作</th></tr></thead>
            <tbody>${(r.items || []).map((it) => `<tr>
              <td>${escapeHtml(it.name)}</td>
              <td>${escapeHtml(it.account)}</td>
              <td>${escapeHtml(it.dept)}</td>
              <td>${escapeHtml(it.entry_date || "—")}</td>
              <td>${it.total_days}</td>
              <td>${it.used_days}</td>
              <td><b>${it.available_days}</b></td>
              <td><button class="link" data-al-edit="${it.user_id}" data-al-name="${escapeHtml(it.name)}" data-al-total="${it.total_days}">设额度</button></td>
            </tr>`).join("")}</tbody></table>`;
          $("alList").querySelectorAll("[data-al-edit]").forEach((b) => b.addEventListener("click", () => openAnnualLeaveSetter(Number(b.dataset.alEdit), b.dataset.alName, Number(b.dataset.alTotal), Number(y))));
        } catch (e) { $("alList").innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
      };
      $("alSearch").onclick = reload;
      $("alYear").onchange = reload;
      $("alKeyword").addEventListener("keydown", (e) => { if (e.key === "Enter") reload(); });
      reload();
    } else if (platformTab === "notices") {
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-header"><h2>通知公告</h2><button class="secondary" data-admin="notice-new">+ 发布公告</button></div>
          <div class="panel-body">
            <p class="muted" style="margin:0 0 12px;line-height:1.7">通知公告由<b>管理员</b>发布与维护，发布后全员可在「工作台 → 通知公告」看到。<b>范围</b>用于标注面向哪些科室（如<i>全中心</i>或某个具体科室）。</p>
            <div id="noticeManager"><div class="empty">加载中…</div></div>
          </div>
        </section>`;
      panel.querySelector("[data-admin='notice-new']").addEventListener("click", () => openNoticeForm(departments));
      renderNoticeManager(departments);
    } else if (platformTab === "roles") {
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-header"><h2>角色与权限</h2><div class="row-actions"><button class="secondary" data-admin="role-new">新增角色</button><button class="secondary" data-admin="role-modules">配置菜单权限</button></div></div>
          <div class="panel-body">
          <p class="muted" style="margin:0 0 12px;line-height:1.7"><b>数据范围</b>决定该角色能看到哪些单据：全部 / 本部门及下级 / 仅本部门 / 仅本人；<b>可审批</b>决定能否作为审批人处理单据。内置角色（管理员/部门负责人/普通职工）不可删除，管理员固定为全部数据。</p>
          <table>
            <thead><tr><th>角色</th><th>标识</th><th>数据范围</th><th>可审批</th><th>菜单权限</th><th>操作</th></tr></thead>
            <tbody>${rolesData.roles.map((role) => {
              const codes = rolesData.roleModules.filter((i) => i.role_code === role.code).map((i) => i.module_code);
              return `<tr>
                <td>${escapeHtml(role.name)}${role.is_system ? ' <span class="dept-tag sub">内置</span>' : ""}</td>
                <td><span class="muted">${escapeHtml(role.code)}</span></td>
                <td>${dataScopeText(role.data_scope)}</td>
                <td>${role.can_approve ? "✅ 是" : "—"}</td>
                <td>${codes.map((c) => escapeHtml((moduleMeta[c] && moduleMeta[c].title) || c)).join("、") || "<span class='muted'>无</span>"}</td>
                <td class="row-actions"><button class="link" data-edit-role="${role.id}">编辑</button>${role.is_system ? "" : `<button class="link danger" data-del-role="${role.id}">删除</button>`}</td>
              </tr>`;
            }).join("")}</tbody>
          </table></div>
        </section>`;
      panel.querySelector("[data-admin='role-modules']").addEventListener("click", () => openRoleModuleForm(rolesData));
      panel.querySelector("[data-admin='role-new']").addEventListener("click", () => openRoleForm());
      panel.querySelectorAll("[data-edit-role]").forEach((b) => b.addEventListener("click", () => openRoleForm(rolesData.roles.find((r) => String(r.id) === b.dataset.editRole))));
      panel.querySelectorAll("[data-del-role]").forEach((b) => b.addEventListener("click", () => deleteRole(b.dataset.delRole)));
    }
  }

  const DATA_SCOPE_LABELS = { all: "全部数据", dept_sub: "本部门及下级", dept: "仅本部门", self: "仅本人" };
  function dataScopeText(s) { return DATA_SCOPE_LABELS[s] || s || "仅本人"; }

  function openRoleForm(role) {
    const scopes = Object.entries(DATA_SCOPE_LABELS);
    const isAdmin = role && role.code === "admin";
    openModal(role ? "编辑角色" : "新增角色", `
      <form id="roleForm" class="form-grid">
        <label>角色名称<input name="name" value="${role ? escapeHtml(role.name) : ""}" required /></label>
        ${role ? `<label>角色标识<input value="${escapeHtml(role.code)}" disabled /></label>`
          : `<label>角色标识<input name="code" placeholder="如 dept_clerk（小写字母开头）" required /></label>`}
        <label>数据范围<select name="dataScope" ${isAdmin ? "disabled" : ""}>${scopes.map(([v, l]) => `<option value="${v}" ${role && role.data_scope === v ? "selected" : (!role && v === "self" ? "selected" : "")}>${l}</option>`).join("")}</select></label>
        <label>可审批<select name="canApprove" ${isAdmin ? "disabled" : ""}><option value="0" ${role && !role.can_approve ? "selected" : ""}>否</option><option value="1" ${role && role.can_approve ? "selected" : ""}>是</option></select></label>
        ${isAdmin ? `<p class="muted full">管理员角色固定为「全部数据 + 可审批」，不可更改。</p>` : ""}
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("roleForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const payload = { name: f.get("name"), dataScope: f.get("dataScope"), canApprove: f.get("canApprove") === "1" };
      try {
        if (role) await api(`/api/roles/${role.id}`, { method: "PUT", body: JSON.stringify(payload) });
        else await api("/api/roles", { method: "POST", body: JSON.stringify({ ...payload, code: f.get("code") }) });
        closeModal(); await renderPlatform();
      } catch (err) { alert(err.message); }
    });
  }

  async function deleteRole(id) {
    if (!confirm("确认删除该角色？")) return;
    try { await api(`/api/roles/${id}`, { method: "DELETE" }); await renderPlatform(); }
    catch (err) { alert(err.message); }
  }

  /* ---------------- 通知公告管理 ---------------- */

  async function renderNoticeManager(departments) {
    const box = $("noticeManager");
    if (!box) return;
    let resp;
    try { resp = await api("/api/notices?pageSize=100"); }
    catch (err) { box.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`; return; }
    const items = resp.items || [];
    if (!items.length) {
      box.innerHTML = `<div class="empty">暂无公告，点击右上角「+ 发布公告」开始发布</div>`;
      return;
    }
    box.innerHTML = `<table>
      <thead><tr><th>标题</th><th>范围</th><th>发布日期</th><th>发布人</th><th>正文</th><th>操作</th></tr></thead>
      <tbody>${items.map((n) => `<tr>
        <td>${escapeHtml(n.title)}</td>
        <td>${escapeHtml(n.scope)}</td>
        <td>${escapeHtml(n.published_at)}</td>
        <td>${escapeHtml(n.created_by_name || "—")}</td>
        <td><span class="muted">${escapeHtml((n.content || "").slice(0, 40))}${(n.content || "").length > 40 ? "…" : ""}</span></td>
        <td class="row-actions">
          <button class="link" data-edit-notice="${n.id}">编辑</button>
          <button class="link danger" data-del-notice="${n.id}">删除</button>
        </td></tr>`).join("")}</tbody></table>`;
    box.querySelectorAll("[data-edit-notice]").forEach((b) => b.addEventListener("click", () => openNoticeForm(departments, items.find((x) => String(x.id) === b.dataset.editNotice))));
    box.querySelectorAll("[data-del-notice]").forEach((b) => b.addEventListener("click", () => deleteNotice(b.dataset.delNotice)));
  }

  function openNoticeForm(departments, notice) {
    const today = new Date().toISOString().slice(0, 10);
    const scopes = ["全中心", ...((departments || []).map((d) => d.name))];
    const cur = notice ? notice.scope : "全中心";
    const scopeOpts = scopes.map((s) => `<option value="${escapeHtml(s)}" ${cur === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
    openModal(notice ? "编辑公告" : "发布公告", `
      <form id="noticeForm" class="form-grid">
        <label class="full">标题<input name="title" required value="${notice ? escapeHtml(notice.title) : ""}" /></label>
        <label>发布范围<select name="scope">${scopeOpts}</select></label>
        <label>发布日期<input type="date" name="publishedAt" value="${notice ? escapeHtml(notice.published_at) : today}" /></label>
        <label class="full">正文<textarea name="content" required rows="4">${notice ? escapeHtml(notice.content) : ""}</textarea></label>
        <div class="full row-actions"><button class="primary" type="submit">${notice ? "保存" : "发布"}</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("noticeForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const body = { title: f.get("title"), scope: f.get("scope"), content: f.get("content"), publishedAt: f.get("publishedAt") };
      try {
        if (notice) await api(`/api/notices/${notice.id}`, { method: "PUT", body: JSON.stringify(body) });
        else await api("/api/notices", { method: "POST", body: JSON.stringify(body) });
        closeModal(); await renderPlatform();
      } catch (err) { alert(err.message); }
    });
  }

  function openAnnualLeaveSetter(userId, name, currentTotal, year) {
    openModal(`设置年假额度 · ${name}`, `
      <form id="alForm" class="form-grid">
        <label>年度<input value="${year}" disabled /></label>
        <label>员工<input value="${escapeHtml(name)}" disabled /></label>
        <label class="full">${year} 年年假总天数<input name="totalDays" type="number" min="0" step="0.5" value="${currentTotal}" required /></label>
        <p class="muted full" style="margin:0;line-height:1.7">调整后系统按「新总天数 - 已用天数」自动计算可用余额。</p>
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("alForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await api(`/api/annual-leave/${userId}`, { method: "PUT", body: JSON.stringify({ year, totalDays: Number(f.get("totalDays")) }) });
        closeModal(); platformTab = "annual"; await renderPlatform();
      } catch (err) { alert(err.message); }
    });
  }

  async function deleteNotice(id) {
    if (!confirm("确认删除该公告？删除后所有人都看不到了。")) return;
    try { await api(`/api/notices/${id}`, { method: "DELETE" }); await renderPlatform(); }
    catch (err) { alert(err.message); }
  }

  /* ---------------- 用户管理（规模化：搜索/筛选/分页/批量） ---------------- */

  async function renderUserManager() {
    const container = $("userManager");
    if (!container) return;
    const s = userMgrState;
    const { departments, roles } = userMgrCtx;
    const qs = new URLSearchParams({
      page: s.page, pageSize: s.pageSize, keyword: s.keyword,
      deptId: s.deptId, roleId: s.roleId, status: s.status, sortBy: s.sortBy, sortDir: s.sortDir,
    });
    let resp;
    try { resp = await api(`/api/users?${qs.toString()}`); }
    catch (err) { container.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`; return; }
    const { items, total, page, pageSize } = resp;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const arrow = (col) => s.sortBy === col ? (s.sortDir === "asc" ? " ▲" : " ▼") : "";
    const deptOpts = departments.map((d) => `<option value="${d.id}" ${String(s.deptId) === String(d.id) ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("");
    const roleOpts = roles.map((r) => `<option value="${r.id}" ${String(s.roleId) === String(r.id) ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("");
    container.innerHTML = `
      <div class="um-toolbar">
        <input id="umKeyword" class="um-search" placeholder="搜索姓名 / 账号" value="${escapeHtml(s.keyword)}" />
        <select id="umDept"><option value="">全部部门</option>${deptOpts}</select>
        <select id="umRole"><option value="">全部角色</option>${roleOpts}</select>
        <select id="umStatus"><option value="">全部状态</option><option value="active" ${s.status === "active" ? "selected" : ""}>启用</option><option value="disabled" ${s.status === "disabled" ? "selected" : ""}>禁用</option></select>
        <button class="secondary" id="umSearch">查询</button>
        <button class="link" id="umReset">重置</button>
        <span class="um-spacer"></span>
        <button class="secondary" id="umExport">导出</button>
        <button class="secondary" id="umImport">批量导入</button>
        <button class="primary" id="umAdd">新增用户</button>
      </div>
      <div class="um-bulk" id="umBulk" hidden>
        <span>已选 <b id="umSelCount">0</b> 人：</span>
        <button class="link" data-bulk="enable">启用</button>
        <button class="link" data-bulk="disable">禁用</button>
        <button class="link" data-bulk="move">调部门</button>
        <button class="link" data-bulk="setRole">改角色</button>
        <button class="link" data-bulk="reset">重置密码</button>
        <button class="link danger" data-bulk="delete">删除</button>
      </div>
      <table class="um-table">
        <thead><tr>
          <th class="um-check"><input type="checkbox" id="umAll" /></th>
          <th class="sortable" data-sort="name">姓名${arrow("name")}</th>
          <th class="sortable" data-sort="account">账号${arrow("account")}</th>
          <th class="sortable" data-sort="dept">科室${arrow("dept")}</th>
          <th>角色</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>${items.length ? items.map(userRow).join("") : `<tr><td colspan="7"><div class="empty">没有符合条件的用户</div></td></tr>`}</tbody>
      </table>
      <div class="um-pager">
        <span class="muted">共 ${total} 人 · 第 ${page}/${totalPages} 页</span>
        <span class="um-spacer"></span>
        <select id="umPageSize">
          <option value="20" ${pageSize === 20 ? "selected" : ""}>20 条/页</option>
          <option value="50" ${pageSize === 50 ? "selected" : ""}>50 条/页</option>
          <option value="100" ${pageSize === 100 ? "selected" : ""}>100 条/页</option>
        </select>
        <button class="secondary" id="umPrev" ${page <= 1 ? "disabled" : ""}>上一页</button>
        <button class="secondary" id="umNext" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      </div>`;
    bindUserManager(items);
  }

  function userRow(u) {
    return `<tr>
      <td class="um-check"><input type="checkbox" class="um-row" value="${u.id}" /></td>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.account)}</td>
      <td>${escapeHtml(u.dept)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td><span class="pill ${u.status === "active" ? "on" : ""}">${accountStatusText(u.status)}</span></td>
      <td class="row-actions">
        <button class="link" data-edit-user="${u.id}">编辑</button>
        <button class="link" data-reset-user="${u.id}">重置密码</button>
        ${u.status === "active" ? `<button class="link" data-disable-user="${u.id}">禁用</button>` : `<button class="link" data-enable-user="${u.id}">启用</button>`}
        <button class="link danger" data-del-user="${u.id}">删除</button>
      </td></tr>`;
  }

  function bindUserManager(items) {
    const s = userMgrState;
    const reload = () => renderUserManager();
    const applyFilters = () => {
      s.keyword = $("umKeyword").value.trim();
      s.deptId = $("umDept").value;
      s.roleId = $("umRole").value;
      s.status = $("umStatus").value;
      s.page = 1;
      reload();
    };
    $("umSearch").onclick = applyFilters;
    $("umKeyword").onkeydown = (e) => { if (e.key === "Enter") applyFilters(); };
    ["umDept", "umRole", "umStatus"].forEach((id) => { $(id).onchange = applyFilters; });
    $("umReset").onclick = () => { Object.assign(s, { page: 1, keyword: "", deptId: "", roleId: "", status: "", sortBy: "id", sortDir: "asc" }); reload(); };
    $("umPageSize").onchange = (e) => { s.pageSize = Number(e.target.value); s.page = 1; reload(); };
    $("umPrev").onclick = () => { if (s.page > 1) { s.page -= 1; reload(); } };
    $("umNext").onclick = () => { s.page += 1; reload(); };
    $("umAdd").onclick = () => openUserForm(userMgrCtx.departments, userMgrCtx.roles);
    $("umImport").onclick = () => openImportForm("users");
    $("umExport").onclick = () => {
      const eq = new URLSearchParams({ keyword: s.keyword, deptId: s.deptId, roleId: s.roleId, status: s.status });
      downloadExport(`/api/users/export.xlsx?${eq.toString()}`);
    };
    document.querySelectorAll(".um-table th.sortable").forEach((th) => { th.onclick = () => {
      const col = th.dataset.sort;
      if (s.sortBy === col) s.sortDir = s.sortDir === "asc" ? "desc" : "asc"; else { s.sortBy = col; s.sortDir = "asc"; }
      reload();
    }; });
    document.querySelectorAll("[data-edit-user]").forEach((b) => { b.onclick = () => openUserForm(userMgrCtx.departments, userMgrCtx.roles, items.find((u) => String(u.id) === b.dataset.editUser)); });
    document.querySelectorAll("[data-reset-user]").forEach((b) => { b.onclick = () => resetUserPassword(b.dataset.resetUser); });
    document.querySelectorAll("[data-disable-user]").forEach((b) => { b.onclick = () => toggleUserMgr(b.dataset.disableUser, "disable"); });
    document.querySelectorAll("[data-enable-user]").forEach((b) => { b.onclick = () => toggleUserMgr(b.dataset.enableUser, "enable"); });
    document.querySelectorAll("[data-del-user]").forEach((b) => { b.onclick = () => deleteUserMgr(b.dataset.delUser); });
    const syncSel = () => { const n = document.querySelectorAll(".um-row:checked").length; $("umSelCount").textContent = n; $("umBulk").hidden = n === 0; };
    $("umAll").onchange = (e) => { document.querySelectorAll(".um-row").forEach((c) => { c.checked = e.target.checked; }); syncSel(); };
    document.querySelectorAll(".um-row").forEach((c) => { c.onchange = syncSel; });
    document.querySelectorAll("[data-bulk]").forEach((b) => { b.onclick = () => bulkUser(b.dataset.bulk); });
  }

  function selectedUserIds() {
    return [...document.querySelectorAll(".um-row:checked")].map((c) => Number(c.value));
  }

  async function toggleUserMgr(userId, action) {
    if (!confirm(action === "disable" ? "确认禁用该用户？" : "确认启用该用户？")) return;
    try { await api(`/api/users/${userId}/${action}`, { method: "POST", body: "{}" }); directoryCache = null; pickerDirectoryCache = null; await renderUserManager(); }
    catch (err) { alert(err.message); }
  }

  async function deleteUserMgr(userId) {
    if (!confirm("确认删除该用户？删除后不可恢复（有业务记录的用户无法删除）。")) return;
    try { await api(`/api/users/${userId}`, { method: "DELETE" }); directoryCache = null; pickerDirectoryCache = null; await renderUserManager(); }
    catch (err) { alert(err.message); }
  }

  function bulkUser(action) {
    const ids = selectedUserIds();
    if (!ids.length) return alert("请先勾选用户");
    if (action === "move") return openBulkSelect("批量调整部门", userMgrCtx.departments, "deptId", ids);
    if (action === "setRole") return openBulkSelect("批量调整角色", userMgrCtx.roles, "roleId", ids);
    if (action === "reset") {
      const pwd = prompt(`为选中的 ${ids.length} 个用户重置密码（至少 6 位）`, "123456");
      if (!pwd) return;
      return runBulk({ action, ids, password: pwd });
    }
    const verb = { enable: "启用", disable: "禁用", delete: "删除" }[action];
    const extra = action === "delete" ? "（有业务记录的将自动跳过）" : "";
    if (!confirm(`确认${verb}选中的 ${ids.length} 个用户？${extra}`)) return;
    runBulk({ action, ids });
  }

  function openBulkSelect(title, list, key, ids) {
    const label = key === "deptId" ? "部门" : "角色";
    openModal(title, `
      <div class="form-grid">
        <label class="full">目标${label}<select id="bulkTarget">${list.map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join("")}</select></label>
        <div class="full row-actions"><button class="primary" id="bulkOk" type="button">应用到 ${ids.length} 人</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </div>`);
    $("bulkOk").onclick = () => {
      const value = Number($("bulkTarget").value);
      closeModal();
      runBulk({ action: key === "deptId" ? "move" : "setRole", ids, [key]: value });
    };
  }

  async function runBulk(body) {
    try {
      const r = await api("/api/users/bulk", { method: "POST", body: JSON.stringify(body) });
      directoryCache = null;
      pickerDirectoryCache = null;
      let msg = `操作成功 ${r.success} 人`;
      if (r.failed && r.failed.length) msg += `；${r.failed.length} 人未处理：\n` + r.failed.map((f) => `· ${f.name || ("ID" + f.id)}：${f.reason}`).join("\n");
      alert(msg);
      await renderUserManager();
    } catch (err) { alert(err.message); }
  }

  function renderDeptTree(departments) {
    const byParent = {};
    departments.forEach((d) => { (byParent[d.parent_id || 0] = byParent[d.parent_id || 0] || []).push(d); });
    // 同一上级下的部门为「平级」，按排序号并列；子部门用缩进 + 连接线挂在上级下方。
    const build = (parent, depth) => (byParent[parent] || []).map((d) => {
      const childCount = (byParent[d.id] || []).length;
      const levelTag = depth === 0
        ? `<span class="dept-tag top">顶级</span>`
        : `<span class="dept-tag sub">${depth} 级子部门</span>`;
      const childInfo = childCount ? ` · 含 ${childCount} 个子部门` : "";
      const branch = depth ? `<span class="tree-branch">${"│".repeat(depth - 1)}└</span>` : "";
      return `
      <div class="tree-node"${depth ? ` style="margin-left:${depth * 22}px"` : ""}>
        <div class="tree-label">${branch}
          <div class="tree-info"><strong>${escapeHtml(d.name)}</strong>
            <span class="muted" title="同层级内的显示顺序，数字越小越靠前">${levelTag} · 排序号 ${d.sort_order} · ${escapeHtml(accountStatusText(d.status))}${childInfo}</span></div>
        </div>
        <div class="row-actions">
          <button class="link" data-edit-dept="${d.id}">编辑</button>
          <button class="link danger" data-del-dept="${d.id}">删除</button>
        </div>
      </div>${build(d.id, depth + 1)}`;
    }).join("");
    return build(0, 0) || `<div class="empty">暂无部门</div>`;
  }

  // 每个业务类型只呈现当前生效的流程（无生效版本时回退到最新一版），界面不出现版本号
  function activeWorkflows(workflows) {
    const byType = new Map();
    (workflows || []).forEach((w) => {
      const cur = byType.get(w.business_type);
      const better = !cur || (w.enabled && !cur.enabled) || (!!w.enabled === !!cur.enabled && w.version > cur.version);
      if (better) byType.set(w.business_type, w);
    });
    return Array.from(byType.values());
  }

  function workflowCard(w) {
    const steps = w.nodes.map((n) => {
      const cond = n.condition_json && n.condition_json !== "{}" ? `<span class="cond">条件</span>` : "";
      const modeBadge = n.approve_mode && n.approve_mode !== "single" ? `<span class="cond">${n.approve_mode === "countersign" ? "会签" : "并行"}</span>` : "";
      const who = n.approver_type === "user" ? "" : n.approver_value ? "·" + escapeHtml(n.approver_value) : "";
      return `<span class="wf-step">${escapeHtml(n.node_name)}<small>${approverTypeText(n.approver_type)}${who}</small>${cond}${modeBadge}</span>`;
    });
    return `<div class="workflow-card">
      <div class="wf-title"><strong>${escapeHtml(w.name)}</strong>
        <span class="row-actions">
          <button class="link" data-edit-wf="${w.id}">编辑</button>
          ${w.enabled ? `<span class="pill on">启用中</span>` : `<button class="link" data-enable-wf="${w.id}">启用</button>`}
        </span></div>
      <div class="workflow-steps">${steps.join('<span class="arrow">→</span>')}</div>
    </div>`;
  }

  function openDepartmentForm(departments, editId) {
    const dept = editId ? departments.find((d) => String(d.id) === String(editId)) : null;
    const options = departments.filter((d) => !dept || d.id !== dept.id)
      .map((d) => `<option value="${d.id}" ${dept && dept.parent_id === d.id ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("");
    openModal(dept ? "编辑部门" : "新增部门", `
      <form id="departmentForm" class="form-grid">
        <label class="full">部门名称<input name="name" required value="${dept ? escapeHtml(dept.name) : ""}" /></label>
        <label>上级部门<select name="parentId"><option value="">（顶级部门）</option>${options}</select></label>
        <label>排序号 <span class="muted" style="font-weight:400">（同层级越小越靠前）</span><input name="sortOrder" type="number" value="${dept ? dept.sort_order : 10}" /></label>
        ${dept ? `<label>状态<select name="status"><option value="active" ${dept.status === "active" ? "selected" : ""}>启用</option><option value="disabled" ${dept.status === "disabled" ? "selected" : ""}>禁用</option></select></label>` : ""}
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("departmentForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const body = { name: f.get("name"), parentId: f.get("parentId") ? Number(f.get("parentId")) : null, sortOrder: Number(f.get("sortOrder")), status: f.get("status") || "active" };
      try {
        if (dept) await api(`/api/departments/${dept.id}`, { method: "PUT", body: JSON.stringify(body) });
        else await api("/api/departments", { method: "POST", body: JSON.stringify(body) });
        closeModal(); await renderPlatform();
      } catch (err) { alert(err.message); }
    });
  }

  async function deleteDepartment(id) {
    if (!confirm("确认删除该部门？")) return;
    try { await api(`/api/departments/${id}`, { method: "DELETE" }); await renderPlatform(); }
    catch (err) { alert(err.message); }
  }

  function openUserForm(departments, roles, editUser) {
    openModal(editUser ? "编辑用户" : "新增用户", `
      <form id="userForm" class="form-grid">
        <label>账号<input name="account" required value="${editUser ? escapeHtml(editUser.account) : ""}" ${editUser ? "disabled" : ""} /></label>
        ${editUser ? "" : `<label>初始密码<input name="password" value="123456" required /></label>`}
        <label>姓名<input name="name" required value="${editUser ? escapeHtml(editUser.name) : ""}" /></label>
        <label>部门<select name="deptId">${departments.map((d) => `<option value="${d.id}" ${editUser && editUser.dept_id === d.id ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}</select></label>
        <label>角色<select name="roleId">${roles.map((r) => `<option value="${r.id}" ${editUser && editUser.role_id === r.id ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}</select></label>
        <label>参加工作时间<input type="date" name="entryDate" value="${editUser && editUser.entry_date ? escapeHtml(editUser.entry_date) : ""}" /></label>
        <label>联系电话<input name="phone" value="${editUser && editUser.phone ? escapeHtml(editUser.phone) : ""}" placeholder="如 13800138000" maxlength="20" /></label>
        ${editUser ? `<label>状态<select name="status"><option value="active" ${editUser.status === "active" ? "selected" : ""}>启用</option><option value="disabled" ${editUser.status === "disabled" ? "selected" : ""}>禁用</option></select></label>` : ""}
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("userForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const common = { name: f.get("name"), deptId: Number(f.get("deptId")), roleId: Number(f.get("roleId")), entryDate: f.get("entryDate"), phone: f.get("phone") };
      try {
        if (editUser) {
          await api(`/api/users/${editUser.id}`, { method: "PUT", body: JSON.stringify({ ...common, status: f.get("status") }) });
        } else {
          await api("/api/users", { method: "POST", body: JSON.stringify({ ...common, account: f.get("account"), password: f.get("password") }) });
        }

        directoryCache = null; pickerDirectoryCache = null; closeModal(); await renderUserManager();
      } catch (err) { alert(err.message); }
    });
  }

  function openImportForm(kind) {
    const isUser = kind === "users";
    openModal(isUser ? "批量导入用户" : "批量导入部门", `
      <div class="muted" style="margin-bottom:12px; line-height:1.8">
        第一步「下载模板」，按表头逐列填写（保留第一行表头），再「上传导入」。各列说明：<br>
        ${isUser
          ? `<b>账号 / 姓名</b>（必填）。<br><b>部门名称</b>（必填）：须是系统中已存在的部门全称。<br><b>角色</b>：只能填 管理员 / 部门负责人 / 普通职工。<br><b>初始密码</b>（可空）：留空默认 123456。`
          : `<b>部门名称</b>（必填）：部门全称，如"免疫规划科"。<br><b>上级部门名称</b>（可空）：留空＝顶级部门；填某个部门名即建为它的子部门（上级须已存在，或在表格中排在它前面先导入）。<br><b>排序号</b>（可空）：同一层级内的显示顺序，<b>数字越小越靠前</b>（如 1 排在 2 前面），留空按 0 处理。`}
      </div>
      <div class="row-actions" style="margin-bottom:12px"><button class="secondary" id="dlTpl" type="button">下载模板</button></div>
      <form id="importForm" class="row-actions"><input type="file" name="file" accept=".xlsx" required /><button class="primary" type="submit">上传导入</button></form>
      <div id="importResult" style="margin-top:12px"></div>`);
    $("dlTpl").addEventListener("click", () => downloadExport(`/api/import/template/${kind}.xlsx`));
    $("importForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/api/import/${kind}`, { method: "POST", body: new FormData(e.currentTarget) });
        $("importResult").innerHTML = `<div class="note">成功导入 ${r.created}/${r.total} 条。${r.errors && r.errors.length ? "<br>需注意：<br>" + r.errors.map(escapeHtml).join("<br>") : ""}</div>`;
        directoryCache = null;
        pickerDirectoryCache = null;
      } catch (err) { alert(err.message); }
    });
  }

  async function resetUserPassword(userId) {
    const password = prompt("请输入新密码（至少6位）", "123456");
    if (!password) return;
    try { await api(`/api/users/${userId}/reset-password`, { method: "POST", body: JSON.stringify({ password }) }); alert("密码已重置"); }
    catch (err) { alert(err.message); }
  }
  // 可视化流程图编辑器：画布式 DAG —— 节点可拖动、节点之间拉边、分叉/汇合/提前办结。
  function openWorkflowDesigner(roles, users, existing) {
    const parseCond = (cj) => { try { const c = typeof cj === "string" ? JSON.parse(cj || "{}") : (cj || {}); return c || {}; } catch (e) { return {}; } };

    let uid = 1;
    const nid = () => "n" + (uid++);
    const eid = () => "e" + (uid++);
    let nodes = [];
    let edges = [];
    let selected = null; // { kind: "node"|"edge", id }
    let connectFrom = null;
    const NODE_TYPES = ["", "收文拟办", "收文批示", "处室办理", "秘书", "申请审批", "申请会签"];

    if (existing && existing.nodes && existing.nodes.length) {
      const map = {};
      existing.nodes.forEach((n, i) => {
        const id = nid(); map[n.id] = id;
        const isEnd = n.node_kind === "end" || /归档|办结|结束/.test(n.node_name || "");
        nodes.push({
          id, dbId: n.id, nodeName: n.node_name, nodeType: n.node_type || "",
          nodeKind: isEnd ? "end" : "task",
          posX: Number(n.pos_x) > 0 ? Number(n.pos_x) : (60 + i * 200),
          posY: Number(n.pos_y) > 0 ? Number(n.pos_y) : (80 + (i % 2) * 130),
          approverType: n.approver_type || "dept_leader",
          approverValue: String(n.approver_value || ""),
          approveMode: n.approve_mode || "single",
          condition: parseCond(n.condition_json),
          allowTerminal: !!n.allow_terminal || isEnd,
        });
      });
      (existing.edges || []).forEach((e) => {
        const from = map[e.from_node_id]; if (!from) return;
        const to = e.to_node_id ? map[e.to_node_id] : null;
        edges.push({ id: eid(), from, to, label: e.label || "", condition: parseCond(e.condition_json) });
      });
    } else {
      const a = nid(), b = nid();
      nodes = [
        { id: a, nodeName: "部门负责人审批", nodeType: "", nodeKind: "task", posX: 80, posY: 130, approverType: "dept_leader", approverValue: "", approveMode: "single", condition: {}, allowTerminal: false },
        { id: b, nodeName: "结束节点", nodeType: "", nodeKind: "end", posX: 380, posY: 130, approverType: "role", approverValue: "admin", approveMode: "single", condition: {}, allowTerminal: true },
      ];
      edges = [{ id: eid(), from: a, to: b, label: "", condition: {} }];
    }

    const bizList = Object.values(bizTypes).length ? Object.values(bizTypes)
      : [{ code: "leave", name: "请假" }, { code: "trip", name: "出差" }, { code: "vehicle", name: "用车" }, { code: "document", name: "公文" }];

    openModal(existing ? "编辑流程（DAG）" : "设计流程（DAG）", `
      <div class="form-grid">
        <label>业务类型<select id="wfBiz">${bizList.map((b) => `<option value="${b.code}">${escapeHtml(b.name)}</option>`).join("")}</select></label>
        <label>流程名称<input id="wfName" value="${existing ? escapeHtml(existing.name) : "自定义审批流程"}" /></label>
      </div>
      <div class="wf-toolbar">
        <button type="button" class="secondary" data-add="task">+ 新建节点</button>
        <button type="button" class="secondary" data-add="proc">+ 处室办理</button>
        <button type="button" class="secondary" data-add="sec">+ 秘书节点</button>
        <button type="button" class="secondary" data-add="end">+ 结束节点</button>
        <button type="button" class="secondary" id="wfConnect" title="先选起点节点，再点此按钮，然后点目标节点">↦ 连线</button>
        <button type="button" class="link danger" id="wfClear">清空</button>
        <span class="muted" style="margin-left:auto;font-size:12px">拖动节点改位置 · 单击选中 · Shift+点节点 = 从当前选中节点连线过去</span>
      </div>
      <div class="wf-canvas-wrap"><div class="wf-canvas" id="wfCanvas">
        <svg class="wf-svg" id="wfSvg" width="100%" height="100%">
          <defs><marker id="wfArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#9aa9bd"/></marker></defs>
        </svg>
      </div></div>
      <div id="wfEditor" class="wf-side-editor"></div>
      <div class="row-actions" style="margin-top:14px">
        <button class="primary" id="wfSave" type="button">保存</button>
        <button class="secondary" id="wfSaveAs" type="button">另存为新版本</button>
        <button class="secondary modal-cancel" type="button">取消</button>
      </div>`);
    $("wfBiz").value = existing ? existing.business_type : "leave";
    if (existing) $("wfBiz").disabled = true;

    const canvas = $("wfCanvas");
    const svg = $("wfSvg");
    const NODE_W = 168, NODE_H = 70;
    const getNode = (id) => nodes.find((n) => n.id === id);
    const getEdge = (id) => edges.find((e) => e.id === id);
    const nodeAnchor = (n, side) => side === "right"
      ? { x: (n.posX || 0) + NODE_W, y: (n.posY || 0) + NODE_H / 2 }
      : { x: (n.posX || 0), y: (n.posY || 0) + NODE_H / 2 };
    const curve = (a, b) => {
      const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      return `M ${a.x},${a.y} C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
    };

    function renderCanvas() {
      canvas.querySelectorAll(".wf-node").forEach((el) => el.remove());
      nodes.forEach((n, idx) => {
        const el = document.createElement("div");
        const isSel = selected && selected.kind === "node" && selected.id === n.id;
        el.className = `wf-node kind-${n.nodeKind}${isSel ? " selected" : ""}${connectFrom === n.id ? " connect-from" : ""}`;
        el.style.left = (n.posX || 0) + "px";
        el.style.top = (n.posY || 0) + "px";
        el.dataset.id = n.id;
        el.innerHTML = `<div class="wf-node-no">${idx + 1}</div>
          <div class="wf-node-name">${escapeHtml(n.nodeName || "未命名")}</div>
          ${n.nodeType ? `<div class="wf-node-type">[${escapeHtml(n.nodeType)}]</div>` : ""}
          <div class="wf-node-handle" title="点此圆点然后点目标节点 = 连线">●</div>`;
        canvas.appendChild(el);
        bindNodeEvents(el, n);
      });
      // 重建 SVG 边层（保留 defs）
      Array.from(svg.querySelectorAll(".wf-edge,.wf-edge-label")).forEach((el) => el.remove());
      edges.forEach((e) => {
        const from = getNode(e.from); if (!from) return;
        const to = e.to ? getNode(e.to) : null;
        const p1 = nodeAnchor(from, "right");
        const p2 = to ? nodeAnchor(to, "left") : { x: from.posX + NODE_W + 80, y: from.posY + NODE_H / 2 };
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", curve(p1, p2));
        const isSel = selected && selected.kind === "edge" && selected.id === e.id;
        path.setAttribute("class", `wf-edge${isSel ? " selected" : ""}${!to ? " terminal" : ""}`);
        path.setAttribute("marker-end", "url(#wfArrow)");
        path.addEventListener("click", (ev) => { ev.stopPropagation(); selected = { kind: "edge", id: e.id }; renderCanvas(); renderEditor(); });
        svg.appendChild(path);
        const labelText = e.label || (e.condition && e.condition.field ? `${e.condition.field} ${e.condition.op} ${e.condition.value}` : (!to ? "提前办结" : ""));
        if (labelText) {
          const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
          t.setAttribute("x", (p1.x + p2.x) / 2);
          t.setAttribute("y", (p1.y + p2.y) / 2 - 6);
          t.setAttribute("class", "wf-edge-label");
          t.textContent = labelText;
          svg.appendChild(t);
        }
      });
    }

    function bindNodeEvents(el, n) {
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
      const onMove = (ev) => {
        if (!dragging) return;
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        n.posX = Math.max(0, ox + dx);
        n.posY = Math.max(0, oy + dy);
        renderCanvas();
      };
      const onUp = () => { dragging = false; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
      el.addEventListener("mousedown", (ev) => {
        if (ev.target.classList.contains("wf-node-handle")) return;
        dragging = true; sx = ev.clientX; sy = ev.clientY; ox = n.posX || 0; oy = n.posY || 0; moved = false;
        document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
      });
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (moved) return;
        if (ev.shiftKey && selected && selected.kind === "node" && selected.id !== n.id) { addEdge(selected.id, n.id); return; }
        if (connectFrom && connectFrom !== n.id) { addEdge(connectFrom, n.id); connectFrom = null; renderCanvas(); return; }
        selected = { kind: "node", id: n.id }; renderCanvas(); renderEditor();
      });
      const handle = el.querySelector(".wf-node-handle");
      if (handle) handle.addEventListener("click", (ev) => { ev.stopPropagation(); connectFrom = n.id; renderCanvas(); });
    }

    function addEdge(from, to) {
      if (from === to) return;
      if (edges.some((e) => e.from === from && e.to === to)) return;
      edges.push({ id: eid(), from, to, label: "", condition: {} });
      selected = { kind: "edge", id: edges[edges.length - 1].id };
      renderCanvas(); renderEditor();
    }

    function addNode(kind) {
      const presets = {
        task: { nodeName: "新节点", nodeType: "", approverType: "dept_leader", kind: "task" },
        proc: { nodeName: "处室办理", nodeType: "处室办理", approverType: "dept_leader", kind: "task" },
        sec:  { nodeName: "秘书处理", nodeType: "秘书", approverType: "role", approverValue: "leader", kind: "task" },
        end:  { nodeName: "结束节点", nodeType: "", approverType: "role", approverValue: "admin", kind: "end" },
      };
      const p = presets[kind] || presets.task;
      const x = 80 + (nodes.length % 5) * 200;
      const y = 80 + Math.floor(nodes.length / 5) * 130;
      const node = {
        id: nid(), nodeName: p.nodeName, nodeType: p.nodeType, nodeKind: p.kind,
        posX: x, posY: y, approverType: p.approverType, approverValue: p.approverValue || "",
        approveMode: "single", condition: {}, allowTerminal: p.kind === "end",
      };
      nodes.push(node); selected = { kind: "node", id: node.id }; renderCanvas(); renderEditor();
    }

    function renderEditor() {
      const box = $("wfEditor");
      if (!selected) { box.innerHTML = `<div class="muted" style="padding:12px;text-align:center">点选节点或箭头查看 / 编辑属性</div>`; return; }
      if (selected.kind === "edge") {
        const e = getEdge(selected.id); if (!e) { selected = null; return renderEditor(); }
        const c = e.condition || {};
        const fromN = getNode(e.from); const toN = e.to ? getNode(e.to) : null;
        box.innerHTML = `
          <div class="wfe-head"><h3>箭头：${escapeHtml(fromN?.nodeName || "?")} → ${escapeHtml(toN?.nodeName || "（未连接）")}</h3>
            <button class="link danger" type="button" id="eDel">删除箭头</button></div>
          <div class="wfe-section">
            <div class="wfe-label">说明 <small class="muted">显示在箭头上，如「同意」「提前办结」</small></div>
            <input id="eLabel" class="wfe-input" value="${escapeHtml(e.label || "")}" placeholder="同意 / 退回 / 提前办结" />
          </div>
          <div class="wfe-section">
            <label class="wfe-toggle"><input type="checkbox" id="eCondOn" ${c.field ? "checked" : ""} />仅在满足条件时才走这条路径</label>
            <div id="eCondBox" class="wfe-cond" ${c.field ? "" : "hidden"}>
              <div class="form-grid compact">
                <label>条件字段<select id="eCondF">
                  <option value="days" ${c.field === "days" ? "selected" : ""}>天数</option>
                  <option value="category" ${c.field === "category" ? "selected" : ""}>类别</option></select></label>
                <label>运算<select id="eCondOp">${[">=", ">", "<=", "<", "==", "!="].map((o) => `<option ${c.op === o ? "selected" : ""}>${o}</option>`).join("")}</select></label>
                <label>条件值<input id="eCondV" value="${escapeHtml(c.value != null ? c.value : "")}" placeholder="例如 3" /></label>
              </div>
            </div>
          </div>`;
        const commit = () => {
          e.label = $("eLabel").value;
          e.condition = $("eCondOn").checked ? { field: $("eCondF").value, op: $("eCondOp").value, value: $("eCondV").value } : {};
          renderCanvas();
        };
        $("eDel").onclick = () => { edges = edges.filter((x) => x.id !== e.id); selected = null; renderCanvas(); renderEditor(); };
        $("eCondOn").onchange = () => { $("eCondBox").hidden = !$("eCondOn").checked; commit(); };
        ["eLabel", "eCondF", "eCondOp", "eCondV"].forEach((id) => { const el = $(id); if (el) { el.oninput = commit; el.onchange = commit; } });
        return;
      }
      const n = getNode(selected.id); if (!n) { selected = null; return renderEditor(); }
      const isEnd = n.nodeKind === "end";
      const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
      const selVals = csv(n.approverValue);
      const mode = n.approveMode || "single";
      const type = n.approverType || "dept_leader";
      const isMulti = mode !== "single";

      const modeBtns = [["single","单人审批"],["parallel","并行（任一通过）"],["countersign","会签（全部通过）"]].map(([v,l]) =>
        `<button type="button" class="seg-btn ${mode === v ? "on" : ""}" data-mode="${v}">${l}</button>`).join("");
      const typeBtns = [["dept_leader","本部门负责人"],["role","指定角色"],["user","指定人员"]].map(([v,t]) =>
        `<button type="button" class="seg-btn ${type === v ? "on" : ""}" data-type="${v}">${t}</button>`).join("");

      const valuePicker = (() => {
        if (type === "dept_leader") return `<div class="wfe-static">由系统按申请人所在部门自动指定</div>`;
        const items = type === "role"
          ? roles.map((r) => ({ v: r.code, t: r.name, sub: "" }))
          : users.map((u) => ({ v: String(u.id), t: u.name, sub: u.dept }));
        if (!isMulti) {
          const opts = items.map((it) => `<option value="${escapeHtml(it.v)}" ${selVals[0] === it.v ? "selected" : ""}>${escapeHtml(it.t)}${it.sub ? `（${escapeHtml(it.sub)}）` : ""}</option>`).join("");
          return `<select id="eValSingle" class="wfe-input"><option value="">请选择…</option>${opts}</select>`;
        }
        const cls = type === "role" ? "picker-grid" : "picker-list";
        return `<div class="${cls}">${items.map((it) => `<label class="picker-item"><input type="checkbox" value="${escapeHtml(it.v)}" ${selVals.includes(it.v) ? "checked" : ""} /><span>${escapeHtml(it.t)}${it.sub ? `<small> · ${escapeHtml(it.sub)}</small>` : ""}</span></label>`).join("")}</div>`;
      })();

      box.innerHTML = `
        <div class="wfe-head"><h3>节点 ${nodes.indexOf(n) + 1}：${escapeHtml(n.nodeName || "未命名")}</h3>
          <button class="link danger" type="button" id="nDel">删除节点</button></div>
        <div class="wfe-section">
          <div class="form-grid compact">
            <label>节点名称<input id="nName" value="${escapeHtml(n.nodeName || "")}" /></label>
            <label>节点类型 <small class="muted">流程图上的标签</small>
              <select id="nType">${NODE_TYPES.map((t) => `<option value="${escapeHtml(t)}" ${(n.nodeType || "") === t ? "selected" : ""}>${t || "（无）"}</option>`).join("")}</select></label>
            <label>节点角色<select id="nKind">
              <option value="task" ${!isEnd ? "selected" : ""}>办理节点</option>
              <option value="end" ${isEnd ? "selected" : ""}>结束节点</option></select></label>
            <label class="wfe-toggle"><input type="checkbox" id="nTerm" ${n.allowTerminal ? "checked" : ""} /> 允许在此节点直接办结</label>
          </div>
        </div>
        ${isEnd ? `<div class="wfe-section muted">结束节点不处理审批人，单据走到此节点即归档。</div>` : `
        <div class="wfe-section">
          <div class="wfe-label">审批方式</div>
          <div class="seg-control pills" id="nModeSeg">${modeBtns}</div>
        </div>
        <div class="wfe-section">
          <div class="wfe-label">审批人</div>
          <div class="seg-control pills" id="nTypeSeg">${typeBtns}</div>
          <div id="nValBox" style="margin-top:8px">${valuePicker}</div>
        </div>`}`;

      const commit = () => {
        n.nodeName = $("nName").value.trim() || "未命名";
        n.nodeType = $("nType").value;
        n.nodeKind = $("nKind").value;
        n.allowTerminal = $("nTerm").checked;
        if (n.nodeKind !== "end") {
          const single = $("eValSingle");
          if (single) n.approverValue = single.value;
          else if ($("nValBox")) n.approverValue = Array.from($("nValBox").querySelectorAll('input[type="checkbox"]:checked')).map((b) => b.value).join(",");
        }
        renderCanvas();
      };
      $("nDel").onclick = () => {
        nodes = nodes.filter((x) => x.id !== n.id);
        edges = edges.filter((e) => e.from !== n.id && e.to !== n.id);
        selected = null; renderCanvas(); renderEditor();
      };
      ["nName", "nType", "nTerm"].forEach((id) => { const el = $(id); if (el) { el.oninput = commit; el.onchange = commit; } });
      const kindSel = $("nKind"); if (kindSel) kindSel.onchange = () => { commit(); renderEditor(); };
      const modeSeg = $("nModeSeg");
      if (modeSeg) modeSeg.querySelectorAll(".seg-btn").forEach((b) => { b.onclick = () => { n.approveMode = b.dataset.mode; renderEditor(); }; });
      const typeSeg = $("nTypeSeg");
      if (typeSeg) typeSeg.querySelectorAll(".seg-btn").forEach((b) => { b.onclick = () => { n.approverType = b.dataset.type; n.approverValue = ""; renderEditor(); }; });
      const valBox = $("nValBox"); if (valBox) valBox.onchange = commit;
    }

    document.querySelectorAll(".wf-toolbar [data-add]").forEach((b) => { b.onclick = () => addNode(b.dataset.add); });
    $("wfConnect").onclick = () => {
      if (!selected || selected.kind !== "node") return alert("先点选一个起点节点");
      connectFrom = selected.id; renderCanvas();
    };
    $("wfClear").onclick = () => { if (!confirm("清空全部节点与箭头？")) return; nodes = []; edges = []; selected = null; renderCanvas(); renderEditor(); };
    canvas.onclick = (ev) => { if (ev.target === canvas || ev.target === svg) { selected = null; connectFrom = null; renderCanvas(); renderEditor(); } };

    async function doSave(asNew) {
      const businessType = $("wfBiz").value;
      const name = $("wfName").value.trim() || "自定义审批流程";
      if (!nodes.length) return alert("至少需要一个节点");
      const bad = nodes.findIndex((n) => n.nodeKind === "task" && n.approverType !== "dept_leader" && !String(n.approverValue || "").trim());
      if (bad >= 0) return alert(`节点 ${bad + 1}「${nodes[bad].nodeName}」未选择审批人`);
      const payloadNodes = nodes.map((n) => ({
        id: n.id, nodeName: n.nodeName, nodeType: n.nodeType, nodeKind: n.nodeKind,
        posX: Math.round(n.posX || 0), posY: Math.round(n.posY || 0), allowTerminal: !!n.allowTerminal,
        approverType: n.approverType, approverValue: n.approverValue,
        approveMode: n.approveMode || "single", condition: n.condition || {},
      }));
      const payloadEdges = edges.map((e) => ({ from: e.from, to: e.to, label: e.label || "", condition: e.condition || {} }));
      try {
        await api("/api/workflows", { method: "POST", body: JSON.stringify({ businessType, name: asNew ? `${name}（副本）` : name, nodes: payloadNodes, edges: payloadEdges }) });
        closeModal(); await renderPlatform();
      } catch (err) { alert(err.message); }
    }
    $("wfSave").onclick = () => doSave(false);
    $("wfSaveAs").onclick = () => doSave(true);

    renderCanvas(); renderEditor();
  }

  async function enableWorkflow(id) {
    try { await api(`/api/workflows/${id}/enable`, { method: "POST", body: "{}" }); await renderPlatform(); }
    catch (err) { alert(err.message); }
  }

  function openBusinessTypeForm() {
    openModal("新增业务类型", `
      <form id="btForm" class="form-grid">
        <label>名称<input name="name" placeholder="如 物资采购" required /></label>
        <label>标识<input name="code" placeholder="如 purchase（小写字母开头）" required /></label>
        <label>图标<input name="icon" placeholder="单字/符号，如 购" maxlength="2" /></label>
        <label>类别<select name="category"><option value="request">申请类</option><option value="document">公文类</option></select></label>
        <p class="muted full" style="line-height:1.7">创建后自动生成左侧菜单、默认表单（标题 + 说明）和默认审批流程（部门负责人 → 归档）；随后可在「表单配置 / 流程配置」细化。</p>
        <div class="full row-actions"><button class="primary" type="submit">创建</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("btForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await api("/api/business-types", { method: "POST", body: JSON.stringify({ name: f.get("name"), code: f.get("code"), icon: f.get("icon"), category: f.get("category") }) });
        closeModal();
        try { const me = await api("/api/me"); modules = me.modules; } catch (_) { /* ignore */ }
        await loadBizTypes(); renderNav(); await renderPlatform();
      } catch (err) { alert(err.message); }
    });
  }

  function formTypeCard(bt) {
    return `<div class="workflow-card">
      <div class="wf-title"><strong>${escapeHtml(bt.name)}</strong>
        <span class="row-actions"><button class="link" data-design-form="${escapeHtml(bt.code)}" data-design-name="${escapeHtml(bt.name)}">设计表单</button></span></div>
      <div class="muted" style="font-size:12.5px">${bt.is_preset ? "预置业务" : "自定义业务"} · ${bt.category === "document" ? "公文类" : "申请类"} · ${escapeHtml(accountStatusText(bt.status))}</div>
    </div>`;
  }

  // 表单设计器：增删改排序字段，保存为新版本并启用（动态表单设计器）。
  async function openFormDesigner(code, name) {
    let form = null;
    try { const r = await api(`/api/business-types/${code}/form`); form = r.form; } catch (e) { /* 可能尚无启用表单 */ }
    let fields = (form && form.schema ? form.schema : []).map((f) => ({ key: f.key, label: f.label, type: f.type || "text", required: !!f.required, options: (f.options || []).join(", ") }));
    if (!fields.length) fields = [{ key: "reason", label: "事由", type: "textarea", required: true, options: "" }];
    const TYPES = [["text", "单行文本"], ["textarea", "多行文本"], ["select", "下拉选择"], ["date", "日期"], ["datetime", "日期时间"], ["number", "数字"]];
    openModal(`表单设计 · ${escapeHtml(name)}`, `
      <label>表单名称<input id="fdName" value="${form ? escapeHtml(form.name) : escapeHtml(name + "默认表单")}" /></label>
      <p class="muted" style="margin:8px 0; line-height:1.7">标准字段 <b>category / startDate / endDate / reason</b> 会自动归入申请主体；其余字段进入扩展信息。<b>下拉</b>类型在「选项」列用逗号分隔。标识须字母开头（字母/数字/下划线）。</p>
      <div id="fdList"></div>
      <div class="row-actions" style="margin:10px 0"><button class="secondary" id="fdAdd" type="button">+ 新增字段</button></div>
      <div class="row-actions"><button class="primary" id="fdSave" type="button">保存并启用</button><button class="secondary modal-cancel" type="button">取消</button></div>`);
    const renderList = () => {
      $("fdList").innerHTML = `<table class="fd-table">
        <thead><tr><th>标识</th><th>名称</th><th>类型</th><th>必填</th><th>选项(下拉)</th><th>排序</th></tr></thead>
        <tbody>${fields.map((f, i) => `<tr>
          <td><input data-fd="key" data-i="${i}" value="${escapeHtml(f.key)}" style="width:88px" /></td>
          <td><input data-fd="label" data-i="${i}" value="${escapeHtml(f.label)}" style="width:108px" /></td>
          <td><select data-fd="type" data-i="${i}">${TYPES.map(([v, l]) => `<option value="${v}" ${f.type === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
          <td style="text-align:center"><input type="checkbox" data-fd="required" data-i="${i}" ${f.required ? "checked" : ""} /></td>
          <td><input data-fd="options" data-i="${i}" value="${escapeHtml(f.options)}" placeholder="选项1,选项2" style="width:140px" ${f.type === "select" ? "" : "disabled"} /></td>
          <td class="row-actions"><button class="link" data-fdmv="up" data-i="${i}">↑</button><button class="link" data-fdmv="down" data-i="${i}">↓</button><button class="link danger" data-fddel="${i}">✕</button></td>
        </tr>`).join("")}</tbody></table>`;
      $("fdList").querySelectorAll("[data-fd]").forEach((el) => {
        const i = Number(el.dataset.i); const k = el.dataset.fd;
        const ev = el.type === "checkbox" ? "change" : "input";
        el.addEventListener(ev, () => { fields[i][k] = el.type === "checkbox" ? el.checked : el.value; if (k === "type") renderList(); });
      });
      $("fdList").querySelectorAll("[data-fddel]").forEach((b) => b.addEventListener("click", () => {
        fields.splice(Number(b.dataset.fddel), 1);
        if (!fields.length) fields.push({ key: "field1", label: "字段1", type: "text", required: false, options: "" });
        renderList();
      }));
      $("fdList").querySelectorAll("[data-fdmv]").forEach((b) => b.addEventListener("click", () => {
        const i = Number(b.dataset.i); const j = i + (b.dataset.fdmv === "up" ? -1 : 1);
        if (j < 0 || j >= fields.length) return;
        [fields[i], fields[j]] = [fields[j], fields[i]]; renderList();
      }));
    };
    renderList();
    $("fdAdd").addEventListener("click", () => { fields.push({ key: "field" + (fields.length + 1), label: "新字段", type: "text", required: false, options: "" }); renderList(); });
    $("fdSave").addEventListener("click", async () => {
      const schema = fields.map((f) => {
        const o = { key: String(f.key).trim(), label: String(f.label).trim(), type: f.type, required: !!f.required };
        if (f.type === "select") o.options = String(f.options || "").split(",").map((s) => s.trim()).filter(Boolean);
        return o;
      });
      try {
        await api("/api/forms", { method: "POST", body: JSON.stringify({ businessType: code, name: $("fdName").value.trim() || name + "默认表单", schema }) });
        delete formCache[code];
        closeModal(); await renderPlatform();
      } catch (err) { alert(err.message); }
    });
  }

  function openRoleModuleForm(rolesData) {
    openModal("配置角色菜单权限", `
      <form id="roleModuleForm" class="form-grid">
        <label>角色<select name="roleId">${rolesData.roles.map((r) => `<option value="${r.id}" data-code="${r.code}">${escapeHtml(r.name)}</option>`).join("")}</select></label>
        <div class="full">${rolesData.modules.map((m) => `<label class="chk"><input type="checkbox" name="moduleCodes" value="${m.code}" /> ${escapeHtml((moduleMeta[m.code] && moduleMeta[m.code].title) || m.name)}</label>`).join("")}</div>
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    const form = $("roleModuleForm");
    const sync = () => {
      const code = form.querySelector("select").selectedOptions[0].dataset.code;
      const allowed = rolesData.roleModules.filter((i) => i.role_code === code).map((i) => i.module_code);
      form.querySelectorAll("[name='moduleCodes']").forEach((cb) => { cb.checked = allowed.includes(cb.value); });
    };
    form.querySelector("select").addEventListener("change", sync); sync();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const roleId = form.querySelector("select").value;
      const moduleCodes = Array.from(form.querySelectorAll("[name='moduleCodes']:checked")).map((i) => i.value);
      try { await api(`/api/roles/${roleId}/modules`, { method: "PUT", body: JSON.stringify({ moduleCodes }) }); closeModal(); await renderPlatform(); }
      catch (err) { alert(err.message); }
    });
  }

  /* ---------------- 业务（请假/出差/用车） ---------------- */

  function filterBar(type) {
    const cats = (categoryOptions[type] || []).map((c) => `<option value="${c}">${c}</option>`).join("");
    return `<div class="filter-bar">
      <input data-f="keyword" placeholder="关键字（事由/申请人）" />
      <select data-f="status"><option value="">全部状态</option><option value="pending">待审批</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="withdrawn">已撤回</option></select>
      ${cats ? `<select data-f="category"><option value="">全部类别</option>${cats}</select>` : ""}
      <input data-f="from" type="date" title="开始日期起" />
      <input data-f="to" type="date" title="开始日期止" />
      <button class="secondary" data-do-filter>查询</button>
      <button class="link" data-reset-filter>重置</button>
    </div>`;
  }

  function readFilters() {
    const params = new URLSearchParams();
    viewRoot.querySelectorAll("[data-f]").forEach((el) => { if (el.value) params.set(el.dataset.f, el.value); });
    return params;
  }

  async function renderBusiness(type) {
    await ensureForms(type);
    const title = typeText(type);
    viewRoot.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <button class="primary" data-create="${type}">新增${title}申请</button>
          <button class="secondary" data-export="/api/export/requests.xlsx?type=${type}">导出 Excel</button>
        </div>
      </div>
      ${filterBar(type)}
      <section class="panel"><div class="panel-header"><h2>${canApprove() ? title + "业务列表" : "我的" + title + "申请"}</h2><span class="muted">${canApprove() ? "可审批本部门/全中心单据" : "仅显示本人申请与进度"}</span></div>
        <div class="panel-body" id="bizTable"></div></section>`;
    bindActions();
    const load = async (page = 1) => {
      const p = readFilters(); p.set("type", type); p.set("page", page); p.set("pageSize", 20);
      const data = await api(`/api/requests?${p.toString()}`);
      $("bizTable").innerHTML = renderRequestTable(data.items) + pager(data.total, data.page, data.pageSize);
      bindRowActions($("bizTable"));
      bindPagerEl($("bizTable"), load);
    };
    bindFilter(() => load(1));
    await load(1);
  }

  function bindFilter(run) {
    const btn = viewRoot.querySelector("[data-do-filter]");
    if (btn) btn.addEventListener("click", run);
    const reset = viewRoot.querySelector("[data-reset-filter]");
    if (reset) reset.addEventListener("click", () => { viewRoot.querySelectorAll("[data-f]").forEach((el) => { el.value = ""; }); run(); });
    viewRoot.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); }));
  }

  function renderRequestTable(rows) {
    if (!rows.length) return `<div class="empty">暂无业务记录</div>`;
    const showWho = canApprove(); // 普通职工只看自己的单据，隐藏“申请人/科室”列
    return `<table>
      <thead><tr><th>类别</th>${showWho ? "<th>申请人</th><th>科室</th>" : ""}<th>时间</th><th>事由</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows.map((item) => `<tr>
        <td>${escapeHtml(item.category)}</td>
        ${showWho ? `<td>${escapeHtml(item.applicant_name)}</td><td>${escapeHtml(item.dept_name)}</td>` : ""}
        <td>${escapeHtml(String(item.start_date || "").replace("T", " "))} 至 ${escapeHtml(String(item.end_date || "").replace("T", " "))}<br><span class="muted">${escapeHtml(item.current_node)}</span></td>
        <td>${escapeHtml(item.reason)}</td>
        <td><span class="status ${escapeHtml(item.status)}">${statusText(item.status)}</span></td>
        <td class="row-actions">
          <button class="secondary" data-detail="${item.id}">查看</button>
          ${canApprove() && item.status === "pending" && item.current_approver_id === session.id ? `<button class="secondary" data-approve="${item.id}">审批</button>` : ""}
          ${item.status === "pending" && item.applicant_id === session.id ? `<button class="secondary" data-withdraw="${item.id}">撤回</button>` : ""}
        </td></tr>`).join("")}</tbody></table>`;
  }

  async function openRequestForm(type) {
    await ensureForms(type);
    if (type === "leave") return openLeaveForm();
    if (type === "vehicle") return openVehicleRequestForm();
    if (type === "trip") return openTripForm();
    const title = `${typeText(type)}申请`;
    const cats = categoryOptions[type] || [];
    const extra = (requestFields[type] || []).map((f) => renderSchemaField(f)).join("");
    openModal(title, `
      <form id="requestForm" class="form-grid">
        <label>申请人<input value="${escapeHtml(session.name)}" disabled /></label>
        <label>所在科室<input value="${escapeHtml(session.dept)}" disabled /></label>
        <label>${typeText(type)}类别<select name="category">${cats.map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label>申请时间<input type="datetime-local" name="applyTime" value="${nowLocal()}" /></label>
        <label>开始日期<input type="date" name="startDate" value="${new Date().toISOString().slice(0, 10)}" required /></label>
        <label>结束日期<input type="date" name="endDate" value="${new Date().toISOString().slice(0, 10)}" required /></label>
        ${extra}
        <label class="full">事由<textarea name="reason" required></textarea></label>
        <div class="full row-actions"><button class="primary" type="submit">提交审批</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("requestForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const fields = {};
      (requestFields[type] || []).forEach((fd) => { fields[fd.key] = f.get(`fld_${fd.key}`) || ""; });
      try {
        await api("/api/requests", { method: "POST", body: JSON.stringify({
          type, category: f.get("category"), startDate: f.get("startDate"), endDate: f.get("endDate"),
          reason: f.get("reason"), applyTime: toISO(f.get("applyTime")), fields,
        }) });
        closeModal(); await setView(type);
        refreshNotify();
      } catch (err) { alert(err.message); }
    });
  }

  // 职工请假审批单：按图样式 —— 姓名/科室/入职/年假/类型/到何处/联系电话/起止/天数/事由
  async function openLeaveForm() {
    const today = new Date().toISOString().slice(0, 10);
    const curYear = new Date().getFullYear();
    let profile = {};
    try { profile = await api("/api/me/profile"); } catch (e) { /* 不阻断 */ }
    const cats = categoryOptions.leave || ["事假","病假","年假","婚假","产假","丧假","调休","其他"];
    const years = [];
    for (let y = curYear - 1; y <= curYear + 1; y += 1) years.push(y);
    openModal("职工请假审批单", `
      <form id="leaveForm" class="leave-form">
        <div class="leave-row">
          <label>姓名<input value="${escapeHtml(profile.name || session.name)}" disabled /></label>
          <label>科所名称<input value="${escapeHtml(profile.dept || session.dept)}" disabled /></label>
          <label>参加工作时间<input value="${escapeHtml(profile.entry_date || "（未录入）")}" disabled /></label>
        </div>
        <div class="leave-row">
          <label>休假年度<select id="lvYear">${years.map((y) => `<option value="${y}" ${y === curYear ? "selected" : ""}>${y}</option>`).join("")}</select></label>
          <label>年假天数<input id="lvTotal" value="-" disabled /></label>
          <label>年假可用天数<input id="lvAvail" value="-" disabled /></label>
        </div>
        <div class="leave-row">
          <label>请假类型<select name="category" id="lvCat" required>${cats.map((c) => `<option ${c === "事假" ? "selected" : ""}>${c}</option>`).join("")}</select></label>
          <label>到何处<input name="destination" placeholder="如：广西南宁" /></label>
          <label>联系电话<input name="contactPhone" value="${escapeHtml(profile.phone || "")}" placeholder="如 13800138000" /></label>
        </div>
        <div class="leave-row">
          <label>开始时间<input type="datetime-local" name="startDate" id="lvStart" value="${today}T09:00" required /></label>
          <label>结束时间<input type="datetime-local" name="endDate" id="lvEnd" value="${today}T18:00" required /></label>
          <label>请假天数<input id="lvDays" value="1" disabled /><small class="muted" id="lvAnnualHint" style="display:none">年假本次扣减：<b id="lvAnnualDays">0</b> 天</small></label>
        </div>
        <label class="leave-full">请假事由<textarea name="reason" required placeholder="请简述事由" rows="3"></textarea></label>
        <label class="leave-full">申请时间<input type="datetime-local" name="applyTime" value="${nowLocal()}" /></label>
        <div class="row-actions" style="margin-top:14px">
          <button class="primary" type="submit">提交审批</button>
          <button class="secondary modal-cancel" type="button">取消</button>
        </div>
      </form>`);
    const $f = (id) => document.getElementById(id);
    // 请假天数支持半天：纯日期（YYYY-MM-DD）走"含首尾整天数"，含时分的按 8 小时 / 天换算并就近 0.5 取整，最少 0.5 天
    const dayDiff = (s, e) => {
      if (!s || !e) return 0;
      const a = new Date(s), b = new Date(e);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      if (dateOnly.test(s) && dateOnly.test(e)) return Math.max(0, Math.floor((b - a) / 86400000) + 1);
      const hours = Math.max(0, (b - a) / 3600000);
      return Math.max(0.5, Math.round((hours / 8) * 2) / 2);
    };
    const recompute = () => {
      const d = dayDiff($f("lvStart").value, $f("lvEnd").value);
      $f("lvDays").value = d;
      const isAnnual = $f("lvCat").value === "年假";
      $f("lvAnnualHint").style.display = isAnnual ? "" : "none";
      $f("lvAnnualDays").textContent = d;
    };
    const refreshBalance = async () => {
      const y = $f("lvYear").value;
      try {
        const b = await api(`/api/annual-leave/me?year=${y}`);
        $f("lvTotal").value = b.total_days || 0;
        $f("lvAvail").value = b.available_days || 0;
      } catch (e) { $f("lvTotal").value = "-"; $f("lvAvail").value = "-"; }
    };
    ["lvStart","lvEnd","lvCat","lvYear"].forEach((id) => $f(id).addEventListener("change", () => { recompute(); if (id === "lvYear") refreshBalance(); }));
    recompute(); refreshBalance();

    $("leaveForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const days = dayDiff(f.get("startDate"), f.get("endDate"));
      if (days <= 0) return alert("起止日期不合法");
      if (f.get("category") === "年假") {
        const avail = Number($f("lvAvail").value || 0);
        if (avail <= 0) return alert(`${$f("lvYear").value} 年没有可用年假额度，请联系管理员录入`);
        if (days > avail) return alert(`年假可用 ${avail} 天，本次申请 ${days} 天超额`);
      }
      const fields = {
        destination: f.get("destination") || "",
        contactPhone: f.get("contactPhone") || "",
        leaveYear: $f("lvYear").value,
        days: String(days),
      };
      try {
        await api("/api/requests", { method: "POST", body: JSON.stringify({
          type: "leave", category: f.get("category"),
          startDate: f.get("startDate"), endDate: f.get("endDate"),
          reason: f.get("reason"), applyTime: toISO(f.get("applyTime")), fields,
        }) });
        closeModal(); await setView("leave"); refreshNotify();
      } catch (err) { alert(err.message); }
    });
  }

  // 用车申请表：精简时间字段 —— 用车开始/结束时间 + 用车小时数（其余冗余时间字段已合并）
  async function openVehicleRequestForm() {
    const cats = categoryOptions.vehicle || ["公务用车","下乡采样","会议用车","应急用车"];
    const suggestions = ["请选择","外协调度","公交出行","自驾报销","改期","取消用车"];
    const nowDt = nowLocal();
    let vehicles = [];
    try { vehicles = await api("/api/vehicles"); } catch (e) { /* 普通员工无权限取车辆台账时为空 */ }
    // 必填星号统一使用 req-label 包装，避免出现在 grid label 内成为独立一行造成的错位
    const req = (text) => `<span class="req-label"><span class="req-mark">*</span>${text}</span>`;
    openModal("用车申请表", `
      <form id="vehicleReqForm" class="leave-form">
        <div class="leave-row">
          <label>申请科（室）<input value="${escapeHtml(session.dept)}" disabled /></label>
          <label>申请人<input value="${escapeHtml(session.name)}" disabled /></label>
          <label>申请时间<input value="${fmtTime(new Date())}" disabled /></label>
        </div>
        <div class="leave-row">
          <label>用车类别<select name="category">${cats.map((c) => `<option>${c}</option>`).join("")}</select></label>
          <label>${req("用车开始时间")}<input type="datetime-local" id="vrStart" name="startDateTime" value="${nowDt}" required /></label>
          <label>${req("用车结束时间")}<input type="datetime-local" id="vrEnd" name="endDateTime" value="${nowDt}" required /></label>
        </div>
        <label class="leave-full">${req("用车事由")}<textarea name="reason" required rows="2" placeholder="请简述用车事由"></textarea></label>
        <label class="leave-full">${req("用车去向")}<input name="destinationDetail" required placeholder="如 中心 → 玉林市疾控中心 → 中心" /></label>
        <div class="leave-row">
          <label>${req("乘车人员")}<input name="passengers" required placeholder="如 张医生、王科长" /></label>
          <label>${req("乘车人数")}<input name="passengerCount" type="number" min="1" value="1" required /></label>
          <label>用车小时数<input id="vrHours" name="durationHours" type="number" step="0.1" value="0" readonly /></label>
        </div>
        <div class="leave-row">
          <label>${req("候车地点")}<input name="waitLocation" required placeholder="如 单位门口" /></label>
          <label>无中心车时，科室建议<select name="deptSuggestion">${suggestions.map((s) => `<option>${s}</option>`).join("")}</select></label>
          <label>其他要求<input name="otherRequirement" placeholder="如 需后备箱装设备" /></label>
        </div>
        <div class="leave-row">
          <label>本单位联系人<input name="internalContact" value="${escapeHtml(session.name)}" /></label>
          <label>本单位联系电话<input name="internalPhone" placeholder="如 13788251337" /></label>
          <label>外单位联系人<input name="externalContact" placeholder="如有外单位对接人" /></label>
        </div>
        <div class="leave-row">
          <label>外单位联系电话<input name="externalPhone" placeholder="外单位联系电话" /></label>
          <label>调度建议-驾驶员<input name="preassignDriver" placeholder="留空由办公室分派" /></label>
          <label>调度建议-车号<select name="preassignVehicleId"><option value="">由办公室分派</option>${vehicles.map((v) => `<option value="${escapeHtml(v.plate_no)}">${escapeHtml(v.plate_no)} · ${escapeHtml(v.driver)}</option>`).join("")}</select></label>
        </div>
        <label class="leave-full">备注<input name="remark" placeholder="其他需要说明的内容" /></label>
        <div class="row-actions" style="margin-top:14px">
          <button class="primary" type="submit">提交审批</button>
          <button class="secondary modal-cancel" type="button">取消</button>
        </div>
      </form>`);
    const $f = (id) => document.getElementById(id);
    const recomputeHours = () => {
      const s = $f("vrStart").value, e = $f("vrEnd").value;
      if (!s || !e) { $f("vrHours").value = 0; return; }
      const a = new Date(s), b = new Date(e);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) { $f("vrHours").value = 0; return; }
      const diff = Math.max(0, (b - a) / 3600000);
      $f("vrHours").value = Math.round(diff * 10) / 10;
    };
    ["vrStart","vrEnd"].forEach((id) => $f(id).addEventListener("change", recomputeHours));
    recomputeHours();

    $("vehicleReqForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const startDt = f.get("startDateTime") || "";
      const endDt = f.get("endDateTime") || "";
      // startDate/endDate 由开始/结束时间派生，避免再让用户重复填一遍日期
      const startDate = startDt ? startDt.slice(0, 10) : "";
      const endDate = endDt ? endDt.slice(0, 10) : "";
      const fields = {
        destinationDetail: f.get("destinationDetail") || "",
        passengers: f.get("passengers") || "",
        passengerCount: f.get("passengerCount") || "",
        startDateTime: toISO(startDt) || "",
        endDateTime: toISO(endDt) || "",
        durationHours: f.get("durationHours") || "",
        waitLocation: f.get("waitLocation") || "",
        deptSuggestion: (f.get("deptSuggestion") === "请选择" ? "" : f.get("deptSuggestion")) || "",
        internalContact: f.get("internalContact") || "",
        internalPhone: f.get("internalPhone") || "",
        externalContact: f.get("externalContact") || "",
        externalPhone: f.get("externalPhone") || "",
        otherRequirement: f.get("otherRequirement") || "",
        preassignDriver: f.get("preassignDriver") || "",
        preassignVehicleId: f.get("preassignVehicleId") || "",
        remark: f.get("remark") || "",
      };
      try {
        await api("/api/requests", { method: "POST", body: JSON.stringify({
          type: "vehicle",
          category: f.get("category"),
          startDate,
          endDate,
          reason: f.get("reason"),
          fields,
        }) });
        closeModal(); await setView("vehicle"); refreshNotify();
      } catch (err) { alert(err.message); }
    });
  }

  // 出差申请表：按"出差申请表"模板布局 ——
  // 出差人员名单（选人）+ 带队者（选人）+ 出差时间安排（起止+天数）+
  // 出差类别（单选）+ 出差类型（下拉，"其他"末位需补充） + 出差目的地 + 任务/公文（关联）+
  // 出差事由（合并原"工作事项"）+ 交通工具（下拉，"其他"末位需补充）+ 差旅费预算 + 开支渠道 + 每人学费 + 备注
  async function openTripForm() {
    const tripCats = (categoryOptions.trip && categoryOptions.trip.length
      ? categoryOptions.trip
      : ["市内出差", "市外出差", "省外出差"]);
    // 配置里如果没有"其他"，强制补一个并放到末位；UI 上选中"其他"后展开文字补充。
    // 旧数据库里 transportTools 没带"其他"，但表单一定要给一个兜底入口。
    const ensureOtherLast = (arr) => [...arr.filter((c) => c !== "其他"), "其他"];
    const tripTypeOptions = ensureOtherLast((formCache.trip || []).find((f) => f.key === "tripTypes")?.options
      || ["督导", "调查", "检测", "疫情处理", "开展业务培训", "工作会议", "参加业务培训", "学术会议", "进修学习"]);
    const transportOptions = ensureOtherLast((formCache.trip || []).find((f) => f.key === "transportTools")?.options
      || ["火车", "高铁/动车", "全列软席列车", "汽车", "轮船", "飞机", "单位派车", "租赁车辆", "乘坐出租车往返机场（车站）"]);
    const today = new Date().toISOString().slice(0, 10);
    const nowDt = nowLocal();
    // 出差表单需要"选人"——用通用 picker 接口，普通员工也能拉到名册
    let dir = [];
    try { dir = await getPickerDirectory(); } catch (e) { /* 拉不到名册时退化为只能手输 */ }
    let docs = [];
    try {
      const r = await api(`/api/documents?pageSize=50`);
      docs = r.items || [];
    } catch (e) { /* 普通员工无公文权限时为空 */ }

    const dirOpts = dir.map((u) => `<option value="${u.id}" data-name="${escapeHtml(u.name)}" data-dept="${escapeHtml(u.dept || "")}">${escapeHtml(u.name)}（${escapeHtml(u.dept || "")}）</option>`).join("");
    const docOpts = `<option value="">不关联公文</option>` + docs.map((d) => `<option value="${d.id}" data-title="${escapeHtml(d.title)}">${escapeHtml(d.no || "")}　${escapeHtml(d.title)}</option>`).join("");
    const radioCats = tripCats.map((c, i) => `<label class="inline-choice"><input type="radio" name="category" value="${escapeHtml(c)}" ${i === 0 ? "checked" : ""} required /> ${escapeHtml(c)}</label>`).join("");
    const tripTypeSelOpts = `<option value="">-- 请选择 --</option>` + tripTypeOptions.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    const transportSelOpts = `<option value="">-- 请选择 --</option>` + transportOptions.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    // 必填星号：用单一 span 包住"星 + 文字"，避免在 grid label 里被拆成独立一行
    const reqLabel = (text) => `<span class="req-label"><span class="req-mark">*</span>${escapeHtml(text)}</span>`;

    openModal("出差申请表", `
      <form id="tripForm" class="leave-form trip-form">
        <div class="leave-row">
          <label>填报部门<input value="${escapeHtml(session.dept)}" disabled /></label>
          <label>申请人<input value="${escapeHtml(session.name)}" disabled /></label>
          <label>填表时间<input type="datetime-local" name="applyTime" value="${nowDt}" /></label>
        </div>

        <label class="leave-full">出差人员名单
          <div class="person-picker">
            <div class="picker-tags" id="tpPersonnelTags"></div>
            <div class="picker-controls">
              <div class="combo-wrap">
                <input type="text" id="tpPersonnelAdd" autocomplete="off" placeholder="输入姓名 / 部门搜索，回车或点击加入" />
                <div class="combo-dropdown" id="tpPersonnelList" hidden></div>
              </div>
              <button type="button" class="link" id="tpPersonnelClear">清空</button>
            </div>
            <input type="hidden" name="personnel" id="tpPersonnelNames" />
            <input type="hidden" name="personnelIds" id="tpPersonnelIds" />
          </div>
        </label>

        <label class="leave-full">${reqLabel(" 带队者")}
          <div class="combo-wrap">
            <input type="text" id="tpLeader" autocomplete="off" placeholder="输入姓名 / 部门搜索带队者" />
            <div class="combo-dropdown" id="tpLeaderList" hidden></div>
          </div>
          <input type="hidden" name="leader" id="tpLeaderName" />
          <input type="hidden" name="leaderId" id="tpLeaderId" />
        </label>

        <div class="leave-row">
          <label>${reqLabel("出差开始日期")}<input type="date" name="startDate" id="tpStart" value="${today}" required /></label>
          <label>${reqLabel("出差结束日期")}<input type="date" name="endDate" id="tpEnd" value="${today}" required /></label>
          <label>出差天数<input id="tpDays" value="1" disabled /></label>
        </div>

        <label class="leave-full">${reqLabel(" 出差类别")}
          <div class="inline-group">${radioCats}</div>
        </label>

        <label class="leave-full">出差类型
          <select name="tripType" id="tpTripType">${tripTypeSelOpts}</select>
          <input name="tripTypeOther" id="tpTripTypeOther" placeholder="请填写其他出差类型" style="display:none;margin-top:6px" />
        </label>

        <label class="leave-full">${reqLabel(" 出差目的地")}
          <input name="destination" required placeholder="如 南宁市 / 北京市 / 广西医科大学" />
        </label>

        <label class="leave-full">任务/公文
          <select name="taskDocId" id="tpDoc">${docOpts}</select>
        </label>

        <label class="leave-full">${reqLabel(" 出差事由")}
          <textarea name="reason" required rows="3" placeholder="请简述本次出差的事由、工作内容与任务安排"></textarea>
        </label>

        <label class="leave-full">交通工具
          <select name="transportTool" id="tpTransport">${transportSelOpts}</select>
          <input name="transportToolOther" id="tpTransportOther" placeholder="请填写其他交通工具" style="display:none;margin-top:6px" />
        </label>

        <div class="leave-row">
          <label>${reqLabel(" 差旅费预算（元）")}<input name="budgetAmount" type="number" min="0" step="0.01" required placeholder="0.00" /></label>
          <label>差旅费开支渠道<input name="budgetChannel" placeholder="如 项目经费 / 公用经费" /></label>
          <label>每人学费（元）<input name="tuitionPerPerson" type="number" min="0" step="0.01" placeholder="无填 0" /></label>
        </div>

        <label class="leave-full">备注<textarea name="remark" rows="2" placeholder="其他需要说明的内容"></textarea></label>

        <div class="row-actions" style="margin-top:14px">
          <button class="primary" type="submit">提交审批</button>
          <button class="secondary modal-cancel" type="button">取消</button>
        </div>
      </form>`);

    const $f = (id) => document.getElementById(id);

    // 天数计算
    const dayDiff = (s, e) => {
      if (!s || !e) return 0;
      const a = new Date(s), b = new Date(e);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
      return Math.max(0, Math.floor((b - a) / 86400000) + 1);
    };
    const recompute = () => { $f("tpDays").value = dayDiff($f("tpStart").value, $f("tpEnd").value); };
    ["tpStart", "tpEnd"].forEach((id) => $f(id).addEventListener("change", recompute));
    recompute();

    // 出差人员选人：选中后追加为 tag，去重；可点 × 移除
    const selected = new Map(); // id -> { id, name, dept }
    const renderTags = () => {
      const tags = $f("tpPersonnelTags");
      tags.innerHTML = selected.size === 0
        ? `<span class="muted" style="font-size:12px">尚未选择</span>`
        : Array.from(selected.values()).map((p) => `<span class="person-tag" data-id="${p.id}">${escapeHtml(p.name)}<small>${escapeHtml(p.dept || "")}</small><button type="button" data-remove="${p.id}" title="移除">×</button></span>`).join("");
      $f("tpPersonnelNames").value = Array.from(selected.values()).map((p) => p.name).join("、");
      $f("tpPersonnelIds").value = Array.from(selected.values()).map((p) => p.id).join(",");
      tags.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => { selected.delete(Number(b.dataset.remove)); renderTags(); }));
    };
    // 人员搜索下拉：输入子串匹配 name / dept；方向键 + 回车 + 鼠标点击都可选中。
    // 调用方通过 getCandidates() 决定可见选项（如：出差人员里要排除已选；带队者无需排除）。
    const bindPersonCombo = ({ input, list, getCandidates, onPick }) => {
      let active = -1;
      let matches = [];
      const render = () => {
        list.innerHTML = !matches.length
          ? `<div class="combo-empty">无匹配人员</div>`
          : matches.map((u, i) => `<div class="combo-item${i === active ? " active" : ""}" data-id="${u.id}">${escapeHtml(u.name)} <small>${escapeHtml(u.dept || "")}</small></div>`).join("");
        list.hidden = false;
      };
      const refresh = () => {
        const s = input.value.trim().toLowerCase();
        matches = getCandidates()
          .filter((u) => !s || u.name.toLowerCase().includes(s) || (u.dept || "").toLowerCase().includes(s))
          .slice(0, 30);
        active = matches.length ? 0 : -1;
        render();
      };
      input.addEventListener("focus", refresh);
      input.addEventListener("input", refresh);
      // blur 时延迟关闭，把鼠标点击事件让出去
      input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 150));
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); render(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
        else if (e.key === "Enter") {
          if (active >= 0 && matches[active]) { e.preventDefault(); onPick(matches[active]); }
        } else if (e.key === "Escape") { list.hidden = true; }
      });
      list.addEventListener("mousedown", (e) => {
        const item = e.target.closest("[data-id]");
        if (!item) return;
        e.preventDefault(); // 阻止 input 先 blur
        const u = matches.find((x) => String(x.id) === item.dataset.id);
        if (u) onPick(u);
      });
      return { refresh };
    };

    // 出差人员名单：可重复添加（同一人去重）。选中后清空输入框，焦点保留，方便连续加人。
    const personCombo = bindPersonCombo({
      input: $f("tpPersonnelAdd"),
      list: $f("tpPersonnelList"),
      getCandidates: () => dir.filter((u) => !selected.has(u.id)),
      onPick: (u) => {
        if (!selected.has(u.id)) selected.set(u.id, { id: u.id, name: u.name, dept: u.dept });
        $f("tpPersonnelAdd").value = "";
        renderTags();
        personCombo.refresh();
        $f("tpPersonnelAdd").focus();
      },
    });
    $f("tpPersonnelClear").addEventListener("click", () => { selected.clear(); renderTags(); personCombo.refresh(); });
    renderTags();

    // 带队者：单选，落到两个隐藏字段（姓名 + id）。手动清空输入时同步清空隐藏 id。
    const leaderInput = $f("tpLeader");
    const leaderName = $f("tpLeaderName");
    const leaderId = $f("tpLeaderId");
    const leaderCombo = bindPersonCombo({
      input: leaderInput,
      list: $f("tpLeaderList"),
      getCandidates: () => dir,
      onPick: (u) => {
        leaderInput.value = `${u.name}（${u.dept || ""}）`;
        leaderName.value = u.name;
        leaderId.value = String(u.id);
        $f("tpLeaderList").hidden = true;
      },
    });
    leaderInput.addEventListener("input", () => {
      // 用户改文字就视为重新挑：清掉已落字段，直到再次选中
      leaderName.value = "";
      leaderId.value = "";
    });
    void leaderCombo;

    // "其他"分支：选中后展开同级文字补充，未选中时隐藏并清空，避免脏数据
    const bindOtherToggle = (selectId, otherId) => {
      const sel = $f(selectId);
      const other = $f(otherId);
      const sync = () => {
        const isOther = sel.value === "其他";
        other.style.display = isOther ? "block" : "none";
        if (isOther) {
          other.setAttribute("required", "required");
        } else {
          other.removeAttribute("required");
          other.value = "";
        }
      };
      sel.addEventListener("change", sync);
      sync();
    };
    bindOtherToggle("tpTripType", "tpTripTypeOther");
    bindOtherToggle("tpTransport", "tpTransportOther");

    // 把"主选项 + 其他文字补充"折叠成一个展示值（"其他：xxx"），存进既有字段保持兼容
    const mergeOther = (mainVal, otherVal) => {
      if (!mainVal) return "";
      if (mainVal !== "其他") return mainVal;
      const t = (otherVal || "").trim();
      return t ? `其他：${t}` : "其他";
    };

    $("tripForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const days = dayDiff(f.get("startDate"), f.get("endDate"));
      if (days <= 0) return alert("起止日期不合法");

      // 带队者：来自搜索式 combobox，落 id + name 两个字段；二者都得有才算合法选择
      const leaderName = f.get("leader") || "";
      const leaderId = f.get("leaderId") || "";
      if (!leaderId || !leaderName) {
        $f("tpLeader").focus();
        return alert("请从下拉列表选择带队者");
      }

      // 关联公文：select 存的是 document id，附带 title 便于详情展示
      const docSelect = $f("tpDoc");
      const docOpt = docSelect.selectedOptions[0];
      const taskDocTitle = docOpt && docOpt.value ? docOpt.dataset.title : "";

      const fields = {
        personnel: f.get("personnel") || "",
        personnelIds: f.get("personnelIds") || "",
        leader: leaderName,
        leaderId,
        // 复用原字段名（tripTypes/transportTools）便于历史详情、统计页继续工作
        tripTypes: mergeOther(f.get("tripType") || "", f.get("tripTypeOther") || ""),
        destination: f.get("destination") || "",
        taskDocId: f.get("taskDocId") || "",
        taskDocTitle,
        transportTools: mergeOther(f.get("transportTool") || "", f.get("transportToolOther") || ""),
        budgetAmount: f.get("budgetAmount") || "",
        budgetChannel: f.get("budgetChannel") || "",
        tuitionPerPerson: f.get("tuitionPerPerson") || "",
        remark: f.get("remark") || "",
        days: String(days),
      };
      try {
        await api("/api/requests", { method: "POST", body: JSON.stringify({
          type: "trip",
          category: f.get("category"),
          startDate: f.get("startDate"),
          endDate: f.get("endDate"),
          reason: f.get("reason"),
          applyTime: toISO(f.get("applyTime")),
          fields,
        }) });
        closeModal(); await setView("trip"); refreshNotify();
      } catch (err) { alert(err.message); }
    });
  }

  // 渲染流程链路：优先按 DAG（节点坐标 + edges）绘 SVG 缩略图；无坐标时回退线性列表。
  function renderFlowSteps(item) {
    const nodes = item.workflow_nodes || [];
    if (!nodes.length) return "";
    const edges = item.workflow_edges || [];
    const actByNode = {};
    (item.approvals || []).forEach((a) => {
      if (a.action === "同意" || a.action === "驳回") actByNode[a.node_name] = a;
    });
    const isPending = item.status === "pending";
    // 当前活跃节点（多 token 时按名拼出多个 current）
    const currentNames = new Set();
    if (isPending) {
      if (item.current_node && item.current_node.startsWith("并行：")) {
        item.current_node.replace("并行：", "").split(" / ").forEach((s) => currentNames.add(s.trim()));
      } else if (item.current_node) {
        currentNames.add(item.current_node);
      }
    }
    // 流程整体办结：发文分发后 / 申请审批通过后，单据落到「归档」等终态节点，
    // 该节点不产生审批动作（无人“审批归档”），需按办结状态点亮，否则永远显示「未到达」。
    const isDone = item.status === "approved" || item.status === "archived" || item.status === "done";
    const isEndNode = (n) => n.node_kind === "end" || /归档|办结|结束/.test(n.node_name || "");
    const statusOf = (n) => {
      const act = actByNode[n.node_name];
      if (act && act.action === "同意") return { cls: "done", badge: "已通过", who: act.approver_name, when: fmtTime(act.approved_at) };
      if (act && act.action === "驳回") return { cls: "rejected", badge: "已驳回", who: act.approver_name, when: fmtTime(act.approved_at) };
      if (isDone && isEndNode(n)) return { cls: "done", badge: "已归档", who: n.expected_approver_name || "", when: fmtTime(item.updated_at) };
      if (isPending && currentNames.has(n.node_name)) return { cls: "current", badge: "待审批", who: item.current_approver_name || n.expected_approver_name || "" };
      return { cls: "todo", badge: "未到达", who: n.expected_approver_name ? `预计 ${n.expected_approver_name}` : "", when: "" };
    };

    // 有坐标 + 有边 ⇒ DAG 渲染；否则回退线性
    const hasPositions = nodes.some((n) => Number(n.pos_x) > 0 || Number(n.pos_y) > 0);
    if (!hasPositions || !edges.length) {
      const lis = nodes.map((n) => {
        const s = statusOf(n);
        const meta = [s.who, s.when].filter(Boolean).map(escapeHtml).join(" · ");
        return `<li class="flow-step ${s.cls}">
          <span class="flow-step-idx">${n.sort_order}</span>
          <div class="flow-step-body">
            <div class="flow-step-name">${escapeHtml(n.node_name)}${n.node_type ? ` <small class="muted">[${escapeHtml(n.node_type)}]</small>` : ""}</div>
            <div class="flow-step-meta">
              <span class="flow-step-badge ${s.cls}">${s.badge}</span>${meta ? ` <span class="muted">${meta}</span>` : ""}
            </div>
          </div>
        </li>`;
      }).join("");
      return `<div class="timeline-item flow-steps-wrap"><div class="flow-steps-title">审批流程</div><ol class="flow-steps">${lis}</ol></div>`;
    }

    // ---- DAG 缩略图 ----
    const NW = 132, NH = 50, PAD = 16;
    const xs = nodes.map((n) => Number(n.pos_x) || 0);
    const ys = nodes.map((n) => Number(n.pos_y) || 0);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    // 居中归一化
    const norm = nodes.map((n) => ({ n, x: (Number(n.pos_x) || 0) - minX + PAD, y: (Number(n.pos_y) || 0) - minY + PAD }));
    const width = Math.max(...norm.map((p) => p.x)) + NW + PAD;
    const height = Math.max(...norm.map((p) => p.y)) + NH + PAD;
    const byId = {}; norm.forEach((p) => { byId[p.n.id] = p; });

    const edgePaths = edges.map((e) => {
      const a = byId[e.from_node_id]; if (!a) return "";
      const b = e.to_node_id ? byId[e.to_node_id] : null;
      const p1 = { x: a.x + NW, y: a.y + NH / 2 };
      const p2 = b ? { x: b.x, y: b.y + NH / 2 } : { x: p1.x + 60, y: p1.y };
      const dx = Math.max(30, Math.abs(p2.x - p1.x) / 2);
      const d = `M ${p1.x},${p1.y} C ${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`;
      return `<path d="${d}" class="dag-edge${!b ? " terminal" : ""}" marker-end="url(#dagArrow)"></path>`;
    }).join("");

    const nodeBlocks = norm.map((p) => {
      const s = statusOf(p.n);
      const typeTag = p.n.node_type ? `<div class="dag-node-type">[${escapeHtml(p.n.node_type)}]</div>` : "";
      const who = [s.who, s.when].filter(Boolean).map(escapeHtml).join(" · ");
      const isEnd = p.n.node_kind === "end" || /归档|办结|结束/.test(p.n.node_name);
      return `<div class="dag-node ${s.cls}${isEnd ? " end" : ""}" style="left:${p.x}px;top:${p.y}px;width:${NW}px;min-height:${NH}px">
        <div class="dag-node-no">${p.n.sort_order || ""}</div>
        <div class="dag-node-name">${escapeHtml(p.n.node_name)}</div>
        ${typeTag}
        <div class="dag-node-meta"><span class="dag-badge ${s.cls}">${s.badge}</span>${who ? `<small>${who}</small>` : ""}</div>
      </div>`;
    }).join("");

    return `<div class="timeline-item flow-steps-wrap">
      <div class="flow-steps-title">审批流程（DAG）</div>
      <div class="dag-viewer-wrap"><div class="dag-viewer" style="width:${width}px;height:${height}px">
        <svg class="dag-svg" width="${width}" height="${height}">
          <defs><marker id="dagArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#9aa9bd"/></marker></defs>
          ${edgePaths}
        </svg>
        ${nodeBlocks}
      </div></div>
    </div>`;
  }

  async function openRequestDetail(id) {
    const [item, attachments] = await Promise.all([api(`/api/requests/${id}`), api(`/api/attachments/request/${id}`)]);
    // 「我是当前节点审批人」放宽到「我在 pending_approvers 里」，覆盖并行场景
    const myPending = String(item.pending_approvers || "").split(",").map((s) => s.trim()).filter(Boolean).includes(String(session.id));
    const canAct = canApprove() && item.status === "pending" && (item.current_approver_id === session.id || myPending);
    const actionsHtml = canAct ? `<div class="row-actions" style="margin:12px 0">
        <button class="primary" data-act="approve">同意</button>
        ${item.can_terminate ? `<button class="primary" data-act="terminate" title="当前节点可直接办结整个流程">直接办结</button>` : ""}
        <button class="secondary" data-act="reject">驳回</button>
        <button class="secondary" data-act="add-sign">加签</button>
        <button class="secondary" data-act="transfer">转办</button>
      </div>` : "";

    if (item.type === "vehicle") {
      openModal("用车申请表", renderVehicleDetail(item) + actionsHtml + attachmentBlock("request", id, attachments));
    } else if (item.type === "trip") {
      openModal("出差申请表", renderTripDetail(item) + actionsHtml + attachmentBlock("request", id, attachments));
    } else {
      const fieldRows = (requestFields[item.type] || []).map((f) => item.fields && item.fields[f.key]
        ? `<div class="timeline-item">${f.label}：${escapeHtml(item.fields[f.key])}</div>` : "").join("");
      openModal(`${typeText(item.type)}详情`, `
        <div class="timeline">
          <div class="timeline-item"><strong>${escapeHtml(item.category)}</strong><div class="muted">${escapeHtml(item.applicant_name)} · ${escapeHtml(item.dept_name)}</div></div>
          <div class="timeline-item">申请时间：${escapeHtml(fmtTime(item.apply_time))}</div>
          <div class="timeline-item">时间：${escapeHtml(String(item.start_date || "").replace("T", " "))} 至 ${escapeHtml(String(item.end_date || "").replace("T", " "))}</div>
          ${fieldRows}
          <div class="timeline-item">事由：${escapeHtml(item.reason)}</div>
          <div class="timeline-item">当前状态：<span class="status ${escapeHtml(item.status)}">${statusText(item.status)}</span></div>
          ${renderFlowSteps(item)}
          ${(item.approvals || []).map((a) => `<div class="timeline-item">${escapeHtml(fmtTime(a.approved_at))} · ${escapeHtml(a.approver_name)} · ${escapeHtml(a.action)}：${escapeHtml(a.comment)}</div>`).join("") || `<div class="timeline-item muted">暂无审批意见</div>`}
        </div>
        ${actionsHtml}
        ${attachmentBlock("request", id, attachments)}`);
    }
    if (canAct) {
      document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => openApprovalAction(id, b.dataset.act)));
    }
    // 出差详情里"任务/公文"链接：点击跳转公文详情
    document.querySelectorAll("[data-doc-link]").forEach((a) => a.addEventListener("click", () => {
      const docId = Number(a.dataset.docLink);
      if (docId) { closeModal(); openDocDetail(docId); }
    }));
    bindAttachmentForm("request", id);
  }

  // 用车申请详情：按"用车申请表"模板渲染，含行车记录、科室负责人意见、办公室意见
  function renderVehicleDetail(item) {
    const f = item.fields || {};
    const cell = (v) => escapeHtml(v == null || v === "" ? "—" : String(v));
    const fmtRange = () => {
      const s = f.startDateTime ? fmtTime(f.startDateTime) : (item.start_date || "");
      const e = f.endDateTime ? fmtTime(f.endDateTime) : (item.end_date || "");
      const h = f.durationHours ? `（${escapeHtml(String(f.durationHours))} 小时）` : "";
      return `${escapeHtml(s)} 至 ${escapeHtml(e)} ${h}`;
    };
    const driveRecord = item.vehicle_record || null;
    const dr = driveRecord || {};
    const tripKm = dr.end_mileage != null && dr.start_mileage != null
      ? Math.max(0, Number(dr.end_mileage || 0) - Number(dr.start_mileage || 0)) : "—";
    // 审批意见按"科室负责人/办公室"两块归类（按节点名匹配）；其他审批顺序展示
    const approvals = item.approvals || [];
    const findByNode = (kw) => approvals.find((a) => (a.node_name || "").includes(kw));
    const deptOpinion = findByNode("科室") || findByNode("部门");
    const officeOpinion = findByNode("办公室");
    const otherApprovals = approvals.filter((a) => a !== deptOpinion && a !== officeOpinion);
    const opinionBlock = (label, ap) => `
      <tr><th>${label}</th>
        <td colspan="3">${ap
          ? `<div>${escapeHtml(ap.comment || ap.action || "")}</div><div class="muted">${escapeHtml(ap.approver_name || "")} · ${escapeHtml(fmtTime(ap.approved_at))}</div>`
          : `<span class="muted">待审批</span>`}</td>
      </tr>`;
    return `
      <table class="vehicle-form">
        <tbody>
          <tr><th>申请科（室）</th><td>${cell(item.dept_name)}</td><th>申请时间</th><td>${cell(fmtTime(item.apply_time))}</td></tr>
          <tr><th>用车类别</th><td>${cell(item.category)}</td><th>申请人</th><td>${cell(item.applicant_name)}</td></tr>
          <tr><th>用车事由</th><td colspan="3">${cell(item.reason)}</td></tr>
          <tr><th>用车去向</th><td colspan="3">${cell(f.destinationDetail)}</td></tr>
          <tr><th>乘车人员</th><td>${cell(f.passengers)}</td><th>乘车人数</th><td>${cell(f.passengerCount)}</td></tr>
          <tr><th>用车时段</th><td colspan="3">${fmtRange()}</td></tr>
          <tr><th>候车地点</th><td colspan="3">${cell(f.waitLocation)}</td></tr>
          <tr><th>无中心车时，科室建议</th><td>${cell(f.deptSuggestion)}</td><th>其他要求</th><td>${cell(f.otherRequirement)}</td></tr>
          <tr><th>本单位联系人</th><td>${cell(f.internalContact)} ${f.internalPhone ? `<span class="muted">${escapeHtml(f.internalPhone)}</span>` : ""}</td>
              <th>外单位联系人</th><td>${cell(f.externalContact)} ${f.externalPhone ? `<span class="muted">${escapeHtml(f.externalPhone)}</span>` : ""}</td></tr>
          <tr><th>驾驶员</th><td>${cell(dr.driver || f.preassignDriver)}</td><th>车号</th><td>${cell(dr.plate_no || f.preassignVehicleId)}</td></tr>
          <tr><th rowspan="2">行车记录</th>
              <td colspan="3">
                <div>实际用车时间：${cell(fmtTime(dr.actual_start_time))}　归队时间：${cell(fmtTime(dr.return_time))}</div>
                <div>发车读表：${cell(dr.start_mileage)} 公里，收车读表：${cell(dr.end_mileage)} 公里，本次行程：${escapeHtml(String(tripKm))} 公里</div>
              </td></tr>
          <tr><td colspan="3">加油 ${cell(dr.fuel_count)} 次（${cell(dr.fuel_liters)} L），维修 ${cell(dr.maintain_count)} 次</td></tr>
          <tr><th>备注</th><td colspan="3">${cell(f.remark)}</td></tr>
          ${opinionBlock("科室负责人意见", deptOpinion)}
          ${opinionBlock("办公室意见", officeOpinion)}
        </tbody>
      </table>
      <div class="muted" style="margin-top:8px">当前状态：<span class="status ${escapeHtml(item.status)}">${statusText(item.status)}</span>　节点：${escapeHtml(item.current_node || "")}</div>
      ${renderFlowSteps(item)}
      ${otherApprovals.length ? `<div class="muted" style="margin-top:8px">其他审批轨迹：${otherApprovals.map((a) => `<div>${escapeHtml(fmtTime(a.approved_at))} · ${escapeHtml(a.approver_name)} · ${escapeHtml(a.action)}：${escapeHtml(a.comment)}</div>`).join("")}</div>` : ""}
    `;
  }

  // 出差申请详情：按"出差申请表"模板渲染，含三段审批意见（科室/办公室/单位领导）
  function renderTripDetail(item) {
    const f = item.fields || {};
    const cell = (v) => escapeHtml(v == null || v === "" ? "—" : String(v));
    const days = f.days ? `（共 ${escapeHtml(String(f.days))} 天）` : "";
    const docLink = f.taskDocId
      ? `<a href="javascript:void(0)" data-doc-link="${escapeHtml(String(f.taskDocId))}">${cell(f.taskDocTitle || `公文 #${f.taskDocId}`)}</a>`
      : `<span class="muted">—</span>`;

    const approvals = item.approvals || [];
    const findByNode = (...kws) => approvals.find((a) => kws.some((k) => (a.node_name || "").includes(k)) && (a.action === "同意" || a.action === "驳回"));
    const deptOpinion = findByNode("科室", "科长", "部门");
    const officeOpinion = findByNode("办公室", "副主任");
    const leaderOpinion = findByNode("单位领导", "主任", "中心领导");
    const otherApprovals = approvals.filter((a) => a !== deptOpinion && a !== officeOpinion && a !== leaderOpinion);
    const opinionBlock = (label, ap) => `
      <tr><th>${label}</th>
        <td colspan="3">${ap
          ? `<div>${escapeHtml(ap.comment || ap.action || "")}</div><div class="muted">${escapeHtml(ap.approver_name || "")} · ${escapeHtml(fmtTime(ap.approved_at))}</div>`
          : `<span class="muted">待审批</span>`}</td>
      </tr>`;

    return `
      <table class="vehicle-form">
        <tbody>
          <tr><th>填报部门</th><td>${cell(item.dept_name)}</td><th>填表时间</th><td>${cell(fmtTime(item.apply_time))}</td></tr>
          <tr><th>出差人员名单</th><td colspan="3">${cell(f.personnel)}</td></tr>
          <tr><th>带队者</th><td>${cell(f.leader)}</td><th>申请人</th><td>${cell(item.applicant_name)}</td></tr>
          <tr><th>出差时间安排</th><td colspan="3">${cell(item.start_date)} 至 ${cell(item.end_date)} ${days}</td></tr>
          ${f.workItems ? `<tr><th>工作事项</th><td colspan="3" style="white-space:pre-wrap">${cell(f.workItems)}</td></tr>` : ""}
          <tr><th>出差类别</th><td>${cell(item.category)}</td><th>出差类型</th><td>${cell(f.tripTypes)}</td></tr>
          <tr><th>出差目的地</th><td colspan="3">${cell(f.destination)}</td></tr>
          <tr><th>任务/公文</th><td colspan="3">${docLink}</td></tr>
          <tr><th>出差事由</th><td colspan="3" style="white-space:pre-wrap">${cell(item.reason)}</td></tr>
          <tr><th>交通工具</th><td colspan="3">${cell(f.transportTools)}</td></tr>
          <tr><th>差旅费预算（元）</th><td>${cell(f.budgetAmount)}</td><th>差旅费开支渠道</th><td>${cell(f.budgetChannel)}</td></tr>
          <tr><th>每人学费（元）</th><td colspan="3">${cell(f.tuitionPerPerson)}</td></tr>
          <tr><th>备注</th><td colspan="3" style="white-space:pre-wrap">${cell(f.remark)}</td></tr>
          ${opinionBlock("科室意见", deptOpinion)}
          ${opinionBlock("办公室意见", officeOpinion)}
          ${opinionBlock("单位领导意见", leaderOpinion)}
        </tbody>
      </table>
      <div class="muted" style="margin-top:8px">当前状态：<span class="status ${escapeHtml(item.status)}">${statusText(item.status)}</span>　节点：${escapeHtml(item.current_node || "")}</div>
      ${renderFlowSteps(item)}
      ${otherApprovals.length ? `<div class="muted" style="margin-top:8px">其他审批轨迹：${otherApprovals.map((a) => `<div>${escapeHtml(fmtTime(a.approved_at))} · ${escapeHtml(a.approver_name)} · ${escapeHtml(a.action)}：${escapeHtml(a.comment)}</div>`).join("")}</div>` : ""}
    `;
  }

  function openApprovalAction(id, act) {
    const needTarget = act === "add-sign" || act === "transfer";
    // "terminate" 走 /approve 接口但带 terminate=1 标记；其余按 act 映射
    const titleMap = { approve: "同意", reject: "驳回", "add-sign": "加签", transfer: "转办", terminate: "直接办结" };
    const endpoint = act === "terminate" ? "approve" : act;
    const buildForm = (dirHtml) => {
      openModal(`审批 - ${titleMap[act]}`, `
        <form id="approvalForm" class="form-grid">
          ${needTarget ? `<label class="full">${act === "transfer" ? "转办给" : "加签给"}<select name="targetUserId" required>${dirHtml}</select></label>` : ""}
          ${act === "terminate" ? `<div class="muted full" style="margin-bottom:6px;line-height:1.7">提交后本流程将<b>立即归档</b>，其他并行节点也会一并结束。请确认确实可以提前办结。</div>` : ""}
          <label class="full">审批意见<textarea name="comment" ${act === "reject" ? "required" : ""}>${act === "approve" ? "同意" : act === "terminate" ? "经研判可直接办结" : ""}</textarea></label>
          <label>审批时间<input type="datetime-local" name="approvedAt" value="${nowLocal()}" /></label>
          <div class="full row-actions"><button class="primary" type="submit">提交</button><button class="secondary modal-cancel" type="button">取消</button></div>
        </form>`);
      $("approvalForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body = { comment: f.get("comment"), approvedAt: toISO(f.get("approvedAt")) };
        if (needTarget) body.targetUserId = Number(f.get("targetUserId"));
        if (act === "terminate") body.terminate = 1;
        try {
          await api(`/api/requests/${id}/${endpoint}`, { method: "POST", body: JSON.stringify(body) });
          closeAllModals(); await renderView(); refreshNotify();
          toast(`✓ 已${titleMap[act]}`);
        } catch (err) { alert(err.message); }
      });
    };
    if (needTarget) {
      getDirectory().then((dir) => buildForm(dir.filter((u) => u.id !== session.id).map((u) => `<option value="${u.id}">${escapeHtml(u.name)}（${escapeHtml(u.dept)}）</option>`).join("")));
    } else buildForm("");
  }

  async function withdrawRequest(id) {
    if (!confirm("确认撤回该申请？")) return;
    try { await api(`/api/requests/${id}/withdraw`, { method: "POST", body: JSON.stringify({ comment: "申请人撤回" }) }); await renderView(); }
    catch (err) { alert(err.message); }
  }

  /* ---------------- 自定义业务类型实例（统一引擎前端） ---------------- */

  async function renderInstanceBusiness(code) {
    const bt = bizTypes[code] || { name: code };
    viewRoot.innerHTML = `
      <div class="toolbar"><div class="toolbar-left">
        <button class="primary" data-create-inst="${escapeHtml(code)}">新增${escapeHtml(bt.name)}申请</button>
      </div></div>
      <div class="filter-bar">
        <input data-f="keyword" placeholder="关键字（标题）" />
        <select data-f="status"><option value="">全部状态</option><option value="pending">待审批</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="withdrawn">已撤回</option></select>
        <button class="secondary" data-do-filter>查询</button><button class="link" data-reset-filter>重置</button>
      </div>
      <section class="panel"><div class="panel-header"><h2>${canApprove() ? escapeHtml(bt.name) + "列表" : "我的" + escapeHtml(bt.name) + "申请"}</h2><span class="muted">${canApprove() ? "可审批所辖单据" : "仅显示本人申请与进度"}</span></div>
        <div class="panel-body" id="instTable"></div></section>`;
    viewRoot.querySelector("[data-create-inst]").addEventListener("click", () => openInstanceForm(code));
    const load = async (page = 1) => {
      const p = readFilters(); p.set("businessType", code); p.set("page", page); p.set("pageSize", 20);
      const data = await api(`/api/instances?${p.toString()}`);
      $("instTable").innerHTML = renderInstanceTable(data.items) + pager(data.total, data.page, data.pageSize);
      bindInstanceRowActions($("instTable"));
      bindPagerEl($("instTable"), load);
    };
    bindFilter(() => load(1));
    await load(1);
  }

  function renderInstanceTable(rows) {
    if (!rows.length) return `<div class="empty">暂无记录</div>`;
    const showWho = canApprove();
    return `<table>
      <thead><tr><th>标题</th>${showWho ? "<th>申请人</th><th>科室</th>" : ""}<th>提交时间</th><th>状态/节点</th><th>操作</th></tr></thead>
      <tbody>${rows.map((item) => `<tr>
        <td>${escapeHtml(item.title)}</td>
        ${showWho ? `<td>${escapeHtml(item.applicant_name)}</td><td>${escapeHtml(item.dept_name)}</td>` : ""}
        <td>${escapeHtml(fmtTime(item.created_at))}</td>
        <td><span class="status ${escapeHtml(item.status)}">${statusText(item.status)}</span><br><span class="muted">${escapeHtml(item.current_node || "")}</span></td>
        <td class="row-actions">
          <button class="secondary" data-inst-detail="${item.id}">查看</button>
          ${canApprove() && item.status === "pending" && item.current_approver_id === session.id ? `<button class="secondary" data-inst-detail="${item.id}">审批</button>` : ""}
          ${item.status === "pending" && item.applicant_id === session.id ? `<button class="secondary" data-inst-withdraw="${item.id}">撤回</button>` : ""}
        </td></tr>`).join("")}</tbody></table>`;
  }

  function bindInstanceRowActions(root) {
    root.querySelectorAll("[data-inst-detail]").forEach((b) => b.addEventListener("click", () => openInstanceDetail(b.dataset.instDetail)));
    root.querySelectorAll("[data-inst-withdraw]").forEach((b) => b.addEventListener("click", () => withdrawInstance(b.dataset.instWithdraw)));
  }

  async function openInstanceForm(code) {
    const bt = bizTypes[code] || { name: code };
    let schema = [];
    try { const r = await api(`/api/business-types/${code}/form`); schema = r.form.schema || []; }
    catch (e) { alert("该业务类型暂无启用表单"); return; }
    const fieldsHtml = schema.map((f) => renderSchemaField(f)).join("");
    openModal(`${bt.name}申请`, `
      <form id="instForm" class="form-grid">
        <label>申请人<input value="${escapeHtml(session.name)}" disabled /></label>
        <label>所在科室<input value="${escapeHtml(session.dept)}" disabled /></label>
        ${fieldsHtml}
        <div class="full row-actions"><button class="primary" type="submit">提交审批</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("instForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget); const data = {};
      schema.forEach((fd) => { data[fd.key] = f.get(`fld_${fd.key}`) || ""; });
      try { await api("/api/instances", { method: "POST", body: JSON.stringify({ businessType: code, data }) }); closeModal(); await renderView(); refreshNotify(); }
      catch (err) { alert(err.message); }
    });
  }

  async function openInstanceDetail(id) {
    const item = await api(`/api/instances/${id}`);
    const rows = (item.schema || []).map((f) => (item.data && item.data[f.key] != null && item.data[f.key] !== "")
      ? `<div class="timeline-item">${escapeHtml(f.label)}：${escapeHtml(String(item.data[f.key]))}</div>` : "").join("");
    const canAct = canApprove() && item.status === "pending" && item.current_approver_id === session.id;
    openModal(`${escapeHtml(item.type_name || item.business_type_code)}详情`, `
      <div class="timeline">
        <div class="timeline-item"><strong>${escapeHtml(item.title)}</strong><div class="muted">${escapeHtml(item.applicant_name)} · ${escapeHtml(item.dept_name)}</div></div>
        <div class="timeline-item">提交时间：${escapeHtml(fmtTime(item.created_at))}</div>
        ${rows}
        <div class="timeline-item">当前状态：<span class="status ${escapeHtml(item.status)}">${statusText(item.status)}</span>，节点：${escapeHtml(item.current_node)}</div>
        ${(item.approvals || []).map((a) => `<div class="timeline-item">${escapeHtml(fmtTime(a.approved_at))} · ${escapeHtml(a.approver_name)} · ${escapeHtml(a.action)}：${escapeHtml(a.comment)}</div>`).join("") || `<div class="timeline-item muted">暂无审批意见</div>`}
      </div>
      ${canAct ? `<div class="row-actions" style="margin:12px 0">
        <button class="primary" data-iact="approve">同意</button>
        <button class="secondary" data-iact="reject">驳回</button>
        <button class="secondary" data-iact="add-sign">加签</button>
        <button class="secondary" data-iact="transfer">转办</button>
      </div>` : ""}`);
    if (canAct) document.querySelectorAll("[data-iact]").forEach((b) => b.addEventListener("click", () => openInstanceApprovalAction(id, b.dataset.iact)));
  }

  function openInstanceApprovalAction(id, act) {
    const needTarget = act === "add-sign" || act === "transfer";
    const titleMap = { approve: "同意", reject: "驳回", "add-sign": "加签", transfer: "转办" };
    const build = (dirHtml) => {
      openModal(`审批 - ${titleMap[act]}`, `
        <form id="iApprovalForm" class="form-grid">
          ${needTarget ? `<label class="full">${act === "transfer" ? "转办给" : "加签给"}<select name="targetUserId" required>${dirHtml}</select></label>` : ""}
          <label class="full">审批意见<textarea name="comment" ${act === "reject" ? "required" : ""}>${act === "approve" ? "同意" : ""}</textarea></label>
          <label>审批时间<input type="datetime-local" name="approvedAt" value="${nowLocal()}" /></label>
          <div class="full row-actions"><button class="primary" type="submit">提交</button><button class="secondary modal-cancel" type="button">取消</button></div>
        </form>`);
      $("iApprovalForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body = { comment: f.get("comment"), approvedAt: toISO(f.get("approvedAt")) };
        if (needTarget) body.targetUserId = Number(f.get("targetUserId"));
        try {
          await api(`/api/instances/${id}/${act}`, { method: "POST", body: JSON.stringify(body) });
          closeAllModals(); await renderView(); refreshNotify();
          toast(`✓ 已${titleMap[act]}`);
        } catch (err) { alert(err.message); }
      });
    };
    if (needTarget) getDirectory().then((dir) => build(dir.filter((u) => u.id !== session.id).map((u) => `<option value="${u.id}">${escapeHtml(u.name)}（${escapeHtml(u.dept)}）</option>`).join("")));
    else build("");
  }

  async function withdrawInstance(id) {
    if (!confirm("确认撤回该申请？")) return;
    try { await api(`/api/instances/${id}/withdraw`, { method: "POST", body: JSON.stringify({ comment: "申请人撤回" }) }); await renderView(); }
    catch (err) { alert(err.message); }
  }

  /* ---------------- 用车 ---------------- */

  async function renderVehicle() {
    const [reqResp, vehicles, records] = await Promise.all([api("/api/requests?type=vehicle&pageSize=200"), api("/api/vehicles"), api("/api/vehicle-records")]);
    const rows = reqResp.items;
    const isAdmin = session && session.roleCode === "admin";
    viewRoot.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <button class="primary" data-create="vehicle">新增用车申请</button>
          ${canApprove() ? `<button class="secondary" data-admin="vehicle-record">登记行车记录</button>` : ""}
          ${isAdmin ? `<button class="secondary" data-admin="vehicle-new">+ 新增车辆</button>` : ""}
          <button class="secondary" data-export="/api/export/requests.xlsx?type=vehicle">导出 Excel</button>
        </div>
      </div>
      <section class="panel" style="margin-bottom:16px">
        <div class="panel-header"><h2>车辆台账</h2><span class="muted">${isAdmin ? "管理员可新增 / 编辑 / 删除车辆" : "由管理员维护车辆信息"}</span></div>
        <div class="panel-body">${renderVehicleTable(vehicles, isAdmin)}</div>
      </section>
      <div class="grid cols-2">
        <section class="panel"><div class="panel-header"><h2>${canApprove() ? "用车申请" : "我的用车申请"}</h2></div><div class="panel-body">${renderRequestTable(rows)}</div></section>
        <section class="panel"><div class="panel-header"><h2>行车记录</h2></div><div class="panel-body"><table>
          <thead><tr><th>车辆</th><th>里程</th><th>用油</th><th>归队时间</th><th>登记人</th><th>操作</th></tr></thead>
          <tbody>${records.length ? records.map((r) => `<tr><td>${escapeHtml(r.plate_no || "")}</td><td>${r.start_mileage || 0} - ${r.end_mileage || 0}</td><td>${r.fuel_liters || 0} L</td><td>${escapeHtml(fmtTime(r.return_time))}</td><td>${escapeHtml(r.created_by_name || "")}</td><td>${isAdmin ? `<button class="link danger" data-delete-record="${r.id}">删除</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="6"><div class="empty">暂无行车记录</div></td></tr>`}</tbody>
        </table></div></section>
      </div>`;
    bindActions();
    const b = viewRoot.querySelector("[data-admin='vehicle-record']");
    if (b) b.addEventListener("click", () => openVehicleRecordForm(rows, vehicles));
    const addCar = viewRoot.querySelector("[data-admin='vehicle-new']");
    if (addCar) addCar.addEventListener("click", () => openVehicleForm());
    viewRoot.querySelectorAll("[data-edit-vehicle]").forEach((btn) => btn.addEventListener("click", () => openVehicleForm(vehicles.find((v) => String(v.id) === btn.dataset.editVehicle))));
    viewRoot.querySelectorAll("[data-del-vehicle]").forEach((btn) => btn.addEventListener("click", () => deleteVehicle(btn.dataset.delVehicle)));
    viewRoot.querySelectorAll("[data-delete-record]").forEach((btn) => btn.addEventListener("click", () => deleteVehicleRecord(btn.dataset.deleteRecord)));
  }

  function renderVehicleTable(vehicles, isAdmin) {
    if (!vehicles.length) return `<div class="empty">暂无车辆，${isAdmin ? "点击右上角「+ 新增车辆」录入" : "请联系管理员录入"}</div>`;
    return `<table>
      <thead><tr><th>车牌</th><th>驾驶员</th><th>状态</th><th>当前里程</th>${isAdmin ? "<th>操作</th>" : ""}</tr></thead>
      <tbody>${vehicles.map((v) => `<tr>
        <td>${escapeHtml(v.plate_no)}</td>
        <td>${escapeHtml(v.driver)}</td>
        <td><span class="pill ${v.status === "空闲" ? "on" : ""}">${escapeHtml(v.status || "空闲")}</span></td>
        <td>${Number(v.mileage || 0).toLocaleString()} km</td>
        ${isAdmin ? `<td class="row-actions"><button class="link" data-edit-vehicle="${v.id}">编辑</button><button class="link danger" data-del-vehicle="${v.id}">删除</button></td>` : ""}
      </tr>`).join("")}</tbody></table>`;
  }

  function openVehicleForm(vehicle) {
    const statusOptions = ["空闲", "已预约", "出车中", "维修", "停用"];
    openModal(vehicle ? "编辑车辆" : "新增车辆", `
      <form id="vehicleForm" class="form-grid">
        <label>车牌号<input name="plateNo" required value="${vehicle ? escapeHtml(vehicle.plate_no) : ""}" placeholder="如 桂R-CDC03" /></label>
        <label>驾驶员<input name="driver" required value="${vehicle ? escapeHtml(vehicle.driver) : ""}" placeholder="如 覃师傅" /></label>
        <label>状态<select name="status">${statusOptions.map((s) => `<option value="${s}" ${vehicle && vehicle.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label>当前里程 (km)<input name="mileage" type="number" min="0" value="${vehicle ? Number(vehicle.mileage || 0) : 0}" /></label>
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("vehicleForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const body = { plateNo: f.get("plateNo"), driver: f.get("driver"), status: f.get("status"), mileage: Number(f.get("mileage") || 0) };
      try {
        if (vehicle) await api(`/api/vehicles/${vehicle.id}`, { method: "PUT", body: JSON.stringify(body) });
        else await api("/api/vehicles", { method: "POST", body: JSON.stringify(body) });
        closeModal(); await renderVehicle();
      } catch (err) { alert(err.message); }
    });
  }

  async function deleteVehicle(id) {
    if (!confirm("确认删除该车辆？已有行车记录引用的车辆无法删除（可改成「停用」）。")) return;
    try { await api(`/api/vehicles/${id}`, { method: "DELETE" }); await renderVehicle(); }
    catch (err) { alert(err.message); }
  }

  function openVehicleRecordForm(requests, vehicles) {
    const approved = requests.filter((i) => i.status === "approved");
    openModal("登记行车记录", `
      <form id="vehicleRecordForm" class="form-grid">
        <label class="full">关联用车申请<select name="requestId"><option value="">无</option>${approved.map((i) => `<option value="${i.id}">${escapeHtml(i.reason)}</option>`).join("")}</select></label>
        <label>车辆<select name="vehicleId">${vehicles.map((c) => `<option value="${c.id}">${escapeHtml(c.plate_no)} · ${escapeHtml(c.driver)}</option>`).join("")}</select></label>
        <label>实际用车时间<input name="actualStartTime" type="datetime-local" value="${nowLocal()}" /></label>
        <label>归队时间<input name="returnTime" type="datetime-local" value="${nowLocal()}" /></label>
        <label>发车读表（公里）<input id="vrStartM" name="startMileage" type="number" min="0" value="0" /></label>
        <label>收车读表（公里）<input id="vrEndM" name="endMileage" type="number" min="0" value="0" /></label>
        <label>本次行程（公里）<input id="vrTrip" type="number" value="0" readonly /></label>
        <label>用油升数（L）<input name="fuelLiters" type="number" step="0.1" min="0" value="0" /></label>
        <label>加油次数<input name="fuelCount" type="number" min="0" value="0" /></label>
        <label>维修次数<input name="maintainCount" type="number" min="0" value="0" /></label>
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    const sM = document.getElementById("vrStartM");
    const eM = document.getElementById("vrEndM");
    const tM = document.getElementById("vrTrip");
    const recompute = () => { tM.value = Math.max(0, Number(eM.value || 0) - Number(sM.value || 0)); };
    sM.addEventListener("input", recompute);
    eM.addEventListener("input", recompute);
    $("vehicleRecordForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await api("/api/vehicle-records", { method: "POST", body: JSON.stringify({
          requestId: f.get("requestId") || null, vehicleId: Number(f.get("vehicleId")),
          startMileage: Number(f.get("startMileage")), endMileage: Number(f.get("endMileage")),
          fuelLiters: Number(f.get("fuelLiters")), returnTime: toISO(f.get("returnTime")),
          actualStartTime: toISO(f.get("actualStartTime")),
          fuelCount: Number(f.get("fuelCount") || 0),
          maintainCount: Number(f.get("maintainCount") || 0),
        }) });
        closeModal(); await renderVehicle();
      } catch (err) { alert(err.message); }
    });
  }

  async function deleteVehicleRecord(id) {
    if (!confirm("确认删除该行车记录？")) return;
    try { await api(`/api/vehicle-records/${id}`, { method: "DELETE" }); await renderVehicle(); }
    catch (err) { alert(err.message); }
  }

  /* ---------------- 公文 ---------------- */

  async function renderDocuments() {
    viewRoot.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          ${canApprove() ? `<button class="primary" data-create-doc="收文">收文登记</button>` : ""}
          <button class="primary" data-create-doc="发文">发文拟稿</button>
          <button class="secondary" data-export="/api/export/documents.xlsx">导出 Excel</button>
        </div>
      </div>
      <div class="filter-bar">
        <input data-f="keyword" placeholder="关键字（标题/文号/来文单位）" />
        <select data-f="type"><option value="">全部</option><option value="收文">收文</option><option value="发文">发文</option></select>
        <select data-f="status"><option value="">全部状态</option><option value="pending">办理中</option><option value="approved">已办结</option><option value="archived">已归档</option><option value="rejected">已退回</option><option value="withdrawn">已撤回</option></select>
        <input data-f="from" type="date" /><input data-f="to" type="date" />
        <button class="secondary" data-do-filter>查询</button><button class="link" data-reset-filter>重置</button>
      </div>
      <section class="panel"><div class="panel-header"><h2>公文台账</h2><span class="muted">服务端按权限控制范围</span></div>
        <div class="panel-body" id="docTable"></div></section>`;
    bindActions();
    const load = async (page = 1) => {
      const p = readFilters(); p.set("page", page); p.set("pageSize", 20);
      const data = await api(`/api/documents?${p.toString()}`);
      $("docTable").innerHTML = renderDocTable(data.items) + pager(data.total, data.page, data.pageSize);
      bindRowActions($("docTable"));
      bindPagerEl($("docTable"), load);
    };
    bindFilter(() => load(1));
    await load(1);
  }

  function renderDocTable(rows) {
    if (!rows.length) return `<div class="empty">暂无公文</div>`;
    return `<table>
      <thead><tr><th>类型</th><th>文号</th><th>标题</th><th>来文单位 / 承办科室</th><th>密级</th><th>紧急程度</th><th>状态</th><th class="col-actions">操作</th></tr></thead>
      <tbody>${rows.map((doc) => `<tr>
        <td>${escapeHtml(doc.type)}</td>
        <td>${escapeHtml(doc.no)}</td>
        <td>${escapeHtml(doc.title)}</td>
        <td>${escapeHtml(doc.source_unit || doc.owner_dept)}</td>
        <td>${escapeHtml(doc.secret)}</td>
        <td>${escapeHtml(doc.urgency)}</td>
        <td><span class="status ${escapeHtml(doc.status)}">${statusText(doc.status)}</span><br><span class="muted">${escapeHtml(doc.current_node)}</span></td>
        <td class="row-actions">
          <button class="secondary" data-doc-detail="${doc.id}" title="打开公文，做阅读、签字、反馈等留痕动作">阅文</button>
          ${canApprove() && doc.status === "pending" ? `<button class="primary" data-doc-approve="${doc.id}" title="写审批意见并把流程推到下一节点">审批</button>` : ""}
          ${(() => {
            if (!canApprove()) return "";
            // 发文：仅在「分发」节点出现，且分发后会自动推进到下一节点（归档）
            if (doc.type === "发文") return doc.status === "pending" && doc.current_node === "分发"
              ? `<button class="secondary" data-doc-distribute="${doc.id}" title="选择阅读人，提交后自动推进到「归档」节点">分发</button>`
              : "";
            // 收文：随时可分发阅读对象
            return `<button class="secondary" data-doc-distribute="${doc.id}" title="把公文派发给指定的人去阅读">分发</button>`;
          })()}
        </td></tr>`).join("")}</tbody></table>`;
  }

  function openDocumentForm(type) {
    const recv = type === "收文";
    const today = new Date().toISOString().slice(0, 10);
    openModal(recv ? "收文登记（阅文卡）" : "发文拟稿", `
      <form id="docForm" class="form-grid">
        ${recv
          ? `<label class="full">来文单位<input name="sourceUnit" required placeholder="如 广西壮族自治区继续医学教育工作委员会" /></label>
             <label>原文件号<input name="originNo" placeholder="如 桂卫继字〔2026〕1号" /></label>
             <label>收文号<input name="no" value="A2026-" required placeholder="如 A2026-624" /></label>
             <label>发文日期<input type="date" name="issueDate" /></label>
             <label>收文日期<input type="date" name="docDate" value="${today}" /></label>
             <label>份数<input name="copies" type="number" min="0" value="1" /></label>`
          : `<label>文号<input name="no" value="贵疾控发〔2026〕" required pattern=".*〕.*[0-9].*" title="请填写完整文号，如 贵疾控发〔2026〕15号" placeholder="贵疾控发〔2026〕15号" /></label>
             <label>登记/成文日期<input type="date" name="docDate" value="${today}" /></label>`}
        <label class="full">${recv ? "来文标题" : "公文标题"}<input name="title" required /></label>
        ${recv ? "" : `<label class="full">主送机关<input name="mainSend" placeholder="如 各县（市、区）疾控中心" /></label><label class="full">抄送机关<input name="ccSend" placeholder="如 自治区疾控中心" /></label>`}
        <label>承办科室<input name="ownerDept" value="${escapeHtml(session.dept)}" required /></label>
        <label>密级<select name="secret"><option>普通</option><option>内部</option><option>秘密</option><option>机密</option></select></label>
        <label>紧急程度<select name="urgency"><option>一般</option><option>平件</option><option>急件</option><option>特急</option></select></label>
        <label class="full">${recv ? "摘要" : "正文摘要"}<textarea name="content" rows="3" placeholder="${recv ? "请简述来文要点" : "请填写发文正文摘要"}"></textarea></label>
        ${recv ? "" : `<label class="full">发文附件<input type="file" name="attachments" multiple /><span class="muted" style="font-size:12px">可一次选择多个文件，提交后自动挂到本发文</span></label>`}
        <div class="full row-actions"><button class="primary" type="submit">提交公文流程</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("docForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const files = recv ? [] : Array.from(e.currentTarget.attachments?.files || []);
      try {
        const created = await api("/api/documents", { method: "POST", body: JSON.stringify({
          type, no: f.get("no"), title: f.get("title"), secret: f.get("secret"), urgency: f.get("urgency"),
          ownerDept: f.get("ownerDept"), content: f.get("content"), docDate: f.get("docDate"),
          sourceUnit: f.get("sourceUnit") || "", mainSend: f.get("mainSend") || "", ccSend: f.get("ccSend") || "",
          originNo: f.get("originNo") || "", issueDate: f.get("issueDate") || "", copies: f.get("copies") || 0,
        }) });
        // 用印号在拟稿阶段不再要求；统一在「用印登记」节点录入。
        for (const file of files) {
          const fd = new FormData(); fd.append("file", file);
          try { await api(`/api/attachments/document/${created.id}`, { method: "POST", body: fd }); }
          catch (err) { toast(`附件「${file.name}」上传失败：${err.message}`, "err"); }
        }
        closeModal(); await setView("document"); refreshNotify();
      } catch (err) { alert(err.message); }
    });
  }

  // 阅文卡渲染：按官方"阅文卡"模板布局，仅用于收文
  // 节点意见聚合规则：
  //   拟办意见 ← node_name 含"拟办"
  //   分管领导阅示 ← 含"分管"
  //   中心主任阅示 ← 含"中心主任" / "主任"（且不含"分管"）
  //   其他领导阅示 ← 走加签路径（add-sign 产生的额外审批）
  //   承办科（室）落实情况 ← 含"承办" / "落实" 的审批 + receipts 中 action='反馈' 的留痕
  function renderReadingCard(doc) {
    const cell = (v) => escapeHtml(v == null || v === "" ? "—" : String(v));
    const approvals = doc.approvals || [];
    const receipts = doc.receipts || [];
    const decided = approvals.filter((a) => a.action === "同意" || a.action === "驳回" || a.action === "办结" || a.action === "登记");
    const findByNode = (matcher) => decided.find((a) => matcher(a.node_name || ""));

    const draftOpinion = findByNode((n) => n.includes("拟办"));
    const branchLeaderOpinion = findByNode((n) => n.includes("分管"));
    const centerHeadOpinion = findByNode((n) => /中心主任|主任/.test(n) && !n.includes("分管"));
    // 「其他领导阅示」按加签路径理解：所有 action 为「加签」的审批轨迹 + 加签节点上的最终意见
    const addSignTrail = approvals.filter((a) => (a.action || "").includes("加签"));
    const otherOpinions = approvals.filter((a) => {
      if (a === draftOpinion || a === branchLeaderOpinion || a === centerHeadOpinion) return false;
      if (a.action !== "同意" && a.action !== "驳回") return false;
      const n = a.node_name || "";
      if (n.includes("拟办") || n.includes("分管") || n.includes("中心主任") || n === "主任" || n.includes("承办") || n.includes("落实") || n.includes("归档")) return false;
      return true;
    });
    const implementOpinions = approvals.filter((a) => /承办|落实/.test(a.node_name || ""));
    const feedbackReceipts = receipts.filter((r) => r.action === "反馈" || r.action === "落实");

    const formatOpinion = (ap) => `<div>${escapeHtml(ap.comment || ap.action || "")}</div><div class="muted">${escapeHtml(ap.approver_name || "")} ${escapeHtml(ap.approved_at ? fmtTime(ap.approved_at).slice(0, 10) : "")}</div>`;
    const opinionRow = (label, ap) => `
      <tr><th>${label}</th>
        <td colspan="3">${ap ? formatOpinion(ap) : `<span class="muted">待办理</span>`}</td></tr>`;

    const otherBlock = (otherOpinions.length || addSignTrail.length)
      ? `<div>${otherOpinions.map(formatOpinion).join("")}</div>
         ${addSignTrail.length ? `<div class="muted" style="margin-top:6px;font-size:12px">加签轨迹：${addSignTrail.map((a) => `${escapeHtml(a.approver_name)}（${escapeHtml(a.node_name || "")}）`).join("、")}</div>` : ""}`
      : `<span class="muted">无加签意见</span>`;

    const implementBlock = (implementOpinions.length || feedbackReceipts.length)
      ? `${implementOpinions.map(formatOpinion).join("")}
         ${feedbackReceipts.map((r) => `<div>${escapeHtml(r.comment || "已落实")}<span class="muted" style="margin-left:8px">${escapeHtml(r.user_name)} ${escapeHtml(fmtTime(r.created_at).slice(0, 10))}</span></div>`).join("")}`
      : `<span class="muted">待落实</span>`;

    return `
      <table class="vehicle-form reading-card">
        <tbody>
          <tr>
            <th>来文单位</th><td>${cell(doc.source_unit)}</td>
            <th>原文件号</th><td>${cell(doc.origin_no)}</td>
          </tr>
          <tr>
            <th>收文号</th><td>${cell(doc.no)}</td>
            <th>密级</th><td>${cell(doc.secret)}</td>
          </tr>
          <tr>
            <th>发文日期</th><td>${cell(doc.issue_date)}</td>
            <th>收文日期</th><td>${cell(doc.doc_date)}</td>
          </tr>
          <tr>
            <th>紧急程度</th><td>${cell(doc.urgency)}</td>
            <th>份数</th><td>${cell(doc.copies)}</td>
          </tr>
          <tr><th>来文标题</th><td colspan="3">${cell(doc.title)}</td></tr>
          <tr><th>摘要</th><td colspan="3" style="white-space:pre-wrap;min-height:60px">${cell(doc.content)}</td></tr>
          ${opinionRow("拟办意见", draftOpinion)}
          ${opinionRow("分管领导阅示", branchLeaderOpinion)}
          ${opinionRow("中心主任阅示", centerHeadOpinion)}
          <tr><th>其他领导阅示</th><td colspan="3">${otherBlock}</td></tr>
          <tr><th>承办科（室）<br/>落实情况</th><td colspan="3">${implementBlock}</td></tr>
        </tbody>
      </table>
      <div class="muted" style="margin-top:8px">当前状态：<span class="status ${escapeHtml(doc.status)}">${statusText(doc.status)}</span>　节点：${escapeHtml(doc.current_node || "")}　承办：${escapeHtml(doc.owner_dept || "")}</div>
      ${renderFlowSteps(doc)}
      ${renderReceiptsBlock(receipts)}
    `;
  }

  // 阅文/办文留痕区：阅读 / 签字 / 打印 / 反馈 / 用印 全部按时间倒序列出
  function renderReceiptsBlock(receipts) {
    if (!receipts || !receipts.length) return `<div class="panel" style="margin-top:12px"><div class="panel-header"><h3 style="margin:0;font-size:14px">阅文留痕</h3></div><div class="panel-body"><div class="empty" style="padding:12px">暂无留痕，下方按钮可记录</div></div></div>`;
    const sorted = [...receipts].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const tagColor = { 阅读: "#1565c0", 签收: "#2e7d32", 打印: "#6a1b9a", 反馈: "#ef6c00", 落实: "#ef6c00", 用印: "#c62828" };
    return `<div class="panel" style="margin-top:12px">
      <div class="panel-header"><h3 style="margin:0;font-size:14px">阅文留痕（${sorted.length}）</h3></div>
      <div class="panel-body" style="padding:8px">
        ${sorted.map((r) => `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 4px;border-bottom:1px dashed #eee">
          <span style="color:#fff;background:${tagColor[r.action] || "#607d8b"};padding:1px 8px;border-radius:10px;font-size:12px;flex-shrink:0">${escapeHtml(r.action)}</span>
          <div style="flex:1;min-width:0">
            <div>${escapeHtml(r.comment || "—")}</div>
            <div class="muted" style="font-size:12px">${escapeHtml(r.user_name)} · ${escapeHtml(fmtTime(r.created_at))}</div>
            ${r.signature ? `<img class="sign-img" src="${r.signature}" alt="签名" style="margin-top:4px;max-height:60px" />` : ""}
          </div>
        </div>`).join("")}
      </div>
    </div>`;
  }

  async function approveDocument(id) {
    openModal("公文流转 / 办结", `
      <form id="docApproveForm" class="form-grid">
        <label class="full">办理意见<textarea name="comment">同意</textarea></label>
        <label>审批时间<input type="datetime-local" name="approvedAt" value="${nowLocal()}" /></label>
        <div class="full row-actions">
          <button class="primary" type="submit">同意</button>
          <button class="danger" type="button" id="docRejectBtn" title="退回给起草人">驳回</button>
          <button class="secondary modal-cancel" type="button">取消</button>
        </div>
      </form>`);
    const act = async (action) => {
      const f = new FormData($("docApproveForm"));
      const comment = (f.get("comment") || "").toString().trim();
      if (action === "reject" && (!comment || comment === "同意")) { alert("驳回请填写驳回理由"); return; }
      try {
        await api(`/api/documents/${id}/${action}`, { method: "POST", body: JSON.stringify({ comment, approvedAt: toISO(f.get("approvedAt")) }) });
        closeModal(); await renderView(); refreshNotify();
        toast(action === "reject" ? "✓ 已驳回，公文退回起草人" : "✓ 已同意，流程已推进到下一节点");
      } catch (err) { alert(err.message); }
    };
    $("docApproveForm").addEventListener("submit", (e) => { e.preventDefault(); act("approve"); });
    $("docRejectBtn").addEventListener("click", () => act("reject"));
  }

  async function openDistributeForm(id) {
    const dir = await getDirectory();
    openModal("公文分发", `
      <form id="distForm" class="form-grid">
        <div class="full">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span>分发对象（可多选，点击勾选）</span>
            <a href="#" id="distToggleAll" class="muted" style="font-size:12px">全选</a>
          </div>
          <div id="distList" style="max-height:240px;overflow:auto;border:1px solid #d9d9d9;border-radius:6px;padding:4px">
            ${dir.map((u) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer">
              <input type="checkbox" name="readerIds" value="${u.id}" style="width:16px;height:16px;flex:none" />
              <span>${escapeHtml(u.name)}<span class="muted">（${escapeHtml(u.dept)}）</span></span>
            </label>`).join("")}
          </div>
          <div class="muted" id="distCount" style="font-size:12px;margin-top:4px">已选 0 人</div>
        </div>
        <label class="full">分发说明<input name="comment" value="请相关科室阅办" /></label>
        <div class="full row-actions"><button class="primary" type="submit">分发</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    const distForm = $("distForm");
    const distBoxes = () => Array.from(distForm.querySelectorAll('input[name="readerIds"]'));
    const updateDistCount = () => {
      const n = distBoxes().filter((b) => b.checked).length;
      $("distCount").textContent = `已选 ${n} 人`;
      $("distToggleAll").textContent = n === distBoxes().length && n > 0 ? "清空" : "全选";
    };
    $("distList").addEventListener("change", updateDistCount);
    $("distToggleAll").addEventListener("click", (e) => {
      e.preventDefault();
      const allChecked = distBoxes().every((b) => b.checked);
      distBoxes().forEach((b) => { b.checked = !allChecked; });
      updateDistCount();
    });
    distForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const readerIds = distBoxes().filter((b) => b.checked).map((b) => Number(b.value));
      if (!readerIds.length) return alert("请选择分发对象");
      try {
        await api(`/api/documents/${id}/distribute`, { method: "POST", body: JSON.stringify({ readerIds, comment: e.currentTarget.comment.value }) });
        closeModal(); await renderView(); refreshNotify();
        toast(`✓ 已分发给 ${readerIds.length} 人，已推送待阅通知`);
      } catch (err) { alert(err.message); }
    });
  }

  async function openDocDetail(id) {
    const [doc, attachments] = await Promise.all([api(`/api/documents/${id}`), api(`/api/attachments/document/${id}`)]);
    const isRecv = doc.type === "收文";
    const headerHtml = isRecv ? renderReadingCard(doc) : `
      <div class="timeline">
        <div class="timeline-item"><strong>${escapeHtml(doc.title)}</strong><div class="muted">${escapeHtml(doc.no)} · ${escapeHtml(doc.type)} · ${escapeHtml(doc.doc_date || "")}</div></div>
        ${doc.main_send ? `<div class="timeline-item">主送：${escapeHtml(doc.main_send)}</div>` : ""}
        ${doc.cc_send ? `<div class="timeline-item">抄送：${escapeHtml(doc.cc_send)}</div>` : ""}
        ${doc.seal_no ? `<div class="timeline-item">用印登记：${escapeHtml(doc.seal_no)}</div>` : ""}
        <div class="timeline-item">承办：${escapeHtml(doc.owner_dept)} · 密级：${escapeHtml(doc.secret)} · ${escapeHtml(doc.urgency)}</div>
        <div class="timeline-item">当前状态：<span class="status ${escapeHtml(doc.status)}">${statusText(doc.status)}</span>，节点：${escapeHtml(doc.current_node)}</div>
        <div class="timeline-item">传阅范围：${escapeHtml(doc.readers || "—")}</div>
        ${doc.content ? `<div class="timeline-item">正文摘要：${escapeHtml(doc.content)}</div>` : ""}
        ${(doc.approvals || []).map((a) => `<div class="timeline-item">${escapeHtml(fmtTime(a.approved_at))} · ${escapeHtml(a.approver_name)} · ${escapeHtml(a.action)}：${escapeHtml(a.comment)}</div>`).join("")}
        ${(doc.receipts || []).map((r) => `<div class="timeline-item">${escapeHtml(fmtTime(r.created_at))} · ${escapeHtml(r.user_name)} · ${escapeHtml(r.action)}：${escapeHtml(r.comment)} ${r.signature ? `<img class="sign-img" src="${r.signature}" alt="签名" />` : ""}</div>`).join("")}
        ${renderFlowSteps(doc)}
      </div>`;
    openModal(isRecv ? "阅文卡" : "公文办理留痕", `
      ${headerHtml}
      ${doc.can_terminate && canApprove() && doc.status === "pending" ? `<div class="row-actions" style="margin:12px 0">
        <button class="primary" data-doc-terminate="${doc.id}" title="当前节点可直接办结整个流程">直接办结</button>
      </div>` : ""}
      <div style="margin:12px 0;padding:8px 12px;background:#fff8e1;border-left:3px solid #ffb300;font-size:13px;color:#5d4037">
        ℹ️ 下方按钮仅做<b>留痕</b>，不会推动流程到下一节点。要审批请关闭本窗口，点击台账上的「<b>审批</b>」按钮。
      </div>
      <div class="row-actions" style="margin:12px 0">
        <button class="secondary" data-doc-action="read">阅读留痕</button>
        <button class="secondary" data-doc-action="sign">在线签字</button>
        <button class="secondary" data-doc-action="feedback">落实反馈</button>
        <button class="secondary" data-doc-action="print">打印留痕</button>
        ${!isRecv && canApprove() ? `<button class="secondary" data-doc-action="seal">用印登记</button>` : ""}
      </div>
      ${attachmentBlock("document", id, attachments)}`);
    document.querySelectorAll("[data-doc-action]").forEach((b) => b.addEventListener("click", () => docAction(id, b.dataset.docAction)));
    const term = document.querySelector("[data-doc-terminate]");
    if (term) term.addEventListener("click", async () => {
      if (!confirm("确认直接办结？本流程将立即归档，其他并行节点也会一并结束。")) return;
      try {
        await api(`/api/documents/${id}/approve`, { method: "POST", body: JSON.stringify({ comment: "直接办结", terminate: 1 }) });
        closeModal(); await renderView(); refreshNotify();
        toast("✓ 已办结并归档");
      } catch (err) { alert(err.message); }
    });
    bindAttachmentForm("document", id);
  }

  // 轻量 toast：右上角飘出，2.4 秒淡出，不打断用户视线
  function toast(message, kind = "ok") {
    const bg = kind === "err" ? "#c62828" : "#2e7d32";
    const el = document.createElement("div");
    el.textContent = message;
    el.style.cssText = `position:fixed;top:24px;right:24px;z-index:9999;background:${bg};color:#fff;padding:10px 16px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);font-size:14px;opacity:0;transition:opacity .25s`;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "1"; });
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2400);
  }

  async function docAction(id, action) {
    if (action === "sign") return openSignPad(id);
    if (action === "print") {
      try {
        await api(`/api/documents/${id}/print`, { method: "POST", body: JSON.stringify({ comment: "打印公文" }) });
        toast("✓ 已记录打印留痕");
        window.print();
        await openDocDetail(id);
      } catch (err) { toast(err.message, "err"); }
      return;
    }
    if (action === "seal") {
      const sealNo = prompt("请输入盖章 / 用印登记号", "已盖中心公章");
      if (!sealNo) return;
      const comment = prompt("用印备注（可选）", "") || "";
      try {
        await api(`/api/documents/${id}/seal`, { method: "POST", body: JSON.stringify({ sealNo, comment }) });
        toast(`✓ 用印登记已保存（${sealNo}）`);
        await openDocDetail(id);
        refreshNotify();
      } catch (err) { toast(err.message, "err"); }
      return;
    }
    const actionLabel = { read: "阅读留痕", feedback: "落实反馈" }[action] || action;
    const comment = action === "feedback" ? (prompt("请输入落实反馈", "已落实办理") || "") : "已阅读";
    try {
      await api(`/api/documents/${id}/${action}`, { method: "POST", body: JSON.stringify({ comment }) });
      toast(`✓ 已记录${actionLabel}`);
      await openDocDetail(id);
      refreshNotify();
    } catch (err) { toast(err.message, "err"); }
  }

  function openSignPad(id) {
    openModal("在线签字", `
      <div class="muted" style="margin-bottom:8px">请在下方区域手写签名</div>
      <canvas id="signPad" width="420" height="160" class="sign-pad"></canvas>
      <div class="row-actions" style="margin-top:10px">
        <button class="primary" id="signSave" type="button">提交签字</button>
        <button class="secondary" id="signClear" type="button">清除</button>
        <button class="secondary modal-cancel" type="button">取消</button>
      </div>`);
    const canvas = $("signPad");
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.strokeStyle = "#16314f";
    let drawing = false, dirty = false;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; };
    const start = (e) => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
    const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); dirty = true; e.preventDefault(); };
    const end = () => { drawing = false; };
    canvas.addEventListener("mousedown", start); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start); canvas.addEventListener("touchmove", move); canvas.addEventListener("touchend", end);
    $("signClear").addEventListener("click", () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; });
    $("signSave").addEventListener("click", async () => {
      if (!dirty) return toast("请先签名", "err");
      try {
        await api(`/api/documents/${id}/sign`, { method: "POST", body: JSON.stringify({ signature: canvas.toDataURL("image/png"), comment: "在线签字" }) });
        toast("✓ 签字已保存");
        closeModal();
        await openDocDetail(id);
      } catch (err) { toast(err.message, "err"); }
    });
  }

  /* ---------------- 统计分析 ---------------- */

  async function renderStats() {
    viewRoot.innerHTML = `
      <div class="filter-bar">
        <select data-f="type"><option value="">全部业务</option><option value="leave">请假</option><option value="trip">出差</option><option value="vehicle">用车</option></select>
        <select data-f="groupBy"><option value="category">按类别</option><option value="person">按人</option><option value="dept">按部门</option><option value="type">按类型</option><option value="month">按月份</option><option value="status">按状态</option></select>
        <input data-f="from" type="date" /><input data-f="to" type="date" />
        <button class="secondary" data-do-filter>统计</button>
        <button class="secondary" id="statExport">导出 Excel</button>
      </div>
      <div class="grid cols-2">
        <section class="panel"><div class="panel-header"><h2>业务申请统计</h2></div><div class="panel-body" id="reqStat"><div class="empty">点击「统计」查看</div></div></section>
        <section class="panel"><div class="panel-header"><h2>收发文统计</h2><button class="secondary" id="docStatExport">导出 Excel</button></div><div class="panel-body" id="docStat"></div></section>
      </div>`;
    const run = async () => {
      const p = readFilters();
      const data = await api(`/api/stats/requests?${p.toString()}`);
      $("reqStat").innerHTML = data.rows.length ? `<table><thead><tr><th>${escapeHtml(data.label)}</th><th>数量</th><th>合计天数</th></tr></thead>
        <tbody>${data.rows.map((r) => `<tr><td>${escapeHtml(r.key == null ? "—" : (typeText(r.key) || r.key))}</td><td>${r.count}</td><td>${r.days || 0}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">无数据</div>`;
    };
    const runDoc = async () => {
      const p = readFilters();
      const data = await api(`/api/stats/documents?${p.toString()}`);
      $("docStat").innerHTML = `<table><thead><tr><th>类型</th><th>数量</th></tr></thead><tbody>${(data.byType || []).map((r) => `<tr><td>${escapeHtml(r.key)}</td><td>${r.count}</td></tr>`).join("") || `<tr><td colspan=2>无数据</td></tr>`}</tbody></table>`;
    };
    viewRoot.querySelector("[data-do-filter]").addEventListener("click", () => { run(); runDoc(); });
    $("statExport").addEventListener("click", () => { const p = readFilters(); downloadExport(`/api/export/stats-requests.xlsx?${p.toString()}`); });
    $("docStatExport").addEventListener("click", () => { const p = readFilters(); downloadExport(`/api/export/stats-documents.xlsx?${p.toString()}`); });
    run(); runDoc();
  }

  /* ---------------- 日志 ---------------- */

  async function renderLogs() {
    viewRoot.innerHTML = `
      <div class="filter-bar">
        <input data-f="keyword" placeholder="关键字" /><input data-f="from" type="date" /><input data-f="to" type="date" />
        <button class="secondary" data-do-filter>查询</button><button class="link" data-reset-filter>重置</button>
      </div>
      <div class="grid cols-2">
        <section class="panel"><div class="panel-header"><h2>操作日志</h2></div><div class="panel-body" id="opLog"></div></section>
        <section class="panel"><div class="panel-header"><h2>登录日志</h2></div><div class="panel-body" id="loginLog"></div></section>
      </div>`;
    const loadOp = async (page = 1) => {
      const p = readFilters(); p.set("page", page); p.set("pageSize", 30);
      const data = await api(`/api/logs/operations?${p.toString()}`);
      $("opLog").innerHTML = `<table><thead><tr><th>时间</th><th>操作人</th><th>模块</th><th>动作</th><th>内容</th><th>IP</th></tr></thead>
        <tbody>${data.items.map((i) => `<tr><td>${escapeHtml(fmtTime(i.created_at))}</td><td>${escapeHtml(i.operator_name)}</td><td>${escapeHtml(i.module_name)}</td><td>${escapeHtml(i.action)}</td><td>${escapeHtml(i.content)}</td><td>${escapeHtml(i.ip)}</td></tr>`).join("")}</tbody></table>${pager(data.total, data.page, data.pageSize)}`;
      bindPagerEl($("opLog"), loadOp);
    };
    const loadLogin = async (page = 1) => {
      const p = readFilters(); p.set("page", page); p.set("pageSize", 30);
      const data = await api(`/api/logs/login?${p.toString()}`);
      $("loginLog").innerHTML = `<table><thead><tr><th>时间</th><th>账号</th><th>IP</th><th>结果</th><th>原因</th></tr></thead>
        <tbody>${data.items.map((i) => `<tr><td>${escapeHtml(fmtTime(i.login_time))}</td><td>${escapeHtml(i.account)}</td><td>${escapeHtml(i.ip)}</td><td>${escapeHtml(i.result)}</td><td>${escapeHtml(i.reason)}</td></tr>`).join("")}</tbody></table>${pager(data.total, data.page, data.pageSize)}`;
      bindPagerEl($("loginLog"), loadLogin);
    };
    bindFilter(() => { loadOp(1); loadLogin(1); });
    loadOp(1); loadLogin(1);
  }

  /* ---------------- 附件 ---------------- */

  function attachmentBlock(type, id, attachments) {
    return `<section class="panel" style="margin-top:14px"><div class="panel-header"><h2>附件</h2></div><div class="panel-body">
      <div class="notice-list">${attachments.length ? attachments.map((f) => `<div class="notice-item"><strong>${escapeHtml(f.original_name)}</strong>
        <div class="muted">${Math.ceil(f.size / 1024)} KB · ${escapeHtml(fmtTime(f.created_at))} · ${escapeHtml(f.uploaded_by_name)}</div>
        <button class="link" data-preview="${f.id}">预览</button> <button class="link" data-download="${f.id}">下载</button></div>`).join("") : `<div class="empty">暂无附件</div>`}</div>
      <form id="attachmentForm" class="row-actions" style="margin-top:12px"><input type="file" name="file" required /><button class="primary" type="submit">上传附件</button></form>
    </div></section>`;
  }

  function bindAttachmentForm(type, id) {
    document.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () => downloadFile(b.dataset.download)));
    document.querySelectorAll("[data-preview]").forEach((b) => b.addEventListener("click", () => previewFile(b.dataset.preview)));
    const form = $("attachmentForm");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api(`/api/attachments/${type}/${id}`, { method: "POST", body: new FormData(e.currentTarget) });
        closeModal();
        if (type === "document") await openDocDetail(id); else await openRequestDetail(id);
      } catch (err) { alert(err.message); }
    });
  }

  async function downloadFile(id) {
    const response = await fetch(`/api/attachments/${id}/download`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return alert("下载失败");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = match ? decodeURIComponent(match[1]) : "附件";
    link.click(); URL.revokeObjectURL(url);
  }

  async function previewFile(id) {
    const response = await fetch(`/api/attachments/${id}/preview`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return alert("该附件暂不支持预览");
    const blob = await response.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  }

  async function downloadExport(url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return alert("导出失败");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i);
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl; link.download = match ? decodeURIComponent(match[1]) : "导出.xlsx";
    link.click(); URL.revokeObjectURL(objectUrl);
  }

  /* ---------------- 通知 ---------------- */

  async function refreshNotify() {
    try {
      const data = await api("/api/notifications");
      const badge = $("notifyCount");
      if (badge) { badge.textContent = data.unread > 99 ? "99+" : data.unread; badge.hidden = !data.unread; }
      return data;
    } catch (e) { return { items: [], unread: 0 }; }
  }

  let notifyFilter = "all"; // all | unread

  async function openNotifications() { await renderNotifyModal(); }

  async function renderNotifyModal() {
    const onlyUnread = notifyFilter === "unread";
    const data = await api(`/api/notifications${onlyUnread ? "?unread=1" : ""}`);
    const badge = $("notifyCount");
    const totalUnread = onlyUnread ? data.unread : data.unread;
    if (badge) { badge.textContent = data.unread > 99 ? "99+" : data.unread; badge.hidden = !data.unread; }
    const catBadge = (c) => c === "info" ? '<span class="dept-tag sub">通知</span>' : '<span class="dept-tag top">待办</span>';
    closeModal(); // 切换标签/标记已读时先关掉旧弹窗，避免模态层层叠加
    openModal("消息通知", `
      <div class="subtabs" style="margin-bottom:10px">
        <button class="subtab ${notifyFilter === "all" ? "active" : ""}" data-nf="all">全部</button>
        <button class="subtab ${notifyFilter === "unread" ? "active" : ""}" data-nf="unread">未读${totalUnread ? `（${totalUnread}）` : ""}</button>
        <span style="flex:1"></span>
        <button class="link" id="readAll">全部已读</button>
      </div>
      <div class="notice-list">${data.items.length ? data.items.map((n) => `<div class="notice-item ${n.is_read ? "" : "unread"}" data-noti="${n.id}" data-bt="${escapeHtml(n.business_type || "")}" data-bid="${n.business_id || ""}">
        <div class="noti-head"><strong>${escapeHtml(n.title)}</strong>${catBadge(n.category)}<span class="muted noti-time">${escapeHtml(fmtTime(n.created_at))}</span></div>
        <p>${escapeHtml(n.content)}</p></div>`).join("") : `<div class="empty">${onlyUnread ? "没有未读通知" : "暂无通知"}</div>`}</div>`);
    document.querySelectorAll("[data-nf]").forEach((b) => b.addEventListener("click", () => { notifyFilter = b.dataset.nf; renderNotifyModal(); }));
    $("readAll").addEventListener("click", async () => { await api("/api/notifications/read-all", { method: "POST", body: "{}" }); refreshNotify(); renderNotifyModal(); });
    document.querySelectorAll("[data-noti]").forEach((el) => el.addEventListener("click", async () => {
      await api(`/api/notifications/${el.dataset.noti}/read`, { method: "POST", body: "{}" });
      const bt = el.dataset.bt, bid = el.dataset.bid;
      if (!bid) { refreshNotify(); return renderNotifyModal(); }
      closeModal(); refreshNotify();
      if (bt === "request") { await setView(hasModule("leave") ? "leave" : "dashboard"); openRequestDetail(bid); }
      else if (bt === "document") { await setView("document"); openDocDetail(bid); }
      else if (bt === "instance") {
        try { const inst = await api(`/api/instances/${bid}`); if (hasModule(inst.business_type_code)) await setView(inst.business_type_code); openInstanceDetail(bid); } catch (e) { /* ignore */ }
      }
    }));
  }

  /* ---------------- 通用绑定 ---------------- */

  function bindActions() {
    viewRoot.querySelectorAll("[data-create]").forEach((b) => b.addEventListener("click", () => openRequestForm(b.dataset.create)));
    viewRoot.querySelectorAll("[data-create-doc]").forEach((b) => b.addEventListener("click", () => openDocumentForm(b.dataset.createDoc)));
    viewRoot.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", () => downloadExport(b.dataset.export)));
    bindRowActions(viewRoot);
  }

  function bindRowActions(root) {
    root.querySelectorAll("[data-detail]").forEach((b) => b.addEventListener("click", () => openRequestDetail(b.dataset.detail)));
    root.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => openRequestDetail(b.dataset.approve)));
    root.querySelectorAll("[data-withdraw]").forEach((b) => b.addEventListener("click", () => withdrawRequest(b.dataset.withdraw)));
    root.querySelectorAll("[data-doc-detail]").forEach((b) => b.addEventListener("click", () => openDocDetail(b.dataset.docDetail)));
    root.querySelectorAll("[data-doc-approve]").forEach((b) => b.addEventListener("click", () => approveDocument(b.dataset.docApprove)));
    root.querySelectorAll("[data-doc-distribute]").forEach((b) => b.addEventListener("click", () => openDistributeForm(b.dataset.docDistribute)));
  }

  function pager(total, page, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (pages <= 1) return `<div class="pager muted">共 ${total} 条</div>`;
    return `<div class="pager"><button class="secondary" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page} / ${pages} 页 · 共 ${total} 条</span><button class="secondary" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button></div>`;
  }

  function bindPagerEl(root, load) {
    root.querySelectorAll("[data-page]").forEach((b) => { if (!b.disabled) b.addEventListener("click", () => load(Number(b.dataset.page))); });
  }

  function openModal(title, body) {
    const node = $("modalTemplate").content.firstElementChild.cloneNode(true);
    node.querySelector("h2").textContent = title;
    node.querySelector(".modal-body").innerHTML = body;
    document.body.appendChild(node);
    const closeThis = () => node.remove();
    node.querySelector(".modal-close").addEventListener("click", closeThis);
    node.querySelectorAll(".modal-cancel").forEach((b) => b.addEventListener("click", closeThis));
    node.addEventListener("click", (e) => { if (e.target === node) closeThis(); });
  }
  function closeModal() {
    const all = document.querySelectorAll(".modal-mask");
    if (all.length) all[all.length - 1].remove();
  }
  function closeAllModals() {
    document.querySelectorAll(".modal-mask").forEach((n) => n.remove());
  }

  /* ---------------- 修改密码 ---------------- */

  // 我的资料：电话本人可改，姓名/科室/入职日期由管理员维护
  async function openProfile() {
    let p;
    try { p = await api("/api/me/profile"); } catch (e) { return alert(e.message); }
    openModal("我的资料", `
      <form id="profileForm" class="form-grid">
        <label>姓名<input value="${escapeHtml(p.name || "")}" disabled /></label>
        <label>账号<input value="${escapeHtml(p.account || "")}" disabled /></label>
        <label>科室<input value="${escapeHtml(p.dept || "")}" disabled /></label>
        <label>角色<input value="${escapeHtml(p.role || "")}" disabled /></label>
        <label>参加工作时间<input value="${escapeHtml(p.entry_date || "（管理员维护）")}" disabled title="如需修改，请联系管理员" /></label>
        <label>联系电话<input name="phone" value="${escapeHtml(p.phone || "")}" placeholder="如 13800138000" maxlength="20" /></label>
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("profileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try { await api("/api/me/profile", { method: "PUT", body: JSON.stringify({ phone: f.get("phone") }) }); alert("已保存"); closeModal(); }
      catch (err) { alert(err.message); }
    });
  }

  function openChangePassword() {
    openModal("修改密码", `
      <form id="pwdForm" class="form-grid">
        <label class="full">原密码<input type="password" name="oldPassword" required /></label>
        <label class="full">新密码（至少6位）<input type="password" name="newPassword" required /></label>
        <div class="full row-actions"><button class="primary" type="submit">保存</button><button class="secondary modal-cancel" type="button">取消</button></div>
      </form>`);
    $("pwdForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try { await api("/api/me/password", { method: "POST", body: JSON.stringify({ oldPassword: f.get("oldPassword"), newPassword: f.get("newPassword") }) }); alert("密码已修改"); closeModal(); }
      catch (err) { alert(err.message); }
    });
  }

  /* ---------------- 会话 ---------------- */

  async function showApp(payload) {
    session = payload.user;
    modules = payload.modules;
    directoryCache = null;
    pickerDirectoryCache = null;
    await loadBizTypes();
    if (!hasModule(activeView)) activeView = "dashboard";
    loginPanel.hidden = true;
    appShell.hidden = false;
    currentUserName.textContent = session.name;
    currentUserRole.textContent = `${session.dept} · ${session.role}`;
    setPageMeta(); renderNav(); await renderView(); refreshNotify();
  }

  function showLogin() {
    loginPanel.hidden = false;
    appShell.hidden = true;
  }

  function logout(removeToken) {
    if (removeToken !== false) localStorage.removeItem(TOKEN_KEY);
    token = null; session = null; modules = [];
    showLogin();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const payload = await api("/api/auth/login", { method: "POST", body: JSON.stringify({
        account: $("loginAccount").value.trim(), password: $("loginPassword").value,
      }) });
      token = payload.token; localStorage.setItem(TOKEN_KEY, token);
      await showApp(payload);
    } catch (err) { alert(err.message); }
  });

  moduleNav.addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) setView(b.dataset.view);
  });

  if ($("notifyBtn")) $("notifyBtn").addEventListener("click", openNotifications);
  if ($("profileBtn")) $("profileBtn").addEventListener("click", openProfile);
  if ($("pwdBtn")) $("pwdBtn").addEventListener("click", openChangePassword);
  $("logoutBtn").addEventListener("click", () => logout(true));

  setInterval(() => { if (session) refreshNotify(); }, 30000);

  (async function boot() {
    if (!token) return showLogin();
    try { await showApp(await api("/api/me")); }
    catch (err) { logout(false); }
  })();
})();
