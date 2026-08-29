import type * as acp from "@agentclientprotocol/sdk";

export type ConnectionState =
  | "disconnected"
  | "workspace_required"
  | "starting"
  | "connected"
  | "running"
  | "stopping"
  | "error";

/** Grok CLI `--permission-mode` values (see `grok agent --help`). */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "plan";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
];

/** Legacy UI / layout values → CLI mode */
export function normalizePermissionMode(mode?: string | null): PermissionMode {
  const raw = String(mode || "default").trim();
  const aliases: Record<string, PermissionMode> = {
    ask: "default",
    full: "bypassPermissions",
    bypass: "bypassPermissions",
    "full-access": "bypassPermissions",
    "dont-ask": "dontAsk",
    "accept-edits": "acceptEdits",
  };
  const mapped = aliases[raw] || (raw as PermissionMode);
  return (PERMISSION_MODES as string[]).includes(mapped) ? mapped : "default";
}

export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number] | "";

export interface ToolLocation {
  path: string;
  line?: number;
}

export interface ToolDiff {
  path: string;
  oldText?: string;
  newText: string;
}

export interface PromptAttachment {
  uri: string;
  name: string;
  /** MIME type for image attachments. */
  mimeType?: string;
  /** Base64 payload for image attachments. */
  data?: string;
}

export interface SessionConfigChoice {
  value: string;
  name: string;
  description?: string;
}

export interface SessionConfigControl {
  id: string;
  name: string;
  type: "select" | "boolean";
  category?: string;
  description?: string;
  currentValue: string | boolean;
  options?: SessionConfigChoice[];
}

export type GrokEvent =
  | { type: "state"; state: ConnectionState; detail?: string }
  | {
      type: "context";
      workspaceName: string;
      model: string;
      reasoningEffort: string;
      showReasoning: boolean;
      permissionMode: PermissionMode;
      allowOutsideWorkspace: boolean;
      followAgentFiles: boolean;
      openDiffOnEdit: boolean;
      showToolDetails: boolean;
      voiceInput: boolean;
      sandbox: string;
      experimentalMemory: boolean;
      enableTerminal: boolean;
    }
  | {
      type: "runtime";
      protocolVersion: number;
      agentName: string;
      agentVersion: string;
    }
  | { type: "session"; sessionId: string; title?: string; resumed?: boolean }
  | { type: "clear_conversation"; reason: "new_session" | "manual" | "resume" }
  | {
      type: "model_catalog";
      currentModel: string;
      defaultModel?: string;
      models: string[];
    }
  | {
      type: "session_config";
      options: SessionConfigControl[];
    }
  | {
      type: "session_modes";
      currentModeId: string;
      modes: Array<{ id: string; name: string; description?: string }>;
    }
  | { type: "current_mode"; currentModeId: string }
  | {
      type: "usage";
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
    }
  | {
      type: "token_usage";
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      thoughtTokens?: number;
    }
  | {
      type: "attachment_added";
      uri: string;
      name: string;
      mimeType?: string;
      data?: string;
    }
  | { type: "assistant_delta"; text: string; messageId?: string }
  | { type: "thought_delta"; text: string; messageId?: string }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      status: string;
      kind?: string;
      locations?: ToolLocation[];
      diffs?: ToolDiff[];
      /** Plain text / terminal snippets from tool content */
      detail?: string;
    }
  | {
      type: "tool_update";
      toolCallId: string;
      title?: string;
      status?: string;
      kind?: string;
      locations?: ToolLocation[];
      diffs?: ToolDiff[];
      detail?: string;
    }
  | {
      type: "permission_request";
      requestId: string;
      toolCallId: string;
      title: string;
      kind?: string;
      locations?: ToolLocation[];
      hookAsk?: boolean;
      hookName?: string;
      reason?: string;
      additionalContext?: string;
      meta?: unknown;
      options: Array<{
        optionId: string;
        name: string;
        kind: string;
      }>;
    }
  | {
      type: "permission_resolved";
      requestId: string;
      optionId?: string;
      automatic: boolean;
      cancelled?: boolean;
    }
  | {
      type: "workspace_edit";
      changeId: string;
      path: string;
      source: "acp_diff" | "filesystem";
    }
  | {
      type: "plan";
      entries: Array<{ content: string; status: string; priority?: string }>;
    }
  | { type: "turn_complete"; stopReason: string }
  | { type: "diagnostic"; message: string }
  | { type: "error"; message: string }
  | { type: "cli_status"; available: boolean; detail: string };

export interface GrokHost {
  requestPermission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse>;
  readTextFile(
    request: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse>;
  writeTextFile(
    request: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse>;
  selectAuthMethod(methods: acp.AuthMethod[]): Promise<acp.AuthMethod | undefined>;
  createTerminal?(
    request: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse>;
  terminalOutput?(
    request: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse>;
  releaseTerminal?(request: acp.ReleaseTerminalRequest): Promise<void>;
  waitForTerminalExit?(
    request: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse>;
  killTerminal?(request: acp.KillTerminalRequest): Promise<void>;
}

export interface GrokClientOptions {
  executable: string;
  arguments?: string[];
  cwd: string;
  additionalDirectories?: string[];
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  enableTerminal?: boolean;
  resumeSessionId?: string;
  /** Applied on session/new and session/load (Grok CLI 1.0.5+). */
  reasoningEffort?: string;
  /** Applied on session/new and session/load so the CLI process and session agree. */
  permissionMode?: string;
  mcpServers?: acp.McpServer[];
}
