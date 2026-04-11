import { resolveTemplate } from "../config/templates.js";
import type { HttpRequestSchema } from "../config/schema.js";
import type { z } from "zod";

export interface HttpExecutorOptions {
  timeoutMs?: number;
  retries?: number;
}

export type HttpRequestConfig = z.infer<typeof HttpRequestSchema>;

export type HttpExecutorResult =
  | { error: false; status: number; data: unknown; headers: Record<string, string> }
  | { error: true; status?: number; message: string };

/**
 * HTTP step executor using native fetch.
 */
export class HttpExecutor {
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: HttpExecutorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retries = options.retries ?? 0;
  }

  /**
   * Execute an HTTP request step.
   */
  async execute(
    request: HttpRequestConfig,
    scope: Record<string, unknown>,
    stepNumber?: number,
  ): Promise<HttpExecutorResult> {
    const maxAttempts = this.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const resolved = resolveTemplate(request, scope, stepNumber);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(resolved.url, {
          method: resolved.method,
          headers: resolved.headers,
          body:
            resolved.body === undefined
              ? undefined
              : JSON.stringify(resolved.body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const text = await response.text();
        let data: unknown = text;
        if (text.length > 0) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }

        if (!response.ok) {
          const failure = {
            error: true as const,
            status: response.status,
            message: `HTTP ${response.status}: ${response.statusText}`,
          };
          // 4xx client errors will not resolve on retry — fail immediately.
          if (response.status < 500 || attempt >= maxAttempts) {
            return failure;
          }
          continue;
        }

        return {
          error: false,
          status: response.status,
          data,
          headers,
        };
      } catch (error) {
        if (attempt >= maxAttempts) {
          return {
            error: true,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    return { error: true, message: "HTTP execution failed" };
  }
}
