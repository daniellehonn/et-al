// Extraction eval fixtures. Each is something a person might save, written for
// this eval (no copyrighted text), with the durable facts a good extraction
// should find.
//
// An expected fact is a list of keyword groups. An extracted fact matches it if
// its title + content contains at least one alternative from every group, case-
// insensitively. Groups keep matching tolerant of paraphrase without accepting
// a fact that misses the point.
//
// The last five fixtures hold nothing durable — a cookie wall, a promo, a
// nav page — and should produce no facts at all. They measure noise.

export interface Fixture {
  id: string;
  title: string;
  text: string;
  expect: Array<Array<string | string[]>>;
}

export const FIXTURES: Fixture[] = [
  {
    id: "rrf",
    title: "Fusing ranked lists without tuning",
    text: `When you combine results from a keyword index and a vector index, the scores are not comparable: BM25 is unbounded and cosine similarity lives between -1 and 1. Reciprocal Rank Fusion sidesteps this by ignoring scores entirely. Each document gets 1/(k + rank) from every list it appears in, and the sums are sorted. The constant k is usually 60, which keeps one list's top hit from dominating. In practice RRF is hard to beat without labelled data, and it needs no per-corpus tuning, which is why most hybrid search systems start with it.`,
    expect: [
      [["reciprocal rank fusion", "rrf"], ["rank"]],
      [["60", "k"], ["constant", "damp", "dominat"]],
    ],
  },
  {
    id: "d1-fts",
    title: "D1 export gotcha",
    text: `Cloudflare D1's export command refuses to run on a database that contains virtual tables such as FTS5 indexes. The error is "cannot export databases with virtual tables". The workaround is to export table by table with repeated --table flags, leaving out the FTS tables, and rebuild the search index after restoring. Since an FTS index is derived from the canonical rows, nothing is lost by skipping it, but it is worth knowing before you need a backup in a hurry.`,
    expect: [
      [["export"], ["virtual", "fts"]],
      [["--table", "table by table", "per table", "each table"]],
    ],
  },
  {
    id: "sourdough",
    title: "Keeping a sourdough starter",
    text: `A sourdough starter is a culture of wild yeast and lactic acid bacteria living in flour and water. To keep one active at room temperature you discard most of it and feed it equal weights of flour and water once a day. Stored in the fridge it only needs feeding about once a week. A healthy starter roughly doubles in volume four to eight hours after feeding; if it doesn't, it is too cold or underfed. Rye flour speeds a sluggish starter up because it carries more wild yeast.`,
    expect: [
      [["feed", "fed"], ["equal", "1:1", "same weight"]],
      [["double"], ["hour", "after feeding"]],
      [["rye"]],
    ],
  },
  {
    id: "user-pref",
    title: "Notes from my 1:1 with Sam",
    text: `Talked through how I want to run the platform migration. I work best with long uninterrupted mornings, so I'm blocking 9 to 12 every day for deep work and pushing all meetings to the afternoon. Sam agreed to be the reviewer for every schema change, and we decided the migration ships behind a feature flag first, then to everyone after a week with no incidents. I also told Sam I prefer written proposals over meetings for anything that needs a decision.`,
    expect: [
      [["morning", "9"], ["deep work", "uninterrupted", "block"]],
      [["sam"], ["review"]],
      [["written"], ["meeting", "proposal"]],
    ],
  },
  {
    id: "lcs",
    title: "Why diff tools use LCS",
    text: `A line diff is the complement of the longest common subsequence of two files: every line in the LCS is unchanged, everything else is a deletion from the first file or an addition to the second. The textbook dynamic programme fills an n by m table, which is fine for small inputs but quadratic in time and memory. Myers' algorithm finds a shortest edit script in O((n+m)·D), where D is the number of differences, so it is fast when files are similar — the usual case — and that is why git uses it by default.`,
    expect: [
      [["longest common subsequence", "lcs"], ["diff"]],
      [["myers"], ["edit", "differences", "d)"]],
    ],
  },
  {
    id: "idempotency",
    title: "Idempotency keys",
    text: `Retries are only safe if the operation is idempotent. For writes that aren't naturally idempotent, like "create a payment", the client generates a unique key and sends it in an Idempotency-Key header. The server stores the key with the result of the first request and, if the same key arrives again, returns that stored result instead of doing the work twice. Keys need an expiry, typically 24 hours, and the store has to settle races, usually with a unique index on the key.`,
    expect: [
      [["idempotency key", "idempotency-key"], ["same", "first", "stored", "twice", "duplicate", "repeat"]],
      [["unique"], ["race", "index", "concurren"]],
    ],
  },
  {
    id: "climbing",
    title: "Hangboard protocol",
    text: `For finger strength, the protocol my coach gave me is seven-second hangs on a 20mm edge with three minutes rest between sets, five sets, twice a week, never on consecutive days. Add weight when all five sets feel easy. Tendons adapt far more slowly than muscle, so beginners should climb for at least a year before hangboarding, and any sharp pain in a finger pulley means stop for the day.`,
    expect: [
      [["seven", "7"], ["20", "edge", "hang"]],
      [["tendon", "pulley"], ["slow", "year", "pain", "stop"]],
    ],
  },
  {
    id: "project-decision",
    title: "et al. decision log: dropping the generic database",
    text: `We are removing the Notion-style collections from et al. The generic property system needed a role field on every collection just so agents could tell a task list from any other table, which meant the structure was the user's but the meaning was smuggled back in. Replacing it with three fixed types — notes, tasks and sources — removes several thousand lines and lets the trust rules live in the schema instead of in query filters. Proposals get their own table so nothing unreviewed can be indexed.`,
    expect: [
      [["collection", "generic", "database"], ["remov", "drop", "replac"]],
      [["notes", "note"], ["tasks", "task"], ["sources", "source"]],
      [["proposal"], ["table", "index", "unreviewed"]],
    ],
  },
  {
    id: "contact",
    title: "Intro from Priya",
    text: `Priya introduced me to Jordan Lee, who runs developer relations at a database startup in Toronto and used to work on the Postgres query planner. Jordan is hiring a developer advocate next quarter and said they care more about a public portfolio of real projects than about a CV. Best way to reach them is by email; they don't use LinkedIn. Follow up after the conference in May.`,
    expect: [
      [["jordan"], ["developer relations", "devrel", "database", "advocate"]],
      [["jordan", "they"], ["portfolio", "projects"]],
    ],
  },
  {
    id: "workers-cron",
    title: "Cron triggers and time zones",
    text: `Cloudflare cron triggers are evaluated in UTC only. If you schedule something for 8pm local time with a fixed UTC hour, it drifts by an hour twice a year at the daylight-saving boundaries. A robust pattern is to trigger hourly and have the handler ask what time it is in the user's zone with Intl.DateTimeFormat, acting only on the right local hour, and logging what it sent so a duplicate wake-up never sends twice.`,
    expect: [
      [["utc"], ["cron"]],
      [["hourly", "every hour"], ["local", "time zone", "intl"]],
    ],
  },
  {
    id: "espresso",
    title: "Dialling in espresso",
    text: `Start from a 1:2 ratio: 18 grams of coffee in, 36 grams of liquid out, in 25 to 30 seconds. If the shot runs fast and tastes sour, grind finer; if it runs slow and tastes bitter, grind coarser. Change one variable at a time. Beans are usually best between one and four weeks after roasting — fresher than that and the shot is gassy and erratic.`,
    expect: [
      [["1:2", "18", "36"], ["ratio", "grams", "g"]],
      [["sour"], ["finer", "fine"]],
      [["roast"], ["week"]],
    ],
  },
  {
    id: "vitest-workers",
    title: "Testing Workers for real",
    text: `The Cloudflare Vitest integration runs tests inside workerd, the same runtime as production, with real local bindings: D1, R2, KV, queues. Migrations can be applied in a setup file with applyD1Migrations, so tests hit a real schema instead of mocks. The old package, @cloudflare/vitest-pool-workers, has been renamed to @cloudflare/vitest-plugin and the old name no longer gets updates.`,
    expect: [
      [["workerd", "same runtime", "real"], ["test"]],
      [["vitest-plugin"], ["renam", "deprecat", "old"]],
    ],
  },
  {
    id: "reading-habit",
    title: "What worked for reading more",
    text: `After a year of trying, the only thing that made me read more was leaving my phone in another room for the first hour after I wake up and keeping a book on the kitchen table instead. Reading goals by number of books made it worse — I'd pick short books and skim. I now track minutes, not books, and aim for thirty a day.`,
    expect: [
      [["phone"], ["room", "morning", "wake", "hour"]],
      [["minutes"], ["books", "thirty", "30"]],
    ],
  },
  {
    id: "http-cache",
    title: "Private versus public caching",
    text: `Cache-Control: public lets any shared cache — a CDN, a corporate proxy — store a response and serve it to other people. For anything behind authentication that is a data leak waiting to happen. Use private, which restricts storage to the requesting browser, and add immutable with a long max-age for content-addressed files so the browser never revalidates them.`,
    expect: [
      [["private"], ["auth", "shared", "browser", "leak"]],
      [["immutable"], ["max-age", "revalidat", "content"]],
    ],
  },
  {
    id: "meeting-correction",
    title: "Correction to last week's notes",
    text: `Correction: the launch is not on the 14th as I wrote last week. Legal moved it to the 21st because the privacy review isn't finished. Everything else in the plan stands. The beta group is still the 200 users from the waitlist, and support will staff an extra shift for the first two days after launch.`,
    expect: [
      [["21"], ["launch"]],
      [["privacy", "legal"], ["review", "moved", "delay"]],
    ],
  },

  // ---- nothing durable --------------------------------------------------------
  {
    id: "noise-cookies",
    title: "Before you continue",
    text: `We use cookies and data to deliver and maintain our services, track outages and protect against spam, fraud and abuse, measure audience engagement and site statistics, and develop new services. If you choose to accept all, we will also use cookies and data to personalise content and ads. Select more options to see additional information. Accept all. Reject all. More options. Privacy policy. Terms of service.`,
    expect: [],
  },
  {
    id: "noise-promo",
    title: "Summer Sale",
    text: `SUMMER SALE! Up to 70% off everything for a limited time only. Free shipping on orders over $50. Sign up for our newsletter and get an extra 10% off your first order. Shop now before it's gone! New arrivals every week. Follow us on social media for exclusive deals. Offer ends Sunday at midnight. Terms and conditions apply. Shop women, shop men, shop kids, shop home.`,
    expect: [],
  },
  {
    id: "noise-nav",
    title: "Home | Example Docs",
    text: `Home. Getting started. Installation. Configuration. API reference. Guides. Tutorials. Examples. Changelog. Community. Blog. Search the docs. Previous page. Next page. Edit this page on GitHub. Was this page helpful? Yes. No. Copyright 2026 Example Inc. All rights reserved. Made with love by the docs team. Status page. Careers. Contact us.`,
    expect: [],
  },
  {
    id: "noise-login",
    title: "Sign in",
    text: `Sign in to continue. Email address. Password. Forgot your password? Keep me signed in. Sign in with Google. Sign in with Apple. Don't have an account? Create one now. By continuing you agree to our Terms of Use and acknowledge our Privacy Notice. Need help? Visit the help centre. This site is protected by reCAPTCHA and its policies apply.`,
    expect: [],
  },
  {
    id: "noise-error",
    title: "Something went wrong",
    text: `Oops! Something went wrong on our end. We're working on it and we'll get it fixed as soon as we can. You may be able to try again. If the problem continues, please check our status page for updates or contact support with the reference code below. Reference code: 0x7f3a-9b21. Go back. Return home. Report a problem. Error 503 Service Unavailable.`,
    expect: [],
  },
];
