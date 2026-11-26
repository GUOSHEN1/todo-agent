import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// 任务标题与完成状态由 API 校验，其余扩展字段（优先级、工作量、到期时间）由
// 智能体负责读写。looseObject 会保留未知字段，保证向后兼容。
export const priorityLevels = ["高", "中", "低"] as const;
export const effortLevels = ["大", "中", "小"] as const;
export type Priority = (typeof priorityLevels)[number];
export type Effort = (typeof effortLevels)[number];

// 存储层只校验核心字段；扩展字段原样保留（可为任意类型），由智能体层按需读取。
const storedTask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});
const taskList = z.array(storedTask);

// 智能体视角的任务类型：扩展字段为可选、弱类型（宽松读取）。
export interface Task {
  id: string;
  title: string;
  done: boolean;
  priority?: Priority;
  effort?: Effort;
  due?: string;
  [key: string]: unknown;
}

export type TaskChanges = Partial<Pick<Task, "title" | "done" | "priority" | "effort" | "due">>;

export interface TaskStore {
  list(): Task[];
  create(title: string): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
  clear(): void;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title) {
      const task = { id: randomUUID(), title, done: false };
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, changes);
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },

    clear() {
      save([]);
    },
  };
}
