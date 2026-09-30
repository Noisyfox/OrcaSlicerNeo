interface ImportMetaEnv {
  readonly VITE_REAL_PROJECT_PROFILE?: string;
  readonly VITE_PAINTING_PROFILE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
