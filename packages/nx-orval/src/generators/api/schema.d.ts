export type OrvalClient =
  | 'fetch'
  | 'axios'
  | 'axios-functions'
  | 'react-query'
  | 'vue-query'
  | 'svelte-query'
  | 'solid-query'
  | 'solid-start'
  | 'pinia-colada'
  | 'angular'
  | 'angular-query'
  | 'swr'
  | 'hono'
  | 'effect'
  | 'mcp'
  | 'zod'
  | 'valibot';

export type OrvalHttpClient = 'fetch' | 'axios';

export type OrvalValidation = 'zod' | 'valibot';

export type OrvalFormatter = 'oxfmt' | 'biome' | 'prettier';

export interface ApiGeneratorSchema {
  name?: string;
  directory?: string;
  project?: string;
  spec?: string;
  client?: OrvalClient;
  httpClient?: OrvalHttpClient;
  validation?: OrvalValidation | 'none';
  mock?: boolean;
  tags?: string;
  linter?: 'eslint' | 'none';
  skipGenerate?: boolean;
  skipFormat?: boolean;
}
