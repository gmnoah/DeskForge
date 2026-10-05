const api = window.deskforge;

const sessionList = document.querySelector("#session-list");
const messagesEl = document.querySelector("#messages");
const statusEl = document.querySelector("#status");
const workspaceEl = document.querySelector("#workspace");
const presetEl = document.querySelector("#preset");
const baseUrlEl = document.querySelector("#base-url");
const modelEl = document.querySelector("#model");
const apiKeyEl = document.querySelector("#api-key");
const keyStateEl = document.querySelector("#key-state");
const approvalsEl = document.querySelector("#approvals");
const auditEl = document.querySelector("#audit");
const auditOkEl = document.querySelector("#audit-ok");
const promptEl = document.querySelector("#prompt");
const sendButton = document.querySelector("#send");

const state = {
  presets: [],
  sessions: [],
  sessionId: null,
  messages: [],
  approvals: [],
  running: false,
  profile: null,
};

function tierLabel(tier) {
  if (tier === "high") return "高";
  if (tier === "medium") return "中";
  return "低";
}

function renderSessions() {
  sessionList.replaceChildren();
  if (state.sessions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "还没有会话";
    sessionList.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session${session.id === state.sessionId ? " active" : ""}`;
    button.textContent = session.title;
    button.addEventListener("click", () => void openSession(session.id));
    item.append(button);
    sessionList.append(item);
  }
}

function renderMessages() {
  messagesEl.replaceChildren();
  if (state.messages.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "从一句具体的工作开始。需要文件或命令时，模型会先申请能力。";
    messagesEl.append(empty);
    return;
  }
  for (const message of state.messages) {
    const item = document.createElement("li");
    item.className = `message ${message.role}`;
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = message.role === "user" ? "你" : "DeskForge";
    const body = document.createElement("p");
    body.textContent = message.content;
    item.append(who, body);
    messagesEl.append(item);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderApprovals() {
  approvalsEl.replaceChildren();
  if (state.approvals.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "没有等待中的操作";
    approvalsEl.append(empty);
    return;
  }
  for (const approval of state.approvals) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("strong");
    title.textContent = approval.request.tool;
    const tier = document.createElement("span");
    tier.className = `tier-${approval.request.tier}`;
    tier.textContent = ` · ${tierLabel(approval.request.tier)}风险`;
    const reason = document.createElement("p");
    reason.textContent = approval.request.reason;
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(approval.request.args, null, 2);
    const actions = document.createElement("div");
    actions.className = "actions";
    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "批准";
    allow.addEventListener("click", () => void decide(approval.id, true));
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "ghost";
    deny.textContent = "拒绝";
    deny.addEventListener("click", () => void decide(approval.id, false));
    actions.append(allow, deny);
    card.append(title, tier, reason, pre, actions);
    approvalsEl.append(card);
  }
}

function renderAudit(records, auditOk) {
  auditOkEl.textContent = auditOk ? "哈希链完好" : "哈希链校验失败";
  auditEl.replaceChildren();
  const visible = [...(records ?? [])].reverse();
  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "还没有记录";
    auditEl.append(empty);
    return;
  }
  for (const record of visible) {
    const item = document.createElement("li");
    item.textContent = `${record.seq}. ${record.decision} ${record.action}`;
    auditEl.append(item);
  }
}

function fillPreset(preset, keepCustom) {
  if (!preset) return;
  if (!keepCustom || preset.id === "custom" || !baseUrlEl.value) baseUrlEl.value = preset.baseUrl;
  if (!keepCustom || preset.id === "custom" || !modelEl.value) modelEl.value = preset.model;
}

function applyBootstrap(data) {
  state.presets = data.presets;
  state.sessions = data.sessions;
  state.profile = data.profile;
  presetEl.replaceChildren();
  for (const preset of data.presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    presetEl.append(option);
  }
  if (data.profile) {
    presetEl.value = data.profile.preset;
    baseUrlEl.value = data.profile.baseUrl;
    modelEl.value = data.profile.model;
  } else {
    const deepseek = data.presets.find((preset) => preset.id === "deepseek");
    presetEl.value = "deepseek";
    fillPreset(deepseek, false);
    if (data.envBaseUrl) baseUrlEl.value = data.envBaseUrl;
    if (data.envModel) modelEl.value = data.envModel;
  }
  workspaceEl.textContent = data.workspaceRoot || "还没有选择。不会默认使用 /。";
  keyStateEl.textContent = data.hasApiKey ? "主进程里已经有一把密钥，界面不会把它读回来。" : "还没有密钥。";
  statusEl.textContent = data.platform === "darwin" ? "macOS · 空闲" : "非 macOS 环境 · 仅供检查";
  renderSessions();
  renderAudit(data.audit, data.auditOk);
  renderMessages();
  renderApprovals();
}

async function openSession(sessionId) {
  state.sessionId = sessionId;
  state.messages = await api.invoke("messages", { sessionId });
  renderSessions();
  renderMessages();
}

async function decide(id, approved) {
  state.approvals = state.approvals.filter((item) => item.id !== id);
  renderApprovals();
  await api.invoke("decide", { id, approved });
}

if (!api) {
  statusEl.textContent = "预加载脚本没有暴露接口";
} else {
  api.onEvent((event) => {
    if (event.type === "sessions") {
      state.sessions = event.sessions;
      renderSessions();
    }
    if (event.type === "messages") {
      state.sessionId = event.sessionId;
      state.messages = event.messages;
      renderSessions();
      renderMessages();
    }
    if (event.type === "text") {
      const last = state.messages.at(-1);
      if (last && last.role === "assistant" && last.streaming) {
        last.content = event.text;
      } else {
        state.messages.push({ role: "assistant", content: event.text, streaming: true });
      }
      renderMessages();
    }
    if (event.type === "approval") {
      state.approvals.push(event);
      renderApprovals();
    }
    if (event.type === "approval-closed") {
      state.approvals = state.approvals.filter((item) => item.id !== event.id);
      renderApprovals();
    }
    if (event.type === "audit") renderAudit(event.records, event.auditOk);
    if (event.type === "status") {
      state.running = event.running;
      sendButton.disabled = event.running;
      statusEl.textContent = event.running ? "正在运行" : "空闲";
    }
    if (event.type === "error") statusEl.textContent = event.message;
  });

  document.querySelector("#new-session").addEventListener("click", () => {
    state.sessionId = null;
    state.messages = [];
    renderSessions();
    renderMessages();
  });

  document.querySelector("#choose-workspace").addEventListener("click", async () => {
    const result = await api.invoke("chooseWorkspace");
    if (result?.workspaceRoot) workspaceEl.textContent = result.workspaceRoot;
    if (result?.error && !result.ok) statusEl.textContent = result.error;
  });

  presetEl.addEventListener("change", () => {
    const preset = state.presets.find((item) => item.id === presetEl.value);
    fillPreset(preset, false);
  });

  document.querySelector("#settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.invoke("saveSettings", {
      preset: presetEl.value,
      baseUrl: baseUrlEl.value,
      model: modelEl.value,
      apiKey: apiKeyEl.value,
    });
    apiKeyEl.value = "";
    if (result.ok) {
      const data = await api.invoke("bootstrap");
      applyBootstrap(data);
      statusEl.textContent = "模型已保存";
      keyStateEl.textContent = data.hasApiKey ? "主进程里已经有一把密钥，界面不会把它读回来。" : "还没有密钥。";
    } else {
      statusEl.textContent = result.error || "保存失败";
    }
  });

  document.querySelector("#composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = promptEl.value;
    if (!text.trim() || state.running) return;
    promptEl.value = "";
    const result = await api.invoke("send", { sessionId: state.sessionId, text });
    if (result?.sessionId) state.sessionId = result.sessionId;
    if (!result?.ok && result?.error) statusEl.textContent = result.error;
  });

  promptEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      document.querySelector("#composer").requestSubmit();
    }
  });

  void api.invoke("bootstrap").then(applyBootstrap).catch((error) => {
    statusEl.textContent = error instanceof Error ? error.message : "无法读取状态";
  });
}
