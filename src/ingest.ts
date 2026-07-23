// Capture ingestion — the deterministic half of the pipeline.
//
// Phase 2 scope: take a raw capture and establish *facts* about it — what the
// URL is, its title, author, platform, and text. No interpretation, no AI. The
// AI proposal pass (Phase 4) runs on top of what this produces.
//
// Keeping the two apart matters: metadata extraction is cheap, deterministic,
// and cacheable, while extraction is expensive and probabilistic. Re-running the
// AI stage should never require re-fetching, and a failed AI stage must not lose
// a successfully fetched transcript.

export interface FetchedMetadata {
  title: string | null;
  author: string | null;
  description: string | null;
  published_at: number | null;
  canonical_url: string | null;
  text: string | null;
}

const USER_AGENT = "et-al/0.6 (+personal knowledge system)";
const MAX_BYTES = 2_000_000;   // don't pull a whole video page into memory
const TIMEOUT_MS = 15_000;

/** Decodes the handful of entities that actually show up in title/meta tags. */
function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    const key = code.toLowerCase();
    if (named[key]) return named[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return whole;
  });
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = decodeEntities(match[1]).trim();
      if (value) return value;
    }
  }
  return null;
}

/**
 * Strips markup to readable text. Deliberately simple: this feeds search and
 * gives the AI stage something to read, not a faithful article reconstruction.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 20_000);
}

export function parseHtmlMetadata(html: string): FetchedMetadata {
  const title = metaContent(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]);
  const author = metaContent(html, [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+itemprop=["']name["'][^>]+content=["']([^"']+)["']/i,
  ]);
  const description = metaContent(html, [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  ]);
  const publishedRaw = metaContent(html, [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
  ]);
  const canonical = metaContent(html, [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
  ]);

  let publishedAt: number | null = null;
  if (publishedRaw) {
    const ms = Date.parse(publishedRaw);
    if (Number.isFinite(ms)) publishedAt = Math.floor(ms / 1000);
  }

  return {
    title, author, description, published_at: publishedAt,
    canonical_url: canonical, text: htmlToText(html),
  };
}

/**
 * Fetches a URL and extracts metadata.
 *
 * Throws on a non-OK response so the job records a real failure and can be
 * retried, rather than silently storing an empty Source that looks successful.
 */
export async function fetchUrlMetadata(url: string): Promise<FetchedMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      // A PDF or video file: record what we know rather than parsing binary.
      return {
        title: decodeURIComponent(url.split("/").pop() ?? "") || url,
        author: null, description: null, published_at: null,
        canonical_url: url, text: null,
      };
    }

    const body = await readCapped(response, MAX_BYTES);
    const meta = parseHtmlMetadata(body);
    return { ...meta, canonical_url: meta.canonical_url ?? url };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads at most `limit` bytes, so a huge page cannot exhaust Worker memory. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk.subarray(0, Math.max(0, Math.min(chunk.length, total - offset))), offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(merged);
}

/**
 * YouTube's oEmbed endpoint gives a reliable title/author without scraping or an
 * API key. Transcripts need a separate (Phase 4) path; this at least means a
 * pasted video is never just a naked URL in the inbox.
 */
export async function fetchOEmbed(url: string): Promise<FetchedMetadata | null> {
  const endpoint = oembedEndpointFor(url);
  if (!endpoint) return null;
  try {
    const response = await fetch(endpoint, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) return null;
    const data = (await response.json()) as { title?: string; author_name?: string };
    if (!data.title) return null;
    return {
      title: data.title, author: data.author_name ?? null,
      description: null, published_at: null, canonical_url: url, text: null,
    };
  } catch { return null; }
}

function oembedEndpointFor(url: string): string | null {
  const u = url.toLowerCase();
  if (/youtube\.com\/watch|youtu\.be\//.test(u)) {
    return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  }
  if (/tiktok\.com\//.test(u)) {
    return `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  }
  return null;
}

/**
 * Best available metadata for a URL: oEmbed where a provider offers it (more
 * reliable than scraping a JS-rendered page), falling back to HTML parsing, and
 * merging so a good oEmbed title still gets the page's description and text.
 */
export async function resolveUrl(url: string): Promise<FetchedMetadata> {
  const oembed = await fetchOEmbed(url);
  try {
    const scraped = await fetchUrlMetadata(url);
    if (!oembed) return scraped;
    return {
      title: oembed.title ?? scraped.title,
      author: oembed.author ?? scraped.author,
      description: scraped.description,
      published_at: scraped.published_at,
      canonical_url: scraped.canonical_url ?? url,
      text: scraped.text,
    };
  } catch (error) {
    // A provider that blocks scraping still yields a usable record via oEmbed.
    if (oembed) return oembed;
    throw error;
  }
}
