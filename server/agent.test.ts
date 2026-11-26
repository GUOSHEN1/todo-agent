import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { reply, setTaskStore } from "./agent.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

async function makeAgent(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store: TaskStore = createJsonTaskStore(join(directory, "tasks.json"));
  setTaskStore(store);

  async function say(user: string, history: ChatMessage[]): Promise<ChatMessage[]> {
    const next: ChatMessage[] = [...history, { role: "user", content: user }];
    const answer = await reply(next);
    next.push({ role: "assistant", content: answer });
    return next;
  }

  return { store, say };
}

test("验收对话：创建、查看、完成、删除", async (t) => {
  const { store, say } = await makeAgent(t);

  let history: ChatMessage[] = [];
  history = await say("帮我记一下买牛奶", history);
  assert.deepEqual(store.list(), [{ id: store.list()[0].id, title: "买牛奶", done: false }]);

  history = await say("再记一条取快递", history);
  assert.equal(store.list().length, 2);
  assert.deepEqual(
    store.list().map((x) => x.title),
    ["买牛奶", "取快递"],
  );

  history = await say("我有哪些任务？", history);
  const listReply = history.at(-1)!.content;
  assert.ok(listReply.includes("买牛奶") && listReply.includes("取快递"));

  history = await say("牛奶买好了", history);
  const milk = store.list().find((x) => x.title === "买牛奶");
  const express = store.list().find((x) => x.title === "取快递");
  assert.equal(milk!.done, true);
  assert.equal(express!.done, false);

  history = await say("取快递这条删掉吧", history);
  assert.deepEqual(
    store.list().map((x) => x.title),
    ["买牛奶"],
  );

  history = await say("再给我看看清单", history);
  const finalReply = history.at(-1)!.content;
  assert.ok(finalReply.includes("买牛奶"));
  assert.ok(!finalReply.includes("取快递"));
});

test("空清单时友好提示", async (t) => {
  const { say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("我有哪些任务？", history);
  assert.ok(history.at(-1)!.content.includes("还没有任何待办"));
});

test("找不到任务时给出提示", async (t) => {
  const { say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("牛奶买好了", history);
  assert.ok(history.at(-1)!.content.includes("没找到"));
});

test("扩展：设置优先级", async (t) => {
  const { store, say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下写周报", history);
  history = await say("写周报设为高优先级", history);
  assert.equal(store.list()[0].priority, "高");
  assert.ok(history.at(-1)!.content.includes("高"));
});

test("扩展：设置工作量", async (t) => {
  const { store, say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下整理文档", history);
  history = await say("整理文档工作量大", history);
  assert.equal(store.list()[0].effort, "大");
});

test("扩展：设置到期时间（明天）", async (t) => {
  const { store, say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下取快递", history);
  history = await say("取快递明天到期", history);
  const due = store.list()[0].due;
  assert.ok(due, "应有到期时间");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expected = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  assert.equal(due, expected);
});

test("扩展：今天到期查询", async (t) => {
  const { store, say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下买菜", history);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  store.update(store.list()[0].id, { due: todayStr });
  history = await say("今天有哪些任务到期？", history);
  assert.ok(history.at(-1)!.content.includes("买菜"));
});

test("边界：打招呼得到友好回应", async (t) => {
  const { say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("你好", history);
  const reply = history.at(-1)!.content;
  assert.ok(reply.includes("你好") && !reply.includes("我没有完全理解"));
});

test("边界：只说「帮我记一下」不误建空任务", async (t) => {
  const { store, say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下", history);
  assert.equal(store.list().length, 0);
  assert.ok(history.at(-1)!.content.includes("记下什么"));
});

test("边界：超长标题友好提示", async (t) => {
  const { store, say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下" + "啊".repeat(250), history);
  assert.equal(store.list().length, 0);
  assert.ok(history.at(-1)!.content.includes("太长"));
});

test("边界：标记已完成的任务提示重复", async (t) => {
  const { say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下买牛奶", history);
  history = await say("牛奶买好了", history);
  history = await say("牛奶买好了", history);
  assert.ok(history.at(-1)!.content.includes("已经完成"));
});

test("边界：重复记同名待办任务只提醒不新增", async (t) => {
  const { store, say } = await makeAgent(t);
  let history: ChatMessage[] = [];
  history = await say("帮我记一下买牛奶", history);
  history = await say("帮我记一下买牛奶", history);
  assert.equal(store.list().length, 1);
  assert.ok(history.at(-1)!.content.includes("已经记过"));
});
