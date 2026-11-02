import { z } from "zod";

export type RequestId = string | number;

export type JsonRpcRequest = {
  id: RequestId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: RequestId;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcEnvelope = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

const requestIdSchema = z.union([z.string(), z.number()]);

const requestSchema = z.object({
  id: requestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional()
}).passthrough();

const notificationSchema = z.object({
  method: z.string().min(1),
  params: z.unknown().optional()
}).passthrough();

const responseSchema = z.object({
  id: requestIdSchema,
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional()
  }).passthrough().optional()
}).passthrough().refine((value) => value.result !== undefined || value.error !== undefined, {
  message: "响应缺少 result 或 error"
});

export const parseEnvelope = (value: unknown): JsonRpcEnvelope => {
  const candidate = z.record(z.unknown()).parse(value);
  if ("method" in candidate && "id" in candidate) {
    return requestSchema.parse(candidate) as JsonRpcRequest;
  }
  if ("method" in candidate) {
    return notificationSchema.parse(candidate) as JsonRpcNotification;
  }
  return responseSchema.parse(candidate) as JsonRpcResponse;
};

export const isResponse = (value: JsonRpcEnvelope): value is JsonRpcResponse => {
  return "id" in value && !("method" in value);
};

export const isServerRequest = (value: JsonRpcEnvelope): value is JsonRpcRequest => {
  return "id" in value && "method" in value;
};

