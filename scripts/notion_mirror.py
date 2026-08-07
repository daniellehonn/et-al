"""Build the Notion mirror: four roots, nested exactly as Notion nests them.

Page bodies captured in full are written as markdown; the rest are created as
titled pages so navigation matches Notion now and bodies can be backfilled
without moving anything. Databases become collections with their real schemas.
"""
import json, sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..",
                                "Users", "daniellehon", "projects", "personal-projects", "et-al", "scripts"))

rows  = json.load(open("rows.json"))
sch   = json.load(open("schemas.json"))
extra = json.load(open("rows_extra.json"))

# Bodies captured verbatim from Notion. Anything absent here becomes a titled
# page with no body — the same state it would have if it were blank in Notion,
# and the honest representation of "structure captured, body not yet".
bodies = json.load(open("bodies.json"))
B = lambda k: bodies.get(k, "")

DB = lambda title, icon, schema, rows_: {"title": title, "icon": icon, "schema": schema, "rows": rows_}

tree = [
  {"title": "UCLA", "icon": "🧸", "markdown": "",
   "collections": [DB("courses of the next 4 years", "📚", sch["courses"], rows["courses"])],
   "children": [
     {"title": "club application tracker", "icon": None, "markdown": B("club_tracker"),
      "collections": [DB("club applications", "📋", extra["club"]["schema"], extra["club"]["rows"])]},
     {"title": "fall ‘25", "icon": "🍁", "markdown": "", "children": [
        {"title": "assignment tracker", "icon": None, "markdown": ""},
        {"title": "CS 1: Computer Science Seminar", "icon": None, "markdown": ""}]},
     {"title": "winter ‘26", "icon": "❄️", "markdown": "", "children": [
        {"title": "JAPAN 70: Japanese Literature and Film — “Fictions of the Floating World”", "icon": None, "markdown": ""}]},
     {"title": "spring ‘26", "icon": "🍀", "markdown": "", "children": [
        {"title": "classics 51b: Art and Archaeology of Ancient Rome", "icon": None, "markdown": ""},
        {"title": "MGMT 170: Real Estate Finance & Investments", "icon": None, "markdown": ""}]},
     {"title": "summer ‘26", "icon": "☀️", "markdown": ""},
     {"title": "UCLA JOB COUNSELING", "icon": None, "markdown": B("job_counseling")},
     {"title": "fall ‘26", "icon": "🍁", "markdown": ""},
   ]},

  {"title": "Career", "icon": "⭐", "markdown": "",
   "collections": [DB("summer ‘27 internship tracker", "🎯", sch["internships"], rows["internships"])],
   "children": [
     {"title": "career blocks", "icon": None, "markdown": B("career_blocks"), "children": [
        {"title": "Resume Draft — Tech (SWE + AI Eng)", "icon": None, "markdown": B("resume_tech")}]},
     {"title": "resume plan", "icon": None, "markdown": "", "children": [
        {"title": "Resume Draft — SWE (SUPERSEDED — see Resume Draft — Tech)", "icon": None, "markdown": ""},
        {"title": "Resume Draft — PM", "icon": "📈", "markdown": B("resume_pm")}]},
     {"title": "LinkedIn Draft", "icon": "🔗", "markdown": B("linkedin")},
   ]},

  {"title": "Side Projects", "icon": "💻", "markdown": B("side_projects"), "children": [
     {"title": "Course Planner", "icon": "📓", "markdown": B("course_planner")},
     {"title": "AgentBench", "icon": "🧪", "markdown": B("agentbench")},
     {"title": "half baked", "icon": "🍞", "markdown": B("half_baked"), "children": [
        {"title": "design brief — semantic music discovery agent", "icon": None, "markdown": ""}]},
     {"title": "et al. — Next Level", "icon": None, "markdown": B("next_level")},
  ]},

  {"title": "The Useful Internet", "icon": "✳️", "markdown": B("useful_internet"),
   "collections": [
     DB("Tool Database", "🧰", sch["tools"], rows["tools"]),
     DB("Posts", "📝", extra["posts"]["schema"], extra["posts"]["rows"]),
   ],
   "children": [
     {"title": "Content Templates", "icon": None, "markdown": B("content_templates")},
     {"title": "Visual Brand System — Art Direction Reference", "icon": None, "markdown": B("visual_brand")},
     {"title": "image generation suite", "icon": None, "markdown": "",
      "collections": [
        DB("prompts", "💡", extra["prompts"]["schema"], extra["prompts"]["rows"]),
        DB("results", "🖼️", [{"key": "tags", "name": "Tags", "type": "multi_select"}], []),
      ]},
  ]},
]

json.dump(tree, open("mirror_tree.json", "w"), indent=1)

def count(ns):
    n = 0
    for x in ns:
        n += 1 + count(x.get("children", []))
    return n

print(f"roots: {len(tree)}  pages: {count(tree)}", file=sys.stderr)
