"use client";

// Goals — measurable direction inside a Life Area.
//
// A goal exists to answer *why* a project matters, so this screen shows which
// projects are advancing each one. A goal with no projects behind it is an
// intention, not a goal, and is flagged as such.

import { useCallback, useEffect, useState } from "react";
import DeleteButton from "@/components/DeleteButton";
import { getGoals, createGoal, updateGoal, deleteGoal, getAreas, getProjects,
  type Goal, type Area, type Project } from "@/lib/api";

const TYPES = ["outcome", "habit", "identity"] as const;
const STATUSES = ["active", "paused", "completed"] as const;

export default function GoalsPage() {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("");
  const [areaId, setAreaId] = useState("");

  const load = useCallback(() => {
    getGoals().then((r) => setGoals(r.goals)).catch(() => setGoals([]));
  }, []);

  useEffect(() => {
    load();
    getAreas().then((r) => setAreas(r.areas)).catch(() => {});
    getProjects().then((r) => setProjects(r.projects)).catch(() => {});
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await createGoal({ title: title.trim(), area_id: areaId || null });
    setTitle("");
    load();
  }

  return (
    <>
      <h1>Goals</h1>
      <p style={{ color: "var(--ink-2)", margin: "4px 0 16px" }}>
        Measurable direction inside an Area — what makes a project worth doing.
      </p>

      <form onSubmit={add} style={{ marginBottom: 18 }}>
        <div className="capture" style={{ marginBottom: 8 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="New goal…" aria-label="New goal" />
          <button className="btn primary" disabled={!title.trim()}>Add</button>
        </div>
        <div className="pick">
          <button type="button" className={areaId === "" ? "on" : ""}
            onClick={() => setAreaId("")}>No area</button>
          {areas.map((a) => (
            <button type="button" key={a.id} className={areaId === a.id ? "on" : ""}
              onClick={() => setAreaId(a.id)}>{a.name}</button>
          ))}
        </div>
      </form>

      <div className="card">
        {!goals && <><div className="skeleton" /><div className="skeleton" /></>}
        {goals?.length === 0 && (
          <div className="empty">
            <strong>No goals yet</strong>
            A goal turns an Area into direction. Projects then link to it, so you can
            see which work is actually moving something forward.
          </div>
        )}
        {goals?.map((g) => {
          const advancing = projects.filter((p) => p.goal_ids?.includes(g.id));
          return (
            <div className="row" key={g.id}>
              <div className="lead">
                <div className="title">{g.title}</div>
                <div className="meta">
                  {areas.find((a) => a.id === g.area_id)?.name ?? "no area"} · {g.type}
                  {advancing.length === 0
                    ? " · no project advancing this"
                    : ` · ${advancing.length} project(s)`}
                </div>
              </div>
              <div className="pick">
                {STATUSES.map((s) => (
                  <button key={s} className={g.status === s ? "on" : ""}
                    onClick={async () => { await updateGoal(g.id, { status: s }); load(); }}>{s}</button>
                ))}
              </div>
              <DeleteButton what="this goal"
                onDelete={async () => { await deleteGoal(g.id); load(); }} />
            </div>
          );
        })}
      </div>
    </>
  );
}
