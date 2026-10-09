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
     the same one you type to sign in to the web app)
   - **Request Body**: `JSON`
   - Add field **text** (type Text) → value **Shortcut Input**

   Use **text**, not `url`. Shortcut Input is whatever the share sheet handed
   over, which is a link from Safari but prose when you share a text selection.
   The endpoint pulls a link out of `text` when there is one and files a plain
   note when there isn't, so one field covers both.

5. Done. Share any page from Safari, Reader, Mail, anywhere → scroll to
   **Capture to et al.** → it lands in your inbox.

The request is silent and takes well under a second. Nothing opens.

### Optional: confirmation instead of silence

If you'd rather see that it worked, add a **Show Notification** action after
step 4 with the text `Captured`. A notification is far less disruptive than
launching the app.

## What the endpoint accepts

`POST /api/share` is deliberately more forgiving than `POST /api/capture`. It
takes JSON or form encoding and any of:

| field   | meaning                                                       |
| ------- | ------------------------------------------------------------- |
| `text`  | free text; any link inside it becomes the `url`               |
| `url`   | the shared link — demoted to text if it isn't actually a link |
| `title` | page title, if the sharing app provides one                   |

`url` is treated as a candidate rather than a promise because share sheets
routinely put prose in it (share a text selection from Safari and you get the
selection, not a link). Sending only `text` is the simplest correct thing.

If `text` is only a repeat of the URL it's dropped, so the inbox row doesn't
show the same link twice.

### What happens to a shared link

It lands in the inbox straight away and stays there until you file it into a
note or mark it done. In the background, a queue job fetches the page once and
uses that response three ways: OpenGraph and `<meta>` tags (read with
`HTMLRewriter`) give the inbox row a title, site, description and image; the
page text is indexed for search; and the extractor may suggest a few facts from
it, which wait in **Review** for you to keep or discard. A title you wrote
yourself is never overwritten.

If the fetch fails — a 404, a timeout, a login wall — the inbox says why and
offers **Try again**. Nothing about the capture itself is lost.

### Sharing the same thing twice

Sharing a link that is already waiting in the inbox returns the one already
there instead of adding a copy. A Shortcut that might retry can also send an
`Idempotency-Key` header with a value unique to that share; a retry with the
same key returns the first capture.

## The `/share/` page

`/share/?url=…&title=…&text=…` captures the same way and shows a confirmation
screen. It authorises with the `et_al_session` cookie rather than an API key,
so a Shortcut using **Open URLs** against it needs no key stored.

The catch on iOS: Safari and a home-screen web app keep **separate cookie
jars**. A Shortcut opening this URL lands in Safari, which is only signed in if
you've signed in to et al. *in Safari* — signing in to the home-screen app
doesn't count. That's why the API-key Shortcut above is the recommended setup, and this
page is the fallback.

## Android

Install the PWA from Chrome and the manifest's `share_target` takes effect with
no further setup — et al. appears in the Android share sheet and shares land on
`/share/`, using the session cookie. No Shortcut, no API key.
