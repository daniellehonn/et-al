"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { NoteView } from "@/components/NoteView";

function NoteRoute() {
  const id = useSearchParams().get("id");
  if (!id) return <div style={{ padding: "3.5rem 2.5rem" }} className="et-empty">No note selected.</div>;
  return <NoteView key={id} id={id} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NoteRoute />
    </Suspense>
  );
}
