export function contactOrigin(request: Request, configured?: string) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return null;
  const supplied = request.headers.get("origin");
  if (!supplied) return null;
  try {
    const origin = new URL(supplied);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== supplied
    )
      return null;
    if (configured?.trim()) {
      const site = new URL(configured.trim());
      if (site.origin === supplied) return supplied;
      // The public site is served on both its main host and its www alias.
      // Do not accept other subdomains, protocols, ports or lookalike hosts.
      const withoutWww = (hostname: string) => hostname.replace(/^www\./, "");
      return origin.protocol === site.protocol &&
        origin.port === site.port &&
        withoutWww(origin.hostname) === withoutWww(site.hostname)
        ? supplied
        : null;
    }
    // NextURL normalizes 127.0.0.1 to localhost. Host preserves the actual
    // browser origin; unlike Origin, the browser cannot choose a different Host.
    const target = new URL(request.url);
    return origin.host === request.headers.get("host") &&
      origin.protocol === target.protocol
      ? supplied
      : null;
  } catch {
    return null;
  }
}
