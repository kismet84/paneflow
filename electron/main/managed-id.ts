import { createHash } from "node:crypto";

export const stableManagedId = (identity: string | Buffer): string => {
  const hex = createHash("sha256").update(identity).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
