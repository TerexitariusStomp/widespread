/** GitHub connection fields collected by the repository census scripts. */
export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
export interface ConnectionPage<T> {
  totalCount: number;
  nodes: T[];
  pageInfo: PageInfo;
}
