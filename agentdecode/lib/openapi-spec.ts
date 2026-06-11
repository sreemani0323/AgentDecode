/**
 * OpenAPI 3.1 specification for the AgentDecode API.
 *
 * Auto-derived from the Next.js route handlers in app/api/.
 * Served at GET /api/docs.
 */
export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'AgentDecode API',
    version: '0.1.0',
    description:
      'AgentDecode is an observability platform for AI agents. It ingests LLM traces, evaluates span quality, surfaces errors as issues, and provides AI-powered failure explanations.',
  },
  servers: [{ url: '/' }],
  security: [{ BearerAuth: [] }],

  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'For most endpoints use a Supabase session JWT. For POST /api/ingest use a project API key.',
      },
    },

    schemas: {
      // ── Shared ────────────────────────────────────────────────────────
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
        required: ['error'],
      },

      // ── Health ────────────────────────────────────────────────────────
      CheckDetail: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
          latency_ms: { type: 'number' },
          message: { type: 'string' },
          details: { type: 'array', items: { type: 'string' } },
        },
        required: ['status'],
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
          version: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
          checks: {
            type: 'object',
            properties: {
              env: { $ref: '#/components/schemas/CheckDetail' },
              database: { $ref: '#/components/schemas/CheckDetail' },
            },
            required: ['env', 'database'],
          },
        },
        required: ['status', 'version', 'timestamp', 'checks'],
      },

      // ── Ingest ────────────────────────────────────────────────────────
      IngestSpan: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          span_type: { type: 'string', enum: ['llm', 'tool', 'chain', 'retriever', 'agent'], default: 'chain' },
          status: { type: 'string', enum: ['ok', 'error'], default: 'ok' },
          started_at: { type: 'string', format: 'date-time' },
          ended_at: { type: 'string', format: 'date-time' },
          duration_ms: { type: 'number' },
          parent_span_id: { type: 'string', format: 'uuid' },
          model: { type: 'string' },
          input: {},
          output: {},
          error_message: { type: 'string' },
          input_tokens: { type: 'integer' },
          output_tokens: { type: 'integer' },
          cost_usd: { type: 'number' },
          metadata: { type: 'object' },
        },
        required: ['name', 'started_at'],
      },
      IngestRequest: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Optional external session ID for grouping spans.' },
          session_name: { type: 'string', default: 'Unnamed Session' },
          spans: {
            type: 'array',
            items: { $ref: '#/components/schemas/IngestSpan' },
            minItems: 1,
          },
        },
        required: ['spans'],
      },
      IngestResponse: {
        type: 'object',
        properties: {
          session_id: { type: 'string', format: 'uuid' },
          span_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
          spans_ingested: { type: 'integer' },
        },
        required: ['session_id', 'span_ids', 'spans_ingested'],
      },

      // ── API Keys ──────────────────────────────────────────────────────
      ApiKey: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          key_prefix: { type: 'string' },
          name: { type: 'string' },
          last_used_at: { type: 'string', format: 'date-time', nullable: true },
          is_active: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ApiKeyCreated: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          key_prefix: { type: 'string' },
          name: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          key: { type: 'string', description: 'Full API key — shown only once.' },
        },
        required: ['id', 'key_prefix', 'created_at', 'key'],
      },

      // ── Projects ──────────────────────────────────────────────────────
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          org_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          session_count: { type: 'integer' },
          error_count: { type: 'integer' },
        },
      },
      ProjectDetail: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          org_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          stats: {
            type: 'object',
            properties: {
              total_sessions: { type: 'integer' },
              total_spans: { type: 'integer' },
              total_errors: { type: 'integer' },
              total_tokens: { type: 'integer' },
              total_cost_usd: { type: 'number' },
            },
          },
        },
      },

      // ── Sessions ──────────────────────────────────────────────────────
      EvalScore: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          score: { type: 'number' },
          reason: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AiExplanation: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          explanation: { type: 'string' },
          model_used: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      SpanTreeNode: {
        type: 'object',
        description: 'A span node with nested children forming a trace tree.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          session_id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          parent_span_id: { type: 'string', format: 'uuid', nullable: true },
          trace_id: { type: 'string', nullable: true },
          name: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          start_time: { type: 'string', format: 'date-time' },
          end_time: { type: 'string', format: 'date-time', nullable: true },
          duration_ms: { type: 'number', nullable: true },
          input: {},
          output: {},
          model: { type: 'string', nullable: true },
          tokens_in: { type: 'integer' },
          tokens_out: { type: 'integer' },
          cost_usd: { type: 'number' },
          error_message: { type: 'string', nullable: true },
          metadata: {},
          created_at: { type: 'string', format: 'date-time' },
          eval_scores: { type: 'array', items: { $ref: '#/components/schemas/EvalScore' } },
          ai_explanations: { type: 'array', items: { $ref: '#/components/schemas/AiExplanation' } },
          children: { type: 'array', items: { $ref: '#/components/schemas/SpanTreeNode' } },
        },
      },

      // ── Search ────────────────────────────────────────────────────────
      SearchResult: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['session', 'span', 'issue'] },
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          status: { type: 'string' },
          href: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
        },
      },

      // ── Organization ──────────────────────────────────────────────────
      Organization: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },

      // ── Profile ───────────────────────────────────────────────────────
      Profile: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          full_name: { type: 'string' },
          avatar_url: { type: 'string', nullable: true },
        },
      },

      // ── Invites / Members ─────────────────────────────────────────────
      OrgMember: {
        type: 'object',
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['owner', 'admin', 'member'] },
          full_name: { type: 'string' },
          avatar_url: { type: 'string', nullable: true },
        },
      },

      // ── Issues ────────────────────────────────────────────────────────
      Issue: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          error_fingerprint: { type: 'string' },
          status: { type: 'string', enum: ['open', 'resolved', 'ignored'] },
          occurrence_count: { type: 'integer' },
          first_seen_at: { type: 'string', format: 'date-time' },
          last_seen_at: { type: 'string', format: 'date-time' },
        },
      },

      // ── Alert Rules ───────────────────────────────────────────────────
      AlertRule: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          project_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          metric: { type: 'string', enum: ['error_rate', 'latency_p95', 'cost_spike'] },
          threshold: { type: 'number' },
          window_minutes: { type: 'integer' },
          notify_email: { type: 'string', format: 'email' },
          is_active: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },

      // ── Playground ────────────────────────────────────────────────────
      PlaygroundMessage: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['system', 'user', 'assistant'] },
          content: { type: 'string' },
        },
        required: ['role', 'content'],
      },
      PlaygroundRunRequest: {
        type: 'object',
        properties: {
          messages: { type: 'array', items: { $ref: '#/components/schemas/PlaygroundMessage' }, minItems: 1 },
          model: { type: 'string', default: 'llama-3.3-70b-versatile' },
          temperature: { type: 'number', default: 0.7 },
          max_tokens: { type: 'integer', default: 1024 },
        },
        required: ['messages'],
      },
      PlaygroundRunResponse: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          model: { type: 'string' },
          usage: {
            type: 'object',
            properties: {
              input_tokens: { type: 'integer' },
              output_tokens: { type: 'integer' },
              total_tokens: { type: 'integer' },
            },
          },
          duration_ms: { type: 'integer' },
          finish_reason: { type: 'string' },
        },
      },

      // ── Explain ───────────────────────────────────────────────────────
      ExplainResponse: {
        type: 'object',
        properties: {
          diagnosis: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  //  PATHS
  // ═══════════════════════════════════════════════════════════════════════
  paths: {
    // ── Health ─────────────────────────────────────────────────────────
    '/api/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Health check',
        description:
          'Returns a structured health report including environment and database checks. No authentication required.',
        tags: ['Health'],
        security: [],
        responses: {
          200: {
            description: 'System healthy or degraded',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
          503: {
            description: 'System unhealthy',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
        },
      },
    },

    // ── Ingest ─────────────────────────────────────────────────────────
    '/api/ingest': {
      post: {
        operationId: 'ingestSpans',
        summary: 'Ingest spans',
        description:
          'Ingest one or more spans into a session. Authenticates via a project API key (Bearer token). Creates a new session or attaches to an existing one via session_id. Automatically scores LLM spans, fires alert rules, and groups errors into issues.',
        tags: ['Ingest'],
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/IngestRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Spans ingested successfully',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/IngestResponse' } } },
          },
          400: { description: 'Invalid request body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          429: {
            description: 'Rate limit exceeded',
            content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, retry_after_ms: { type: 'integer' } } } } },
            headers: {
              'Retry-After': { schema: { type: 'string' } },
              'X-RateLimit-Remaining': { schema: { type: 'string' } },
            },
          },
          503: { description: 'Server misconfigured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── API Keys ───────────────────────────────────────────────────────
    '/api/keys': {
      get: {
        operationId: 'listApiKeys',
        summary: 'List API keys',
        description: 'List all API keys for a project. Never returns the key hash.',
        tags: ['API Keys'],
        parameters: [
          { name: 'project_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'List of API keys',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { keys: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } } },
                },
              },
            },
          },
          400: { description: 'Missing project_id', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        operationId: 'createApiKey',
        summary: 'Create an API key',
        description: 'Generate a new API key for a project. The full key is returned only in this response.',
        tags: ['API Keys'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  project_id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                },
                required: ['project_id'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'API key created (full key shown once)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreated' } } },
          },
          400: { description: 'Missing project_id', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        operationId: 'revokeApiKey',
        summary: 'Revoke an API key',
        description: 'Soft-deletes an API key by setting is_active to false.',
        tags: ['API Keys'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' } },
                required: ['id'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Key revoked',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } },
          },
          400: { description: 'Missing id', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'API key not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Projects ───────────────────────────────────────────────────────
    '/api/projects': {
      get: {
        operationId: 'listProjects',
        summary: 'List projects',
        description: "List all projects in the authenticated user's organization, including aggregated session and error counts.",
        tags: ['Projects'],
        responses: {
          200: {
            description: 'List of projects',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } } },
                },
              },
            },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'No organization found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        operationId: 'createProject',
        summary: 'Create a project',
        description: 'Create a new project within the current organization.',
        tags: ['Projects'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 3, maxLength: 50 },
                  description: { type: 'string' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Project created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { project: { $ref: '#/components/schemas/Project' } },
                },
              },
            },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'No organization found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/projects/{id}': {
      get: {
        operationId: 'getProject',
        summary: 'Get project details',
        description: 'Retrieve a single project by ID with aggregated session statistics.',
        tags: ['Projects'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Project with stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { project: { $ref: '#/components/schemas/ProjectDetail' } },
                },
              },
            },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      patch: {
        operationId: 'updateProject',
        summary: 'Update a project',
        description: "Update a project's name and/or description.",
        tags: ['Projects'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Project updated',
            content: { 'application/json': { schema: { type: 'object', properties: { project: { $ref: '#/components/schemas/Project' } } } } },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        operationId: 'deleteProject',
        summary: 'Delete a project',
        description: 'Delete a project. Only owners and admins are allowed. Cascading deletes are handled at the database level.',
        tags: ['Projects'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Project deleted',
            content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Forbidden / insufficient permissions', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Project Alert Rules ───────────────────────────────────────────
    '/api/projects/{id}/alerts': {
      get: {
        operationId: 'listProjectAlertRules',
        summary: 'List alert rules for a project',
        tags: ['Alerts'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Project ID' },
        ],
        responses: {
          200: {
            description: 'Alert rules list',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { rules: { type: 'array', items: { $ref: '#/components/schemas/AlertRule' } } } },
              },
            },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        operationId: 'createAlertRule',
        summary: 'Create an alert rule',
        tags: ['Alerts'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Project ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  metric: { type: 'string', enum: ['error_rate', 'latency_p95', 'cost_spike'] },
                  threshold: { type: 'number' },
                  window_minutes: { type: 'integer' },
                  notify_email: { type: 'string', format: 'email' },
                },
                required: ['name', 'metric', 'threshold', 'window_minutes', 'notify_email'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Alert rule created',
            content: { 'application/json': { schema: { type: 'object', properties: { rule: { $ref: '#/components/schemas/AlertRule' } } } } },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Alert Rule by ID ──────────────────────────────────────────────
    '/api/alerts/{id}': {
      patch: {
        operationId: 'toggleAlertRule',
        summary: 'Toggle alert rule active state',
        tags: ['Alerts'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Alert rule ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { is_active: { type: 'boolean' } },
                required: ['is_active'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Rule updated',
            content: { 'application/json': { schema: { type: 'object', properties: { rule: { $ref: '#/components/schemas/AlertRule' } } } } },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Rule not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        operationId: 'deleteAlertRule',
        summary: 'Delete an alert rule',
        tags: ['Alerts'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Alert rule ID' },
        ],
        responses: {
          200: {
            description: 'Rule deleted',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Rule not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Sessions ───────────────────────────────────────────────────────
    '/api/sessions/{id}': {
      get: {
        operationId: 'getSession',
        summary: 'Get session detail',
        description:
          'Retrieve a single session with all its spans as a nested tree, including eval_scores and ai_explanations per span.',
        tags: ['Sessions'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Session with span tree',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    session: {
                      type: 'object',
                      description: 'Session fields plus a spans array of nested SpanTreeNodes.',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        project_id: { type: 'string', format: 'uuid' },
                        external_id: { type: 'string', nullable: true },
                        name: { type: 'string' },
                        status: { type: 'string', enum: ['running', 'success', 'error'] },
                        started_at: { type: 'string', format: 'date-time' },
                        ended_at: { type: 'string', format: 'date-time', nullable: true },
                        span_count: { type: 'integer' },
                        error_count: { type: 'integer' },
                        total_tokens: { type: 'integer' },
                        total_cost_usd: { type: 'number' },
                        spans: { type: 'array', items: { $ref: '#/components/schemas/SpanTreeNode' } },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Session not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Span Eval Scores ──────────────────────────────────────────────
    '/api/spans/{id}/eval': {
      get: {
        operationId: 'getSpanEval',
        summary: 'Get eval score for a span',
        tags: ['Spans'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Span ID' },
        ],
        responses: {
          200: {
            description: 'Eval score (or null if not yet scored)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { eval_score: { oneOf: [{ $ref: '#/components/schemas/EvalScore' }, { type: 'null' }] } },
                },
              },
            },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Span AI Explanation ───────────────────────────────────────────
    '/api/spans/{id}/explain': {
      post: {
        operationId: 'explainSpan',
        summary: 'Get AI explanation for a span failure',
        description:
          'Generates an AI-powered diagnosis and suggested fix for a failed span. Returns cached result if already generated. Requires GEMINI_API_KEY to be configured.',
        tags: ['Spans'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Span ID' },
        ],
        responses: {
          200: {
            description: 'Explanation (may be cached)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ExplainResponse' } } },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Span or project not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          412: { description: 'GEMINI_API_KEY not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Search ─────────────────────────────────────────────────────────
    '/api/search': {
      get: {
        operationId: 'globalSearch',
        summary: 'Global search',
        description: 'Search across sessions, spans, and issues. Returns grouped results by type.',
        tags: ['Search'],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2 }, description: 'Search query (min 2 chars)' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 8, maximum: 20 }, description: 'Max results per type' },
        ],
        responses: {
          200: {
            description: 'Search results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: { type: 'array', items: { $ref: '#/components/schemas/SearchResult' } },
                    query: { type: 'string' },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Organization ──────────────────────────────────────────────────
    '/api/org': {
      get: {
        operationId: 'getOrganization',
        summary: "Get current user's organization",
        tags: ['Organization'],
        responses: {
          200: {
            description: 'Organization details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Organization not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      patch: {
        operationId: 'updateOrganization',
        summary: 'Update organization name',
        description: 'Only organization owners can update the name.',
        tags: ['Organization'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string', minLength: 1 } },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Organization updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Only owners allowed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Profile ───────────────────────────────────────────────────────
    '/api/profile': {
      patch: {
        operationId: 'updateProfile',
        summary: 'Update user profile',
        tags: ['Profile'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { full_name: { type: 'string', minLength: 1 } },
                required: ['full_name'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Profile updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Invites / Members ─────────────────────────────────────────────
    '/api/invites': {
      get: {
        operationId: 'listOrgMembers',
        summary: 'List organization members',
        tags: ['Invites'],
        parameters: [
          { name: 'org_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Members list with current user role',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    members: { type: 'array', items: { $ref: '#/components/schemas/OrgMember' } },
                    currentUserRole: { type: 'string', enum: ['owner', 'admin', 'member'] },
                  },
                },
              },
            },
          },
          400: { description: 'Missing org_id', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Not a member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        operationId: 'inviteMember',
        summary: 'Invite a user by email',
        description: 'Add a user to the organization. Only owners can invite. The user must already have an account.',
        tags: ['Invites'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  org_id: { type: 'string', format: 'uuid' },
                  email: { type: 'string', format: 'email' },
                },
                required: ['org_id', 'email'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Member added',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    member: { $ref: '#/components/schemas/OrgMember' },
                  },
                },
              },
            },
          },
          400: { description: 'Validation error or self-invite', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Only owners allowed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'User already a member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        operationId: 'removeMember',
        summary: 'Remove a member',
        description: 'Remove a member from the organization. Only owners can remove. Cannot remove other owners or yourself.',
        tags: ['Invites'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  org_id: { type: 'string', format: 'uuid' },
                  user_id: { type: 'string', format: 'uuid' },
                },
                required: ['org_id', 'user_id'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Member removed',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } },
          },
          400: { description: 'Validation error or self-removal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Only owners allowed / cannot remove owner', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Issues ─────────────────────────────────────────────────────────
    '/api/issues/{id}': {
      patch: {
        operationId: 'updateIssueStatus',
        summary: 'Update issue status',
        tags: ['Issues'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Issue ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { status: { type: 'string', enum: ['open', 'resolved', 'ignored'] } },
                required: ['status'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Issue updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Issue' } } },
          },
          400: { description: 'Invalid status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Issue not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Playground ─────────────────────────────────────────────────────
    '/api/playground/run': {
      post: {
        operationId: 'runPlayground',
        summary: 'Run a prompt in the playground',
        description:
          'Execute a chat completion against the Groq free tier. Used by the Prompt Playground to let users tweak and re-run LLM calls.',
        tags: ['Playground'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PlaygroundRunRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Completion result',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaygroundRunResponse' } } },
          },
          400: { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          502: {
            description: 'Groq API error',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' }, duration_ms: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    },

    // ── Export / Fine-tune ─────────────────────────────────────────────
    '/api/export/finetune': {
      get: {
        operationId: 'exportFinetune',
        summary: 'Export fine-tuning dataset',
        description:
          'Export high-quality LLM traces as a JSONL file formatted for OpenAI / Llama fine-tuning. Filters LLM spans by eval score threshold.',
        tags: ['Export'],
        parameters: [
          { name: 'project_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'min_score', in: 'query', required: false, schema: { type: 'number', default: 8, minimum: 0, maximum: 10 }, description: 'Minimum eval score threshold' },
        ],
        responses: {
          200: {
            description: 'JSONL file download',
            content: {
              'application/jsonl': {
                schema: { type: 'string', description: 'Newline-delimited JSON training examples' },
              },
            },
            headers: {
              'Content-Disposition': { schema: { type: 'string' } },
              'X-Total-Examples': { schema: { type: 'string' } },
              'X-Min-Score': { schema: { type: 'string' } },
            },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'No matching spans found', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, total: { type: 'integer' } } } } } },
        },
      },
    },

    // ── Docs (this spec) ──────────────────────────────────────────────
    '/api/docs': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'OpenAPI specification',
        description: 'Returns this OpenAPI 3.1 specification as JSON.',
        tags: ['Docs'],
        security: [],
        responses: {
          200: {
            description: 'OpenAPI spec',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },

  tags: [
    { name: 'Health', description: 'System health and readiness' },
    { name: 'Ingest', description: 'Trace / span ingestion (SDK-facing)' },
    { name: 'API Keys', description: 'Manage project API keys' },
    { name: 'Projects', description: 'Project CRUD and statistics' },
    { name: 'Alerts', description: 'Alert rule management' },
    { name: 'Sessions', description: 'Session retrieval with span trees' },
    { name: 'Spans', description: 'Span evaluation and AI explanation' },
    { name: 'Search', description: 'Global search across entities' },
    { name: 'Organization', description: 'Organization settings' },
    { name: 'Profile', description: 'User profile management' },
    { name: 'Invites', description: 'Organization member management' },
    { name: 'Issues', description: 'Error issue tracking' },
    { name: 'Playground', description: 'Prompt playground (Groq-powered)' },
    { name: 'Export', description: 'Data export for fine-tuning' },
    { name: 'Docs', description: 'API documentation' },
  ],
} as const
