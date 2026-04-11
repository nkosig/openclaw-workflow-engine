import { z } from "zod";

export const ScalarTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
]);

export const InputFieldSchema = z
  .object({
    type: ScalarTypeSchema,
    required: z.boolean().optional().default(true),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "string") {
      if (value.min !== undefined || value.max !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "min/max are only valid for number/integer fields",
        });
      }
      if (value.pattern) {
        try {
          // Validate regex syntax at load-time
          // eslint-disable-next-line no-new
          new RegExp(value.pattern);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid regex pattern '${value.pattern}'`,
          });
        }
      }
    }

    if (value.type === "number" || value.type === "integer") {
      if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "min cannot be greater than max",
        });
      }
    }

    if (value.type !== "string" && value.pattern !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pattern is only valid for string fields",
      });
    }

    if (value.default !== undefined) {
      const typeMatches =
        (value.type === "string" && typeof value.default === "string") ||
        ((value.type === "number" || value.type === "integer") &&
          typeof value.default === "number") ||
        (value.type === "boolean" && typeof value.default === "boolean");
      if (!typeMatches) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "default type does not match field type",
        });
      }
      if (value.type === "integer" && typeof value.default === "number" && !Number.isInteger(value.default)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "default for integer fields must be an integer",
        });
      }
    }
  });

export const HttpRequestSchema = z.object({
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
    .default("GET"),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.record(z.unknown()).optional(),
});

const SqlStepSchema = z
  .object({
    sql: z.string().min(1),
    as: z.string().optional(),
  })
  .strict();

const HttpStepSchema = z
  .object({
    http: HttpRequestSchema,
    as: z.string().optional(),
  })
  .strict();

const EventStepSchema = z
  .object({
    event: z.string().min(1),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

const SetContextStepSchema = z
  .object({
    set_context: z.record(z.unknown()),
  })
  .strict();

const ReturnStepSchema = z
  .object({
    return: z.record(z.unknown()),
    transition: z.string().min(1).optional(),
  })
  .strict();

const WorkflowStepSchemaBase: z.ZodTypeAny = z.lazy(() => {
  const IfStepSchema: z.ZodTypeAny = z
    .object({
      if: z.string().min(1),
      then: z.array(WorkflowStepSchemaBase),
      else: z.array(WorkflowStepSchemaBase).optional(),
    })
    .strict()
    .superRefine((step, ctx) => {
      if (step.then.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "if step 'then' branch cannot be empty",
        });
      }
    });

  return z.union([
    SqlStepSchema,
    HttpStepSchema,
    IfStepSchema,
    EventStepSchema,
    SetContextStepSchema,
    ReturnStepSchema,
  ]);
});

export const WorkflowStepSchema = WorkflowStepSchemaBase;

export type SqlStepConfig = z.infer<typeof SqlStepSchema>;
export type HttpStepConfig = z.infer<typeof HttpStepSchema>;
export type EventStepConfig = z.infer<typeof EventStepSchema>;
export type SetContextStepConfig = z.infer<typeof SetContextStepSchema>;
export type ReturnStepConfig = z.infer<typeof ReturnStepSchema>;
export type WorkflowStepConfig = z.infer<typeof WorkflowStepSchema>;

export const ToolConfigSchema = z
  .object({
    description: z.string().min(1),
    input: z.record(InputFieldSchema).default({}),
    idempotency: z.string().optional(),
    read_after_write: z.string().optional(),
    steps: z.array(WorkflowStepSchema).min(1),
    on_error: z.string().optional(),
  })
  .strict();

export const StateConfigSchema = z
  .object({
    prompt: z.string().optional().default(""),
    tools: z.record(ToolConfigSchema).default({}),
  })
  .strict();

export const MigrationConfigSchema = z
  .object({
    version: z.number().int().positive(),
    sql: z.string().min(1),
  })
  .strict();

export const WorkflowYamlSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    db: z.string().optional(),
    api_base: z.string().url().optional(),
    context: z.record(z.unknown()).optional().default({}),
    states: z.record(StateConfigSchema).superRefine((states, ctx) => {
      if (Object.keys(states).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Workflow must define at least one state",
        });
      }
    }),
    migrations: z.array(MigrationConfigSchema).optional().default([]),
  })
  .strict();

export type InputFieldConfig = z.infer<typeof InputFieldSchema>;
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type StateConfig = z.infer<typeof StateConfigSchema>;
export type WorkflowYamlConfig = z.infer<typeof WorkflowYamlSchema>;
export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;

/**
 * Parse and validate workflow YAML data.
 */
export function parseWorkflowYaml(data: unknown): WorkflowYamlConfig {
  return WorkflowYamlSchema.parse(data);
}
