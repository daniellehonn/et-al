"use client";
import { useState, type DragEvent } from "react";

// The HTML5 drag-reorder pattern (dragId + overId + the four handlers) was
// hand-rolled in five places: the workspace tree, widget reorder, table columns,
// the task board, and move-to-root. This hook centralizes the state and handlers;
// each call site supplies only what happens on drop.
export function useDragReorder<T extends string = string>() {
  const [dragId, setDragId] = useState<T | null>(null);
  const [overId, setOverId] = useState<T | null>(null);
  const reset = () => { setDragId(null); setOverId(null); };

  // Spread onto a draggable item (or a drag handle).
  const dragProps = (id: T) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; },
    onDragEnd: reset,
  });

  // Spread onto a drop target. `onDrop` gets the dragged id. `id` may be a
  // sentinel (e.g. a status column or "__end") — pass allowSelf to permit
  // dropping onto the same id (e.g. board columns).
  const dropProps = (id: T, onDrop: (dragId: T) => void, allowSelf = false) => ({
    "data-over": overId === id || undefined,
    onDragOver: (e: DragEvent) => { if (dragId && (allowSelf || dragId !== id)) { e.preventDefault(); setOverId(id); } },
    onDragLeave: () => setOverId((c) => (c === id ? null : c)),
    onDrop: (e: DragEvent) => { e.preventDefault(); if (dragId && (allowSelf || dragId !== id)) onDrop(dragId); reset(); },
  });

  return { dragId, overId, dragProps, dropProps, reset };
}
