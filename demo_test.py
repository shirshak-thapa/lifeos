"""Runs the whole demo story from a clean state and prints PASS/FAIL per step.
Run: python demo_test.py          (uses cache.json, so it works offline once the cache is filled)
     python demo_test.py --prune  (also removes cache entries that are no longer used)"""
import sys

import ai
import logic
import main

results = []


def check(step, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {step}  {detail}")


def run(name):
    with open(f"demo_inputs/{name}", "rb") as f:
        out = main.process(name, f.read())
    print(f"      {name}: " + " | ".join(out["log"]))
    return out


def items():
    return logic.load()["items"]


def find(word):
    return [i for i in items() if word in i["title"].lower()]


logic.reset()

# 1. classmate chat -> 2 new items + a summary
out = run("classmate_chat.png")
a, p = find("assignment"), find("presentation")
check("1 chat -> 2 new items", len(items()) == 2 and a and p and a[0]["date"] == "2026-10-16" and p[0]["date"] == "2026-10-20",
      f"{[(i['title'], i['date']) for i in items()]}")
check("  file has summary + source type", out["file"]["summary"] and out["file"]["source"] == "classmate",
      f"{out['file']['source']}: {out['file']['summary']!r}")

# 2. assignment brief -> conflict, Thursday suggested (official notice beats a classmate)
out = run("assignment_brief.pdf")
a = find("assignment")
c = a[0]["conflict"] if a else None
ok = len(a) == 1 and a[0]["status"] == "conflict" and c and c["options"][c["suggested"]]["date"] == "2026-10-15"
check("2 brief -> conflict, Thu 15 Oct suggested", ok, f"source={out['file']['source']}, items={len(items())}")
if ok:  # the user picks the suggested date, as in the live demo
    db = logic.load()
    logic.resolve(db, a[0]["id"], c["suggested"])
    logic.save(db)

# 3. poster -> merges into the presentation, adds time + room
run("seminar_poster.png")
p = find("presentation")
check("3 poster -> merged, time+room added", len(p) == 1 and p[0]["time"] == "10:00" and "204" in (p[0]["location"] or ""),
      f"{[(i['title'], i['date'], i['time'], i['location']) for i in p]}")

# 4. note -> helper task under the presentation
run("note.png")
r = [i for i in items() if i.get("parent_id")]
check("4 note -> related task", len(r) == 1 and p and r[0]["parent_id"] == p[0]["id"], f"{[(i['title'], i['parent_id']) for i in r]}")

# 5. ask about the plan
db = logic.load()
ans = ai.answer("What do I need to do before Tuesday?", logic.summary_for_answer(db), logic.documents_for_answer(db))
print("      answer:\n" + "\n".join("        " + line for line in ans.splitlines()))
check("5 ask -> short sourced answer", len(ans.splitlines()) <= 8 and "assignment_brief.pdf" in ans)

# 6. professor's notice -> update to Mon 19 Oct
run("prof_notice.png")
a = find("assignment")
check("6 notice -> update to Mon 19 Oct", len(a) == 1 and a[0]["date"] == "2026-10-19" and "->" in a[0]["history"][-1],
      f"{a[0]['history'][-1] if a else ''}")

# 7. multi-page PDF -> items from every page
out = run("course_schedule.pdf")
f = out["file"]
exam = [i for i in items() if "exam" in i["title"].lower()]
lab = [i for i in items() if "lab" in i["title"].lower()]
check("7 3-page PDF -> items from all pages", f["pages"] == 3 and exam and lab and exam[0]["date"] == "2026-10-28"
      and exam[0]["time"] == "09:00" and lab[0]["date"] == "2026-10-21",
      f"pages={f['pages']} facts={[(x['title'], x['date'], x['time']) for x in f['facts']]}")
check("  assignment not duplicated", len(find("assignment")) == 1)

# 8. ask about the files' content (not only dates)
db = logic.load()
ans = ai.answer("What should I bring to the exam?", logic.summary_for_answer(db), logic.documents_for_answer(db))
print("      answer:\n" + "\n".join("        " + line for line in ans.splitlines()))
check("8 ask about content -> uses the PDF text", "calculator" in ans.lower() and "course_schedule.pdf" in ans)

# 9. same file again -> nothing changes
before = len(items())
out = run("note.png")
check("9 same file twice -> 'already added'", out["duplicate"] and len(items()) == before)

# 10. quotes and calendar
bad = [(i["title"], s["file"]) for i in items() for s in i["sources"] if not s["verified"]]
check("10 quotes verified", not bad, f"unverified: {bad}")
ics = logic.calendar_ics(logic.load())
dated = [i for i in items() if i["date"]]
check("11 calendar export", ics.count("BEGIN:VEVENT") == len(dated) and ics.startswith("BEGIN:VCALENDAR"))

print(f"\n{sum(results)}/{len(results)} checks passed. Model used: {ai.last_model_used}")
if "--prune" in sys.argv:
    print(f"cache pruned to {ai.prune_cache(ai.used_keys)} entries")
