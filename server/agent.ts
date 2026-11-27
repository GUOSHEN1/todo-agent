import type { ChatMessage } from "../shared/chat.ts";
import type { Effort, Priority, TaskStore } from "./task-store.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

// 任务存储由 index.ts 注入，让智能体既能对话也能读写清单。
let tasks: TaskStore;

export function setTaskStore(store: TaskStore) {
  tasks = store;
}

// 记录「用户刚请求清空、等待确认」的状态，用于二次确认防止误删。
let pendingClear = false;

// 意图类型：把用户消息归类为一种操作，并携带解析出的参数。
type Intent =
  | { kind: "create"; title: string; priority?: Priority; effort?: Effort; due?: string }
  | { kind: "list"; filter?: "pending" | "done" | "due-today" }
  | { kind: "complete"; query: string }
  | { kind: "uncomplete"; query: string }
  | { kind: "delete"; query: string }
  | { kind: "set-priority"; query: string; priority: Priority }
  | { kind: "set-effort"; query: string; effort: Effort }
  | { kind: "set-due"; query: string; due: string }
  | { kind: "clear" }
  | { kind: "unknown" };

// ---------------------------------------------------------------------------
// 本地规则解析：不依赖大模型，保证无 API key 时基础功能也能验收通过。
// ---------------------------------------------------------------------------

const completeMarkers = ["好了", "完成", "搞定", "做完", "办完", "买好", "买到", "取到", "处理完"];
const uncompleteMarkers = ["还没", "取消完成", "标记为未完成", "恢复为待办"];
const deleteMarkers = ["删掉", "删除", "移除", "去掉", "取消这条", "不要了"];
const clearMarkers = ["清空任务", "清空清单", "清空列表", "清空待办", "全部删掉", "删掉所有", "删除所有", "全部清除", "清除所有", "清空"];
const listMarkers = [
  "有哪些",
  "看看",
  "清单",
  "列表",
  "任务",
  "待办",
  "还有什么",
  "给我看",
  "查一下",
];
const createMarkers = [
  "帮我记",
  "记一下",
  "记一条",
  "再记",
  "加一条",
  "新增",
  "添加",
  "提醒我",
  "记上",
  "记个",
  "帮我加",
  "记个任务",
];

const priorityWords: Record<string, Priority> = {
  高: "高",
  紧急: "高",
  重要: "高",
  中: "中",
  普通: "中",
  低: "低",
  不急: "低",
};
const effortWords: Record<string, Effort> = {
  大: "大",
  复杂: "大",
  难: "大",
  中: "中",
  一般: "中",
  小: "小",
  简单: "小",
  容易: "小",
  快: "小",
};

// 从消息中抽取任务标题：去掉常见的前缀动词与语气词，以及优先级/工作量/到期修饰。
function extractTitle(text: string): string {
  let title = text;
  title = title.replace(
    /^(帮我|请|麻烦|再)?(记一下|记一条|记下|记上|记个|新增|添加|加一条|提醒我|我要|我想|记个任务)[：:\s]*/,
    "",
  );
  title = title
    .replace(/[,，、]\s*(高|中|低|紧急|重要|普通|不急)?\s*优先级?/, "")
    .replace(/[,，、]\s*工作量?\s*(大|中|小|复杂|一般|简单|容易|难|快)?/, "")
    .replace(
      /[,，、]\s*(今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜天)?\s*(到期|截止|要交)?/,
      "",
    );
  title = title.replace(/[吧哦啊啦哈呀嘛咯]$/, "");
  return title.trim().replace(/^[,，、\s]+|[,，、\s]+$/g, "");
}

// 去掉定位描述里的动词和语气词，得到用于匹配任务的查询词。
function cleanQuery(text: string): string {
  return text
    .replace(/^(请|帮我|麻烦)?(把|将)?/, "")
    .replace(/(这条|那个|这个|了|吧|哦|啊|啦|哈|呀)/g, "")
    .trim();
}

function detectPriority(text: string): Priority | undefined {
  for (const [word, level] of Object.entries(priorityWords)) {
    if (
      text.includes(`${word}优先`) ||
      text.includes(`优先级${word}`) ||
      text.includes(`优先级是${word}`)
    )
      return level;
  }
  return undefined;
}

function detectEffort(text: string): Effort | undefined {
  for (const [word, level] of Object.entries(effortWords)) {
    if (text.includes(`工作量${word}`) || text.includes(`工作量是${word}`)) return level;
  }
  return undefined;
}

// 解析「今天 / 明天 / 周几 / 具体日期」到期时间。
function detectDue(text: string): string | undefined {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/(今天|今晚|今儿)/.test(text)) return toDateString(today);
  if (/(明天|明晚|明儿)/.test(text)) return toDateString(addDays(today, 1));
  if (/(后天)/.test(text)) return toDateString(addDays(today, 2));

  const weekdayMap: Record<string, number> = {
    周一: 1,
    周二: 2,
    周三: 3,
    周四: 4,
    周五: 5,
    周六: 6,
    周日: 0,
    星期天: 0,
    礼拜天: 0,
  };
  for (const [name, day] of Object.entries(weekdayMap)) {
    if (text.includes(name)) {
      const diff = (day - today.getDay() + 7) % 7 || 7;
      return toDateString(addDays(today, diff));
    }
  }

  const dateMatch = text.match(/(\d{1,2})[月/-](\d{1,2})(?:日|号)?/);
  if (dateMatch) {
    const month = Number(dateMatch[1]);
    const day = Number(dateMatch[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const target = new Date(now.getFullYear(), month - 1, day);
      return toDateString(target);
    }
  }
  return undefined;
}

function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// 判断是否为纯打招呼 / 寒暄，无需解析意图。
function isGreeting(text: string): boolean {
  const t = text.trim();
  return /^(你好|您好|嗨|哈喽|hello|hi|在吗|在不在|早上好|下午好|晚上好|谢谢|多谢|你是谁|你能做什么|你会什么)[!！。？?~～\s]*$/i.test(
    t,
  );
}

function parseIntent(text: string): Intent {
  const t = text.trim();

  // 查看清单（含「今天到期」）
  if (/今天.*(到期|要交|截止)|今天有哪些|有哪些.*到期/.test(t)) {
    return { kind: "list", filter: "due-today" };
  }
  if (/^(我|帮我看|看看|给我看|查)/.test(t) && listMarkers.some((m) => t.includes(m))) {
    return { kind: "list" };
  }
  if (
    /(有哪些|看看.*清单|看看.*待办|查看|清单|待办)/.test(t) &&
    !createMarkers.some((m) => t.includes(m))
  ) {
    return { kind: "list" };
  }

  // 创建任务（优先于设置类操作，避免「帮我记一下写周报，高优先级」被误判为设置）
  if (createMarkers.some((m) => t.includes(m))) {
    const title = extractTitle(t);
    if (title) {
      return {
        kind: "create",
        title,
        priority: detectPriority(t),
        effort: detectEffort(t),
        due: detectDue(t),
      };
    }
    // 有创建意图但没说出具体任务：返回空标题的 create，由上层给出追问。
    return { kind: "create", title: "" };
  }

  // 设置优先级
  const priority = detectPriority(t);
  const priorityQuery = t
    .replace(/优先级?(是|为|设为|设置)?(高|中|低|紧急|重要|普通|不急)/, "")
    .trim();
  if (priority && priorityQuery) return { kind: "set-priority", query: priorityQuery, priority };

  // 设置工作量
  const effort = detectEffort(t);
  const effortQuery = t
    .replace(/工作量?(是|为|设为|设置)?(大|中|小|复杂|一般|简单|容易|难|快)/, "")
    .trim();
  if (effort && effortQuery) return { kind: "set-effort", query: effortQuery, effort };

  // 设置到期时间
  const due = detectDue(t);
  if (due) {
    // 去掉「明天/今天/后天/周几」和「到期/截止/要交」等词，剩下的就是任务描述
    const dueQuery = t
      .replace(
        /(今天|明天|后天|今晚|明晚|今儿|明儿|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜天)/g,
        "",
      )
      .replace(/(到期|截止|要交|前完成|之前完成|设为|设置|改成|安排到|放到|定在|前)/g, "")
      .replace(/[的了吧哦啊啦哈呀嘛]/g, "")
      .trim();
    if (dueQuery) return { kind: "set-due", query: dueQuery, due };
  }

  // 清空全部任务（优先于单条删除判断，避免「全部删掉」被当成删除单条）
  if (clearMarkers.some((m) => t.includes(m))) {
    return { kind: "clear" };
  }

  // 删除
  if (deleteMarkers.some((m) => t.includes(m))) {
    const query = cleanQuery(t.replace(/(删掉|删除|移除|去掉|取消这条|不要了)/g, ""));
    return { kind: "delete", query: query || t };
  }

  // 标记完成
  if (completeMarkers.some((m) => t.includes(m)) && !deleteMarkers.some((m) => t.includes(m))) {
    const query = cleanQuery(
      t.replace(
        /(已经|都|办好了|买好了|买到了|取到了|完成了|搞定了|做好了|做完了|处理完了|好了|完成|搞定|做完|办完)/g,
        "",
      ),
    );
    return { kind: "complete", query: query || t };
  }

  // 取消完成
  if (uncompleteMarkers.some((m) => t.includes(m))) {
    const query = cleanQuery(t.replace(/(还没|取消完成|标记为未完成|恢复为待办)/g, ""));
    return { kind: "uncomplete", query: query || t };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// 大模型增强：当配置了 API key 时，用 DeepSeek 做更精准的意图识别。
// ---------------------------------------------------------------------------

interface LlmIntent {
  action:
    | "create"
    | "list"
    | "complete"
    | "delete"
    | "set_priority"
    | "set_effort"
    | "set_due"
    | "unknown";
  title?: string;
  query?: string;
  priority?: Priority;
  effort?: Effort;
  due?: string;
}

const SYSTEM_PROMPT = `你是「小明」待办清单助手。分析用户的中文消息，只输出一个 JSON 数组，不要输出其他内容。
数组里的每一项是一个动作对象，字段如下：
- action: create（新建任务）/ list（查看任务）/ complete（标记完成）/ delete（删除任务）/ set_priority（设置优先级）/ set_effort（设置工作量）/ set_due（设置到期时间）/ unknown（无法判断）
- create 时给出 title（任务标题，去掉语气词和前缀）；可选 priority（高/中/低）、effort（大/中/小）、due（YYYY-MM-DD）
- complete/delete/set_priority/set_effort/set_due 时给出 query（定位任务的描述词）
- set_priority 额外给 priority，set_effort 额外给 effort，set_due 额外给 due

重要规则：如果用户一句话里提到多件独立的事，必须拆成多个 create 动作，分别输出。例如「下午开会，开会前吃午饭」要拆成两个 create：「下午开会」和「吃午饭」。如果只有一件事，就输出只含一个元素的数组。

示例：
"帮我记一下买牛奶" -> [{"action":"create","title":"买牛奶"}]
"下午开会，会前吃午饭" -> [{"action":"create","title":"下午开会","priority":"高"},{"action":"create","title":"吃午饭"}]
"我有哪些任务？" -> [{"action":"list"}]
"牛奶买好了" -> [{"action":"complete","query":"买牛奶"}]
"取快递这条删掉吧" -> [{"action":"delete","query":"取快递"}]
"买牛奶设为高优先级" -> [{"action":"set_priority","query":"买牛奶","priority":"高"}]
"取快递明天到期" -> [{"action":"set_due","query":"取快递","due":"2026-11-27"}]

只输出 JSON 数组。`;

async function parseIntentWithLlm(text: string): Promise<LlmIntent[] | null> {
  try {
    // 未配置 API key 时直接回退规则，避免抛错。
    if (!process.env.DEEPSEEK_API_KEY) return null;
    const client = getModelClient();
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0,
      },
      // 模型请求超时上限：超时或失败都降级到本地规则，绝不卡住用户。
      { timeout: 10_000, maxRetries: 1 },
    );
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(
      raw
        .replace(/^```(json)?/i, "")
        .replace(/```$/, "")
        .trim(),
    );
    // 兼容两种情况：模型可能返回单个对象或数组，统一转成数组。
    return Array.isArray(parsed) ? (parsed as LlmIntent[]) : [parsed as LlmIntent];
  } catch (error) {
    // 记录原因便于排查，同时静默降级，保证服务不中断。
    console.warn(
      "[agent] 模型解析失败，已回退本地规则：",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// 任务匹配与展示。
// ---------------------------------------------------------------------------

function findTask(query: string) {
  const all = tasks.list();
  const q = query.trim();
  if (!q) return undefined;
  return (
    all.find((task) => task.title === q) ??
    all.find((task) => task.title.includes(q) || q.includes(task.title))
  );
}

function renderList(filter?: "pending" | "done" | "due-today"): string {
  const all = tasks.list();
  if (all.length === 0) return "你还没有任何待办，对我说「帮我记一下……」，我就能帮你记下来。";

  if (filter === "due-today") {
    const today = toDateString(new Date());
    const dueToday = all.filter((task) => task.due === today && !task.done);
    if (dueToday.length === 0) return "今天没有到期的任务。";
    return "今天到期：\n" + dueToday.map((task) => formatTask(task)).join("\n");
  }

  const pending = all.filter((task) => !task.done).sort(comparePriority);
  const done = all.filter((task) => task.done);

  if (filter === "pending" && pending.length === 0) return "太棒了，所有任务都已完成！";
  if (filter === "done" && done.length === 0) return "还没有已完成的任务。";

  const lines: string[] = [];
  const showPending = filter !== "done" && pending.length > 0;
  const showDone = filter !== "pending" && done.length > 0;

  if (showPending) {
    lines.push(`待办（${pending.length}）：`);
    pending.forEach((task, index) => lines.push(`${index + 1}. ${formatTask(task)}`));
  }
  if (showDone) {
    lines.push(`已完成（${done.length}）：`);
    done.forEach((task) => lines.push(`✓ ${task.title}`));
  }
  return lines.join("\n");
}

function formatTask(task: {
  title: string;
  priority?: Priority;
  effort?: Effort;
  due?: string;
}): string {
  const parts: string[] = [task.title];
  // 用「〔高〕」这类标记包裹优先级，前端据此把整条任务渲染成对应颜色加粗。
  if (task.priority) parts.push(`〔${task.priority}〕`);
  if (task.effort) parts.push(`[${task.effort}工作量]`);
  if (task.due) parts.push(`📅${task.due}`);
  return parts.join(" ");
}

const priorityRank: Record<Priority, number> = { 高: 0, 中: 1, 低: 2 };

function comparePriority(a: { priority?: Priority }, b: { priority?: Priority }): number {
  return (priorityRank[a.priority ?? "中"] ?? 1) - (priorityRank[b.priority ?? "中"] ?? 1);
}

// 创建单条任务，处理空标题、超长、去重等边界，返回给用户的文字结果。
// 用 { status } 区分是否真正记下，便于上层汇总多条任务时的措辞。
export function createTask(title: string, priority?: Priority, effort?: Effort, due?: string): {
  status: "created" | "duplicate" | "too-long" | "empty";
  title: string;
  detail: string;
} {
  const t = title.trim();
  if (!t) return { status: "empty", title: "", detail: "" };
  if (t.length > 200) return { status: "too-long", title: t, detail: "" };
  const existing = tasks.list().find((task) => task.title === t && !task.done);
  if (existing) return { status: "duplicate", title: t, detail: "" };
  const created = tasks.create(t);
  if (priority) tasks.update(created.id, { priority });
  if (effort) tasks.update(created.id, { effort });
  if (due) tasks.update(created.id, { due });
  const finalTask = tasks.list().find((task) => task.id === created.id) ?? created;
  return {
    status: "created",
    title: t,
    detail: formatTask(finalTask) !== t ? `（${formatTask(finalTask)}）` : "",
  };
}

// ---------------------------------------------------------------------------
// 主入口：接收对话历史，返回本轮回复。
// ---------------------------------------------------------------------------

export async function reply(messages: ChatMessage[]): Promise<string> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "你好，欢迎使用小明智能体";
  const text = lastUser.content;

  if (!tasks) return "你好，欢迎使用小明智能体";

  // 打招呼 / 寒暄：友好回应，不调用模型也不走意图解析。
  if (isGreeting(text)) {
    return "你好，我是小明。你可以直接跟我说「帮我记一下买牛奶」来记任务，或问「我有哪些任务？」来查看清单。";
  }

  // 二次确认：上一轮用户请求了「清空任务」，这一轮判断他是否确认。
  if (pendingClear) {
    pendingClear = false;
    if (/^(确定|确认|是的|好|嗯|清空吧|删吧|yes|ok|OK)$/.test(text.trim())) {
      tasks.clear();
      return "好的，已经清空全部任务，现在清单是空的。";
    }
    // 用户改主意或说了别的，取消清空。
    return "好的，那我先不清空了。你可以继续跟我说要记什么任务。";
  }

  // 优先用大模型解析，失败回退本地规则。
  // 但「清空任务」这类危险指令必须走确定性本地规则，避免模型误判成新建任务。
  let intent: Intent;
  if (clearMarkers.some((m) => text.includes(m))) {
    intent = { kind: "clear" };
  } else {
    const llmResults = await parseIntentWithLlm(text);
    if (llmResults) {
      // 大模型可能拆出多个 create（一句话含多个任务），单独处理。
      const creates = llmResults
        .filter((l) => l.action === "create" && l.title)
        .map((l) => llmToIntent(l, text) as Extract<Intent, { kind: "create" }>);
      if (creates.length > 0) {
        return handleCreates(creates);
      }
      // 其余情况取第一个动作。
      intent = llmResults.length > 0 ? llmToIntent(llmResults[0], text) : parseIntent(text);
    } else {
      intent = parseIntent(text);
    }
  }

  switch (intent.kind) {
    case "create": {
      const result = createTask(intent.title, intent.priority, intent.effort, intent.due);
      if (result.status === "empty") return "你想让我记下什么任务呢？";
      if (result.status === "too-long") return "这条任务太长了（超过 200 字），能说简短一点吗？";
      if (result.status === "duplicate") return `「${result.title}」已经记过了哦，不用重复提醒。`;
      return `好的，已记下「${result.title}」。${result.detail}`;
    }

    case "list":
      return renderList(intent.filter);

    case "clear": {
      const count = tasks.list().length;
      if (count === 0) {
        pendingClear = false;
        return "你的清单本来就是空的，没有什么需要清空。";
      }
      pendingClear = true;
      return `你当前有 ${count} 条任务，确定要全部清空吗？回复「确定」我就清空，回复别的就取消。`;
    }

    case "complete": {
      const target = findTask(intent.query);
      if (!target)
        return `我没找到「${intent.query}」这条任务，你可以先问我「有哪些任务？」确认一下。`;
      if (target.done) return `「${target.title}」之前就已经完成了。`;
      tasks.update(target.id, { done: true });
      return `已把「${target.title}」标记为已完成。`;
    }

    case "uncomplete": {
      const target = findTask(intent.query);
      if (!target) return `我没找到「${intent.query}」这条任务。`;
      if (!target.done) return `「${target.title}」本来就是待办状态。`;
      tasks.update(target.id, { done: false });
      return `已把「${target.title}」恢复为待办。`;
    }

    case "delete": {
      const target = findTask(intent.query);
      if (!target) return `我没找到「${intent.query}」这条任务，可能已经删过了。`;
      tasks.remove(target.id);
      return `已删除「${target.title}」。`;
    }

    case "set-priority": {
      const target = findTask(intent.query);
      if (!target) return `我没找到「${intent.query}」这条任务。`;
      tasks.update(target.id, { priority: intent.priority });
      return `已把「${target.title}」设为${intent.priority}优先级。`;
    }

    case "set-effort": {
      const target = findTask(intent.query);
      if (!target) return `我没找到「${intent.query}」这条任务。`;
      tasks.update(target.id, { effort: intent.effort });
      return `已把「${target.title}」的工作量标记为${intent.effort}。`;
    }

    case "set-due": {
      const target = findTask(intent.query);
      if (!target) return `我没找到「${intent.query}」这条任务。`;
      tasks.update(target.id, { due: intent.due });
      return `已把「${target.title}」的到期时间设为 ${intent.due}。`;
    }

    case "unknown":
      return "我没有完全理解你的意思。你可以试试：「帮我记一下买牛奶」「我有哪些任务？」「牛奶买好了」「取快递这条删掉吧」，也可以说「买牛奶设为高优先级」「取快递明天到期」。";
  }
}

function llmToIntent(llm: LlmIntent, fallbackText: string): Intent {
  switch (llm.action) {
    case "create":
      return llm.title
        ? {
            kind: "create",
            title: llm.title,
            priority: llm.priority,
            effort: llm.effort,
            due: llm.due,
          }
        : parseIntent(fallbackText);
    case "list":
      return { kind: "list" };
    case "complete":
      return { kind: "complete", query: llm.query ?? "" };
    case "delete":
      return { kind: "delete", query: llm.query ?? "" };
    case "set_priority":
      return { kind: "set-priority", query: llm.query ?? "", priority: llm.priority ?? "中" };
    case "set_effort":
      return { kind: "set-effort", query: llm.query ?? "", effort: llm.effort ?? "小" };
    case "set_due":
      return llm.due
        ? { kind: "set-due", query: llm.query ?? "", due: llm.due }
        : parseIntent(fallbackText);
    default:
      return parseIntent(fallbackText);
  }
}

// 一句话拆出多个任务时，逐个记下并汇总回复。
function handleCreates(creates: Array<Extract<Intent, { kind: "create" }>>): string {
  const done: string[] = [];
  const duplicates: string[] = [];
  for (const c of creates) {
    const result = createTask(c.title, c.priority, c.effort, c.due);
    if (result.status === "created") done.push(result.title);
    else if (result.status === "duplicate") duplicates.push(result.title);
  }
  const parts: string[] = [];
  if (done.length > 0) parts.push(`好的，已记下：${done.map((t) => `「${t}」`).join("、")}。`);
  if (duplicates.length > 0) parts.push(`其中 ${duplicates.map((t) => `「${t}」`).join("、")} 已经记过了，未重复添加。`);
  if (parts.length === 0) return "你想让我记下什么任务呢？";
  return parts.join(" ");
}
