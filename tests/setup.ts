import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach } from "vitest";

enableAutoUnmount(afterEach);

if (typeof window !== "undefined") {
  const target = globalThis as typeof globalThis & {
    addEventListener?: typeof window.addEventListener;
    removeEventListener?: typeof window.removeEventListener;
  };
  target.addEventListener ??= window.addEventListener.bind(window);
  target.removeEventListener ??= window.removeEventListener.bind(window);
}
