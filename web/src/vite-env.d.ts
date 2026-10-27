/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIMPLE_LOGIN?: string
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
