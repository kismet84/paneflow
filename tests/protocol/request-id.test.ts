import { describe, expect, it } from "vitest";
import { createServerRequestKey } from "../../electron/main/app-server-supervisor";

describe("server request identity", () => {
  it("keeps numeric and string JSON-RPC ids distinct across generations", () => {
    expect(createServerRequestKey(1, 1)).not.toBe(createServerRequestKey(1, "1"));
    expect(createServerRequestKey(1, 1)).not.toBe(createServerRequestKey(2, 1));
  });
});
