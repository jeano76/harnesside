import { spawn, ChildProcess } from "node:child_process";
import { OpenAICompatibleClient } from "./openaiClient.js";

export interface LlamaServerConfig {
  /** Path to the llama-server binary. */
  binPath: string;
  /** Path to the .gguf model file. */
  modelPath: string;
  host: string;
  port: number;
  contextSize: number;
  threads: number;
  gpuLayers: number;
}

/** 8GB RAM 환경 기본 프로파일: 과도한 ctx-size로 인한 OOM을 피하는 보수적 기본값. */
export const DEFAULT_8GB_PROFILE: Omit<LlamaServerConfig, "binPath" | "modelPath"> = {
  host: "127.0.0.1",
  port: 8081,
  contextSize: 8192,
  threads: 4,
  gpuLayers: 0,
};

/**
 * Manages a locally spawned `llama-server` subprocess and exposes it through
 * the same OpenAI-compatible client used for any remote backend. Callers
 * never talk HTTP or process management directly — go through this class.
 */
export class LlamaServerManager {
  private proc: ChildProcess | null = null;
  private spawnError: Error | null = null;

  constructor(private config: LlamaServerConfig) {}

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.proc = spawn(
      this.config.binPath,
      [
        "-m", this.config.modelPath,
        "--host", this.config.host,
        "--port", String(this.config.port),
        "-c", String(this.config.contextSize),
        "-t", String(this.config.threads),
        "-ngl", String(this.config.gpuLayers),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    // **`'error'` 를 반드시 받아야 한다.** 이 리스너가 없을 때 바이너리 경로가 틀리면
    // `spawn()` 은 예외 없이 끝난 뒤 약 1초 뒤에 uncaughtException 으로 **프로세스
    // 전체** 가 죽는다 (실측) — llama 못 뜬다고 TUI 까지 함께 사라진다. Node 는
    // ENOENT 를 동기 throw 가 아니라 비동기 이벤트로 보낸다.
    this.proc.on("error", (err: NodeJS.ErrnoException) => {
      this.spawnError = err;
      this.proc = null;
    });

    await this.waitUntilReady();
  }

  /**
   * 스폰 실패 원인. **null 과 "아직 시도하지 않았다" 를 구분한다** — 합치면 사용자는
   * "기다리는 중" 과 "경로가 틀렸다" 를 구분하지 못한다(§5.10).
   */
  get error(): Error | null {
    return this.spawnError;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  /** Connects to an already-running llama-server instead of spawning one. */
  static attachExisting(baseUrl: string): OpenAICompatibleClient {
    return new OpenAICompatibleClient(baseUrl);
  }

  client(): OpenAICompatibleClient {
    return new OpenAICompatibleClient(this.baseUrl);
  }

  private async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/models`);
        if (res.ok) return;
      } catch {
        // server not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    // **사람이 읽는 문장** 으로 말한다. 내부 영어 문자열은 사용자가 무엇을 해야 하는지
    // 알려주지 않는다(§11.3) — 바이너리가 없으면 그것을 먼저 단서로 제시한다.
    if (this.spawnError) {
      throw new Error(`llama-server 실행에 실패했습니다: ${this.spawnError.message}`);
    }
    throw new Error(`llama-server 가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다`);
  }
}
