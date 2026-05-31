// Provider contract for ATS/portal scrapers.
// Each provider exports a default `Provider` object. scan_portals loads them via the
// registry in providers/index.ts (no filesystem auto-discovery — explicit imports keep
// the build deterministic).
export interface TrackedCompanyEntry {
  name:            string;
  greenhouse_slug?: string;
  ashby_slug?:     string;
  lever_slug?:     string;
  workday_url?:    string;
  careers_url?:    string;
  api?:            string;        // explicit override for some providers (e.g. greenhouse)
  provider?:       string;        // force a provider id
  enabled?:        boolean;
  is_active?:      boolean;
}

export interface RawJob {
  title:    string;
  url:      string;
  company:  string;
  location: string;
}

export interface ProviderCtx {
  fetchJson:    (url: string, opts?: any) => Promise<any>;
  fetchText:    (url: string, opts?: any) => Promise<string>;
  withBrowser?: <T>(fn: (browser: any) => Promise<T>) => Promise<T>;
}

export interface Provider {
  id:      string;
  detect?: (entry: TrackedCompanyEntry) => { url?: string } | null;
  fetch:   (entry: TrackedCompanyEntry, ctx: ProviderCtx) => Promise<RawJob[]>;
}
