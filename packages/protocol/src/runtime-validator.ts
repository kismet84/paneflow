import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";

export class RuntimeProtocolValidator {
  readonly #serverRequest: ValidateFunction;
  readonly #serverNotification: ValidateFunction;
  readonly #clientRequest: ValidateFunction;
  readonly #clientNotification: ValidateFunction;
  readonly #serverResponses = new Map<string, ValidateFunction>();

  constructor(schemaDirectory: string) {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    this.#serverRequest = ajv.compile(JSON.parse(readFileSync(join(schemaDirectory, "ServerRequest.json"), "utf8")));
    this.#serverNotification = ajv.compile(JSON.parse(readFileSync(join(schemaDirectory, "ServerNotification.json"), "utf8")));
    this.#clientRequest = ajv.compile(JSON.parse(readFileSync(join(schemaDirectory, "ClientRequest.json"), "utf8")));
    this.#clientNotification = ajv.compile(JSON.parse(readFileSync(join(schemaDirectory, "ClientNotification.json"), "utf8")));
    const responseSchemas: Record<string, string> = {
      "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalResponse.json",
      "item/fileChange/requestApproval": "FileChangeRequestApprovalResponse.json",
      "item/tool/requestUserInput": "ToolRequestUserInputResponse.json",
      "mcpServer/elicitation/request": "McpServerElicitationRequestResponse.json",
      "item/permissions/requestApproval": "PermissionsRequestApprovalResponse.json",
      "item/tool/call": "DynamicToolCallResponse.json",
      "account/chatgptAuthTokens/refresh": "ChatgptAuthTokensRefreshResponse.json",
      "attestation/generate": "AttestationGenerateResponse.json",
      "currentTime/read": "CurrentTimeReadResponse.json",
      applyPatchApproval: "ApplyPatchApprovalResponse.json",
      execCommandApproval: "ExecCommandApprovalResponse.json"
    };
    for (const [method, file] of Object.entries(responseSchemas)) {
      this.#serverResponses.set(method, ajv.compile(JSON.parse(readFileSync(join(schemaDirectory, file), "utf8"))));
    }
  }

  validateServerRequest(value: unknown): { valid: boolean; errors: ErrorObject[] } {
    const valid = this.#serverRequest(value);
    return { valid, errors: [...(this.#serverRequest.errors ?? [])] };
  }

  validateServerNotification(value: unknown): { valid: boolean; errors: ErrorObject[] } {
    const valid = this.#serverNotification(value);
    return { valid, errors: [...(this.#serverNotification.errors ?? [])] };
  }

  validateServerResponse(method: string, value: unknown): { valid: boolean; errors: ErrorObject[] } {
    const validator = this.#serverResponses.get(method);
    if (!validator) return { valid: false, errors: [] };
    const valid = validator(value);
    return { valid, errors: [...(validator.errors ?? [])] };
  }

  validateClientRequest(value: unknown): { valid: boolean; errors: ErrorObject[] } {
    const valid = this.#clientRequest(value);
    return { valid, errors: [...(this.#clientRequest.errors ?? [])] };
  }

  validateClientNotification(value: unknown): { valid: boolean; errors: ErrorObject[] } {
    const valid = this.#clientNotification(value);
    return { valid, errors: [...(this.#clientNotification.errors ?? [])] };
  }
}
