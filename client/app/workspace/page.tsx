"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { WorkspaceView } from "@/components/WorkspaceView";

function WorkspaceRoute() {
  const params = useSearchParams();
  const id = params.get("id");
  if (!id) return <div style={{ padding: "3.5rem 2.5rem" }} className="et-empty">No workspace selected.</div>;
  return <WorkspaceView key={id} id={id} initialTab={params.get("tab") ?? undefined} initialDoc={params.get("doc") ?? undefined} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <WorkspaceRoute />
    </Suspense>
  );
}
