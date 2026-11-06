/** Browser-only display preference; never used as an authorization signal. */
export type AzureThemePreference = "light" | "dark" | "system";

export const AZURE_THEME_STORAGE_KEY = "cbc.security-center.theme";

export function parseAzureThemePreference(value: string | null): AzureThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveAzureDarkTheme(preference: AzureThemePreference, systemDark: boolean): boolean {
  return preference === "dark" || (preference === "system" && systemDark);
}
