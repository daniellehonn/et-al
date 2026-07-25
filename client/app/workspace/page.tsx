"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { WorkspaceView } from "@/components/WorkspaceView";

function WorkspaceRoute() {
  const id = useSearchParams().get("id");
  if (!id) return <div style={{ padding: "3.5rem 2.5rem" }} className="et-empty">No workspace selected.</div>;
  return <WorkspaceView id={id} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <WorkspaceRoute />
    </Suspense>
  );
}
