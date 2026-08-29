import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { terminateProcessTree } from "./processTree.js";
import { sessionRequestMeta } from "./sessionMeta.js";
import { normalizeConfigOptions, normalizeSessionUpdate } from "./sessionUpdates.js";
import type {
  ConnectionState,
  GrokClientOptions,
  GrokEvent,
  GrokHost,
  PromptAttachment,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LIMIT = 8_000;

export class GrokClient {
  private readonly events = new EventEmitter();
  private process: ChildProcessWithoutNullStreams | undefined;
  private connection: acp.ClientSideConnection | undefined;
  private currentSessionId: string | undefined;
  private state: ConnectionState = "disconnected";
  private stderrTail = "";
  private stopping = false;
  private agentSupportsLoadSession = false;

  constructor(
    private readonly options: GrokClientOptions,
    private readonly host: GrokHost,
  ) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  onEvent(listener: (event: GrokEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.stopping = false;
    this.stderrTail = "";
    this.setState("starting", `Launching ${this.options.executable}`);

    const launchArgs = [...(this.options.arguments ?? [])];
    if (this.options.resumeSessionId) {
      launchArgs.push("--resume", this.options.resumeSessionId);
    }

    const child = spawn(
      this.options.executable,
      [...launchArgs, "agent", "stdio"],
      {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.environment },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      },
    );
    this.process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.once("exit", (code, signal) => {
      this.process = undefined;
      this.connection = undefined;
      this.currentSessionId = undefined;
      if (!this.stopping) {
        const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        this.setState("error", `Grok Build exited with ${suffix}`);
      }
    });

    try {
      await this.waitForSpawn(child);
      const input = Writable.toWeb(
        child.stdin,
      ) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(
        child.stdout,
      ) as ReadableStream<Uint8Array>;

      const enableTerminal = Boolean(this.options.enableTerminal && this.host.createTerminal);
      this.connection = new acp.ClientSideConnection(
        () => ({
          requestPermission: (request) => this.host.requestPermission(request),
          sessionUpdate: async (notification) => {
            const event = normalizeSessionUpdate(notification);
            if (event) {
              this.emit(event);
            }
          },
          readTextFile: (request) => this.host.readTextFile(request),
          writeTextFile: (request) => this.host.writeTextFile(request),
          ...(enableTerminal
            ? {
                createTerminal: (request: acp.CreateTerminalRequest) =>
                  this.host.createTerminal!(request),
                terminalOutput: (request: acp.TerminalOutputRequest) =>
                  this.host.terminalOutput!(request),
                releaseTerminal: (request: acp.ReleaseTerminalRequest) =>
                  this.host.releaseTerminal!(request),
                waitForTerminalExit: (request: acp.WaitForTerminalExitRequest) =>
                  this.host.waitForTerminalExit!(request),
                killTerminal: (request: acp.KillTerminalRequest) =>
                  this.host.killTerminal!(request),
              }
            : {}),
        }),
        acp.ndJsonStream(input, output),
      );

      const initializeResponse = await this.withTimeout(
        this.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: enableTerminal,
            session: { configOptions: { boolean: {} } },
            plan: {},
          },
          clientInfo: {
            name: "grok-build-desktop",
            title: "Grok Build",
            version: "0.1.0",
          },
          _meta: {
            startupHints: {
              nonInteractive: false,
              skipGitStatus: false,
              skipProjectLayout: false,
            },
            clientType: "desktop",
          },
        }),
        "initialize",
      );

      this.agentSupportsLoadSession = Boolean(
        initializeResponse.agentCapabilities?.loadSession,
      );

      this.emit({
        type: "runtime",
        protocolVersion: initializeResponse.protocolVersion,
        agentName: initializeResponse.agentInfo?.name ?? "Grok Build",
        agentVersion: initializeResponse.agentInfo?.version ?? "",
      });

      await this.createSessionWithAuthRetry(initializeResponse.authMethods ?? []);
      this.setState("connected", "Ready");
    } catch (error) {
      const message = this.describeError(error);
      await this.stopProcess();
      this.setState("error", message);
      this.emit({ type: "error", message });
      throw error;
    }
  }

  setReasoningEffort(effort?: string | null): void {
    this.options.reasoningEffort = effort ? String(effort) : "";
  }

  async newSession(): Promise<void> {
    const connection = this.requireConnection();
    if (this.state === "running") {
      await this.cancel();
    }
    const response = await this.withTimeout(
      connection.newSession({
        cwd: this.options.cwd,
        mcpServers: this.options.mcpServers ?? [],
        ...(this.options.additionalDirectories?.length
          ? { additionalDirectories: this.options.additionalDirectories }
          : {}),
        ...this.sessionOpenFields(),
      }),
      "session/new",
    );
    this.currentSessionId = response.sessionId;
    this.emit({ type: "clear_conversation", reason: "new_session" });
    this.emit({ type: "session", sessionId: response.sessionId });
    this.emit(normalizeConfigOptions(response.configOptions));
    if (response.modes) {
      this.emit({
        type: "session_modes",
        currentModeId: response.modes.currentModeId,
        modes: response.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      });
    }
    this.setState("connected", "Ready");
  }

  async loadSession(sessionId: string): Promise<void> {
    const connection = this.requireConnection();
    if (this.state === "running") {
      await this.cancel();
    }
    if (!this.agentSupportsLoadSession) {
      throw new Error(
        "This Grok Build agent does not advertise session/load. Use Resume via CLI flag instead.",
      );
    }
    const response = await this.withTimeout(
      connection.loadSession({
        sessionId,
        cwd: this.options.cwd,
        mcpServers: this.options.mcpServers ?? [],
        ...(this.options.additionalDirectories?.length
          ? { additionalDirectories: this.options.additionalDirectories }
          : {}),
        ...this.sessionOpenFields(),
      }),
      "session/load",
    );
    this.currentSessionId = sessionId;
    // Desktop reloads transcript from disk; do not wipe UI here.
    this.emit({
      type: "session",
      sessionId,
      resumed: true,
    });
    if (response.configOptions) {
      this.emit(normalizeConfigOptions(response.configOptions));
    }
    if (response.modes) {
      this.emit({
        type: "session_modes",
        currentModeId: response.modes.currentModeId,
        modes: response.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      });
    }
    // Do not surface raw session UUIDs in UI status — they are internal IDs only.
    this.setState("connected", "Chat resumed");
  }

  async prompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }
    if (this.state === "running") {
      throw new Error("A Grok Build turn is already running.");
    }

    this.setState("running", "Grok Build is working");
    try {
      const promptBlocks: acp.ContentBlock[] = [
        ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
        ...attachments.map((attachment) => {
          if (attachment.data && attachment.mimeType) {
            return {
              type: "image" as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
              uri: attachment.uri,
            };
          }
          return {
            type: "resource_link" as const,
            uri: attachment.uri,
            name: attachment.name,
          };
        }),
      ];
      const result = await connection.prompt({
        sessionId,
        prompt: promptBlocks,
      });
      if (result.usage) {
        this.emit({
          type: "token_usage",
          totalTokens: result.usage.totalTokens,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...(result.usage.thoughtTokens !== undefined && result.usage.thoughtTokens !== null
            ? { thoughtTokens: result.usage.thoughtTokens }
            : {}),
        });
      }
      this.emit({ type: "turn_complete", stopReason: result.stopReason });
      this.setState("connected", `Turn completed: ${result.stopReason}`);
    } catch (error) {
      const message = this.describeError(error);
      this.emit({ type: "error", message });
      this.setState("connected", "Turn failed; session remains connected");
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      return;
    }
    await this.withTimeout(this.connection.cancel({ sessionId: this.currentSessionId }), "session/cancel");
  }

  async setSessionMode(modeId: string): Promise<void> {
    await this.requireConnection().setSessionMode({
      sessionId: this.requireSession(),
      modeId,
    });
    this.emit({ type: "current_mode", currentModeId: modeId });
  }

  async setSessionConfigOption(
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    const request: acp.SetSessionConfigOptionRequest =
      typeof value === "boolean"
        ? { sessionId, configId, type: "boolean", value }
        : { sessionId, configId, value };
    const response = await connection.setSessionConfigOption(request);
    this.emit(normalizeConfigOptions(response.configOptions));
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.setState("disconnected", "Not connected");
      return;
    }
    this.setState("stopping", "Stopping Grok Build");
    await this.stopProcess();
    this.setState("disconnected", "Disconnected");
  }

  private async openSessionAfterAuth(): Promise<void> {
    const resumeId = this.options.resumeSessionId;
    if (!resumeId) {
      await this.newSession();
      return;
    }
    // Prefer ACP session/load. Never silently open a *new* session when resuming —
    // that duplicated empty chats in the desktop history UI.
    try {
      await this.loadSession(resumeId);
      return;
    } catch (err) {
      // Capability missing or load failed: still bind to resume id (--resume on process).
      // Do NOT call newSession() here.
      this.currentSessionId = resumeId;
      this.emit({
        type: "session",
        sessionId: resumeId,
        resumed: true,
      });
      // Session bound via process --resume; keep status human-readable
      this.setState("connected", "Chat resumed");
    }
  }

  private async createSessionWithAuthRetry(
    authMethods: acp.AuthMethod[],
  ): Promise<void> {
    try {
      await this.openSessionAfterAuth();
    } catch (error) {
      if (!this.isAuthenticationError(error) || authMethods.length === 0) {
        throw error;
      }
      const method = await this.host.selectAuthMethod(authMethods);
      if (!method) {
        throw new Error("Authentication was cancelled.");
      }
      await this.withTimeout(
        this.requireConnection().authenticate({
          methodId: method.id,
          _meta: { headless: false },
        }),
        "authenticate",
        120_000,
      );
      await this.openSessionAfterAuth();
    }
  }

  private async waitForSpawn(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    await this.withTimeout(
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      "process start",
      10_000,
    );
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    this.stopping = true;
    this.connection = undefined;
    this.currentSessionId = undefined;
    if (!child) {
      return;
    }

    child.stdin.end();
    await terminateProcessTree(child, false);
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await terminateProcessTree(child, true);
    this.process = undefined;
  }

  /** Grok CLI 1.0.5+ reads open-session settings from session/new and session/load `_meta`. */
  private sessionOpenFields(): { _meta?: Record<string, unknown> } {
    const meta = sessionRequestMeta({
      reasoningEffort: this.options.reasoningEffort,
      permissionMode: this.options.permissionMode,
    });
    return meta ? { _meta: meta } : {};
  }

  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) {
      throw new Error("Grok Build is not connected.");
    }
    return this.connection;
  }

  private requireSession(): string {
    if (!this.currentSessionId) {
      throw new Error("No Grok Build session is active.");
    }
    return this.currentSessionId;
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    this.emit({ type: "state", state, ...(detail ? { detail } : {}) });
  }

  private emit(event: GrokEvent): void {
    this.events.emit("event", event);
  }

  private isAuthenticationError(error: unknown): boolean {
    return /auth(?:entication)?[_ -]?required|not authenticated/i.test(
      this.describeError(error),
    );
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found/i.test(message)) {
      return `Cannot start '${this.options.executable}'. Install the Grok CLI (irm https://x.ai/cli/install.ps1 | iex) or set GROK_EXECUTABLE.`;
    }
    const stderr = this.stderrTail.trim();
    return stderr ? `${message}\n${stderr.slice(-1_500)}` : message;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    operation: string,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${operation} timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
