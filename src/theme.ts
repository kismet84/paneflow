import type { CSSProperties } from "vue";
import type { GlobalThemeOverrides } from "naive-ui";
import type { AppearanceSettings } from "./types";

const darkPalette = { background: "#0c0d0f", surface: "#111316", raised: "#191c20", border: "#292d33", controlBorder: "#454b54", text: "#f3f5f7", muted: "#9da5af", diffAdd: "#183627", diffDelete: "#42201f", diffAddGutter: "#214832", diffDeleteGutter: "#542725", diffGutterText: "#9aa4ae", diffAddText: "#55c985", diffDeleteText: "#ff716a" };
const lightPalette = { background: "#f3f5f7", surface: "#ffffff", raised: "#f7f8fa", border: "#d9dee5", controlBorder: "#a9b1bb", text: "#171a1f", muted: "#626b76", diffAdd: "#dafbe1", diffDelete: "#ffebe9", diffAddGutter: "#aceebb", diffDeleteGutter: "#ffcecb", diffGutterText: "#1f2328", diffAddText: "#116329", diffDeleteText: "#82071e" };
const defaultFontFamily = '"Segoe UI", "Microsoft YaHei UI", sans-serif';

export const resolvedTheme = (appearance: AppearanceSettings, systemPrefersDark = true): "dark" | "light" => appearance.theme === "system" ? systemPrefersDark ? "dark" : "light" : appearance.theme;

export const appearanceCssVars = (appearance: AppearanceSettings, systemPrefersDark = true): CSSProperties => {
  const palette = resolvedTheme(appearance, systemPrefersDark) === "dark" ? darkPalette : lightPalette;
  const fontFamily = appearance.fontFamily.trim() || defaultFontFamily;
  return {
    "--app-bg": palette.background,
    "--app-surface": palette.surface,
    "--app-raised": palette.raised,
    "--app-border": palette.border,
    "--app-control-border": palette.controlBorder,
    "--app-text": palette.text,
    "--app-muted": palette.muted,
    "--app-accent": appearance.accentColor,
    "--app-font-family": fontFamily,
    "--app-font-size": `${appearance.fontSize}px`,
    "--app-diff-add": palette.diffAdd,
    "--app-diff-delete": palette.diffDelete,
    "--app-diff-add-gutter": palette.diffAddGutter,
    "--app-diff-delete-gutter": palette.diffDeleteGutter,
    "--app-diff-gutter-text": palette.diffGutterText,
    "--app-diff-add-text": palette.diffAddText,
    "--app-diff-delete-text": palette.diffDeleteText
  } as CSSProperties;
};

export const appearanceThemeOverrides = (appearance: AppearanceSettings, systemPrefersDark = true): GlobalThemeOverrides => {
  const palette = resolvedTheme(appearance, systemPrefersDark) === "dark" ? darkPalette : lightPalette;
  const fontFamily = appearance.fontFamily.trim() || defaultFontFamily;
  return {
    common: {
      primaryColor: appearance.accentColor,
      primaryColorHover: appearance.accentColor,
      primaryColorPressed: appearance.accentColor,
      primaryColorSuppl: appearance.accentColor,
      bodyColor: palette.background,
      cardColor: palette.surface,
      modalColor: palette.surface,
      popoverColor: palette.surface,
      tableColor: palette.surface,
      inputColor: palette.raised,
      actionColor: palette.raised,
      borderColor: palette.border,
      dividerColor: palette.border,
      textColorBase: palette.text,
      textColor1: palette.text,
      textColor2: palette.text,
      textColor3: palette.muted,
      fontFamily,
      fontFamilyMono: fontFamily,
      fontSize: `${appearance.fontSize}px`,
      fontSizeMini: `${Math.max(10, appearance.fontSize - 2)}px`,
      fontSizeTiny: `${Math.max(10, appearance.fontSize - 2)}px`,
      fontSizeSmall: `${Math.max(11, appearance.fontSize - 1)}px`,
      fontSizeMedium: `${appearance.fontSize}px`,
      fontSizeLarge: `${appearance.fontSize + 2}px`,
      fontSizeHuge: `${appearance.fontSize + 4}px`
    }
  };
};
