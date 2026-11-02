import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../electron/main/sensitive-data";

describe("diagnostic redaction", () => {
  it("removes common credentials and URL query values before diagnostics reach disk or UI", () => {
    const source = "Authorization: Bearer abc.def-123 api_key=sk-abcdefghijklmnop token eyJheader.payload.signature https://example.com/callback?code=secret&state=visible";
    const redacted = redactSensitiveText(source);
    for (const secret of ["abc.def-123", "sk-abcdefghijklmnop", "eyJheader.payload.signature", "code=secret", "state=visible"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("Authorization: [已隐藏]");
    expect(redacted).toContain("[JWT 已隐藏]");
  });
});
