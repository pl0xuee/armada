/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" bundles the browser mock backend into a production build (UI review only). */
  readonly VITE_KVISTCODE_MOCK?: string;
}
