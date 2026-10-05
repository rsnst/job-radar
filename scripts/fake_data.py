"""Generate synthetic shard output for load-testing the DB build and the web app (no network)."""
import gzip, json, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scraper.run import load_boards

N = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
out = Path(sys.argv[2] if len(sys.argv) > 2 else "out"); out.mkdir(exist_ok=True)
random.seed(7)
boards = list(load_boards())
titles = ["Software Engineer", "Senior .NET Developer", "Data Engineer", "C# Full Stack Engineer", "Registered Nurse",
          "Warehouse Associate", "Sales Representative", "Product Manager", "Staff Data Engineer - Azure",
          "Accountant", "Customer Service Rep", "DevOps Engineer", "Machine Learning Engineer", "Truck Driver (CDL-A)",
          "Medical Assistant", "Financial Analyst", "Backend Engineer (Python)", "Site Reliability Engineer"]
lvl = ["", "Senior ", "Lead ", "Principal ", "Junior ", "II ", "III "]
locs = [("Austin, TX","TX"),("San Antonio, TX","TX"),("New York, NY","NY"),("Remote - US",None),("Seattle, WA","WA"),
        ("Chicago, IL","IL"),("Atlanta, GA","GA"),("Denver, CO","CO"),("Remote",None),("Plano, TX","TX"),("Boston, MA","MA")]
w = gzip.open(out/"jobs-00.jsonl.gz","wt"); s = open(out/"boards-00.jsonl","w")
per = {}
for i in range(N):
    b = random.choice(boards); per[b["id"]] = per.get(b["id"],0)+1
    l, st = random.choice(locs)
    rem = int("Remote" in l)
    d = f"2026-{random.choice(['08','09','09','10','10','10'])}-{random.randint(1,28):02d}" if random.random()>.1 else None
    if d and d > "2026-10-05": d = "2026-10-05"
    w.write(json.dumps({"k":f"x:{i}","b":b["id"],"t":random.choice(lvl)+random.choice(titles),"c":b["company"],"a":b["ats"],
        "l":l,"s":st,"r":rem,"u":int(l!="Remote"),"d":d,"url":b["board_url"]+f"/jobs/{i}"},separators=(",",":"))+"\n")
for b in boards:
    s.write(json.dumps({"b":b["id"],"ok":1 if b["id"] in per else (0 if b["ats"] not in ("Dayforce",) else 0),"n":per.get(b["id"],0)})+"\n")
w.close(); s.close(); print("wrote", N)
