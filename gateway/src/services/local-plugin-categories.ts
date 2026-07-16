/** Same fixed taxonomy as Marketplace's MKT-024 (apps/openon4net-marketplace/migrations/0006_plugin_categories.sql) — one category concept across the whole Plugin ecosystem, local or Marketplace-published. */
export const PLUGIN_CATEGORIES = [
  'communication',
  'productivity',
  'data-analytics',
  'devops',
  'ai-ml',
  'finance',
  'other',
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];
