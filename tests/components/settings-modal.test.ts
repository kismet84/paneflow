// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { NColorPicker, NInput, NInputNumber, NRadioGroup, NSelect, NSwitch } from "naive-ui";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModal from "../../src/components/SettingsModal.vue";
import { useWorkspaceStore } from "../../src/stores/workspace";
import { appearanceCssVars, appearanceThemeOverrides } from "../../src/theme";

describe("SettingsModal", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    Object.defineProperty(window, "queryLocalFonts", {
      configurable: true,
      value: vi.fn().mockResolvedValue([{ family: "Microsoft YaHei UI" }, { family: "Cascadia Code" }, { family: "Microsoft YaHei UI" }])
    });
  });

  it("updates theme, font, size, and accent color", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    const wrapper = mount(SettingsModal, { props: { show: true }, global: { plugins: [pinia], stubs: { teleport: true } } });
    wrapper.findAllComponents(NRadioGroup).find((group) => group.props("name") === "appearance-theme")!.vm.$emit("update:value", "light");
    wrapper.getComponent(NSelect).vm.$emit("update:value", "Cascadia Code");
    wrapper.getComponent(NInputNumber).vm.$emit("update:value", 18);
    wrapper.getComponent(NColorPicker).vm.$emit("update:value", "#ff3366");
    await wrapper.vm.$nextTick();
    expect(store.state.appearance).toMatchObject({ theme: "light", fontFamily: "Cascadia Code", fontSize: 18, accentColor: "#ff3366" });
    expect((window as typeof window & { queryLocalFonts: ReturnType<typeof vi.fn> }).queryLocalFonts).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("已读取 2 个字体系列");
    wrapper.getComponent(NSelect).vm.$emit("update:value", null);
    expect(store.state.appearance.fontFamily).toBe("");
    wrapper.findAllComponents(NSwitch).at(-1)!.vm.$emit("update:value", true);
    expect(store.state.appearance.mcpGatewayAdaptation).toBe(true);
    await wrapper.findAll("button").find((button) => button.text() === "恢复默认")!.trigger("click");
    expect(store.state.appearance).toMatchObject({ theme: "system", fontSize: 14, accentColor: "#10a37f", mcpGatewayAdaptation: false });
    expect(wrapper.text()).toContain("Codex Pane");
  });

  it("offers the multi-pane and session-sidebar workspace modes", () => {
    const pinia = createPinia();
    const wrapper = mount(SettingsModal, { props: { show: true }, global: { plugins: [pinia], stubs: { teleport: true } } });
    const modeGroup = wrapper.findAllComponents(NRadioGroup).find((group) => group.props("name") === "workspace-mode");
    expect(modeGroup).toBeTruthy();
    expect(wrapper.text()).toContain("多窗格");
    expect(wrapper.text()).toContain("会话侧栏");
    modeGroup!.vm.$emit("update:value", "sessionSidebar");
    expect(wrapper.emitted("update:workspaceMode")?.at(-1)).toEqual(["sessionSidebar"]);
  });

  it("applies the configured font family and size to application and component tokens", () => {
    const appearance = { theme: "dark" as const, fontFamily: "Microsoft YaHei UI", fontSize: 18, accentColor: "#10a37f", commandShellPath: "", unwrapPowerShellCommands: true, mcpGatewayAdaptation: false };
    expect(appearanceCssVars(appearance)).toMatchObject({ "--app-font-family": "Microsoft YaHei UI", "--app-font-size": "18px", "--app-control-border": "#454b54", "--app-diff-add": "#183627", "--app-diff-delete": "#42201f" });
    expect(appearanceThemeOverrides(appearance).common).toMatchObject({ fontFamily: "Microsoft YaHei UI", fontFamilyMono: "Microsoft YaHei UI", fontSize: "18px", fontSizeTiny: "16px", fontSizeSmall: "17px", fontSizeMedium: "18px" });
    expect(appearanceCssVars({ ...appearance, fontFamily: "" })["--app-font-family"]).toContain("Segoe UI");
    expect(appearanceThemeOverrides({ ...appearance, fontFamily: "" }).common?.fontFamily).toContain("Segoe UI");
    expect(appearanceCssVars({ ...appearance, theme: "system" }, false)["--app-bg"]).toBe("#f3f5f7");
    expect(appearanceCssVars({ ...appearance, theme: "system" }, true)["--app-bg"]).toBe("#0c0d0f");
  });

  it("labels the PowerShell wrapper path clearly, allows it to be cleared, and has an explicit close action", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    const wrapper = mount(SettingsModal, { props: { show: true, commandShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }, global: { plugins: [pinia], stubs: { teleport: true } } });
    const shellInput = wrapper.findAllComponents(NInput).find((input) => input.props("placeholder")?.includes("PowerShell"));
    expect(shellInput).toBeTruthy();
    expect(wrapper.text()).toContain("pwsh 路径");
    expect(wrapper.text()).toContain("简化 pwsh 命令");
    expect(wrapper.text()).not.toContain("PowerShell 7 路径");
    expect(wrapper.findAll(".settings-note")).toHaveLength(0);
    shellInput!.vm.$emit("update:value", "");
    expect(wrapper.emitted("update:commandShellPath")?.at(-1)).toEqual([""]);
    wrapper.findAllComponents(NSwitch).find((component) => component.element.closest(".n-form-item")?.textContent?.includes("简化 pwsh 命令"))!.vm.$emit("update:value", false);
    expect(store.state.appearance.unwrapPowerShellCommands).toBe(false);
    await wrapper.findAll("button").find((button) => button.text() === "完成")!.trigger("click");
    expect(wrapper.emitted("update:show")?.at(-1)).toEqual([false]);
  });

  it("falls back to the Windows font inventory when the browser list is empty", async () => {
    const pinia = createPinia();
    vi.mocked((window as typeof window & { queryLocalFonts: ReturnType<typeof vi.fn> }).queryLocalFonts).mockResolvedValueOnce([]);
    Object.defineProperty(window, "codexPane", { configurable: true, value: { listSystemFonts: vi.fn().mockResolvedValue(["Segoe UI", "Microsoft YaHei UI"]) } });
    const wrapper = mount(SettingsModal, { props: { show: true }, global: { plugins: [pinia], stubs: { teleport: true } } });
    await vi.waitFor(() => expect(wrapper.text()).toContain("已读取 2 个字体系列"));
    expect(window.codexPane.listSystemFonts).toHaveBeenCalledOnce();
  });

  it("shows and controls the global default directory", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.defaultCwd = "E:\\Personal\\codex-pane";
    const choose = vi.spyOn(store, "chooseDefaultDirectory").mockResolvedValue(undefined);
    const clear = vi.spyOn(store, "clearDefaultDirectory").mockResolvedValue(undefined);
    const wrapper = mount(SettingsModal, { props: { show: true }, global: { plugins: [pinia], stubs: { teleport: true } } });
    expect(wrapper.text()).toContain("E:\\Personal\\codex-pane");
    const buttons = wrapper.findAll("button");
    await buttons.find((button) => button.text().includes("选择目录"))!.trigger("click");
    await buttons.find((button) => button.text().includes("清空"))!.trigger("click");
    expect(choose).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(wrapper.text()).not.toContain("/cwd");
  });

  it("keeps Settings open and explains a failed default-directory update", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    vi.spyOn(store, "chooseDefaultDirectory").mockRejectedValue(new Error("目录已被移除"));
    const wrapper = mount(SettingsModal, { props: { show: true }, global: { plugins: [pinia], stubs: { teleport: true } } });
    await wrapper.findAll("button").find((button) => button.text().includes("选择目录"))!.trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("无法更新运行目录：目录已被移除"));
    expect(wrapper.emitted("update:show")).toBeUndefined();
  });

  it("copies the bounded redacted diagnostics exposed by the desktop contract", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.connection = { phase: "ready", generation: 2, codexVersion: "0.149.1", compatible: true, message: "连接正常" };
    const readDiagnostics = vi.fn().mockResolvedValue(["line 1", "line 2"]);
    const copyText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "codexPane", { configurable: true, value: { readDiagnostics, copyText, listSystemFonts: vi.fn().mockResolvedValue([]) } });
    const wrapper = mount(SettingsModal, { props: { show: true }, global: { plugins: [pinia], stubs: { teleport: true } } });
    await wrapper.findAll("button").find((button) => button.text().includes("复制脱敏诊断"))!.trigger("click");
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith("line 1\nline 2"));
    expect(wrapper.text()).toContain("诊断信息已复制到剪贴板");
    expect(wrapper.text()).toContain("Codex 版本");
  });

  it("configures remote access and starts desktop-authorized pairing", async () => {
    const pinia = createPinia();
    const status = { enabled: false, phase: "disabled" as const, message: "远程访问已关闭", relayUrl: "", paired: false, pairing: null, passkeys: [] };
    const updateRemoteSettings = vi.fn().mockResolvedValue({ ...status, enabled: true, phase: "connecting", relayUrl: "https://pane.example.com", message: "正在连接中转服务…" });
    const beginRemotePairing = vi.fn().mockResolvedValue({ ...status, enabled: true, phase: "pairing", relayUrl: "https://pane.example.com", message: "请使用手机扫描配对二维码" });
    Object.defineProperty(window, "codexPane", { configurable: true, value: {
      getRemoteAccessStatus: vi.fn().mockResolvedValue(status), updateRemoteSettings, beginRemotePairing,
      onRemoteAccessStatus: vi.fn().mockReturnValue(() => undefined), listSystemFonts: vi.fn().mockResolvedValue([])
    } });
    const wrapper = mount(SettingsModal, { props: { show: true }, global: { plugins: [pinia], stubs: { teleport: true } } });
    await vi.waitFor(() => expect(wrapper.text()).toContain("远程访问已关闭"));
    expect(wrapper.text()).toContain("保存设置");
    const switches = wrapper.findAllComponents(NSwitch);
    switches.find((component) => component.element.closest(".n-form-item")?.textContent?.includes("启用远程访问"))!.vm.$emit("update:value", true);
    const relayInput = wrapper.findAllComponents(NInput).find((input) => input.props("placeholder") === "https://pane.example.com")!;
    relayInput.vm.$emit("update:value", "https://pane.example.com");
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button").find((button) => button.text() === "保存并连接")!.trigger("click");
    expect(updateRemoteSettings).toHaveBeenCalledWith({ enabled: true, relayUrl: "https://pane.example.com" });
    await wrapper.findAll("button").find((button) => button.text() === "生成配对二维码")!.trigger("click");
    expect(beginRemotePairing).toHaveBeenCalledOnce();
  });
});
