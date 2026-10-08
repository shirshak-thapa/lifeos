"""Runs the whole demo story from a clean state and prints PASS/FAIL per step.
Run: python demo_test.py   (uses cache.json, so it works offline once the cache is filled)"""
import logic
import main
import ai

results = []


def check(step, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {step}  {detail}")


def run(file, source_type):
    with open(f"demo_inputs/{file}", "rb") as f:
        out = main.process(file, f.read(), source_type)
    print(f"      {file}: " + " | ".join(out["log"]))
    return out["items"]


def find(items, word):
    return [i for i in items if word in i["title"].lower()]


logic.reset()

# 1. classmate chat -> 2 new items
items = run("classmate_chat.png", "classmate")
a, p = find(items, "assignment"), find(items, "presentation")
check("1 chat -> 2 new items", len(items) == 2 and a and p and a[0]["date"] == "2026-10-16" and p[0]["date"] == "2026-10-20",
      f"{[(i['title'], i['date']) for i in items]}")

# 2. assignment brief -> conflict, Thursday suggested
items = run("assignment_brief.pdf", "official")
a = find(items, "assignment")
c = a[0]["conflict"] if a else None
ok = len(a) == 1 and a[0]["status"] == "conflict" and c and c["options"][c["suggested"]]["date"] == "2026-10-15"
check("2 brief -> conflict, Thu 15 Oct suggested", ok, f"status={a[0]['status'] if a else None}, items={len(items)}")

# user picks the suggested date (as in the live demo)
if ok:
    logic.save({**logic.load(), "items": items})
    db = logic.load()
    logic.resolve(db, a[0]["id"], c["suggested"])
    logic.save(db)

# 3. poster -> merges into presentation, adds time + room
items = run("seminar_poster.png", "official")
p = find(items, "presentation")
check("3 poster -> merged, time+room added", len(p) == 1 and p[0]["time"] == "10:00" and "204" in (p[0]["location"] or ""),
      f"{[(i['title'], i['date'], i['time'], i['location']) for i in p]}")

# 4. note -> related task under the presentation
items = run("note.png", "note")
r = [i for i in items if i.get("parent_id")]
check("4 note -> related task", len(r) == 1 and p and r[0]["parent_id"] == p[0]["id"], f"{[(i['title'], i['parent_id']) for i in r]}")

# 5. ask
ans = ai.answer("What do I need to do before Tuesday?", logic.summary_for_answer(logic.load()))
print("      answer:\n" + "\n".join("        " + l for l in ans.splitlines()))
check("5 ask -> short sourced answer", len(ans.splitlines()) <= 8 and "assignment_brief.pdf" in ans)

# 6. prof notice -> update to Mon 19 Oct
items = run("prof_notice.png", "teacher")
a = find(items, "assignment")
check("6 notice -> update to Mon 19 Oct", len(a) == 1 and a[0]["date"] == "2026-10-19" and "->" in a[0]["history"][-1],
      f"{a[0]['history'][-1] if a else ''}")

# quotes verified?
bad = [(i["title"], s["file"]) for i in items for s in i["sources"] if not s["verified"]]
check("quotes verified", not bad, f"unverified: {bad}")

print(f"\n{sum(results)}/{len(results)} checks passed. Model used: {ai.last_model_used}")
