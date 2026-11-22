const SCAN_ID_PARAM = ':scanId';

export const ROUTE_PATHS = {
  health: '/health',
  scans: '/scans',
  scan: `/scans/${SCAN_ID_PARAM}`,
  findings: `/scans/${SCAN_ID_PARAM}/findings`,
  stop: `/scans/${SCAN_ID_PARAM}/stop`,
  resume: `/scans/${SCAN_ID_PARAM}/resume`,
} as const;

export function withScanId(routePath: string, scanId: string): string {
  return routePath.replace(SCAN_ID_PARAM, encodeURIComponent(scanId));
}
