export interface SimpleLoginBuildConfig {
  enabled: boolean
  apiBaseUrl?: string
}

export function validateSimpleLoginBuildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): SimpleLoginBuildConfig {
  try {
    const enabled = environment.VITE_SIMPLE_LOGIN
    const apiBaseUrl = environment.VITE_API_BASE_URL
    if (enabled === undefined && apiBaseUrl === undefined) return { enabled: false }
    if (enabled !== 'true' || typeof apiBaseUrl !== 'string' || apiBaseUrl.length === 0 || apiBaseUrl.length > 2_048) throw new Error()
    const parsed = new URL(apiBaseUrl)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href.replace(/\/$/u, '') !== apiBaseUrl.replace(/\/$/u, '')) throw new Error()
    return { enabled: true, apiBaseUrl }
  } catch {
    throw new Error('Simple login build configuration is invalid')
  }
}
