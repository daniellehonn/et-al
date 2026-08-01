"use client";
import { useEffect } from "react";

// /source/?id=… — kept only as a redirect.
//
// In v7 a saved capture was a row with no page of its own, so an @-mention of
// one needed a bespoke screen to land on. Under v8 a source IS a page, so that
// screen has an obvious better answer: send it to the page. Old links, saved
// mentions and anything already written into a block body keep working.
export default function SourceRedirect() {
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    window.location.replace(id ? `/page/?id=${id}` : "/");
  }, []);
  return <p style={{ padding: "3rem" }}>Opening…</p>;
}
