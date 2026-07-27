# Sharing into et al. from any iOS app

## Why this isn't just a manifest

The web standard for this is the [Web Share Target API]: a PWA declares a
`share_target` in its manifest and the OS lists it in the system share sheet.
`client/public/manifest.webmanifest` declares one, pointing at `/share/`.

**Safari has never implemented it.** As of iOS 26 a home-screen web app cannot
register as a share target — there is no flag, entitlement, or workaround. The
manifest entry is there for Chrome on Android, where it works as written.

On iPhone, the only thing that can add an entry to the share sheet of *every*
app is an **App Extension**, and the Shortcuts app is the one that ships a
user-programmable one. So the share sheet entry is a Shortcut. It takes about
two minutes to build, once.

[Web Share Target API]: https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target

## Build the Shortcut

1. Open **Shortcuts** → **+** → rename it **Capture to et al.**
   The name is what appears in the share sheet, so make it one you'll recognise.

2. Tap the ⓘ (Details) → turn on **Show in Share Sheet**.
   Under *Share Sheet Types*, leave **URLs** and **Text** on; turn the rest off,
   so it doesn't offer itself when you share a photo.

3. Add action **Get Contents of URL**. Set the URL to:

   ```
   https://et-al.daniellehonnn.workers.dev/api/share
   ```

4. Expand **Show More** on that action and set:

   - **Method**: `POST`
   - **Headers**: add `x-api-key` → *your API key* (the value in `.dev.vars`,
     the same one you type to unlock the web app)
   - **Request Body**: `JSON`
   - Add field **url** (type Text) → value **Shortcut Input**

5. Done. Share any page from Safari, Reader, Mail, anywhere → scroll to
   **Capture to et al.** → it lands in your inbox.

The request is silent and takes well under a second. Nothing opens.

### Optional: confirmation instead of silence

If you'd rather see that it worked, add a **Show Notification** action after
step 4 with the text `Captured`. A notification is far less disruptive than
launching the app.

## What the endpoint accepts

`POST /api/share` is deliberately more forgiving than `POST /api/capture`,
because a share sheet can't supply a typed `kind`. It takes JSON or form
encoding and any of:

| field   | meaning                                                       |
| ------- | ------------------------------------------------------------- |
| `url`   | the shared link                                               |
| `title` | page title, if the sharing app provides one                   |
| `text`  | free text; a URL found inside it is used when `url` is absent |
| `kind`  | optional, see below — omit it in normal use                   |

If `text` is only a repeat of the URL it's dropped, so the inbox row doesn't
show the same link twice.

### Why a shared link is filed as a `note`

Captures default to `kind: "note"` **even when a URL is present**. That looks
wrong, but it's what Quick Capture already does when you paste a link, and it's
load-bearing:

- `note` and `idea` are *inline* kinds. They need no fetching, so nothing is
  enqueued and the source sits at `status: inbox` until you or an agent files it.
- `url`, `youtube`, `pdf`, `github` enqueue an ingest job. The consumer fetches
  the page and sets `status: processed` — which drops the item **out of the
  inbox within seconds of sharing it**.

Since the point of sharing is to capture now and sort later, the link must stay
in the inbox. The URL is still stored in the `url` column, so the inbox row
renders it as a real link and `process_inbox` can classify it properly later.

Pass `kind` explicitly (e.g. `"url"`) only if you want that eager fetch and
accept that the capture leaves the inbox on its own.

### Link enrichment

Filing a link as a `note` would normally leave the inbox showing a bare URL, so
any capture that carries a `url` enqueues an **`enrich_source`** job. It fetches
the page, pulls title / description / site / image out of the OpenGraph and
`<meta>` tags with `HTMLRewriter`, and writes them to `metadata_json`.

It is strictly decorative — unlike `ingest_source` it **never touches `status`**,
so the capture stays in the inbox where you put it. It also only claims the
`title` when you didn't write one (a title equal to the URL counts as unwritten),
so a note you typed yourself is never overwritten.

Everything about it is best-effort. A page that 404s, times out, blocks the
fetch, or isn't HTML still records the hostname, so the row is more legible than
a raw URL and the UI can tell "tried" from "not yet tried". The inbox polls
while a capture is awaiting enrichment and stops as soon as none is — bounded by
a two-minute window, so a link that will never enrich can't poll forever.

Quick Capture on Home and Inbox posts here rather than to `/capture`, which is
what lets a pasted link be recognised as a link at all.

## The `/share/` page

`/share/?url=…&title=…&text=…` captures the same way and shows a confirmation
screen. It authorises with the `et_al_session` cookie rather than an API key,
so a Shortcut using **Open URLs** against it needs no key stored.

The catch on iOS: Safari and a home-screen web app keep **separate cookie
jars**. A Shortcut opening this URL lands in Safari, which is only unlocked if
you've unlocked et al. *in Safari* — unlocking the home-screen app doesn't
count. That's why the API-key Shortcut above is the recommended setup, and this
page is the fallback.

## Android

Install the PWA from Chrome and the manifest's `share_target` takes effect with
no further setup — et al. appears in the Android share sheet and shares land on
`/share/`, using the session cookie. No Shortcut, no API key.
