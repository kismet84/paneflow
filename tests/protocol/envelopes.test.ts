import { describe, expect, it } from "vitest";
import { isResponse, isServerRequest, parseEnvelope } from "../../packages/protocol/src/envelopes";

describe("JSON-RPC envelope", () => {
  it("classifies responses", () => {
    const response = parseEnvelope({ id: "request-1", result: {} });
    expect(isResponse(response)).toBe(true);
  });

  it("classifies server requests", () => {
    const request = parseEnvelope({ id: 9, method: "item/tool/requestUserInput", params: {} });
    expect(isServerRequest(request)).toBe(true);
  });

  it("accepts notifications without params", () => {
    expect(parseEnvelope({ method: "initialized" })).toEqual({ method: "initialized" });
  });

  it("rejects malformed responses", () => {
    expect(() => parseEnvelope({ id: 1 })).toThrow();
  });
});

