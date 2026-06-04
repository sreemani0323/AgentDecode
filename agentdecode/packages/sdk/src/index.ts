export interface AgentDecodeConfig {
  apiKey: string;
  endpoint?: string;
  projectId: string;
}

export interface Span {
  name: string;
  type: 'llm' | 'tool' | 'retrieval' | 'agent' | 'chain';
  status?: 'success' | 'error';
  duration_ms?: number;
  input?: any;
  output?: any;
  tokens_prompt?: number;
  tokens_completion?: number;
  cost_usd?: number;
  error_msg?: string;
  error_stack?: string;
  model?: string;
}

export class AgentDecode {
  private config: Required<AgentDecodeConfig>;

  constructor(config: AgentDecodeConfig) {
    this.config = {
      apiKey: config.apiKey,
      endpoint: config.endpoint || 'https://agentdecode.dev/api/ingest',
      projectId: config.projectId,
    };
  }

  public async ingestSpans(sessionId: string, spans: Span[]): Promise<void> {
    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_id: this.config.projectId,
          session_id: sessionId,
          spans,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ingest API returned ${response.status}: ${errText}`);
      }
    } catch (err) {
      console.error('[AgentDecode] Failed to ingest spans:', err);
      throw err;
    }
  }

  public trace<TArgs extends any[], TReturn>(
    name: string,
    options: Omit<Span, 'name' | 'duration_ms' | 'status' | 'input' | 'output'>,
    fn: (...args: TArgs) => Promise<TReturn>
  ) {
    return async (sessionId: string, ...args: TArgs): Promise<TReturn> => {
      const startMs = Date.now();
      const started_at = new Date(startMs).toISOString();
      let status: 'ok' | 'error' = 'ok';
      let error_message: string | undefined;
      let error_stack: string | undefined;
      let output: any;

      try {
        output = await fn(...args);
        return output;
      } catch (err: any) {
        status = 'error';
        error_message = err?.message || String(err);
        error_stack = err?.stack;
        throw err;
      } finally {
        const endMs = Date.now();
        const duration_ms = endMs - startMs;
        const ended_at = new Date(endMs).toISOString();
        const { type, ...restOptions } = options as any;
        const span: any = {
          name,
          ...restOptions,
          span_type: type,
          status,
          started_at,
          ended_at,
          duration_ms,
          input: args.length > 1 ? args : args[0],
          output: status === 'ok' ? output : undefined,
          error_message,
          error_stack,
        };

        // Fire and forget
        this.ingestSpans(sessionId, [span]).catch((err) => {
          console.error('[AgentDecode SDK Error]', err)
        });
      }
    };
  }
}
