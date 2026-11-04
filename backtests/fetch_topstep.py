"""Download Topstep (ProjectX) 1-minute bars for NQ, ES and GC and stitch them into one front-month series per market.
Credentials come only from the environment (never written to disk):  TOPSTEPX_USER, TOPSTEPX_KEY
    python3 fetch_topstep.py            -> data/topstep/{NQ,ES,GC}_1m.csv.gz  (+ a per-contract cache in data/topstep/raw/)
Each contract is fetched backwards in 20,000-bar pages until the API returns nothing. The front month for each day is the contract
with the most volume that day (so rolls follow where traders actually were). Prices are not back-adjusted; trades never span a roll."""
import os, sys, json, time, datetime as dt, urllib.request, pandas as pd
BASE = "https://api.topstepx.com"; OUT = os.path.join(os.path.dirname(__file__), "data", "topstep"); os.makedirs(os.path.join(OUT, "raw"), exist_ok=True)
ROOT = {"NQ": "ENQ", "ES": "EP", "GC": "GCE"}
MONTHS = {"NQ": "HMUZ", "ES": "HMUZ", "GC": "GJMQVZ"}
TOKEN = None

def call(path, body, auth=True):
    for k in range(5):
        req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json", "Accept": "application/json",
                                     **({"Authorization": f"Bearer {TOKEN}"} if auth else {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(10 * (k + 1)); continue
            raise
        except Exception: time.sleep(3 * (k + 1))
    raise RuntimeError(f"{path} failed")

def login():
    global TOKEN
    u, key = os.environ.get("TOPSTEPX_USER"), os.environ.get("TOPSTEPX_KEY")
    if not u or not key: sys.exit("Set TOPSTEPX_USER and TOPSTEPX_KEY in the environment.")
    j = call("/api/Auth/loginKey", {"userName": u, "apiKey": key}, auth=False)
    if not j.get("success"): sys.exit(f"Login refused: {j.get('errorMessage') or j.get('errorCode')}")
    TOKEN = j["token"]

def bars(cid, start, end):
    """All 1-minute bars of one contract between start and end, paging backwards."""
    out, e = [], end
    while e > start:
        j = call("/api/History/retrieveBars", {"contractId": cid, "live": False, "startTime": start.isoformat(), "endTime": e.isoformat(),
                                               "unit": 2, "unitNumber": 1, "limit": 20000, "includePartialBar": False})
        b = j.get("bars") or []
        if not b: break
        out += b; first = min(pd.Timestamp(x["t"]) for x in b)
        if first >= e: break
        e = first.to_pydatetime(); time.sleep(0.7)
    return out

def contracts(sym, years):
    now = dt.date.today()
    for y in range(now.year - years, now.year + 1):
        for m in MONTHS[sym]:
            yield f"CON.F.US.{ROOT[sym]}.{m}{y % 100:02d}", y, "FGHJKMNQUVXZ".index(m) + 1

def fetch(sym, years=8):
    frames = []
    for cid, y, mo in contracts(sym, years):
        f = os.path.join(OUT, "raw", cid.replace(".", "_") + ".csv.gz")
        exp = dt.datetime(y, mo, 28, tzinfo=dt.timezone.utc)
        if exp < dt.datetime(dt.date.today().year - years, 1, 1, tzinfo=dt.timezone.utc): continue
        if os.path.exists(f) and exp < dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=40):
            d = pd.read_csv(f, parse_dates=["t"])
        else:
            start = exp - dt.timedelta(days=200); end = min(exp + dt.timedelta(days=5), dt.datetime.now(dt.timezone.utc))
            try: b = bars(cid, start, end)
            except Exception as ex: print(f"  {cid}: {ex}", flush=True); continue
            if not b: print(f"  {cid}: no data", flush=True); continue
            d = pd.DataFrame(b).rename(columns=str.lower); d["t"] = pd.to_datetime(d["t"], utc=True); d = d.drop_duplicates("t").sort_values("t"); d.to_csv(f, index=False)
        print(f"  {cid}: {len(d):,} bars {d.t.min():%Y-%m-%d} -> {d.t.max():%Y-%m-%d}", flush=True)
        d["contract"] = cid; frames.append(d)
    if not frames: return None
    a = pd.concat(frames); a["day"] = a.t.dt.tz_convert("America/New_York").dt.date
    vol = a.groupby(["day", "contract"]).v.sum().reset_index().sort_values("v").drop_duplicates("day", keep="last").set_index("day").contract
    a = a[a.contract == a.day.map(vol)].drop(columns="day").sort_values("t")
    a.to_csv(os.path.join(OUT, f"{sym}_1m.csv.gz"), index=False)
    print(f"{sym}: {len(a):,} front-month bars {a.t.min():%Y-%m-%d} -> {a.t.max():%Y-%m-%d}", flush=True); return a

if __name__ == "__main__":
    login()
    for s in sys.argv[1:] or ["NQ", "ES", "GC"]: fetch(s)
