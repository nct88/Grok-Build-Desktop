import type * as acp from "@agentclientprotocol/sdk";
import type { GrokEvent } from "./types.js";

function textFromContent(content: acp.ContentBlock): string | undefined {
  return content.type === "text" ? content.text : undefined;
}

function locationsFromUpdate(
  locations: acp.ToolCallLocation[] | null | undefined,
): Array<{ path: string; line?: number }> | undefined {
  if (!locations?.length) {
    return undefined;
  }
  return locations.map((location) => ({
    path: location.path,
    ...(location.line !== undefined && location.line !== null
      ? { line: location.line }
      : {}),
  }));
}

function diffsFromContent(
  content: acp.ToolCallContent[] | null | undefined,
): Array<{ path: string; oldText?: string; newText: string }> | undefined {
  const diffs = (content ?? [])
    .filter((item): item is Extract<acp.ToolCallContent, { type: "diff" }> => item.type === "diff")
    .map((item) => ({
      path: item.path,
      ...(item.oldText !== undefined && item.oldText !== null ? { oldText: item.oldText } : {}),
      newText: item.newText,
    }));
  return diffs.length ? diffs : undefined;
}

/** Plain text / terminal snippets from tool content (for expandable CLI-like detail). */
function textDetailFromContent(
  content: acp.ToolCallContent[] | null | undefined,
): string | undefined {
  if (!content?.length) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content" && item.content?.type === "text" && item.content.text) {
      parts.push(item.content.text);
    } else if (item.type === "terminal" && "terminalId" in item) {
      parts.push(`[terminal ${item.terminalId}]`);
    }
  }
  const joined = parts.join("\n").trim();
  return joined ? joined.slice(0, 4000) : undefined;
}

export function normalizeConfigOptions(
  options: acp.SessionConfigOption[] | null | undefined,
): Extract<GrokEvent, { type: "session_config" }> {
  return {
    type: "session_config",
    options: (options ?? []).map((option) => {
      const base = {
        id: option.id,
        name: option.name,
        type: option.type,
        ...(option.category ? { category: option.category } : {}),
        ...(option.description ? { description: option.description } : {}),
        currentValue: option.currentValue,
      };
      if (option.type === "boolean") {
        return base;
      }
      const choices = option.options.flatMap((entry) =>
        "options" in entry ? entry.options : [entry],
      );
      return {
        ...base,
        options: choices.map((choice) => {
          const marked = choice as { default?: boolean };
          return {
            value: choice.value,
            name: choice.name,
            ...(choice.description ? { description: choice.description } : {}),
            ...(marked.default ? { default: true } : {}),
          };
        }),
      };
    }),
  };
}

export function normalizeSessionUpdate(
  notification: acp.SessionNotification,
): GrokEvent | undefined {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      return text === undefined
        ? undefined
        : {
            type: "assistant_delta",
            text,
            ...(update.messageId ? { messageId: update.messageId } : {}),
          };
    }
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      return text === undefined
        ? undefined
        : {
            type: "thought_delta",
            text,
            ...(update.messageId ? { messageId: update.messageId } : {}),
          };
    }
    case "tool_call": {
      const locations = locationsFromUpdate(update.locations);
      const diffs = diffsFromContent(update.content);
      const detail = textDetailFromContent(update.content);
      return {
        type: "tool",
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status ?? "pending",
        ...(update.kind ? { kind: update.kind } : {}),
        ...(locations ? { locations } : {}),
        ...(diffs ? { diffs } : {}),
        ...(detail ? { detail } : {}),
      };
    }
    case "tool_call_update": {
      const locations = locationsFromUpdate(update.locations);
      const diffs = diffsFromContent(update.content);
      const detail = textDetailFromContent(update.content);
      return {
        type: "tool_update",
        toolCallId: update.toolCallId,
        ...(update.title ? { title: update.title } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        ...(locations ? { locations } : {}),
        ...(diffs ? { diffs } : {}),
        ...(detail ? { detail } : {}),
      };
    }
    case "plan":
      return {
        type: "plan",
        entries: update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
          ...(entry.priority ? { priority: entry.priority } : {}),
        })),
      };
    case "config_option_update":
      return normalizeConfigOptions(update.configOptions);
    case "current_mode_update":
      return { type: "current_mode", currentModeId: update.currentModeId };
    case "usage_update":
      return {
        type: "usage",
        used: update.used,
        size: update.size,
        ...(update.cost
          ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
          : {}),
      };
    default:
      return undefined;
  }
}
