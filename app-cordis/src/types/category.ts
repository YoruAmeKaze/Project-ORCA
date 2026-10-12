/** Stable, controlled functional classification shared by Memory and Skills. */
export interface CategoryPath {
  domain: string
  subdomain: string
  function: string
}

export const CONTROLLED_CATEGORIES: readonly CategoryPath[] = [
  { domain: 'ordering', subdomain: 'luckin', function: 'stores' },
  { domain: 'ordering', subdomain: 'luckin', function: 'products' },
  { domain: 'ordering', subdomain: 'mcdonalds', function: 'stores' },
  { domain: 'ordering', subdomain: 'mcdonalds', function: 'menu' },
  { domain: 'basic-control', subdomain: 'screen', function: 'screenshot' },
  { domain: 'basic-control', subdomain: 'screen', function: 'snapshot' },
  { domain: 'basic-control', subdomain: 'screen', function: 'display-inventory' },
  { domain: 'basic-control', subdomain: 'screen', function: 'control-status' },
  { domain: 'basic-control', subdomain: 'system', function: 'system-info' },
  { domain: 'basic-control', subdomain: 'filesystem', function: 'read-file' },
  { domain: 'uncategorized', subdomain: 'uncategorized', function: 'uncategorized' },
]

function categoryKey(category: CategoryPath): string {
  return `${category.domain}/${category.subdomain}/${category.function}`
}

const CATEGORY_KEYS = new Set(CONTROLLED_CATEGORIES.map(categoryKey))

/** Unknown or malformed paths degrade to the explicit uncategorized bucket. */
export function normalizeCategory(category?: Partial<CategoryPath>): CategoryPath {
  const candidate = {
    domain: category?.domain?.trim() || 'uncategorized',
    subdomain: category?.subdomain?.trim() || 'uncategorized',
    function: category?.function?.trim() || 'uncategorized',
  }
  return CATEGORY_KEYS.has(categoryKey(candidate))
    ? candidate
    : CONTROLLED_CATEGORIES[CONTROLLED_CATEGORIES.length - 1]!
}

export function categoryMatches(category: CategoryPath | undefined, query?: Partial<CategoryPath>): boolean {
  if (!query) return true
  const actual = category ?? normalizeCategory()
  return (!query.domain || actual.domain === query.domain)
    && (!query.subdomain || actual.subdomain === query.subdomain)
    && (!query.function || actual.function === query.function)
}
