import { useEffect, useRef } from "react";
import type { ChatMessage } from "../shared/chat.ts";

const examplePrompts = ["提醒我买牛奶", "看看我的待办"];

// 优先级标记 → 对应颜色等级，用于给任务行上色。
const priorityClass: Record<string, string> = {
  高: "prio-high",
  中: "prio-mid",
  低: "prio-low",
};

// 把一行文本拆成「优先级标记」和「其余文字」，识别不到标记时整行按普通文本处理。
function renderLine(line: string) {
  const match = line.match(/〔(高|中|低)〕/);
  if (!match) return <span key={line}>{line}</span>;
  const cls = priorityClass[match[1]];
  const [before, after] = line.split(match[0]);
  return (
    <span key={line} className={cls}>
      {before}
      <strong className="prio-tag">{match[1]}优先</strong>
      {after}
    </span>
  );
}

interface ChatHistoryProps {
  messages: ChatMessage[];
  pending: boolean;
  onSelectPrompt: (prompt: string) => void;
}

export function ChatHistory({ messages, pending, onSelectPrompt }: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messages, pending]);

  return (
    <div className="scroll" ref={viewport}>
      {messages.length === 0 ? (
        <section className="welcome">
          <img src="/logo.png" alt="" />
          <h1>小明智能体</h1>
          <p>今天有什么待办？</p>
          <div className="examples">
            {examplePrompts.map((prompt) => (
              <button key={prompt} onClick={() => onSelectPrompt(prompt)}>
                {prompt}
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div className="thread" role="log" aria-label="对话记录" aria-live="polite">
          {messages.map((message, index) => (
            <div key={index} className={`message ${message.role}`}>
              <small>{message.role === "user" ? "你" : "小明智能体"}</small>
              <div className="content">
                {message.content.split("\n").map((line) => renderLine(line))}
              </div>
            </div>
          ))}
          {pending && <p role="status">正在回复…</p>}
        </div>
      )}
    </div>
  );
}
