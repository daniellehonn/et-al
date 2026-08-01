"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PageView } from "@/components/PageView";

function PageRoute() {
  const params = useSearchParams();
  const id = params.get("id");
  if (!id) return <div style={{ padding: "3.5rem 2.5rem" }} className="et-empty">No page selected.</div>;
  return <PageView key={id} id={id} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageRoute />
    </Suspense>
  );
}
