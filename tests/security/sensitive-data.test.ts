import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../electron/main/sensitive-data";

describe("diagnostic redaction", () => {
  it("redacts adjacent Markdown links",()=>{
    expect(redactSensitiveText("[甲](https://a.example/path)。[乙](https://b.example/?code=private-value)")).not.toContain("private-value");
  });
  it("redacts complete IPv6 and parenthesized query values", () => {
    for(const url of ["https://[::1]/callback?code=private-value&state=private-state", "https://example.com/callback?code=first)private-tail&state=private-state"]){
      expect(redactSensitiveText(url)).not.toMatch(/private-|first/);
    }
  });
  it("preserves Chinese text after markdown links while redacting URL queries", () => {
    expect(redactSensitiveText("已更新 [Release](https://example.com/v0.8.0)。手机和平板共用。"))
      .toBe("已更新 [Release](https://example.com/v0.8.0)。手机和平板共用。");
    const result=redactSensitiveText("[下载](https://example.com/a?token=secret)；正文");
    expect(result).not.toContain("secret");expect(result).toContain(")；正文");
  });
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
